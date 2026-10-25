export type SpellElement = 'fire' | 'frost' | 'storm';
export type SpellId =
  | 'ember-bolt' | 'fire-lance' | 'immolate' | 'meteor'
  | 'frost-shard' | 'ice-shield' | 'frost-prison' | 'frost-nova'
  | 'storm-spark' | 'chain-lightning' | 'static-shock' | 'overcharge';

/**
 * Steps a player can chain to weave a spell:
 * - Glove / key inputs: `B1` (cast button / 1), `B2` (element button / 2), `T` (touch / 3), `swing` (slash/thrust glove or Space)
 * - CV body poses (no leans — only reliable vertical poses, also mapped to W/S fallbacks):
 *   `raise` (raise right arm), `duck` (crouch low)
 */
export type RitualStep = 'B1' | 'B2' | 'T' | 'swing' | 'raise' | 'duck';

export const RITUAL_LABELS: Record<
  RitualStep,
  { short: string; label: string; timingCue: string; kind: 'glove' | 'pose'; keyHint: string }
> = {
  B1: {
    short: 'B1',
    label: 'Press B1',
    timingCue: 'Press [B1] in ★ PERFECT',
    kind: 'glove',
    keyHint: '1',
  },
  B2: {
    short: 'B2',
    label: 'Tap B2',
    timingCue: 'Tap [B2] in ★ PERFECT',
    kind: 'glove',
    keyHint: '2',
  },
  T: {
    short: 'T',
    label: 'Touch T',
    timingCue: 'Tap [T] in ★ PERFECT',
    kind: 'glove',
    keyHint: '3',
  },
  swing: {
    short: 'Swing',
    label: 'Swing Glove',
    timingCue: 'Swing Glove in ★ PERFECT',
    kind: 'glove',
    keyHint: 'Space',
  },
  raise: {
    short: '↑ Arm',
    label: 'Raise Arm',
    timingCue: 'Raise Arm in ★ PERFECT',
    kind: 'pose',
    keyHint: 'W',
  },
  duck: {
    short: '↓ Duck',
    label: 'Duck Low',
    timingCue: 'Duck Low in ★ PERFECT',
    kind: 'pose',
    keyHint: 'S',
  },
};

/** Duration of each individual step's timing bar during a spell ritual (slower bar makes hitting Perfect easier!). */
export const RITUAL_STEP_DURATION_MS = 4000;
/** Normalized progress (0..1) where the Perfect timing sweet-spot begins and ends. */
export const PERFECT_WINDOW_START = 0.28;
export const PERFECT_WINDOW_END = 0.76;
export const GOOD_WINDOW_START = 0.12;
export const GOOD_WINDOW_END = 0.90;

export type TimingGrade = 'perfect' | 'good' | 'sloppy';

/** Evaluates how well-timed a ritual input was based on normalized step progress (0..1). */
export function gradeStepTiming(progress: number): { grade: TimingGrade; label: string; multiplier: number } {
  if (progress >= PERFECT_WINDOW_START && progress <= PERFECT_WINDOW_END) {
    return { grade: 'perfect', label: '★ PERFECT!', multiplier: 1.45 };
  }
  if (progress >= GOOD_WINDOW_START && progress <= GOOD_WINDOW_END) {
    return { grade: 'good', label: 'GOOD', multiplier: 1.15 };
  }
  return {
    grade: 'sloppy',
    label: progress < GOOD_WINDOW_START ? 'EARLY (Weakened)' : 'LATE (Weakened)',
    multiplier: 0.75,
  };
}

/** Combines the timing grades of all steps in a completed ritual into a final spell effectiveness multiplier. */
export function combineRitualMultiplier(grades: readonly TimingGrade[]): {
  multiplier: number;
  summary: string;
} {
  if (!grades.length) return { multiplier: 1, summary: 'Standard Cast' };
  const weights: Record<TimingGrade, number> = { perfect: 1.45, good: 1.15, sloppy: 0.75 };
  const avg = grades.reduce((sum, g) => sum + weights[g], 0) / grades.length;
  const multiplier = Math.round(avg * 100) / 100;
  const allPerfect = grades.every((g) => g === 'perfect');
  const anySloppy = grades.some((g) => g === 'sloppy');
  const summary = allPerfect
    ? `★ PERFECT WEAVE (×${multiplier.toFixed(2)} Power!)`
    : anySloppy && multiplier < 1
      ? `Weakened Weave (×${multiplier.toFixed(2)} Power)`
      : `Resonant Weave (×${multiplier.toFixed(2)} Power)`;
  return { multiplier, summary };
}

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
  /** True for the three spells known at the start of the adventure. */
  starter?: boolean;
  /** Ordered sequence of glove inputs + CV body poses required to weave and cast this spell. */
  ritual: RitualStep[];
  /** Hint shown while the spell is still undiscovered. */
  hint: string;
  /** Tactical counter tip shown on the wheel once discovered. */
  counterHint: string;
};

/** Spells known at the beginning of a run (one per element). */
export const STARTER_SPELLS: readonly SpellId[] = ['ember-bolt', 'frost-shard', 'storm-spark'];

/**
 * Every spell (including the 3 starter spells) requires a unique movement + glove ritual under a time constraint.
 */
export const SPELLS: Record<SpellId, Spell> = {
  'ember-bolt': {
    id: 'ember-bolt', name: 'Ember Bolt', element: 'fire', cost: 2, target: 'enemy', damage: 14, color: '#ff9653',
    starter: true,
    ritual: ['raise', 'B1', 'swing'],
    hint: '↑ Arm, [B1], then [Swing].',
    counterHint: 'Shatters Chilled or Frozen foes (+50% dmg).',
    description: '14 damage. Quick and cheap. Shatters Chilled/Frozen (+50%).',
  },
  'fire-lance': {
    id: 'fire-lance', name: 'Fire Lance', element: 'fire', cost: 4, target: 'enemy', damage: 32, pierce: true, color: '#ff8a3d',
    ritual: ['raise', 'B1', 'B2', 'swing'],
    hint: '4 steps: ↑ Arm → [B1] → [B2] → [Swing].',
    counterHint: 'Pierces Pack Leader & Gatekeeper armor; +50% vs Chilled/Frozen.',
    description: '32 damage that ignores armor.',
  },
  immolate: {
    id: 'immolate', name: 'Immolate', element: 'fire', cost: 3, target: 'enemy', damage: 8, color: '#ff7a2e',
    applies: { id: 'burning', turns: 3, amount: 6 },
    ritual: ['duck', 'B2', 'swing'],
    hint: '↓ Duck, [B2], then [Swing].',
    counterHint: 'Applies Burning (ignores armor, primes Storm Conductive).',
    description: '8 damage, then Burning: 6 damage at the start of its next 3 turns.',
  },
  meteor: {
    id: 'meteor', name: 'Meteor', element: 'fire', cost: 7, target: 'enemy', damage: 34, splash: 16, color: '#ff6a2a',
    ritual: ['raise', 'duck', 'B1', 'B2', 'swing'],
    hint: '5 steps: ↑ Arm → ↓ Duck → [B1] → [B2] → [Swing].',
    counterHint: 'Undodgeable pack devastation. Shatters Chilled packs.',
    description: '34 damage to the target and 16 to every other wolf. Long charge.',
  },
  'frost-shard': {
    id: 'frost-shard', name: 'Frost Shard', element: 'frost', cost: 2, target: 'enemy', damage: 10, color: '#98e8ff',
    applies: { id: 'chilled', turns: 1 },
    starter: true,
    ritual: ['duck', 'T', 'swing'],
    hint: '↓ Duck, [T], then [Swing].',
    counterHint: 'Chills target (−30% dmg, blocks Jaw & Grab, primes Fire Shatter).',
    description: '10 damage and Chilled: its next attack does 30% less.',
  },
  'ice-shield': {
    id: 'ice-shield', name: 'Ice Shield', element: 'frost', cost: 3, target: 'self', damage: 0, color: '#aeeaff',
    shield: { amount: 18, turns: 2 },
    ritual: ['raise', 'T', 'B1'],
    hint: '↑ Arm, [T], then [B1].',
    counterHint: 'Counters heavy attacks, Bleeding, and Gatekeeper Scorn curses.',
    description: 'Absorbs the next 18 damage for 2 turns.',
  },
  'frost-prison': {
    id: 'frost-prison', name: 'Frost Prison', element: 'frost', cost: 5, target: 'enemy', damage: 0, color: '#c4f4ff',
    applies: { id: 'frozen', turns: 2 },
    ritual: ['raise', 'duck', 'T', 'B1', 'swing'],
    hint: '5 steps: ↑ Arm → ↓ Duck → [T] → [B1] → [Swing].',
    counterHint: 'Freezes 2 turns, strips Roused, and primes Fire Shatter (+50%).',
    description: 'Frozen: strips Roused and the wolf skips its next 2 turns.',
  },
  'frost-nova': {
    id: 'frost-nova', name: 'Frost Nova', element: 'frost', cost: 4, target: 'enemy', damage: 12, area: true, color: '#7fd8ff',
    applies: { id: 'chilled', turns: 1 },
    ritual: ['duck', 'T', 'B2', 'swing'],
    hint: '4 steps: ↓ Duck → [T] → [B2] → [Swing].',
    counterHint: 'Undodgeable; Chills the entire pack to set up Meteor or Chain Lightning.',
    description: '12 damage to every wolf and Chills them all.',
  },
  'storm-spark': {
    id: 'storm-spark', name: 'Storm Spark', element: 'storm', cost: 1, target: 'enemy', damage: 7, color: '#cfacff',
    starter: true,
    ritual: ['raise', 'B2', 'B1'],
    hint: '↑ Arm, [B2], then [B1].',
    counterHint: 'Conducts on Burning/Chilled foes (+4 dmg & refunds 1 MP).',
    description: '7 damage. Nearly instant and conducts on Burning/Chilled.',
  },
  'chain-lightning': {
    id: 'chain-lightning', name: 'Chain Lightning', element: 'storm', cost: 4, target: 'enemy', damage: 16, chain: [10, 6], color: '#c49bff',
    ritual: ['raise', 'B2', 'T', 'swing'],
    hint: '4 steps: ↑ Arm → [B2] → [T] → [Swing].',
    counterHint: 'Undodgeable arc across all 3 wolves; Conducts on Burning/Chilled.',
    description: '16 damage, then jumps to the next wolf for 10 and the last for 6.',
  },
  'static-shock': {
    id: 'static-shock', name: 'Static Shock', element: 'storm', cost: 3, target: 'enemy', damage: 8, drain: true, color: '#b48cff',
    applies: { id: 'drained', turns: 1 },
    ritual: ['duck', 'T', 'B1'],
    hint: '↓ Duck, [T], then [B1].',
    counterHint: 'HARD COUNTER: strips Roused (+5 bonus dmg) and drains all Energy!',
    description: '8 damage, strips Roused, and Drained: empties energy so it must Rest.',
  },
  'overcharge': {
    id: 'overcharge', name: 'Overcharge', element: 'storm', cost: 2, target: 'self', damage: 0, color: '#d6b8ff',
    overcharge: { multiplier: 1.5, turns: 2 },
    ritual: ['raise', 'B2', 'swing'],
    hint: '↑ Arm, [B2], then [Swing].',
    counterHint: 'Next attack spell deals ×1.5 damage; Storm spells refund 1 MP.',
    description: 'Your next damaging spell hits 50% harder. A Storm spell also refunds 1 MP.',
  },
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

/** Find any spell whose ritual matches the given sequence of steps, or starts with it. */
export function matchRitualPrefix(steps: readonly RitualStep[], elementFilter?: SpellElement): {
  exact: Spell | null;
  candidates: Spell[];
} {
  if (!steps.length) return { exact: null, candidates: [] };
  const all = Object.values(SPELLS).filter(s => !elementFilter || s.element === elementFilter);
  const candidates = all.filter(spell =>
    steps.length <= spell.ritual.length &&
    steps.every((step, index) => spell.ritual[index] === step),
  );
  const exact = candidates.find(spell => spell.ritual.length === steps.length) ?? null;
  return { exact, candidates };
}
