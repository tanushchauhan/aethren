/**
 * Spellbearer glove controller.
 *
 * 1. Web Serial (`navigator.serial`) at {@link SERIAL_BAUD} when Chrome or Edge can see the Uno R4.
 * 2. Local bridge at {@link SERIAL_BRIDGE_URL} (`firmware/serial-bridge.ts`) for other browsers,
 *    or when the glove streams wirelessly over Wi-Fi UDP (`--udp <arduino-ip>`).
 * 3. Keyboard and on-screen simulator when no board is attached. This is the default.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCEL_POWER,
  DIAL_SLOT_COUNT,
  FIST_CHARGE_MULTIPLIER,
  GLOVE_POLL_HZ,
  SERIAL_BAUD,
  SERVO_ANGLE,
} from '@aethren/shared';
import type {
  BuzzPattern,
  GloveCommand,
  GloveSensorFrame,
  HardwareCommand,
  HardwareEvent,
  P0ElementType,
} from '@aethren/shared';
import {
  DEFAULT_GLOVE_FRAME,
  GloveEdgeTracker,
  LineBufferProcessor,
  buildLcdCommand,
  buildWifiCommand,
  createIdleGloveEdges,
  elementForDialSlot,
  normalizeGloveCommand,
  normalizeWireChunk,
  serializeGloveCommand,
  toHardwareEvent,
} from './serialProtocol';
import type { GloveEdges, GloveLcdMessage, GloveWifiStatus, SwipeRelease } from './serialProtocol';
import { GloveSoundSynthesizer } from './soundSynthesizer';

export const SERIAL_BRIDGE_URL = 'ws://localhost:8765';

export const SIMULATOR_HOTKEYS: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: '1 / 2 / 3', action: 'Turn the rotary dial to Ember, Frost, or Bloom and play the tick buzzer' },
  { keys: '[ / ]', action: 'Step the rotary dial backward or forward and play the tick buzzer' },
  { keys: 'Hold E', action: 'D4 Button 1 — hold opens push-to-talk (a short tap also locks the element)' },
  { keys: 'L', action: 'D8 Button 2 — click locks the element under the dial' },
  { keys: 'Hold F', action: `D8 Button 2 held — charge the spell (fist, ${FIST_CHARGE_MULTIPLIER}× power)` },
  { keys: 'Arrow Left / Right / Up', action: 'I2C accelerometer swipe left, swipe right, or thrust (speed 1.0×–1.5×)' },
  { keys: 'Q', action: 'D3 touch sensor — parry a projectile' },
  { keys: 'C', action: 'Cycle the color token: none → ember → frost → bloom → boss (simulator only)' },
  { keys: 'M', action: 'Arm / disarm the glove (sends {"cmd":"arm"} to a live board)' },
];

export type HardwareLinkMode = 'simulator' | 'web-serial' | 'ws-bridge';
export type HardwareConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface UseGloveHardwareOptions {
  bridgeUrl?: string;
  /** Fires with each applied frame (about 50 Hz while a link is streaming). */
  onFrame?: (frame: GloveSensorFrame, event: HardwareEvent) => void;
  /** Fires when a semantic edge changes, including the room-noise level. */
  onEdges?: (edges: GloveEdges, frame: GloveSensorFrame) => void;
  onPushToTalk?: (active: boolean) => void;
}

export interface GloveHardwareController {
  mode: HardwareLinkMode;
  status: HardwareConnectionStatus;
  error: string | null;
  frame: GloveSensorFrame;
  event: HardwareEvent;
  edges: GloveEdges;
  servoOpen: boolean;
  servoAngle: number;
  recentLines: readonly string[];
  sampleHz: number;
  frameCount: number;
  pushToTalk: boolean;
  lockedElement: P0ElementType | null;
  lastRelease: SwipeRelease | null;
  /** True for a short beat after a parry edge so the badge can be seen. */
  parryLit: boolean;
  lastCommand: string | null;
  /** The last custom message sent to the forearm LCD, or null after a clear. */
  lcdMessage: GloveLcdMessage | null;
  /** Latest `{"event":"wifi"}` report from the board (USB serial only). */
  wifiStatus: GloveWifiStatus | null;
  keyboardEnabled: boolean;
  webSerialSupported: boolean;
  simulatorActive: boolean;
  bridgeUrl: string;

  connectSerial: () => Promise<void>;
  disconnectSerial: () => Promise<void>;
  connectBridge: (url?: string) => void;
  disconnectBridge: () => void;
  useSimulator: () => void;
  setBridgeUrl: (url: string) => void;

  setDial: (slot: number) => void;
  stepDial: (delta: number) => void;
  setButton: (pressed: boolean) => void;
  setButton2: (pressed: boolean) => void;
  setFist: (covered: boolean) => void;
  setSwipe: (swipe: GloveSensorFrame['swipe']) => void;
  releaseSwipe: (direction: SwipeRelease['direction']) => void;
  setAccel: (accel: number) => void;
  setParry: (active: boolean) => void;
  tapParry: () => void;
  setArmed: (armed: boolean) => void;
  toggleArmed: () => void;
  setNoise: (noise: number) => void;
  setColor: (color: GloveSensorFrame['color']) => void;
  cycleColor: () => void;

  sendCommand: (cmd: GloveCommand | HardwareCommand) => void;
  setServoOpen: (open: boolean) => void;
  playBuzz: (pattern: BuzzPattern) => void;
  /** Show custom text and an optional RGB backlight on the forearm 16x2 LCD. */
  sendLcd: (message: GloveLcdMessage) => void;
  /** Drop the custom message so the LCD returns to the spell wheel. */
  clearLcd: () => void;
  /** Send hotspot credentials over the open link. An empty SSID asks for status. */
  configureWifi: (ssid: string, pass: string) => void;
  requestWifiStatus: () => void;
  setKeyboardEnabled: (enabled: boolean) => void;
}

interface WebSerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface WebSerialApi {
  requestPort(): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
}

interface SerialSession {
  port: WebSerialPort;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  stopped: boolean;
}

interface SimulatorApi {
  setDial: (slot: number) => void;
  stepDial: (delta: number) => void;
  setButton: (pressed: boolean) => void;
  tapButton2: () => void;
  setFist: (covered: boolean) => void;
  releaseSwipe: (direction: SwipeRelease['direction']) => void;
  tapParry: () => void;
  cycleColor: () => void;
  toggleArmed: () => void;
  unlockAudio: () => void;
}

const COLOR_CYCLE = ['none', 'ember', 'frost', 'bloom', 'boss'] as const satisfies readonly GloveSensorFrame['color'][];
const SWIPE_VALUES = ['none', 'left', 'right', 'thrust'] as const satisfies readonly GloveSensorFrame['swipe'][];
const LOG_LIMIT = 8;
const PARRY_LAMP_MS = 520;
const SWIPE_PULSE_MS = 140;
const PARRY_PULSE_MS = 120;
const LOCK_PULSE_MS = 120;

const IDLE_API: SimulatorApi = {
  setDial: () => undefined,
  stepDial: () => undefined,
  setButton: () => undefined,
  tapButton2: () => undefined,
  setFist: () => undefined,
  releaseSwipe: () => undefined,
  tapParry: () => undefined,
  cycleColor: () => undefined,
  toggleArmed: () => undefined,
  unlockAudio: () => undefined,
};

function getWebSerial(): WebSerialApi | null {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return null;
  const candidate: unknown = (navigator as Navigator & { serial?: unknown }).serial;
  if (typeof candidate !== 'object' || candidate === null) return null;
  if (!('requestPort' in candidate) || !('getPorts' in candidate)) return null;
  const requestPort: unknown = candidate.requestPort;
  const getPorts: unknown = candidate.getPorts;
  if (typeof requestPort !== 'function' || typeof getPorts !== 'function') return null;
  return candidate as WebSerialApi;
}

function isUserCancel(err: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    (err.name === 'NotFoundError' || err.name === 'AbortError')
  );
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function wrapSlot(slot: number, delta: number): number {
  const count = DIAL_SLOT_COUNT;
  return ((slot + delta) % count + count) % count;
}

function nextColor(current: GloveSensorFrame['color']): GloveSensorFrame['color'] {
  const index = COLOR_CYCLE.indexOf(current);
  const next = COLOR_CYCLE[(index + 1) % COLOR_CYCLE.length];
  return next ?? 'none';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useGloveHardware(options?: UseGloveHardwareOptions): GloveHardwareController {
  const [mode, setMode] = useState<HardwareLinkMode>('simulator');
  const [status, setStatus] = useState<HardwareConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<GloveSensorFrame>(DEFAULT_GLOVE_FRAME);
  const [edges, setEdges] = useState<GloveEdges>(createIdleGloveEdges);
  const [servoOpen, setServoOpenState] = useState(false);
  const [recentLines, setRecentLines] = useState<string[]>([]);
  const [sampleHz, setSampleHz] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [pushToTalk, setPushToTalk] = useState(false);
  const [lockedElement, setLockedElement] = useState<P0ElementType | null>(null);
  const [lastRelease, setLastRelease] = useState<SwipeRelease | null>(null);
  const [parryLit, setParryLit] = useState(false);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [lcdMessage, setLcdMessage] = useState<GloveLcdMessage | null>(null);
  const [wifiStatus, setWifiStatus] = useState<GloveWifiStatus | null>(null);
  const [keyboardEnabled, setKeyboardEnabledState] = useState(true);
  const [bridgeUrl, setBridgeUrlState] = useState(options?.bridgeUrl ?? SERIAL_BRIDGE_URL);
  const [webSerialSupported] = useState(() => getWebSerial() !== null);

  const modeRef = useRef(mode);
  const frameRef = useRef(frame);
  const keyboardRef = useRef(keyboardEnabled);
  const bridgeUrlRef = useRef(bridgeUrl);
  const frameSigRef = useRef('');
  const edgeSigRef = useRef('');
  const mountedRef = useRef(true);
  const pttRef = useRef(false);
  const lockedRef = useRef<P0ElementType | null>(null);
  const releaseRef = useRef<SwipeRelease | null>(null);
  const parryLitRef = useRef(false);
  const parryUntilRef = useRef(0);
  const sigRef = useRef('');
  const countRef = useRef(0);
  const sampleTimesRef = useRef<number[]>([]);
  const linesRef = useRef<string[]>([]);
  const lastFlushRef = useRef(0);
  const trackerRef = useRef(new GloveEdgeTracker());
  const wifiListenerRef = useRef<(status: GloveWifiStatus) => void>(() => undefined);
  const linesBufferRef = useRef(new LineBufferProcessor((status) => wifiListenerRef.current(status)));
  const synthRef = useRef<GloveSoundSynthesizer | null>(null);
  const serialRef = useRef<SerialSession | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const encoderRef = useRef(new TextEncoder());
  const swipeTimerRef = useRef(0);
  const parryTimerRef = useRef(0);
  const lockTimerRef = useRef(0);
  const connectLockRef = useRef(false);
  const ingestRef = useRef<(next: GloveSensorFrame, countSample: boolean) => void>(() => undefined);
  const sendCommandRef = useRef<(cmd: GloveCommand | HardwareCommand) => void>(() => undefined);
  const closeSerialRef = useRef<() => Promise<void>>(async () => undefined);
  const closeSocketRef = useRef<() => void>(() => undefined);
  const apiRef = useRef<SimulatorApi>(IDLE_API);
  const onFrameRef = useRef(options?.onFrame);
  const onEdgesRef = useRef(options?.onEdges);
  const onPushToTalkRef = useRef(options?.onPushToTalk);

  if (synthRef.current === null) synthRef.current = new GloveSoundSynthesizer();
  modeRef.current = mode;
  keyboardRef.current = keyboardEnabled;
  bridgeUrlRef.current = bridgeUrl;
  onFrameRef.current = options?.onFrame;
  onEdgesRef.current = options?.onEdges;
  onPushToTalkRef.current = options?.onPushToTalk;
  wifiListenerRef.current = (status) => {
    if (mountedRef.current) setWifiStatus(status);
  };

  const noteSample = (now: number) => {
    countRef.current += 1;
    const times = sampleTimesRef.current;
    times.push(now);
    const cutoff = now - 1000;
    while (times.length > 0 && (times[0] ?? 0) < cutoff) times.shift();
  };

  const pushLine = (next: GloveSensorFrame) => {
    const lines = linesRef.current;
    lines.push(JSON.stringify(next));
    if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  };

  const publish = (next: GloveSensorFrame, nextEdges: GloveEdges) => {
    const signature = JSON.stringify({
      frame: next,
      edges: nextEdges,
      ptt: pttRef.current,
      locked: lockedRef.current,
      release: releaseRef.current,
    });
    if (signature === sigRef.current) return;
    sigRef.current = signature;
    frameRef.current = next;
    setFrame(next);
    setEdges(nextEdges);
    setPushToTalk(pttRef.current);
    setLockedElement(lockedRef.current);
    setLastRelease(releaseRef.current);
  };

  const ingest = (next: GloveSensorFrame, countSample: boolean) => {
    const now = performance.now();
    const nextEdges = trackerRef.current.update(next, now);
    const stored = { ...next };
    frameRef.current = stored;

    let ptt = pttRef.current;
    if (!stored.armed || nextEdges.pushToTalkStop) ptt = false;
    if (stored.armed && nextEdges.pushToTalkStart) ptt = true;
    if (ptt !== pttRef.current) {
      pttRef.current = ptt;
      onPushToTalkRef.current?.(ptt);
    } else {
      pttRef.current = ptt;
    }

    if (nextEdges.buttonClicked || nextEdges.lockPressed) {
      const element = elementForDialSlot(stored.dial);
      if (element) lockedRef.current = element;
    }
    if (nextEdges.swipeReleased) releaseRef.current = nextEdges.swipeReleased;
    if (nextEdges.parryTriggered) {
      parryUntilRef.current = now + PARRY_LAMP_MS;
      if (!parryLitRef.current) {
        parryLitRef.current = true;
        setParryLit(true);
      }
    }
    if (nextEdges.dialChanged) sendCommandRef.current({ cmd: 'buzz', p: 'tick' });

    if (countSample) {
      noteSample(now);
      pushLine(stored);
    }
    const frameSig = JSON.stringify(stored);
    const frameChanged = frameSig !== frameSigRef.current;
    frameSigRef.current = frameSig;
    if (frameChanged || (countSample && modeRef.current !== 'simulator')) {
      onFrameRef.current?.(stored, toHardwareEvent(stored));
    }
    const edgeSig = JSON.stringify(nextEdges);
    if (edgeSig !== edgeSigRef.current) {
      edgeSigRef.current = edgeSig;
      onEdgesRef.current?.(nextEdges, stored);
    }
    publish(stored, nextEdges);
  };
  ingestRef.current = ingest;

  const writeLine = (line: string) => {
    const session = serialRef.current;
    if (session && !session.stopped && modeRef.current === 'web-serial' && session.writer) {
      const writer = session.writer;
      void writer.write(encoderRef.current.encode(line)).catch((err: unknown) => {
        if (session.stopped || !mountedRef.current) return;
        setError(errorText(err, 'Serial write failed'));
      });
    }
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && modeRef.current === 'ws-bridge') {
      socket.send(line);
    }
  };

  const sendCommand = (cmd: GloveCommand | HardwareCommand) => {
    const glove = normalizeGloveCommand(cmd);
    const line = serializeGloveCommand(glove);
    writeLine(line);
    synthRef.current?.playCommand(glove);
    setLastCommand(line.trim());
    if (glove.cmd === 'servo') setServoOpenState(glove.open);
    if (glove.cmd === 'lcd') {
      const hasText = Boolean(glove.l1 || glove.l2);
      const hasRgb = glove.r !== undefined && glove.g !== undefined && glove.b !== undefined;
      setLcdMessage(
        hasText || hasRgb
          ? {
              l1: glove.l1 ?? '',
              l2: glove.l2 ?? '',
              rgb: hasRgb ? [glove.r ?? 0, glove.g ?? 0, glove.b ?? 0] : undefined,
              ms: glove.ms,
            }
          : null,
      );
    }
  };
  sendCommandRef.current = sendCommand;

  const releaseMomentary = () => {
    window.clearTimeout(swipeTimerRef.current);
    window.clearTimeout(parryTimerRef.current);
    window.clearTimeout(lockTimerRef.current);
    const next: GloveSensorFrame = {
      ...frameRef.current,
      btn: 0,
      btn2: 0,
      fist: false,
      swipe: 'none',
      parry: false,
    };
    frameRef.current = next;
    pttRef.current = false;
    trackerRef.current.reset();
    sigRef.current = '';
    frameSigRef.current = '';
    edgeSigRef.current = '';
    setFrame(next);
    setPushToTalk(false);
    setEdges(createIdleGloveEdges());
  };

  const releaseWriter = (session: SerialSession) => {
    const writer = session.writer;
    session.writer = null;
    if (!writer) return;
    try {
      writer.releaseLock();
    } catch {
      // Already released.
    }
  };

  const closeSerial = async () => {
    const session = serialRef.current;
    if (!session) return;
    session.stopped = true;
    releaseWriter(session);
    const reader = session.reader;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The read loop releases the lock and closes the port.
      }
      return;
    }
    serialRef.current = null;
    try {
      await session.port.close();
    } catch {
      // Already closed by unplug or a previous attempt.
    }
  };
  closeSerialRef.current = closeSerial;

  const closeSocket = () => {
    const socket = wsRef.current;
    wsRef.current = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };
  closeSocketRef.current = closeSocket;

  const acceptWireText = (text: string) => {
    const frames = linesBufferRef.current.push(normalizeWireChunk(text));
    for (const wireFrame of frames) ingestRef.current(wireFrame, true);
  };

  const patchSimulator = (partial: Partial<GloveSensorFrame>) => {
    if (modeRef.current !== 'simulator') return;
    ingestRef.current({ ...frameRef.current, ...partial }, false);
  };

  const setDial = (slot: number) => {
    if (!Number.isFinite(slot)) return;
    patchSimulator({ dial: clampNumber(Math.round(slot), 0, DIAL_SLOT_COUNT - 1) });
  };

  const stepDial = (delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    setDial(wrapSlot(frameRef.current.dial, Math.trunc(delta)));
  };

  const setButton = (pressed: boolean) => {
    patchSimulator({ btn: pressed ? 1 : 0, d4: pressed ? 1 : 0 });
  };

  const setButton2 = (pressed: boolean) => {
    patchSimulator({ btn2: pressed ? 1 : 0, d8: pressed ? 1 : 0 });
  };

  const tapButton2 = () => {
    if (modeRef.current !== 'simulator') return;
    window.clearTimeout(lockTimerRef.current);
    setButton2(true);
    lockTimerRef.current = window.setTimeout(() => setButton2(false), LOCK_PULSE_MS);
  };

  const setFist = (covered: boolean) => {
    patchSimulator({ fist: covered });
  };

  const setSwipe = (swipe: GloveSensorFrame['swipe']) => {
    if (!(SWIPE_VALUES as readonly string[]).includes(swipe)) return;
    patchSimulator({ swipe });
  };

  const releaseSwipe = (direction: SwipeRelease['direction']) => {
    if (modeRef.current !== 'simulator') return;
    window.clearTimeout(swipeTimerRef.current);
    ingestRef.current({ ...frameRef.current, swipe: direction }, false);
    swipeTimerRef.current = window.setTimeout(() => {
      if (frameRef.current.swipe === direction) {
        ingestRef.current({ ...frameRef.current, swipe: 'none' }, false);
      }
    }, SWIPE_PULSE_MS);
  };

  const setAccel = (accel: number) => {
    if (!Number.isFinite(accel)) return;
    const clamped = clampNumber(accel, ACCEL_POWER.min, ACCEL_POWER.max);
    patchSimulator({ accel: Math.round(clamped * 100) / 100 });
  };

  const setParry = (active: boolean) => {
    patchSimulator({ parry: active });
  };

  const tapParry = () => {
    if (modeRef.current !== 'simulator') return;
    window.clearTimeout(parryTimerRef.current);
    ingestRef.current({ ...frameRef.current, parry: true }, false);
    parryTimerRef.current = window.setTimeout(() => {
      ingestRef.current({ ...frameRef.current, parry: false }, false);
    }, PARRY_PULSE_MS);
  };

  const setArmed = (armed: boolean) => {
    if (modeRef.current === 'simulator') patchSimulator({ armed });
    else sendCommandRef.current({ cmd: 'arm', open: armed });
  };

  const toggleArmed = () => {
    setArmed(!frameRef.current.armed);
  };

  const setNoise = (noise: number) => {
    if (!Number.isFinite(noise)) return;
    patchSimulator({ noise: Math.round(clampNumber(noise, 0, 1023)) });
  };

  const setColor = (color: GloveSensorFrame['color']) => {
    if (!(COLOR_CYCLE as readonly string[]).includes(color)) return;
    patchSimulator({ color });
  };

  const cycleColor = () => {
    setColor(nextColor(frameRef.current.color));
  };

  const setBridgeUrl = (url: string) => {
    bridgeUrlRef.current = url;
    setBridgeUrlState(url);
  };

  const setKeyboardEnabled = (enabled: boolean) => {
    keyboardRef.current = enabled;
    setKeyboardEnabledState(enabled);
    if (!enabled && modeRef.current === 'simulator') {
      ingestRef.current({ ...frameRef.current, btn: 0, btn2: 0, fist: false }, false);
    }
  };

  const playBuzz = (pattern: BuzzPattern) => {
    sendCommandRef.current({ cmd: 'buzz', p: pattern });
  };

  const setServoOpen = (open: boolean) => {
    sendCommandRef.current({ cmd: 'servo', open });
  };

  const sendLcd = (message: GloveLcdMessage) => {
    sendCommandRef.current(buildLcdCommand(message));
  };

  const clearLcd = () => {
    sendCommandRef.current({ cmd: 'lcd' });
  };

  const configureWifi = (ssid: string, pass: string) => {
    sendCommandRef.current(buildWifiCommand(ssid, pass));
  };

  const requestWifiStatus = () => {
    sendCommandRef.current({ cmd: 'wifi' });
  };

  const useSimulator = () => {
    void closeSerial();
    closeSocket();
    linesBufferRef.current.reset();
    releaseMomentary();
    modeRef.current = 'simulator';
    setMode('simulator');
    setStatus('idle');
    setError(null);
  };

  const disconnectBridge = () => {
    closeSocket();
    linesBufferRef.current.reset();
    releaseMomentary();
    modeRef.current = 'simulator';
    setMode('simulator');
    setStatus('idle');
    setError(null);
  };

  const disconnectSerial = async () => {
    await closeSerial();
    linesBufferRef.current.reset();
    releaseMomentary();
    modeRef.current = 'simulator';
    setMode('simulator');
    setStatus('idle');
    setError(null);
  };

  const connectSerial = async () => {
    if (connectLockRef.current) return;
    connectLockRef.current = true;
    const serial = getWebSerial();
    if (!serial) {
      connectLockRef.current = false;
      setError('This browser has no Web Serial API. Use the keyboard simulator or the local WS bridge.');
      setStatus('error');
      modeRef.current = 'simulator';
      setMode('simulator');
      return;
    }
    setStatus('connecting');
    setError(null);
    void synthRef.current?.resume();
    let port: WebSerialPort | null = null;
    try {
      port = await serial.requestPort();
      if (!mountedRef.current) {
        await port.close().catch(() => undefined);
        return;
      }
      await closeSerial();
      closeSocket();
      linesBufferRef.current.reset();
      releaseMomentary();
      await port.open({ baudRate: SERIAL_BAUD });
      if (!mountedRef.current) {
        await port.close().catch(() => undefined);
        return;
      }
      const session: SerialSession = { port, reader: null, writer: null, stopped: false };
      if (port.writable) session.writer = port.writable.getWriter();
      serialRef.current = session;
      modeRef.current = 'web-serial';
      setMode('web-serial');
      setStatus('connected');
      void readSerial(session);
    } catch (err) {
      if (port && serialRef.current?.port !== port) {
        await port.close().catch(() => undefined);
      }
      if (!mountedRef.current) return;
      modeRef.current = 'simulator';
      setMode('simulator');
      if (isUserCancel(err)) {
        setStatus('idle');
        return;
      }
      setError(errorText(err, 'Web Serial connection failed'));
      setStatus('error');
    } finally {
      connectLockRef.current = false;
    }
  };

  const readSerial = async (session: SerialSession) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let reading = false;
    let failed = false;
    try {
      const readable = session.port.readable;
      if (!readable) {
        if (mountedRef.current) {
          setError('The serial port has no readable stream.');
          modeRef.current = 'simulator';
          setMode('simulator');
          setStatus('error');
        }
        return;
      }
      reader = readable.getReader();
      session.reader = reader;
      reading = true;
      while (!session.stopped) {
        const { value, done } = await reader.read();
        if (done || session.stopped) break;
        if (!value || modeRef.current !== 'web-serial' || serialRef.current !== session) continue;
        const frames = linesBufferRef.current.push(value);
        for (const wireFrame of frames) ingestRef.current(wireFrame, true);
      }
    } catch (err) {
      failed = true;
      if (!session.stopped && mountedRef.current) {
        setError(errorText(err, 'Serial read failed'));
        modeRef.current = 'simulator';
        setMode('simulator');
        setStatus('error');
      }
    } finally {
      session.reader = null;
      if (reader) {
        try {
          reader.releaseLock();
        } catch {
          // cancel() already released the lock.
        }
      }
      releaseWriter(session);
      if (serialRef.current === session) serialRef.current = null;
      try {
        await session.port.close();
      } catch {
        // Already closed or unplugged.
      }
      if (reading && !failed && !session.stopped && mountedRef.current && modeRef.current === 'web-serial') {
        modeRef.current = 'simulator';
        setMode('simulator');
        setStatus('error');
        setError('The serial port closed.');
      }
    }
  };

  const connectBridge = (url?: string) => {
    const target = (url ?? bridgeUrlRef.current).trim() || SERIAL_BRIDGE_URL;
    bridgeUrlRef.current = target;
    setBridgeUrlState(target);
    void closeSerial();
    closeSocket();
    linesBufferRef.current.reset();
    releaseMomentary();
    modeRef.current = 'ws-bridge';
    setMode('ws-bridge');
    setStatus('connecting');
    setError(null);
    void synthRef.current?.resume();

    let socket: WebSocket;
    try {
      socket = new WebSocket(target);
    } catch (err) {
      modeRef.current = 'simulator';
      setMode('simulator');
      setStatus('error');
      setError(errorText(err, `Could not open ${target}`));
      return;
    }
    socket.binaryType = 'arraybuffer';
    wsRef.current = socket;

    socket.onopen = () => {
      if (wsRef.current !== socket || !mountedRef.current) return;
      modeRef.current = 'ws-bridge';
      setMode('ws-bridge');
      setStatus('connected');
      setError(null);
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (wsRef.current !== socket || modeRef.current !== 'ws-bridge') return;
      const data = event.data;
      if (typeof data === 'string') {
        acceptWireText(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        acceptWireText(new TextDecoder().decode(data));
        return;
      }
      if (data instanceof Blob) {
        void data.text().then((text) => {
          if (wsRef.current === socket && modeRef.current === 'ws-bridge') acceptWireText(text);
        });
      }
    };
    socket.onerror = () => {
      if (wsRef.current !== socket || !mountedRef.current) return;
      setError(`Could not reach the serial bridge at ${target}. The keyboard simulator is still live.`);
      setStatus('error');
    };
    socket.onclose = () => {
      if (wsRef.current !== socket || !mountedRef.current) return;
      wsRef.current = null;
      if (modeRef.current !== 'ws-bridge') return;
      modeRef.current = 'simulator';
      setMode('simulator');
      setStatus('error');
    };
  };

  const unlockAudio = () => {
    void synthRef.current?.resume();
  };

  apiRef.current = {
    setDial,
    stepDial,
    setButton,
    tapButton2,
    setFist,
    releaseSwipe,
    tapParry,
    cycleColor,
    toggleArmed,
    unlockAudio,
  };

  const flushInspector = () => {
    const now = performance.now();
    if (parryLitRef.current && now >= parryUntilRef.current) {
      parryLitRef.current = false;
      setParryLit(false);
    }
    if (now - lastFlushRef.current < 100) return;
    lastFlushRef.current = now;
    const cutoff = now - 1000;
    const times = sampleTimesRef.current;
    while (times.length > 0 && (times[0] ?? 0) < cutoff) times.shift();
    setSampleHz(times.length);
    setFrameCount(countRef.current);
    setRecentLines(linesRef.current.slice());
  };

  useEffect(() => {
    const period = Math.round(1000 / GLOVE_POLL_HZ);
    const id = window.setInterval(() => {
      const held = frameRef.current.armed && frameRef.current.btn !== 0;
      if (modeRef.current === 'simulator') {
        ingestRef.current(frameRef.current, true);
      } else if (held) {
        ingestRef.current(frameRef.current, false);
      }
      flushInspector();
    }, period);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!keyboardRef.current || modeRef.current !== 'simulator') return;
      if (event.repeat || isEditableTarget(event.target)) return;
      const api = apiRef.current;
      const key = event.key;
      const lower = key.toLowerCase();
      if (lower === '1' || lower === '2' || lower === '3') {
        event.preventDefault();
        api.unlockAudio();
        api.setDial(Number(lower) - 1);
        return;
      }
      if (key === '[' || key === ']') {
        event.preventDefault();
        api.unlockAudio();
        api.stepDial(key === '[' ? -1 : 1);
        return;
      }
      if (lower === 'e') {
        event.preventDefault();
        api.unlockAudio();
        api.setButton(true);
        return;
      }
      if (lower === 'f') {
        event.preventDefault();
        api.unlockAudio();
        api.setFist(true);
        return;
      }
      if (lower === 'l') {
        event.preventDefault();
        api.unlockAudio();
        api.tapButton2();
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp') {
        event.preventDefault();
        api.unlockAudio();
        const direction = key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : 'thrust';
        api.releaseSwipe(direction);
        return;
      }
      if (lower === 'q') {
        event.preventDefault();
        api.unlockAudio();
        api.tapParry();
        return;
      }
      if (lower === 'c') {
        event.preventDefault();
        api.unlockAudio();
        api.cycleColor();
        return;
      }
      if (lower === 'm') {
        event.preventDefault();
        api.unlockAudio();
        api.toggleArmed();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (modeRef.current !== 'simulator') return;
      const lower = event.key.toLowerCase();
      if (lower === 'e') apiRef.current.setButton(false);
      if (lower === 'f') apiRef.current.setFist(false);
    };
    const onBlur = () => {
      if (modeRef.current !== 'simulator') return;
      apiRef.current.setButton(false);
      apiRef.current.setFist(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(swipeTimerRef.current);
      window.clearTimeout(parryTimerRef.current);
      window.clearTimeout(lockTimerRef.current);
      void closeSerialRef.current();
      closeSocketRef.current();
      synthRef.current?.dispose();
    };
  }, []);

  const event = useMemo(() => toHardwareEvent(frame), [frame]);
  const servoAngle = servoOpen ? SERVO_ANGLE.open : SERVO_ANGLE.closed;

  return {
    mode,
    status,
    error,
    frame,
    event,
    edges,
    servoOpen,
    servoAngle,
    recentLines,
    sampleHz,
    frameCount,
    pushToTalk,
    lockedElement,
    lastRelease,
    parryLit,
    lastCommand,
    lcdMessage,
    wifiStatus,
    keyboardEnabled,
    webSerialSupported,
    simulatorActive: mode === 'simulator',
    bridgeUrl,
    connectSerial,
    disconnectSerial,
    connectBridge,
    disconnectBridge,
    useSimulator,
    setBridgeUrl,
    setDial,
    stepDial,
    setButton,
    setButton2,
    setFist,
    setSwipe,
    releaseSwipe,
    setAccel,
    setParry,
    tapParry,
    setArmed,
    toggleArmed,
    setNoise,
    setColor,
    cycleColor,
    sendCommand,
    setServoOpen,
    playBuzz,
    sendLcd,
    clearLcd,
    configureWifi,
    requestWifiStatus,
    setKeyboardEnabled,
  };
}

/** Name used in the team plan for this same controller. */
export const useGloveSerial = useGloveHardware;
