import type {
  AttackType,
  ElementType,
  EncounterTemplate,
  P0ElementType,
  QuestDifficulty,
} from './types';

/** Combat round phase durations. A full round is their sum (about 16 seconds). */
export const ROUND_TIMINGS_MS = {
  telegraph: 2000,
  defense: 1500,
  return: 3000,
  teamTurn: 8000,
  resolve: 1500,
} as const;

export const ROUND_DURATION_MS =
  ROUND_TIMINGS_MS.telegraph +
  ROUND_TIMINGS_MS.defense +
  ROUND_TIMINGS_MS.return +
  ROUND_TIMINGS_MS.teamTurn +
  ROUND_TIMINGS_MS.resolve;

/** The boss agent may only resize the defense window inside this range. */
export const DEFENSE_WINDOW_MS = {
  min: 1000,
  max: 2000,
  default: ROUND_TIMINGS_MS.defense,
} as const;

/** Both casts of the same element inside this window shatter the ward and deal double damage. */
export const TWIN_CAST_WINDOW_MS = 3000;

/** Pause after a disconnect before a bot takes the empty seat. */
export const DISCONNECT_PAUSE_MS = 10_000;

/** Clients re-ping on join and on this interval to refresh `serverTimeOffsetMs`. */
export const CLOCK_SYNC_INTERVAL_MS = 10_000;

/** Player stands inside the silhouette this long while the baseline is recorded. */
export const CALIBRATION_DURATION_MS = 3000;

/**
 * Zone width as a multiple of calibrated shoulder width.
 * A little wider than the shoulders, so one side step clears it.
 */
export const ZONE_WIDTH_MULTIPLIER = 1.4;

/**
 * Duck when the shoulder midpoint drops this far below the standing baseline.
 * MediaPipe y grows downward, so a duck is `shoulderY > baseline.shoulderY + DUCK_THRESHOLD`.
 */
export const DUCK_THRESHOLD = 0.15;

/** Hold the right wrist above the head this long to lock the next wheel slot. */
export const ARM_RAISE_HOLD_MS = 1000;

/** Wrist velocity is measured across this rolling window for swipe and thrust. */
export const SWIPE_WINDOW_MS = 200;

export const POSE_TRACK_HZ = 30;
export const POSE_SEND_HZ = 15;
export const POSE_LANDMARK_COUNT = 33;

/**
 * MediaPipe Pose Landmarker indices in image space (33 landmarks).
 * A mirrored preview flips x for drawing; these indices stay on the unflipped frame.
 */
export const POSE_LANDMARK = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
} as const;

export const TEAM_HEARTS_P0 = 5;
export const P0_PLAYER_COUNT = 2;
export const ROOM_CODE_LENGTH = 4;

/** Share of incantation words that must match. Forgives a noisy room. */
export const INCANTATION_MATCH_RATIO = 0.6;

/** The third failed attempt in a row succeeds at {@link MERCY_POWER}. */
export const MERCY_ATTEMPT = 3;
export const MERCY_POWER = 0.5;

/**
 * Grove sound sensor reading (0–1023). At or above this, raise the mic gate
 * and show the "too loud" warning.
 */
export const NOISE_TOO_LOUD_THRESHOLD = 450;

export const SERIAL_BAUD = 115200;
export const GLOVE_POLL_HZ = 50;
/** The glove listens for commands and streams frames back on this UDP port once it joins Wi-Fi. */
export const GLOVE_UDP_PORT = 4210;
/** Forearm 16x2 LCD: characters per line. */
export const GLOVE_LCD_COLS = 16;

/** P0 dial slots. Index matches {@link P0_ELEMENTS}. */
export const DIAL_SLOT_COUNT = 3;

/** Accelerometer speed scales spell power inside this range. */
export const ACCEL_POWER = { min: 1, max: 1.5 } as const;

/** Extra multiplier while the palm light sensor is covered (closed fist). */
export const FIST_CHARGE_MULTIPLIER = 1.25;

export const SERVO_ANGLE = { closed: 0, open: 110 } as const;

export const TAUNT_MAX_CHARS = 120;

/** If cloud TTS takes longer than this, the client speaks with `speechSynthesis`. */
export const TTS_CLIENT_FALLBACK_MS = 800;

/** The boss may raise its ward once it falls below this fraction of max HP. */
export const WARD_HP_RATIO = 0.5;

export const P0_ELEMENTS = ['ember', 'frost', 'bloom'] as const satisfies readonly P0ElementType[];

export const ELEMENT_META: Record<
  ElementType,
  { tier: 'P0' | 'P1' | 'P2'; label: string; effect: string; color: string }
> = {
  ember: { tier: 'P0', label: 'Ember', effect: 'Fire damage', color: '#E85D04' },
  frost: {
    tier: 'P0',
    label: 'Frost',
    effect: "Slows the enemy's next telegraph, giving a longer defense window",
    color: '#4CC9F0',
  },
  bloom: { tier: 'P0', label: 'Bloom', effect: 'Heals 1 heart', color: '#52B788' },
  storm: {
    tier: 'P1',
    label: 'Storm',
    effect: 'Damage that chains to a second enemy',
    color: '#7209B7',
  },
  moon: { tier: 'P2', label: 'Moon', effect: "Skips the enemy's next attack", color: '#CDB4DB' },
  starlight: {
    tier: 'P2',
    label: 'Starlight',
    effect: 'Only works as part of a collaborative spell',
    color: '#FFD60A',
  },
};

/** Which body action answers each attack. Jump and freeze arrive after P0. */
export const ATTACK_DEFENSE: Record<AttackType, 'side_step' | 'duck' | 'parry' | 'jump' | 'freeze'> = {
  low_sweep: 'side_step',
  high_swing: 'duck',
  projectile: 'parry',
  ground_wave: 'jump',
  stare: 'freeze',
};

export const COMBAT = {
  hearts: TEAM_HEARTS_P0,
  heartLossOnHit: 1,
  bloomHeal: 1,
  twinCastMultiplier: 2,
  /** Flat damage before element, power, and Twin Cast multipliers. */
  baseSpellDamage: 10,
  parryDamage: 8,
} as const;

/**
 * Code-owned stats per encounter template. These set how each template fights.
 * `attackSpeed` scales the telegraph duration (above 1 is a faster wind-up).
 * `defaultAttacks` is the scripted cycle when the boss agent is unavailable.
 */
export const ENEMY_TEMPLATES: Record<
  EncounterTemplate,
  { baseHp: number; attackSpeed: number; defaultAttacks: readonly AttackType[] }
> = {
  charger: { baseHp: 60, attackSpeed: 1.1, defaultAttacks: ['low_sweep', 'high_swing', 'low_sweep'] },
  caster: { baseHp: 50, attackSpeed: 1, defaultAttacks: ['projectile', 'high_swing', 'projectile'] },
  swarm: { baseHp: 45, attackSpeed: 1.2, defaultAttacks: ['low_sweep', 'projectile', 'high_swing'] },
  guardian: { baseHp: 80, attackSpeed: 0.9, defaultAttacks: ['high_swing', 'projectile', 'low_sweep'] },
};

/** Tier multipliers on template hit points and attack speed. Bosses are always tier 3. */
export const TIER_MULTIPLIERS: Record<1 | 2 | 3, { hp: number; attackSpeed: number }> = {
  1: { hp: 1, attackSpeed: 1 },
  2: { hp: 1.4, attackSpeed: 1.05 },
  3: { hp: 2, attackSpeed: 1.1 },
};

/** Quest difficulty scales enemy hit points only; round timings stay fixed. */
export const DIFFICULTY_HP_MULTIPLIER: Record<QuestDifficulty, number> = {
  easy: 0.75,
  normal: 1,
  hard: 1.3,
};
