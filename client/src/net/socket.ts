import { io, type Socket } from 'socket.io-client';
import { noteClockPong, resetClock, startClockSync, stopClockSync } from './clock';
import {
  DEFAULT_SERVER_URL,
  type CastEvent,
  type DodgeResult,
  type GameState,
  type HardwareEvent,
  type NarratorLine,
  type PoseEvent,
  type TelegraphEvent,
} from './contract';
import type { ClientEmitters, ServerListeners } from './socketTypes';

export type GameSocket = Socket<ServerListeners, ClientEmitters>;

export interface SocketBridge {
  onConnected: () => void;
  onDisconnected: (willReconnect: boolean) => void;
  onConnectError: (message: string) => void;
  onClockOffset: (offsetMs: number) => void;
  onRoomState: (state: GameState) => void;
  onTelegraph: (event: TelegraphEvent) => void;
  onPose: (event: PoseEvent) => void;
  onDodge: (event: DodgeResult) => void;
  onCast: (event: CastEvent) => void;
  onHardware: (event: HardwareEvent) => void;
  onNarrator: (line: NarratorLine) => void;
  onRoomError: (message: string) => void;
}

let activeSocket: GameSocket | null = null;
let activeUrl: string | null = null;
let bridge: SocketBridge | null = null;

export function registerSocketBridge(next: SocketBridge): void {
  bridge = next;
}

export function getSocket(): GameSocket | null {
  return activeSocket;
}

export function connectedSocket(): GameSocket | null {
  return activeSocket?.connected ? activeSocket : null;
}

function resolveServerUrl(url?: string): string {
  const requested = url?.trim();
  if (requested) return requested;
  const fromEnv = import.meta.env.VITE_SERVER_URL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_SERVER_URL;
}

function bindSocket(socket: GameSocket): void {
  socket.on('connect', () => {
    startClockSync(socket);
    bridge?.onConnected();
  });

  socket.on('disconnect', (reason) => {
    if (activeSocket !== socket) return;
    stopClockSync();
    bridge?.onDisconnected(reason !== 'io client disconnect');
  });

  socket.on('connect_error', (error: Error) => {
    if (activeSocket !== socket) return;
    bridge?.onConnectError(error.message || 'Server unreachable');
  });

  socket.on('clock:pong', (pong) => {
    bridge?.onClockOffset(noteClockPong(pong));
  });

  socket.on('room:state', (state) => {
    bridge?.onRoomState(state);
  });

  socket.on('combat:telegraph', (event) => {
    bridge?.onTelegraph(event);
  });

  socket.on('player:pose', (event) => {
    bridge?.onPose(event);
  });

  socket.on('player:dodge_result', (event) => {
    bridge?.onDodge(event);
  });

  socket.on('player:cast', (event) => {
    bridge?.onCast(event);
  });

  socket.on('hardware:event', (event) => {
    bridge?.onHardware(event);
  });

  socket.on('narrator:line', (line) => {
    bridge?.onNarrator(line);
  });

  socket.on('room:error', ({ message }) => {
    bridge?.onRoomError(message);
  });
}

function publishClockReset(): void {
  bridge?.onClockOffset(resetClock());
}

/** Opens a socket. A down server stays in mock mode; this does not throw. */
export function connect(url?: string): GameSocket | null {
  const target = resolveServerUrl(url);

  if (activeSocket && activeUrl === target) {
    if (!activeSocket.connected) activeSocket.connect();
    return activeSocket;
  }

  if (activeSocket) {
    const previous = activeSocket;
    activeSocket = null;
    activeUrl = null;
    previous.disconnect();
    publishClockReset();
  }

  try {
    // socket.io-client 4.8 publishes `io()` with no type parameters.
    const socket = io(target, {
      reconnection: true,
      reconnectionDelay: 1000,
      timeout: 5000,
    }) as GameSocket;
    activeSocket = socket;
    activeUrl = target;
    bindSocket(socket);
    return socket;
  } catch (error) {
    activeSocket = null;
    activeUrl = null;
    const message = error instanceof Error ? error.message : 'Unable to open a socket';
    bridge?.onConnectError(message);
    return null;
  }
}

export function disconnect(): void {
  const previous = activeSocket;
  activeSocket = null;
  activeUrl = null;
  previous?.disconnect();
  publishClockReset();
  bridge?.onDisconnected(false);
}
