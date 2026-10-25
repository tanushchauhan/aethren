/**
 * Duel spells. Positions are fractions of the arena (0-1 across, 0-1 down) in the mirror view of the camera,
 * and radii are fractions of the arena height. Every spell is telegraphed at the caster's hand for `telegraphMs`
 * before it lands, so a smaller zone with a shorter warning is harder to read but easier to leave.
 */
export interface DuelSpell {
  id: string;
  name: string;
  color: string;
  radius: number;
  telegraphMs: number;
  damage: number;
  cost: number;
  /** Share of the damage a clean block takes away. Big blasts push through a guard. */
  blockReduction: number;
}

export const DUEL_SPELLS: readonly DuelSpell[] = [
  { id: 'ember', name: 'Ember', color: '#ff8a4a', radius: 0.11, telegraphMs: 1400, damage: 12, cost: 18, blockReduction: 0.7 },
  { id: 'bolt', name: 'Bolt', color: '#ffe066', radius: 0.085, telegraphMs: 850, damage: 15, cost: 30, blockReduction: 0.5 },
  { id: 'frost', name: 'Frost', color: '#7fd8ff', radius: 0.15, telegraphMs: 1900, damage: 18, cost: 28, blockReduction: 0.6 },
  { id: 'nova', name: 'Nova', color: '#d58aff', radius: 0.25, telegraphMs: 2300, damage: 26, cost: 45, blockReduction: 0.25 },
];

export const spellById = (id: string) => DUEL_SPELLS.find((spell) => spell.id === id);

export const DUEL_HEALTH = 100;
export const DUEL_MANA = 100;
export const MANA_PER_SECOND = 14;
export const CAST_COOLDOWN_MS = 650;
export const GUARD_MAX = 100;
export const GUARD_COST = 40;
export const GUARD_PER_SECOND = 7;
/** The arm must already be up this long when a spell lands, so a late flinch does not count as a block. */
export const BLOCK_HOLD_MS = 280;
/** Arena width over height, to turn x distances into the same units as y. */
export const ARENA_ASPECT = 16 / 9;
/** Extra reach around a spell zone, so clipping the edge with a shoulder counts. */
export const BODY_PADDING = 0.02;
