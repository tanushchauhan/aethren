import type { Spell, SpellId } from './spells';
/** Where the caster's hand holds a spell, in stage percent: the first-person camera sits just below the stage. */
export const HAND = { x: 50, y: 63 };
/** A co-op partner casts from beside you, at the right edge of your screen. */
export const PARTNER_HAND = { x: 90, y: 58 };
/** Shared by the stage shake, the target's hit-stop and the impact burst so all three land on the same frame. */
export const HIT_TIMING = { hitStop: .09, react: .55 };
/**
 * How each spell looks. `chargeMs` is how long it is held in the hand before release; `travelMs` is the flight
 * (lightning is near-instant, ice is a thrown dart, fire is a heavier lob, a meteor falls from the sky).
 * `big` spells get the large impact: ground spikes, double rings, sky strikes.
 */
export type SpellVisual = {
  projectile: 'fireball' | 'lance' | 'meteor' | 'icicle' | 'crystal' | 'orb' | 'none';
  impact: 'fire' | 'frost' | 'storm' | 'none';
  self?: 'shield' | 'overcharge';
  size: number; big: boolean; chargeMs: number; travelMs: number;
};
export const SPELL_VISUALS: Record<SpellId, SpellVisual> = {
  'ember-bolt': { projectile: 'fireball', impact: 'fire', size: 1, big: false, chargeMs: 1000, travelMs: 380 },
  'fire-lance': { projectile: 'lance', impact: 'fire', size: 1.1, big: false, chargeMs: 1100, travelMs: 240 },
  immolate: { projectile: 'fireball', impact: 'fire', size: .85, big: false, chargeMs: 1000, travelMs: 420 },
  meteor: { projectile: 'meteor', impact: 'fire', size: 1.8, big: true, chargeMs: 2000, travelMs: 650 },
  'frost-shard': { projectile: 'icicle', impact: 'frost', size: 1, big: false, chargeMs: 1000, travelMs: 300 },
  'ice-shield': { projectile: 'none', impact: 'none', self: 'shield', size: 1, big: false, chargeMs: 1000, travelMs: 450 },
  'frost-prison': { projectile: 'crystal', impact: 'frost', size: 1.25, big: true, chargeMs: 1200, travelMs: 440 },
  'frost-nova': { projectile: 'crystal', impact: 'frost', size: 1, big: true, chargeMs: 1100, travelMs: 360 },
  'storm-spark': { projectile: 'orb', impact: 'storm', size: .85, big: false, chargeMs: 800, travelMs: 110 },
  'chain-lightning': { projectile: 'orb', impact: 'storm', size: 1.25, big: false, chargeMs: 1100, travelMs: 150 },
  'static-shock': { projectile: 'orb', impact: 'storm', size: 1, big: false, chargeMs: 1000, travelMs: 130 },
  overcharge: { projectile: 'none', impact: 'none', self: 'overcharge', size: 1, big: false, chargeMs: 1000, travelMs: 400 },
};
/** Gap between each jump of a chain, so the bolt visibly travels wolf to wolf. */
export const CHAIN_STEP_MS = 160;
export type SpellTiming = { chargeMs: number; travelMs: number; impactMs: number; finishMs: number };
/** The spell is held and charged in the hand first, then released; impact lands when the flight ends. */
export function spellTiming(spell: Spell, reduced = false): SpellTiming {
  if (reduced) return { chargeMs: 0, travelMs: 150, impactMs: 150, finishMs: 500 };
  const { chargeMs, travelMs } = SPELL_VISUALS[spell.id], linger = 950 + (spell.chain?.length ?? 0) * CHAIN_STEP_MS;
  return { chargeMs, travelMs, impactMs: chargeMs + travelMs, finishMs: chargeMs + travelMs + linger };
}
export type SpellVfxProfile = {
  core: string; residue: string; color: string; highlight: string; deep: string;
  pieces: number; trail: number; spread: number; scale: number; shake: number;
};
const art = (name: string) => `/art/particles/${name}.png`;
const elements: Record<Spell['element'], Pick<SpellVfxProfile, 'core' | 'residue' | 'highlight' | 'deep'>> = {
  fire: { core: art('fire_01'), residue: art('smoke_01'), highlight: '#fff1c4', deep: '#d6361a' },
  frost: { core: art('star_04'), residue: art('smoke_01'), highlight: '#ffffff', deep: '#2f7fd8' },
  storm: { core: art('spark_03'), residue: art('smoke_01'), highlight: '#fbf4ff', deep: '#7b3fe0' },
};
/** Tune layers independently or override them for a new spell, without rewriting the renderer. */
export function buildSpellVfx(spell: Spell, overrides: Partial<SpellVfxProfile> = {}): SpellVfxProfile {
  const { size, big } = SPELL_VISUALS[spell.id];
  return { ...elements[spell.element], color: spell.color, pieces: big ? 16 : 10, trail: big ? 12 : 8,
    spread: 110 * Math.max(1, size * .95), scale: size, shake: Math.round(6 + size * 5), ...overrides };
}
