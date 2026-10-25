import type { ElementP0 } from '../../net/contract';
import { useGameStore } from '../../net/store';
import { serverUrl } from './serverUrl';
import { toWav16k } from './wav';

export interface TranscribeResult {
  transcript: string;
  pass: boolean | null;
}

const TRANSCRIBE_TIMEOUT_MS = 8000;

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** About 60% of the expected words must show up. Order can wander. */
export function phraseMatches(transcript: string, expected: string): boolean {
  const need = words(expected);
  if (need.length === 0) return true;
  const said = new Set(words(transcript));
  const hits = need.filter((word) => said.has(word)).length;
  return hits / need.length >= 0.6;
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

function readBool(record: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function audioName(blob: Blob): string {
  if (blob.type.includes('wav')) return 'incantation.wav';
  if (blob.type.includes('mp4')) return 'incantation.m4a';
  return 'incantation.webm';
}

export async function transcribeClip(blob: Blob, element: ElementP0): Promise<TranscribeResult> {
  // The server credits the incantation to this seat, so the next cast can use it.
  const { gameState, localPlayerId } = useGameStore.getState();
  const audio = (await toWav16k(blob)) ?? blob;
  const body = new FormData();
  body.append('audio', audio, audioName(audio));
  body.append('element', element);
  if (gameState?.roomCode) body.append('roomCode', gameState.roomCode);
  if (localPlayerId) body.append('playerId', localPlayerId);

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverUrl()}/api/transcribe?element=${encodeURIComponent(element)}`, {
      method: 'POST',
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Transcribe failed (${response.status})`);
    const payload: unknown = await response.json();
    const record = asRecord(payload);
    if (!record) throw new Error('Transcribe response was empty');
    const transcript = readString(record, ['transcript', 'text', 'utterance']);
    const pass = readBool(record, ['passed', 'pass', 'matched', 'ok']);
    // A server verdict (including its third-try mercy pass) counts even with no words heard.
    if (!transcript && pass === null) throw new Error('Transcribe response had no transcript');
    return { transcript: transcript ?? '', pass };
  } finally {
    window.clearTimeout(timer);
  }
}
