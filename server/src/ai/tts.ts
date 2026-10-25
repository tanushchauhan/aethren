/**
 * Narrator and boss voice. Provider order: Muse TTS (only when `MUSE_TTS_MODEL` is set) ->
 * ElevenLabs -> OpenAI -> `null` (the route then tells the client to use `speechSynthesis`).
 * Each provider gets its own short budget. MP3 bytes are kept in a small LRU.
 */
import { createHash } from 'node:crypto';
import type { TtsRequest } from '@once-upon/shared';
import { createLru } from './lru';
import { elevenLabsTts, openAiCompatSpeech, ProviderError } from './providers';
import {
  describeError,
  ELEVENLABS_BASE_URL,
  ELEVENLABS_BOSS_VOICE_ID,
  OPENAI_BASE_URL,
  OPENAI_BOSS_VOICE,
  type AiRuntime,
} from './runtime';

export const TTS_PROVIDER_BUDGET_MS = 2500;
export const TTS_MAX_CHARS = 1000;
const LRU_MAX_ENTRIES = 300;
const LRU_MAX_BYTES = 40 * 1024 * 1024;

export type Speaker = TtsRequest['speaker'];
export type TtsProvider = 'muse' | 'elevenlabs' | 'openai';

export interface TtsAudio {
  audio: Buffer;
  provider: TtsProvider;
  key: string;
}

const NARRATOR_INSTRUCTIONS =
  'Warm, gentle storybook narrator reading a fairy tale aloud to friends. Unhurried, playful, a little hushed.';
const BOSS_INSTRUCTIONS = 'A theatrical fairy-tale villain: low, slow, sly and menacing, but fun.';

export function ttsKey(speaker: Speaker, text: string): string {
  return createHash('sha1').update(`${speaker}\n${text}`).digest('hex');
}

export function normalizeSpeaker(s: unknown): Speaker {
  return s === 'boss' ? 'boss' : 'narrator';
}

export function cleanTtsText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
}

export function createTts(rt: AiRuntime) {
  const cache = createLru<Buffer>(LRU_MAX_ENTRIES, LRU_MAX_BYTES);
  const providerOf = new Map<string, TtsProvider>();
  const inflight = new Map<string, Promise<TtsAudio | null>>();

  const providers: { name: TtsProvider; enabled: () => boolean; run: (text: string, speaker: Speaker) => Promise<Buffer> }[] = [
    {
      name: 'muse',
      enabled: () => rt.caps.tts && Boolean(rt.config.muse.apiKey && rt.config.muse.ttsModel),
      run: (text) =>
        openAiCompatSpeech({
          provider: 'muse-tts',
          baseUrl: rt.config.muse.baseUrl,
          apiKey: rt.config.muse.apiKey!,
          model: rt.config.muse.ttsModel!,
          voice: rt.config.muse.ttsVoice ?? 'default',
          text,
          timeoutMs: TTS_PROVIDER_BUDGET_MS,
        }),
    },
    {
      name: 'elevenlabs',
      enabled: () => rt.hasElevenLabs && Boolean(rt.config.elevenLabs.apiKey),
      run: async (text, speaker) => {
        const base = {
          baseUrl: ELEVENLABS_BASE_URL,
          apiKey: rt.config.elevenLabs.apiKey!,
          modelId: rt.config.elevenLabs.modelId,
          text,
        };
        const narratorVoice = rt.config.elevenLabs.voiceId;
        if (speaker !== 'boss' || ELEVENLABS_BOSS_VOICE_ID === narratorVoice) {
          return elevenLabsTts({ ...base, voiceId: narratorVoice, timeoutMs: TTS_PROVIDER_BUDGET_MS });
        }
        const started = Date.now();
        try {
          return await elevenLabsTts({ ...base, voiceId: ELEVENLABS_BOSS_VOICE_ID, timeoutMs: TTS_PROVIDER_BUDGET_MS });
        } catch (err) {
          // The boss voice may be missing from this account: retry with the narrator's voice.
          const left = TTS_PROVIDER_BUDGET_MS - (Date.now() - started);
          if (err instanceof ProviderError && (err.status === 400 || err.status === 404) && left > 500) {
            return elevenLabsTts({ ...base, voiceId: narratorVoice, timeoutMs: left });
          }
          throw err;
        }
      },
    },
    {
      name: 'openai',
      enabled: () => rt.hasOpenAI && Boolean(rt.config.openai.apiKey),
      run: (text, speaker) =>
        openAiCompatSpeech({
          provider: 'openai-tts',
          baseUrl: OPENAI_BASE_URL,
          apiKey: rt.config.openai.apiKey!,
          model: rt.config.openai.ttsModel,
          voice: speaker === 'boss' ? OPENAI_BOSS_VOICE : rt.config.openai.ttsVoice,
          text,
          instructions: rt.config.openai.ttsModel.startsWith('gpt-4o')
            ? speaker === 'boss'
              ? BOSS_INSTRUCTIONS
              : NARRATOR_INSTRUCTIONS
            : undefined,
          timeoutMs: TTS_PROVIDER_BUDGET_MS,
        }),
    },
  ];

  async function runChain(text: string, speaker: Speaker, key: string): Promise<TtsAudio | null> {
    for (const p of providers) {
      if (!p.enabled()) continue;
      try {
        const audio = await p.run(text, speaker);
        cache.set(key, audio);
        providerOf.set(key, p.name);
        return { audio, provider: p.name, key };
      } catch (err) {
        rt.warn(`tts ${p.name} failed: ${describeError(err)}`);
      }
    }
    return null;
  }

  /** MP3 bytes for a line, from cache or the provider chain. `null` means use speechSynthesis. */
  async function synthesize(rawText: string, rawSpeaker: unknown): Promise<TtsAudio | null> {
    const text = cleanTtsText(rawText);
    if (!text) return null;
    const speaker = normalizeSpeaker(rawSpeaker);
    const key = ttsKey(speaker, text);
    const hit = cache.get(key);
    if (hit) return { audio: hit, provider: providerOf.get(key) ?? 'elevenlabs', key };
    const pending = inflight.get(key);
    if (pending) return pending;
    const job = runChain(text, speaker, key).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  const anyProvider = () => providers.some((p) => p.enabled());

  /** Fills the cache one line at a time in the background. Never throws. */
  async function prewarm(lines: { text: string; speaker: Speaker }[]): Promise<number> {
    let ok = 0;
    for (const line of lines) {
      try {
        if (await synthesize(line.text, line.speaker)) ok++;
      } catch {
        // synthesize never throws, but stay safe in a background task
      }
    }
    return ok;
  }

  return { synthesize, prewarm, anyProvider, cacheSize: () => cache.size };
}
