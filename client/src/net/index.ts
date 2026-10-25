export { useGameStore } from './store';
export type { GameStore, GameStoreActions, GameStoreState } from './store';

export { getServerNow, getServerTimeOffsetMs } from './clock';

export { connect, connectedSocket, disconnect, getSocket } from './socket';
export type { GameSocket } from './socket';

export { MockToolbar } from './MockToolbar';

export {
  CLOCK_SYNC_INTERVAL_MS,
  DEFAULT_SERVER_URL,
  ELEMENT_COLORS,
  ELEMENTS_P0,
  MAX_TEAM_HEARTS,
  NOISE_LOUD_THRESHOLD,
  ROUND_TIMINGS,
  TWIN_CAST_WINDOW_MS,
} from './contract';

export type {
  AttackType,
  AttackTypeP0,
  Boss,
  CastEvent,
  ClientToServerEvents,
  ClockPing,
  ClockPong,
  CombatPhase,
  ConnectionStatus,
  DodgeResult,
  Element,
  ElementP0,
  Encounter,
  GameState,
  Gesture,
  HardwareCommand,
  HardwareEvent,
  MemoryCard,
  NarratorLine,
  NormalizedLandmark,
  PlayerPublic,
  PlayerRole,
  PoseEvent,
  RoomPhase,
  ServerToClientEvents,
  TelegraphEvent,
  WorldSchema,
} from './contract';
