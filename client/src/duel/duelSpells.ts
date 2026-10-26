import {
  SPELLS,
  SPELLS_BY_ELEMENT,
  type Spell,
  type SpellElement,
  type SpellId,
} from '../combat/spells';
import { BODY_PART_TARGETS, type BodyPartTarget } from '../vision/poseClassifiers';

export { SPELLS, SPELLS_BY_ELEMENT, BODY_PART_TARGETS };
export type { Spell, SpellElement, SpellId, BodyPartTarget };

export const DUEL_MAX_HP = 100;
export const DUEL_MAX_MP = 12;
export const DUEL_START_MP = 12;
/** Fast passive MP regeneration in the real-time speed contest (MP per second). */
export const DUEL_MP_PER_SECOND = 1.4;
/** MP restored when holding B2 / pressing Rest. */
export const DUEL_REST_MP = 4;
/** Cooldown on Rest so a player can't spam it every frame. */
export const DUEL_REST_COOLDOWN_MS = 1400;
/** Share of damage mitigated when parrying an incoming spell instead of dodging the body ring. */
export const PARRY_REDUCTION = 0.7;

/**
 * Selectable Spell Cast Speed tiers!
 * Faster tiers speed up your ritual timing bar AND make the Osu! target circles on your rival's body shrink much faster.
 */
export type CastSpeedTier = 1 | 2 | 3;

export interface CastSpeedProfile {
  tier: CastSpeedTier;
  label: string;
  tag: string;
  /** Duration of each ritual step's timing bar (ms). Faster = quicker cast! */
  stepDurationMs: number;
  /** Projectile visual speed multiplier (0.45 = 2.2x faster projectile flight). */
  vfxDurationScale: number;
  /** Duration of each Osu! circle on the defender's body (ms). */
  osuWindupMs: number;
  /** Stagger delay between sequential disjoint Osu! circles in the same cast (ms). */
  osuStaggerMs: number;
  /** Bonus damage multiplier for weaving at higher speed! */
  damageBonus: number;
}

export const CAST_SPEED_PROFILES: Record<CastSpeedTier, CastSpeedProfile> = {
  1: {
    tier: 1,
    label: '1× Swift',
    tag: '1×',
    stepDurationMs: 2200,
    vfxDurationScale: 0.48,
    osuWindupMs: 1450,
    osuStaggerMs: 650,
    damageBonus: 1.0,
  },
  2: {
    tier: 2,
    label: '1.5× Rapid',
    tag: '1.5×',
    stepDurationMs: 1450,
    vfxDurationScale: 0.35,
    osuWindupMs: 1050,
    osuStaggerMs: 480,
    damageBonus: 1.15,
  },
  3: {
    tier: 3,
    label: '2× Blitz',
    tag: '2×',
    stepDurationMs: 950,
    vfxDurationScale: 0.25,
    osuWindupMs: 760,
    osuStaggerMs: 360,
    damageBonus: 1.3,
  },
};

/**
 * Picks 2 or 3 distinct random body parts for every attack so the defender gets a sequence
 * of disjoint (staggered-timer) Osu! circles they must dodge or parry one after another!
 */
export function pickRandomBodyTargets(spell: Spell): BodyPartTarget[] {
  const pool = [...BODY_PART_TARGETS];
  const count = spell.area || spell.splash || spell.chain || spell.cost >= 4 ? 3 : 2;
  const chosen: BodyPartTarget[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    chosen.push(pool.splice(idx, 1)[0] ?? 'head');
  }
  return chosen;
}
