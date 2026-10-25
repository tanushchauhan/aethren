/**
 * Incantation judging: fuzzy word match plus the mercy rule.
 */
import { INCANTATION_MATCH_RATIO, MERCY_ATTEMPT, MERCY_POWER } from '@once-upon/shared';
import { tokenize, wordSimilarity } from './text';

/** Two words count as the same when their Levenshtein similarity is at least this. */
export const WORD_SIMILARITY_MIN = 0.75;

export interface IncantationMatch {
  matchRatio: number;
  matched: number;
  total: number;
}

/**
 * Share of the expected words found in the transcript, in any order. Each transcript word
 * can satisfy one expected word only, so "frost frost frost" does not match a long phrase.
 */
export function matchIncantation(transcript: string, expected: string): IncantationMatch {
  const want = tokenize(expected);
  const heard = tokenize(transcript);
  if (want.length === 0) return { matchRatio: 0, matched: 0, total: 0 };
  const used = new Array<boolean>(heard.length).fill(false);
  let matched = 0;
  for (const w of want) {
    let bestIdx = -1;
    let bestSim = 0;
    heard.forEach((h, i) => {
      if (used[i]) return;
      // Also try the word joined with the next one ("garden er" -> "gardener").
      const joined = i + 1 < heard.length ? h + heard[i + 1] : h;
      const sim = Math.max(wordSimilarity(w, h), wordSimilarity(w, joined));
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0 && bestSim >= WORD_SIMILARITY_MIN) {
      used[bestIdx] = true;
      matched++;
    }
  }
  return { matchRatio: Math.round((matched / want.length) * 1000) / 1000, matched, total: want.length };
}

export interface JudgeResult {
  passed: boolean;
  mercy: boolean;
  attempt: number;
  power: number;
}

const STALE_MS = 10 * 60_000;

/**
 * Tracks consecutive failures per room, player and element. The {@link MERCY_ATTEMPT}-th
 * consecutive try passes at {@link MERCY_POWER}. A pass (real or mercy) resets the count.
 */
export function createMercyTracker(now: () => number = Date.now) {
  const failures = new Map<string, { count: number; at: number }>();
  const key = (room: string, player: string, element: string) => `${room.toUpperCase()}|${player}|${element}`;

  function sweep(t: number): void {
    if (failures.size < 500) return;
    for (const [k, v] of failures) if (t - v.at > STALE_MS) failures.delete(k);
  }

  return {
    judge(room: string, player: string, element: string, matchRatio: number): JudgeResult {
      const t = now();
      sweep(t);
      const k = key(room, player, element);
      const prev = failures.get(k);
      const count = prev && t - prev.at <= STALE_MS ? prev.count : 0;
      const attempt = count + 1;
      if (matchRatio >= INCANTATION_MATCH_RATIO) {
        failures.delete(k);
        return { passed: true, mercy: false, attempt, power: 1 };
      }
      if (attempt >= MERCY_ATTEMPT) {
        failures.delete(k);
        return { passed: true, mercy: true, attempt, power: MERCY_POWER };
      }
      failures.set(k, { count: attempt, at: t });
      return { passed: false, mercy: false, attempt, power: 0 };
    },
    reset(room: string, player: string, element: string): void {
      failures.delete(key(room, player, element));
    },
  };
}
