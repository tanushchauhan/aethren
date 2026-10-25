import { describe, expect, it } from 'vitest';
import {
  GAUNTLET_CLEAR_BONUS_PER_HEART,
  GAUNTLET_DIFFICULTY_TUNING,
  GAUNTLET_FINAL_WAVE,
  GAUNTLET_HEARTS,
  GAUNTLET_MIN_WINDOW_MS,
  advanceGauntletWave,
  applyGauntletResult,
  attackPoints,
  buildGauntletWave,
  comboMultiplier,
  createGauntletState,
  levelForWave,
  levelTitle,
  startGauntlet,
  type GauntletIncoming,
  type Rng,
} from '../survivalGauntlet';

/** Small deterministic generator so wave shapes are repeatable. */
function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const RING: GauntletIncoming = { kind: 'part_ring', parts: ['head'] };
const DUAL: GauntletIncoming = { kind: 'part_ring', parts: ['head', 'left_shoulder'] };
const BLAST: GauntletIncoming = { kind: 'zone_blast' };

describe('gauntlet levels', () => {
  it('maps waves to the five escalating levels', () => {
    const levels = [1, 2, 3, 4, 5, 7, 8, 10, 11, 15].map((wave) => levelForWave(wave).level);
    expect(levels).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(levelTitle(levelForWave(11))).toBe('Level 5: BOSS FRENZY');
    expect(levelTitle(levelForWave(1))).toBe('Level 1: Warmup');
  });

  it('shrinks the ring window every level', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const wave of [1, 3, 5, 8, 11]) {
      const windowMs = levelForWave(wave).windowMs;
      expect(windowMs).toBeLessThan(previous);
      previous = windowMs;
    }
  });
});

describe('buildGauntletWave', () => {
  it('opens with single rings on head and arms only', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const attack of buildGauntletWave(1, 'normal', seeded(seed))) {
        expect(attack.incoming.kind).toBe('part_ring');
        if (attack.incoming.kind !== 'part_ring') continue;
        expect(attack.incoming.parts).toHaveLength(1);
        expect(['head', 'left_shoulder', 'right_shoulder']).toContain(attack.incoming.parts[0]);
        expect(attack.windowMs).toBe(2400);
      }
    }
  });

  it('never repeats the same single ring back to back', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const parts = buildGauntletWave(1, 'normal', seeded(seed)).map((attack) =>
        attack.incoming.kind === 'part_ring' ? attack.incoming.parts[0] : null,
      );
      for (let i = 1; i < parts.length; i += 1) expect(parts[i]).not.toBe(parts[i - 1]);
    }
  });

  it('adds a blast at level 2 and makes the next attack wait for the player to come home', () => {
    const wave = buildGauntletWave(3, 'normal', seeded(7));
    expect(wave.map((attack) => attack.incoming.kind)).toEqual(['part_ring', 'part_ring', 'zone_blast']);
    expect(wave.every((attack) => !attack.requireHome)).toBe(true);
    const next = buildGauntletWave(4, 'normal', seeded(7), true);
    expect(next[0]?.requireHome).toBe(true);
    expect(next[1]?.requireHome).toBe(false);
  });

  it('spawns two simultaneous rings at level 3', () => {
    const wave = buildGauntletWave(5, 'normal', seeded(3));
    const duals = wave.filter((attack) => attack.incoming.kind === 'part_ring' && attack.incoming.parts.length === 2);
    expect(duals.length).toBe(2);
    for (const attack of duals) {
      if (attack.incoming.kind !== 'part_ring') continue;
      expect(new Set(attack.incoming.parts).size).toBe(2);
    }
  });

  it('chains level 4 attacks with short gaps', () => {
    const wave = buildGauntletWave(8, 'normal', seeded(1));
    expect(wave).toHaveLength(4);
    expect(wave.every((attack) => attack.gapMs === 650)).toBe(true);
    expect(wave[3]?.incoming.kind).toBe('zone_blast');
  });

  it('mixes duals, snipes, and one blast in the boss frenzy, never opening on the blast', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const wave = buildGauntletWave(12, 'normal', seeded(seed));
      expect(wave).toHaveLength(5);
      expect(wave[0]?.incoming.kind).not.toBe('zone_blast');
      expect(wave.filter((attack) => attack.incoming.kind === 'zone_blast')).toHaveLength(1);
      expect(wave.filter((attack) => attack.sniper)).toHaveLength(2);
      for (const attack of wave.filter((item) => item.sniper)) expect(attack.windowMs).toBe(1000);
      const blastIndex = wave.findIndex((attack) => attack.incoming.kind === 'zone_blast');
      const afterBlast = wave[blastIndex + 1];
      if (afterBlast) expect(afterBlast.requireHome).toBe(true);
    }
  });

  it('speeds every window up on harder difficulties but never below the floor', () => {
    const normal = buildGauntletWave(11, 'normal', seeded(5));
    const insane = buildGauntletWave(11, 'insane', seeded(5));
    normal.forEach((attack, index) => {
      const fast = insane[index];
      expect(fast?.windowMs).toBe(
        Math.max(GAUNTLET_MIN_WINDOW_MS, Math.round(attack.windowMs * GAUNTLET_DIFFICULTY_TUNING.insane.time)),
      );
      expect(fast?.windowMs ?? 0).toBeLessThan(attack.windowMs);
    });
  });
});

describe('gauntlet scoring', () => {
  it('ramps the combo multiplier from 1x to 4x', () => {
    expect([0, 2, 3, 5, 6, 9, 10, 30].map(comboMultiplier)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('pays more for dual rings and blasts than single rings', () => {
    expect(attackPoints(DUAL)).toBeGreaterThan(attackPoints(BLAST));
    expect(attackPoints(BLAST)).toBeGreaterThan(attackPoints(RING));
  });

  it('builds a streak on dodges and multiplies points by combo and difficulty', () => {
    let state = startGauntlet('hard');
    const points: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = applyGauntletResult(state, RING, true);
      state = result.state;
      points.push(result.points);
    }
    expect(points).toEqual([150, 150, 300]);
    expect(state).toMatchObject({ streak: 3, bestStreak: 3, score: 600, dodged: 3, highScore: 600 });
  });

  it('costs a shared heart and breaks the streak on a hit', () => {
    let state = applyGauntletResult(startGauntlet('normal'), RING, true).state;
    state = applyGauntletResult(state, DUAL, false).state;
    expect(state).toMatchObject({ hearts: GAUNTLET_HEARTS - 1, streak: 0, bestStreak: 1, hits: 1, status: 'running' });
  });

  it('ends the run at zero hearts and ignores results afterwards', () => {
    let state = startGauntlet('normal');
    for (let i = 0; i < GAUNTLET_HEARTS; i += 1) state = applyGauntletResult(state, BLAST, false).state;
    expect(state).toMatchObject({ hearts: 0, status: 'over' });
    expect(applyGauntletResult(state, RING, true)).toEqual({ state, points: 0 });
  });

  it('advances waves and clears after the final wave with a heart bonus', () => {
    const mid = advanceGauntletWave(startGauntlet('normal'));
    expect(mid.wave).toBe(2);
    const last = { ...startGauntlet('normal'), wave: GAUNTLET_FINAL_WAVE, hearts: 2, score: 1000 };
    const cleared = advanceGauntletWave(last);
    expect(cleared).toMatchObject({ status: 'cleared', score: 1000 + 2 * GAUNTLET_CLEAR_BONUS_PER_HEART });
    expect(advanceGauntletWave(createGauntletState('normal')).wave).toBe(1);
  });

  it('keeps the stored high score when a run scores less', () => {
    const state = applyGauntletResult(startGauntlet('normal', 5000), RING, true).state;
    expect(state.highScore).toBe(5000);
  });
});
