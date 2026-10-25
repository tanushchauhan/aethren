import { describe, expect, it } from 'vitest';
import { COMBAT, DEFENSE_WINDOW_MS, TAUNT_MAX_CHARS } from '@once-upon/shared';
import type { BossSchema, EncounterSchema } from '@once-upon/shared';
import {
  clampPower,
  enemyAttacks,
  enemyMaxHp,
  sanitizePlan,
  scriptedPlan,
  spellEffect,
  telegraphMs,
  wardEligible,
  type PlanContext,
} from './combat';
import { testWorld } from './test-helpers';

const world = testWorld();
const encounter = world.encounters[0] as EncounterSchema;
const boss = world.boss as BossSchema;

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    enemy: boss,
    isBoss: true,
    enemyHp: 160,
    enemyMaxHp: 160,
    wardActive: false,
    wardRaisedThisPhase: false,
    playerIds: ['p1', 'p2'],
    roundIndex: 0,
    ...overrides,
  };
}

describe('element effects', () => {
  it('ember deals base damage times power, x1.5 on the weakness', () => {
    expect(spellEffect('ember', 1, 'frost')).toMatchObject({ damage: COMBAT.baseSpellDamage, heal: 0, weaknessHit: false });
    expect(spellEffect('ember', 2, 'frost').damage).toBe(20);
    expect(spellEffect('ember', 1, 'ember')).toMatchObject({ damage: 15, weaknessHit: true });
  });

  it('frost deals reduced damage and bloom heals one heart without damage', () => {
    expect(spellEffect('frost', 1, 'ember').damage).toBe(6);
    expect(spellEffect('frost', 1, 'frost').damage).toBe(9);
    expect(spellEffect('bloom', 1, 'bloom')).toMatchObject({ damage: 0, heal: COMBAT.bloomHeal });
    expect(spellEffect('bloom', 0, null).heal).toBe(0);
  });

  it('a twin cast doubles damage and heal', () => {
    expect(spellEffect('ember', 1, 'ember', { twin: true }).damage).toBe(30);
    expect(spellEffect('bloom', 1, null, { twin: true }).heal).toBe(2);
  });

  it('clamps power to 0..2 and defaults junk to 1', () => {
    expect(clampPower(5)).toBe(2);
    expect(clampPower(-1)).toBe(0);
    expect(clampPower(Number.NaN)).toBe(1);
    expect(clampPower('x')).toBe(1);
    expect(spellEffect('ember', 9, null).damage).toBe(20);
  });
});

describe('enemy stats', () => {
  it('derives HP from template, tier, difficulty and the P0 scale', () => {
    expect(enemyMaxHp(encounter, false, 'normal')).toBe(75); // charger 60 x1 x1 x1.25
    expect(enemyMaxHp(encounter, false, 'hard')).toBe(98); // x1.3
    expect(enemyMaxHp(encounter, false, 'easy')).toBe(56); // x0.75
    expect(enemyMaxHp(boss, true, 'normal')).toBe(160); // guardian 80 x tier 3 (2)
  });

  it('keeps only P0 attacks, falling back to the template cycle', () => {
    expect(enemyAttacks({ ...encounter, attacks: ['stare', 'projectile', 'projectile'] })).toEqual(['projectile']);
    expect(enemyAttacks({ ...encounter, attacks: [] })).toEqual(['low_sweep', 'high_swing', 'low_sweep']);
  });

  it('scales the telegraph by attack speed within bounds', () => {
    expect(telegraphMs(encounter, false)).toBe(1818); // 2000 / 1.1
    expect(telegraphMs(boss, true)).toBe(2020); // 2000 / (0.9 x 1.1)
  });
});

describe('ward rules', () => {
  it('only the boss, only below half HP, only once', () => {
    expect(wardEligible(ctx({ enemyHp: 79 }))).toBe(true);
    expect(wardEligible(ctx({ enemyHp: 80 }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 79, isBoss: false }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 79, wardRaisedThisPhase: true }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 79, wardActive: true }))).toBe(false);
  });
});

describe('plan clamping', () => {
  it('clamps every field of a bad plan', () => {
    const plan = sanitizePlan(
      {
        attackType: 'stare',
        targetPlayerIds: ['ghost', 'p2', 'p2'],
        defenseWindowMs: 5000,
        raiseWard: true,
        taunt: 'x'.repeat(300),
        effects: ['servo_open', 'hit', 'explode' as never, 'hit'],
        source: 'agent',
      },
      ctx(),
    );
    expect(plan.attackType).toBe('high_swing'); // scripted fallback for round 0
    expect(plan.targetPlayerIds).toEqual(['p2']);
    expect(plan.defenseWindowMs).toBe(DEFENSE_WINDOW_MS.max);
    expect(plan.raiseWard).toBe(false); // boss at full HP
    expect(plan.taunt!.length).toBeLessThanOrEqual(TAUNT_MAX_CHARS);
    expect(plan.effects).toEqual(['servo_open', 'hit']);
    expect(plan.source).toBe('agent');
  });

  it('falls back to real targets and the minimum window', () => {
    const plan = sanitizePlan({ attackType: 'projectile', targetPlayerIds: ['nobody'], defenseWindowMs: 10 }, ctx({ roundIndex: 1 }));
    expect(plan.attackType).toBe('projectile');
    expect(plan.targetPlayerIds).toEqual(['p2']);
    expect(plan.defenseWindowMs).toBe(DEFENSE_WINDOW_MS.min);
  });

  it('allows raise_ward only when eligible', () => {
    expect(sanitizePlan({ raiseWard: true }, ctx({ enemyHp: 70 })).raiseWard).toBe(true);
    expect(sanitizePlan({ raiseWard: true }, ctx({ enemyHp: 70, isBoss: false, enemy: encounter })).raiseWard).toBe(false);
    expect(sanitizePlan(null, ctx()).source).toBe('scripted');
  });

  it('scripted plan cycles attacks and targets and raises an eligible ward', () => {
    expect(scriptedPlan(ctx({ roundIndex: 0 })).attackType).toBe('high_swing');
    expect(scriptedPlan(ctx({ roundIndex: 1 })).attackType).toBe('projectile');
    expect(scriptedPlan(ctx({ roundIndex: 1 })).targetPlayerIds).toEqual(['p2']);
    expect(scriptedPlan(ctx({ enemyHp: 10 })).raiseWard).toBe(true);
  });
});
