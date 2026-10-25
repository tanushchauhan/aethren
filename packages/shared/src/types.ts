/**
 * Shared contract for Once Upon a Memory.
 * Locked in Phase 0 so client, server, and firmware agents share one shape.
 * Muse JSON may use snake_case (`art_prompt`); map it onto these camelCase fields at the boundary.
 */

/** Every element across tiers. P0 ships the first three. */
export type ElementType = 'ember' | 'frost' | 'bloom' | 'storm' | 'moon' | 'starlight';

/** Elements on the P0 spell wheel. */
export type P0ElementType = 'ember' | 'frost' | 'bloom';

/** Enemy attacks. P0 uses `low_sweep`, `high_swing`, and `projectile`. */
export type AttackType = 'low_sweep' | 'high_swing' | 'projectile' | 'ground_wave' | 'stare';

/**
 * Spell-release gestures.
 * `swipe` is the unsided P0 cast. `swipe_left` / `swipe_right` carry aim.
 */
export type GestureType = 'swipe_left' | 'swipe_right' | 'swipe' | 'thrust';

/** Fixed encounter templates. Code owns hit points and behavior; Muse only picks one. */
export type EncounterTemplate = 'charger' | 'caster' | 'swarm' | 'guardian';

/** Collaborative spell that can break a ward. P0 has Twin Cast only. */
export type CollaborativeSpellId = 'twin_cast';

export type BuzzPattern = 'tick' | 'cast' | 'fizzle' | 'hit';

export type PlayerRole = 'spellbearer' | 'partner' | 'bot';

export type QuestDifficulty = 'easy' | 'normal' | 'hard';

/**
 * High-level room phase, including the combat round steps.
 * Order during a fight: telegraph -> defense -> return -> team_turn -> resolve.
 */
export type GamePhase =
  | 'lobby'
  | 'opening'
  | 'calibration'
  | 'intro'
  | 'telegraph'
  | 'defense'
  | 'return'
  | 'team_turn'
  | 'resolve'
  | 'ending';

/** One MediaPipe Pose landmark, normalized to the frame (origin top-left, y grows downward). */
export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** Standing pose captured during the 3-second calibration. */
export interface CalibrationBaseline {
  shoulderY: number;
  shoulderWidth: number;
  hipY: number;
  centerX: number;
  calibratedAt: number;
  /**
   * Head center height (nose, eyes, and ears averaged) while standing. Optional: it is left out
   * when the face was never visible, and older baselines do not have it.
   */
  noseY?: number;
}

export type PoseActionType =
  | 'none'
  | 'side_step_left'
  | 'side_step_right'
  | 'duck'
  | 'arm_raise'
  | 'swipe_left'
  | 'swipe_right'
  | 'thrust';

/** Body sample a laptop sends so teammates can be drawn and dodges can be judged. */
export interface PoseFrame {
  playerId: string;
  landmarks: NormalizedLandmark[];
  inZone: boolean;
  activeAction: PoseActionType;
  confidence: number;
  serverTimestampMs: number;
}

/**
 * Newline-delimited JSON frame the glove sends at 50 Hz over USB serial (115200 baud).
 * `dial` is the spell-wheel slot (0..2 in P0), not the raw 10-bit angle.
 */
export interface GloveSensorFrame {
  dial: number;
  btn: number;
  fist: boolean;
  swipe: 'none' | 'left' | 'right' | 'thrust';
  accel: number;
  parry: boolean;
  armed: boolean;
  noise: number;
  color: 'none' | 'ember' | 'frost' | 'bloom' | 'boss';
}

/** Command the laptop writes back to the glove, one JSON object per line. */
export type GloveCommand =
  | { cmd: 'buzz'; p: BuzzPattern }
  | { cmd: 'servo'; open: boolean };

/** Semantic glove snapshot laptop A forwards to the server (not the raw serial line). */
export interface HardwareEvent {
  dialSlot: number;
  buttonPressed: boolean;
  fistCharged: boolean;
  parryTriggered: boolean;
  colorToken: GloveSensorFrame['color'] | null;
  noiseLevel: number;
  armed: boolean;
}

/**
 * Socket form of a glove command. Laptop A translates this into a {@link GloveCommand}
 * before writing it to the serial port.
 */
export interface HardwareCommand {
  type: 'buzz' | 'servo';
  pattern?: BuzzPattern;
  servoOpen?: boolean;
}

/** A moment Muse Spark extracted from the consented group chat. */
export interface MemoryCard {
  id: string;
  quote: string;
  date: string;
  people: string[];
  mood: string;
  /** Display color (CSS color or token name) chosen by Muse. */
  color: string;
}

export interface EncounterSchema {
  memory: string;
  name: string;
  template: EncounterTemplate;
  attacks: AttackType[];
  weakness: ElementType;
  tier: 1 | 2 | 3;
  lines: string[];
  artPrompt: string;
}

/** Same shape as an encounter, always tier 3, plus the spell that breaks its ward. */
export interface BossSchema extends EncounterSchema {
  tier: 3;
  ward: CollaborativeSpellId;
}

/** One phrase per element, including elements that are not on the P0 wheel yet. */
export type IncantationMap = Record<ElementType, string>;

export interface WorldSchema {
  title: string;
  intro: string;
  incantations: IncantationMap;
  encounters: EncounterSchema[];
  boss: BossSchema;
}

export interface PlayerState {
  id: string;
  name: string;
  role: PlayerRole;
  connected: boolean;
  inZone: boolean;
  /** False when the player is still outside the silhouette at the start of the team turn. */
  canCast: boolean;
  selectedElement: P0ElementType | null;
  fistCharged: boolean;
}

/** Authoritative snapshot the server broadcasts on `room:state`. */
export interface GameState {
  roomCode: string;
  phase: GamePhase;
  hearts: number;
  maxHearts: number;
  wardActive: boolean;
  wardSpell: CollaborativeSpellId | null;
  players: PlayerState[];
  world: WorldSchema | null;
  currentEncounter: EncounterSchema | BossSchema | null;
  fightingBoss: boolean;
  enemyHp: number;
  enemyMaxHp: number;
  roundIndex: number;
  serverTimestampMs: number;
}

/** Scheduled attack. Every screen shows it against `impactServerMs` in server time. */
export interface TelegraphPayload {
  attackId: string;
  attackType: AttackType;
  targetPlayerIds: string[];
  impactServerMs: number;
  windowMs: number;
  narratorHint: string;
}

export interface ClockPing {
  clientSendMs: number;
}

export interface ClockPong {
  clientSendMs: number;
  serverRecvMs: number;
  serverSendMs: number;
}

export interface DodgeResultPayload {
  playerId: string;
  attackId: string;
  dodged: boolean;
  parried: boolean;
  serverTimestampMs: number;
}

export interface CastPayload {
  playerId: string;
  element: P0ElementType;
  gesture: GestureType;
  transcript: string;
  /** Effect multiplier after the word match, fist charge, and accelerometer. */
  power: number;
  serverTimestampMs: number;
}

export interface ServerToClientEvents {
  'clock:pong': (payload: ClockPong) => void;
  'room:state': (state: GameState) => void;
  'combat:telegraph': (payload: TelegraphPayload) => void;
  'hardware:command': (command: HardwareCommand) => void;
}

export interface ClientToServerEvents {
  'clock:ping': (payload: ClockPing) => void;
  'player:pose': (frame: PoseFrame) => void;
  'player:dodge_result': (payload: DodgeResultPayload) => void;
  'player:cast': (payload: CastPayload) => void;
  'hardware:event': (event: HardwareEvent) => void;
}
