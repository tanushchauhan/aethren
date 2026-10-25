import { describe, expect, it } from 'vitest';
import { TWIN_CAST_WINDOW_MS } from '@once-upon/shared';
import { TwinCastTracker } from './twin-cast';

describe('TwinCastTracker', () => {
  it('pairs two players casting the same element inside the window', () => {
    const t = new TwinCastTracker();
    const first = t.add({ playerId: 'a', element: 'ember', serverTimestampMs: 1000 });
    expect(first.kind).toBe('started');
    expect(first.progress).toEqual({
      element: 'ember',
      castByPlayerIds: ['a'],
      expiresServerMs: 1000 + TWIN_CAST_WINDOW_MS,
      complete: false,
    });
    const second = t.add({ playerId: 'b', element: 'ember', serverTimestampMs: 1000 + TWIN_CAST_WINDOW_MS });
    expect(second.kind).toBe('completed');
    expect(second.progress.complete).toBe(true);
    expect(second.progress.castByPlayerIds).toEqual(['a', 'b']);
    expect(t.pending()).toHaveLength(0);
  });

  it('does not pair casts further apart than the window', () => {
    const t = new TwinCastTracker();
    t.add({ playerId: 'a', element: 'frost', serverTimestampMs: 0 });
    const late = t.add({ playerId: 'b', element: 'frost', serverTimestampMs: TWIN_CAST_WINDOW_MS + 1 });
    expect(late.kind).toBe('started');
  });

  it('needs two different players and the same element', () => {
    const t = new TwinCastTracker();
    t.add({ playerId: 'a', element: 'ember', serverTimestampMs: 0 });
    expect(t.add({ playerId: 'a', element: 'ember', serverTimestampMs: 10 }).kind).toBe('started');
    expect(t.add({ playerId: 'b', element: 'bloom', serverTimestampMs: 20 }).kind).toBe('started');
    expect(t.pending()).toHaveLength(2);
  });

  it('judges by server timestamps, even when casts arrive out of order', () => {
    const t = new TwinCastTracker();
    t.add({ playerId: 'b', element: 'bloom', serverTimestampMs: 5000 });
    const pair = t.add({ playerId: 'a', element: 'bloom', serverTimestampMs: 3500 });
    expect(pair.kind).toBe('completed');
    if (pair.kind !== 'completed') return;
    expect(pair.progress.castByPlayerIds).toEqual(['a', 'b']);
    expect(pair.progress.expiresServerMs).toBe(3500 + TWIN_CAST_WINDOW_MS);
  });

  it('uses each cast in at most one pair', () => {
    const t = new TwinCastTracker();
    t.add({ playerId: 'a', element: 'ember', serverTimestampMs: 0 });
    expect(t.add({ playerId: 'b', element: 'ember', serverTimestampMs: 100 }).kind).toBe('completed');
    expect(t.add({ playerId: 'c', element: 'ember', serverTimestampMs: 200 }).kind).toBe('started');
  });

  it('expires and flushes open casts as incomplete progress', () => {
    const t = new TwinCastTracker(1000);
    t.add({ playerId: 'a', element: 'ember', serverTimestampMs: 0 });
    t.add({ playerId: 'b', element: 'frost', serverTimestampMs: 900 });
    expect(t.expire(1500)).toEqual([{ element: 'ember', castByPlayerIds: ['a'], expiresServerMs: 1000, complete: false }]);
    expect(t.flush().map((p) => p.element)).toEqual(['frost']);
    expect(t.pending()).toHaveLength(0);
  });
});
