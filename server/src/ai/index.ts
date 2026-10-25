/**
 * Muse AI pipeline (Agent 1B). STUB: replace freely, keeping the exported signatures.
 *
 * Exports `createAiService()` (implements `AiService` from `../contracts.ts`) and
 * `registerAiRoutes(app, ctx)` for `POST /api/chat-upload`, `/api/transcribe`, `/api/tts`.
 */
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import multer from 'multer';
import { P0_ELEMENTS } from '@once-upon/shared';
import type {
  ChatUploadResponse,
  MemoryCard,
  P0ElementType,
  TranscribeResponse,
  TtsFallbackResponse,
  TtsRequest,
  WorldSchema,
} from '@once-upon/shared';
import type { AiService, CachedPicks, NarrationEvent, ServerContext } from '../contracts';

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T;
}

const CACHED_WORLD = readJson<WorldSchema>('./cached-demo-world.json');
const FIXTURE_CARDS = readJson<MemoryCard[]>('./fixtures/memory-cards.json');
const CACHED_PICKS: CachedPicks = {
  encounterCardId: 'card-roadtrip',
  bossCardId: 'card-finals',
};

const FALLBACK_LINES: Record<string, string> = {
  intro: CACHED_WORLD.intro,
  telegraph: 'The enemy gathers itself. Watch closely!',
  dodge: 'Nimble as a fox in the brambles!',
  hit: 'Oof! The blow lands true.',
  parry: 'Sent right back where it came from!',
  cast: 'The magic answers your call.',
  fizzle: 'The words tangle, and the spell fizzles out.',
  twin_cast: 'Two voices, one spell!',
  ward_raised: 'A shimmering ward rises. Only two voices together can break it.',
  ward_shattered: 'The ward shatters like spun sugar!',
  enemy_defeated: 'The creature crumbles into leaves and moonlight.',
  boss_learned: 'The boss has learned your habits.',
  victory: 'And they lived happily ever after.',
  defeat: 'And so the tale ends early, for now.',
};

export function createAiService(): AiService {
  return {
    listMemoryCards: () => FIXTURE_CARDS,
    generateWorld: async () => CACHED_WORLD,
    getCachedWorld: () => CACHED_WORLD,
    getCachedPicks: () => CACHED_PICKS,
    generateImages: async () => {
      // Stub: no images. Clients show placeholder art until `world:image` arrives.
    },
    narrate: async (event: NarrationEvent) =>
      FALLBACK_LINES[event.kind] ?? 'The wood holds its breath.',
    muse: {
      available: false,
      complete: async () => null,
    },
  };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export function registerAiRoutes(app: Express, ctx: ServerContext): void {
  // Stub: ignores the upload and returns the fixture cards.
  app.post('/api/chat-upload', upload.single('file'), (_req, res) => {
    const body: ChatUploadResponse = { cards: ctx.ai.listMemoryCards() };
    res.json(body);
  });

  app.post('/api/transcribe', upload.single('audio'), (req, res) => {
    const { roomCode, playerId, element } = (req.body ?? {}) as Record<string, string | undefined>;
    if (!roomCode || !playerId || !P0_ELEMENTS.includes(element as P0ElementType)) {
      res.status(400).json({ error: 'roomCode, playerId and a P0 element are required' });
      return;
    }
    const el = element as P0ElementType;
    const expected =
      ctx.rooms.getIncantation(roomCode, el) ?? ctx.ai.getCachedWorld().incantations[el];
    // Stub: every incantation passes at full power so clients can test the cast flow.
    const result: TranscribeResponse = {
      transcript: expected,
      expected,
      matchRatio: 1,
      passed: true,
      mercy: false,
      attempt: 1,
      power: 1,
    };
    ctx.rooms.recordIncantation(roomCode, playerId, el, result);
    res.json(result);
  });

  app.post('/api/tts', (req, res) => {
    const { text } = (req.body ?? {}) as Partial<TtsRequest>;
    const body: TtsFallbackResponse = { fallback: 'speech_synthesis', text: text ?? '' };
    res.json(body);
  });
}
