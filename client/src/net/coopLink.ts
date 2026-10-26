import { create } from 'zustand';
import { GLOVE_HUB_URL } from '../hardware/useGloveHub';
import { allyStore, heroStore, HEROES, localHeroStore, playerStore, resetHeroes, type HeroId, type PlayerState } from '../combat/playerState';
import { setBattleRemote, useSpellBattle, type BattleIntent, type Cast } from '../combat/spellBattle';
import { useDefense } from '../combat/defense';
import { getSpell, type SpellId } from '../combat/spells';

/**
 * Separate-screen co-op for the boss fight, carried by the glove hub's `coop` relay so no other server is needed.
 *
 * Both screens look for each other at the castle gate. Once paired, the host (the lower hub id) runs the fight with
 * both heroes and sends a snapshot on every change; the guest's battle store becomes a mirror (see `setBattleRemote`)
 * that plays the same effects and sends its own casts, rests and parries to the host as intents.
 */
export type CoopStatus = 'off' | 'seeking' | 'unavailable' | 'paired' | 'partner-left';
export type CoopRole = 'solo' | 'host' | 'guest';

type HeroSnapshot = Pick<PlayerState, 'health' | 'maxHealth' | 'magicPower' | 'maxMagicPower' | 'stance' | 'stanceValue' | 'statuses' | 'hurt'>;
type BattleSnapshot = Pick<ReturnType<typeof useSpellBattle.getState>,
  'encounterId' | 'coop' | 'allyAway' | 'heroNames' | 'fieldTurns' | 'opponents' | 'enemyTurn' | 'activeId' | 'turnNumber' | 'status' | 'feedback' | 'message'>
  & { pending: (Omit<Cast, 'spell'> & { spell: SpellId }) | null };
type StateMessage = { kind: 'state'; seq: number; battle: BattleSnapshot; heroes: Record<HeroId, HeroSnapshot> };
type CoopMessage =
  | { kind: 'seek'; name: string }
  | { kind: 'sync' }
  | StateMessage
  | { kind: 'intent'; intent: BattleIntent }
  | { kind: 'result'; ok: boolean; message: string }
  | { kind: 'ping' }
  | { kind: 'bye' };

interface CoopState {
  status: CoopStatus;
  role: CoopRole;
  partnerName: string;
  /** Bumps when the host turns down one of the guest's moves, so the guest's glove can fizzle. */
  rejected: { id: number; message: string } | null;
}
export const useCoop = create<CoopState>(() => ({ status: 'off', role: 'solo', partnerName: '', rejected: null }));

const SEEK_MS = 1000;
const KEYFRAME_MS = 2000;
/** Silence from the partner for this long counts as a disconnect, in case the hub never noticed the socket drop. */
const PARTNER_TIMEOUT_MS = 7000;

let socket: WebSocket | null = null;
let clientId: string | null = null;
let partnerId: string | null = null;
let myName = '';
let lastHeard = 0;
let seq = 0;
let lastSeq = -1;
let rejectedId = 0;
let fighting = false;
const timers = new Set<number>();
let unsubscribe: (() => void) | null = null;

const idNumber = (id: string) => Number(id.replace(/\D/g, '')) || 0;
const every = (ms: number, fn: () => void) => { const timer = window.setInterval(fn, ms); timers.add(timer); };
function clearTimers() { for (const timer of timers) window.clearInterval(timer); timers.clear(); }

function send(data: CoopMessage, to: string | null = partnerId) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(to ? { type: 'coop', to, data } : { type: 'coop', data }));
}

function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(GLOVE_HUB_URL);
  socket = ws;
  ws.onmessage = (event) => {
    const text = String(event.data);
    // The hub also streams every glove frame here; only welcome and co-op messages matter.
    if (!text.startsWith('{"type":"coop') && !text.startsWith('{"type":"welcome')) return;
    let message: { type?: string; clientId?: string; from?: string; data?: CoopMessage };
    try { message = JSON.parse(text); } catch { return; }
    if (message.type === 'welcome' && typeof message.clientId === 'string') {
      clientId = message.clientId;
      if (useCoop.getState().status === 'unavailable') useCoop.setState({ status: 'seeking' });
    } else if (message.type === 'coop-left' && message.from === partnerId) partnerLost();
    else if (message.type === 'coop' && message.from && message.data) receive(message.from, message.data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null; clientId = null;
    const { status } = useCoop.getState();
    if (status === 'seeking') useCoop.setState({ status: 'unavailable' });
    else if (status === 'paired') partnerLost();
  };
  ws.onerror = () => ws.close();
}

function receive(from: string, data: CoopMessage) {
  const coop = useCoop.getState();
  if (data.kind === 'seek') {
    if (coop.status !== 'seeking' || !clientId) return;
    partnerId = from;
    lastHeard = performance.now();
    const role: CoopRole = idNumber(clientId) < idNumber(from) ? 'host' : 'guest';
    clearTimers();
    useCoop.setState({ status: 'paired', role, partnerName: data.name || 'Your partner' });
    // Answer directly so the other screen pairs even if it missed our broadcasts.
    send({ kind: 'seek', name: myName }, from);
    return;
  }
  if (from !== partnerId) return;
  lastHeard = performance.now();
  // A partner who went quiet but is still on the same connection picks up where they left off.
  if (coop.status === 'partner-left' && data.kind !== 'bye') {
    useCoop.setState({ status: 'paired' });
    if (coop.role === 'host') useSpellBattle.getState().setAllyAway(false);
  }
  if (data.kind === 'bye') partnerLost();
  else if (data.kind === 'sync' && coop.role === 'host' && fighting) sendSnapshot();
  else if (data.kind === 'intent' && coop.role === 'host' && fighting) handleIntent(data.intent);
  else if (data.kind === 'state' && coop.role === 'guest' && fighting) applySnapshot(data);
  else if (data.kind === 'result' && coop.role === 'guest' && !data.ok) {
    useCoop.setState({ rejected: { id: ++rejectedId, message: data.message } });
    if (data.message) useSpellBattle.setState({ message: data.message });
  }
}

function partnerLost() {
  const { status, role } = useCoop.getState();
  if (status !== 'paired') return;
  useCoop.setState({ status: 'partner-left' });
  if (role === 'host') useSpellBattle.getState().setAllyAway(true);
}

/** Starts looking for a partner at the gate. `name` is what the other screen shows. */
export function seekPartner(name: string) {
  myName = name.trim() || 'Spellbearer';
  partnerId = null;
  clearTimers();
  useCoop.setState({ status: 'seeking', role: 'solo', partnerName: '', rejected: null });
  connect();
  every(SEEK_MS, () => {
    if (socket?.readyState === WebSocket.OPEN && clientId) send({ kind: 'seek', name: myName }, null);
    else { if (useCoop.getState().status === 'seeking') useCoop.setState({ status: 'unavailable' }); connect(); }
  });
}

/** Leaves co-op: back to a solo fight on this screen, and the partner hears about it. */
export function leaveCoop() {
  if (partnerId) send({ kind: 'bye' });
  clearTimers();
  unsubscribe?.(); unsubscribe = null;
  fighting = false; partnerId = null; lastSeq = -1;
  setBattleRemote(null);
  localHeroStore.setState({ hero: 'player' });
  useCoop.setState({ status: 'off', role: 'solo', partnerName: '', rejected: null });
}

/** Called by both screens once paired: the host starts the shared fight, the guest becomes its mirror. */
export function startCoopBattle() {
  const { role, partnerName } = useCoop.getState();
  if (role === 'solo' || fighting) return;
  fighting = true;
  resetHeroes();
  for (const id of HEROES) heroStore(id).getState().setMagicPower(12);
  useSpellBattle.getState().reset('knight', true);
  useSpellBattle.setState({ heroNames: role === 'host' ? { player: myName, ally: partnerName } : { player: partnerName, ally: myName } });
  every(KEYFRAME_MS / 2, () => { if (useCoop.getState().status === 'paired' && performance.now() - lastHeard > PARTNER_TIMEOUT_MS) partnerLost(); });
  if (role === 'host') {
    localHeroStore.setState({ hero: 'player' });
    let queued = false;
    const changed = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; sendSnapshot(); }); } };
    const subscriptions = [useSpellBattle.subscribe(changed), playerStore.subscribe(changed), allyStore.subscribe(changed)];
    unsubscribe = () => subscriptions.forEach((off) => off());
    every(KEYFRAME_MS, sendSnapshot);
    sendSnapshot();
  } else {
    localHeroStore.setState({ hero: 'ally' });
    setBattleRemote((intent) => send({ kind: 'intent', intent }));
    every(KEYFRAME_MS, () => send({ kind: 'ping' }));
    send({ kind: 'sync' });
  }
}

const heroSnapshot = (state: PlayerState): HeroSnapshot => ({ health: state.health, maxHealth: state.maxHealth, magicPower: state.magicPower, maxMagicPower: state.maxMagicPower,
  stance: state.stance, stanceValue: state.stanceValue, statuses: state.statuses, hurt: state.hurt });

/** The whole shared fight as plain data: what the host sends, and what a guest's screen rebuilds. */
export function buildSnapshot(): Omit<StateMessage, 'kind' | 'seq'> {
  const b = useSpellBattle.getState();
  const battle: BattleSnapshot = { encounterId: b.encounterId, coop: b.coop, allyAway: b.allyAway, heroNames: b.heroNames, fieldTurns: b.fieldTurns, opponents: b.opponents,
    enemyTurn: b.enemyTurn, activeId: b.activeId, turnNumber: b.turnNumber, status: b.status, feedback: b.feedback, message: b.message,
    pending: b.pending ? { ...b.pending, spell: b.pending.spell.id } : null };
  return { battle, heroes: { player: heroSnapshot(playerStore.getState()), ally: heroSnapshot(allyStore.getState()) } };
}

function sendSnapshot() { send({ kind: 'state', seq: ++seq, ...buildSnapshot() }); }

export function applySnapshot(message: StateMessage) {
  // The host numbers its snapshots; a late one must not undo a newer one. A restarted host starts again from 1.
  if (message.seq <= lastSeq && message.seq !== 1) return;
  lastSeq = message.seq;
  const { pending, ...battle } = message.battle;
  const spell = pending ? getSpell(pending.spell) : null;
  // Cue the guest's local webcam defense projection whenever the host starts a new enemy attack!
  const prevAction = useSpellBattle.getState().enemyTurn?.action;
  const nextAction = battle.enemyTurn?.action;
  if (nextAction && nextAction.id !== prevAction?.id) {
    useDefense.getState().begin(nextAction.id, nextAction.moveId);
  } else if (!nextAction && prevAction) {
    useDefense.getState().clear();
  }
  useSpellBattle.setState({ ...battle, pending: pending && spell ? { ...pending, spell } : null });
  playerStore.setState(message.heroes.player);
  allyStore.setState(message.heroes.ally);
}

function handleIntent(intent: BattleIntent) {
  const battle = useSpellBattle.getState();
  const reply = (ok: boolean, message = '') => send({ kind: 'result', ok, message });
  if (battle.status !== 'active') return reply(false, 'The fight is over.');
  if (intent.type === 'defend') {
    // Allow guest parry/dodge intents even if the host is between enemy actions or in windup,
    // and pad the hold window by 900ms to absorb two-laptop video/network skew!
    const paddedMs = (intent.ms ?? 2200) + 900;
    battle.triggerDefense(intent.mode, intent.label, paddedMs, 'ally');
    if (intent.mode === 'parry') allyStore.getState().setStance('guarding');
    return;
  }
  if (battle.activeId !== 'ally' || battle.pending) return reply(false, 'Wait for your turn.');
  if (intent.type === 'cast') {
    const ok = battle.castSpell(intent.input, intent.source, 'natural', intent.options);
    return reply(ok, ok ? '' : useSpellBattle.getState().message);
  }
  if (intent.type === 'rest') battle.rest();
  else battle.endTurn();
  reply(true);
}
