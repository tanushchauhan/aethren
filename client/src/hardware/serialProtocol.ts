/**
 * Pure glove wire protocol: newline-delimited JSON at {@link SERIAL_BAUD} over USB,
 * or one JSON object per packet over Wi-Fi UDP {@link GLOVE_UDP_PORT}.
 * Safe to run in Vitest — no Web Serial, WebSocket, or React.
 *
 * Outbound (50 Hz): {"dial":0,"btn":0,"btn2":0,"fist":false,"swipe":"none","accel":1.00,"parry":false,
 *   "armed":true,"noise":0,"color":"none","d3":0,"d4":0,"d8":0,"rawDial":512}
 * Status: {"event":"wifi","status":"connected","ssid":"...","ip":"172.20.10.4","port":4210}
 * Inbound: {"cmd":"buzz","p":"cast"}, {"cmd":"lcd","l1":"...","l2":"...","r":255,"g":80,"b":0},
 *   {"cmd":"wifi","ssid":"...","pass":"..."}, {"cmd":"arm","open":true}, {"cmd":"servo","open":true}, {"cmd":"hello"}
 */

import {
  ACCEL_POWER,
  DIAL_SLOT_COUNT,
  FIST_CHARGE_MULTIPLIER,
  GLOVE_LCD_COLS,
  NOISE_TOO_LOUD_THRESHOLD,
  P0_ELEMENTS,
} from '@once-upon/shared';
import type {
  BuzzPattern,
  GloveCommand,
  GloveSensorFrame,
  HardwareCommand,
  HardwareEvent,
  P0ElementType,
} from '@once-upon/shared';

const SWIPE_VALUES = ['none', 'left', 'right', 'thrust'] as const satisfies readonly GloveSensorFrame['swipe'][];
const COLOR_VALUES = ['none', 'ember', 'frost', 'bloom', 'boss'] as const satisfies readonly GloveSensorFrame['color'][];
const BUZZ_PATTERNS = ['tick', 'cast', 'fizzle', 'hit'] as const satisfies readonly BuzzPattern[];

/** A press shorter than this locks the element. A longer hold is push-to-talk. */
export const BUTTON_CLICK_MAX_MS = 250;

const MAX_PENDING_CHARS = 4096;
const NOISE_MAX = 1023;
const RAW_DIAL_MAX = 1023;
const WIFI_SSID_MAX = 32;
const WIFI_PASS_MAX = 63;
const WIFI_STATUS_VALUES = [
  'off',
  'joining',
  'connected',
  'failed',
  'lost',
  'no-module',
  'udp-failed',
] as const;

/** Backlight per dial slot, the same table the firmware uses. */
export const GLOVE_LCD_ELEMENT_RGB: Readonly<Record<P0ElementType, readonly [number, number, number]>> = {
  ember: [255, 70, 0],
  frost: [30, 180, 255],
  bloom: [40, 255, 110],
};
const GLOVE_LCD_DISARMED_RGB = [40, 40, 40] as const;

export type GloveWifiState = (typeof WIFI_STATUS_VALUES)[number];

/** `{"event":"wifi",...}` line the board prints on USB serial after a `wifi` command. */
export interface GloveWifiStatus {
  status: GloveWifiState;
  ssid: string;
  ip: string;
  port: number;
}

/** A custom forearm LCD message. Missing RGB keeps the element backlight. */
export interface GloveLcdMessage {
  l1: string;
  l2: string;
  rgb?: readonly [number, number, number];
  /** How long the board keeps it. Default 4000; 0 keeps it until replaced. */
  ms?: number;
}

export interface GloveLcdPreview {
  lines: readonly [string, string];
  rgb: readonly [number, number, number];
}

export const DEFAULT_GLOVE_FRAME: GloveSensorFrame = Object.freeze({
  dial: 0,
  btn: 0,
  fist: false,
  swipe: 'none',
  accel: ACCEL_POWER.min,
  parry: false,
  armed: true,
  noise: 96,
  color: 'none',
});

export interface DialChange {
  slot: number;
  element: P0ElementType;
}

export interface SwipeRelease {
  direction: 'left' | 'right' | 'thrust';
  /** `accel * (fist ? FIST_CHARGE_MULTIPLIER : 1)`. */
  power: number;
}

/** Semantic transitions between two 50 Hz frames. Levels that did not change stay null/false. */
export interface GloveEdges {
  dialChanged: DialChange | null;
  buttonClicked: boolean;
  pushToTalkStart: boolean;
  pushToTalkStop: boolean;
  /** Rising edge of D8 Button 2 (`btn2`): lock the element under the dial. */
  lockPressed: boolean;
  parryTriggered: boolean;
  swipeReleased: SwipeRelease | null;
  /** The new token, including `'none'` when the well is cleared. Null when the token did not change. */
  colorTokenChanged: GloveSensorFrame['color'] | null;
  /** Level, not an edge: true while armed and `noise >= NOISE_TOO_LOUD_THRESHOLD`. */
  isRoomTooLoud: boolean;
}

/**
 * Timing for the finger button. Omit it and click / push-to-talk stay false —
 * those need a press duration. {@link GloveEdgeTracker} keeps this for you.
 */
export interface GloveEdgeClock {
  nowMs: number;
  /** `nowMs` when the button went down. Null if the press start was not observed. */
  buttonDownAtMs: number | null;
  pushToTalkActive: boolean;
}

export function createIdleGloveEdges(): GloveEdges {
  return {
    dialChanged: null,
    buttonClicked: false,
    pushToTalkStart: false,
    pushToTalkStop: false,
    lockPressed: false,
    parryTriggered: false,
    swipeReleased: null,
    colorTokenChanged: null,
    isRoomTooLoud: false,
  };
}

export function elementForDialSlot(dial: number): P0ElementType | null {
  const element = P0_ELEMENTS.find((_, index) => index === dial);
  return element ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isSwipe(value: unknown): value is GloveSensorFrame['swipe'] {
  return typeof value === 'string' && (SWIPE_VALUES as readonly string[]).includes(value);
}

function isColor(value: unknown): value is GloveSensorFrame['color'] {
  return typeof value === 'string' && (COLOR_VALUES as readonly string[]).includes(value);
}

function isBuzzPattern(value: unknown): value is BuzzPattern {
  return typeof value === 'string' && (BUZZ_PATTERNS as readonly string[]).includes(value);
}

function readFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readDial(value: unknown): number | null {
  const raw = readFinite(value);
  if (raw === null) return null;
  return Math.round(clamp(raw, 0, DIAL_SLOT_COUNT - 1));
}

function readButton(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const raw = readFinite(value);
  if (raw === null) return null;
  return Math.round(clamp(raw, 0, 1));
}

function readAccel(value: unknown): number | null {
  const raw = readFinite(value);
  if (raw === null) return null;
  const clamped = clamp(raw, ACCEL_POWER.min, ACCEL_POWER.max);
  return Math.round(clamped * 1000) / 1000;
}

function readNoise(value: unknown): number | null {
  const raw = readFinite(value);
  if (raw === null) return null;
  return Math.round(clamp(raw, 0, NOISE_MAX));
}

function readRawDial(value: unknown): number | null {
  const raw = readFinite(value);
  if (raw === null) return null;
  return Math.round(clamp(raw, 0, RAW_DIAL_MAX));
}

/** The optional 7-part debug fields. A missing or malformed one is left out. */
function readPinFields(parsed: Record<string, unknown>): Partial<GloveSensorFrame> {
  const extra: Partial<GloveSensorFrame> = {};
  const btn2 = readButton(parsed.btn2);
  if (btn2 !== null) extra.btn2 = btn2;
  const d3 = readButton(parsed.d3);
  if (d3 !== null) extra.d3 = d3;
  const d4 = readButton(parsed.d4);
  if (d4 !== null) extra.d4 = d4;
  const d8 = readButton(parsed.d8);
  if (d8 !== null) extra.d8 = d8;
  const rawDial = readRawDial(parsed.rawDial);
  if (rawDial !== null) extra.rawDial = rawDial;
  return extra;
}

/**
 * Parse one serial line. Returns null for boot text, partial JSON, and frames
 * whose enums or types are wrong. Numeric sensors are clamped into range:
 * `dial` 0..2, `accel` 1.0..1.5, `noise` 0..1023, `btn` / `btn2` / `d3` / `d4` / `d8` 0..1,
 * `rawDial` 0..1023. The optional pin fields are only present when the board sent them.
 */
export function parseGloveSerialLine(line: string): GloveSensorFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let parsed: unknown;
  try {
    parsed = parseJson(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const dial = readDial(parsed.dial);
  const btn = readButton(parsed.btn);
  const fist = readBool(parsed.fist);
  const accel = readAccel(parsed.accel);
  const parry = readBool(parsed.parry);
  const armed = readBool(parsed.armed);
  const noise = readNoise(parsed.noise);
  if (
    dial === null ||
    btn === null ||
    fist === null ||
    accel === null ||
    parry === null ||
    armed === null ||
    noise === null ||
    !isSwipe(parsed.swipe) ||
    !isColor(parsed.color)
  ) {
    return null;
  }

  return {
    dial,
    btn,
    fist,
    swipe: parsed.swipe,
    accel,
    parry,
    armed,
    noise,
    color: parsed.color,
    ...readPinFields(parsed),
  };
}

/** Parse the board's `{"event":"wifi",...}` status line. Null for anything else. */
export function parseGloveWifiStatus(line: string): GloveWifiStatus | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = parseJson(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.event !== 'wifi') return null;
  const status = parsed.status;
  if (typeof status !== 'string' || !(WIFI_STATUS_VALUES as readonly string[]).includes(status)) return null;
  const port = readFinite(parsed.port);
  return {
    status: status as GloveWifiState,
    ssid: typeof parsed.ssid === 'string' ? parsed.ssid : '',
    ip: typeof parsed.ip === 'string' ? parsed.ip : '0.0.0.0',
    port: port === null ? 0 : Math.round(port),
  };
}

/**
 * A bridge message that is one complete JSON object (no newline yet) is closed
 * so the line buffer can emit it. Partial USB chunks are left untouched.
 */
export function normalizeWireChunk(chunk: string): string {
  if (chunk.includes('\n') || chunk.includes('\r')) return chunk;
  const trimmed = chunk.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return `${trimmed}\n`;
  return chunk;
}

/**
 * Reassembles chunked `ReadableStream` bytes or strings into sensor frames.
 * Malformed lines are skipped so a boot banner cannot desync the next frame.
 * Wi-Fi status lines go to `onWifiStatus` instead of the frame list.
 */
export class LineBufferProcessor {
  private buffer = '';
  private decoder = new TextDecoder();

  constructor(private readonly onWifiStatus?: (status: GloveWifiStatus) => void) {}

  push(chunk: Uint8Array | string): GloveSensorFrame[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    const frames = this.drain();
    if (this.buffer.length > MAX_PENDING_CHARS) {
      // A sensor line is ~120 characters. Anything still pending is noise, not a frame.
      this.buffer = '';
    }
    return frames;
  }

  /** Bytes that have not yet formed a full line. */
  pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.decoder = new TextDecoder();
  }

  private drain(): GloveSensorFrame[] {
    const frames: GloveSensorFrame[] = [];
    while (this.buffer.length > 0) {
      const newlineAt = findLineBreak(this.buffer);
      if (newlineAt < 0) break;
      const line = this.buffer.slice(0, newlineAt);
      let drop = 1;
      const marker = this.buffer[newlineAt];
      if (marker === '\r' && this.buffer[newlineAt + 1] === '\n') drop = 2;
      this.buffer = this.buffer.slice(newlineAt + drop);
      const frame = parseGloveSerialLine(line);
      if (frame) {
        frames.push(frame);
        continue;
      }
      if (this.onWifiStatus) {
        const status = parseGloveWifiStatus(line);
        if (status) this.onWifiStatus(status);
      }
    }
    return frames;
  }
}

function findLineBreak(buffer: string): number {
  const newline = buffer.indexOf('\n');
  const carriage = buffer.indexOf('\r');
  if (newline < 0) return carriage;
  if (carriage < 0) return newline;
  return Math.min(newline, carriage);
}

export function isGloveCommand(cmd: GloveCommand | HardwareCommand): cmd is GloveCommand {
  return 'cmd' in cmd;
}

/**
 * Exactly what the 16x2 LCD will draw for one line: printable ASCII only
 * (anything else becomes `?`, as on the board), cut at 16 characters.
 */
export function fitLcdLine(text: string): string {
  let out = '';
  for (const ch of text) {
    if (out.length >= GLOVE_LCD_COLS) break;
    const code = ch.charCodeAt(0);
    out += ch.length === 1 && code >= 32 && code <= 126 ? ch : '?';
  }
  return out;
}

function clampByte(value: unknown): number {
  const raw = readFinite(value);
  return raw === null ? 0 : Math.round(clamp(raw, 0, 255));
}

/** `{"cmd":"lcd",...}` for a custom forearm message. */
export function buildLcdCommand(message: GloveLcdMessage): GloveCommand {
  const cmd: Extract<GloveCommand, { cmd: 'lcd' }> = {
    cmd: 'lcd',
    l1: fitLcdLine(message.l1),
    l2: fitLcdLine(message.l2),
  };
  if (message.rgb) {
    cmd.r = clampByte(message.rgb[0]);
    cmd.g = clampByte(message.rgb[1]);
    cmd.b = clampByte(message.rgb[2]);
  }
  if (message.ms !== undefined && Number.isFinite(message.ms)) cmd.ms = Math.max(0, Math.round(message.ms));
  return cmd;
}

/** `{"cmd":"wifi",...}`. An empty SSID asks the board for its status instead. */
export function buildWifiCommand(ssid: string, pass: string): GloveCommand {
  const name = ssid.trim().slice(0, WIFI_SSID_MAX);
  if (!name) return { cmd: 'wifi' };
  return { cmd: 'wifi', ssid: name, pass: pass.slice(0, WIFI_PASS_MAX) };
}

/** Map either wire command shape onto the newline JSON the Uno expects. */
export function normalizeGloveCommand(cmd: GloveCommand | HardwareCommand): GloveCommand {
  if (isGloveCommand(cmd)) {
    switch (cmd.cmd) {
      case 'buzz':
        return { cmd: 'buzz', p: isBuzzPattern(cmd.p) ? cmd.p : 'tick' };
      case 'servo':
        return { cmd: 'servo', open: cmd.open === true };
      case 'arm':
        return { cmd: 'arm', open: cmd.open === true };
      case 'hello':
        return { cmd: 'hello' };
      case 'wifi':
        return buildWifiCommand(typeof cmd.ssid === 'string' ? cmd.ssid : '', typeof cmd.pass === 'string' ? cmd.pass : '');
      case 'lcd': {
        const hasRgb = cmd.r !== undefined && cmd.g !== undefined && cmd.b !== undefined;
        return buildLcdCommand({
          l1: typeof cmd.l1 === 'string' ? cmd.l1 : '',
          l2: typeof cmd.l2 === 'string' ? cmd.l2 : '',
          rgb: hasRgb ? [clampByte(cmd.r), clampByte(cmd.g), clampByte(cmd.b)] : undefined,
          ms: cmd.ms,
        });
      }
    }
  }
  if (cmd.type === 'servo') {
    return { cmd: 'servo', open: cmd.servoOpen === true };
  }
  return { cmd: 'buzz', p: isBuzzPattern(cmd.pattern) ? cmd.pattern : 'tick' };
}

/** Newline-terminated JSON, ready to write to USB serial or the local bridge. */
export function serializeGloveCommand(cmd: GloveCommand | HardwareCommand): string {
  return `${JSON.stringify(normalizeGloveCommand(cmd))}\n`;
}

/** Snapshot laptop A forwards on `hardware:event`. `'none'` in the well becomes null. */
export function toHardwareEvent(frame: GloveSensorFrame): HardwareEvent {
  return {
    dialSlot: frame.dial,
    buttonPressed: frame.btn !== 0,
    fistCharged: frame.fist,
    parryTriggered: frame.parry,
    colorToken: frame.color === 'none' ? null : frame.color,
    noiseLevel: frame.noise,
    armed: frame.armed,
  };
}

function padLcd(text: string): string {
  return fitLcdLine(text).padEnd(GLOVE_LCD_COLS, ' ');
}

/**
 * What the forearm LCD shows for this frame, following the firmware's priority:
 * line 1 is the custom text, else LOCKED / WHEEL; line 2 is DISARMED, PARRY,
 * SPEAKING, the custom text, SWIPE, CHARGED, then the button hint.
 */
export function previewGloveLcd(
  frame: GloveSensorFrame,
  options: { custom?: GloveLcdMessage | null; lockedElement?: P0ElementType | null } = {},
): GloveLcdPreview {
  const custom = options.custom ?? null;
  const element = elementForDialSlot(frame.dial) ?? 'ember';
  const name = element.toUpperCase();

  let l1 = `WHEEL: ${name}`;
  if (custom && custom.l1) l1 = custom.l1;
  else if (frame.armed && options.lockedElement === element) l1 = `LOCKED: ${name} *`;

  let l2 = 'D4:TALK  D8:LOCK';
  if (!frame.armed) l2 = 'DISARMED';
  else if (frame.parry) l2 = '!! PARRY !!';
  else if (frame.btn !== 0) l2 = '>> SPEAKING <<';
  else if (custom && custom.l2) l2 = custom.l2;
  else if (frame.swipe !== 'none') l2 = `SWIPE: ${frame.swipe.toUpperCase()}!`;
  else if (frame.fist) l2 = 'CHARGED 1.25x';

  let rgb: readonly [number, number, number] = GLOVE_LCD_ELEMENT_RGB[element];
  if (custom?.rgb) rgb = [clampByte(custom.rgb[0]), clampByte(custom.rgb[1]), clampByte(custom.rgb[2])];
  else if (!frame.armed) rgb = GLOVE_LCD_DISARMED_RGB;

  return { lines: [padLcd(l1), padLcd(l2)], rgb };
}

/** Total spell power for a release: accelerometer, then fist charge. */
export function spellReleasePower(frame: Pick<GloveSensorFrame, 'accel' | 'fist'>): number {
  const accel = clamp(
    Number.isFinite(frame.accel) ? frame.accel : ACCEL_POWER.min,
    ACCEL_POWER.min,
    ACCEL_POWER.max,
  );
  const multiplier = frame.fist ? FIST_CHARGE_MULTIPLIER : 1;
  return accel * multiplier;
}

function isReleaseSwipe(swipe: GloveSensorFrame['swipe']): swipe is SwipeRelease['direction'] {
  return swipe === 'left' || swipe === 'right' || swipe === 'thrust';
}

/**
 * Edges fire only while `next.armed` is true. The forearm switch gates the dial,
 * button, parry, swipe, color token, and the room-noise warning together.
 * Pass `clock` to split a short click from a push-to-talk hold.
 */
export function detectGloveEdges(
  prev: GloveSensorFrame | null,
  next: GloveSensorFrame,
  clock?: GloveEdgeClock,
): GloveEdges {
  if (!next.armed) return createIdleGloveEdges();

  const edges = createIdleGloveEdges();
  const nextElement = elementForDialSlot(next.dial);
  if (prev !== null && prev.dial !== next.dial && nextElement) {
    edges.dialChanged = { slot: next.dial, element: nextElement };
  }

  if (clock) {
    const button = detectButton(prev, next, clock);
    edges.buttonClicked = button.buttonClicked;
    edges.pushToTalkStart = button.pushToTalkStart;
    edges.pushToTalkStop = button.pushToTalkStop;
  }

  const lockWasDown = prev !== null && prev.armed && (prev.btn2 ?? 0) !== 0;
  edges.lockPressed = prev !== null && (next.btn2 ?? 0) !== 0 && !lockWasDown;

  const prevParry = prev !== null && prev.parry;
  edges.parryTriggered = next.parry && !prevParry && prev !== null;

  if (prev !== null && isReleaseSwipe(next.swipe) && prev.swipe !== next.swipe) {
    edges.swipeReleased = {
      direction: next.swipe,
      power: spellReleasePower(next),
    };
  }

  if (prev !== null && prev.color !== next.color) {
    edges.colorTokenChanged = next.color;
  }

  edges.isRoomTooLoud = next.noise >= NOISE_TOO_LOUD_THRESHOLD;
  return edges;
}

function detectButton(
  prev: GloveSensorFrame | null,
  next: GloveSensorFrame,
  clock: GloveEdgeClock,
): Pick<GloveEdges, 'buttonClicked' | 'pushToTalkStart' | 'pushToTalkStop'> {
  const idle = { buttonClicked: false, pushToTalkStart: false, pushToTalkStop: false };
  const isDown = next.btn !== 0;
  const wasDown = prev !== null && prev.armed && prev.btn !== 0;

  if (isDown && wasDown && !clock.pushToTalkActive && clock.buttonDownAtMs !== null) {
    const held = clock.nowMs - clock.buttonDownAtMs;
    if (held >= BUTTON_CLICK_MAX_MS) {
      return { buttonClicked: false, pushToTalkStart: true, pushToTalkStop: false };
    }
  }

  if (!isDown && wasDown) {
    if (clock.pushToTalkActive) {
      return { buttonClicked: false, pushToTalkStart: false, pushToTalkStop: true };
    }
    if (clock.buttonDownAtMs === null) return idle;
    const held = clock.nowMs - clock.buttonDownAtMs;
    if (held < BUTTON_CLICK_MAX_MS) {
      return { buttonClicked: true, pushToTalkStart: false, pushToTalkStop: false };
    }
    return { buttonClicked: false, pushToTalkStart: false, pushToTalkStop: true };
  }

  return idle;
}

/**
 * Remembers the previous frame and when the finger button went down so
 * {@link detectGloveEdges} can tell a tap from a hold at 50 Hz.
 */
export class GloveEdgeTracker {
  private prev: GloveSensorFrame | null = null;
  private buttonDownAtMs: number | null = null;
  private pushToTalkActive = false;

  update(next: GloveSensorFrame, nowMs: number): GloveEdges {
    const edges = detectGloveEdges(this.prev, { ...next }, {
      nowMs,
      buttonDownAtMs: this.buttonDownAtMs,
      pushToTalkActive: this.pushToTalkActive,
    });

    const wasDown = this.prev !== null && this.prev.armed && this.prev.btn !== 0;
    const isDown = next.armed && next.btn !== 0;
    if (!next.armed) {
      this.buttonDownAtMs = null;
      this.pushToTalkActive = false;
    } else {
      if (isDown && !wasDown) this.buttonDownAtMs = nowMs;
      if (!isDown) this.buttonDownAtMs = null;
      if (edges.pushToTalkStart) this.pushToTalkActive = true;
      if (edges.pushToTalkStop) this.pushToTalkActive = false;
    }

    this.prev = { ...next };
    return edges;
  }

  reset(): void {
    this.prev = null;
    this.buttonDownAtMs = null;
    this.pushToTalkActive = false;
  }
}
