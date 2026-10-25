/**
 * In-process latency recorder for AI work (provider calls and the pipelines around them).
 *
 * Every operation keeps its last {@link MAX_SAMPLES} durations plus running counts, so
 * `GET /api/metrics/ai` and `bench.ts` can report min / p50 / p95 / max without storing
 * anything else. Recording is synchronous and never throws, so it is safe on hot paths.
 */
import { performance } from 'node:perf_hooks';

export type TimingOutcome = 'ok' | 'fallback' | 'error';

/** One stable name per measured step; `bench.ts` and the test lab group by these. */
export type TimingOp =
  | 'muse.chat'
  | 'world.generate'
  | 'cards.extract'
  | 'image.generate'
  | 'asr.transcribe'
  | 'tts.provider'
  | 'tts.cache_hit'
  | 'narrate'
  | 'boss.plan'
  | 'quest.chat';

export const MAX_SAMPLES = 200;

export interface TimingStats {
  count: number;
  ok: number;
  fallback: number;
  error: number;
  lastMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
  lastAt: number;
}

export interface TimingsSnapshot {
  since: number;
  operations: Partial<Record<TimingOp, TimingStats>>;
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

export function summarize(samples: number[]): Pick<TimingStats, 'minMs' | 'p50Ms' | 'p95Ms' | 'maxMs' | 'avgMs'> {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, ms) => total + ms, 0);
  return {
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    avgMs: round(sorted.length ? sum / sorted.length : 0),
  };
}

export function createTimings(now: () => number = Date.now) {
  let since = now();
  const ops = new Map<TimingOp, { samples: number[]; ok: number; fallback: number; error: number; count: number; lastMs: number; lastAt: number }>();

  function record(op: TimingOp, ms: number, outcome: TimingOutcome = 'ok'): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let entry = ops.get(op);
    if (!entry) {
      entry = { samples: [], ok: 0, fallback: 0, error: 0, count: 0, lastMs: 0, lastAt: 0 };
      ops.set(op, entry);
    }
    entry.samples.push(ms);
    if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
    entry.count++;
    entry[outcome]++;
    entry.lastMs = round(ms);
    entry.lastAt = now();
  }

  /** Times `fn`; `outcomeOf` classifies the result (a thrown error counts as `error` and rethrows). */
  async function time<T>(op: TimingOp, fn: () => Promise<T>, outcomeOf: (value: T) => TimingOutcome = () => 'ok'): Promise<T> {
    const started = performance.now();
    try {
      const value = await fn();
      record(op, performance.now() - started, safeOutcome(outcomeOf, value));
      return value;
    } catch (err) {
      record(op, performance.now() - started, 'error');
      throw err;
    }
  }

  function snapshot(): TimingsSnapshot {
    const operations: TimingsSnapshot['operations'] = {};
    for (const [op, e] of ops) {
      operations[op] = { count: e.count, ok: e.ok, fallback: e.fallback, error: e.error, lastMs: e.lastMs, lastAt: e.lastAt, ...summarize(e.samples) };
    }
    return { since, operations };
  }

  function reset(): void {
    ops.clear();
    since = now();
  }

  return { record, time, snapshot, reset };
}

function safeOutcome<T>(outcomeOf: (value: T) => TimingOutcome, value: T): TimingOutcome {
  try {
    return outcomeOf(value);
  } catch {
    return 'ok';
  }
}

export type Timings = ReturnType<typeof createTimings>;

/** Process-wide recorder shared by the AI module, the agents and `/api/metrics/ai`. */
export const aiTimings: Timings = createTimings();
