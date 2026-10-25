import { readActiveNarrator, type VoiceOption } from '../../audio-lab/voiceCatalog';
import { serverUrl } from './serverUrl';

/**
 * Narration for every combat screen.
 * Laptop A should use the Google Home Mini as its Bluetooth speaker.
 * Only the Spellbearer client invokes playback; the Partner sees captions. This module never calls Muse or
 * ElevenLabs and holds no API keys. It only asks our server at /api/tts, or, when a narrator was chosen on
 * /debug/audio, the Vite dev server's /api/tts with that engine and voice.
 */

const TTS_DEADLINE_MS = 800;

export interface NarrationRequest {
  text: string;
  audioUrl?: string | null;
  useBrowserTts?: boolean;
}

type TtsClip = { kind: 'url'; url: string } | { kind: 'blob'; blob: Blob };

let generation = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let fallbackTimer = 0;
let speakTimer = 0;
let inflight: AbortController | null = null;
let active = false;
const listeners = new Set<(speaking: boolean) => void>();

function setActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener(next);
}

export function onNarrationActive(listener: (speaking: boolean) => void): () => void {
  listeners.add(listener);
  listener(active);
  return () => {
    listeners.delete(listener);
  };
}

function releaseAudio(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

export function stopNarration(): void {
  generation += 1;
  window.clearTimeout(fallbackTimer);
  window.clearTimeout(speakTimer);
  fallbackTimer = 0;
  speakTimer = 0;
  inflight?.abort();
  inflight = null;
  releaseAudio();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  setActive(false);
}

function browserSpeak(text: string, token: number): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.clearTimeout(speakTimer);
  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();
  setActive(true);
  speakTimer = window.setTimeout(() => {
    if (token !== generation) return;
    const narrator = readActiveNarrator();
    const tuned = narrator?.engine === 'browser-web-speech' ? narrator : null;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = tuned?.rate ? Number(tuned.rate) : 1;
    utterance.pitch = tuned?.pitch ? Number(tuned.pitch) : 0.92;
    utterance.lang = tuned?.voice ?? 'en-US';
    utterance.onend = () => {
      if (token === generation) setActive(false);
    };
    utterance.onerror = () => {
      if (token === generation) setActive(false);
    };
    window.speechSynthesis.speak(utterance);
  }, 60);
}

function resolveAudioUrl(url: string): string {
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  const base = serverUrl();
  if (url.startsWith('/')) return `${base}${url}`;
  return `${base}/${url}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function postTts(url: string, body: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/*,application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/** The dev server answers /api/tts itself, so narration keeps a real voice while the game server is down. */
function canUseDevTts(base: string): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && window.location.origin !== base;
}

async function fetchTts(text: string, signal: AbortSignal, narrator: VoiceOption | null): Promise<TtsClip> {
  const base = serverUrl();
  let response: Response;
  if (narrator) {
    response = await postTts('/api/tts', { text, engine: narrator.engine, voice: narrator.voice }, signal);
  } else {
    try {
      response = await postTts(`${base}/api/tts`, { text }, signal);
    } catch (error) {
      if (signal.aborted || !canUseDevTts(base)) throw error;
      response = await postTts('/api/tts', { text }, signal);
    }
  }
  if (!narrator && (response.status === 404 || response.status === 405)) {
    response = await fetch(`${base}/api/tts?text=${encodeURIComponent(text)}`, {
      method: 'GET',
      headers: { Accept: 'audio/*,application/json' },
      signal,
    });
  }
  if (!response.ok) throw new Error(`TTS failed (${response.status})`);
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    const payload: unknown = await response.json();
    const record = asRecord(payload);
    if (!record) throw new Error('TTS JSON was empty');
    if (record.useBrowserTts === true) throw new Error('browser tts');
    const url = readString(record, ['audioUrl', 'url', 'audio']);
    if (!url) throw new Error('TTS JSON had no audio');
    return { kind: 'url', url: resolveAudioUrl(url) };
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('TTS audio was empty');
  return { kind: 'blob', blob };
}

function playUrl(url: string, token: number, text: string, ownsUrl: boolean): void {
  const audio = new Audio(url);
  currentAudio = audio;
  let fellBack = false;
  const fallback = () => {
    if (fellBack || token !== generation) return;
    fellBack = true;
    browserSpeak(text, token);
  };
  audio.onended = () => {
    if (token === generation) setActive(false);
    if (ownsUrl && currentObjectUrl === url) {
      URL.revokeObjectURL(url);
      currentObjectUrl = null;
    }
  };
  audio.onplaying = () => {
    if (token === generation) setActive(true);
  };
  audio.onerror = () => fallback();
  void audio.play().then(
    () => {
      if (token === generation) setActive(true);
    },
    () => fallback(),
  );
}

function playBlob(blob: Blob, token: number, text: string): void {
  const url = URL.createObjectURL(blob);
  currentObjectUrl = url;
  playUrl(url, token, text, true);
}

export function playNarration(request: NarrationRequest): void {
  const text = request.text.trim();
  if (!text || typeof window === 'undefined') return;
  stopNarration();
  const token = generation;

  const narrator = readActiveNarrator();
  if (request.useBrowserTts || narrator?.engine === 'browser-web-speech') {
    browserSpeak(text, token);
    return;
  }
  if (request.audioUrl) {
    playUrl(resolveAudioUrl(request.audioUrl), token, text, false);
    return;
  }

  const controller = new AbortController();
  inflight = controller;
  const started = performance.now();
  let usedBrowser = false;
  fallbackTimer = window.setTimeout(() => {
    if (token !== generation) return;
    usedBrowser = true;
    browserSpeak(text, token);
    controller.abort();
  }, TTS_DEADLINE_MS);

  void (async () => {
    try {
      const clip = await fetchTts(text, controller.signal, narrator);
      if (token !== generation) return;
      if (usedBrowser || performance.now() - started > TTS_DEADLINE_MS) {
        if (!usedBrowser) browserSpeak(text, token);
        return;
      }
      window.clearTimeout(fallbackTimer);
      if (clip.kind === 'url') playUrl(clip.url, token, text, false);
      else playBlob(clip.blob, token, text);
    } catch {
      if (token !== generation || usedBrowser) return;
      window.clearTimeout(fallbackTimer);
      browserSpeak(text, token);
    }
  })();
}
