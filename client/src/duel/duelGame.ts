import { create } from 'zustand';
import { GLOVE_HUB_URL } from '../hardware/useGloveHub';
import {
  ARENA_ASPECT, BLOCK_HOLD_MS, BODY_PADDING, CAST_COOLDOWN_MS, DUEL_HEALTH, DUEL_MANA, DUEL_SPELLS, GUARD_COST, GUARD_MAX,
  GUARD_PER_SECOND, MANA_PER_SECOND, spellById, type DuelSpell,
} from './duelSpells';

/**
 * Two-screen duel carried by the glove hub's `coop` relay. There is no host: each screen owns its own health and judges
 * the spells aimed at it (so a dodge never waits on the network), then tells the caster what happened.
 */
export type DuelStatus = 'off' | 'seeking' | 'unavailable' | 'paired' | 'countdown' | 'fighting' | 'over';
export type DuelResult = 'hit' | 'dodged' | 'blocked';

export interface Zone { id: number; spell: DuelSpell; x: number; y: number; startAt: number; impactAt: number }
type Point = { x: number; y: number };

type Message =
  | { kind: 'duel-seek'; name: string }
  | { kind: 'duel-ready' }
  | { kind: 'duel-pose'; p: number[] }
  | { kind: 'duel-cast'; id: number; spell: string; x: number; y: number }
  | { kind: 'duel-result'; id: number; result: DuelResult; damage: number; hp: number }
  | { kind: 'duel-rematch' }
  | { kind: 'duel-bye' };

interface DuelState {
  active: boolean;
  status: DuelStatus;
  foeName: string;
  health: number;
  foeHealth: number;
  mana: number;
  guard: number;
  spellIndex: number;
  /** Spells coming at this screen. */
  incoming: Zone[];
  /** Spells this player has cast and is waiting to hear about. */
  outgoing: Zone[];
  message: string;
  /** Bumps on every hit taken or landed, for the screen flash. */
  hurtTick: number;
  strikeTick: number;
  winner: 'me' | 'foe' | null;
  readyMine: boolean;
  readyFoe: boolean;
  rematchMine: boolean;
  rematchFoe: boolean;
  countdownEnd: number;
}

const initial = (): Omit<DuelState, 'active'> => ({
  status: 'off', foeName: '', health: DUEL_HEALTH, foeHealth: DUEL_HEALTH, mana: DUEL_MANA, guard: GUARD_MAX, spellIndex: 0,
  incoming: [], outgoing: [], message: '', hurtTick: 0, strikeTick: 0, winner: null,
  readyMine: false, readyFoe: false, rematchMine: false, rematchFoe: false, countdownEnd: 0,
});

export const useDuel = create<DuelState>(() => ({ active: false, ...initial() }));
const set = useDuel.setState;
const get = useDuel.getState;

/** Per-frame data the canvas reads directly, so pose updates never go through React. Points are mirror-view fractions. */
export const duelLive = {
  /** This player's body: nose, shoulders, elbows, wrists, hips (same order as the wire format). */
  body: null as Point[] | null,
  foe: null as Point[] | null,
  aim: null as Point | null,
  /** performance.now() when the guard arm went up, or 0 when it is down. */
  blockSince: 0,
};

const SEEK_MS = 1000;
const COUNTDOWN_MS = 3000;
const SIM_MS = 50;
const POSE_TIMEOUT_MS = 8000;

let socket: WebSocket | null = null;
let clientId: string | null = null;
let foeId: string | null = null;
let myName = '';
let castId = 0;
let lastHeard = 0;
const timers = new Set<number>();
const every = (ms: number, fn: () => void) => { timers.add(window.setInterval(fn, ms)); };
const clearTimers = () => { for (const timer of timers) window.clearInterval(timer); timers.clear(); };

function send(data: Message, to: string | null = foeId) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(to ? { type: 'coop', to, data } : { type: 'coop', data }));
}

function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(GLOVE_HUB_URL);
  socket = ws;
  ws.onmessage = (event) => {
    const text = String(event.data);
    if (!text.startsWith('{"type":"coop') && !text.startsWith('{"type":"welcome')) return;
    let message: { type?: string; clientId?: string; from?: string; data?: Message };
    try { message = JSON.parse(text); } catch { return; }
    if (message.type === 'welcome' && typeof message.clientId === 'string') {
      clientId = message.clientId;
      if (get().status === 'unavailable') set({ status: 'seeking' });
    } else if (message.type === 'coop-left' && message.from === foeId) foeLeft();
    else if (message.type === 'coop' && message.from && message.data) receive(message.from, message.data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null; clientId = null;
    const { status } = get();
    if (status === 'seeking') set({ status: 'unavailable' });
    else if (status !== 'off' && status !== 'over') foeLeft();
  };
  ws.onerror = () => ws.close();
}

function foeLeft() {
  const { status } = get();
  if (status === 'off' || status === 'over') return;
  stopSim();
  set({ status: 'over', winner: 'me', message: 'Your opponent left the duel.', incoming: [], outgoing: [] });
}

function receive(from: string, data: Message) {
  if (!data.kind.startsWith('duel-')) return;
  const state = get();
  if (data.kind === 'duel-seek') {
    if (state.status !== 'seeking') return;
    foeId = from; lastHeard = performance.now();
    clearTimers();
    set({ status: 'paired', foeName: data.name || 'Your rival' });
    send({ kind: 'duel-seek', name: myName }, from);
    return;
  }
  if (from !== foeId) return;
  lastHeard = performance.now();
  switch (data.kind) {
    case 'duel-bye': foeLeft(); break;
    case 'duel-ready':
      set({ readyFoe: true });
      maybeStart();
      break;
    case 'duel-pose': {
      const points: Point[] = [];
      for (let i = 0; i + 1 < data.p.length; i += 2) points.push({ x: data.p[i]!, y: data.p[i + 1]! });
      duelLive.foe = points;
      break;
    }
    case 'duel-cast': {
      const spell = spellById(data.spell);
      if (!spell || state.status !== 'fighting') break;
      const now = performance.now();
      set({ incoming: [...state.incoming, { id: data.id, spell, x: data.x, y: data.y, startAt: now, impactAt: now + spell.telegraphMs }] });
      break;
    }
    case 'duel-result': {
      const outgoing = state.outgoing.filter((zone) => zone.id !== data.id);
      const spell = state.outgoing.find((zone) => zone.id === data.id)?.spell;
      const text = data.result === 'hit' ? `${spell?.name ?? 'Spell'} hit for ${data.damage}`
        : data.result === 'blocked' ? `Blocked: only ${data.damage} got through` : `${state.foeName} dodged ${spell?.name ?? 'the spell'}`;
      set({ outgoing, foeHealth: data.hp, message: text, strikeTick: data.result === 'dodged' ? state.strikeTick : state.strikeTick + 1 });
      if (data.hp <= 0 && state.status === 'fighting') finish('me');
      break;
    }
    case 'duel-rematch':
      set({ rematchFoe: true });
      maybeRematch();
      break;
  }
}

/** Gives every spell that lands this tick its verdict, and keeps mana and guard topped up. */
function simulate() {
  const state = get();
  if (state.status !== 'fighting') return;
  const now = performance.now();
  const dt = SIM_MS / 1000;
  let { health } = state;
  let { guard } = state;
  let hurtTick = state.hurtTick;
  let message = state.message;
  const remaining: Zone[] = [];
  for (const zone of state.incoming) {
    if (zone.impactAt > now) { remaining.push(zone); continue; }
    const verdict = judge(zone, guard, now);
    const damage = verdict === 'hit' ? zone.spell.damage : verdict === 'blocked' ? Math.round(zone.spell.damage * (1 - zone.spell.blockReduction)) : 0;
    if (verdict === 'blocked') guard -= GUARD_COST;
    health = Math.max(0, health - damage);
    if (damage > 0) hurtTick++;
    message = verdict === 'dodged' ? `You dodged ${zone.spell.name}` : verdict === 'blocked' ? `You blocked ${zone.spell.name}` : `${zone.spell.name} hit you for ${damage}`;
    send({ kind: 'duel-result', id: zone.id, result: verdict, damage, hp: health });
  }
  const stale = state.outgoing.filter((zone) => zone.impactAt + 4000 > now);
  set({
    incoming: remaining, outgoing: stale, health, hurtTick, message,
    mana: Math.min(DUEL_MANA, state.mana + MANA_PER_SECOND * dt),
    guard: Math.min(GUARD_MAX, guard + GUARD_PER_SECOND * dt),
  });
  if (health <= 0) finish('foe');
  else if (now - lastHeard > POSE_TIMEOUT_MS) foeLeft();
}

/** True when the player's body is inside the zone, by head, shoulders and hips. */
export function bodyInZone(body: Point[] | null, zone: Pick<Zone, 'x' | 'y' | 'spell'>): boolean {
  if (!body) return true;
  const reach = zone.spell.radius + BODY_PADDING;
  const marks = body.length >= 9 ? [body[0]!, body[1]!, body[2]!, body[7]!, body[8]!, midpoint(body[1]!, body[2]!), midpoint(body[7]!, body[8]!)] : body;
  return marks.some((p) => Math.hypot((p.x - zone.x) * ARENA_ASPECT, p.y - zone.y) <= reach);
}
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function judge(zone: Zone, guard: number, now: number): DuelResult {
  if (!bodyInZone(duelLive.body, zone)) return 'dodged';
  const guarding = duelLive.blockSince > 0 && now - duelLive.blockSince >= BLOCK_HOLD_MS;
  return guarding && guard >= GUARD_COST ? 'blocked' : 'hit';
}

function startSim() { stopSim(); every(SIM_MS, simulate); }
function stopSim() { clearTimers(); }

function finish(winner: 'me' | 'foe') {
  stopSim();
  set({ status: 'over', winner, incoming: [], outgoing: [], message: winner === 'me' ? 'You win the duel' : 'You were defeated' });
}

function beginCountdown() {
  const end = performance.now() + COUNTDOWN_MS;
  const base = initial();
  set({ ...base, status: 'countdown', foeName: get().foeName, countdownEnd: end, readyMine: true, readyFoe: true, message: '' });
  stopSim();
  every(100, () => {
    if (performance.now() < end || get().status !== 'countdown') return;
    set({ status: 'fighting', message: 'Raise your hand, aim, and cast' });
    lastHeard = performance.now();
    startSim();
  });
}

function maybeStart() {
  const { status, readyMine, readyFoe } = get();
  if (status === 'paired' && readyMine && readyFoe) beginCountdown();
}

function maybeRematch() {
  const { status, rematchMine, rematchFoe } = get();
  if (status === 'over' && rematchMine && rematchFoe) { set({ readyMine: true, readyFoe: true }); beginCountdown(); }
}

/** Opens the duel screen and starts looking for a rival on the same glove hub. */
export function openDuel(name: string) {
  myName = name.trim() || 'Spellbearer';
  foeId = null;
  clearTimers();
  duelLive.body = null; duelLive.foe = null; duelLive.aim = null; duelLive.blockSince = 0;
  set({ ...initial(), active: true, status: 'seeking' });
  connect();
  every(SEEK_MS, () => {
    if (socket?.readyState === WebSocket.OPEN && clientId) send({ kind: 'duel-seek', name: myName }, null);
    else { if (get().status === 'seeking') set({ status: 'unavailable' }); connect(); }
  });
}

export function leaveDuel() {
  if (foeId) send({ kind: 'duel-bye' });
  clearTimers();
  foeId = null;
  socket?.close(); socket = null; clientId = null;
  set({ ...initial(), active: false });
}

/** This screen's player is calibrated (or has no camera): tell the rival and start once both are. */
export function markReady() {
  const { status, readyMine } = get();
  if (status !== 'paired' || readyMine) return;
  set({ readyMine: true });
  send({ kind: 'duel-ready' });
  maybeStart();
}

export function requestRematch() {
  if (get().status !== 'over' || get().rematchMine) return;
  set({ rematchMine: true });
  send({ kind: 'duel-rematch' });
  maybeRematch();
}

export function selectSpell(index: number) {
  const spellIndex = ((index % DUEL_SPELLS.length) + DUEL_SPELLS.length) % DUEL_SPELLS.length;
  if (spellIndex !== get().spellIndex) set({ spellIndex });
}

/** Casts the selected spell at wherever the caster's hand is right now. */
export function castSpell(): boolean {
  const state = get();
  if (state.status !== 'fighting') return false;
  const spell = DUEL_SPELLS[state.spellIndex]!;
  const aim = duelLive.aim;
  const now = performance.now();
  if (!aim) { set({ message: 'Raise your casting hand so the camera can see it' }); return false; }
  if (state.mana < spell.cost) { set({ message: 'Not enough magic power' }); return false; }
  if (now < castReadyAt) return false;
  castReadyAt = now + CAST_COOLDOWN_MS;
  const id = ++castId;
  set({
    mana: state.mana - spell.cost,
    outgoing: [...state.outgoing, { id, spell, x: aim.x, y: aim.y, startAt: now, impactAt: now + spell.telegraphMs }],
    message: `${spell.name} cast`,
  });
  send({ kind: 'duel-cast', id, spell: spell.id, x: round(aim.x), y: round(aim.y) });
  return true;
}
let castReadyAt = 0;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Sends the body to the rival; 9 points in order nose, shoulders, elbows, wrists, hips. */
export function sendPose(points: Point[]) {
  if (get().status !== 'fighting' && get().status !== 'countdown' && get().status !== 'paired') return;
  send({ kind: 'duel-pose', p: points.flatMap((p) => [round(p.x), round(p.y)]) });
}
