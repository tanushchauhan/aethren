import { describe, expect, it } from 'vitest';
import { createTimings, MAX_SAMPLES, percentile, summarize } from './timings';

describe('timings', () => {
  it('computes nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([], 50)).toBe(0);
    expect(summarize([30, 10, 20])).toMatchObject({ minMs: 10, p50Ms: 20, maxMs: 30, avgMs: 20 });
  });

  it('counts outcomes per operation and keeps only the latest samples', () => {
    const t = createTimings(() => 1000);
    for (let i = 0; i < MAX_SAMPLES + 50; i++) t.record('narrate', i, i % 2 ? 'fallback' : 'ok');
    t.record('narrate', -5);
    t.record('narrate', Number.NaN);
    const stats = t.snapshot().operations.narrate!;
    expect(stats.count).toBe(MAX_SAMPLES + 50);
    expect(stats.ok + stats.fallback).toBe(MAX_SAMPLES + 50);
    expect(stats.minMs).toBe(50);
    expect(stats.lastMs).toBe(MAX_SAMPLES + 49);
    expect(stats.lastAt).toBe(1000);
  });

  it('times async work, classifies the result and records a throw as an error', async () => {
    const t = createTimings();
    await expect(t.time('world.generate', async () => ({ source: 'cached' }), (r) => (r.source === 'muse' ? 'ok' : 'fallback')))
      .resolves.toEqual({ source: 'cached' });
    await expect(t.time('world.generate', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await t.time('world.generate', async () => 1, () => { throw new Error('bad classifier'); });
    expect(t.snapshot().operations['world.generate']).toMatchObject({ count: 3, ok: 1, fallback: 1, error: 1 });
    t.reset();
    expect(t.snapshot().operations).toEqual({});
  });
});
