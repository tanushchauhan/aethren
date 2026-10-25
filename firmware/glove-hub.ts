/**
 * Glove hub: receives the gloves' Wi-Fi UDP packets and relays them to browsers over WebSocket.
 *
 *   glove --UDP :4211--> hub --WebSocket :8765--> /debug/hardware
 *   glove <--UDP :4210-- hub   ("hello" every 2 s so the glove stops broadcasting and sends straight here;
 *                               also the target for ident / beep / lcd commands from the page)
 *
 * Run:  pnpm --dir firmware hub            real gloves
 *       pnpm --dir firmware hub:simulate   two fake gloves, no hardware needed
 * Node built-ins only. WebSocket is hand-rolled: the page only needs text frames.
 */
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Socket } from 'node:net';

const GLOVE_UDP_PORT = Number(process.env.GLOVE_UDP_PORT ?? 4211);
const GLOVE_CMD_PORT = 4210;
const WS_PORT = Number(process.env.GLOVE_WS_PORT ?? 8765);
/** Listens on every interface so other laptops on the network can use these gloves. Set GLOVE_WS_HOST=127.0.0.1 to keep it local. */
const WS_HOST = process.env.GLOVE_WS_HOST ?? '0.0.0.0';
const ONLINE_MS = 3000;
const HELLO_MS = 2000;
const simulate = process.argv.includes('--simulate');

interface Frame {
  seq: number;
  ms: number;
  ax: number;
  ay: number;
  az: number;
  d3: number;
  d7: number;
  d4: number;
  d8: number;
  dial: number;
  rssi: number;
  /** Unused pins, only sent by wifi-diag-2 firmware and later. */
  d2?: number;
  d6?: number;
  d9?: number;
  a1?: number;
  a2?: number;
  a3?: number;
}

interface Glove {
  id: number;
  ip: string;
  variant: number | null;
  fw: string;
  ssid: string;
  rssi: number;
  acc: string;
  touchPin: number | null;
  hubSeen: boolean;
  uptimeS: number;
  gloveFps: number;
  i2c: number[];
  lastSeen: number;
  lastSeq: number | null;
  received: number;
  dropped: number;
  rxRate: number;
  conflictUntil: number;
  windowCount: number;
}

const gloves = new Map<number, Glove>();
const clients = new Set<Socket>();
/** Which browser connection has each glove claimed. A glove can be used by one player at a time. */
const owners = new Map<number, string>();
const clientIds = new WeakMap<Socket, string>();
let nextClient = 1;

function summary(g: Glove) {
  const now = Date.now();
  return {
    id: g.id,
    ip: g.ip,
    variant: g.variant,
    fw: g.fw,
    ssid: g.ssid,
    rssi: g.rssi,
    acc: g.acc,
    touchPin: g.touchPin,
    hubSeen: g.hubSeen,
    uptimeS: g.uptimeS,
    gloveFps: g.gloveFps,
    i2c: g.i2c,
    online: now - g.lastSeen < ONLINE_MS,
    ageMs: now - g.lastSeen,
    received: g.received,
    dropped: g.dropped,
    rxRate: g.rxRate,
    conflict: now < g.conflictUntil,
    claimedBy: owners.get(g.id) ?? null,
  };
}

function broadcast(message: unknown): void {
  if (clients.size === 0) return;
  const frame = encodeWs(JSON.stringify(message));
  for (const client of clients) client.write(frame);
}

function gloveFor(id: number, ip: string): Glove {
  let g = gloves.get(id);
  const now = Date.now();
  if (!g) {
    g = {
      id,
      ip,
      variant: null,
      fw: '',
      ssid: '',
      rssi: 0,
      acc: '',
      touchPin: null,
      hubSeen: false,
      uptimeS: 0,
      gloveFps: 0,
      i2c: [],
      lastSeen: now,
      lastSeq: null,
      received: 0,
      dropped: 0,
      rxRate: 0,
      conflictUntil: 0,
      windowCount: 0,
    };
    gloves.set(id, g);
    console.log(`[hub] glove ${id} appeared at ${ip}`);
  } else if (g.ip !== ip && now - g.lastSeen < ONLINE_MS) {
    // Two boards flashed with the same id would interleave here.
    g.conflictUntil = now + 5000;
    console.warn(`[hub] glove id ${id} is arriving from ${g.ip} and ${ip}: flash them with different ids`);
  }
  g.ip = ip;
  g.lastSeen = now;
  return g;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function handlePacket(text: string, ip: string): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = num(data.id, -1);
  if (id < 0) return;
  const g = gloveFor(id, ip);
  if (data.t === 'f') {
    const frame: Frame = {
      seq: num(data.seq),
      ms: num(data.ms),
      ax: num(data.ax),
      ay: num(data.ay),
      az: num(data.az),
      d3: num(data.d3),
      d7: num(data.d7),
      d4: num(data.d4),
      d8: num(data.d8),
      dial: num(data.dial),
      rssi: num(data.rssi),
    };
    for (const key of ['d2', 'd6', 'd9', 'a1', 'a2', 'a3'] as const) {
      if (typeof data[key] === 'number') frame[key] = data[key] as number;
    }
    if (g.lastSeq !== null && frame.seq > g.lastSeq + 1) g.dropped += frame.seq - g.lastSeq - 1;
    g.lastSeq = frame.seq;
    g.received++;
    g.windowCount++;
    g.rssi = frame.rssi || g.rssi;
    broadcast({ type: 'frame', id, rx: Date.now(), f: frame });
  } else if (data.t === 'i') {
    g.variant = num(data.v, g.variant ?? 0) || null;
    g.fw = typeof data.fw === 'string' ? data.fw : g.fw;
    g.ssid = typeof data.ssid === 'string' ? data.ssid : g.ssid;
    g.rssi = num(data.rssi, g.rssi);
    g.acc = typeof data.acc === 'string' ? data.acc : g.acc;
    g.touchPin = typeof data.tp === 'number' ? data.tp : g.touchPin;
    g.hubSeen = data.hub === 1;
    g.uptimeS = num(data.up);
    g.gloveFps = num(data.fps);
    g.i2c = Array.isArray(data.i2c) ? data.i2c.filter((n): n is number => typeof n === 'number') : g.i2c;
    broadcast({ type: 'glove', glove: summary(g) });
  }
}

// --- UDP ---------------------------------------------------------------------

const udp = dgram.createSocket('udp4');

function sendToGlove(id: number, payload: Record<string, unknown>): void {
  const g = gloves.get(id);
  if (!g || simulate) return;
  udp.send(JSON.stringify(payload), GLOVE_CMD_PORT, g.ip);
}

if (!simulate) {
  udp.on('message', (msg, rinfo) => handlePacket(msg.toString('utf8'), rinfo.address));
  udp.on('error', (err) => {
    console.error(`[hub] UDP error: ${err.message}`);
    process.exit(1);
  });
  udp.bind(GLOVE_UDP_PORT, () => console.log(`[hub] listening for gloves on UDP :${GLOVE_UDP_PORT}`));
}

setInterval(() => {
  for (const g of gloves.values()) {
    if (Date.now() - g.lastSeen < 30_000) sendToGlove(g.id, { cmd: 'hello' });
  }
}, HELLO_MS);

// --- Rates and snapshots -----------------------------------------------------

setInterval(() => {
  for (const g of gloves.values()) {
    g.rxRate = g.windowCount;
    g.windowCount = 0;
  }
  broadcast({ type: 'snapshot', gloves: [...gloves.values()].sort((a, b) => a.id - b.id).map(summary) });
}, 1000);

setInterval(() => {
  const rows = [...gloves.values()].map((g) => {
    const s = summary(g);
    return `G${g.id} ${s.online ? 'ONLINE ' : 'offline'} v${g.variant ?? '?'} ${g.ip} rx ${g.rxRate}/s drop ${g.dropped} rssi ${g.rssi} acc ${g.acc || '?'}`;
  });
  console.log(rows.length ? rows.join('\n') : '[hub] no gloves yet (are they on the same Wi-Fi?)');
}, 3000);

// --- WebSocket ---------------------------------------------------------------

function encodeWs(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([head, body]);
}

function decodeWs(buffer: Buffer): { opcode: number; text: string; used: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ buffer[offset + (i % 4)]!;
  return { opcode, text: payload.toString('utf8'), used: offset + maskBytes + length };
}

function reply(socket: Socket, message: unknown): void {
  socket.write(encodeWs(JSON.stringify(message)));
}

/**
 * Co-op relay: two game screens on this hub share a boss fight without any other server.
 * `{type:'coop', to?, data}` goes to that one connection, or to every other connection without `to`,
 * arriving as `{type:'coop', from, data}`.
 */
function relayCoop(socket: Socket, message: Record<string, unknown>): void {
  const from = clientIds.get(socket);
  if (!from || message.data === undefined) return;
  const frame = encodeWs(JSON.stringify({ type: 'coop', from, data: message.data }));
  for (const client of clients) {
    if (client === socket) continue;
    if (typeof message.to === 'string' && clientIds.get(client) !== message.to) continue;
    client.write(frame);
  }
}

function handleClientMessage(socket: Socket, text: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.type === 'coop') return relayCoop(socket, message);
  if (typeof message.id !== 'number') return;
  const me = clientIds.get(socket);
  if (message.type === 'claim') {
    const g = gloves.get(message.id);
    const owner = owners.get(message.id);
    if (!g || !me) return reply(socket, { type: 'claim', id: message.id, ok: false, reason: 'unknown' });
    if (owner && owner !== me) return reply(socket, { type: 'claim', id: message.id, ok: false, reason: 'in-use' });
    if (Date.now() - g.lastSeen >= ONLINE_MS) return reply(socket, { type: 'claim', id: message.id, ok: false, reason: 'offline' });
    owners.set(message.id, me);
    reply(socket, { type: 'claim', id: message.id, ok: true });
    broadcast({ type: 'glove', glove: summary(g) });
    return;
  }
  if (message.type === 'release') {
    if (owners.get(message.id) === me) {
      owners.delete(message.id);
      const g = gloves.get(message.id);
      if (g) broadcast({ type: 'glove', glove: summary(g) });
    }
    return;
  }
  if (message.type !== 'cmd') return;
  const { type: _type, id, ...payload } = message;
  if (typeof payload.cmd === 'string') sendToGlove(id as number, payload);
}

const server = createServer((req, res) => {
  if (req.url === '/api/gloves') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify([...gloves.values()].sort((a, b) => a.id - b.id).map(summary)));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Glove hub. Open /debug/hardware in the game client. JSON: /api/gloves\n');
});

server.on('upgrade', (req, socket: Socket) => {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(socket);
  const clientId = `c${nextClient++}`;
  clientIds.set(socket, clientId);
  reply(socket, { type: 'welcome', clientId });
  socket.write(encodeWs(JSON.stringify({ type: 'snapshot', gloves: [...gloves.values()].sort((a, b) => a.id - b.id).map(summary) })));
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let msg = decodeWs(pending); msg; msg = decodeWs(pending)) {
      pending = pending.subarray(msg.used);
      if (msg.opcode === 0x8) socket.end();
      else if (msg.opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
      else if (msg.opcode === 0x1) handleClientMessage(socket, msg.text);
    }
  });
  const drop = () => {
    // Tells a co-op partner straight away instead of leaving them waiting on a silent screen.
    if (clients.delete(socket)) broadcast({ type: 'coop-left', from: clientId });
    for (const [gloveId, owner] of [...owners]) {
      if (owner !== clientId) continue;
      owners.delete(gloveId);
      const g = gloves.get(gloveId);
      if (g) broadcast({ type: 'glove', glove: summary(g) });
    }
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.listen(WS_PORT, WS_HOST, () => {
  console.log(`[hub] browser feed on ws://localhost:${WS_PORT}`);
  if (WS_HOST === '127.0.0.1') return;
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) console.log(`[hub] other laptops: open the game with ?hub=ws://${addr.address}:${WS_PORT}`);
    }
  }
});

// --- Simulator ---------------------------------------------------------------

if (simulate) {
  console.log('[hub] simulating gloves 1 (LCD v4) and 2 (LCD v2); no hardware is read');
  const started = Date.now();
  const tick = (id: number, variant: number, phase: number, seq: number): void => {
    const t = (Date.now() - started) / 1000 + phase;
    // Rest at 1 g on Z, with a swing every few seconds.
    const swing = Math.max(0, Math.sin(t * 0.9)) ** 8;
    const frame = {
      t: 'f',
      id,
      seq,
      ms: Date.now() - started,
      ax: Math.round(Math.sin(t * 9) * 900 * swing + Math.sin(t * 2.1) * 30),
      ay: Math.round(Math.cos(t * 7) * 700 * swing + Math.cos(t * 1.3) * 30),
      az: Math.round(1000 + Math.sin(t * 5) * 400 * swing),
      d3: id === 2 && Math.sin(t * 0.6) > 0.8 ? 1 : 0,
      d7: id === 1 && Math.sin(t * 0.6) > 0.8 ? 1 : 0,
      d4: Math.sin(t * 0.4 + 1) > 0.85 ? 1 : 0,
      d8: Math.sin(t * 0.5 + 2) > 0.85 ? 1 : 0,
      dial: Math.round(512 + Math.sin(t * 0.3) * 500),
      rssi: -48 - id * 4,
      d2: 0,
      d6: id === 1 && Math.sin(t * 0.7) > 0.9 ? 1 : 0,
      d9: 0,
      a1: Math.round(8 + Math.sin(t) * 5),
      a2: Math.round(300 + Math.sin(t * 0.4) * 280),
      a3: Math.round(5 + Math.cos(t) * 4),
    };
    handlePacket(JSON.stringify(frame), `172.20.10.${id + 3}`);
  };
  const seqs = new Map<number, number>();
  setInterval(() => {
    for (const [id, variant, phase] of [[1, 4, 0], [2, 2, 1.7]] as const) {
      const seq = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, seq);
      tick(id, variant, phase, seq);
    }
  }, 25);
  setInterval(() => {
    for (const [id, variant] of [[1, 4], [2, 2]] as const) {
      handlePacket(
        JSON.stringify({ t: 'i', id, v: variant, fw: 'simulated', ip: `172.20.10.${id + 3}`, ssid: 'iPhone', rssi: -48 - id * 4, acc: 'MMA7660', tp: id === 1 ? 7 : 3, hub: 1, up: Math.round((Date.now() - started) / 1000), fps: 40, i2c: [62, 76, 98] }),
        `172.20.10.${id + 3}`,
      );
    }
  }, 1000);
}
