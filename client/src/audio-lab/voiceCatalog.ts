/**
 * Voices compared on /debug/audio. Shared by the page and the Vite dev middleware in vite.config.ts,
 * so it must stay free of DOM access at import time. The middleware only synthesizes voices listed here.
 */

export const DEBUG_TTS_ENDPOINT = '/api/debug-tts';
export const COMBAT_DEADLINE_MS = 800;
export const MAX_TTS_TEXT_LENGTH = 600;
export const ACTIVE_NARRATOR_STORAGE_KEY = 'ouam-active-narrator';

export type TtsEngineId =
  | 'edge-neural'
  | 'kokoro-local'
  | 'macos-say'
  | 'google-translate-tts'
  | 'streamelements-polly'
  | 'tiktok-tts'
  | 'browser-web-speech';

export type EngineColumn = 'local' | 'online';

export interface EngineMeta {
  id: TtsEngineId;
  column: EngineColumn;
  title: string;
  blurb: string;
}

export interface VoiceOption {
  engine: TtsEngineId;
  /** Engine-native voice id: an Edge ShortName, Kokoro voice, `say -v` name, locale, or Polly name. */
  voice: string;
  label: string;
  persona: string;
  /** Edge prosody (`-12Hz`), `say` words-per-minute, or Web Speech pitch, depending on the engine. */
  pitch?: string;
  rate?: string;
}

export const ENGINES: readonly EngineMeta[] = [
  {
    id: 'kokoro-local',
    column: 'local',
    title: 'Kokoro-82M Local Neural',
    blurb: 'kokoro-js ONNX q8 on the M4 Pro CPU. The model downloads once, then runs offline.',
  },
  {
    id: 'macos-say',
    column: 'local',
    title: 'macOS Native Speech',
    blurb: '/usr/bin/say rendered to AIFF, converted to WAV with afconvert. No download.',
  },
  {
    id: 'browser-web-speech',
    column: 'local',
    title: 'Browser speechSynthesis',
    blurb: 'Instant voices built into this browser. Pitch and rate are tuned per persona.',
  },
  {
    id: 'edge-neural',
    column: 'online',
    title: 'Microsoft Edge Azure Neural',
    blurb: 'The Edge Read Aloud neural voices. No API key.',
  },
  {
    id: 'streamelements-polly',
    column: 'online',
    title: 'StreamElements / Amazon Polly',
    blurb: 'Public Polly proxy. It may now ask for a key; the card reports that.',
  },
  {
    id: 'tiktok-tts',
    column: 'online',
    title: 'TikTok TTS (Weilbyte proxy)',
    blurb: 'Community TikTok voice proxy. Often rate limited or offline.',
  },
  {
    id: 'google-translate-tts',
    column: 'online',
    title: 'Google Translate TTS',
    blurb: 'translate_tts with the tw-ob client. Fast, plain, no key.',
  },
];

export const VOICES: readonly VoiceOption[] = [
  { engine: 'kokoro-local', voice: 'bm_fable', label: 'Kokoro Fable', persona: 'British Storybook' },
  { engine: 'kokoro-local', voice: 'bm_george', label: 'Kokoro George', persona: 'Warm Narrator' },
  { engine: 'kokoro-local', voice: 'bf_emma', label: 'Kokoro Emma', persona: 'Enchanted Narrator' },
  { engine: 'kokoro-local', voice: 'am_adam', label: 'Kokoro Adam', persona: 'Deep Boss' },

  { engine: 'macos-say', voice: 'Daniel', label: 'Daniel', persona: 'UK Narrator' },
  { engine: 'macos-say', voice: 'Grandpa (English (UK))', label: 'Grandpa', persona: 'Fireside Elder' },
  { engine: 'macos-say', voice: 'Reed (English (UK))', label: 'Reed', persona: 'Plain Chronicler' },
  { engine: 'macos-say', voice: 'Samantha', label: 'Samantha', persona: 'US Storyteller' },
  { engine: 'macos-say', voice: 'Rocko (English (UK))', label: 'Rocko', persona: 'Gruff Squire' },
  { engine: 'macos-say', voice: 'Bad News', label: 'Bad News', persona: 'Doom Chant Boss' },

  { engine: 'browser-web-speech', voice: 'en-GB', label: 'Browser Narrator', persona: 'en-GB, pitch 0.92', pitch: '0.92', rate: '0.95' },
  { engine: 'browser-web-speech', voice: 'en-US', label: 'Browser Boss', persona: 'en-US, pitch 0.4', pitch: '0.4', rate: '0.86' },

  { engine: 'edge-neural', voice: 'en-GB-RyanNeural', label: 'Ryan', persona: 'The Royal Bard' },
  { engine: 'edge-neural', voice: 'en-GB-SoniaNeural', label: 'Sonia', persona: 'The Fairy Godmother' },
  { engine: 'edge-neural', voice: 'en-IE-ConnorNeural', label: 'Connor', persona: 'The Celtic Storyteller' },
  { engine: 'edge-neural', voice: 'en-AU-WilliamNeural', label: 'William', persona: 'The Elder Chronicler' },
  {
    engine: 'edge-neural',
    voice: 'en-US-GuyNeural',
    label: 'Guy (pitched)',
    persona: 'The Rusted Iron Boss',
    pitch: '-12Hz',
    rate: '-8%',
  },

  { engine: 'streamelements-polly', voice: 'Brian', label: 'Brian', persona: 'UK Narrator' },
  { engine: 'streamelements-polly', voice: 'Amy', label: 'Amy', persona: 'UK Storyteller' },
  { engine: 'streamelements-polly', voice: 'Matthew', label: 'Matthew', persona: 'US Herald' },

  { engine: 'tiktok-tts', voice: 'en_uk_001', label: 'UK Narrator', persona: 'TikTok en_uk_001' },
  { engine: 'tiktok-tts', voice: 'en_us_ghostface', label: 'Ghostface', persona: 'TikTok Boss' },

  { engine: 'google-translate-tts', voice: 'en-GB', label: 'Google UK', persona: 'en-GB British' },
  { engine: 'google-translate-tts', voice: 'en-IE', label: 'Google Irish', persona: 'en-IE Irish' },
  { engine: 'google-translate-tts', voice: 'en-US', label: 'Google US', persona: 'en-US American' },
  { engine: 'google-translate-tts', voice: 'en-AU', label: 'Google AU', persona: 'en-AU Australian' },
];

export const DEFAULT_NARRATOR: VoiceOption = VOICES.find((v) => v.voice === 'en-GB-RyanNeural')!;

export interface ScriptPreset {
  id: string;
  icon: string;
  title: string;
  text: string;
}

export const SCRIPT_PRESETS: readonly ScriptPreset[] = [
  {
    id: 'intro',
    icon: '📖',
    title: 'Storybook Intro',
    text: 'Once upon a time, in a wood woven from your midnight group chat, the Rusted Corolla stirred beneath the roots...',
  },
  {
    id: 'telegraph',
    icon: '⚡',
    title: 'Combat Telegraph',
    text: 'Maya, the iron steed sweeps low! Step out of your silhouette now!',
  },
  {
    id: 'taunt',
    icon: '💀',
    title: 'Boss Taunt',
    text: 'I have learned your habits, Spellbearer. Your left-side dodge will not save you twice!',
  },
  {
    id: 'fizzle',
    icon: '🔥',
    title: 'Incantation Fizzle',
    text: 'Your words trembled in the mist, and the Ember spark dissolved into smoke.',
  },
  {
    id: 'victory',
    icon: '✨',
    title: 'Ward Shatter & Victory',
    text: 'Together your voices rang as one! The ancient ward shatters, and the storybook opens!',
  },
];

export function engineMeta(id: TtsEngineId): EngineMeta {
  return ENGINES.find((engine) => engine.id === id)!;
}

export function isEngineId(value: unknown): value is TtsEngineId {
  return typeof value === 'string' && ENGINES.some((engine) => engine.id === value);
}

export function findVoice(engine: unknown, voice: unknown): VoiceOption | null {
  if (!isEngineId(engine) || typeof voice !== 'string') return null;
  return VOICES.find((option) => option.engine === engine && option.voice === voice) ?? null;
}

export function voiceKey(option: Pick<VoiceOption, 'engine' | 'voice'>): string {
  return `${option.engine}:${option.voice}`;
}

export function voicesFor(engine: TtsEngineId): VoiceOption[] {
  return VOICES.filter((option) => option.engine === engine);
}

/** The narrator chosen on /debug/audio, or null when the game should use its own server voice. */
export function readActiveNarrator(): VoiceOption | null {
  try {
    const raw = globalThis.localStorage?.getItem(ACTIVE_NARRATOR_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return findVoice(record.engine, record.voice);
  } catch {
    return null;
  }
}

export function writeActiveNarrator(option: VoiceOption | null): void {
  try {
    if (option) {
      globalThis.localStorage?.setItem(
        ACTIVE_NARRATOR_STORAGE_KEY,
        JSON.stringify({ engine: option.engine, voice: option.voice }),
      );
    } else {
      globalThis.localStorage?.removeItem(ACTIVE_NARRATOR_STORAGE_KEY);
    }
  } catch {
    /* Storage can be unavailable in private contexts. */
  }
}
