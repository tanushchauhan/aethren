/**
 * Twin Cast detector (pure). Two different players casting the same element within
 * `TWIN_CAST_WINDOW_MS` of each other, judged by `serverTimestampMs`, form a pair.
 *
 * Casts may arrive out of timestamp order (network delay), so the window is checked as an
 * absolute difference. Each cast can belong to at most one pair.
 */
import { TWIN_CAST_WINDOW_MS } from '@once-upon/shared';
import type { P0ElementType, TwinCastProgress } from '@once-upon/shared';

export interface TwinCastEntry {
  playerId: string;
  element: P0ElementType;
  serverTimestampMs: number;
}

export type TwinCastUpdate =
  | { kind: 'started'; progress: TwinCastProgress }
  | { kind: 'completed'; progress: TwinCastProgress; pair: [TwinCastEntry, TwinCastEntry] };

export class TwinCastTracker {
  private open: TwinCastEntry[] = [];

  constructor(private readonly windowMs: number = TWIN_CAST_WINDOW_MS) {}

  /** Adds an accepted cast. Completes a pair with the closest open match, or opens a new one. */
  add(entry: TwinCastEntry): TwinCastUpdate {
    let best: TwinCastEntry | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const candidate of this.open) {
      if (candidate.element !== entry.element || candidate.playerId === entry.playerId) continue;
      const gap = Math.abs(candidate.serverTimestampMs - entry.serverTimestampMs);
      if (gap <= this.windowMs && gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }

    if (best) {
      this.open = this.open.filter((e) => e !== best);
      const pair = [best, entry].sort((a, b) => a.serverTimestampMs - b.serverTimestampMs) as [
        TwinCastEntry,
        TwinCastEntry,
      ];
      return {
        kind: 'completed',
        pair,
        progress: {
          element: entry.element,
          castByPlayerIds: pair.map((e) => e.playerId),
          expiresServerMs: pair[0].serverTimestampMs + this.windowMs,
          complete: true,
        },
      };
    }

    // A player re-casting the same element replaces their own open entry.
    this.open = this.open.filter((e) => !(e.playerId === entry.playerId && e.element === entry.element));
    this.open.push(entry);
    return { kind: 'started', progress: this.progressOf(entry, false) };
  }

  /** Removes open casts whose window ended before `nowMs` and reports them as failed. */
  expire(nowMs: number): TwinCastProgress[] {
    const expired = this.open.filter((e) => e.serverTimestampMs + this.windowMs < nowMs);
    this.open = this.open.filter((e) => !expired.includes(e));
    return expired.map((e) => this.progressOf(e, false));
  }

  /** Drops every open cast (end of the team turn), reporting each as failed. */
  flush(): TwinCastProgress[] {
    const flushed = this.open.map((e) => this.progressOf(e, false));
    this.open = [];
    return flushed;
  }

  pending(): readonly TwinCastEntry[] {
    return this.open;
  }

  private progressOf(entry: TwinCastEntry, complete: boolean): TwinCastProgress {
    return {
      element: entry.element,
      castByPlayerIds: [entry.playerId],
      expiresServerMs: entry.serverTimestampMs + this.windowMs,
      complete,
    };
  }
}
