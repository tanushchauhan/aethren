import { create } from 'zustand';
import { GLOVE_HUB_URL } from '../hardware/useGloveHub';
import { getSpell, SPELLS, type Spell, type SpellId } from '../combat/spells';
import { type BodyPartTarget } from '../vision/poseClassifiers';
import {
  CAST_SPEED_PROFILES,
  DUEL_MAX_HP,
  DUEL_MAX_MP,
  DUEL_MP_PER_SECOND,
  DUEL_REST_COOLDOWN_MS,
  DUEL_REST_MP,
  DUEL_START_MP,
  PARRY_REDUCTION,
  pickRandomBodyTargets,
  type CastSpeedTier,
} from './duelSpells';

export type DuelStatus = 'off' | 'seeking' | 'unavailable' | 'paired' | 'countdown' | 'fighting' | 'over';
export type Avatar = 'male' | 'female';
export type DuelResult = 'hit' | 'dodged' | 'parried';

/**
 * Each circle in an incoming spell has its own disjoint `startAt` and `impactAt` timer
 * so they shrink and hit sequentially rather than all at once!
 */
export interface IncomingRing {
  ringId: string;
  index: number;
  total: number;
  part: BodyPartTarget;
  startAt: number;
  impactAt: number;
  parriedUntil: number;
  verdict: DuelResult | null;
}

export interface IncomingAttack {
  id: number;
  spell: Spell;
  power: number;
  speedTier: CastSpeedTier;
  rings: IncomingRing[];
}

export interface OutgoingCast {
  id: number;
  spell: Spell;
  power: number;
  speedTier: CastSpeedTier;
  timingSummary: string;
  parts: BodyPartTarget[];
  castAt: number;
  resolved: boolean;
  result: DuelResult | null;
  damage: number;
}

export interface DuelHitFeedback {
  id: number;
  castId: number;
  targetId: 'rival';
  kind: 'hurt' | 'dodge' | 'effect';
  damage: number;
  label?: string;
}

type Message =
  | { kind: 'duel-seek'; name: string; avatar?: Avatar; ready?: boolean }
  | { kind: 'duel-ready' }
  | { kind: 'duel-weaving'; spellId: SpellId | null; step: number; total: number; speedTier?: CastSpeedTier }
  | { kind: 'duel-cast'; id: number; spell: SpellId; power: number; parts: BodyPartTarget[]; speedTier?: CastSpeedTier }
  | { kind: 'duel-result'; id: number; result: DuelResult; damage: number; hp: number }
  | { kind: 'duel-defeated' }
  | { kind: 'duel-rematch' }
  | { kind: 'duel-ping' }
  | { kind: 'duel-bye' };

interface DuelState {
  active: boolean;
  status: DuelStatus;
  practice: boolean;
  castSpeed: CastSpeedTier;
  foeName: string;
  foeAvatar: Avatar;
  health: number;
  maxHealth: number;
  foeHealth: number;
  foeMaxHealth: number;
  magicPower: number;
  maxMagicPower: number;
  foeMagicPower: number;
  shield: number;
  overcharged: boolean;
  /** Rival's live weaving progress so you see them racing to cast above their sprite! */
  foeWeaving: { spellId: SpellId; step: number; total: number; speedTier: CastSpeedTier } | null;
  /** Incoming rival spells with disjoint-timer Osu! circles on random body parts. */
  incoming: IncomingAttack[];
  /** Your most recent cast flying toward the rival on the stage (drives `SpellEffect` & rival reaction). */
  outgoing: OutgoingCast | null;
  /** Floating damage / dodge / parry popups above the rival sprite, matching `WolfCombatStage`. */
  feedback: DuelHitFeedback[];
  /** Screen hurt flash on the local player, matching `WolfCombatStage`. */
  hurt: { id: number; damage: number; guarded: boolean; absorbed: number } | null;
  /** DODGED! / PARRIED! banner on the local screen. */
  defended: { id: number; kind: 'dodged' | 'parried'; detail: string } | null;
  message: string;
  castCount: number;
  foeCastCount: number;
  winner: 'me' | 'foe' | null;
  readyMine: boolean;
  readyFoe: boolean;
  rematchMine: boolean;
  rematchFoe: boolean;
  countdownEnd: number;
}

const initial = (): Omit<DuelState, 'active' | 'castSpeed'> => ({
  status: 'off',
  practice: false,
  foeName: '',
  foeAvatar: 'female',
  health: DUEL_MAX_HP,
  maxHealth: DUEL_MAX_HP,
  foeHealth: DUEL_MAX_HP,
  foeMaxHealth: DUEL_MAX_HP,
  magicPower: DUEL_START_MP,
  maxMagicPower: DUEL_MAX_MP,
  foeMagicPower: DUEL_START_MP,
  shield: 0,
  overcharged: false,
  foeWeaving: null,
  incoming: [],
  outgoing: null,
  feedback: [],
  hurt: null,
  defended: null,
  message: '',
  castCount: 0,
  foeCastCount: 0,
  winner: null,
  readyMine: false,
  readyFoe: false,
  rematchMine: false,
  rematchFoe: false,
  countdownEnd: 0,
});

export const useDuel = create<DuelState>(() => ({ active: false, castSpeed: 2, ...initial() }));
const set = useDuel.setState;
const get = useDuel.getState;

/**
 * Live per-ring body-part clearance callback set by the camera overlay in `DuelArena.tsx`.
 * Evaluates a single ring (`ringId`, `part`) at the exact millisecond its individual timer expires!
 */
export const duelDefenseJudge = {
  checkRing: null as ((ringId: string, part: BodyPartTarget) => { dodged: boolean; parried: boolean }) | null,
};

const SEEK_MS = 900;
const COUNTDOWN_MS = 2400;
const SIM_MS = 40;
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 12000;

let socket: WebSocket | null = null;
let clientId: string | null = null;
let foeId: string | null = null;
let myName = '';
let myAvatar: Avatar = 'male';
let nextCastId = 0;
let nextFeedbackId = 0;
let nextHurtId = 0;
let nextDefendedId = 0;
let lastHeard = 0;
let lastRestAt = -Infinity;
let mpFloat = DUEL_START_MP;

/** Bot state for solo / practice speed contest. */
let botWeaveSpell: Spell | null = null;
let botWeaveStep = 0;
let botNextStepAt = 0;
let botSpeedTier: CastSpeedTier = 2;

const timers = new Set<number>();
const every = (ms: number, fn: () => void) => {
  const id = window.setInterval(fn, ms);
  timers.add(id);
  return id;
};
const clearTimers = () => {
  for (const timer of timers) window.clearInterval(timer);
  timers.clear();
};

function buildDisjointRings(
  attackId: number,
  parts: readonly BodyPartTarget[],
  speedTier: CastSpeedTier,
  now: number,
): IncomingRing[] {
  const profile = CAST_SPEED_PROFILES[speedTier] ?? CAST_SPEED_PROFILES[2];
  return parts.map((part, index) => {
    // Disjoint staggered start & impact times so each circle closes at a different moment!
    const jitter = index === 0 ? 0 : Math.round((Math.random() - 0.25) * 110);
    const startAt = now + index * profile.osuStaggerMs + Math.max(0, jitter);
    const impactAt = startAt + profile.osuWindupMs;
    return {
      ringId: `${attackId}-${index}`,
      index,
      total: parts.length,
      part,
      startAt,
      impactAt,
      parriedUntil: 0,
      verdict: null,
    };
  });
}

function send(data: Message, to: string | null = foeId) {
  if (get().practice) return;
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(to ? { type: 'coop', to, data } : { type: 'coop', data }));
}

function connect() {
  if (get().practice) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(GLOVE_HUB_URL);
  } catch {
    if (get().status === 'seeking') set({ status: 'unavailable' });
    return;
  }
  socket = ws;
  ws.onmessage = (event) => {
    const text = String(event.data);
    if (!text.startsWith('{"type":"coop') && !text.startsWith('{"type":"welcome')) return;
    let message: { type?: string; clientId?: string; from?: string; data?: Message };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === 'welcome' && typeof message.clientId === 'string') {
      clientId = message.clientId;
      if (get().status === 'unavailable') set({ status: 'seeking' });
      if (get().status === 'seeking') {
        send({ kind: 'duel-seek', name: myName, avatar: myAvatar, ready: get().readyMine }, null);
      }
    } else if (message.type === 'coop-left' && message.from === foeId) {
      foeLeft();
    } else if (message.type === 'coop' && message.from && message.data) {
      receive(message.from, message.data);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    clientId = null;
    if (get().practice) return;
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
  set({ status: 'over', winner: 'me', message: 'Your rival disconnected from the clearing.', incoming: [], foeWeaving: null });
}

function startPairedHeartbeats() {
  clearTimers();
  every(HEARTBEAT_MS, () => {
    const s = get();
    if (s.practice || !foeId) return;
    send({ kind: 'duel-ping' }, foeId);
    if (s.readyMine && s.status === 'paired') {
      send({ kind: 'duel-ready' }, foeId);
    }
  });
}

function receive(from: string, data: Message) {
  if (!data || typeof data.kind !== 'string' || !data.kind.startsWith('duel-')) return;
  const state = get();
  if (state.practice) return;

  if (data.kind === 'duel-seek') {
    if (state.status !== 'seeking' && !(state.status === 'paired' && foeId === from)) return;
    const firstPair = state.status === 'seeking';
    foeId = from;
    lastHeard = performance.now();
    const readyFoe = state.readyFoe || Boolean(data.ready);
    set({
      status: 'paired',
      foeName: data.name || 'Rival Spellbearer',
      foeAvatar: data.avatar === 'female' ? 'female' : 'male',
      readyFoe,
    });
    if (firstPair) {
      startPairedHeartbeats();
      send({ kind: 'duel-seek', name: myName, avatar: myAvatar, ready: get().readyMine }, from);
      if (get().readyMine) send({ kind: 'duel-ready' }, from);
    }
    maybeStart();
    return;
  }

  if (from !== foeId) return;
  lastHeard = performance.now();

  switch (data.kind) {
    case 'duel-ping':
      break;
    case 'duel-bye':
      foeLeft();
      break;
    case 'duel-ready':
      set({ readyFoe: true });
      maybeStart();
      break;
    case 'duel-weaving':
      set({
        foeWeaving: data.spellId
          ? { spellId: data.spellId, step: data.step, total: data.total, speedTier: data.speedTier ?? 2 }
          : null,
      });
      break;
    case 'duel-cast': {
      const spell = getSpell(data.spell);
      if (!spell || state.status !== 'fighting') break;
      const now = performance.now();
      const parts = Array.isArray(data.parts) && data.parts.length > 0 ? data.parts : pickRandomBodyTargets(spell);
      const speedTier: CastSpeedTier = data.speedTier === 1 || data.speedTier === 2 || data.speedTier === 3 ? data.speedTier : 2;
      const rings = buildDisjointRings(data.id, parts, speedTier, now);
      set({
        foeWeaving: null,
        foeCastCount: state.foeCastCount + 1,
        incoming: [
          ...state.incoming,
          {
            id: data.id,
            spell,
            power: data.power || 1,
            speedTier,
            rings,
          },
        ],
        message: `⚠ ${state.foeName} cast ${spell.name} (${CAST_SPEED_PROFILES[speedTier].label})!`,
      });
      break;
    }
    case 'duel-result': {
      applyOutgoingResult(data.id, data.result, data.damage, data.hp);
      break;
    }
    case 'duel-defeated': {
      set({ foeHealth: 0 });
      if (state.status === 'fighting') finish('me');
      break;
    }
    case 'duel-rematch':
      set({ rematchFoe: true });
      maybeRematch();
      break;
  }
}

function applyOutgoingResult(castId: number, result: DuelResult, damage: number, foeHp: number) {
  const state = get();
  const current = state.outgoing;
  const spell = current?.id === castId ? current.spell : null;
  const fb: DuelHitFeedback = {
    id: ++nextFeedbackId,
    castId,
    targetId: 'rival',
    kind: result === 'dodged' ? 'dodge' : 'hurt',
    damage,
    label: result === 'parried' ? 'Parried' : spell?.applies?.id ? spell.applies.id.toUpperCase() : undefined,
  };
  const text =
    result === 'hit'
      ? `${spell?.name ?? 'Spell'} struck ${state.foeName} for −${damage} HP!`
      : result === 'parried'
        ? `${state.foeName} parried ${spell?.name ?? 'your spell'} (−${damage} HP)`
        : `${state.foeName} dodged ${spell?.name ?? 'your spell'}!`;
  set({
    foeHealth: Math.max(0, foeHp),
    outgoing: current?.id === castId ? { ...current, resolved: true, result, damage } : current,
    feedback: [...state.feedback.slice(-4), fb],
    message: text,
  });
  if (foeHp <= 0 && get().status === 'fighting') finish('me');
}

const BOT_ATTACK_POOL: readonly SpellId[] = [
  'ember-bolt',
  'frost-shard',
  'storm-spark',
  'fire-lance',
  'immolate',
  'chain-lightning',
  'frost-nova',
  'static-shock',
];

function stepPracticeBot(now: number) {
  const state = get();
  if (!state.practice || state.status !== 'fighting') return;

  if (!botWeaveSpell) {
    if (now < botNextStepAt) return;
    const id = BOT_ATTACK_POOL[Math.floor(Math.random() * BOT_ATTACK_POOL.length)]!;
    botWeaveSpell = SPELLS[id];
    botWeaveStep = 1;
    // Match or slightly vary around the player's selected cast speed
    botSpeedTier = state.castSpeed;
    const stepMs = CAST_SPEED_PROFILES[botSpeedTier].stepDurationMs * 0.65;
    botNextStepAt = now + stepMs;
    set({
      foeWeaving: { spellId: botWeaveSpell.id, step: 1, total: botWeaveSpell.ritual.length, speedTier: botSpeedTier },
    });
    return;
  }

  if (now < botNextStepAt) return;

  const stepMs = CAST_SPEED_PROFILES[botSpeedTier].stepDurationMs * 0.65;
  if (botWeaveStep < botWeaveSpell.ritual.length) {
    botWeaveStep += 1;
    botNextStepAt = now + stepMs;
    set({
      foeWeaving: { spellId: botWeaveSpell.id, step: botWeaveStep, total: botWeaveSpell.ritual.length, speedTier: botSpeedTier },
    });
    return;
  }

  // Bot completed its ritual -> launches disjoint-timer Osu! circles on random body parts!
  const spell = botWeaveSpell;
  botWeaveSpell = null;
  botWeaveStep = 0;
  botNextStepAt = now + 1800 + Math.random() * 800;

  const parts = pickRandomBodyTargets(spell);
  const id = ++nextCastId;
  const rings = buildDisjointRings(id, parts, botSpeedTier, now);
  set((s) => ({
    foeWeaving: null,
    foeCastCount: s.foeCastCount + 1,
    incoming: [
      ...s.incoming,
      {
        id,
        spell,
        power: 1,
        speedTier: botSpeedTier,
        rings,
      },
    ],
    message: `⚠ ${s.foeName} cast ${spell.name} (${CAST_SPEED_PROFILES[botSpeedTier].label})!`,
  }));
}

function rawSpellDamage(spell: Spell, power: number, overcharged: boolean, speedTier: CastSpeedTier): number {
  const base = spell.damage > 0 ? spell.damage : spell.id === 'frost-prison' ? 14 : 10;
  const speedBonus = CAST_SPEED_PROFILES[speedTier].damageBonus;
  const mult = power * speedBonus * (overcharged ? 1.5 : 1);
  return Math.max(4, Math.round(base * mult));
}

function simulate() {
  const state = get();
  if (state.status !== 'fighting') return;
  const now = performance.now();
  const dt = SIM_MS / 1000;

  // Fast MP regeneration for high-speed duel casting
  mpFloat = Math.min(DUEL_MAX_MP, mpFloat + DUEL_MP_PER_SECOND * dt);
  const nextMp = Math.floor(mpFloat);
  if (nextMp !== state.magicPower) {
    set({ magicPower: nextMp });
  }

  if (state.practice) {
    stepPracticeBot(now);
    if (get().status !== 'fighting') return;
  }

  const fresh = get();
  let { health, shield } = fresh;
  let hurt = fresh.hurt;
  let defended = fresh.defended;
  let message = fresh.message;
  let changed = false;
  const remainingAttacks: IncomingAttack[] = [];

  for (const attack of fresh.incoming) {
    let anyUnresolved = false;
    let ringChanged = false;
    const updatedRings = attack.rings.map((ring) => {
      if (ring.verdict !== null) return ring;
      if (ring.impactAt > now) {
        anyUnresolved = true;
        return ring;
      }
      // This individual Osu! circle reached its impact time!
      ringChanged = true;
      changed = true;
      const cvVerdict = duelDefenseJudge.checkRing?.(ring.ringId, ring.part) ?? { dodged: false, parried: false };
      const gloveParried = ring.parriedUntil >= now - 250;
      const verdict: DuelResult = cvVerdict.dodged
        ? 'dodged'
        : cvVerdict.parried || gloveParried
          ? 'parried'
          : 'hit';

      const totalDmg = Math.max(6, Math.round((attack.spell.damage || 12) * attack.power));
      const perRingFull = Math.max(3, Math.round(totalDmg / attack.rings.length));
      const rawDmg =
        verdict === 'dodged'
          ? 0
          : verdict === 'parried'
            ? Math.max(1, Math.round(perRingFull * (1 - PARRY_REDUCTION)))
            : perRingFull;

      const absorbed = Math.min(shield, rawDmg);
      shield = Math.max(0, shield - absorbed);
      const finalDmg = Math.max(0, rawDmg - absorbed);
      health = Math.max(0, health - finalDmg);

      if (verdict === 'dodged') {
        defended = { id: ++nextDefendedId, kind: 'dodged', detail: `Dodged ${attack.spell.name}!` };
      } else if (verdict === 'parried') {
        defended = { id: ++nextDefendedId, kind: 'parried', detail: `Parried ${attack.spell.name}!` };
        hurt = { id: ++nextHurtId, damage: finalDmg, guarded: true, absorbed };
      } else {
        hurt = { id: ++nextHurtId, damage: finalDmg, guarded: false, absorbed };
      }

      return { ...ring, verdict };
    });

    if (anyUnresolved && health > 0) {
      remainingAttacks.push(ringChanged ? { ...attack, rings: updatedRings } : attack);
    } else {
      // Either all disjoint circles for this spell have finished OR this ring just knocked the player down to 0 HP!
      // Send the result back to the caster immediately so the winner gets their Victory screen right away!
      changed = true;
      const hits = updatedRings.filter((r) => r.verdict === 'hit').length;
      const parries = updatedRings.filter((r) => r.verdict === 'parried').length;
      const overall: DuelResult = hits > 0 ? 'hit' : parries > 0 ? 'parried' : 'dodged';
      const totalFull = Math.max(6, Math.round((attack.spell.damage || 12) * attack.power));
      const perRing = Math.max(3, Math.round(totalFull / updatedRings.length));
      const dealt = hits * perRing + parries * Math.max(1, Math.round(perRing * (1 - PARRY_REDUCTION)));
      message =
        overall === 'dodged'
          ? `Dodged all ${updatedRings.length} circles of ${attack.spell.name}!`
          : overall === 'parried'
            ? `Parried ${attack.spell.name} (−${dealt} HP)!`
            : `${attack.spell.name} hit for −${dealt} HP!`;
      send({ kind: 'duel-result', id: attack.id, result: overall, damage: dealt, hp: health });
      if (health <= 0) break;
    }
  }

  if (changed) {
    set({ incoming: remainingAttacks, health, shield, hurt, defended, message });
    if (health <= 0) {
      finish('foe');
      return;
    }
  }

  if (!fresh.practice && now - lastHeard > TIMEOUT_MS) {
    foeLeft();
  }
}

function startSim() {
  stopSim();
  every(SIM_MS, simulate);
  if (!get().practice) {
    every(HEARTBEAT_MS, () => send({ kind: 'duel-ping' }));
  }
}

function stopSim() {
  clearTimers();
}

function finish(winner: 'me' | 'foe') {
  stopSim();
  if (winner === 'foe' && !get().practice && foeId) {
    send({ kind: 'duel-defeated' }, foeId);
  }
  if (!get().practice && foeId) {
    every(HEARTBEAT_MS, () => send({ kind: 'duel-ping' }));
  }
  set({
    status: 'over',
    winner,
    incoming: [],
    foeWeaving: null,
    message: winner === 'me' ? 'The rival Spellbearer falls!' : 'Your strength gives out in the clearing.',
  });
}

function beginCountdown() {
  const end = performance.now() + COUNTDOWN_MS;
  const prev = get();
  const base = initial();
  mpFloat = DUEL_START_MP;
  botWeaveSpell = null;
  botWeaveStep = 0;
  set({
    ...base,
    status: 'countdown',
    practice: prev.practice,
    foeName: prev.foeName,
    foeAvatar: prev.foeAvatar,
    countdownEnd: end,
    readyMine: true,
    readyFoe: true,
    message: '',
  });
  stopSim();
  every(80, () => {
    const now = performance.now();
    if (!get().practice && foeId && now - lastHeard > 1500) {
      send({ kind: 'duel-ping' });
    }
    if (now < end || get().status !== 'countdown') return;
    lastHeard = now;
    botNextStepAt = now + 900;
    set({
      status: 'fighting',
      message: 'Speed Duel! Weave spells fast & dodge or parry the staggered body rings!',
    });
    startSim();
  });
}

function maybeStart() {
  const { status, readyMine, readyFoe } = get();
  if (status === 'paired' && readyMine && readyFoe) beginCountdown();
}

function maybeRematch() {
  const { status, rematchMine, rematchFoe } = get();
  if (status === 'over' && rematchMine && rematchFoe) {
    set({ readyMine: true, readyFoe: true });
    beginCountdown();
  }
}

export function setCastSpeed(tier: CastSpeedTier) {
  set({ castSpeed: tier });
}

export function cycleCastSpeed(): CastSpeedTier {
  const cur = get().castSpeed;
  const next: CastSpeedTier = cur === 1 ? 2 : cur === 2 ? 3 : 1;
  set({ castSpeed: next, message: `Cast Speed set to ${CAST_SPEED_PROFILES[next].label}` });
  return next;
}

export function openDuel(name: string) {
  myName = name.trim() || 'Spellbearer';
  myAvatar = Math.random() < 0.5 ? 'male' : 'female';
  foeId = null;
  mpFloat = DUEL_START_MP;
  clearTimers();
  set({ ...initial(), active: true, status: 'seeking', practice: false });
  connect();
  every(SEEK_MS, () => {
    if (get().status !== 'seeking') return;
    if (socket?.readyState === WebSocket.OPEN && clientId) {
      send({ kind: 'duel-seek', name: myName, avatar: myAvatar, ready: get().readyMine }, null);
    } else {
      connect();
    }
  });
}

export function startPracticeDuel() {
  foeId = 'practice-bot';
  mpFloat = DUEL_START_MP;
  clearTimers();
  socket?.close();
  socket = null;
  clientId = null;
  const botAvatar: Avatar = myAvatar === 'male' ? 'female' : 'male';
  const readyMine = get().readyMine;
  set({
    ...initial(),
    active: true,
    practice: true,
    status: 'paired',
    foeName: 'Rival Spellbearer',
    foeAvatar: botAvatar,
    readyMine,
    readyFoe: true,
  });
  maybeStart();
}

export function leaveDuel() {
  if (foeId && !get().practice) send({ kind: 'duel-bye' });
  clearTimers();
  foeId = null;
  socket?.close();
  socket = null;
  clientId = null;
  set({ ...initial(), active: false });
}

export function markReady() {
  const { status, readyMine, practice } = get();
  if (readyMine) {
    if (status === 'paired') maybeStart();
    return;
  }
  set({ readyMine: true });
  if (practice) {
    maybeStart();
    return;
  }
  if (status === 'paired') {
    send({ kind: 'duel-ready' });
    maybeStart();
  }
}

export function requestRematch() {
  const state = get();
  if (state.status !== 'over' || state.rematchMine) return;
  if (state.practice) {
    set({ rematchMine: true, rematchFoe: true });
    maybeRematch();
    return;
  }
  set({ rematchMine: true });
  send({ kind: 'duel-rematch' });
  maybeRematch();
}

export function notifyDuelWeaving(spellId: SpellId | null, step = 0, total = 0) {
  const s = get();
  if (s.status !== 'fighting') return;
  send({ kind: 'duel-weaving', spellId, step, total, speedTier: s.castSpeed });
}

export function restDuel(): boolean {
  const state = get();
  if (state.status !== 'fighting') return false;
  const now = performance.now();
  if (now - lastRestAt < DUEL_REST_COOLDOWN_MS) return false;
  lastRestAt = now;
  mpFloat = Math.min(DUEL_MAX_MP, mpFloat + DUEL_REST_MP);
  const nextMp = Math.floor(mpFloat);
  set({
    magicPower: nextMp,
    message: `Rested · +${DUEL_REST_MP} Magic Power (${nextMp}/${DUEL_MAX_MP} MP)`,
  });
  return true;
}

/**
 * Triggers a Glove Ward / keyboard parry against the next unresolved Osu! circle (currently active or soonest).
 * Because circles have disjoint timers, parrying wards the next circle that is closing in!
 */
export function triggerDuelParry(durationMs = 950): boolean {
  const state = get();
  if (state.status !== 'fighting' || state.incoming.length === 0) return false;
  const now = performance.now();
  const until = now + durationMs;
  let marked = false;
  const nextIncoming = state.incoming.map((att) => ({
    ...att,
    rings: att.rings.map((ring) => {
      if (!marked && ring.verdict === null && ring.impactAt >= now) {
        marked = true;
        return { ...ring, parriedUntil: Math.max(ring.parriedUntil, until) };
      }
      return ring;
    }),
  }));
  set({ incoming: nextIncoming });
  return marked;
}

/**
 * Called when the player finishes a spell's ritual on the wheel!
 * Spends MP, plays the fast projectile VFX toward the rival Spellbearer sprite, and sends `duel-cast`
 * with `speedTier` so the rival gets faster disjoint Osu! circles.
 */
export function castDuelSpell(spell: Spell, powerBoost: number, timingSummary: string): boolean {
  const state = get();
  if (state.status !== 'fighting') return false;
  if (mpFloat < spell.cost) {
    set({ message: `Not enough Magic Power for ${spell.name} (${spell.cost} MP). Hold B2 to Rest!` });
    return false;
  }

  mpFloat = Math.max(0, mpFloat - spell.cost);
  const nextMp = Math.floor(mpFloat);
  const speedTier = state.castSpeed;
  notifyDuelWeaving(null);

  if (spell.target === 'self') {
    const id = ++nextCastId;
    const shieldGain = spell.shield?.amount ?? 0;
    const grantsOvercharge = Boolean(spell.overcharge);
    const out: OutgoingCast = {
      id,
      spell,
      power: powerBoost,
      speedTier,
      timingSummary,
      parts: [],
      castAt: performance.now(),
      resolved: false,
      result: 'hit',
      damage: 0,
    };
    set({
      magicPower: nextMp,
      shield: state.shield + shieldGain,
      overcharged: state.overcharged || grantsOvercharge,
      castCount: state.castCount + 1,
      outgoing: out,
      message: `${spell.name} woven! · ${timingSummary}`,
    });
    return true;
  }

  const id = ++nextCastId;
  const speedBonus = CAST_SPEED_PROFILES[speedTier].damageBonus;
  const effectivePower = Math.round(powerBoost * speedBonus * (state.overcharged ? 1.5 : 1) * 100) / 100;
  const parts = pickRandomBodyTargets(spell);
  const out: OutgoingCast = {
    id,
    spell,
    power: effectivePower,
    speedTier,
    timingSummary,
    parts,
    castAt: performance.now(),
    resolved: false,
    result: null,
    damage: rawSpellDamage(spell, powerBoost, state.overcharged, speedTier),
  };

  set({
    magicPower: nextMp,
    overcharged: false,
    castCount: state.castCount + 1,
    outgoing: out,
    message: `✦ ${spell.name} (${CAST_SPEED_PROFILES[speedTier].tag}) · ${timingSummary}`,
  });

  if (!state.practice) {
    send({ kind: 'duel-cast', id, spell: spell.id, power: effectivePower, parts, speedTier });
  }
  return true;
}

/** Resolves the visual impact of the player's outgoing spell (and judges AI rival dodge/parry/hit in solo practice mode). */
export function resolveOutgoingVisual(castId: number) {
  const state = get();
  const out = state.outgoing;
  if (!out || out.id !== castId) return;

  if (out.spell.target === 'self') {
    set({ outgoing: { ...out, resolved: true } });
    return;
  }

  if (state.practice && !out.resolved) {
    // Faster cast speed makes it harder for the AI rival to dodge!
    const roll = Math.random();
    const dodgeChance = out.speedTier === 3 ? 0.08 : out.speedTier === 2 ? 0.14 : 0.22;
    const parryChance = 0.2;
    const verdict: DuelResult =
      roll < dodgeChance ? 'dodged' : roll < dodgeChance + parryChance ? 'parried' : 'hit';
    const full = out.damage;
    const finalDmg =
      verdict === 'dodged'
        ? 0
        : verdict === 'parried'
          ? Math.max(3, Math.round(full * (1 - PARRY_REDUCTION)))
          : full;
    const nextFoeHp = Math.max(0, state.foeHealth - finalDmg);
    applyOutgoingResult(castId, verdict, finalDmg, nextFoeHp);
  } else if (!out.resolved) {
    set({ outgoing: { ...out, resolved: true } });
  }
}

export function clearOutgoingVisual(castId: number) {
  const out = get().outgoing;
  if (out?.id === castId) {
    set({ outgoing: null });
  }
}
