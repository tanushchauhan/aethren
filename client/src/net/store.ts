import type { PoseActionType } from '@once-upon/shared';
import { create } from 'zustand';
import { serverUrl } from '../combat-ui/audio/serverUrl';
import { getServerNow } from './clock';
import type {
  CastEvent,
  CombatPhase,
  ConnectionStatus,
  DodgeResult,
  GameState,
  HardwareEvent,
  NarratorLine,
  MemoryCard,
  NormalizedLandmark,
  PlayerRole,
  PoseEvent,
  RoomPhase,
  TelegraphEvent,
} from './contract';
import { buildMockGameState, mockPlayerId } from './mockState';
import {
  connect as connectSocket,
  connectedSocket,
  disconnect as disconnectSocket,
  getSocket,
  registerSocketBridge,
} from './socket';

const EVENT_HISTORY = 20;
let lastPoseSentMs = 0;

export interface GameStoreState {
  connection: ConnectionStatus;
  mockMode: boolean;
  adventureMode: 'singleplayer' | 'online';
  localPlayerId: string | null;
  localRole: PlayerRole | null;
  playerName: string;
  gameState: GameState | null;
  latestTelegraph: TelegraphEvent | null;
  teammatePoses: Record<string, PoseEvent>;
  hardware: HardwareEvent | null;
  lastCasts: CastEvent[];
  lastDodges: DodgeResult[];
  serverTimeOffsetMs: number;
  lastError: string | null;
  /** Full narrator payload so combat audio can read audioUrl and the TTS flag. */
  lastNarrator: NarratorLine | null;
}

export interface GameStoreActions {
  connect: (url?: string) => void;
  disconnect: () => void;
  createRoom: (name: string, role: PlayerRole, mode?: 'singleplayer' | 'online') => void;
  joinRoom: (code: string, name: string, role: PlayerRole) => void;
  quickStart: (name: string, role: PlayerRole) => void;
  selectCard: (cardId: string) => void;
  lockBoss: (cardId: string) => void;
  sendQuestPrompt: (prompt: string) => Promise<void>;
  sendCast: (input: Omit<CastEvent, 'playerId'>) => void;
  sendDodge: (input: Omit<DodgeResult, 'playerId'>) => void;
  sendHardware: (event: HardwareEvent) => void;
  sendPose: (landmarks: NormalizedLandmark[], inZone: boolean, activeAction?: PoseActionType, confidence?: number) => void;
  applyMemoryCards: (cards: MemoryCard[]) => void;
  applyRoomState: (state: GameState) => void;
  applyTelegraph: (event: TelegraphEvent) => void;
  applyNarrator: (line: NarratorLine) => void;
  setPhase: (phase: RoomPhase, combatPhase?: CombatPhase) => void;
  resetToLobby: () => void;
}

export type GameStore = GameStoreState & GameStoreActions;

function pushCapped<T>(items: readonly T[], item: T): T[] {
  const next = items.length >= EVENT_HISTORY ? items.slice(items.length - EVENT_HISTORY + 1) : items.slice();
  next.push(item);
  return next;
}

function upsertTimed<T extends { playerId: string; serverTimestampMs: number }>(items: readonly T[], item: T): T[] {
  const index = items.findIndex(
    (entry) => entry.playerId === item.playerId && entry.serverTimestampMs === item.serverTimestampMs,
  );
  if (index === -1) return pushCapped(items, item);
  const next = items.slice();
  next[index] = item;
  return next;
}

function localIdentity(
  name: string,
  role: PlayerRole,
  currentId: string | null,
): Pick<GameStoreState, 'playerName' | 'localRole' | 'localPlayerId'> {
  return {
    playerName: name.trim() || 'Dev',
    localRole: role,
    localPlayerId: currentId ?? mockPlayerId(role),
  };
}

function ensureMockBase(current: GameState | null, name: string, role: PlayerRole, roomCode?: string): GameState {
  return (
    current ??
    buildMockGameState({
      playerName: name.trim() || 'Dev',
      role,
      roomCode,
    })
  );
}

export const useGameStore = create<GameStore>((set, get) => {
  const live = () => get().mockMode === false && connectedSocket() !== null;

  return {
  connection: 'disconnected',
  adventureMode: 'online',
  mockMode: true,
  localPlayerId: null,
  localRole: null,
  playerName: '',
  gameState: null,
  latestTelegraph: null,
  teammatePoses: {},
  hardware: null,
  lastCasts: [],
  lastDodges: [],
  serverTimeOffsetMs: 0,
  lastError: null,
  lastNarrator: null,

  connect: (url) => {
    set({ connection: 'connecting', mockMode: false, lastError: null });
    const socket = connectSocket(url);
    if (!socket) {
      set((state) => ({
        connection: 'disconnected',
        mockMode: true,
        lastError: state.lastError ?? 'Unable to open a socket',
      }));
      return;
    }
    if (socket.connected) {
      set({ connection: 'connected', mockMode: false, lastError: null });
    }
  },

  disconnect: () => {
    disconnectSocket();
    set({ connection: 'disconnected', mockMode: true, serverTimeOffsetMs: 0 });
  },

  createRoom: (name, role, mode = 'online') => {
    set({ adventureMode: mode });
    if (!get().mockMode && !live()) { set({ lastError: 'Reconnect before continuing your online quest.' }); return; }
    if (live()) {
      set({ playerName: name, localRole: role, lastError: null });
      getSocket()?.emit('room:create', { playerName: name, role, mode });
      return;
    }
    set({
      ...localIdentity(name, role, null),
      lastError: null,
      gameState: buildMockGameState({ playerName: name, role, phase: 'upload' }),
    });
  },

  joinRoom: (code, name, role) => {
    set({ adventureMode: 'online' });
    if (!get().mockMode && !live()) { set({ lastError: 'Reconnect before continuing your online quest.' }); return; }
    const roomCode = code.trim().toUpperCase();
    if (live()) {
      set({ playerName: name, localRole: role, lastError: null });
      getSocket()?.emit('room:join', { code: roomCode, playerName: name, role });
      return;
    }
    set({
      ...localIdentity(name, role, null),
      lastError: null,
      gameState: buildMockGameState({ playerName: name, role, roomCode, phase: 'upload' }),
    });
  },

  quickStart: (name, role) => {
    if (!get().mockMode && !live()) { set({ lastError: 'Reconnect before continuing your online quest.' }); return; }
    if (live()) {
      set({ playerName: name, localRole: role, lastError: null });
      getSocket()?.emit('room:quick_start', { playerName: name, role });
      return;
    }
    set({
      ...localIdentity(name, role, null),
      lastError: null,
      gameState: buildMockGameState({
        playerName: name,
        role,
        phase: 'intro',
        quickStart: true,
      }),
    });
  },

  selectCard: (cardId) => {
    if (!get().mockMode && !live()) { set({ lastError: 'Reconnect before continuing your online quest.' }); return; }
    if (live()) {
      getSocket()?.emit('opening:select_card', { cardId });
      return;
    }
    const { playerName, localRole, localPlayerId, gameState } = get();
    const role = localRole ?? 'spellbearer';
    const current = ensureMockBase(gameState, playerName, role);
    const selectedMemoryIds = current.selectedMemoryIds.includes(cardId)
      ? current.selectedMemoryIds
      : [...current.selectedMemoryIds, cardId];
    set({
      ...localIdentity(playerName, role, localPlayerId),
      gameState: { ...current, selectedMemoryIds },
    });
  },

  lockBoss: (cardId) => {
    if (!get().mockMode && !live()) { set({ lastError: 'Reconnect before continuing your online quest.' }); return; }
    if (live()) {
      getSocket()?.emit('opening:lock_boss', { cardId });
      return;
    }
    const { playerName, localRole, localPlayerId, gameState } = get();
    const role = localRole ?? 'spellbearer';
    const current = ensureMockBase(gameState, playerName, role);
    const boss = current.boss ? { ...current.boss, memory: cardId, wardUp: true } : current.boss;
    const world = current.world
      ? { ...current.world, boss: { ...current.world.boss, memory: cardId, wardUp: true } }
      : current.world;
    set({
      ...localIdentity(playerName, role, localPlayerId),
      gameState: { ...current, boss, world, bossMemoryId: cardId, wardUp: true },
    });
  },

  sendQuestPrompt: async (prompt) => {
    if (!get().mockMode) {
      if (!live()) throw new Error('Reconnect to ask Muse.');
      const response = await fetch(`${serverUrl()}/api/quest-chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, roomCode: get().gameState?.roomCode }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Quest request failed.');
      return;
    }
    const { playerName, localRole, localPlayerId, gameState } = get();
    const role = localRole ?? 'spellbearer';
    const current = ensureMockBase(gameState, playerName, role);
    const line: NarratorLine = {
      text: `The quest master hears: ${prompt}`,
      useBrowserTts: false,
    };
    set({
      ...localIdentity(playerName, role, localPlayerId),
      lastNarrator: line,
      gameState: { ...current, narratorCaption: line.text },
    });
  },

  sendCast: (input) => {
    const playerId = get().localPlayerId ?? mockPlayerId(get().localRole ?? 'spellbearer');
    const cast: CastEvent = { ...input, playerId };
    set((state) => ({
      localPlayerId: state.localPlayerId ?? playerId,
      lastCasts: upsertTimed(state.lastCasts, cast),
    }));
    if (live()) getSocket()?.emit('player:cast', input);
  },

  sendDodge: (input) => {
    const playerId = get().localPlayerId ?? mockPlayerId(get().localRole ?? 'spellbearer');
    const dodge: DodgeResult = { ...input, playerId };
    set((state) => ({
      localPlayerId: state.localPlayerId ?? playerId,
      lastDodges: upsertTimed(state.lastDodges, dodge),
    }));
    if (live()) getSocket()?.emit('player:dodge_result', input);
  },

  sendHardware: (event) => {
    const playerId = get().localPlayerId;
    if (!playerId) return;
    const ownedEvent = { ...event, playerId };
    set({ hardware: ownedEvent });
    if (live()) getSocket()?.emit('hardware:event', ownedEvent);
  },

  sendPose: (landmarks, inZone, activeAction = 'none', confidence = 0) => {
    const now = performance.now();
    if (now - lastPoseSentMs < 1000 / 15) return;
    lastPoseSentMs = now;
    set(state => ({ gameState: state.gameState ? { ...state.gameState, players: state.gameState.players.map(p => p.id === state.localPlayerId ? { ...p, inZone } : p) } : null }));
    if (!live()) return;
    getSocket()?.emit('player:pose', { landmarks, inZone, activeAction, confidence, serverTimestampMs: getServerNow() });
  },

  applyMemoryCards: (cards) => {
    const current = get().gameState;
    if (current) set({ gameState: { ...current, memoryCards: cards, selectedMemoryIds: [], bossMemoryId: undefined } });
  },

  applyRoomState: (state) => {
    const { playerName, localRole, localPlayerId } = get();
    const matchingNames = state.players.filter(player => player.name === playerName);
    const me = state.players.find(player => player.id === localPlayerId) ??
      (matchingNames.length === 1 ? matchingNames[0] : null);
    set({
      gameState: state,
      localPlayerId: me?.id ?? get().localPlayerId,
      localRole: me?.role ?? localRole,
      playerName: me?.name ?? playerName,
    });
  },

  applyTelegraph: (event) => {
    set({ latestTelegraph: event });
  },

  applyNarrator: (line) => {
    const current = get().gameState;
    set({
      lastNarrator: line,
      gameState: current ? { ...current, narratorCaption: line.text } : current,
    });
  },

  setPhase: (phase, combatPhase) => {
    if (!get().mockMode) {
      if (live()) getSocket()?.emit('room:advance', { phase });
      return;
    }
    const { playerName, localRole, localPlayerId, gameState } = get();
    const role = localRole ?? 'spellbearer';
    const current = ensureMockBase(gameState, playerName, role);
    set({
      ...localIdentity(playerName, role, localPlayerId),
      gameState: {
        ...current,
        phase,
        combatPhase: combatPhase ?? current.combatPhase,
      },
    });
  },

  resetToLobby: () => {
    const { playerName, localRole, localPlayerId, gameState } = get();
    const role = localRole ?? 'spellbearer';
    const current = gameState ?? buildMockGameState({ playerName: playerName || 'Dev', role, phase: 'lobby' });
    const name = playerName || current.players.find((player) => player.role === role)?.name || 'Dev';
    set({
      ...localIdentity(name, role, localPlayerId),
      latestTelegraph: null,
      hardware: null, lastCasts: [], lastDodges: [], teammatePoses: {}, lastNarrator: null,
      gameState: {
        ...current,
        phase: 'lobby',
        combatPhase: 'idle',
        currentRound: 0,
        narratorCaption: '',
        twinCastMeter: 0,
        quickStart: false,
      },
    });
  },
  };
});

registerSocketBridge({
  onJoined: (playerId) => useGameStore.setState({ localPlayerId: playerId, localRole: 'spellbearer' }),
  onConnected: () => {
    useGameStore.setState({ connection: 'connected', mockMode: false, lastError: null });
  },
  onDisconnected: (willReconnect) => {
    useGameStore.setState({
      connection: willReconnect ? 'connecting' : 'disconnected',
    });
  },
  onConnectError: () => {
    useGameStore.setState({
      connection: 'connecting',
      lastError: 'Cannot reach the game server. Reconnecting…',
    });
  },
  onClockOffset: (offsetMs) => {
    useGameStore.setState({ serverTimeOffsetMs: offsetMs });
  },
  onRoomState: (state) => {
    useGameStore.getState().applyRoomState(state);
  },
  onTelegraph: (event) => {
    useGameStore.getState().applyTelegraph(event);
  },
  onPose: (event) => {
    const localId = useGameStore.getState().localPlayerId;
    if (localId && event.playerId === localId) return;
    useGameStore.setState((state) => ({
      teammatePoses: { ...state.teammatePoses, [event.playerId]: event },
    }));
  },
  onDodge: (event) => {
    useGameStore.setState((state) => ({
      lastDodges: upsertTimed(state.lastDodges, event),
    }));
  },
  onCast: (event) => {
    useGameStore.setState((state) => ({
      lastCasts: upsertTimed(state.lastCasts, event),
    }));
  },
  onHardware: (event) => {
    const localId = useGameStore.getState().localPlayerId;
    if (localId && event.playerId === localId) useGameStore.setState({ hardware: event });
  },
  onHardwareCommand: (command) => {
    const localId = useGameStore.getState().localPlayerId;
    if (localId && (!command.playerId || command.playerId === localId)) window.dispatchEvent(new CustomEvent('ouam:hardware-command', { detail: command }));
  },
  onNarrator: (line) => {
    useGameStore.getState().applyNarrator(line);
  },
  onRoomError: (message) => {
    useGameStore.setState({ lastError: message });
  },
});

export { getServerNow };
