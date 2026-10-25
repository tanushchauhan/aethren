import { DEFAULT_SERVER_URL } from '../net/contract';
import type { MemoryCard } from '../net/contract';
import type { GameStore } from '../net/store';
import { getUiStore } from './storeBindings';

export type UploadOutcome =
  | { ok: true; cardsApplied: boolean }
  | { ok: false; reason: 'rejected' | 'network' };

interface MemoryCardWriter {
  applyMemoryCards?: (cards: MemoryCard[]) => void;
  setMemoryCards?: (cards: MemoryCard[]) => void;
}

function serverBase(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured && configured.trim().length > 0) {
    return configured.replace(/\/$/, '');
  }
  return DEFAULT_SERVER_URL;
}

function isMemoryCard(value: unknown): value is MemoryCard {
  if (!value || typeof value !== 'object') return false;
  const card = value as Record<string, unknown>;
  return (
    typeof card.id === 'string' &&
    typeof card.quote === 'string' &&
    typeof card.date === 'string' &&
    Array.isArray(card.people) &&
    card.people.every((person) => typeof person === 'string') &&
    typeof card.mood === 'string' &&
    typeof card.color === 'string'
  );
}

function extractCards(payload: unknown): MemoryCard[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.memoryCards)
    ? record.memoryCards
    : Array.isArray(record.cards)
      ? record.cards
      : [];
  return list.filter(isMemoryCard);
}

function writeCards(cards: MemoryCard[]): boolean {
  const store = getUiStore() as GameStore & MemoryCardWriter;
  if (typeof store.applyMemoryCards === 'function') {
    store.applyMemoryCards(cards);
    return true;
  }
  if (typeof store.setMemoryCards === 'function') {
    store.setMemoryCards(cards);
    return true;
  }
  return false;
}

export async function uploadInstagramExport(
  file: File,
  roomCode: string | undefined,
): Promise<UploadOutcome> {
  const text = await file.text();
  try {
    JSON.parse(text);
  } catch {
    return { ok: false, reason: 'rejected' };
  }

  const url = new URL('/api/chat-upload', serverBase());
  if (roomCode) url.searchParams.set('room', roomCode);
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(8000)
      : undefined;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
      signal,
    });
    if (!response.ok) return { ok: false, reason: 'network' };
    const body = await response.text();
    let cards: MemoryCard[] = [];
    if (body.trim().length > 0) {
      try {
        cards = extractCards(JSON.parse(body) as unknown);
      } catch {
        cards = [];
      }
    }
    return { ok: true, cardsApplied: cards.length > 0 ? writeCards(cards) : false };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
