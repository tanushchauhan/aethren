import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { startServer } from './storyServer';
let server: Awaited<ReturnType<typeof startServer>>;
const clients: Socket[] = [];
let url: string;
function event<T = any>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${name}`)), 3000);
    socket.once(name, value => { clearTimeout(timer); resolve(value); });
  });
}
async function connect() { const socket = io(url, { forceNew: true }); clients.push(socket); await event(socket, 'connect'); return socket; }
async function create(socket: Socket) { const next = event(socket, 'story:joined'); socket.emit('story:create', { name: 'Host' }); return next; }
beforeEach(async () => { server = await startServer(0); url = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`; });
afterEach(async () => { clients.splice(0).forEach(socket => socket.disconnect()); await server.close(); });
describe('authored story rooms', () => {
  it('creates and joins an online room, normalizing the room code', async () => {
    const host = await connect(); const room = await create(host); expect(room.code).toMatch(/^[A-Z]{4}$/);
    const guest = await connect(); const next = event(guest, 'story:joined');
    guest.emit('story:join', { code: room.code.toLowerCase(), name: 'Guest' });
    expect((await next).players.map((player: { name: string }) => player.name)).toEqual(['Host', 'Guest']);
  });
  it('rejects a third player', async () => {
    const room = await create(await connect()); const guest = await connect(); const joined = event(guest, 'story:joined');
    guest.emit('story:join', { code: room.code, name: 'Guest' }); await joined;
    const third = await connect(); const rejected = event(third, 'story:error'); third.emit('story:join', { code: room.code, name: 'Third' });
    expect((await rejected).message).toContain('two players');
  });
  it('rejects malformed creation and missing rooms without crashing', async () => {
    const socket = await connect(); const invalid = event(socket, 'story:error'); socket.emit('story:create', null); expect((await invalid).message).toBe('Enter your name.');
    const missing = event(socket, 'story:error'); socket.emit('story:join', { name: 'Guest', code: 'NONE' }); expect((await missing).message).toBe('Room not found.');
    expect((await create(socket)).players).toHaveLength(1);
  });
  it('cleans up empty rooms on disconnect', async () => {
    const host = await connect(); const room = await create(host); host.disconnect();
    await new Promise(resolve => setTimeout(resolve, 40));
    const guest = await connect(); const missing = event(guest, 'story:error'); guest.emit('story:join', { code: room.code, name: 'Guest' });
    expect((await missing).message).toBe('Room not found.');
  });
  it('serves health without model services or API routes', async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${url}/api/tts`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${url}/api/quest-chat`, { method: 'POST' })).status).toBe(404);
  });
});
