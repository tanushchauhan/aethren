/**
 * Enchanted Glove bridge.
 *
 * Rebroadcasts GloveSensorFrame JSON from the Arduino Uno R4 WiFi to
 * ws://127.0.0.1:8765 so a browser without Web Serial, or a glove on Wi-Fi,
 * can still play Laptop A. Client text messages are GloveCommand lines and
 * are written back to the board.
 *
 * Links (one per run):
 *   - USB serial (/dev/ttyACM*, /dev/cu.usbmodem*), 115200 baud, newline JSON.
 *   - Wi-Fi UDP: `--udp <arduino-ip>` sends {"cmd":"hello"} to <ip>:4210 and
 *     keeps re-sending it, so the board streams frames back to this socket.
 *     `--udp-listen` binds :4210, waits for the board's 1 Hz broadcast beacon,
 *     then subscribes to whichever board sent it.
 *   - Neither (no port found, or --simulate): a 50 Hz simulated glove.
 *
 *   node --experimental-strip-types firmware/serial-bridge.ts
 *   node --experimental-strip-types firmware/serial-bridge.ts --port /dev/cu.usbmodem1101
 *   node --experimental-strip-types firmware/serial-bridge.ts --udp 172.20.10.4
 *   node --experimental-strip-types firmware/serial-bridge.ts --udp-listen
 *   node --experimental-strip-types firmware/serial-bridge.ts --simulate
 *   node --experimental-strip-types firmware/serial-bridge.ts --self-test
 *
 * The frame shape is GloveSensorFrame / GloveCommand in
 * @once-upon/shared (packages/shared/src/types.ts).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  openSync,
  readSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { connect, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import type { BuzzPattern, GloveCommand, GloveSensorFrame } from '../packages/shared/src/types.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_BAUD = 115200;
const DEFAULT_WS_PORT = 8765;
const DEFAULT_UDP_PORT = 4210;
/** The firmware forgets a UDP peer after 6 s without a packet from it. */
const UDP_HELLO_MS = 3000;
const UDP_STALE_MS = 3000;
const FRAME_MS = 20;
const LCD_COLS = 16;
const WIFI_SSID_MAX = 32;
const WIFI_PASS_MAX = 63;

type Swipe = GloveSensorFrame['swipe'];
type TokenColor = GloveSensorFrame['color'];
type BridgeMode = 'serial' | 'simulate' | 'udp';

function isBuzzPattern(value: unknown): value is BuzzPattern {
  return value === 'tick' || value === 'cast' || value === 'fizzle' || value === 'hit';
}

/** Printable ASCII, at most 16 characters: exactly what the LCD can draw. */
function lcdText(value: unknown): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    if (out.length >= LCD_COLS) break;
    const code = ch.charCodeAt(0);
    out += ch.length === 1 && code >= 32 && code <= 126 ? ch : '?';
  }
  return out;
}

function byte(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(255, Math.max(0, value)));
}

function parseCommand(value: unknown): GloveCommand | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.cmd === 'buzz' && isBuzzPattern(rec.p)) return { cmd: 'buzz', p: rec.p };
  if (rec.cmd === 'servo' && typeof rec.open === 'boolean') return { cmd: 'servo', open: rec.open };
  if (rec.cmd === 'arm' && typeof rec.open === 'boolean') return { cmd: 'arm', open: rec.open };
  if (rec.cmd === 'hello') return { cmd: 'hello' };
  if (rec.cmd === 'wifi') {
    const ssid = typeof rec.ssid === 'string' ? rec.ssid.trim().slice(0, WIFI_SSID_MAX) : '';
    if (!ssid) return { cmd: 'wifi' };
    return { cmd: 'wifi', ssid, pass: typeof rec.pass === 'string' ? rec.pass.slice(0, WIFI_PASS_MAX) : '' };
  }
  if (rec.cmd === 'lcd') {
    const command: Extract<GloveCommand, { cmd: 'lcd' }> = { cmd: 'lcd', l1: lcdText(rec.l1), l2: lcdText(rec.l2) };
    const r = byte(rec.r);
    const g = byte(rec.g);
    const b = byte(rec.b);
    if (r !== null && g !== null && b !== null) {
      command.r = r;
      command.g = g;
      command.b = b;
    }
    if (typeof rec.ms === 'number' && Number.isFinite(rec.ms)) command.ms = Math.max(0, Math.round(rec.ms));
    return command;
  }
  return null;
}

function formatCommand(command: GloveCommand): string {
  return JSON.stringify(command);
}

interface Options {
  port?: string;
  /** Arduino IP or host name for Wi-Fi UDP. */
  udpHost?: string;
  /** Bind the glove port and wait for its broadcast beacon instead of naming an IP. */
  udpListen: boolean;
  udpPort: number;
  baud: number;
  wsPort: number;
  host: string;
  simulate: boolean;
  list: boolean;
  selfTest: boolean;
  help: boolean;
  quiet: boolean;
}

interface BridgeHandle {
  port: number;
  mode: BridgeMode;
  commands: string[];
  stop: () => Promise<void>;
}

type WsEvent =
  | { type: 'text'; text: string }
  | { type: 'ping'; payload: Buffer }
  | { type: 'close' }
  | { type: 'pong' };

const COLORS: readonly TokenColor[] = ['none', 'ember', 'frost', 'bloom', 'boss'];

function log(message: string, quiet = false): void {
  if (!quiet) console.log(`[glove-bridge] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    udpListen: false,
    udpPort: DEFAULT_UDP_PORT,
    baud: DEFAULT_BAUD,
    wsPort: DEFAULT_WS_PORT,
    host: '127.0.0.1',
    simulate: false,
    list: false,
    selfTest: false,
    help: false,
    quiet: false,
  };
  let simulateFlag = false;
  let portFlag = false;
  let udpFlag = false;

  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--simulate') simulateFlag = true;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--port') {
      opts.port = take(i, arg);
      portFlag = true;
      i++;
    } else if (arg === '--udp') {
      opts.udpHost = take(i, arg);
      udpFlag = true;
      i++;
    } else if (arg === '--udp-listen') {
      opts.udpListen = true;
      udpFlag = true;
    } else if (arg === '--udp-port') {
      opts.udpPort = Number(take(i, arg));
      i++;
    } else if (arg === '--baud') {
      opts.baud = Number(take(i, arg));
      i++;
    } else if (arg === '--ws-port') {
      opts.wsPort = Number(take(i, arg));
      i++;
    } else if (arg === '--host') {
      opts.host = take(i, arg);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg ?? ''}`);
    }
  }

  if (!udpFlag && !portFlag && process.env.GLOVE_UDP_HOST) opts.udpHost = process.env.GLOVE_UDP_HOST;
  const udpWanted = opts.udpHost !== undefined || opts.udpListen;
  if (!portFlag && !udpWanted && process.env.GLOVE_PORT) opts.port = process.env.GLOVE_PORT;
  opts.simulate = simulateFlag || process.env.GLOVE_SIMULATE === '1';

  if (!Number.isInteger(opts.baud) || opts.baud < 1) throw new Error('Invalid --baud');
  if (!Number.isInteger(opts.wsPort) || opts.wsPort < 0 || opts.wsPort > 65535) {
    throw new Error('Invalid --ws-port');
  }
  if (!Number.isInteger(opts.udpPort) || opts.udpPort < 1 || opts.udpPort > 65535) {
    throw new Error('Invalid --udp-port');
  }
  if (portFlag && udpWanted) throw new Error('Pick one link: --port (USB serial) or --udp / --udp-listen (Wi-Fi)');
  if (simulateFlag && udpWanted) throw new Error('--simulate cannot be combined with --udp / --udp-listen');
  return opts;
}

function printHelp(): void {
  console.log(`Enchanted Glove bridge (USB serial or Wi-Fi UDP -> WebSocket)

Usage:
  node --experimental-strip-types firmware/serial-bridge.ts [options]

Options:
  --port <path>     USB serial device (/dev/ttyACM0, /dev/cu.usbmodem...)
  --udp <ip>        Wi-Fi UDP to the Uno R4 (port ${DEFAULT_UDP_PORT}; sends hello every ${UDP_HELLO_MS / 1000}s)
  --udp-listen      Bind :${DEFAULT_UDP_PORT}, find the glove by its broadcast beacon, then subscribe
  --udp-port <n>    Glove UDP port (default ${DEFAULT_UDP_PORT})
  --baud <n>        Baud rate (default ${DEFAULT_BAUD}; must match the sketch on the R4 WiFi)
  --ws-port <n>     WebSocket listen port (default ${DEFAULT_WS_PORT})
  --host <addr>     Bind address (default 127.0.0.1)
  --simulate        50 Hz simulated glove, do not open a serial port
  --list            Print matching serial ports and exit
  --self-test       Check the codec, simulator, WebSocket, and UDP loopback
  --quiet           Suppress the periodic status line
  --help            Show this help

Environment:
  GLOVE_PORT        Default serial device when --port is omitted
  GLOVE_UDP_HOST    Arduino IP when --udp is omitted
  GLOVE_SIMULATE=1  Force the simulator

Browser clients connect to ws://127.0.0.1:${DEFAULT_WS_PORT}.
Each text message either way is one JSON object (a GloveSensorFrame from the
bridge; a buzz, lcd, wifi, arm, servo, or hello GloveCommand from the browser).
`);
}

function portRank(path: string): number {
  if (/\/ttyACM\d+$/.test(path)) return 0;
  if (path.includes('/cu.usbmodem')) return 1;
  return 2;
}

function findPorts(): string[] {
  let names: string[] = [];
  try {
    names = readdirSync('/dev');
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        /^ttyACM\d+$/.test(name) ||
        name.startsWith('cu.usbmodem') ||
        name.startsWith('tty.usbmodem'),
    )
    .map((name) => `/dev/${name}`)
    .sort((a, b) => portRank(a) - portRank(b) || a.localeCompare(b));
}

/** Dynamic acceleration in g -> spell power, same map as the firmware. */
export function powerFromDynamicG(dynG: number): number {
  const floor = 0.18;
  const ceil = 1.4;
  const t = Math.min(1, Math.max(0, (dynG - floor) / (ceil - floor)));
  return 1 + 0.5 * t;
}

/** One simulated glove frame. `tick` counts 20 ms steps from bridge start. */
export function simulateFrame(tick: number): GloveSensorFrame {
  const sec = tick / (1000 / FRAME_MS);
  const dial = Math.floor(sec / 2.5) % 3;
  const cycle = sec % 8;
  const btn: 0 | 1 = cycle >= 3.4 && cycle < 4.6 ? 1 : 0;
  const fist = cycle >= 3.2 && cycle < 5.6;
  let swipe: Swipe = 'none';
  let dyn = 0;
  if (cycle >= 5.1 && cycle < 5.45) {
    swipe = 'thrust';
    dyn = 1.15;
  } else if (cycle >= 6.1 && cycle < 6.4) {
    swipe = 'left';
    dyn = 0.7;
  } else if (cycle >= 6.6 && cycle < 6.9) {
    swipe = 'right';
    dyn = 0.85;
  }
  const parry = cycle >= 1.05 && cycle < 1.35;
  let noise = Math.round(180 + 70 * Math.sin(sec * 1.3));
  if (cycle >= 2.0 && cycle < 2.4) noise += 320;
  if (noise < 0) noise = 0;
  if (noise > 1023) noise = 1023;
  const color = COLORS[Math.floor(sec / 4) % COLORS.length] ?? 'none';
  // D8 is clicked once to lock, then held through the charge (fist) window.
  const btn2: 0 | 1 = (cycle >= 0.4 && cycle < 0.52) || fist ? 1 : 0;
  return {
    dial,
    btn,
    btn2,
    fist,
    swipe,
    accel: powerFromDynamicG(dyn),
    parry,
    armed: true,
    noise,
    color,
    d3: parry ? 1 : 0,
    d4: btn,
    d8: btn2,
    rawDial: Math.round(dial * 341 + 170 + 40 * Math.sin(sec * 2)),
  };
}

/** Same key order as the firmware's publishFrame(). The pin fields are optional. */
export function formatFrame(frame: GloveSensorFrame): string {
  const accel = Math.min(1.5, Math.max(1, frame.accel)).toFixed(2);
  const fist = frame.fist ? 'true' : 'false';
  const parry = frame.parry ? 'true' : 'false';
  const armed = frame.armed ? 'true' : 'false';
  const btn2 = frame.btn2 === undefined ? '' : `"btn2":${frame.btn2},`;
  const pins = (['d3', 'd4', 'd8', 'rawDial'] as const)
    .filter((key) => frame[key] !== undefined)
    .map((key) => `,"${key}":${frame[key] ?? 0}`)
    .join('');
  return (
    `{"dial":${frame.dial},"btn":${frame.btn},${btn2}"fist":${fist},` +
    `"swipe":"${frame.swipe}","accel":${accel},"parry":${parry},` +
    `"armed":${armed},"noise":${frame.noise},"color":"${frame.color}"${pins}}`
  );
}

export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    throw new Error('WebSocket payload is too large');
  }
  return Buffer.concat([header, payload]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text));
}

function encodePong(payload: Buffer): Buffer {
  return encodeFrame(0xA, payload.subarray(0, Math.min(payload.length, 125)));
}

function encodeClose(): Buffer {
  return encodeFrame(0x8, Buffer.alloc(0));
}

/** Copy into a fresh Buffer so callers are not tied to a subarray's backing store. */
function bytesFrom(data: Uint8Array): Buffer<ArrayBuffer> {
  const copy = Buffer.alloc(data.length);
  copy.set(data);
  return copy;
}

export function decodeFrames(buffer: Buffer): { events: WsEvent[]; rest: Buffer<ArrayBuffer> } {
  const events: WsEvent[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset] ?? 0;
    const b1 = buffer[offset + 1] ?? 0;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let headerLen = 2;
    if (length === 126) {
      if (buffer.length < offset + 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (length === 127) {
      if (buffer.length < offset + 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(65536)) {
        events.push({ type: 'close' });
        return { events, rest: Buffer.alloc(0) };
      }
      length = Number(big);
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + length;
    if (buffer.length < offset + total) break;
    const data = Buffer.alloc(length);
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const start = offset + headerLen + 4;
      for (let i = 0; i < length; i++) {
        data[i] = (buffer[start + i] ?? 0) ^ (mask[i & 3] ?? 0);
      }
    } else {
      buffer.copy(data, 0, offset + headerLen, offset + headerLen + length);
    }
    if (opcode === 0x8) events.push({ type: 'close' });
    else if (opcode === 0x9 && fin) events.push({ type: 'ping', payload: data });
    else if (opcode === 0xA && fin) events.push({ type: 'pong' });
    else if (opcode === 0x1 && fin) events.push({ type: 'text', text: data.toString('utf8') });
    offset += total;
  }
  return { events, rest: bytesFrom(buffer.subarray(offset)) };
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function configurePort(path: string, baud: number): Promise<void> {
  const flag = process.platform === 'darwin' ? '-f' : '-F';
  const args = [
    flag,
    path,
    String(baud),
    'raw',
    '-echo',
    '-hupcl',
    'cs8',
    '-cstopb',
    '-parenb',
  ];
  return new Promise((resolve) => {
    execFile('stty', args, (err) => {
      if (err) {
        log(`stty could not set ${path} (${err.message}); continuing`);
      }
      resolve();
    });
  });
}

function openSerial(path: string): number {
  return openSync(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
}

async function startBridge(opts: Options): Promise<BridgeHandle> {
  const commands: string[] = [];
  const clients = new Set<Socket>();
  let mode: BridgeMode = opts.simulate
    ? 'simulate'
    : opts.udpHost || opts.udpListen
      ? 'udp'
      : opts.port
        ? 'serial'
        : 'simulate';
  let fd: number | null = null;
  let udp: UdpSocket | null = null;
  /** Where hello and commands go. Null in --udp-listen mode until the beacon arrives. */
  let udpPeer: string | null = opts.udpHost ?? null;
  let lastUdpMs = 0;
  let udpStale = false;
  let helloTimer: ReturnType<typeof setInterval> | null = null;
  let running = true;
  let frames = 0;
  let stopTicker: (() => void) | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const sendUdpLine = (line: string): void => {
    if (!udp || !udpPeer) return;
    const payload = Buffer.from(`${line}\n`);
    udp.send(payload, opts.udpPort, udpPeer, (err) => {
      if (err) log(`UDP send failed (${err.message})`, opts.quiet);
    });
  };

  const broadcast = (text: string): void => {
    frames++;
    const packet = encodeText(text);
    for (const socket of clients) {
      if (socket.destroyed || !socket.writable) {
        clients.delete(socket);
        continue;
      }
      socket.write(packet);
    }
  };

  const ensureSim = (): void => {
    if (stopTicker) return;
    mode = 'simulate';
    let tick = 0;
    let next = Date.now() + FRAME_MS;
    let timer: ReturnType<typeof setTimeout>;
    const step = (): void => {
      if (!running) return;
      broadcast(formatFrame(simulateFrame(tick)));
      tick++;
      next += FRAME_MS;
      if (Date.now() - next > FRAME_MS) next = Date.now() + FRAME_MS;
      timer = setTimeout(step, Math.max(0, next - Date.now()));
    };
    timer = setTimeout(step, FRAME_MS);
    stopTicker = () => {
      clearTimeout(timer);
    };
  };

  const writeCommand = (line: string): void => {
    commands.push(line);
    log(`-> ${line}`, opts.quiet);
    if (mode === 'udp') {
      sendUdpLine(line);
      return;
    }
    if (fd === null) return;
    const data = Buffer.from(`${line}\n`);
    try {
      writeSync(fd, data);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return;
      log(`serial write failed (${code ?? 'unknown'})`);
    }
  };

  const onClientText = (text: string): void => {
    for (const piece of text.split(/\r?\n/)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        log('ignored a client message that was not JSON', opts.quiet);
        continue;
      }
      const command = parseCommand(parsed);
      const line = command ? formatCommand(command) : null;
      if (!line) {
        log('ignored a client message that was not a glove command', opts.quiet);
        continue;
      }
      writeCommand(line);
    }
  };

  const attachClient = (socket: Socket, head: Buffer): void => {
    socket.setNoDelay(true);
    clients.add(socket);
    let pending = Buffer.from(head);
    const consume = (): void => {
      const decoded = decodeFrames(pending);
      pending = bytesFrom(decoded.rest);
      for (const event of decoded.events) {
        if (event.type === 'close') {
          if (!socket.destroyed) socket.end(encodeClose());
          return;
        }
        if (event.type === 'ping') {
          if (!socket.destroyed) socket.write(encodePong(event.payload));
          continue;
        }
        if (event.type === 'text') onClientText(event.text);
      }
    };
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      consume();
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {
      clients.delete(socket);
      socket.destroy();
    });
    if (pending.length > 0) consume();
  };

  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `Once Upon a Memory glove bridge (${req.method ?? 'GET'}). Connect with WebSocket on this port.\n`,
    );
  });

  server.on('upgrade', (req, socket, head) => {
    const key = headerValue(req, 'sec-websocket-key');
    const upgrade = headerValue(req, 'upgrade').toLowerCase();
    const version = headerValue(req, 'sec-websocket-version');
    if (!key || upgrade !== 'websocket' || (version && version !== '13')) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );
    attachClient(socket as Socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.wsPort, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('WebSocket server did not bind a TCP port');
  }

  if (mode === 'udp') {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    udp = sock;
    sock.on('message', (msg: Buffer, rinfo) => {
      if (!udpPeer) {
        udpPeer = rinfo.address;
        log(`found the glove at ${udpPeer}; subscribing`, opts.quiet);
        sendUdpLine('{"cmd":"hello"}');
      } else if (opts.udpListen && rinfo.address !== udpPeer) {
        return;
      }
      lastUdpMs = Date.now();
      if (udpStale) {
        udpStale = false;
        log(`UDP frames from ${udpPeer} resumed`, opts.quiet);
      }
      for (const piece of msg.toString('utf8').split(/\r?\n/)) {
        const line = piece.trim();
        if (line.startsWith('{')) broadcast(line);
      }
    });
    sock.on('error', (err) => {
      log(`UDP error (${err.message})`, opts.quiet);
    });
    const bindPort = opts.udpListen ? opts.udpPort : 0;
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(bindPort, () => {
        sock.off('error', reject);
        resolve();
      });
    });
    const keepAlive = (): void => {
      if (lastUdpMs && !udpStale && Date.now() - lastUdpMs > UDP_STALE_MS) {
        udpStale = true;
        log(`no UDP frames from ${udpPeer ?? 'the glove'} for ${UDP_STALE_MS / 1000}s; still saying hello`, opts.quiet);
      }
      sendUdpLine('{"cmd":"hello"}');
    };
    keepAlive();
    helloTimer = setInterval(keepAlive, UDP_HELLO_MS);
    if (udpPeer) {
      log(`UDP peer ${udpPeer}:${opts.udpPort} (hello every ${UDP_HELLO_MS / 1000}s)`, opts.quiet);
    } else {
      log(`listening on UDP :${sock.address().port} for the glove's broadcast beacon`, opts.quiet);
    }
  } else if (mode === 'serial' && opts.port) {
    const serialPath = opts.port;
    try {
      // The R4 WiFi's USB-C is the ESP32-S3 bridging a real UART, so the baud rate matters.
      // macOS resets termios on the last close, so stty must run while this fd holds the port.
      fd = openSerial(serialPath);
      await configurePort(serialPath, opts.baud);
      log(`opened ${serialPath} at ${opts.baud} baud`, opts.quiet);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const hint =
        code === 'EACCES'
          ? ' Add your user to the dialout group (sudo usermod -aG dialout $USER) and log in again.'
          : '';
      throw new Error(`Could not open ${serialPath}: ${code ?? (err as Error).message}.${hint}`);
    }

    const owned = fd;
    void (async () => {
      const buf = Buffer.alloc(2048);
      let pending = '';
      while (running && fd === owned) {
        let n = 0;
        try {
          n = readSync(owned, buf, 0, buf.length, null);
        } catch (err) {
          if (!running) return;
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
            await sleep(5);
            continue;
          }
          log(`serial disconnected (${code ?? 'unknown'})`, opts.quiet);
          try {
            closeSync(owned);
          } catch {
            // The descriptor is already gone.
          }
          if (fd === owned) fd = null;
          ensureSim();
          return;
        }
        if (n <= 0) {
          await sleep(5);
          continue;
        }
        pending += buf.toString('utf8', 0, n);
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          const line = pending.slice(0, nl).replace(/\r$/, '').trim();
          pending = pending.slice(nl + 1);
          if (line.startsWith('{')) broadcast(line);
          nl = pending.indexOf('\n');
        }
        if (pending.length > 8192) pending = '';
      }
    })();
  } else {
    if (!opts.simulate && !opts.port) {
      log('no USB serial port found; streaming a simulated glove at 50 Hz', opts.quiet);
    } else {
      log('streaming a simulated glove at 50 Hz', opts.quiet);
    }
    ensureSim();
  }

  if (!opts.quiet) {
    statusTimer = setInterval(() => {
      log(`frames=${frames} clients=${clients.size} mode=${mode}`);
    }, 2000);
  }

  return {
    port: address.port,
    mode,
    commands,
    stop: async () => {
      running = false;
      if (stopTicker) stopTicker();
      if (statusTimer) clearInterval(statusTimer);
      if (helloTimer) clearInterval(helloTimer);
      if (udp) {
        await new Promise<void>((resolve) => {
          udp!.close(() => resolve());
        });
        udp = null;
      }
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Already closed by the reader.
        }
        fd = null;
      }
      for (const socket of clients) socket.destroy();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function maskClientText(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error('test payload too long for a 1-byte length');
  const mask = randomBytes(4);
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  header[1] = 0x80 | payload.length;
  const body = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    body[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  }
  return Buffer.concat([header, mask, body]);
}

function assertFrame(frame: GloveSensorFrame): void {
  assert(frame.dial === 0 || frame.dial === 1 || frame.dial === 2, 'dial slot');
  assert(frame.btn === 0 || frame.btn === 1, 'btn');
  assert(typeof frame.fist === 'boolean', 'fist');
  assert(
    frame.swipe === 'none' ||
      frame.swipe === 'left' ||
      frame.swipe === 'right' ||
      frame.swipe === 'thrust',
    'swipe',
  );
  assert(frame.accel >= 1 && frame.accel <= 1.5, 'accel range');
  assert(typeof frame.parry === 'boolean', 'parry');
  assert(typeof frame.armed === 'boolean', 'armed');
  assert(Number.isInteger(frame.noise) && frame.noise >= 0 && frame.noise <= 1023, 'noise');
  assert(
    frame.color === 'none' ||
      frame.color === 'ember' ||
      frame.color === 'frost' ||
      frame.color === 'bloom' ||
      frame.color === 'boss',
    'color',
  );
}

function testSimulator(): void {
  const swipes = new Set<Swipe>();
  const colors = new Set<TokenColor>();
  const dials = new Set<number>();
  let sawBtn = false;
  let sawFist = false;
  let sawParry = false;
  for (let tick = 0; tick < 2500; tick++) {
    const frame = simulateFrame(tick);
    assertFrame(frame);
    const text = formatFrame(frame);
    assert(/"accel":\d+\.\d{2}/.test(text), 'accel has two decimals');
    const parsed = JSON.parse(text) as GloveSensorFrame;
    assert(parsed.swipe === frame.swipe, 'format round-trip swipe');
    assert(parsed.dial === frame.dial, 'format round-trip dial');
    assert(Math.abs(parsed.accel - Number(frame.accel.toFixed(2))) < 0.001, 'accel round-trip');
    swipes.add(frame.swipe);
    colors.add(frame.color);
    dials.add(frame.dial);
    if (frame.btn === 1) sawBtn = true;
    if (frame.fist) sawFist = true;
    if (frame.parry) sawParry = true;
  }
  for (const swipe of ['none', 'left', 'right', 'thrust'] as const) {
    assert(swipes.has(swipe), `simulator produced ${swipe}`);
  }
  for (const color of COLORS) assert(colors.has(color), `simulator produced ${color}`);
  assert(dials.has(0) && dials.has(1) && dials.has(2), 'simulator walks every dial slot');
  assert(sawBtn && sawFist && sawParry, 'simulator presses, fists, and parries');
  assert(powerFromDynamicG(0) === 1, 'rest power is 1');
  assert(powerFromDynamicG(5) === 1.5, 'hard swing power is 1.5');
}

function testCodec(): void {
  const hello = decodeFrames(encodeText('hello'));
  assert(hello.events.length === 1 && hello.events[0]?.type === 'text', 'text event');
  assert(hello.events[0]?.type === 'text' && hello.events[0].text === 'hello', 'text payload');
  assert(hello.rest.length === 0, 'no leftover');

  const long = 'x'.repeat(200);
  const longDecoded = decodeFrames(encodeText(long));
  assert(
    longDecoded.events[0]?.type === 'text' && longDecoded.events[0].text === long,
    '16-bit length',
  );

  const partial = encodeText('hello').subarray(0, 1);
  const incomplete = decodeFrames(partial);
  assert(incomplete.events.length === 0 && incomplete.rest.length === 1, 'partial header');

  const masked = decodeFrames(maskClientText('{"cmd":"hello"}'));
  assert(
    masked.events[0]?.type === 'text' && masked.events[0].text === '{"cmd":"hello"}',
    'masked client frame',
  );

  assert(formatCommand(parseCommand({ cmd: 'arm', open: false })!) === '{"cmd":"arm","open":false}', 'arm command');
  assert(
    formatCommand(parseCommand({ cmd: 'lcd', l1: 'WARD SHATTERED!!!', l2: 'café', r: 300, g: 80, b: -1, ms: 0 })!) ===
      '{"cmd":"lcd","l1":"WARD SHATTERED!!","l2":"caf?","r":255,"g":80,"b":0,"ms":0}',
    'lcd command is fitted to the 16x2 screen',
  );
  assert(formatCommand(parseCommand({ cmd: 'lcd', l1: 'HI' })!) === '{"cmd":"lcd","l1":"HI","l2":""}', 'lcd without rgb');
  assert(
    formatCommand(parseCommand({ cmd: 'wifi', ssid: ' iPhone ', pass: 'pw' })!) ===
      '{"cmd":"wifi","ssid":"iPhone","pass":"pw"}',
    'wifi join',
  );
  assert(formatCommand(parseCommand({ cmd: 'wifi' })!) === '{"cmd":"wifi"}', 'wifi status');
  assert(parseCommand({ cmd: 'calibrate' }) === null, 'calibrate is gone with the light sensor');
  assert(parseCommand({ cmd: 'arm', open: 'yes' }) === null, 'arm needs a boolean');

  const pinned = formatFrame({ ...simulateFrame(0), btn2: 1, d3: 0, d4: 1, d8: 1, rawDial: 512 });
  assert(
    pinned.startsWith('{"dial":0,"btn":0,"btn2":1,"fist":') && pinned.endsWith(',"d3":0,"d4":1,"d8":1,"rawDial":512}'),
    'pin fields follow the firmware key order',
  );

  const ping = decodeFrames(encodeFrame(0x9, Buffer.from('zz')));
  assert(ping.events[0]?.type === 'ping', 'ping opcode');

  const key = acceptKey('dGhlIHNhbXBsZSBub25jZQ==');
  assert(key === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC6455 accept key');
}

function testArgs(): void {
  const opts = parseArgs(['--port', '/dev/ttyACM0', '--baud', '115200', '--ws-port', '0']);
  assert(opts.port === '/dev/ttyACM0', 'port flag');
  assert(opts.wsPort === 0, 'ephemeral ws port');
  assert(opts.baud === 115200, 'baud flag');
  let threw = false;
  try {
    parseArgs(['--nope']);
  } catch {
    threw = true;
  }
  assert(threw, 'unknown flag throws');

  const udp = parseArgs(['--udp', '172.20.10.4', '--udp-port', '4211']);
  assert(udp.udpHost === '172.20.10.4' && udp.udpPort === 4211 && !udp.udpListen, 'udp flags');
  assert(parseArgs(['--udp-listen']).udpListen, 'udp listen flag');
  for (const bad of [
    ['--udp', '1.2.3.4', '--port', '/dev/ttyACM0'],
    ['--udp-listen', '--simulate'],
    ['--udp', '1.2.3.4', '--udp-port', '0'],
  ]) {
    let rejected = false;
    try {
      parseArgs(bad);
    } catch {
      rejected = true;
    }
    assert(rejected, `rejects ${bad.join(' ')}`);
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const step = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(step, 10);
    };
    step();
  });
}

function testOptions(patch: Partial<Options>): Options {
  return {
    udpListen: false,
    udpPort: DEFAULT_UDP_PORT,
    baud: DEFAULT_BAUD,
    wsPort: 0,
    host: '127.0.0.1',
    simulate: false,
    list: false,
    selfTest: false,
    help: false,
    quiet: true,
    ...patch,
  };
}

/** A raw WebSocket client against the bridge: collects text messages, sends masked ones. */
async function openTestClient(port: number): Promise<{
  texts: string[];
  drain: () => void;
  send: (text: string) => void;
  close: () => void;
}> {
  const key = randomBytes(16).toString('base64');
  const socket = connect(port, '127.0.0.1');
  const received: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => resolve());
  });
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  let buffered = Buffer.alloc(0);
  let upgraded = false;
  const texts: string[] = [];
  const drain = (): void => {
    if (received.length) buffered = Buffer.concat([buffered, ...received.splice(0)]);
    if (!upgraded) {
      const marker = buffered.indexOf('\r\n\r\n');
      if (marker < 0) return;
      assert(buffered.subarray(0, marker).toString('utf8').startsWith('HTTP/1.1 101'), 'switching protocols');
      buffered = Buffer.from(buffered.subarray(marker + 4));
      upgraded = true;
    }
    const decoded = decodeFrames(buffered);
    buffered = bytesFrom(decoded.rest);
    for (const event of decoded.events) if (event.type === 'text') texts.push(event.text);
  };
  await waitFor(
    () => {
      drain();
      return upgraded;
    },
    1000,
    'websocket upgrade',
  );
  return { texts, drain, send: (text) => socket.write(maskClientText(text)), close: () => socket.end() };
}

/** A fake glove on 127.0.0.1: answers hello with frames and records every command line. */
async function testUdpLoopback(): Promise<void> {
  const board = createSocket('udp4');
  const boardLines: string[] = [];
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  board.on('message', (msg, rinfo) => {
    for (const line of msg.toString('utf8').split(/\r?\n/)) if (line.trim()) boardLines.push(line.trim());
    if (frameTimer) return;
    let tick = 0;
    frameTimer = setInterval(() => {
      board.send(Buffer.from(`${formatFrame(simulateFrame(tick++))}\n`), rinfo.port, rinfo.address);
    }, FRAME_MS);
  });
  await new Promise<void>((resolve) => board.bind(0, '127.0.0.1', () => resolve()));
  const boardPort = board.address().port;

  const bridge = await startBridge(testOptions({ udpHost: '127.0.0.1', udpPort: boardPort }));
  try {
    assert(bridge.mode === 'udp', 'bridge runs in udp mode');
    await waitFor(() => boardLines.includes('{"cmd":"hello"}'), 1000, 'udp hello');
    const client = await openTestClient(bridge.port);
    await waitFor(
      () => {
        client.drain();
        return client.texts.length >= 2;
      },
      1000,
      'udp frames on the websocket',
    );
    const frame = JSON.parse(client.texts[0] ?? '') as GloveSensorFrame;
    assertFrame(frame);
    assert(typeof frame.rawDial === 'number' && typeof frame.btn2 === 'number', 'pin fields survive the bridge');

    client.send('{"cmd":"lcd","l1":"BRIDGE","l2":"OVER UDP","r":0,"g":200,"b":255}');
    client.send('{"cmd":"buzz","p":"hit"}');
    await waitFor(() => boardLines.includes('{"cmd":"buzz","p":"hit"}'), 1000, 'udp commands');
    assert(
      boardLines.includes('{"cmd":"lcd","l1":"BRIDGE","l2":"OVER UDP","r":0,"g":200,"b":255}'),
      'lcd forwarded over udp',
    );
    client.close();
  } finally {
    if (frameTimer) clearInterval(frameTimer);
    await bridge.stop();
    await new Promise<void>((resolve) => board.close(() => resolve()));
  }
}

async function testLoopback(): Promise<void> {
  const bridge = await startBridge(testOptions({ simulate: true }));
  try {
    assert(bridge.mode === 'simulate', 'self-test bridge simulates');
    const key = randomBytes(16).toString('base64');
    const socket = connect(bridge.port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => resolve());
    });
    socket.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    let buffered = Buffer.alloc(0);
    let header = '';
    await waitFor(
      () => {
        if (received.length) buffered = Buffer.concat([buffered, ...received.splice(0)]);
        const marker = buffered.indexOf('\r\n\r\n');
        if (marker < 0) return false;
        header = buffered.subarray(0, marker).toString('utf8');
        buffered = Buffer.from(buffered.subarray(marker + 4));
        return true;
      },
      1000,
      'websocket upgrade',
    );
    assert(header.startsWith('HTTP/1.1 101'), 'switching protocols');
    assert(header.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`), 'accept key echoed');

    let frameText = '';
    await waitFor(
      () => {
        if (received.length) buffered = Buffer.concat([buffered, ...received.splice(0)]);
        const decoded = decodeFrames(buffered);
        buffered = bytesFrom(decoded.rest);
        const text = decoded.events.find((event) => event.type === 'text');
        if (!text || text.type !== 'text') return false;
        frameText = text.text;
        return true;
      },
      1000,
      'simulated frame',
    );
    const frame = JSON.parse(frameText) as GloveSensorFrame;
    assertFrame(frame);

    socket.write(maskClientText('{"cmd":"buzz","p":"nope"}'));
    socket.write(maskClientText('{"cmd":"buzz","p":"cast"}'));
    socket.write(maskClientText('{"cmd":"servo","open":true}'));
    socket.write(maskClientText('{"cmd":"wifi","ssid":"iPhone","pass":"pw"}'));
    await waitFor(() => bridge.commands.includes('{"cmd":"wifi","ssid":"iPhone","pass":"pw"}'), 1000, 'commands');
    assert(!bridge.commands.some((line) => line.includes('nope')), 'bad pattern dropped');
    assert(bridge.commands.includes('{"cmd":"buzz","p":"cast"}'), 'buzz forwarded');
    assert(bridge.commands.includes('{"cmd":"servo","open":true}'), 'servo forwarded');

    // Client pings are masked. Build one the same way as text, opcode 0x9.
    const pingPayload = Buffer.from('hi');
    const mask = Buffer.from([9, 8, 7, 6]);
    const pingHeader = Buffer.alloc(2);
    pingHeader[0] = 0x89;
    pingHeader[1] = 0x80 | pingPayload.length;
    const pingBody = Buffer.alloc(pingPayload.length);
    for (let i = 0; i < pingPayload.length; i++) {
      pingBody[i] = (pingPayload[i] ?? 0) ^ (mask[i & 3] ?? 0);
    }
    socket.write(Buffer.concat([pingHeader, mask, pingBody]));
    await waitFor(
      () => {
        if (received.length) buffered = Buffer.concat([buffered, ...received.splice(0)]);
        const decoded = decodeFrames(buffered);
        buffered = bytesFrom(decoded.rest);
        return decoded.events.some((event) => event.type === 'pong');
      },
      1000,
      'pong',
    );
    socket.end();
  } finally {
    await bridge.stop();
  }
}

async function runSelfTest(): Promise<void> {
  testArgs();
  testCodec();
  testSimulator();
  await testLoopback();
  await testUdpLoopback();
  console.log('[glove-bridge] self-test passed');
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[glove-bridge] ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.list) {
    const ports = findPorts();
    if (ports.length === 0) console.log('No Arduino serial ports found (/dev/ttyACM*, /dev/cu.usbmodem*).');
    else for (const port of ports) console.log(port);
    return;
  }
  if (opts.selfTest) {
    await runSelfTest();
    return;
  }

  if (!opts.simulate && !opts.udpHost && !opts.udpListen && !opts.port) {
    const found = findPorts();
    if (found.length === 0) {
      opts.simulate = true;
    } else {
      opts.port = found[0];
      if (found.length > 1) {
        log(`several ports found (${found.join(', ')}); using ${opts.port}`);
      }
    }
  }

  const bridge = await startBridge(opts);
  log(`WebSocket on ws://${opts.host}:${bridge.port} (${bridge.mode})`);

  const shutdown = async (): Promise<void> => {
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((err: unknown) => {
  console.error('[glove-bridge] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
