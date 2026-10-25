/**
 * Teammate 2 client contract.
 * Mirrors docs/team-plan.md Phase 0 types. When Teammate 1 publishes
 * packages/shared, re-export from there and delete the duplicates.
 * Agents 2A/2B/2C must import from this file. Do not invent parallel types.
 */

export type ElementP0 = 'ember' | 'frost' | 'bloom';
export type Element = ElementP0 | 'storm' | 'moon' | 'starlight';
export type AttackTypeP0 = 'low_sweep' | 'high_swing' | 'projectile';
export type AttackType = AttackTypeP0 | 'ground_wave' | 'stare';
export type Gesture = 'swipe' | 'thrust';
export type PlayerRole = 'spellbearer' | 'partner';

export type RoomPhase =
  | 'lobby'
  | 'upload'
  | 'opening'
  | 'generating'
  | 'intro'
  | 'calibrating'
  | 'encounter'
  | 'boss'
  | 'ending'
  | 'defeat';

export type CombatPhase =
  | 'idle'
  | 'telegraph'
  | 'defense'
  | 'return'
  | 'team_turn'
  | 'resolve';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface MemoryCard {
  id: string;
  quote: string;
  date: string;
  people: string[];
  mood: string;
  color: string;
}

export interface Encounter {
  memory: string;
  name: string;
  template: 'charger' | 'caster' | 'swarm' | 'guardian';
  attacks: AttackType[];
  weakness: ElementP0;
  tier: 1 | 2 | 3;
  lines: string[];
  art_prompt: string;
  artUrl?: string;
  hp?: number;
  maxHp?: number;
}

export interface Boss extends Encounter {
  ward: 'twin_cast';
  wardUp?: boolean;
}

export interface WorldSchema {
  title: string;
  intro: string;
  incantations: Record<ElementP0, string> & Partial<Record<Element, string>>;
  encounters: Encounter[];
  boss: Boss;
  coverArtUrl?: string;
  ending?: string;
}

export interface PlayerPublic {
  id: string;
  name: string;
  role: PlayerRole;
  inZone: boolean;
  connected: boolean;
  selectedElement: ElementP0;
  elementLocked: boolean;
  fistCharged: boolean;
  lastGesture?: Gesture;
}

export interface GameState {
  roomCode: string;
  phase: RoomPhase;
  combatPhase: CombatPhase;
  teamHearts: number;
  maxTeamHearts: number;
  players: PlayerPublic[];
  encounter?: Encounter;
  boss?: Boss;
  wardUp: boolean;
  twinCastMeter: number;
  currentRound: number;
  narratorCaption: string;
  tooLoud: boolean;
  selectedMemoryIds: string[];
  bossMemoryId?: string;
  world?: WorldSchema;
  memoryCards: MemoryCard[];
  quickStart: boolean;
}

export interface TelegraphEvent {
  attackId: string;
  attackType: AttackTypeP0;
  targetPlayerIds: string[];
  impactServerMs: number;
  windowMs: number;
  narratorHint: string;
}

export interface PoseEvent {
  playerId: string;
  landmarks: NormalizedLandmark[];
  inZone: boolean;
}

export interface DodgeResult {
  playerId: string;
  attackId: string;
  dodged: boolean;
  parried: boolean;
  serverTimestampMs: number;
}

export interface CastEvent {
  playerId: string;
  element: ElementP0;
  gesture: Gesture;
  transcript: string;
  power: number;
  serverTimestampMs: number;
}

export interface HardwareEvent {
  dialSlot: 0 | 1 | 2;
  buttonPressed: boolean;
  fistCharged: boolean;
  parryTriggered: boolean;
  colorToken?: 'ember' | 'frost' | 'bloom' | 'yellow' | null;
  noiseLevel: number;
  armed: boolean;
}

export interface HardwareCommand {
  type: 'buzz' | 'servo';
  pattern?: 'tick' | 'cast' | 'fizzle' | 'hit';
  servoOpen?: boolean;
}

export interface ClockPing {
  clientSendMs: number;
}

export interface ClockPong {
  clientSendMs: number;
  serverRecvMs: number;
  serverSendMs: number;
}

export interface NarratorLine {
  text: string;
  audioUrl?: string | null;
  useBrowserTts?: boolean;
}

export interface ServerToClientEvents {
  'clock:pong': ClockPong;
  'room:state': GameState;
  'combat:telegraph': TelegraphEvent;
  'player:pose': PoseEvent;
  'player:dodge_result': DodgeResult;
  'player:cast': CastEvent;
  'hardware:event': HardwareEvent;
  'hardware:command': HardwareCommand;
  'narrator:line': NarratorLine;
  'room:error': { message: string };
}

export interface ClientToServerEvents {
  'clock:ping': ClockPing;
  'room:create': { playerName: string; role: PlayerRole };
  'room:join': { code: string; playerName: string; role: PlayerRole };
  'room:quick_start': { playerName: string; role: PlayerRole };
  'player:pose': { landmarks: NormalizedLandmark[]; inZone: boolean };
  'player:dodge_result': Omit<DodgeResult, 'playerId'>;
  'player:cast': Omit<CastEvent, 'playerId'>;
  'hardware:event': HardwareEvent;
  'opening:select_card': { cardId: string };
  'opening:lock_boss': { cardId: string };
  'quest:prompt': { prompt: string };
}

export const ROUND_TIMINGS = {
  telegraphMs: 2000,
  defenseMs: 1500,
  returnMs: 3000,
  teamTurnMs: 8000,
  resolveMs: 1500,
} as const;

export const TWIN_CAST_WINDOW_MS = 3000;
export const CLOCK_SYNC_INTERVAL_MS = 10_000;
export const MAX_TEAM_HEARTS = 5;
export const ELEMENTS_P0: readonly ElementP0[] = ['ember', 'frost', 'bloom'];
export const ELEMENT_COLORS: Record<ElementP0, string> = {
  ember: '#e85d04',
  frost: '#4cc9f0',
  bloom: '#80b918',
};
export const NOISE_LOUD_THRESHOLD = 400;
export const DEFAULT_SERVER_URL = 'http://localhost:3001';
