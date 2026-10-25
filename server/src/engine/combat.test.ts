import { describe, expect, it } from 'vitest';
import { COMBAT } from '@aethren/shared';
import type { BossSchema, EncounterSchema } from '@aethren/shared';
import {
  clampPower,
  enemyAttacks,
  enemyMaxHp,
  spellEffect,
  telegraphMs,
  wardEligible,
  type PlanContext,
} from './combat';
import { demoWorld as testWorld } from '../content';

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
  it('only the boss, only at or below half HP, only once', () => {
    expect(wardEligible(ctx({ enemyHp: 80 }))).toBe(true); // at or below half
    expect(wardEligible(ctx({ enemyHp: 81 }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 0 }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 79, isBoss: false }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 79, wardRaisedThisPhase: true }))).toBe(false);
    expect(wardEligible(ctx({ enemyHp: 79, wardActive: true }))).toBe(false);
  });
});

