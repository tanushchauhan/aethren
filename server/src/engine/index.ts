/**
 * Authoritative rooms and combat (Agent 1A).
 *
 * Exports `createRoomService(deps)` (implements `EngineRoomService` from `../contracts.ts`).
 * `createEngine(deps, options)` is the same service with an injectable clock, RNG, time
 * scale and logger for tests and the two-laptop sim.
 *
 * Files:
 * - `phases.ts`    one room's state machine (opening -> intro -> calibration -> rounds -> ending)
 * - `combat.ts`    pure rules: HP, element effects, plan clamping
 * - `twin-cast.ts` pure Twin Cast detector
 * - `bot.ts`       bot seat decisions
 * - `rooms.ts`     room codes and seat claiming
 * - `clock.ts`     injectable clock and timer groups
 */
import type {
  ElementType,
  GameState,
  JoinableRole,
  P0ElementType,
  PlayerRole,
  QuestDifficulty,
  QuestStatus,
  RoomJoinAck,
  TranscribeResponse,
} from '@once-upon/shared';
import { config } from '../config';
import type {
  CreateRoomOptions,
  CreateRoomResult,
  EngineDeps,
  EngineRoomService,
  GameSocket,
} from '../contracts';
import { systemClock, type Clock } from './clock';
import { GameRoom, type EngineRuntime } from './phases';
import { generateCode, normalizeCode, toJoinableRole } from './rooms';
import { storybookRoom } from './storybook';

export interface EngineOptions {
  clock?: Clock;
  rng?: () => number;
  /**
   * Multiplies every phase duration and engine timeout. Defaults to the `ENGINE_TIME_SCALE`
   * env var (sim only), else 1. Server-time windows (Twin Cast, incantation freshness) never scale.
   */
  timeScale?: number;
  log?: (msg: string) => void;
}

/** The engine plus a test hook into a room. */
export interface Engine extends EngineRoomService {
  /** Internal room object (tests and the sim only). */
  debugRoom(roomCode: string): GameRoom | undefined;
}

/** Rooms nobody has been connected to for this long are dropped on the next `createRoom`. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000;

const DIFFICULTIES: readonly QuestDifficulty[] = ['easy', 'normal', 'hard'];
const ROLES: readonly PlayerRole[] = ['spellbearer', 'partner', 'bot'];

function envTimeScale(): number {
  const n = Number.parseFloat(process.env.ENGINE_TIME_SCALE ?? '');
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : 1;
}

function defaultLog(msg: string): void {
  if (process.env.ENGINE_LOG) console.log(msg);
}

export function createRoomService(deps: EngineDeps): EngineRoomService {
  return createEngine(deps);
}

export function createEngine(deps: EngineDeps, options: EngineOptions = {}): Engine {
  const rt: EngineRuntime = {
    io: deps.io,
    ai: deps.ai,
    boss: deps.boss,
    clock: options.clock ?? systemClock,
    rng: options.rng ?? Math.random,
    timeScale: options.timeScale ?? envTimeScale(),
    log: options.log ?? defaultLog,
  };
  const rooms = new Map<string, GameRoom>();
  /** Live sockets by ID, so a seat taken over by a new tab can unhook the old socket. */
  const sockets = new Map<string, GameSocket>();

  function getRoom(code: string | undefined): GameRoom | undefined {
    return code ? rooms.get(normalizeCode(code)) : undefined;
  }

  function sweep(): void {
    const now = rt.clock.now();
    for (const [code, room] of rooms) {
      if (room.emptySince !== null && !room.hasConnectedHumans() && now - room.emptySince > ROOM_IDLE_TTL_MS) {
        room.dispose();
        rooms.delete(code);
      }
    }
  }

  async function createRoom(opts: CreateRoomOptions): Promise<CreateRoomResult> {
    if (!opts || typeof opts !== 'object') throw new Error('createRoom options are required');
    if (typeof opts.hostName !== 'string') throw new Error('hostName is required');
    if (!ROLES.includes(opts.hostRole)) throw new Error(`hostRole must be one of ${ROLES.join(', ')}`);
    if (opts.difficulty !== undefined && !DIFFICULTIES.includes(opts.difficulty)) {
      throw new Error(`difficulty must be one of ${DIFFICULTIES.join(', ')}`);
    }
    if (opts.playerNames !== undefined && !Array.isArray(opts.playerNames)) {
      throw new Error('playerNames must be an array');
    }
    sweep();
    const roomCode = generateCode((c) => rooms.has(c));
    const room = new GameRoom(rt, {
      roomCode,
      hostName: opts.hostName,
      hostRole: toJoinableRole(opts.hostRole),
      difficulty: opts.difficulty ?? 'normal',
      encounterCardId: typeof opts.encounterCardId === 'string' ? opts.encounterCardId : undefined,
      playerNames: (opts.playerNames ?? []).filter((n): n is string => typeof n === 'string'),
      quickStart: Boolean(opts.quickStart),
    });
    rooms.set(roomCode, room);
    rt.log(`[engine ${roomCode}] created (${opts.quickStart ? 'quick start' : opts.difficulty ?? 'normal'})`);
    return { roomCode, hostPlayerId: room.hostPlayerId };
  }

  function leaveCurrent(socket: GameSocket): void {
    const { roomCode, playerId } = socket.data;
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
    if (!roomCode) return;
    void socket.leave(roomCode);
    void socket.leave(storybookRoom(roomCode));
    if (playerId) getRoom(roomCode)?.detach(playerId, socket.id);
  }

  /** Claims a reserved seat with a matching name, or takes a free seat. */
  function seatSocket(socket: GameSocket, room: GameRoom, name: string, role: JoinableRole): RoomJoinAck {
    if (room.singleplayer && name !== room.state.players.find(p => p.id === room.hostPlayerId)?.name) {
      return { ok: false, error: 'This is a singleplayer adventure. Create an online adventure to play together.' };
    }
    const claim = room.claim(name, toJoinableRole(role));
    if (!claim.ok) return { ok: false, error: claim.error };
    const seat = claim.seat;
    const code = room.state.roomCode;
    const alreadyHere = seat.socketId === socket.id && socket.data.roomCode === code;
    if (!alreadyHere) {
      if (socket.data.roomCode) leaveCurrent(socket);
      const previous = room.attach(seat, socket.id);
      if (previous) {
        const old = sockets.get(previous);
        if (old && old.data.playerId === seat.player.id) {
          old.data.roomCode = undefined;
          old.data.playerId = undefined;
          void old.leave(code);
          void old.leave(storybookRoom(code));
        }
      }
    }
    socket.data.roomCode = code;
    socket.data.playerId = seat.player.id;
    // Storybook clients learn their seat first, then get state in their own shape.
    if (socket.data.storybook) {
      socket.emit('room:joined', { playerId: seat.player.id });
      room.holdIntroForNarration = true;
    }
    void socket.join(socket.data.storybook ? storybookRoom(code) : code);
    room.broadcast();
    if (room.state.phase === 'opening') socket.emit('memory:cards', room.state.memoryCards ?? []);
    return { ok: true, roomCode: code, playerId: seat.player.id, state: room.snapshot() };
  }

  /** Wraps a handler so a malformed payload can never take the server down. */
  function safe<A extends unknown[]>(fn: (...args: A) => void | Promise<void>): (...args: A) => void {
    return (...args: A) => {
      try {
        const out = fn(...args);
        if (out instanceof Promise) out.catch((err: unknown) => rt.log(`[engine] handler failed: ${String(err)}`));
      } catch (err) {
        rt.log(`[engine] handler failed: ${(err as Error).stack ?? String(err)}`);
      }
    };
  }

  function registerSocketHandlers(socket: GameSocket): void {
    sockets.set(socket.id, socket);
    const currentRoom = () => getRoom(socket.data.roomCode);
    /**
     * Shared-contract clients pass an ack. Storybook clients (`client/src/net`) do not: mark
     * the socket and answer with `room:error` instead, since `room:joined` follows a success.
     */
    const replyTo = (ack: unknown): ((res: RoomJoinAck) => void) => {
      if (typeof ack === 'function') return ack as (res: RoomJoinAck) => void;
      socket.data.storybook = true;
      return (res) => {
        if (!res.ok) socket.emit('room:error', { message: res.error });
      };
    };

    socket.on(
      'clock:ping',
      safe((payload) => {
        const serverRecvMs = rt.clock.now();
        socket.emit('clock:pong', {
          clientSendMs: typeof payload?.clientSendMs === 'number' ? payload.clientSendMs : 0,
          serverRecvMs,
          serverSendMs: rt.clock.now(),
        });
      }),
    );

    socket.on(
      'room:create',
      safe(async (payload, rawAck) => {
        const ack = replyTo(rawAck);
        if (!payload?.playerName) return ack({ ok: false, error: 'playerName is required' });
        try {
          const { roomCode, hostPlayerId } = await createRoom({
            hostName: payload.playerName,
            hostRole: toJoinableRole(payload.role),
            difficulty: DIFFICULTIES.includes(payload.difficulty as QuestDifficulty) ? payload.difficulty : undefined,
          });
          const room = rooms.get(roomCode)!;
          room.singleplayer = payload.mode === 'singleplayer';
          const host = room.state.players.find((p) => p.id === hostPlayerId)!;
          ack(seatSocket(socket, room, host.name, toJoinableRole(payload.role)));
        } catch (err) {
          ack({ ok: false, error: (err as Error).message });
        }
      }),
    );

    socket.on(
      'room:quick_start',
      safe(async (payload, rawAck) => {
        const ack = replyTo(rawAck);
        if (!payload?.playerName) return ack({ ok: false, error: 'playerName is required' });
        try {
          const { roomCode } = await createRoom({
            hostName: payload.playerName,
            hostRole: toJoinableRole(payload.role),
            quickStart: true,
          });
          ack(seatSocket(socket, rooms.get(roomCode)!, payload.playerName, toJoinableRole(payload.role)));
        } catch (err) {
          ack({ ok: false, error: (err as Error).message });
        }
      }),
    );

    socket.on(
      'room:join',
      safe((payload, rawAck) => {
        const ack = replyTo(rawAck);
        const code = typeof payload?.roomCode === 'string' ? payload.roomCode : payload?.code;
        const room = typeof code === 'string' ? getRoom(code) : undefined;
        if (!room) return ack({ ok: false, error: 'Room not found' });
        if (!payload.playerName) return ack({ ok: false, error: 'playerName is required' });
        ack(seatSocket(socket, room, payload.playerName, toJoinableRole(payload.role)));
      }),
    );

    socket.on(
      'player:pose',
      safe((frame) => {
        const room = currentRoom();
        const playerId = socket.data.playerId;
        if (!room || !playerId || !frame || typeof frame !== 'object') return;
        room.pose(playerId, frame);
        const code = room.state.roomCode;
        socket.to([code, storybookRoom(code)]).emit('player:pose', { ...frame, playerId });
        // Storybook clients have no calibration event: standing in the zone counts.
        if (socket.data.storybook && frame.inZone === true && room.state.phase === 'calibration') {
          room.calibrationDone(playerId);
        }
      }),
    );

    socket.on(
      'player:dodge_result',
      safe((payload) => {
        currentRoom()?.dodgeReport(socket.data.playerId, payload ?? {});
      }),
    );

    socket.on(
      'player:cast',
      safe((payload) => {
        currentRoom()?.cast(socket.data.playerId, payload ?? {});
      }),
    );

    socket.on(
      'hardware:event',
      safe((event) => {
        currentRoom()?.hardwareEvent(socket.data.playerId, event);
      }),
    );

    socket.on(
      'opening:pick_card',
      safe((payload) => {
        currentRoom()?.pickCard(payload?.cardId, payload?.slot);
      }),
    );

    socket.on(
      'opening:select_card',
      safe((payload) => {
        currentRoom()?.storybookKeep(payload?.cardId);
      }),
    );

    socket.on(
      'opening:lock_boss',
      safe((payload) => {
        currentRoom()?.storybookCrown(payload?.cardId);
      }),
    );

    socket.on(
      'room:advance',
      safe((payload) => {
        const room = currentRoom();
        const playerId = socket.data.playerId;
        const wanted = payload?.phase;
        if (!room || !playerId || typeof wanted !== 'string') return;
        // The engine owns every transition; a request only maps onto an existing action.
        const phase = room.state.phase;
        if (phase === 'lobby' && (wanted === 'opening' || wanted === 'intro' || wanted === 'calibrating')) {
          room.start(playerId);
        } else if (phase === 'opening' && (wanted === 'intro' || wanted === 'generating')) {
          room.start(playerId);
        } else if (phase === 'intro' && wanted === 'calibrating') {
          // Sent when the intro narration ends or a player presses Continue.
          room.continueIntro();
        } else if (phase === 'calibration' && (wanted === 'encounter' || wanted === 'boss')) {
          room.calibrationDone(playerId);
        }
      }),
    );

    socket.on(
      'calibration:done',
      safe(() => {
        currentRoom()?.calibrationDone(socket.data.playerId);
      }),
    );

    socket.on(
      'game:start',
      safe(() => {
        currentRoom()?.start(socket.data.playerId);
      }),
    );

    socket.on(
      'disconnect',
      safe(() => {
        sockets.delete(socket.id);
        leaveCurrent(socket);
      }),
    );
  }

  return {
    createRoom,
    getState: (code): GameState | null => {
      const room = getRoom(code);
      return room ? structuredClone(room.snapshot()) : null;
    },
    getQuestStatus: (code): QuestStatus | null => getRoom(code)?.questStatus() ?? null,
    getIncantation: (code, element: ElementType) => getRoom(code)?.state.world?.incantations?.[element] ?? null,
    buildJoinLink: (code, playerName) => {
      const url = new URL(config.publicBaseUrl);
      url.searchParams.set('room', normalizeCode(code));
      if (playerName) url.searchParams.set('name', playerName);
      return url.toString();
    },
    recordIncantation: (code, playerId, element: P0ElementType, result: TranscribeResponse) => {
      getRoom(code)?.recordIncantation(playerId, element, result);
    },
    registerSocketHandlers,
    dispose: () => {
      for (const room of rooms.values()) room.dispose();
      rooms.clear();
      sockets.clear();
    },
    debugRoom: (code) => getRoom(code),
  };
}
