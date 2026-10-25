/**
 * HTTP routes for the AI module:
 *   POST /api/chat-upload        Instagram export -> memory cards (raw upload discarded at once; `?room=` ok)
 *   POST /api/transcribe         push-to-talk clip -> incantation verdict
 *   POST /api/tts, GET /api/tts  narrator/boss line -> audio/mpeg, or a speechSynthesis fallback
 *   GET  /api/images/:id         base64 Muse images kept in memory
 *   GET  /api/placeholder/:kind.svg
 *   GET  /api/metrics/ai         AI latency stats (POST .../reset clears them; dev or bearer only)
 */
import { timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { P0_ELEMENTS } from '@once-upon/shared';
import type {
  ChatUploadResponse,
  P0ElementType,
  TranscribeResponse,
  TtsFallbackResponse,
} from '@once-upon/shared';
import type { ServerContext } from '../contracts';
import { extractMemoryCards } from './cards';
import { matchIncantation } from './incantation';
import { ChatParseError, parseInstagramExport } from './instagram';
import { placeholderSvg } from './placeholders';
import { describeError } from './runtime';
import { internalsFor } from './service';
import { aiTimings } from './timings';
import { cleanTtsText } from './tts';

export const CHAT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
const CARD_EXTRACTION_TIMEOUT_FLOOR_MS = 25_000;

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_UPLOAD_MAX_BYTES, files: 10 },
});
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_UPLOAD_MAX_BYTES, files: 1 },
});

/** Runs a multer middleware and turns its errors into JSON responses. */
function withUpload(mw: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err?: unknown) => {
      if (!err) return next();
      const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File too large' : 'Bad upload' });
    });
  };
}

function uploadedFiles(req: Request): Express.Multer.File[] {
  const files = req.files;
  if (Array.isArray(files)) return files;
  if (files && typeof files === 'object') return Object.values(files).flat();
  return req.file ? [req.file] : [];
}

/** Overwrites and drops the raw upload bytes so nothing of the chat outlives the request. */
function wipe(files: Express.Multer.File[]): void {
  for (const f of files) {
    f.buffer?.fill(0);
    (f as { buffer?: Buffer }).buffer = Buffer.alloc(0);
  }
}

function field(req: Request, name: string): string | undefined {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : undefined;
}

function bearerMatches(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = req.headers.authorization ?? '';
  const got = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function registerAiRoutes(app: Express, ctx: ServerContext): void {
  const ai = internalsFor(ctx.ai);
  const { rt } = ai;

  app.post('/api/chat-upload', withUpload(chatUpload.any()), async (req, res) => {
    const files = uploadedFiles(req);
    let parsedInputs: unknown[] = [];
    try {
      for (const f of files) {
        try {
          parsedInputs.push(JSON.parse(f.buffer.toString('utf8')));
        } catch {
          // not JSON: ignored below
        }
      }
      if (files.length === 0 && req.is('application/json') && req.body && typeof req.body === 'object') {
        parsedInputs.push(req.body);
      }
    } finally {
      wipe(files);
    }
    if (parsedInputs.length === 0) {
      res.status(400).json({ error: 'Upload the Instagram JSON export as the "file" field' });
      return;
    }

    let chat;
    try {
      chat = parseInstagramExport(parsedInputs);
    } catch (err) {
      const msg = err instanceof ChatParseError ? err.message : 'Could not read that export';
      res.status(422).json({ error: msg });
      return;
    } finally {
      parsedInputs = [];
    }
    if (chat.messages.length === 0) {
      res.status(422).json({ error: 'No text messages from chat members were found in that export' });
      return;
    }

    try {
      const { cards, source } = await aiTimings.time(
        'cards.extract',
        () => extractMemoryCards(ctx.ai.muse, chat, Math.max(rt.config.aiTimeoutMs, CARD_EXTRACTION_TIMEOUT_FLOOR_MS)),
        (r) => (r.source === 'muse' ? 'ok' : 'fallback'),
      );
      if (source !== 'muse') rt.warn(`memory cards came from the ${source} extractor`);
      ai.cards.set(cards);
      // Multipart sends `roomCode`; the storybook client posts raw JSON with `?room=CODE`.
      const roomQuery = typeof req.query.room === 'string' ? req.query.room : undefined;
      const roomCode = (field(req, 'roomCode') ?? roomQuery)?.trim().toUpperCase();
      if (roomCode) ctx.io.to(roomCode).emit('memory:cards', ai.cards.list());
      const body: ChatUploadResponse = { cards: ai.cards.list() };
      res.json(body);
    } catch (err) {
      rt.warn(`chat upload failed: ${describeError(err)}`);
      res.status(500).json({ error: 'Card extraction failed' });
    } finally {
      chat.messages.length = 0;
      chat.participants.length = 0;
    }
  });

  app.post('/api/transcribe', withUpload(audioUpload.any()), async (req, res) => {
    const files = uploadedFiles(req);
    const audio = files.find((f) => f.fieldname === 'audio') ?? files[0];
    try {
      const roomCode = field(req, 'roomCode')?.trim();
      const playerId = field(req, 'playerId')?.trim();
      const element = field(req, 'element') as P0ElementType | undefined;
      if (!roomCode || !playerId || !element || !P0_ELEMENTS.includes(element)) {
        res.status(400).json({ error: 'roomCode, playerId and a P0 element are required' });
        return;
      }
      const expected =
        ctx.rooms.getIncantation(roomCode, element) ?? ctx.ai.getCachedWorld().incantations[element];

      const override = field(req, 'transcriptOverride');
      let transcript = '';
      if (override !== undefined) {
        if (rt.config.isProduction && !bearerMatches(req, rt.config.mcpBearerToken)) {
          res.status(403).json({ error: 'transcriptOverride is not allowed here' });
          return;
        }
        transcript = override.trim().slice(0, 500);
      } else if (audio && audio.buffer.length > 0) {
        const run = () => ai.transcriber.transcribe(audio.buffer, audio.mimetype, audio.originalname);
        // Only time real provider attempts; with no provider configured this resolves instantly.
        const result = ai.transcriber.available()
          ? await aiTimings.time('asr.transcribe', run, (r) => (r?.text ? 'ok' : 'error'))
          : await run();
        // No transcript (provider down or missing): the attempt counts as a failure so mercy still applies.
        transcript = result?.text ?? '';
      }

      const { matchRatio } = matchIncantation(transcript, expected);
      const verdict = ai.mercy.judge(roomCode, playerId, element, matchRatio);
      const body: TranscribeResponse = {
        transcript,
        expected,
        matchRatio,
        passed: verdict.passed,
        mercy: verdict.mercy,
        attempt: verdict.attempt,
        power: verdict.power,
      };
      try {
        ctx.rooms.recordIncantation(roomCode, playerId, element, body);
      } catch (err) {
        rt.warn(`recordIncantation threw: ${describeError(err)}`);
      }
      res.json(body);
    } finally {
      wipe(files);
    }
  });

  const tts = async (res: Response, text: unknown, speaker: unknown, method: 'GET' | 'POST', etag?: string) => {
    const clean = cleanTtsText(text);
    if (!clean) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const result = await ai.tts.synthesize(clean, speaker);
    if (!result) {
      const body: TtsFallbackResponse = { fallback: 'speech_synthesis', text: clean };
      // An <audio src> needs an error status to fire `error`; fetch callers read the JSON.
      res.status(method === 'GET' ? 503 : 200).set('Cache-Control', 'no-store').json(body);
      return;
    }
    const tag = `"${result.key}"`;
    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=604800, immutable',
      ETag: tag,
      'X-TTS-Provider': result.provider,
    });
    if (etag === tag) {
      res.status(304).end();
      return;
    }
    res.send(result.audio);
  };

  app.post('/api/tts', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await tts(res, body.text, body.speaker, 'POST');
  });

  app.get('/api/tts', async (req, res) => {
    await tts(res, req.query.text, req.query.speaker, 'GET', req.headers['if-none-match']);
  });

  // Latency stats only (op names, counts, durations): no prompts, transcripts or keys.
  app.get('/api/metrics/ai', (_req, res) => {
    res.json(aiTimings.snapshot());
  });
  app.post('/api/metrics/ai/reset', (req, res) => {
    if (rt.config.isProduction && !bearerMatches(req, rt.config.mcpBearerToken)) {
      res.status(403).json({ error: 'Reset is not allowed here' });
      return;
    }
    aiTimings.reset();
    res.json(aiTimings.snapshot());
  });

  app.get('/api/images/:id', (req, res) => {
    const img = ai.images.getImage(req.params.id);
    if (!img) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }
    res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=86400, immutable' });
    res.send(img.buf);
  });

  app.get('/api/placeholder/:file', (req, res) => {
    const svg = placeholderSvg(req.params.file.replace(/\.svg$/i, ''));
    if (!svg) {
      res.status(404).json({ error: 'Unknown placeholder' });
      return;
    }
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.send(svg);
  });
}
