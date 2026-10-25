/**
 * Memory card extraction: one Muse Spark structured-output call on the filtered chat,
 * then strict validation. Every quote must really appear in the chat; anything Muse invents
 * is dropped. A local heuristic tops up (or replaces) the cards when Muse is unavailable.
 */
import { z } from 'zod';
import type { MemoryCard } from '@once-upon/shared';
import type { MuseChat } from '../contracts';
import { formatLine, isoDate, selectWithinBudget, type ChatMessage, type ParsedChat } from './instagram';
import { MOODS, normalizeColor, normalizeMood, type Mood } from './moods';
import { sparkJson } from './spark';
import { clipText, normalizeText, slugify, tokenize, wordSimilarity } from './text';

export const QUOTE_MAX_CHARS = 140;
export const CARD_MIN = 3;
export const CARD_MAX = 5;
/** About 6k tokens of chat in the extraction prompt. */
export const CHAT_PROMPT_BUDGET_CHARS = 24_000;

export const CARD_JSON_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Copied exactly from one message, at most 140 characters' },
          date: { type: 'string', description: 'YYYY-MM-DD of that message' },
          people: { type: 'array', items: { type: 'string' } },
          mood: { type: 'string', enum: [...MOODS] },
          color: { type: 'string', description: 'Hex color like #E85D04' },
        },
        required: ['quote', 'date', 'people', 'mood', 'color'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
} as const;

const CARD_SYSTEM_PROMPT = `You find the most memorable moments in a group chat between friends, who all agreed in writing to turn it into a fairy-tale game.
Return 3 to 5 memory cards. Each card is one moment:
- quote: a short phrase copied EXACTLY, character for character, from a single message. At most 140 characters. Never paraphrase, merge messages or fix typos.
- date: the YYYY-MM-DD shown on that message.
- people: the participants involved, using names from the participants list only.
- mood: one of ${MOODS.join(', ')}.
- color: a hex color that fits the mood.
Pick inside jokes, small disasters, triumphs and running gags that would make a great storybook monster: vivid, funny, speakable phrases. Spread the cards across different moments and dates.
Never pick anything sensitive (addresses, phone numbers, health, money, passwords), cruel or embarrassing about someone.`;

const RawCard = z.object({
  quote: z.string(),
  date: z.string().optional(),
  people: z.array(z.unknown()).optional(),
  mood: z.unknown().optional(),
  color: z.unknown().optional(),
});

interface QuoteMatch {
  message: ChatMessage;
  quote: string;
}

/**
 * Finds the message a quote came from. Exact (normalized) substring first, then a fuzzy
 * per-word match. Returns the quote to show: Muse's text when it is a real substring, else
 * the matching words of the actual message. `null` when the quote is not in the chat.
 */
export function findQuoteSource(quote: string, messages: ChatMessage[]): QuoteMatch | null {
  const q = normalizeText(quote);
  const qTokens = q ? q.split(' ') : [];
  if (qTokens.length === 0) return null;

  for (const message of messages) {
    if (` ${normalizeText(message.text)} `.includes(` ${q} `)) {
      const shown = quote.replace(/\s+/g, ' ').trim().replace(/^["'“]+|["'”]+$/g, '');
      return { message, quote: shown.length <= QUOTE_MAX_CHARS ? shown : clipText(message.text, QUOTE_MAX_CHARS, true) };
    }
  }

  let best: { message: ChatMessage; score: number } | null = null;
  for (const message of messages) {
    const mTokens = tokenize(message.text);
    if (mTokens.length === 0) continue;
    let hits = 0;
    for (const qt of qTokens) if (mTokens.some((mt) => wordSimilarity(qt, mt) >= 0.8)) hits++;
    const score = hits / qTokens.length;
    if (!best || score > best.score) best = { message, score };
  }
  if (!best || best.score < 0.75) return null;

  const words = best.message.text.split(/\s+/);
  const startIdx = Math.max(
    0,
    words.findIndex((w) => {
      const n = normalizeText(w);
      return n !== '' && wordSimilarity(n.split(' ')[0]!, qTokens[0]!) >= 0.8;
    }),
  );
  return { message: best.message, quote: clipText(words.slice(startIdx).join(' '), QUOTE_MAX_CHARS, true) };
}

function matchPeople(raw: unknown[] | undefined, participants: string[], sender: string): string[] {
  const out = new Set<string>([sender]);
  for (const p of raw ?? []) {
    if (typeof p !== 'string') continue;
    const want = p.trim().toLowerCase();
    if (!want) continue;
    const hit =
      participants.find((n) => n.toLowerCase() === want) ??
      participants.find((n) => n.toLowerCase().split(/\s+/)[0] === want.split(/\s+/)[0]);
    if (hit) out.add(hit);
  }
  return [...out].slice(0, 4);
}

function uniqueId(base: string, used: Set<string>): string {
  let id = `card-${base}`;
  for (let n = 2; used.has(id); n++) id = `card-${base}-${n}`;
  used.add(id);
  return id;
}

/** Validates Muse's raw JSON into at most {@link CARD_MAX} real, deduplicated cards. */
export function validateCards(raw: unknown, chat: ParsedChat): MemoryCard[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { cards?: unknown }).cards)
    ? (raw as { cards: unknown[] }).cards
    : Array.isArray(raw)
      ? raw
      : [];
  const cards: MemoryCard[] = [];
  const usedIds = new Set<string>();
  const usedMessages = new Set<ChatMessage>();
  for (const item of list) {
    if (cards.length >= CARD_MAX) break;
    const parsed = RawCard.safeParse(item);
    if (!parsed.success) continue;
    const match = findQuoteSource(parsed.data.quote, chat.messages);
    if (!match || usedMessages.has(match.message)) continue;
    usedMessages.add(match.message);
    const mood = normalizeMood(parsed.data.mood);
    cards.push({
      id: uniqueId(slugify(match.quote), usedIds),
      quote: match.quote,
      date: isoDate(match.message.timestampMs),
      people: matchPeople(parsed.data.people, chat.participants, match.message.sender),
      mood,
      color: normalizeColor(parsed.data.color, mood),
    });
  }
  return cards;
}

const MOOD_KEYWORDS: [RegExp, Mood][] = [
  [/\b(3am|deadline|exam|essay|due|finals?|overdue|late)\b/i, 'dread'],
  [/\b(ghost|scary|creepy|haunted|spooky)\b/i, 'spooky'],
  [/\b(sad|cry|crying|miss you|lonely)\b/i, 'gloomy'],
  [/\b(angry|mad|furious|wtf|how dare)\b/i, 'heated'],
  [/\b(remember|back when|miss|those days)\b/i, 'nostalgic'],
  [/\b(proud|did it|finally|won|survived|nailed)\b/i, 'proud'],
  [/\b(cozy|blanket|tea|cocoa|movie night)\b/i, 'cozy'],
  [/\b(lol|lmao|haha|hahaha|karaoke|crying laughing)\b/i, 'silly'],
  [/\b(omg|help|noise|broke|broken|lost)\b|!!/i, 'chaotic'],
];

function guessMood(text: string): Mood {
  return MOOD_KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'silly';
}

function memorability(m: ChatMessage): number {
  const len = m.text.length;
  let score = len >= 25 && len <= QUOTE_MAX_CHARS ? 3 : len > QUOTE_MAX_CHARS ? 1 : 0;
  if (/[!?]/.test(m.text)) score += 1;
  if (/\b[A-Z]{3,}\b/.test(m.text)) score += 1;
  if (MOOD_KEYWORDS.some(([re]) => re.test(m.text))) score += 2;
  if (tokenize(m.text).length >= 5) score += 1;
  return score;
}

/** Local fallback: the most memorable message from each slice of the chat's history. */
export function heuristicCards(chat: ParsedChat, count = CARD_MIN, exclude: MemoryCard[] = []): MemoryCard[] {
  const taken = new Set(exclude.map((c) => normalizeText(c.quote)));
  const usedIds = new Set(exclude.map((c) => c.id));
  const pool = chat.messages.filter((m) => tokenize(m.text).length >= 3);
  if (pool.length === 0 || count <= 0) return [];
  const buckets = Math.min(count, pool.length);
  const out: MemoryCard[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = pool.slice(Math.floor((b * pool.length) / buckets), Math.floor(((b + 1) * pool.length) / buckets));
    const best = slice
      .filter((m) => !taken.has(normalizeText(clipText(m.text, QUOTE_MAX_CHARS, true))))
      .sort((x, y) => memorability(y) - memorability(x))[0];
    if (!best) continue;
    const quote = clipText(best.text, QUOTE_MAX_CHARS, true);
    taken.add(normalizeText(quote));
    const mood = guessMood(best.text);
    out.push({
      id: uniqueId(slugify(quote), usedIds),
      quote,
      date: isoDate(best.timestampMs),
      people: [best.sender],
      mood,
      color: normalizeColor(null, mood),
    });
  }
  return out;
}

export interface CardExtraction {
  cards: MemoryCard[];
  source: 'muse' | 'mixed' | 'heuristic';
}

export async function extractMemoryCards(
  muse: MuseChat,
  chat: ParsedChat,
  timeoutMs: number,
): Promise<CardExtraction> {
  let cards: MemoryCard[] = [];
  if (muse.available && chat.messages.length > 0) {
    const lines = selectWithinBudget(chat.messages, CHAT_PROMPT_BUDGET_CHARS).map(formatLine).join('\n');
    const raw = await sparkJson(muse, {
      system: CARD_SYSTEM_PROMPT,
      user: `Participants: ${chat.participants.join(', ')}\n\nChat, oldest first:\n${lines}`,
      schemaName: 'memory_cards',
      schema: CARD_JSON_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs,
      temperature: 0.4,
      maxTokens: 1200,
    });
    cards = validateCards(raw, chat);
  }
  if (cards.length >= CARD_MIN) return { cards, source: 'muse' };
  const topUp = heuristicCards(chat, CARD_MIN - cards.length, cards);
  return { cards: [...cards, ...topUp], source: cards.length > 0 ? 'mixed' : 'heuristic' };
}

/** In-memory store behind `listMemoryCards()`. Only cards are kept, never the chat. */
export function createCardStore(fixtures: MemoryCard[]) {
  let uploaded: MemoryCard[] | null = null;
  const copy = (cards: MemoryCard[]) => cards.map((c) => ({ ...c, people: [...c.people] }));
  return {
    list: (): MemoryCard[] => copy(uploaded && uploaded.length > 0 ? uploaded : fixtures),
    set: (cards: MemoryCard[]) => {
      uploaded = copy(cards);
    },
    clear: () => {
      uploaded = null;
    },
  };
}
