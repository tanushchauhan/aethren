/**
 * Instagram (and Messenger) JSON export parser and filter.
 *
 * Keeps only text messages written by thread participants. Drops media, shares, links,
 * calls, reactions, unsent messages and every system line. The parsed messages live only as
 * long as one request; the route throws them away once cards are extracted.
 */
import { clipText } from './text';

export interface ChatMessage {
  sender: string;
  timestampMs: number;
  text: string;
}

export interface ParsedChat {
  participants: string[];
  /** Chronological (oldest first). */
  messages: ChatMessage[];
  /** How many raw messages were dropped by the filter. */
  dropped: number;
}

export class ChatParseError extends Error {}

/**
 * Instagram writes UTF-8 bytes as one `\u00XX` code point each ("ðŸ˜‚" for 😂, "Ã©" for é).
 * Re-reads those code points as bytes. Strings that are already proper Unicode pass through.
 */
export function fixMojibake(input: string): string {
  if (!input || !/[\u0080-ÿ]/.test(input) || /[^\u0000-ÿ]/.test(input)) return input;
  const decoded = Buffer.from(input, 'latin1').toString('utf8');
  return decoded.includes('�') ? input : decoded;
}

/** System and activity lines Instagram/Messenger write as message `content`. */
const SYSTEM_PATTERNS: RegExp[] = [
  /\breacted\b.*\bto (?:your|a|their|his|her) message\b/i,
  /^reacted\b/i,
  /\bliked a message\b/i,
  /\bsent an attachment\b/i,
  /\bsent a (?:photo|video|voice message|gif|sticker|link|post|reel)\b/i,
  /\bshared a (?:story|post|reel|link|location)\b/i,
  /\bunsent a message\b/i,
  /\b(?:started|joined|missed|ended) (?:a |an |the )?(?:video chat|audio call|video call|call)\b/i,
  /\bthe (?:video chat|call|audio call) ended\b/i,
  /\b(?:named|renamed) the group\b/i,
  /\bchanged the (?:group (?:photo|name)|theme|chat theme|emoji|quick reaction|nickname)\b/i,
  /\bset (?:the|your|his|her|their|the group) (?:nickname|emoji|theme)\b/i,
  /\bset the nickname for\b/i,
  /\bcleared (?:the|your|his|her|their) nickname\b/i,
  /\b(?:added|removed) .+ (?:to|from) the group\b/i,
  /\b(?:left|created) the group\b/i,
  /\bmentioned you in (?:their|his|her) story\b/i,
  /\breplied to (?:your|their|his|her) story\b/i,
  /\breacted to your story\b/i,
  /\byou are now connected on messenger\b/i,
  /\bpinned a message\b/i,
  /\bwaved at\b/i,
  /^this message (?:was|has been) (?:unsent|deleted)/i,
  /^message unavailable$/i,
];

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const MEDIA_KEYS = [
  'photos',
  'videos',
  'audio_files',
  'gifs',
  'sticker',
  'share',
  'files',
  'call_duration',
  'missed',
] as const;

export function isSystemMessage(text: string): boolean {
  return SYSTEM_PATTERNS.some((p) => p.test(text));
}

interface RawMessage {
  sender_name?: unknown;
  timestamp_ms?: unknown;
  content?: unknown;
  type?: unknown;
  is_unsent?: unknown;
  [key: string]: unknown;
}

function asThreads(input: unknown): Record<string, unknown>[] {
  const list = Array.isArray(input) ? input : [input];
  const threads = list.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t));
  if (threads.length === 0 || !threads.some((t) => Array.isArray(t.messages))) {
    throw new ChatParseError('Not an Instagram message export (no messages[] found)');
  }
  return threads;
}

/** Parses one export file, or several `message_N.json` files of the same thread. */
export function parseInstagramExport(input: unknown): ParsedChat {
  const threads = asThreads(input);
  const participants = new Map<string, string>();
  for (const t of threads) {
    if (!Array.isArray(t.participants)) continue;
    for (const p of t.participants) {
      const raw = typeof p === 'string' ? p : p && typeof p === 'object' ? (p as { name?: unknown }).name : null;
      if (typeof raw !== 'string') continue;
      const name = fixMojibake(raw).trim();
      if (name) participants.set(name.toLowerCase(), name);
    }
  }

  const messages: ChatMessage[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const t of threads) {
    for (const m of (t.messages as unknown[]) ?? []) {
      const msg = keepMessage(m as RawMessage, participants);
      if (!msg) {
        dropped++;
        continue;
      }
      const key = `${msg.timestampMs}|${msg.sender}|${msg.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(msg);
    }
  }
  messages.sort((a, b) => a.timestampMs - b.timestampMs);
  const names = participants.size > 0 ? [...participants.values()] : [...new Set(messages.map((m) => m.sender))];
  return { participants: names, messages, dropped };
}

function keepMessage(m: RawMessage, participants: Map<string, string>): ChatMessage | null {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.content !== 'string' || typeof m.sender_name !== 'string') return null;
  if (m.is_unsent === true) return null;
  if (typeof m.type === 'string' && m.type !== 'Generic') return null;
  if (MEDIA_KEYS.some((k) => m[k] !== undefined && m[k] !== null)) return null;

  const senderRaw = fixMojibake(m.sender_name).trim();
  const sender = participants.size > 0 ? participants.get(senderRaw.toLowerCase()) : senderRaw;
  if (!sender) return null;

  const original = fixMojibake(m.content);
  if (isSystemMessage(original)) return null;
  const text = original.replace(URL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  if (text.length < 2) return null;

  const ts = typeof m.timestamp_ms === 'number' ? m.timestamp_ms : Number(m.timestamp_ms);
  return { sender, timestampMs: Number.isFinite(ts) ? ts : 0, text };
}

export function isoDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

export function formatLine(m: ChatMessage): string {
  return `[${isoDate(m.timestampMs)}] ${m.sender}: ${clipText(m.text, 280, true)}`;
}

/**
 * Picks messages that fit `budgetChars` of prompt text (about 4 chars per token): the most
 * recent ~60% of the budget, plus an even sample across the older history for the rest.
 * Returns them in chronological order.
 */
export function selectWithinBudget(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  const cost = (m: ChatMessage) => formatLine(m).length + 1;
  const total = messages.reduce((n, m) => n + cost(m), 0);
  if (total <= budgetChars) return messages.slice();

  const recentBudget = budgetChars * 0.6;
  const picked = new Set<number>();
  let used = 0;
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const c = cost(messages[i]!);
    if (used + c > recentBudget) break;
    picked.add(i);
    used += c;
  }
  const olderCount = i + 1;
  if (olderCount > 0) {
    const avg = total / messages.length;
    const want = Math.max(1, Math.floor((budgetChars - used) / avg));
    const step = Math.max(1, olderCount / want);
    for (let k = 0; k < olderCount && used < budgetChars; k += step) {
      const idx = Math.floor(k);
      const c = cost(messages[idx]!);
      if (used + c > budgetChars) continue;
      picked.add(idx);
      used += c;
    }
  }
  return [...picked].sort((a, b) => a - b).map((idx) => messages[idx]!);
}
