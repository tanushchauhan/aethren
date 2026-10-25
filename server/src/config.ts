/**
 * Typed server configuration. ORCHESTRATOR-OWNED: module agents read from it, never edit it.
 *
 * Every AI key is optional. A missing key means that provider is "unavailable" and the code
 * that would call it must fall back (cached world, prewritten lines, `speechSynthesis`,
 * scripted boss). Nothing here throws on a missing key.
 */
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { AI_DEFAULT_TIMEOUT_MS } from '@once-upon/shared';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

/** Blank strings in `.env` count as unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/** Like {@link optionalString}, but a blank or missing value falls back to `fallback`. */
const stringWithDefault = (fallback: string) =>
  optionalString.transform((v) => v ?? fallback);

/**
 * Researched defaults (2026-10-25), so only `MUSE_API_KEY` has to be set. Sources are listed
 * next to each value in `server/.env.example`. Muse has no TTS model as far as public docs show,
 * so `MUSE_TTS_MODEL` has no default and Muse TTS stays off unless it is set.
 */
export const AI_DEFAULTS = {
  museBaseUrl: 'https://api.meta.ai/v1',
  museSparkModel: 'muse-spark-1.3',
  museTranscribeModel: 'muse-voice-transcribe-1.0',
  museImageModel: 'muse-image-1.0',
  /** ElevenLabs premade "George - Warm, Captivating Storyteller". */
  elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
  elevenLabsModelId: 'eleven_flash_v2_5',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiTtsVoice: 'marin',
} as const;

const booleanFlag = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase()));

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    });

const EnvSchema = z.object({
  NODE_ENV: optionalString,
  PORT: positiveInt(3001),
  PUBLIC_BASE_URL: optionalString,
  CLIENT_ORIGIN: optionalString,
  MUSE_API_KEY: optionalString,
  MUSE_BASE_URL: stringWithDefault(AI_DEFAULTS.museBaseUrl),
  MUSE_SPARK_MODEL: stringWithDefault(AI_DEFAULTS.museSparkModel),
  MUSE_TRANSCRIBE_MODEL: stringWithDefault(AI_DEFAULTS.museTranscribeModel),
  MUSE_IMAGE_MODEL: stringWithDefault(AI_DEFAULTS.museImageModel),
  MUSE_TTS_MODEL: optionalString,
  MUSE_TTS_VOICE: optionalString,
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_VOICE_ID: stringWithDefault(AI_DEFAULTS.elevenLabsVoiceId),
  ELEVENLABS_MODEL_ID: stringWithDefault(AI_DEFAULTS.elevenLabsModelId),
  OPENAI_API_KEY: optionalString,
  OPENAI_TTS_MODEL: stringWithDefault(AI_DEFAULTS.openaiTtsModel),
  OPENAI_TTS_VOICE: stringWithDefault(AI_DEFAULTS.openaiTtsVoice),
  MCP_BEARER_TOKEN: optionalString,
  USE_CACHED_WORLD: booleanFlag,
  AI_TIMEOUT_MS: positiveInt(AI_DEFAULT_TIMEOUT_MS),
});

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  /** Base for join links and the MCP connector URL, without a trailing slash. */
  publicBaseUrl: string;
  /** Allowed browser origins. `true` allows any origin (dev default when unset). */
  clientOrigin: string[] | true;
  muse: {
    apiKey?: string;
    /** Always set: falls back to {@link AI_DEFAULTS} when blank. Same for the model IDs below. */
    baseUrl: string;
    sparkModel: string;
    transcribeModel: string;
    imageModel: string;
    /** No researched default: Muse TTS is off unless `MUSE_TTS_MODEL` is set. */
    ttsModel?: string;
    ttsVoice?: string;
  };
  elevenLabs: { apiKey?: string; voiceId: string; modelId: string };
  openai: { apiKey?: string; ttsModel: string; ttsVoice: string };
  mcpBearerToken?: string;
  /** Skip Muse world generation and serve `ai/cached-demo-world.json`. */
  useCachedWorld: boolean;
  /** Per-call AI timeout in ms. */
  aiTimeoutMs: number;
}

/** Parses an env object into {@link AppConfig}. Exported so tests can build configs. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = EnvSchema.parse(env);
  const nodeEnv = e.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: e.PORT,
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    clientOrigin: e.CLIENT_ORIGIN
      ? e.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
      : true,
    muse: {
      apiKey: e.MUSE_API_KEY,
      baseUrl: e.MUSE_BASE_URL,
      sparkModel: e.MUSE_SPARK_MODEL,
      transcribeModel: e.MUSE_TRANSCRIBE_MODEL,
      imageModel: e.MUSE_IMAGE_MODEL,
      ttsModel: e.MUSE_TTS_MODEL,
      ttsVoice: e.MUSE_TTS_VOICE,
    },
    elevenLabs: {
      apiKey: e.ELEVENLABS_API_KEY,
      voiceId: e.ELEVENLABS_VOICE_ID,
      modelId: e.ELEVENLABS_MODEL_ID,
    },
    openai: { apiKey: e.OPENAI_API_KEY, ttsModel: e.OPENAI_TTS_MODEL, ttsVoice: e.OPENAI_TTS_VOICE },
    mcpBearerToken: e.MCP_BEARER_TOKEN,
    useCachedWorld: e.USE_CACHED_WORLD,
    aiTimeoutMs: e.AI_TIMEOUT_MS,
  };
}

export const config: AppConfig = loadConfig();

/** Muse key is set (the base URL always has a default). Check the per-model flags below before each call. */
export const hasMuse = Boolean(config.muse.apiKey && config.muse.baseUrl);

/**
 * Per-capability Muse availability: the key is set and that model's ID resolves (a researched
 * default counts as set). `tts` has no default, so it needs `MUSE_TTS_MODEL`.
 */
export const museCapabilities = {
  spark: hasMuse && Boolean(config.muse.sparkModel),
  transcribe: hasMuse && Boolean(config.muse.transcribeModel),
  image: hasMuse && Boolean(config.muse.imageModel),
  tts: hasMuse && Boolean(config.muse.ttsModel),
} as const;

export const hasElevenLabs = Boolean(config.elevenLabs.apiKey && config.elevenLabs.voiceId);
export const hasOpenAI = Boolean(config.openai.apiKey);
