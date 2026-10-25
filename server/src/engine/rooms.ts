/**
 * Room codes and seats: who sits where, reserved seats, reconnecting by name, bot seats.
 */
import { randomUUID } from 'node:crypto';
import { ROOM_CODE_LENGTH } from '@once-upon/shared';
import type { JoinableRole, P0ElementType, PlayerRole, PlayerState } from '@once-upon/shared';
import type { DodgeHistoryEntry } from '../contracts';
import type { TimerHandle } from './clock';

/** No I, L or O: letters that are easy to confuse with each other or with digits. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/** P0 is two laptops: one Spellbearer and one Partner. */
export const MAX_SEATS = 2;

export const MAX_NAME_LENGTH = 24;

export function normalizeCode(code: string): string {
  return String(code ?? '').trim().toUpperCase();
}

export function generateCode(taken: (code: string) => boolean, rng: () => number = Math.random): string {
  for (let attempt = 0; ; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
    }
    if (!taken(code)) return code;
    if (attempt > 10_000) throw new Error('No free room codes');
  }
}

export function cleanName(name: unknown, fallback = 'Player'): string {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : '';
  return n || fallback;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** `PlayerState` plus glove fields the contract does not carry yet (see report). */
export type EnginePlayerState = PlayerState & { noiseLevel?: number; gloveArmed?: boolean };

export interface IncantationRecord {
  power: number;
  transcript: string;
  mercy: boolean;
  at: number;
}

export interface Seat {
  player: EnginePlayerState;
  /** Name a human reclaims this seat with (the display name stays the same for bots). */
  humanName: string;
  /** Role restored when a human takes the seat back from a bot. */
  humanRole: JoinableRole;
  socketId: string | null;
  /** True once any socket has sat here (reserved MCP seats start false). */
  everClaimed: boolean;
  isBot: boolean;
  calibrated: boolean;
  /** `inZone` of the latest pose frame, or null before the first frame. */
  lastPoseInZone: boolean | null;
  lastDodgeAction: { direction: 'left' | 'right' | 'down'; at: number } | null;
  /** Server time of the glove's last parry press (`hardware:event`). */
  lastParryAt: number;
  disconnectTimer: TimerHandle | null;
  incantations: Map<P0ElementType, IncantationRecord>;
  dodgeHistory: DodgeHistoryEntry[];
}

export function toJoinableRole(role: unknown): JoinableRole {
  return role === 'spellbearer' ? 'spellbearer' : 'partner';
}

export function newSeat(name: string, role: JoinableRole): Seat {
  return {
    player: {
      id: randomUUID(),
      name: cleanName(name),
      role,
      connected: false,
      inZone: false,
      canCast: true,
      selectedElement: null,
      fistCharged: false,
    },
    humanName: cleanName(name),
    humanRole: role,
    socketId: null,
    everClaimed: false,
    isBot: false,
    calibrated: false,
    lastPoseInZone: null,
    lastDodgeAction: null,
    lastParryAt: 0,
    disconnectTimer: null,
    incantations: new Map(),
    dodgeHistory: [],
  };
}

/** The role a new seat gets: the requested one, unless the single Spellbearer seat is taken. */
export function roleForNewSeat(seats: Seat[], wanted: JoinableRole): JoinableRole {
  if (wanted === 'spellbearer' && seats.some((s) => s.humanRole === 'spellbearer')) return 'partner';
  return wanted;
}

export type ClaimResult = { ok: true; seat: Seat; created: boolean } | { ok: false; error: string };

/**
 * Finds the seat for a joining socket, in this order:
 * 1. A seat with the same name (reconnect, reserved seat, bot seat, or a stale tab).
 * 2. A reserved seat nobody has claimed yet, with the requested role.
 * 3. A new seat, if one is free.
 * 4. Any unclaimed reserved seat, then any disconnected or bot seat (renamed to the joiner).
 */
export function claimSeat(seats: Seat[], rawName: string, wantedRole: JoinableRole): ClaimResult {
  const name = cleanName(rawName);
  const byName = seats.find((s) => sameName(s.humanName, name));
  if (byName) return { ok: true, seat: byName, created: false };

  const reservedSameRole = seats.find((s) => !s.everClaimed && !s.isBot && s.humanRole === wantedRole);
  if (reservedSameRole) return { ok: true, seat: rename(reservedSameRole, name), created: false };

  if (seats.length < MAX_SEATS) {
    const seat = newSeat(name, roleForNewSeat(seats, wantedRole));
    seats.push(seat);
    return { ok: true, seat, created: true };
  }

  const reserved = seats.find((s) => !s.everClaimed && !s.isBot);
  if (reserved) return { ok: true, seat: rename(reserved, name), created: false };

  const free = seats.find((s) => s.isBot || !s.player.connected);
  if (free) return { ok: true, seat: rename(free, name), created: false };

  return { ok: false, error: 'Room is full' };
}

function rename(seat: Seat, name: string): Seat {
  seat.humanName = name;
  seat.player.name = name;
  return seat;
}

/** Turns a seat over to the bot. The display name stays so teammates still recognize it. */
export function makeBot(seat: Seat): void {
  seat.isBot = true;
  seat.socketId = null;
  seat.player.role = 'bot' satisfies PlayerRole;
  seat.player.connected = true;
  seat.player.inZone = true;
  seat.player.canCast = true;
  seat.lastPoseInZone = true;
  seat.calibrated = true;
}

/** A human (re)takes a seat, from a reservation, a disconnect, or a bot. */
export function seatHuman(seat: Seat, socketId: string): void {
  seat.isBot = false;
  seat.socketId = socketId;
  seat.everClaimed = true;
  seat.player.role = seat.humanRole;
  seat.player.connected = true;
}
