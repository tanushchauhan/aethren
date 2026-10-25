import { TEAM_HEARTS_P0 } from '@once-upon/shared';
import type { BodyPartTarget } from './poseClassifiers';

/**
 * Survival Gauntlet: escalating waves of Osu! rings and silhouette blasts on shared hearts.
 * Everything here is pure so the page only has to schedule attacks and render the state.
 */

export type GauntletDifficulty = 'normal' | 'hard' | 'insane';

export const GAUNTLET_DIFFICULTIES: readonly GauntletDifficulty[] = ['normal', 'hard', 'insane'];

export const GAUNTLET_DIFFICULTY_LABEL: Record<GauntletDifficulty, string> = {
  normal: 'Normal',
  hard: 'Hard',
  insane: 'Insane (Osu! Pro)',
};

/** Harder settings shrink every window and gap, and pay more per dodge. */
export const GAUNTLET_DIFFICULTY_TUNING: Record<GauntletDifficulty, { time: number; score: number }> = {
  normal: { time: 1, score: 1 },
  hard: { time: 0.85, score: 1.5 },
  insane: { time: 0.7, score: 2 },
};

export const GAUNTLET_HEARTS = TEAM_HEARTS_P0;

/** Surviving the last attack of this wave clears the gauntlet. */
export const GAUNTLET_FINAL_WAVE = 15;

/** Wind-up before the very first attack, so the player can get into position. */
export const GAUNTLET_START_DELAY_MS = 2500;

/** Breather between waves, while the next wave is announced. */
export const GAUNTLET_WAVE_BREAK_MS = 1800;

/** No window or gap goes below this, even on Insane. */
export const GAUNTLET_MIN_WINDOW_MS = 650;
export const GAUNTLET_MIN_GAP_MS = 400;

/** Bonus per heart left when the final wave is cleared. */
export const GAUNTLET_CLEAR_BONUS_PER_HEART = 500;

export type GauntletLevelNumber = 1 | 2 | 3 | 4 | 5;

export interface GauntletLevel {
  level: GauntletLevelNumber;
  name: string;
  firstWave: number;
  /** Countdown for a ring attack. */
  windowMs: number;
  /** Countdown for a whole-body blast, longer because the whole body has to move. */
  blastWindowMs: number;
  /** Boss single-ring snipes use this shorter countdown. */
  sniperWindowMs: number;
  /** Pause between attacks inside a wave. */
  gapMs: number;
}

export const GAUNTLET_LEVELS: readonly GauntletLevel[] = [
  { level: 1, name: 'Warmup', firstWave: 1, windowMs: 2400, blastWindowMs: 2600, sniperWindowMs: 2400, gapMs: 1200 },
  { level: 2, name: 'Speed Up', firstWave: 3, windowMs: 1800, blastWindowMs: 2400, sniperWindowMs: 1800, gapMs: 1000 },
  { level: 3, name: 'Dual Rings', firstWave: 5, windowMs: 1700, blastWindowMs: 2200, sniperWindowMs: 1700, gapMs: 900 },
  { level: 4, name: 'Rapid Chain', firstWave: 8, windowMs: 1350, blastWindowMs: 2000, sniperWindowMs: 1350, gapMs: 650 },
  { level: 5, name: 'Boss Frenzy', firstWave: 11, windowMs: 1100, blastWindowMs: 1800, sniperWindowMs: 1000, gapMs: 600 },
];

/** Rings in the gauntlet: head and both arms. */
export const GAUNTLET_SINGLE_PARTS: readonly BodyPartTarget[] = ['head', 'left_shoulder', 'right_shoulder'];

export const GAUNTLET_DUAL_PAIRS: readonly (readonly [BodyPartTarget, BodyPartTarget])[] = [
  ['head', 'left_shoulder'],
  ['left_shoulder', 'right_shoulder'],
  ['head', 'right_shoulder'],
];

export type GauntletIncoming =
  | { kind: 'part_ring'; parts: readonly BodyPartTarget[] }
  | { kind: 'zone_blast' };

export interface GauntletAttack {
  incoming: GauntletIncoming;
  windowMs: number;
  /** Pause before this attack's warning starts. The page uses the wave break for the first one. */
  gapMs: number;
  /** After a blast, this attack holds its countdown until the player is back in the silhouette. */
  requireHome: boolean;
  /** Boss single ring on the short sniper countdown. */
  sniper: boolean;
}

export type GauntletStatus = 'idle' | 'running' | 'over' | 'cleared';

export interface GauntletState {
  status: GauntletStatus;
  difficulty: GauntletDifficulty;
  hearts: number;
  score: number;
  streak: number;
  bestStreak: number;
  wave: number;
  dodged: number;
  hits: number;
  highScore: number;
}

/** Random source in [0, 1). Tests pass a seeded one. */
export type Rng = () => number;

export function levelForWave(wave: number): GauntletLevel {
  let current = GAUNTLET_LEVELS[0] as GauntletLevel;
  for (const level of GAUNTLET_LEVELS) {
    if (wave >= level.firstWave) current = level;
  }
  return current;
}

export function levelTitle(level: GauntletLevel): string {
  return level.level === 5 ? `Level 5: ${level.name.toUpperCase()}` : `Level ${level.level}: ${level.name}`;
}

/** Streak to score multiplier: 1x, then 2x from 3 in a row, 3x from 6, 4x from 10. */
export function comboMultiplier(streak: number): 1 | 2 | 3 | 4 {
  if (streak >= 10) return 4;
  if (streak >= 6) return 3;
  if (streak >= 3) return 2;
  return 1;
}

/** Base points before the combo and difficulty multipliers. */
export function attackPoints(incoming: GauntletIncoming): number {
  if (incoming.kind === 'zone_blast') return 150;
  return incoming.parts.length > 1 ? 250 : 100;
}

function pick<T>(items: readonly T[], rng: Rng): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[Math.max(0, index)] as T;
}

/** A single ring that is not the same part as the last one, so the same lean never wins twice. */
function nextSingle(previous: BodyPartTarget | null, rng: Rng): BodyPartTarget {
  const options = GAUNTLET_SINGLE_PARTS.filter((part) => part !== previous);
  return pick(options.length > 0 ? options : GAUNTLET_SINGLE_PARTS, rng);
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

type Slot = 'single' | 'dual' | 'blast' | 'sniper';

/** The shape of each wave by level. Level 5 is shuffled so it never settles into a rhythm. */
function waveSlots(level: GauntletLevelNumber, rng: Rng): Slot[] {
  switch (level) {
    case 1:
      return ['single', 'single', 'single'];
    case 2:
      return ['single', 'single', 'blast'];
    case 3:
      return ['dual', 'single', 'dual'];
    case 4:
      return ['single', 'single', 'single', 'blast'];
    case 5: {
      // The blast never opens a wave, so it can't land right after a blast that closed the last one.
      const slots = shuffle<Slot>(['dual', 'sniper', 'sniper', 'dual'], rng);
      slots.splice(1 + Math.floor(rng() * slots.length), 0, 'blast');
      return slots;
    }
    default: {
      const neverLevel: never = level;
      return neverLevel;
    }
  }
}

function scaled(ms: number, difficulty: GauntletDifficulty, floor: number): number {
  return Math.max(floor, Math.round(ms * GAUNTLET_DIFFICULTY_TUNING[difficulty].time));
}

/**
 * Builds every attack in one wave. `previousWasBlast` carries the "return to your silhouette"
 * rule across waves when the last wave ended on a blast.
 */
export function buildGauntletWave(
  wave: number,
  difficulty: GauntletDifficulty,
  rng: Rng = Math.random,
  previousWasBlast = false,
): GauntletAttack[] {
  const level = levelForWave(wave);
  const gapMs = scaled(level.gapMs, difficulty, GAUNTLET_MIN_GAP_MS);
  const attacks: GauntletAttack[] = [];
  let lastSingle: BodyPartTarget | null = null;
  let afterBlast = previousWasBlast;

  for (const slot of waveSlots(level.level, rng)) {
    let incoming: GauntletIncoming;
    let windowMs: number;
    if (slot === 'blast') {
      incoming = { kind: 'zone_blast' };
      windowMs = level.blastWindowMs;
    } else if (slot === 'dual') {
      incoming = { kind: 'part_ring', parts: [...pick(GAUNTLET_DUAL_PAIRS, rng)] };
      windowMs = level.windowMs;
    } else {
      lastSingle = nextSingle(lastSingle, rng);
      incoming = { kind: 'part_ring', parts: [lastSingle] };
      windowMs = slot === 'sniper' ? level.sniperWindowMs : level.windowMs;
    }
    attacks.push({
      incoming,
      windowMs: scaled(windowMs, difficulty, GAUNTLET_MIN_WINDOW_MS),
      gapMs,
      requireHome: afterBlast,
      sniper: slot === 'sniper',
    });
    afterBlast = slot === 'blast';
  }
  return attacks;
}

export function createGauntletState(difficulty: GauntletDifficulty, highScore = 0): GauntletState {
  return {
    status: 'idle',
    difficulty,
    hearts: GAUNTLET_HEARTS,
    score: 0,
    streak: 0,
    bestStreak: 0,
    wave: 1,
    dodged: 0,
    hits: 0,
    highScore,
  };
}

export function startGauntlet(difficulty: GauntletDifficulty, highScore = 0): GauntletState {
  return { ...createGauntletState(difficulty, highScore), status: 'running' };
}

/**
 * Scores one judged attack. A dodge grows the streak and pays base points times the combo and
 * difficulty multipliers. A hit costs a shared heart and breaks the streak. 0 hearts ends the run.
 */
export function applyGauntletResult(
  state: GauntletState,
  incoming: GauntletIncoming,
  dodged: boolean,
): { state: GauntletState; points: number } {
  if (state.status !== 'running') return { state, points: 0 };
  if (dodged) {
    const streak = state.streak + 1;
    const points = Math.round(
      attackPoints(incoming) * comboMultiplier(streak) * GAUNTLET_DIFFICULTY_TUNING[state.difficulty].score,
    );
    const score = state.score + points;
    return {
      state: {
        ...state,
        score,
        streak,
        bestStreak: Math.max(state.bestStreak, streak),
        dodged: state.dodged + 1,
        highScore: Math.max(state.highScore, score),
      },
      points,
    };
  }
  const hearts = Math.max(0, state.hearts - 1);
  return {
    state: {
      ...state,
      hearts,
      streak: 0,
      hits: state.hits + 1,
      status: hearts === 0 ? 'over' : 'running',
    },
    points: 0,
  };
}

/** Moves to the next wave, or clears the gauntlet (with a bonus per heart left) after the final wave. */
export function advanceGauntletWave(state: GauntletState): GauntletState {
  if (state.status !== 'running') return state;
  if (state.wave >= GAUNTLET_FINAL_WAVE) {
    const score = state.score + state.hearts * GAUNTLET_CLEAR_BONUS_PER_HEART;
    return { ...state, score, highScore: Math.max(state.highScore, score), status: 'cleared' };
  }
  return { ...state, wave: state.wave + 1 };
}
