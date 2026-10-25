export type SpellElement = 'fire' | 'frost' | 'storm';
export type SpellId =
  | 'ember-bolt' | 'fire-lance' | 'immolate' | 'meteor'
  | 'frost-shard' | 'ice-shield' | 'frost-prison' | 'frost-nova'
  | 'storm-spark' | 'chain-lightning' | 'static-shock' | 'overcharge';

/**
 * Steps a player can chain to weave a spell:
 * - Glove / key inputs: `B1` (cast button / 1), `B2` (element button / 2), `T` (touch / 3), `swing` (slash/thrust glove or Space)
 * - CV body poses (also mapped to WASD fallbacks when testing without camera):
 *   `raise` (raise right arm), `left` (lean left), `right` (lean right), `duck` (crouch)
 */
export type RitualStep = 'B1' | 'B2' | 'T' | 'swing' | 'raise' | 'left' | 'right' | 'duck';

export const RITUAL_LABELS: Record<
  RitualStep,
  { short: string; label: string; timingCue: string; kind: 'glove' | 'pose'; keyHint: string }
> = {
  B1: {
    short: 'B1',
    label: 'Press B1',
    timingCue: 'Press B1 right as the pulse enters the gold Sweet Spot!',
    kind: 'glove',
    keyHint: '1',
  },
  B2: {
    short: 'B2',
    label: 'Tap B2',
    timingCue: 'Tap B2 when the timing bar hits the gold Sweet Spot!',
    kind: 'glove',
    keyHint: '2',
  },
  T: {
    short: 'T',
    label: 'Touch T',
    timingCue: 'Touch T inside the gold Sweet Spot to focus the rune!',
    kind: 'glove',
    keyHint: '3',
  },
  swing: {
    short: 'Swing',
    label: 'Swing Glove',
    timingCue: 'Swing the glove forward as the marker crosses the gold Sweet Spot!',
    kind: 'glove',
    keyHint: 'Space',
  },
  raise: {
    short: '↑ Arm',
    label: 'Raise Right Arm (CV)',
    timingCue: 'Raise your right hand above shoulder height as the marker enters the gold zone!',
    kind: 'pose',
    keyHint: 'W',
  },
  left: {
    short: '← Lean',
    label: 'Lean Left (CV)',
    timingCue: 'Lean your torso left into the gold timing window!',
    kind: 'pose',
    keyHint: 'A',
  },
  right: {
    short: 'Lean →',
    label: 'Lean Right (CV)',
    timingCue: 'Lean your torso right into the gold timing window!',
    kind: 'pose',
    keyHint: 'D',
  },
  duck: {
    short: '↓ Duck',
    label: 'Duck Low (CV)',
    timingCue: 'Duck your shoulders down as the pulse reaches the gold window!',
    kind: 'pose',
    keyHint: 'S',
  },
};

/** Duration of each individual step's timing bar during a spell ritual. */
export const RITUAL_STEP_DURATION_MS = 2800;
/** Normalized progress (0..1) where the Perfect timing sweet-spot begins and ends. */
export const PERFECT_WINDOW_START = 0.35;
export const PERFECT_WINDOW_END = 0.72;
export const GOOD_WINDOW_START = 0.16;
export const GOOD_WINDOW_END = 0.88;

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
    id: 'ember-bolt', name: 'Ember Bolt', element: 'fire', cost: 2, target: 'enemy', damage: 8, color: '#ff9653',
    starter: true,
    ritual: ['raise', 'B1', 'swing'],
    hint: 'Raise your right arm (↑ Arm), press B1 in the sweet spot, then Swing.',
    counterHint: 'Shatters Chilled or Frozen foes (+50% dmg).',
    description: '8 damage. Quick and cheap. Shatters Chilled/Frozen (+50%).',
  },
  'fire-lance': {
    id: 'fire-lance', name: 'Fire Lance', element: 'fire', cost: 4, target: 'enemy', damage: 18, pierce: true, color: '#ff8a3d',
    ritual: ['left', 'B1', 'swing'],
    hint: 'Starts by leaning Left (← Lean), locking with B1, then thrusting with a Swing.',
    counterHint: 'Pierces Pack Leader & Gatekeeper armor; +50% vs Chilled/Frozen.',
    description: '18 damage that ignores armor.',
  },
  immolate: {
    id: 'immolate', name: 'Immolate', element: 'fire', cost: 3, target: 'enemy', damage: 5, color: '#ff7a2e',
    applies: { id: 'burning', turns: 3, amount: 4 },
    ritual: ['duck', 'B2', 'swing'],
    hint: 'Starts by ducking low (↓ Duck) to draw ground heat, then B2 + Swing.',
    counterHint: 'Applies Burning (ignores armor, primes Storm Conductive).',
    description: '5 damage, then Burning: 4 damage at the start of its next 3 turns.',
  },
  meteor: {
    id: 'meteor', name: 'Meteor', element: 'fire', cost: 7, target: 'enemy', damage: 22, splash: 10, color: '#ff6a2a',
    ritual: ['raise', 'duck', 'B1', 'swing'],
    hint: 'Call the sky down: Raise Arm (↑ Arm), Duck low (↓ Duck), press B1, then Swing.',
    counterHint: 'Undodgeable pack devastation. Shatters Chilled packs.',
    description: '22 damage to the target and 10 to every other wolf. Long charge.',
  },
  'frost-shard': {
    id: 'frost-shard', name: 'Frost Shard', element: 'frost', cost: 2, target: 'enemy', damage: 5, color: '#98e8ff',
    applies: { id: 'chilled', turns: 1 },
    starter: true,
    ritual: ['left', 'T', 'swing'],
    hint: 'Lean Left (← Lean), Touch T to condense ice, then Swing.',
    counterHint: 'Chills target (−30% dmg, blocks Jaw & Grab, primes Fire Shatter).',
    description: '5 damage and Chilled: its next attack does 30% less.',
  },
  'ice-shield': {
    id: 'ice-shield', name: 'Ice Shield', element: 'frost', cost: 3, target: 'self', damage: 0, color: '#aeeaff',
    shield: { amount: 18, turns: 2 },
    ritual: ['raise', 'T', 'B1'],
    hint: 'Starts by raising your guard arm (↑ Arm), then Touch T and B1.',
    counterHint: 'Counters heavy attacks, Bleeding, and Gatekeeper Scorn curses.',
    description: 'Absorbs the next 18 damage for 2 turns.',
  },
  'frost-prison': {
    id: 'frost-prison', name: 'Frost Prison', element: 'frost', cost: 5, target: 'enemy', damage: 0, color: '#c4f4ff',
    applies: { id: 'frozen', turns: 2 },
    ritual: ['left', 'right', 'T', 'swing'],
    hint: 'Starts by weaving Left (← Lean) then Right (Lean →), Touch T, then Swing.',
    counterHint: 'Freezes 2 turns, strips Roused, and primes Fire Shatter (+50%).',
    description: 'Frozen: strips Roused and the wolf skips its next 2 turns.',
  },
  'frost-nova': {
    id: 'frost-nova', name: 'Frost Nova', element: 'frost', cost: 4, target: 'enemy', damage: 5, area: true, color: '#7fd8ff',
    applies: { id: 'chilled', turns: 1 },
    ritual: ['duck', 'T', 'swing'],
    hint: 'Starts by ducking low (↓ Duck), touching T, then sweeping with a Swing.',
    counterHint: 'Undodgeable; Chills the entire pack to set up Meteor or Chain Lightning.',
    description: '5 damage to every wolf and Chills them all.',
  },
  'storm-spark': {
    id: 'storm-spark', name: 'Storm Spark', element: 'storm', cost: 1, target: 'enemy', damage: 4, color: '#cfacff',
    starter: true,
    ritual: ['right', 'B2', 'B1'],
    hint: 'Lean Right (Lean →), tap B2, then press B1 in the sweet spot.',
    counterHint: 'Conducts on Burning/Chilled foes (+4 dmg & refunds 1 MP).',
    description: '4 damage. Nearly instant and conducts on Burning/Chilled.',
  },
  'chain-lightning': {
    id: 'chain-lightning', name: 'Chain Lightning', element: 'storm', cost: 4, target: 'enemy', damage: 9, chain: [6, 4], color: '#c49bff',
    ritual: ['left', 'B2', 'swing'],
    hint: 'Starts by leaning Left (← Lean), tapping B2, then Swinging.',
    counterHint: 'Undodgeable arc across all 3 wolves; Conducts on Burning/Chilled.',
    description: '9 damage, then jumps to the next wolf for 6 and the last for 4.',
  },
  'static-shock': {
    id: 'static-shock', name: 'Static Shock', element: 'storm', cost: 3, target: 'enemy', damage: 4, drain: true, color: '#b48cff',
    applies: { id: 'drained', turns: 1 },
    ritual: ['right', 'T', 'B1'],
    hint: 'Starts by leaning Right (Lean →), touching T, then pressing B1.',
    counterHint: 'HARD COUNTER: strips Roused (+5 bonus dmg) and drains all Energy!',
    description: '4 damage, strips Roused, and Drained: empties energy so it must Rest.',
  },
  'overcharge': {
    id: 'overcharge', name: 'Overcharge', element: 'storm', cost: 2, target: 'self', damage: 0, color: '#d6b8ff',
    overcharge: { multiplier: 1.5, turns: 2 },
    ritual: ['raise', 'B2', 'swing'],
    hint: 'Starts by raising your arm (↑ Arm) to draw lightning, then B2 + Swing.',
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
