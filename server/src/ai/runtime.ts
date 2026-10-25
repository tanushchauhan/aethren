/**
 * What the AI module needs from the outside world, gathered in one object so tests can swap
 * the config, the capability flags and the chat client without touching `config.ts`.
 */
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import {
  config as defaultConfig,
  hasElevenLabs as defaultHasElevenLabs,
  hasOpenAI as defaultHasOpenAI,
  museCapabilities as defaultMuseCapabilities,
  type AppConfig,
} from '../config';

/** The one chat-completions method we use, so tests can hand in a tiny mock. */
export interface ChatClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
      ): Promise<ChatCompletion>;
    };
  };
}

export interface MuseCaps {
  spark: boolean;
  transcribe: boolean;
  image: boolean;
  tts: boolean;
}

export interface AiRuntime {
  config: AppConfig;
  caps: MuseCaps;
  hasElevenLabs: boolean;
  hasOpenAI: boolean;
  /** Muse Spark client (OpenAI SDK pointed at the Meta Model API). Null when Spark is off. */
  chatClient: ChatClient | null;
  /** Pre-warm the TTS cache in the background on startup. */
  prewarmTts: boolean;
  /** One-line warnings. Never pass key values; {@link redact} is applied anyway. */
  warn: (msg: string) => void;
}

/** The ElevenLabs premade voice for the boss when config does not give one ("Callum", husky and sly). */
export const ELEVENLABS_BOSS_VOICE_ID = 'N2lVS1w4EtoT3dr4eOWO';
/** OpenAI voice for the boss (deep). The narrator uses `config.openai.ttsVoice`. */
export const OPENAI_BOSS_VOICE = 'onyx';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

export function createMuseClient(cfg: AppConfig): ChatClient | null {
  if (!cfg.muse.apiKey) return null;
  const client = new OpenAI({ apiKey: cfg.muse.apiKey, baseURL: cfg.muse.baseUrl, maxRetries: 0 });
  return {
    chat: {
      completions: {
        create: (body, options) => client.chat.completions.create(body, options),
      },
    },
  };
}

/** Replaces any configured secret that slipped into a message with `***`. */
export function redact(msg: string, cfg: AppConfig = defaultConfig): string {
  let out = msg;
  for (const secret of [cfg.muse.apiKey, cfg.elevenLabs.apiKey, cfg.openai.apiKey, cfg.mcpBearerToken]) {
    if (secret && secret.length >= 6) out = out.split(secret).join('***');
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/g, '$1***').replace(/\s+/g, ' ').slice(0, 240);
}

export function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; name?: unknown; message?: unknown };
    const status = typeof e.status === 'number' ? `status=${e.status} ` : '';
    const name = typeof e.name === 'string' ? e.name : 'Error';
    const message = typeof e.message === 'string' ? e.message : '';
    return `${status}${name}: ${message}`;
  }
  return String(err);
}

export function createDefaultRuntime(): AiRuntime {
  const cfg = defaultConfig;
  return {
    config: cfg,
    caps: { ...defaultMuseCapabilities },
    hasElevenLabs: defaultHasElevenLabs,
    hasOpenAI: defaultHasOpenAI,
    chatClient: defaultMuseCapabilities.spark ? createMuseClient(cfg) : null,
    prewarmTts: !process.env.VITEST,
    warn: (msg) => console.warn(`[ai] ${redact(msg, cfg)}`),
  };
}
