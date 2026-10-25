/**
 * Live Narrator lines: one fast Muse Spark call, raced against a ~1.5 s timeout, with the
 * prewritten bank in `lines.ts` as the instant fallback. Never rejects.
 */
import { TAUNT_MAX_CHARS } from '@once-upon/shared';
import type { MuseChat, NarrationEvent } from '../contracts';
import { fallbackLine } from './lines';
import { clipText } from './text';
import { aiTimings } from './timings';

export const NARRATE_TIMEOUT_MS = 1500;

const NARRATE_SYSTEM = `You are the Narrator of a cozy, mischievous fairy-tale picture book, commenting live on a battle.
Reply with exactly one short sentence of storybook narration, under 110 characters.
No quotation marks, no emoji, no markdown, no stage directions. Never invent player names.`;

/** Keeps only small primitive facts from the context so the prompt stays tiny. */
function compactContext(context: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(context ?? {}).slice(0, 12)) {
    if (typeof v === 'string') out[k] = v.slice(0, 80);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = (v as string[]).slice(0, 4);
  }
  return out;
}

export function cleanNarration(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const unquote = (s: string) => s.replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, '');
  const cleaned = unquote(unquote(line).replace(/^narrator\s*:\s*/i, ''));
  return cleaned.length >= 3 ? clipText(cleaned, TAUNT_MAX_CHARS, true) : null;
}

export async function narrate(muse: MuseChat, event: NarrationEvent, timeoutMs = NARRATE_TIMEOUT_MS): Promise<string> {
  const fallback = () => fallbackLine(event);
  try {
    if (!muse.available) return fallback();
    const started = Date.now();
    const msg = await muse.complete({
      messages: [
        { role: 'system', content: NARRATE_SYSTEM },
        { role: 'user', content: `Moment: ${event.kind}\nFacts: ${JSON.stringify(compactContext(event.context))}` },
      ],
      temperature: 0.9,
      maxTokens: 60,
      timeoutMs,
    });
    const line = cleanNarration(msg?.content);
    aiTimings.record('narrate', Date.now() - started, line ? 'ok' : 'fallback');
    return line ?? fallback();
  } catch {
    return fallback();
  }
}
