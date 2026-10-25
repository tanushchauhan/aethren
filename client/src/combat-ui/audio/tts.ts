import { readActiveNarrator, type VoiceOption } from '../../audio-lab/voiceCatalog';
import { serverUrl } from './serverUrl';

/**
 * Narration for every combat screen.
 * Laptop A should use the Google Home Mini as its Bluetooth speaker.
 * Only the Spellbearer client invokes playback; the Partner sees captions. This module never calls Muse or
 * ElevenLabs and holds no API keys. It only asks our server at /api/tts, or, when a narrator was chosen on
 * /debug/audio, the Vite dev server's /api/tts with that engine and voice.
 */

/** How long to wait for the server's voice before speaking with the browser instead. */
const TTS_DEADLINE_MS = 3000;
/** Lines waiting behind the one playing; older waiting lines drop first (never the playing one). */
const MAX_WAITING = 3;

export interface NarrationRequest {
  text: string;
  audioUrl?: string | null;
  useBrowserTts?: boolean;
  /** The server tags boss lines so they get the boss voice. */
  speaker?: 'narrator' | 'boss';
}

/** What the narrator is doing, for the Skip control. */
export interface NarrationQueueState {
  playing: string | null;
  waiting: number;
  paused: boolean;
}

type TtsClip = { kind: 'url'; url: string } | { kind: 'blob'; blob: Blob };

let generation = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let fallbackTimer = 0;
let speakTimer = 0;
let safetyTimer = 0;
let inflight: AbortController | null = null;
let active = false;
let queue: NarrationRequest[] = [];
let current: NarrationRequest | null = null;
let paused = false;
/** A line whose audio arrived while narration was paused (push-to-talk); it starts on resume. */
let pendingStart: (() => void) | null = null;
const listeners = new Set<(speaking: boolean) => void>();
const queueListeners = new Set<(state: NarrationQueueState) => void>();

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

function queueState(): NarrationQueueState {
  return { playing: current?.text ?? null, waiting: queue.length, paused };
}

function notifyQueue(): void {
  const state = queueState();
  for (const listener of queueListeners) listener(state);
}

export function onNarrationQueue(listener: (state: NarrationQueueState) => void): () => void {
  queueListeners.add(listener);
  listener(queueState());
  return () => {
    queueListeners.delete(listener);
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

/** Silences the line in progress without touching the queue. */
function haltLine(): void {
  generation += 1;
  window.clearTimeout(fallbackTimer);
  window.clearTimeout(speakTimer);
  window.clearTimeout(safetyTimer);
  fallbackTimer = 0;
  speakTimer = 0;
  safetyTimer = 0;
  pendingStart = null;
  inflight?.abort();
  inflight = null;
  releaseAudio();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Stops narration and forgets every waiting line. */
export function stopNarration(): void {
  haltLine();
  queue = [];
  current = null;
  setActive(false);
  notifyQueue();
}

/** Called once per line when it ends for any reason; starts the next waiting line. */
function finishLine(token: number): void {
  if (token !== generation) return;
  haltLine();
  current = null;
  setActive(false);
  playNext();
}

/** Skips the line playing now; the next waiting line starts. */
export function skipNarration(): void {
  if (current) finishLine(generation);
}

/** Skips the line playing now and every waiting line. */
export function skipAllNarration(): void {
  stopNarration();
}

/** Holds narration (for push-to-talk, so the microphone does not hear it). */
export function pauseNarration(): void {
  if (paused) return;
  paused = true;
  window.clearTimeout(safetyTimer);
  currentAudio?.pause();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.pause();
  notifyQueue();
}

export function resumeNarration(): void {
  if (!paused) return;
  paused = false;
  if (current) armSafety(current.text, generation);
  if (pendingStart) {
    const start = pendingStart;
    pendingStart = null;
    start();
  } else {
    void currentAudio?.play().catch(() => undefined);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.resume();
  }
  playNext();
  notifyQueue();
}

/** Runs `start` now, or when narration resumes. */
function whenUnpaused(start: () => void): void {
  if (paused) pendingStart = start;
  else start();
}

/** If a voice never reports its end (a known speechSynthesis issue), move on anyway. */
function armSafety(text: string, token: number): void {
  window.clearTimeout(safetyTimer);
  const words = text.split(/\s+/).filter(Boolean).length;
  safetyTimer = window.setTimeout(() => finishLine(token), TTS_DEADLINE_MS + 6000 + words * 700);
}

function browserSpeak(text: string, token: number): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    globalThis.setTimeout(() => finishLine(token), 0);
    return;
  }
  window.clearTimeout(speakTimer);
  window.speechSynthesis.cancel();
  whenUnpaused(() => {
    if (token !== generation) return;
    window.speechSynthesis.resume();
    setActive(true);
    speakTimer = window.setTimeout(() => {
      if (token !== generation) return;
      // A Web Speech narrator chosen on /debug/audio tunes the browser voice.
      const narrator = readActiveNarrator();
      const tuned = narrator?.engine === 'browser-web-speech' ? narrator : null;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = tuned?.rate ? Number(tuned.rate) : 1;
      utterance.pitch = tuned?.pitch ? Number(tuned.pitch) : 0.92;
      utterance.lang = tuned?.voice ?? 'en-US';
      utterance.onend = () => finishLine(token);
      utterance.onerror = () => finishLine(token);
      window.speechSynthesis.speak(utterance);
    }, 60);
  });
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

async function fetchTts(
  text: string,
  speaker: NarrationRequest['speaker'],
  signal: AbortSignal,
  narrator: VoiceOption | null,
): Promise<TtsClip> {
  const base = serverUrl();
  let response: Response;
  if (narrator) {
    response = await postTts('/api/tts', { text, engine: narrator.engine, voice: narrator.voice }, signal);
  } else {
    // The game server tags boss lines so they get the boss voice.
    const body: Record<string, string> = speaker ? { text, speaker } : { text };
    try {
      response = await postTts(`${base}/api/tts`, body, signal);
    } catch (error) {
      if (signal.aborted || !canUseDevTts(base)) throw error;
      response = await postTts('/api/tts', body, signal);
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
    if (ownsUrl && currentObjectUrl === url) {
      URL.revokeObjectURL(url);
      currentObjectUrl = null;
    }
    finishLine(token);
  };
  audio.onplaying = () => {
    if (token === generation) setActive(true);
  };
  audio.onerror = () => fallback();
  whenUnpaused(() => {
    if (token !== generation) return;
    void audio.play().then(
      () => {
        if (token === generation) setActive(true);
      },
      () => fallback(),
    );
  });
}

function playBlob(blob: Blob, token: number, text: string): void {
  const url = URL.createObjectURL(blob);
  currentObjectUrl = url;
  playUrl(url, token, text, true);
}

function startLine(request: NarrationRequest): void {
  const text = request.text;
  const token = generation;
  armSafety(text, token);

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
  let usedBrowser = false;
  fallbackTimer = window.setTimeout(() => {
    if (token !== generation) return;
    usedBrowser = true;
    controller.abort();
    browserSpeak(text, token);
  }, TTS_DEADLINE_MS);

  void (async () => {
    try {
      const clip = await fetchTts(text, request.speaker, controller.signal, narrator);
      if (token !== generation || usedBrowser) return;
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

function playNext(): void {
  if (current || paused) {
    notifyQueue();
    return;
  }
  const next = queue.shift();
  if (next) {
    current = next;
    startLine(next);
  }
  notifyQueue();
}

/**
 * Queues a line. Lines play one after another and are never cut off by a newer line;
 * use {@link skipNarration} to move on. A line identical to the one playing or last
 * queued is ignored (the same line can arrive as an event and in room state).
 */
export function playNarration(request: NarrationRequest): void {
  const text = request.text.trim();
  if (!text || typeof window === 'undefined') return;
  if (current?.text === text || queue.at(-1)?.text === text) return;
  queue.push({ ...request, text });
  while (queue.length > MAX_WAITING) queue.shift();
  playNext();
}
