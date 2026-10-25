/**
 * Server-internal contract between `index.ts` and the combat engine.
 *
 * `engine/` implements {@link RoomService}: rooms, sockets, clock sync and the combat loop.
 * Content is bundled (`content/`) and the boss follows the engine's scripted attack cycle, so
 * the engine needs no external services.
 */
import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  GameState,
  PlayerRole,
  QuestDifficulty,
  ServerToClientEvents,
} from '@aethren/shared';

// ---------------------------------------------------------------------------
// Socket.IO typing
// ---------------------------------------------------------------------------

/** Server-to-server events. Unused (single instance), kept for Socket.IO's generics. */
export type InterServerEvents = Record<string, never>;

/**
 * Per-socket data the engine sets after a successful `room:create` /
 * `room:join`. Read it in handlers instead of trusting `playerId` in payloads.
 */
export interface SocketData {
  roomCode?: string;
  playerId?: string;
}

export type GameServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// ---------------------------------------------------------------------------
// RoomService (engine/)
// ---------------------------------------------------------------------------

export interface CreateRoomOptions {
  /** Name of the creating player. Their seat is reserved with `connected: false` until a socket claims it. */
  hostName: string;
  hostRole: PlayerRole;
  /** Defaults to `normal`. Scales enemy HP via `DIFFICULTY_HP_MULTIPLIER`. */
  difficulty?: QuestDifficulty;
  /** Other players to reserve seats for. The first extra name takes the role the host did not; further names get `partner`. */
  playerNames?: string[];
}

export interface CreateRoomResult {
  roomCode: string;
  /** Reserved seat ID for the host. A socket `room:join` with the same name claims it. */
  hostPlayerId: string;
}

/**
 * Authoritative room state. Owns every `GameState`, the round timer, hearts, damage,
 * Twin Cast, disconnect pause and bot fallback.
 *
 * Seat claiming: a `room:join` whose `playerName` matches a reserved, disconnected seat
 * (case-insensitive) claims that seat; otherwise the engine adds a new seat if one is free.
 */
export interface RoomService {
  /** Creates a room in `lobby`. Rejects only on invalid input. */
  createRoom(opts: CreateRoomOptions): Promise<CreateRoomResult>;

  /** Current snapshot, or `null` for an unknown room code (codes are case-insensitive). */
  getState(roomCode: string): GameState | null;
}

/** What `engine/` exports in addition to {@link RoomService}. */
export interface EngineRoomService extends RoomService {
  /** Wire every client event for one socket. Called once per connection by `index.ts`. */
  registerSocketHandlers(socket: GameSocket): void;
  /** Stop timers (tests and graceful shutdown). */
  dispose(): void;
}

export interface EngineDeps {
  io: GameServer;
}

/** A combat moment to narrate. `kind` is open-ended; the known kinds have prewritten lines in `engine/narration.ts`. */
export interface NarrationEvent {
  kind:
    | 'intro'
    | 'telegraph'
    | 'dodge'
    | 'hit'
    | 'parry'
    | 'cast'
    | 'fizzle'
    | 'twin_cast'
    | 'ward_raised'
    | 'ward_shattered'
    | 'enemy_defeated'
    | 'boss_learned'
    | 'victory'
    | 'defeat'
    | (string & {});
  /** Free-form facts for the line, e.g. `{ playerName, element, enemyName, attackType }`. */
  context: Record<string, unknown>;
}

/** Everything a route module can reach. Built in `index.ts` once the room service exists. */
export interface ServerContext {
  io: GameServer;
  rooms: RoomService;
}
