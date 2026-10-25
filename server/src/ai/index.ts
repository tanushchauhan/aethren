/**
 * Muse AI pipeline (Agent 1B).
 *
 * Exports `createAiService()` (implements `AiService` from `../contracts.ts`) and
 * `registerAiRoutes(app, ctx)` for `POST /api/chat-upload`, `/api/transcribe`, `/api/tts`
 * (plus `GET /api/tts`, `/api/images/:id` and `/api/placeholder/:kind.svg`).
 *
 * Layout:
 *   providers.ts   every external HTTP endpoint (unverified Meta shapes live here)
 *   spark.ts       MuseChat over the OpenAI SDK, structured-output helper
 *   instagram.ts   export parser + filter      cards.ts    card extraction + quote check
 *   world.ts       world schema, prompt, clamp images.ts   Muse Image + image store
 *   narrate.ts     live lines, lines.ts bank   incantation.ts  fuzzy match + mercy rule
 *   transcribe.ts  speech-to-text chain        tts.ts      TTS chain + LRU
 */
import type { AiService } from '../contracts';
import { createDefaultRuntime } from './runtime';
import { createAiServiceWith } from './service';

export function createAiService(): AiService {
  return createAiServiceWith(createDefaultRuntime());
}

export { registerAiRoutes } from './routes';
export { createAiServiceWith } from './service';
