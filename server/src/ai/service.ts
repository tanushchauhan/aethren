/**
 * Builds the {@link AiService} and the private pieces the HTTP routes share with it
 * (card store, TTS cache, image store, transcriber, mercy tracker).
 */
import { readFileSync } from 'node:fs';
import type { MemoryCard, WorldSchema } from '@once-upon/shared';
import type { AiService, CachedPicks } from '../contracts';
import { createCardStore } from './cards';
import { createImageService } from './images';
import { createMercyTracker } from './incantation';
import { allLinesFor } from './lines';
import { narrate } from './narrate';
import { createDefaultRuntime, type AiRuntime } from './runtime';
import { createMuseChat } from './spark';
import { createTranscriber } from './transcribe';
import { createTts, type Speaker } from './tts';
import { clampWorld, generateWorldDetailed, StrictWorldSchema, withPlayerNames } from './world';

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T;
}

/** Loads `cached-demo-world.json`, clamping it if someone saved an out-of-spec world. */
export function loadCachedWorld(): WorldSchema {
  const raw = readJson<unknown>('./cached-demo-world.json');
  const strict = StrictWorldSchema.safeParse(raw);
  if (strict.success) return strict.data as WorldSchema;
  const clamped = clampWorld(raw, { cached: raw as WorldSchema, encounterCard: null, bossCard: null });
  if (!clamped) throw new Error('cached-demo-world.json is not a usable world');
  console.warn('[ai] cached-demo-world.json failed the strict schema; serving a clamped copy');
  return clamped;
}

export const CACHED_WORLD: WorldSchema = loadCachedWorld();
export const FIXTURE_CARDS: MemoryCard[] = readJson<MemoryCard[]>('./fixtures/memory-cards.json');
export const CACHED_PICKS: CachedPicks = { encounterCardId: 'card-roadtrip', bossCardId: 'card-finals' };

export interface AiInternals {
  rt: AiRuntime;
  cards: ReturnType<typeof createCardStore>;
  tts: ReturnType<typeof createTts>;
  images: ReturnType<typeof createImageService>;
  transcriber: ReturnType<typeof createTranscriber>;
  mercy: ReturnType<typeof createMercyTracker>;
}

const internalsByService = new WeakMap<AiService, AiInternals>();

/** The TTS lines worth having ready before the first round of the cached world. */
export function prewarmLines(world: WorldSchema): { text: string; speaker: Speaker }[] {
  const encounter = world.encounters[0];
  const narrator = (text: string) => ({ text, speaker: 'narrator' as const });
  return [
    narrator(world.intro),
    ...(encounter?.lines ?? []).map(narrator),
    ...world.boss.lines.map((text) => ({ text, speaker: 'boss' as const })),
    ...[encounter?.name, world.boss.name].flatMap((enemy) =>
      enemy
        ? allLinesFor(['telegraph_low_sweep', 'telegraph_high_swing', 'telegraph_projectile'], { enemy }).map(narrator)
        : [],
    ),
  ];
}

export function createAiServiceWith(rt: AiRuntime): AiService {
  const muse = createMuseChat(rt);
  const internals: AiInternals = {
    rt,
    cards: createCardStore(FIXTURE_CARDS),
    tts: createTts(rt),
    images: createImageService(rt, CACHED_WORLD.title),
    transcriber: createTranscriber(rt),
    mercy: createMercyTracker(),
  };

  const service: AiService = {
    listMemoryCards: () => internals.cards.list(),
    generateWorld: async (input) => {
      const result = await generateWorldDetailed(muse, input, {
        cached: CACHED_WORLD,
        useCachedWorld: rt.config.useCachedWorld,
        timeoutMs: rt.config.aiTimeoutMs,
      });
      if (result.source === 'cached' && !rt.config.useCachedWorld) {
        rt.warn(`world generation fell back to the cached world: ${result.reason}`);
      }
      return result.world;
    },
    getCachedWorld: () => structuredClone(CACHED_WORLD),
    getCachedPicks: () => ({ ...CACHED_PICKS }),
    generateImages: (world, onImage) => internals.images.generateImages(world, onImage),
    narrate: (event) => narrate(muse, event),
    muse,
  };
  internalsByService.set(service, internals);

  if (rt.prewarmTts && rt.hasElevenLabs) {
    const timer = setTimeout(() => {
      const lines = prewarmLines(withPlayerNames(CACHED_WORLD, []));
      void internals.tts.prewarm(lines).then((n) => {
        console.log(`[ai] tts pre-warm cached ${n}/${lines.length} lines`);
      });
    }, 0);
    timer.unref?.();
  }
  return service;
}

/** The routes' view of a service. A foreign `AiService` (a test double) gets fresh internals. */
export function internalsFor(ai: AiService): AiInternals {
  let found = internalsByService.get(ai);
  if (!found) {
    const rt = createDefaultRuntime();
    found = {
      rt,
      cards: createCardStore(FIXTURE_CARDS),
      tts: createTts(rt),
      images: createImageService(rt, CACHED_WORLD.title),
      transcriber: createTranscriber(rt),
      mercy: createMercyTracker(),
    };
    internalsByService.set(ai, found);
  }
  return found;
}
