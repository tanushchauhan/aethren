import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';
import {
  DEBUG_TTS_ENDPOINT,
  DEFAULT_NARRATOR,
  MAX_TTS_TEXT_LENGTH,
  findVoice,
  type VoiceOption,
} from './src/audio-lab/voiceCatalog';
import {
  EngineUnavailableError,
  engineStatus,
  isServerEngine,
  synthesize,
  warmKokoro,
  type SynthResult,
} from './vite/ttsEngines';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const CACHE_LIMIT = 160;
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Zero-key TTS for /debug/audio at /api/debug-tts, and a local /api/tts so narration still works when the
 * game server is not running. Dev and preview servers only; production builds keep using the game server.
 */
export function debugTtsPlugin(): Plugin {
  const cache = new Map<string, SynthResult>();
  const inflight = new Map<string, Promise<SynthResult>>();

  function remember(key: string, clip: SynthResult): void {
    cache.delete(key);
    cache.set(key, clip);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }

  async function produce(option: VoiceOption, text: string, skipCache: boolean) {
    const key = `${option.engine}|${option.voice}|${text}`;
    const started = performance.now();
    const hit = skipCache ? undefined : cache.get(key);
    if (hit) {
      remember(key, hit);
      return { clip: hit, cached: true, ms: performance.now() - started };
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = synthesize(option, text).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const clip = await pending;
    remember(key, clip);
    return { clip, cached: false, ms: performance.now() - started };
  }

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '');
    if (route !== DEBUG_TTS_ENDPOINT && route !== '/api/tts' && !route.startsWith(`${DEBUG_TTS_ENDPOINT}/`)) {
      next();
      return;
    }
    void handle(route, url, req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  };

  async function handle(route: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (route === `${DEBUG_TTS_ENDPOINT}/status`) {
      sendJson(res, 200, { ...engineStatus(), cacheSize: cache.size });
      return;
    }
    if (route === `${DEBUG_TTS_ENDPOINT}/warmup`) {
      void warmKokoro().catch(() => undefined);
      sendJson(res, 202, engineStatus());
      return;
    }
    if (route === `${DEBUG_TTS_ENDPOINT}/cache`) {
      if (req.method === 'DELETE') cache.clear();
      sendJson(res, 200, { cacheSize: cache.size });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use GET or POST' });
      return;
    }

    const params = req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return;
    }
    if (text.length > MAX_TTS_TEXT_LENGTH) {
      sendJson(res, 413, { error: `text is limited to ${MAX_TTS_TEXT_LENGTH} characters` });
      return;
    }

    const isGameRoute = route === '/api/tts';
    const requested = params.engine === undefined && isGameRoute ? DEFAULT_NARRATOR : findVoice(params.engine, params.voice);
    if (!requested) {
      sendJson(res, 400, { error: 'Unknown engine or voice' });
      return;
    }
    if (!isServerEngine(requested.engine)) {
      sendJson(res, 200, { useBrowserTts: true, engine: requested.engine, voice: requested.voice });
      return;
    }

    try {
      const skipCache = params.nocache === true || params.nocache === '1';
      const { clip, cached, ms } = await produce(requested, text, skipCache);
      res.statusCode = 200;
      res.setHeader('Content-Type', clip.contentType);
      res.setHeader('Content-Length', clip.audio.length);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-TTS-Engine', clip.via ? `${requested.engine} (${clip.via})` : requested.engine);
      res.setHeader('X-TTS-Voice', requested.voice);
      res.setHeader('X-TTS-Cached', cached ? 'hit' : 'miss');
      res.setHeader('X-TTS-Latency-Ms', String(Math.round(ms)));
      res.end(clip.audio);
    } catch (error) {
      const status = error instanceof EngineUnavailableError ? error.status : 502;
      // The game falls back to browser speech on any non-2xx, so a clear reason is all it needs.
      sendJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
        engine: requested.engine,
        voice: requested.voice,
      });
    }
  }

  return {
    name: 'once-upon-debug-tts',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), debugTtsPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: {
    port: 5173,
  },
});
