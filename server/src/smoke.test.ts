import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ClockPong,
  RoomJoinAck,
  ServerToClientEvents,
} from '@aethren/shared';
import { startServer, type StartedServer } from './index';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let server: StartedServer;
let url: string;
const sockets: ClientSocket[] = [];

function client(): Promise<ClientSocket> {
  const socket: ClientSocket = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  url = `http://localhost:${server.port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

describe('server smoke', () => {
  it('serves /health', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('creates and joins a room from two laptops, and answers clock pings', async () => {
    const a = await client();
    const b = await client();

    const created = await new Promise<RoomJoinAck>((resolve) =>
      a.emit('room:create', { playerName: 'Maya', role: 'spellbearer' }, resolve),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.roomCode).toMatch(/^[A-Z]{4}$/);

    const joined = await new Promise<RoomJoinAck>((resolve) =>
      b.emit('room:join', { roomCode: created.roomCode.toLowerCase(), playerName: 'Dev', role: 'partner' }, resolve),
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.roomCode).toBe(created.roomCode);
    expect(joined.state.players.map((p) => p.name)).toEqual(['Maya', 'Dev']);
    expect(joined.state.players.every((p) => p.connected)).toBe(true);

    const clientSendMs = Date.now();
    const pong = await new Promise<ClockPong>((resolve) => {
      b.once('clock:pong', resolve);
      b.emit('clock:ping', { clientSendMs });
    });
    expect(pong.clientSendMs).toBe(clientSendMs);
    expect(pong.serverSendMs).toBeGreaterThanOrEqual(pong.serverRecvMs);

    const missing = await new Promise<RoomJoinAck>((resolve) =>
      b.emit('room:join', { roomCode: 'ZZZZ', playerName: 'X', role: 'partner' }, resolve),
    );
    expect(missing.ok).toBe(false);
  });
});
