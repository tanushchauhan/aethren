import { CLOCK_SYNC_INTERVAL_MS, type ClockPong } from './contract';

const OFFSET_WINDOW = 7;

export interface ClockSocket {
  connected: boolean;
  emit(event: 'clock:ping', payload: { clientSendMs: number }): void;
}

let offsetMs = 0;
const samples: number[] = [];
let timer: number | null = null;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * NTP offset: ((serverRecv - clientSend) + (serverSend - clientRecv)) / 2.
 * Positive means the server clock is ahead of this laptop.
 */
export function noteClockPong(pong: ClockPong): number {
  const clientRecvMs = Date.now();
  const offset = (pong.serverRecvMs - pong.clientSendMs + (pong.serverSendMs - clientRecvMs)) / 2;
  if (!Number.isFinite(offset)) return offsetMs;

  samples.push(offset);
  if (samples.length > OFFSET_WINDOW) samples.shift();
  offsetMs = median(samples);
  return offsetMs;
}

export function getServerTimeOffsetMs(): number {
  return offsetMs;
}

export function getServerNow(): number {
  return Date.now() + offsetMs;
}

export function startClockSync(socket: ClockSocket): void {
  stopClockSync();
  const sendPing = () => {
    if (!socket.connected) return;
    socket.emit('clock:ping', { clientSendMs: Date.now() });
  };
  sendPing();
  timer = window.setInterval(sendPing, CLOCK_SYNC_INTERVAL_MS);
}

export function stopClockSync(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

export function resetClock(): number {
  stopClockSync();
  samples.length = 0;
  offsetMs = 0;
  return 0;
}
