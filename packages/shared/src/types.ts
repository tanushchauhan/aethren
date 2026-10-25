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
 * Newline-delimited JSON frame the glove sends at 50 Hz over USB serial (115200 baud)
 * or Wi-Fi UDP (port 4210). `dial` is the spell-wheel slot (0..2 in P0), not the raw
 * 10-bit angle. `btn` is D4 (push-to-talk) and `btn2` is D8 (lock / charge).
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
  /** D8 Button 2, gated by `armed`. */
  btn2?: number;
  /** Raw D3 touch level, not gated. */
  d3?: number;
  /** Raw D4 Button 1 level, not gated. */
  d4?: number;
  /** Raw D8 Button 2 level, not gated. */
  d8?: number;
  /** Raw A0 rotary angle, 0..1023. */
  rawDial?: number;
}

/** Command the laptop writes back to the glove, one JSON object per line. */
export type GloveCommand =
  | { cmd: 'buzz'; p: BuzzPattern }
  | { cmd: 'servo'; open: boolean }
  /** Forearm 16x2 RGB LCD. Lines are 16 printable ASCII characters; `ms` 0 keeps it until replaced. */
  | { cmd: 'lcd'; l1?: string; l2?: string; r?: number; g?: number; b?: number; ms?: number }
  /** Join a hotspot. Without `ssid` the board reports its Wi-Fi status. */
  | { cmd: 'wifi'; ssid?: string; pass?: string }
  | { cmd: 'arm'; open: boolean }
  /** UDP only: subscribe this sender to the frame stream. */
  | { cmd: 'hello' };

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
  /** Latest glove noise reading; absent before hardware reports it. */
  noiseLevel?: number;
  /** Whether the Spellbearer's hardware switch is armed. */
  gloveArmed?: boolean;
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
  /** Cards offered in the opening. Absent until the chat upload (or cached fixtures) load. */
  memoryCards?: MemoryCard[];
  /** Opening picks. `null` until a player keeps a card for that slot. */
  picks?: { encounterCardId: string | null; bossCardId: string | null };
  /** Image URLs by kind, filled in as Muse Image resolves. Show placeholder art until present. */
  images?: Partial<Record<WorldImage['kind'], string>>;
  /** True while the room waits on a disconnected player (see `DISCONNECT_PAUSE_MS`). */
  paused?: boolean;
  /** Human-readable pause reason, e.g. "Dev disconnected". */
  pausedReason?: string;
  /** Defense window for the current round after the boss agent's `adjust_timing`. */
  defenseWindowMs?: number;
  /** Outcome of the most recent resolve step, kept until the next one. */
  lastResolution?: RoundResolution | null;
  /** When the current phase ends, in server time. Lets clients draw countdowns. */
  phaseEndsServerMs?: number;
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

/** Damage summary the server broadcasts on `combat:resolve` at the end of each round. */
export interface RoundResolution {
  roundIndex: number;
  /** Total damage dealt to the enemy this round, after multipliers and parries. */
  damageDealt: number;
  heartsLost: number;
  heartsHealed: number;
  /** Number of projectiles parried back at the enemy. */
  parries: number;
  /** True when a Twin Cast landed this round. */
  twinCast: boolean;
  /** True when this round's Twin Cast broke the boss's ward. */
  wardShattered: boolean;
  /** Players whose incantation failed, so the spell fizzled. */
  fizzles: string[];
  /** Players who were outside their zone at the team turn and could not cast. */
  sittingOut: string[];
  enemyDefeated: boolean;
  serverTimestampMs: number;
}

/**
 * Twin Cast progress during the team turn. Sent when the first matching cast lands
 * and again when the second completes it (or the window expires).
 */
export interface TwinCastProgress {
  element: P0ElementType;
  castByPlayerIds: string[];
  /** The Twin Cast fails if the second cast arrives after this server time. */
  expiresServerMs: number;
  complete: boolean;
}

/** A spoken and captioned line. Without `ttsUrl`, clients call `POST /api/tts` or use `speechSynthesis`. */
export interface NarratorLine {
  id: string;
  speaker: 'narrator' | 'boss';
  text: string;
  ttsUrl?: string;
}

/** A Muse Image result streamed to the room as soon as it resolves. */
export interface WorldImage {
  kind: 'cover' | 'monster' | 'boss';
  /** HTTP(S) URL or `data:` URL. */
  url: string;
}

/** Seat a laptop asks for. Bots are server-only, so clients never request `bot`. */
export type JoinableRole = Exclude<PlayerRole, 'bot'>;

export interface RoomCreateRequest {
  playerName: string;
  role: JoinableRole;
  difficulty?: QuestDifficulty;
}

export interface RoomJoinRequest {
  roomCode?: string;
  /** Storybook client spelling of `roomCode`; either is accepted. */
  code?: string;
  playerName: string;
  role: JoinableRole;
}

/**
 * Storybook client (`client/src/net`) compatibility. A socket that creates or joins a room
 * without an ack is treated as a storybook client: the server sends it `room:joined` and a
 * storybook-shaped `room:state` (see `server/src/engine/storybook.ts`).
 */
export interface RoomAdvancePayload {
  /** The storybook phase the client wants next, e.g. `opening`, `intro` or `encounter`. */
  phase: string;
}

export interface OpeningCardPayload {
  cardId: string;
}

export interface RoomQuickStartRequest {
  playerName: string;
  role: JoinableRole;
}

/** Ack for `room:create`, `room:join`, and `room:quick_start`. Keep `playerId` for later events. */
export type RoomJoinAck =
  | { ok: true; roomCode: string; playerId: string; state: GameState }
  | { ok: false; error: string };

/** Memory card slot a player fills in the opening. */
export type OpeningSlot = 'encounter' | 'boss';

export interface OpeningPickPayload {
  cardId: string;
  slot: OpeningSlot;
}

export interface CalibrationDonePayload {
  baseline: CalibrationBaseline;
}

export interface RoomErrorPayload {
  message: string;
}

export interface ServerToClientEvents {
  'clock:pong': (payload: ClockPong) => void;
  'room:state': (state: GameState) => void;
  'combat:telegraph': (payload: TelegraphPayload) => void;
  'hardware:command': (command: HardwareCommand) => void;
  /** Teammates' pose frames, relayed by the server at about `POSE_SEND_HZ`. */
  'player:pose': (frame: PoseFrame) => void;
  'player:dodge_result': (payload: DodgeResultPayload) => void;
  /** A cast the server accepted, with the server's final `power`. */
  'player:cast': (payload: CastPayload) => void;
  'combat:resolve': (resolution: RoundResolution) => void;
  'combat:twin_cast_progress': (progress: TwinCastProgress) => void;
  'narrator:line': (line: NarratorLine) => void;
  'world:image': (image: WorldImage) => void;
  'memory:cards': (cards: MemoryCard[]) => void;
  'room:error': (payload: RoomErrorPayload) => void;
  /** Storybook clients only: sent to the joining socket before its first room snapshot. */
  'room:joined': (payload: { playerId: string }) => void;
}

export interface ClientToServerEvents {
  'clock:ping': (payload: ClockPing) => void;
  'player:pose': (frame: PoseFrame) => void;
  'player:dodge_result': (payload: DodgeResultPayload) => void;
  'player:cast': (payload: CastPayload) => void;
  'hardware:event': (event: HardwareEvent) => void;
  /** Storybook clients omit the ack at runtime; they get `room:joined` / `room:error` instead. */
  'room:create': (payload: RoomCreateRequest, ack: (res: RoomJoinAck) => void) => void;
  'room:join': (payload: RoomJoinRequest, ack: (res: RoomJoinAck) => void) => void;
  /** Creates a room with the cached demo world and saved opening picks. */
  'room:quick_start': (payload: RoomQuickStartRequest, ack: (res: RoomJoinAck) => void) => void;
  'opening:pick_card': (payload: OpeningPickPayload) => void;
  'calibration:done': (payload: CalibrationDonePayload) => void;
  /** Host only. Advances lobby -> opening, and after both picks starts world generation. */
  'game:start': () => void;
  /** Storybook: requests the next phase; the server maps it onto `game:start` / `calibration:done`. */
  'room:advance': (payload: RoomAdvancePayload) => void;
  /** Storybook: keeps a card for the encounter (`opening:pick_card` slot `encounter`). */
  'opening:select_card': (payload: OpeningCardPayload) => void;
  /** Storybook: crowns a card as the boss (`opening:pick_card` slot `boss`). */
  'opening:lock_boss': (payload: OpeningCardPayload) => void;
}

// ---------------------------------------------------------------------------
// REST contract (server routes and client callers)
// ---------------------------------------------------------------------------

/** `POST /api/chat-upload` (multipart, `file` field with the Instagram JSON export). */
export interface ChatUploadResponse {
  cards: MemoryCard[];
}

/** `POST /api/transcribe` multipart text fields, sent alongside an `audio` file field. */
export interface TranscribeRequestFields {
  roomCode: string;
  playerId: string;
  element: P0ElementType;
  /** Development transcript injection; production requires MCP bearer authentication. */
  transcriptOverride?: string;
}

export interface TranscribeResponse {
  transcript: string;
  /** The incantation phrase the transcript was matched against. */
  expected: string;
  /** Share of expected words found, 0..1. */
  matchRatio: number;
  passed: boolean;
  /** True when the pass came from the mercy rule rather than the match. */
  mercy: boolean;
  /** Attempt number for this player and element in the current turn (1-based). */
  attempt: number;
  /** Power multiplier from the incantation alone (e.g. `MERCY_POWER` on mercy). */
  power: number;
}

/**
 * `POST /api/tts` JSON body. The response is either `audio/mpeg` bytes, or JSON
 * {@link TtsFallbackResponse} telling the client to speak with `speechSynthesis`.
 * Check the response `Content-Type` to tell them apart.
 */
export interface TtsRequest {
  text: string;
  speaker: 'narrator' | 'boss';
}

export interface TtsFallbackResponse {
  fallback: 'speech_synthesis';
  text: string;
}

/** `POST /api/quest-chat`: the in-app quest box that runs the Quest Master tools. */
export interface QuestChatRequest {
  prompt: string;
  hostName?: string;
}

export interface QuestChatResponse {
  reply: string;
  roomCode?: string;
  joinLink?: string;
  toolCalls: { name: string; args: unknown; result: unknown }[];
}

/** What `get_quest_status` returns over MCP and the quest box. */
export interface QuestStatus {
  roomCode: string;
  phase: GamePhase;
  hearts: number;
  maxHearts: number;
  enemyName: string | null;
  enemyHp: number;
  enemyMaxHp: number;
  wardActive: boolean;
}

// ---------------------------------------------------------------------------
// Boss agent
// ---------------------------------------------------------------------------

/** Effects the boss may trigger: a buzzer pattern or the storybook servo. */
export type BossEffectName = BuzzPattern | 'servo_open';

/** One validated tool call from the boss agent. Limits are enforced in server code. */
export type BossToolCall =
  | { name: 'choose_attack'; args: { pattern: AttackType; targets: string[] } }
  | { name: 'adjust_timing'; args: { ms: number } }
  | { name: 'raise_ward'; args: Record<string, never> }
  | { name: 'taunt'; args: { line: string } }
  | { name: 'trigger_effect'; args: { name: BossEffectName } };

/** The boss's plan for the next round, after validation and clamping. */
export interface BossPlan {
  attackType: AttackType;
  targetPlayerIds: string[];
  /** Clamped to `DEFENSE_WINDOW_MS`. */
  defenseWindowMs: number;
  raiseWard: boolean;
  /** At most `TAUNT_MAX_CHARS` characters. */
  taunt: string | null;
  effects: BossEffectName[];
  /** `agent` when Muse Spark planned it; `scripted` when the fallback did. */
  source: 'agent' | 'scripted';
}
