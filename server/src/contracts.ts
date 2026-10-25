/**
 * Server-internal contract between the three server modules. ORCHESTRATOR-OWNED.
 *
 * - `engine/` (Agent 1A) implements {@link RoomService}: rooms, sockets, clock sync, combat loop.
 * - `ai/`     (Agent 1B) implements {@link AiService}: Muse Spark, Transcribe, Image, TTS, cache.
 * - `agents/` (Agent 1C) implements {@link BossPlanner} and the `/mcp` + `/api/quest-chat` routes.
 *
 * Rules for the parallel agents:
 * 1. A module never imports another module's files. Cross-module calls go through these
 *    interfaces, handed in via factory arguments or {@link ServerContext}.
 * 2. Everything here, `config.ts`, `index.ts`, `package.json`, and `packages/shared` are
 *    read-only for module agents. Ask the orchestrator for a contract change.
 * 3. Every AI-backed method must degrade gracefully: if a provider key is missing, a call
 *    times out, or the reply is invalid, return a fallback. Methods documented as
 *    "never rejects" must not throw or reject.
 *
 * Construction order in `index.ts` (resolves the rooms <-> MCP cycle):
 *   ai = createAiService()
 *   boss = createBossPlanner(ai)
 *   rooms = createRoomService({ io, ai, boss })
 *   ctx = { io, rooms, ai, boss }
 *   registerAiRoutes(app, ctx); registerAgentRoutes(app, ctx)
 *   io.on('connection', rooms.registerSocketHandlers)
 */
import type { Server, Socket } from 'socket.io';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
import type {
  AttackType,
  BossPlan,
  BossSchema,
  ClientToServerEvents,
  ElementType,
  EncounterSchema,
  GameState,
  MemoryCard,
  P0ElementType,
  PlayerRole,
  QuestDifficulty,
  QuestStatus,
  ServerToClientEvents,
  TranscribeResponse,
  WorldImage,
  WorldSchema,
} from '@once-upon/shared';

// ---------------------------------------------------------------------------
// Socket.IO typing
// ---------------------------------------------------------------------------

/** Server-to-server events. Unused (single instance), kept for Socket.IO's generics. */
export type InterServerEvents = Record<string, never>;

/**
 * Per-socket data the engine sets after a successful `room:create` / `room:join` /
 * `room:quick_start`. Read it in handlers instead of trusting `playerId` in payloads.
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
// RoomService (engine/, Agent 1A)
// ---------------------------------------------------------------------------

export interface CreateRoomOptions {
  /** Name of the creating player. Their seat is reserved with `connected: false` until a socket claims it. */
  hostName: string;
  hostRole: PlayerRole;
  /** Defaults to `normal`. Scales enemy HP via `DIFFICULTY_HP_MULTIPLIER`. */
  difficulty?: QuestDifficulty;
  /** Pre-picks the encounter memory card (MCP `create_quest`). The boss card is still picked in the opening. */
  encounterCardId?: string;
  /**
   * Other players to reserve seats for (MCP `create_quest` / quest box). The first extra name
   * takes the role the host did not; further names get `partner`.
   */
  playerNames?: string[];
  /** Load the cached demo world and saved picks, skipping world generation (`room:quick_start`). */
  quickStart?: boolean;
}

export interface CreateRoomResult {
  roomCode: string;
  /** Reserved seat ID for the host. A socket `room:join` with the same name claims it. */
  hostPlayerId: string;
}

/**
 * Authoritative room state. Owns every `GameState`, the round timer, hearts, damage,
 * Twin Cast, disconnect pause and bot fallback. The engine calls {@link AiService} and
 * {@link BossPlanner} itself (no callbacks back into it are needed).
 *
 * Seat claiming: rooms created over MCP / quest box have reserved seats for named players.
 * A `room:join` whose `playerName` matches a reserved, disconnected seat (case-insensitive)
 * claims that seat; otherwise the engine adds a new seat if one is free.
 */
export interface RoomService {
  /** Creates a room in `lobby` (or ready to start, for `quickStart`). Rejects only on invalid input. */
  createRoom(opts: CreateRoomOptions): Promise<CreateRoomResult>;

  /** Current snapshot, or `null` for an unknown room code (codes are case-insensitive). */
  getState(roomCode: string): GameState | null;

  /** Summary for MCP `get_quest_status` and the quest box. `null` for an unknown room. */
  getQuestStatus(roomCode: string): QuestStatus | null;

  /** The active world's phrase for an element, or `null` when the room or world is missing. */
  getIncantation(roomCode: string, element: ElementType): string | null;

  /**
   * Full URL a player opens to join, e.g. `${publicBaseUrl}/?room=ABCD&name=Dev`.
   * The client reads `room` and `name` from the query string.
   */
  buildJoinLink(roomCode: string, playerName?: string): string;

  /**
   * Called by the `ai/` transcribe route after judging an incantation, so the engine can
   * accept a following `player:cast` only if that player passed this team turn, and use
   * `result.power` as the incantation part of the cast's power. No-op for unknown rooms.
   */
  recordIncantation(
    roomCode: string,
    playerId: string,
    element: P0ElementType,
    result: TranscribeResponse,
  ): void;
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
  ai: AiService;
  boss: BossPlanner;
}

// ---------------------------------------------------------------------------
// AiService (ai/, Agent 1B)
// ---------------------------------------------------------------------------

export interface WorldGenInput {
  /** Every card offered in the opening (gives Spark context for incantations). */
  cards: MemoryCard[];
  encounterCard: MemoryCard | null;
  bossCard: MemoryCard | null;
  playerNames: string[];
  difficulty: QuestDifficulty;
}

/** Opening picks used by quick start, referring to IDs in {@link AiService.listMemoryCards}. */
export interface CachedPicks {
  encounterCardId: string;
  bossCardId: string;
}

/**
 * A combat moment to narrate. `kind` is open-ended so the engine can add moments without a
 * contract change; the known kinds below get dedicated prewritten fallbacks.
 */
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

/** A Muse Spark chat request. Mirrors the OpenAI chat-completions fields agents need. */
export interface MuseChatRequest {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
  responseFormat?: ChatCompletionCreateParamsNonStreaming['response_format'];
  temperature?: number;
  maxTokens?: number;
  /** Defaults to `config.aiTimeoutMs`. */
  timeoutMs?: number;
  /** Aborts the request early (e.g. the boss deadline passed). */
  signal?: AbortSignal;
}

/**
 * Muse Spark access for other modules (the boss agent and quest box use it with tools).
 * Lives on {@link AiService} so only `ai/` constructs the OpenAI-compatible client.
 */
export interface MuseChat {
  /** True when Spark is configured. When false, `complete` resolves `null` immediately. */
  readonly available: boolean;
  /**
   * One non-streaming chat completion. Never rejects: resolves `null` when Spark is
   * unavailable, times out, is aborted, or errors. Callers validate tool-call arguments.
   */
  complete(req: MuseChatRequest): Promise<ChatCompletionMessage | null>;
}

export interface AiService {
  /** Latest cards from `POST /api/chat-upload`, or the bundled fixtures before any upload. */
  listMemoryCards(): MemoryCard[];

  /**
   * Builds the world with Muse Spark structured output, clamped and defaulted with zod.
   * Never rejects: on a missing key, `config.useCachedWorld`, timeout, or bad JSON it
   * resolves {@link getCachedWorld}.
   */
  generateWorld(input: WorldGenInput): Promise<WorldSchema>;

  /** The bundled `ai/cached-demo-world.json`. Synchronous and always valid. */
  getCachedWorld(): WorldSchema;

  /** Saved opening picks that go with the cached world (quick start). */
  getCachedPicks(): CachedPicks;

  /**
   * Fires the cover, monster and boss image calls in parallel and calls `onImage` as each
   * resolves (cached/static images when Muse Image is unavailable). Never rejects; resolves
   * once every image has either arrived or failed.
   */
  generateImages(world: WorldSchema, onImage: (img: WorldImage) => void): Promise<void>;

  /**
   * One short Narrator line (<= `TAUNT_MAX_CHARS`). Fast: races Muse Spark against a short
   * timeout and falls back to prewritten lines. Never rejects.
   */
  narrate(event: NarrationEvent): Promise<string>;

  /** Muse Spark chat access with tool calling, for `agents/`. */
  muse: MuseChat;
}

// ---------------------------------------------------------------------------
// BossPlanner (agents/, Agent 1C)
// ---------------------------------------------------------------------------

/** One defense outcome, as recorded by the engine from `player:dodge_result`. */
export interface DodgeHistoryEntry {
  roundIndex: number;
  attackType: AttackType;
  dodged: boolean;
  parried: boolean;
  /** Which way the player dodged, if the engine knows (from the last pose action). */
  direction?: 'left' | 'right' | 'down' | null;
}

export interface BossPlannerInput {
  roomCode: string;
  /** The enemy being planned for: an encounter or the boss. */
  enemy: EncounterSchema | BossSchema;
  isBoss: boolean;
  enemyHp: number;
  enemyMaxHp: number;
  wardActive: boolean;
  /** `raise_ward` is allowed once per phase; true when it was already used. */
  wardRaisedThisPhase: boolean;
  hearts: number;
  maxHearts: number;
  difficulty: QuestDifficulty;
  /** Seats in the room, including bots. Targets must come from these IDs. */
  players: { id: string; name: string; role: PlayerRole }[];
  /** Recent outcomes per player ID, newest last (engine keeps about the last 6). */
  dodgeHistory: Record<string, DodgeHistoryEntry[]>;
  /** Elements cast recently by the team, newest last. */
  recentElements: P0ElementType[];
  /** The round being planned (0-based). */
  roundIndex: number;
}

export interface BossPlanner {
  /**
   * Plans the next round. Always resolves within `deadlineMs` (use `BOSS_AGENT_DEADLINE_MS`):
   * if Muse Spark is unavailable, slow, or returns invalid tool calls, it resolves the
   * scripted cycle through `enemy.attacks` with `source: 'scripted'`. Never rejects.
   *
   * The returned plan is already validated: `attackType` is in `enemy.attacks`, targets are
   * player IDs from the input, `defenseWindowMs` is inside `DEFENSE_WINDOW_MS`, `raiseWard`
   * only when `isBoss`, HP < `WARD_HP_RATIO`, and not `wardRaisedThisPhase`, and `taunt` is
   * at most `TAUNT_MAX_CHARS`. The engine may still re-check.
   */
  planNextRound(input: BossPlannerInput, deadlineMs: number): Promise<BossPlan>;
}

// ---------------------------------------------------------------------------
// Context handed to route registrars
// ---------------------------------------------------------------------------

/** Everything a route module can reach. Built in `index.ts` after all services exist. */
export interface ServerContext {
  io: GameServer;
  rooms: RoomService;
  ai: AiService;
  boss: BossPlanner;
}
