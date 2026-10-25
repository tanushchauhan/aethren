/**
 * Authoritative rooms and combat (Agent 1A). STUB: replace freely, keeping the exported signatures.
 *
 * Exports `createRoomService(deps)` (implements `EngineRoomService` from `../contracts.ts`).
 * The stub supports room create / join / quick start, clock sync, pose relay and opening
 * picks, so client teams can connect today. There is no combat loop yet.
 */
import { randomUUID } from 'node:crypto';
import { ROOM_CODE_LENGTH, TEAM_HEARTS_P0 } from '@once-upon/shared';
import type {
  ElementType,
  GameState,
  JoinableRole,
  PlayerRole,
  PlayerState,
  QuestStatus,
  RoomJoinAck,
} from '@once-upon/shared';
import { config } from '../config';
import type {
  CreateRoomOptions,
  CreateRoomResult,
  EngineDeps,
  EngineRoomService,
  GameSocket,
} from '../contracts';

/** Letters that are hard to confuse when read aloud or typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_SEATS = 2;

interface Room {
  state: GameState;
  hostPlayerId: string;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function newPlayer(name: string, role: PlayerRole): PlayerState {
  return {
    id: randomUUID(),
    name: name.trim() || 'Player',
    role,
    connected: false,
    inZone: false,
    canCast: true,
    selectedElement: null,
    fistCharged: false,
  };
}

export function createRoomService(deps: EngineDeps): EngineRoomService {
  const { io, ai } = deps;
  const rooms = new Map<string, Room>();

  function generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!rooms.has(code)) return code;
    }
  }

  function snapshot(room: Room): GameState {
    room.state.serverTimestampMs = Date.now();
    return room.state;
  }

  function broadcast(room: Room): void {
    io.to(room.state.roomCode).emit('room:state', snapshot(room));
  }

  function getRoom(code: string): Room | undefined {
    return rooms.get(normalizeCode(code));
  }

  async function createRoom(opts: CreateRoomOptions): Promise<CreateRoomResult> {
    const roomCode = generateCode();
    const host = newPlayer(opts.hostName, opts.hostRole);
    const players = [host];
    const otherRole: PlayerRole = opts.hostRole === 'spellbearer' ? 'partner' : 'spellbearer';
    (opts.playerNames ?? []).forEach((name, i) => {
      if (players.length < MAX_SEATS) players.push(newPlayer(name, i === 0 ? otherRole : 'partner'));
    });

    const picks = opts.quickStart
      ? { ...ai.getCachedPicks() }
      : { encounterCardId: opts.encounterCardId ?? null, bossCardId: null };
    const world = opts.quickStart ? ai.getCachedWorld() : null;

    const state: GameState = {
      roomCode,
      phase: 'lobby',
      hearts: TEAM_HEARTS_P0,
      maxHearts: TEAM_HEARTS_P0,
      wardActive: false,
      wardSpell: null,
      players,
      world,
      currentEncounter: world?.encounters[0] ?? null,
      fightingBoss: false,
      enemyHp: 0,
      enemyMaxHp: 0,
      roundIndex: 0,
      serverTimestampMs: Date.now(),
      memoryCards: ai.listMemoryCards(),
      picks,
      images: {},
      paused: false,
      lastResolution: null,
    };
    rooms.set(roomCode, { state, hostPlayerId: host.id });
    return { roomCode, hostPlayerId: host.id };
  }

  /** Claims a reserved seat with a matching name, or takes a free seat. */
  function seatSocket(socket: GameSocket, room: Room, name: string, role: JoinableRole): RoomJoinAck {
    const wanted = name.trim().toLowerCase();
    let player = room.state.players.find((p) => !p.connected && p.name.toLowerCase() === wanted);
    if (!player) {
      if (room.state.players.length >= MAX_SEATS) {
        player = room.state.players.find((p) => !p.connected);
        if (!player) return { ok: false, error: 'Room is full' };
        player.name = name.trim() || player.name;
      } else {
        player = newPlayer(name, role);
        room.state.players.push(player);
      }
    }
    player.connected = true;
    socket.data.roomCode = room.state.roomCode;
    socket.data.playerId = player.id;
    void socket.join(room.state.roomCode);
    broadcast(room);
    return { ok: true, roomCode: room.state.roomCode, playerId: player.id, state: snapshot(room) };
  }

  function registerSocketHandlers(socket: GameSocket): void {
    const currentRoom = () => (socket.data.roomCode ? getRoom(socket.data.roomCode) : undefined);

    socket.on('clock:ping', (payload) => {
      const serverRecvMs = Date.now();
      socket.emit('clock:pong', {
        clientSendMs: payload?.clientSendMs ?? 0,
        serverRecvMs,
        serverSendMs: Date.now(),
      });
    });

    socket.on('room:create', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!payload?.playerName) return ack({ ok: false, error: 'playerName is required' });
      const { roomCode, hostPlayerId } = await createRoom({
        hostName: payload.playerName,
        hostRole: payload.role,
        difficulty: payload.difficulty,
      });
      const room = rooms.get(roomCode)!;
      const host = room.state.players.find((p) => p.id === hostPlayerId)!;
      ack(seatSocket(socket, room, host.name, payload.role));
    });

    socket.on('room:quick_start', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!payload?.playerName) return ack({ ok: false, error: 'playerName is required' });
      const { roomCode } = await createRoom({
        hostName: payload.playerName,
        hostRole: payload.role,
        quickStart: true,
      });
      ack(seatSocket(socket, rooms.get(roomCode)!, payload.playerName, payload.role));
    });

    socket.on('room:join', (payload, ack) => {
      if (typeof ack !== 'function') return;
      const room = payload?.roomCode ? getRoom(payload.roomCode) : undefined;
      if (!room) return ack({ ok: false, error: 'Room not found' });
      if (!payload.playerName) return ack({ ok: false, error: 'playerName is required' });
      ack(seatSocket(socket, room, payload.playerName, payload.role));
    });

    socket.on('player:pose', (frame) => {
      const room = currentRoom();
      if (!room || !socket.data.playerId) return;
      socket.to(room.state.roomCode).emit('player:pose', { ...frame, playerId: socket.data.playerId });
    });

    socket.on('opening:pick_card', ({ cardId, slot }) => {
      const room = currentRoom();
      if (!room) return;
      const picks = room.state.picks ?? { encounterCardId: null, bossCardId: null };
      if (slot === 'encounter') picks.encounterCardId = cardId;
      else if (slot === 'boss') picks.bossCardId = cardId;
      room.state.picks = picks;
      broadcast(room);
    });

    socket.on('game:start', () => {
      const room = currentRoom();
      if (!room || room.hostPlayerId !== socket.data.playerId) return;
      if (room.state.phase === 'lobby') {
        room.state.phase = 'opening';
        broadcast(room);
      }
    });

    socket.on('disconnect', () => {
      const room = currentRoom();
      const player = room?.state.players.find((p) => p.id === socket.data.playerId);
      if (!room || !player) return;
      player.connected = false;
      broadcast(room);
    });
  }

  return {
    createRoom,
    getState: (code) => {
      const room = getRoom(code);
      return room ? snapshot(room) : null;
    },
    getQuestStatus: (code): QuestStatus | null => {
      const room = getRoom(code);
      if (!room) return null;
      const s = room.state;
      return {
        roomCode: s.roomCode,
        phase: s.phase,
        hearts: s.hearts,
        maxHearts: s.maxHearts,
        enemyName: s.currentEncounter?.name ?? null,
        enemyHp: s.enemyHp,
        enemyMaxHp: s.enemyMaxHp,
        wardActive: s.wardActive,
      };
    },
    getIncantation: (code, element: ElementType) =>
      getRoom(code)?.state.world?.incantations[element] ?? null,
    buildJoinLink: (code, playerName) => {
      const url = new URL(config.publicBaseUrl);
      url.searchParams.set('room', normalizeCode(code));
      if (playerName) url.searchParams.set('name', playerName);
      return url.toString();
    },
    recordIncantation: () => {
      // Stub: casts are not gated on incantations yet.
    },
    registerSocketHandlers,
    dispose: () => rooms.clear(),
  };
}
