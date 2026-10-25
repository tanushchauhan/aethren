export type SpellElement = 'fire' | 'frost' | 'storm';
export type SpellId =
  | 'ember-bolt' | 'fire-lance' | 'immolate' | 'meteor'
  | 'frost-shard' | 'ice-shield' | 'frost-prison' | 'frost-nova'
  | 'storm-spark' | 'chain-lightning' | 'static-shock' | 'overcharge';
/** Self spells need no target; enemy spells name the primary target, which area spells also spread from. */
export type SpellInput = { spellId: SpellId; targetId?: string };
export type OpponentEffect = { id: 'burning' | 'chilled' | 'frozen' | 'drained'; turns: number; amount?: number };
export type Spell = {
  id: SpellId; name: string; element: SpellElement; cost: number; description: string; color: string;
  target: 'enemy' | 'self';
  /** Direct damage to the primary target (to every wolf for an `area` spell). */
  damage: number;
  /** Ignores armor. */
  pierce?: boolean;
  /** Hits every living wolf for `damage`. */
  area?: boolean;
  /** Damage dealt to each other living wolf as well. */
  splash?: number;
  /** Damage for each jump after the primary target, in order. */
  chain?: number[];
  /** Applied to each wolf the spell lands on. */
  applies?: OpponentEffect;
  /** Empties the target's energy so its next turn can only be Rest. */
  drain?: boolean;
  /** Self: shield points that absorb incoming health damage. */
  shield?: { amount: number; turns: number };
  /** Self: the next damaging spell is stronger. */
  overcharge?: { multiplier: number; turns: number };
};

/**
 * Each element has a role. Fire trades everything for damage (the best damage per Magic Power),
 * Frost protects you and slows the pack, Storm is cheap and spreads damage while disrupting turns.
 * Area, splash and chain spells cannot be dodged; single-target spells can.
 */
export const SPELLS: Record<SpellId, Spell> = {
  'ember-bolt': { id: 'ember-bolt', name: 'Ember Bolt', element: 'fire', cost: 2, target: 'enemy', damage: 8, color: '#ff9653',
    description: '8 damage. Quick and cheap.' },
  'fire-lance': { id: 'fire-lance', name: 'Fire Lance', element: 'fire', cost: 4, target: 'enemy', damage: 18, pierce: true, color: '#ff8a3d',
    description: '18 damage that ignores armor.' },
  immolate: { id: 'immolate', name: 'Immolate', element: 'fire', cost: 3, target: 'enemy', damage: 5, color: '#ff7a2e',
    applies: { id: 'burning', turns: 3, amount: 4 }, description: '5 damage, then Burning: 4 damage at the start of its next 3 turns.' },
  meteor: { id: 'meteor', name: 'Meteor', element: 'fire', cost: 7, target: 'enemy', damage: 22, splash: 10, color: '#ff6a2a',
    description: '22 damage to the target and 10 to every other wolf. Long charge.' },
  'frost-shard': { id: 'frost-shard', name: 'Frost Shard', element: 'frost', cost: 2, target: 'enemy', damage: 5, color: '#98e8ff',
    applies: { id: 'chilled', turns: 1 }, description: '5 damage and Chilled: its next attack does 30% less.' },
  'ice-shield': { id: 'ice-shield', name: 'Ice Shield', element: 'frost', cost: 3, target: 'self', damage: 0, color: '#aeeaff',
    shield: { amount: 18, turns: 2 }, description: 'Absorbs the next 18 damage for 2 turns.' },
  'frost-prison': { id: 'frost-prison', name: 'Frost Prison', element: 'frost', cost: 5, target: 'enemy', damage: 0, color: '#c4f4ff',
    applies: { id: 'frozen', turns: 2 }, description: 'Frozen: the wolf skips its next 2 turns.' },
  'frost-nova': { id: 'frost-nova', name: 'Frost Nova', element: 'frost', cost: 4, target: 'enemy', damage: 5, area: true, color: '#7fd8ff',
    applies: { id: 'chilled', turns: 1 }, description: '5 damage to every wolf and Chills them all.' },
  'storm-spark': { id: 'storm-spark', name: 'Storm Spark', element: 'storm', cost: 1, target: 'enemy', damage: 4, color: '#cfacff',
    description: '4 damage. Nearly instant and the cheapest spell.' },
  'chain-lightning': { id: 'chain-lightning', name: 'Chain Lightning', element: 'storm', cost: 4, target: 'enemy', damage: 9, chain: [6, 4], color: '#c49bff',
    description: '9 damage, then jumps to the next wolf for 6 and the last for 4.' },
  'static-shock': { id: 'static-shock', name: 'Static Shock', element: 'storm', cost: 3, target: 'enemy', damage: 4, drain: true, color: '#b48cff',
    applies: { id: 'drained', turns: 1 }, description: '4 damage and Drained: empties its energy, so it can only rest next turn.' },
  overcharge: { id: 'overcharge', name: 'Overcharge', element: 'storm', cost: 2, target: 'self', damage: 0, color: '#d6b8ff',
    overcharge: { multiplier: 1.5, turns: 2 }, description: 'Your next damaging spell hits 50% harder. A Storm spell also refunds 1 MP.' },
};
export const SPELLS_BY_ELEMENT: Record<SpellElement, SpellId[]> = {
  fire: ['ember-bolt', 'fire-lance', 'immolate', 'meteor'],
  frost: ['frost-shard', 'ice-shield', 'frost-prison', 'frost-nova'],
  storm: ['storm-spark', 'chain-lightning', 'static-shock', 'overcharge'],
};
/** Validates external input (diagnostics, a future glove adapter) against the catalogue. */
export function getSpell(id: unknown): Spell | null {
  return typeof id === 'string' && Object.hasOwn(SPELLS, id) ? SPELLS[id as SpellId] : null;
}
