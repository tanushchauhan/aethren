import { create } from 'zustand';
import { playerStore, resetHeroes } from '../combat/playerState';
import { useSpellBattle } from '../combat/spellBattle';
import { io, type Socket } from 'socket.io-client';

interface StoryRoom { code: string; players: { id: string; name: string }[] }
interface StoryStore {
  playerName: string;
  adventureMode: 'singleplayer' | 'online';
  connection: 'disconnected' | 'connecting' | 'connected';
  lastError: string | null;
  started: boolean;
  /** Where a new single-player game begins: the story, or straight at the Gatekeeper. */
  startAt: 'story' | 'boss';
  room: StoryRoom | null;
  connect: () => void;
  createRoom: (name: string, mode: 'singleplayer' | 'online') => void;
  startBossFight: () => void;
  joinRoom: (code: string, name: string) => void;
}
let socket: Socket | null = null;
export const useStoryStore = create<StoryStore>((set, get) => ({
  playerName: '', adventureMode: 'singleplayer', connection: 'disconnected', lastError: null, started: false, startAt: 'story', room: null,
  connect() {
    if (socket) { if (!socket.connected) socket.connect(); return; }
    set({ connection: 'connecting', lastError: null });
    socket = io(import.meta.env.VITE_SERVER_URL?.trim() || window.location.origin);
    socket.on('connect', () => set({ connection: 'connected', lastError: null }));
    socket.on('disconnect', () => set({ connection: 'disconnected' }));
    socket.on('connect_error', () => set({ lastError: 'Cannot reach the story server. Retry to connect.' }));
    socket.on('story:joined', (room: StoryRoom) => {
      if (!get().started || get().room?.code !== room.code) { useSpellBattle.getState().reset('wolves'); playerStore.getState().reset(); }
      set({ room, started: true, lastError: null });
    });
    socket.on('story:room', (room: StoryRoom) => set({ room }));
    socket.on('story:error', ({ message }: { message: string }) => set({ lastError: message }));
  },
  createRoom(name, mode) {
    if (mode === 'singleplayer') {
      useSpellBattle.getState().reset('wolves');
      playerStore.getState().reset();
      socket?.disconnect(); socket?.removeAllListeners(); socket = null;
      set({ playerName: name, adventureMode: mode, started: true, startAt: 'story', room: null, lastError: null, connection: 'disconnected' });
      return;
    }
    if (get().connection !== 'connected') return;
    set({ playerName: name, adventureMode: mode, lastError: null });
    socket?.emit('story:create', { name });
  },
  startBossFight() {
    useSpellBattle.getState().reset('knight', false);
    playerStore.getState().reset();
    resetHeroes();
    socket?.disconnect(); socket?.removeAllListeners(); socket = null;
    set({ playerName: get().playerName || 'Spellbearer', adventureMode: 'singleplayer', started: true, startAt: 'boss', room: null, lastError: null, connection: 'disconnected' });
  },
  joinRoom(code, name) {
    if (get().connection !== 'connected') return;
    set({ playerName: name, adventureMode: 'online', lastError: null });
    socket?.emit('story:join', { code, name });
  },
}));
