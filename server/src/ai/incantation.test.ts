import { describe, expect, it } from 'vitest';
import { INCANTATION_MATCH_RATIO, MERCY_ATTEMPT, MERCY_POWER } from '@once-upon/shared';
import { createMercyTracker, matchIncantation } from './incantation';
import { normalizeText } from './text';
import { looksLikeWav, makeToneWav, museWavProblems, parseWavHeader } from './wav';

describe('matchIncantation', () => {
  it('scores an exact phrase as 1', () => {
    expect(matchIncantation('Forty miles from anything!', 'forty miles from anything').matchRatio).toBe(1);
  });

  it('spells out digits, so "40 miles" matches "forty miles"', () => {
    expect(matchIncantation('40 miles from anything', 'forty miles from anything').matchRatio).toBe(1);
    expect(normalizeText("It's 3AM, café!")).toBe('its three am cafe');
  });

  it('forgives small mishearings word by word', () => {
    const r = matchIncantation('the libary is clothing', 'the library is closing');
    expect(r.matchRatio).toBeGreaterThanOrEqual(INCANTATION_MATCH_RATIO);
  });

  it('passes a partial phrase above the threshold and fails below it', () => {
    expect(matchIncantation('i am a gardener', 'i am a gardener now').matchRatio).toBe(0.8);
    expect(matchIncantation('gardener', 'i am a gardener now').matchRatio).toBeLessThan(INCANTATION_MATCH_RATIO);
  });

  it('does not let one repeated word satisfy the whole phrase', () => {
    expect(matchIncantation('closing closing closing closing', 'the library is closing').matchRatio).toBe(0.25);
  });

  it('handles a word split in two by the recognizer', () => {
    expect(matchIncantation('i am a garden er now', 'i am a gardener now').matchRatio).toBe(1);
  });

  it('fails silence and nonsense', () => {
    expect(matchIncantation('', 'the library is closing').matchRatio).toBe(0);
    expect(matchIncantation('banana pancake', 'the library is closing').matchRatio).toBe(0);
  });
});

describe('mercy rule', () => {
  it(`passes the ${MERCY_ATTEMPT}rd consecutive try at ${MERCY_POWER} power, then resets`, () => {
    const mercy = createMercyTracker();
    const a1 = mercy.judge('ABCD', 'p1', 'ember', 0);
    const a2 = mercy.judge('ABCD', 'p1', 'ember', 0.2);
    const a3 = mercy.judge('abcd', 'p1', 'ember', 0);
    expect(a1).toEqual({ passed: false, mercy: false, attempt: 1, power: 0 });
    expect(a2).toEqual({ passed: false, mercy: false, attempt: 2, power: 0 });
    expect(a3).toEqual({ passed: true, mercy: true, attempt: 3, power: MERCY_POWER });
    expect(mercy.judge('ABCD', 'p1', 'ember', 0).attempt).toBe(1);
  });

  it('a real pass is full power and resets the count', () => {
    const mercy = createMercyTracker();
    mercy.judge('R', 'p1', 'frost', 0);
    expect(mercy.judge('R', 'p1', 'frost', 1)).toEqual({ passed: true, mercy: false, attempt: 2, power: 1 });
    expect(mercy.judge('R', 'p1', 'frost', 0).attempt).toBe(1);
  });

  it('tracks players and elements separately', () => {
    const mercy = createMercyTracker();
    mercy.judge('R', 'p1', 'ember', 0);
    mercy.judge('R', 'p1', 'ember', 0);
    expect(mercy.judge('R', 'p2', 'ember', 0).attempt).toBe(1);
    expect(mercy.judge('R', 'p1', 'bloom', 0).attempt).toBe(1);
    expect(mercy.judge('R', 'p1', 'ember', 0).mercy).toBe(true);
  });

  it('forgets failures after ten minutes', () => {
    let t = 0;
    const mercy = createMercyTracker(() => t);
    mercy.judge('R', 'p1', 'ember', 0);
    mercy.judge('R', 'p1', 'ember', 0);
    t += 11 * 60_000;
    expect(mercy.judge('R', 'p1', 'ember', 0).attempt).toBe(1);
  });
});

describe('wav helpers', () => {
  it('builds and validates a 16 kHz mono 16-bit tone', () => {
    const wav = makeToneWav({ seconds: 1, sampleRate: 16_000 });
    const info = parseWavHeader(wav)!;
    expect(looksLikeWav(wav)).toBe(true);
    expect(info).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16 });
    expect(info.durationSec).toBeCloseTo(1, 3);
    expect(museWavProblems(info, wav.length)).toEqual([]);
  });

  it('reports format problems', () => {
    const wav = makeToneWav({ sampleRate: 44_100 });
    expect(museWavProblems(parseWavHeader(wav), wav.length)).toEqual(['44100 Hz, expected 16000 or 24000']);
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(looksLikeWav(webm)).toBe(false);
    expect(museWavProblems(parseWavHeader(webm), webm.length)).toEqual(['not a WAV file']);
  });
});
