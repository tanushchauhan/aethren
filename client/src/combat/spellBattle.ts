import { useDefense } from './defense';
import { create } from 'zustand';
import { combatants, createEncounter, armorValue, encounterReducer, PLAYER_ACTION, type EncounterId, type EncounterState, type ActorState } from './encounter';
import { playerStore, stanceFromValue, type PlayerStance } from './playerState';
import { STATUS_EFFECTS, withStatus } from './statusEffects';
import { getSpell, SPELLS, type Spell, type SpellInput } from './spells';
export type DodgeMode = 'natural' | 'hit' | 'dodge';
export type DefenseMode = 'dodge' | 'parry' | 'brace';
/** An active defensive pose or glove move, valid until `untilMs` (Date.now clock). */
export type PlayerDefense = { mode: 'none' | DefenseMode; label: string; untilMs: number };
export const DEFENSE_MS: Record<DefenseMode, number> = { dodge: 1200, parry: 900, brace: 1500 };
/** Damage a successful parry bounces back at the attacker. */
export const PARRY_REFLECT_DAMAGE = 4;
/** `power` is the Overcharge multiplier locked in when the cast began. Self spells target `player`. */
export type Cast = { id: number; spell: Spell; targetId: string; dodgeMode: DodgeMode; previousStance: PlayerStance; resolved: boolean; power: number; autoEndTurn?: boolean };
/** One wolf's reaction. `castId` is null for start-of-turn effects such as a burn tick. */
export type HitFeedback = { id: number; castId: number | null; targetId: string; kind: 'hurt' | 'dodge' | 'effect'; damage: number; label?: string };
interface SpellBattle {
  encounterId: EncounterId;
  fieldTurns: number;
  opponents: Record<string, ActorState>;
  enemyTurn: EncounterState | null;
  activeId: string;
  turnNumber: number;
  status: 'active' | 'won' | 'lost';
  endTurn: () => void;
  rest: () => void;
  beginEnemy: () => void;
  enemyStep: (type: 'play' | 'impact' | 'return' | 'finish', actionId: number) => void;
  pending: Cast | null;
  feedback: HitFeedback[];
  message: string;
  /** The dodge, parry or brace the player is currently performing; consumed by the next wolf attack. */
  playerDefense: PlayerDefense | null;
  triggerDefense: (mode: DefenseMode, label?: string, durationMs?: number) => void;
  /** `powerBoost` (1..1.45, e.g. from a glove swing) multiplies spell power; `autoEndTurn` defaults to true for glove casts. */
  castSpell: (input: SpellInput, source?: 'diagnostic' | 'glove', dodgeMode?: DodgeMode, options?: { powerBoost?: number; autoEndTurn?: boolean }) => boolean;
  resolveCast: (id: number, roll?: number) => void;
  finishCast: (id: number) => void;
  cancelCast: () => void;
  diagnosticKillAll: () => void;
  reset: (encounterId?: EncounterId) => void;
}
const initialOpponents = (id: EncounterId = 'wolves') => Object.fromEntries(Object.entries(createEncounter(id).actors).filter(([id]) => id !== 'player'));
const opponentsOf = (engine: EncounterState) => Object.fromEntries(Object.entries(engine.actors).filter(([id]) => id !== 'player'));
const nameOf = (id: string) => combatants.find(actor => actor.id === id)!.name;
const enemyOrder = combatants.filter(actor => actor.side === 'enemy').map(actor => actor.id);
let nextCastId = 0;
let nextTurnSession = 0;
let nextFeedbackId = 0;
const dodges = (targetId: string, dodgeMode: DodgeMode, roll: number) => dodgeMode === 'dodge' || (dodgeMode === 'natural' && roll < (targetId === 'knight' ? 0 : targetId === 'center' ? .1 : .2));
/** Armor reduces each hit to a minimum of 1, unless the spell pierces. Zero-damage spells stay at zero. */
export function spellDamage(spell: Spell, base: number, targetId: string, target: ActorState) {
  if (base <= 0) return 0;
  return spell.pierce ? base : Math.max(1, base - armorValue(targetId, target));
}
export function resolveSpellHit(spell: Spell, targetId: string, target: ActorState, dodgeMode: DodgeMode, roll: number, power = 1) {
  const dodged = canBeDodged(spell) && dodges(targetId, dodgeMode, roll);
  return { dodged, damage: dodged ? 0 : spellDamage(spell, Math.floor(spell.damage * power), targetId, target) };
}
/** Area, splash and chain spells fill the space a wolf would dodge into. */
export const canBeDodged = (spell: Spell) => spell.target === 'enemy' && !spell.area && !spell.splash && !spell.chain;
/** Who a spell lands on and for how much, before armor: the primary target first. */
export function spellHits(spell: Spell, primaryId: string, living: string[], power = 1) {
  const primary = { targetId: primaryId, base: Math.floor(spell.damage * power) };
  const others = living.filter(id => id !== primaryId);
  if (spell.area) return [primary, ...others.map(targetId => ({ targetId, base: spell.damage }))];
  if (spell.splash) return [primary, ...others.map(targetId => ({ targetId, base: spell.splash! }))];
  if (spell.chain) {
    // The bolt jumps to the nearest wolf in the formation, then onward.
    const index = enemyOrder.indexOf(primaryId);
    const order = [...others].sort((a, b) => Math.abs(enemyOrder.indexOf(a) - index) - Math.abs(enemyOrder.indexOf(b) - index) || enemyOrder.indexOf(a) - enemyOrder.indexOf(b));
    return [primary, ...order.slice(0, spell.chain.length).map((targetId, i) => ({ targetId, base: spell.chain![i] }))];
  }
  return [primary];
}
const restoreStance = (pending: Cast) => {
  if (playerStore.getState().stance === 'casting') playerStore.setState({ stance: pending.previousStance === 'guarding' ? 'guarding' : stanceFromValue(playerStore.getState().stanceValue) });
};
export const useSpellBattle = create<SpellBattle>((set, get) => {
  /** Applies one step of the opponents' engine: their attacks, burn ticks, skipped turns, and the hand-back to you. */
  function applyEngine(engine: EncounterState, next: EncounterState) {
    const state = get();
    const fieldTurns = next.lastAttack !== engine.lastAttack && next.lastAttack?.type === 'inferno' ? 5 : state.fieldTurns;
    let defenseMessage: string | null = null, clearDefense = false;
    if (next.lastAttack && next.lastAttack !== engine.lastAttack) {
      const attack = next.lastAttack, player = playerStore.getState();
      const cameraDefense = useDefense.getState().resolve(attack.actionId, player.stanceValue);
      const curse = attack.type === 'inferno' ? 'scorn' : attack.type === 'scorn' || attack.type === 'eclipse' ? attack.type : undefined;
      const defense = state.playerDefense && state.playerDefense.mode !== 'none' && Date.now() <= state.playerDefense.untilMs ? state.playerDefense : null;
      if (state.playerDefense) clearDefense = true;
      if (cameraDefense === 'dodged' || defense?.mode === 'dodge') {
        // A clean evasion: no damage, no stance loss, no bleeding.
        defenseMessage = cameraDefense === 'dodged' ? 'Dodged with movement tracking!' : `Dodged! (${defense!.label})`;
        useDefense.setState({ result: 'dodged' });
      } else if (defense?.mode === 'parry' || defense?.mode === 'brace') {
        // Both guard for this hit, halving damage and stance loss; a parry also bounces damage back (never lethal, so the wolf's action finishes cleanly).
        const wasGuarding = player.stance === 'guarding';
        player.setStance('guarding');
        player.receiveAttack(attack.damage, attack.stanceDamage, curse, cameraDefense === 'blocked');
        useDefense.setState({ result: 'blocked' });
        if (!wasGuarding && playerStore.getState().stance === 'guarding') playerStore.setState({ stance: stanceFromValue(playerStore.getState().stanceValue) });
        if (defense.mode === 'parry') {
          const source = next.actors[attack.source];
          if (source && !source.defeated) next = { ...next, actors: { ...next.actors, [attack.source]: { ...source, hp: Math.max(1, source.hp - PARRY_REFLECT_DAMAGE) } } };
          defenseMessage = `Parried with ${defense.label}!`;
        } else defenseMessage = `Braced with ${defense.label}!`;
      } else player.receiveAttack(attack.damage, attack.stanceDamage, curse, cameraDefense === 'blocked');

    }
    const feedback: HitFeedback[] = [];
    const tick = next.lastTick !== engine.lastTick ? next.lastTick : null;
    const skippedId = !next.action && !engine.action && next.queue[0] !== engine.queue[0] ? engine.queue[0] : null;
    const frozen = skippedId && !next.actors[skippedId].defeated ? 'Frozen' : null;
    if (tick) feedback.push({ id: ++nextFeedbackId, castId: null, targetId: tick.actorId, kind: 'hurt', damage: tick.damage, label: frozen ? 'Burning · Frozen' : 'Burning' });
    else if (frozen) feedback.push({ id: ++nextFeedbackId, castId: null, targetId: skippedId!, kind: 'effect', damage: 0, label: frozen });
    const opponents = opponentsOf(next);
    const activeId = next.queue[0];
    if (activeId === 'player' && state.activeId !== 'player') {
      if (fieldTurns > 0) playerStore.getState().receiveFieldDamage(4);
      playerStore.getState().startTurn();
    }
    if (playerStore.getState().health <= 0) {
      set({ fieldTurns: 0, enemyTurn: null, status: 'lost', opponents, message: 'You have fallen. Try the encounter again.' });
      return;
    }
    const won = Object.values(opponents).every(actor => actor.defeated);
    set({ fieldTurns: won ? 0 : fieldTurns, enemyTurn: activeId === 'player' || won ? null : next, activeId: won ? 'player' : activeId, opponents, status: won ? 'won' : 'active',
      turnNumber: state.turnNumber + (activeId !== state.activeId && !won ? 1 : 0),
      ...(feedback.length ? { feedback } : {}),
      ...(clearDefense ? { playerDefense: null } : {}),
      message: activeId === 'player' ? 'Your turn. Choose a spell or end your turn.' : defenseMessage ?? next.lastMove });
  }
  return {
    encounterId: 'wolves', fieldTurns: 0, opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', pending: null, feedback: [], message: 'Choose a spell and a target.', playerDefense: null,
    triggerDefense(mode, label, durationMs) {
      const state = get();
      if (state.status !== 'active') return;
      const ms = Number.isFinite(durationMs) && durationMs! > 0 ? durationMs! : DEFENSE_MS[mode];
      set({ playerDefense: { mode, label: label ?? mode[0].toUpperCase() + mode.slice(1), untilMs: Date.now() + ms } });
    },
    castSpell(input, source = 'diagnostic', dodgeMode = 'natural', options) {
      const battle = get(), player = playerStore.getState(), spell = getSpell(input?.spellId);
      const fail = (message: string) => { set({ message }); return false; };
      if (battle.pending || battle.activeId !== 'player' || battle.status !== 'active') return false;
      if (!spell) return fail('Choose a known spell.');
      const targetId = spell.target === 'self' ? 'player' : input.targetId ?? '';
      if (spell.target === 'enemy' && (!battle.opponents[targetId] || battle.opponents[targetId].defeated)) return fail('Choose a living opponent.');
      if (player.health <= 0 || !['balanced', 'guarding', 'shaken'].includes(player.stance)) return fail('Staggered — end your turn to recover your stance.');
      if (player.magicPower < spell.cost) return fail('Not enough Magic Power. Rest or end your turn to recover it.');
      // Overcharge is spent by the next spell that deals damage, and pays back 1 MP on a Storm spell.
      const overcharged = spell.damage > 0 && player.statuses.some(status => status.id === 'overcharged');
      const id = ++nextCastId;
      const boost = Number.isFinite(options?.powerBoost) && options!.powerBoost! > 0 ? options!.powerBoost! : 1;
      // Lock the action before notifying external subscribers, preventing duplicate casts.
      set({ pending: { id, spell, targetId, dodgeMode: source === 'diagnostic' ? dodgeMode : 'natural', previousStance: player.stance, resolved: false,
        power: (overcharged ? SPELLS.overcharge.overcharge!.multiplier : 1) * boost, autoEndTurn: options?.autoEndTurn ?? source === 'glove' }, feedback: [],
        message: spell.target === 'self' ? `${spell.name}…` : `${spell.name} → ${nameOf(targetId)}${overcharged ? ' (overcharged)' : ''}` });
      player.setMagicPower(player.magicPower - spell.cost + (overcharged && spell.element === 'storm' ? 1 : 0));
      if (overcharged) player.removeStatus('overcharged');
      player.requestAttack(source, input);
      player.setStance('casting');
      return true;
    },
    resolveCast(id, roll = Math.random()) {
      const { pending, opponents } = get();
      if (!pending || pending.id !== id || pending.resolved) return;
      const spell = pending.spell;
      if (spell.target === 'self') {
        const player = playerStore.getState();
        if (spell.shield) player.addStatus({ id: 'shielded', remaining: spell.shield.turns, amount: spell.shield.amount });
        if (spell.overcharge) player.addStatus({ id: 'overcharged', remaining: spell.overcharge.turns });
        set({ pending: { ...pending, resolved: true }, feedback: [],
          message: spell.shield ? `Ice Shield raised: absorbs ${spell.shield.amount} damage.` : 'Overcharged: your next damaging spell hits 50% harder.' });
        return;
      }
      const living = enemyOrder.filter(enemyId => opponents[enemyId] && !opponents[enemyId].defeated);
      const next = { ...opponents }, feedback: HitFeedback[] = [], parts: string[] = [];
      spellHits(spell, pending.targetId, living, pending.power).forEach(({ targetId, base }, index) => {
        const target = next[targetId];
        if (index === 0 && canBeDodged(spell) && dodges(targetId, pending.dodgeMode, roll)) {
          feedback.push({ id: ++nextFeedbackId, castId: id, targetId, kind: 'dodge', damage: 0 });
          parts.push(`${nameOf(targetId)} dodged`);
          return;
        }
        const damage = spellDamage(spell, base, targetId, target), hp = Math.max(0, target.hp - damage), defeated = hp === 0;
        let statuses = target.statuses, energy = target.energy;
        if (!defeated && spell.applies) statuses = withStatus(statuses, { id: spell.applies.id, remaining: targetId === 'knight' && spell.applies.id === 'frozen' ? 1 : spell.applies.turns, amount: spell.applies.amount, source: 'player', appliedAction: PLAYER_ACTION });
        if (!defeated && spell.drain) energy = 0;
        next[targetId] = { ...target, hp, energy, defeated, statuses: defeated ? [] : statuses };
        const label = !defeated && spell.applies ? STATUS_EFFECTS[spell.applies.id].label : undefined;
        feedback.push({ id: ++nextFeedbackId, castId: id, targetId, kind: damage ? 'hurt' : 'effect', damage, label });
        parts.push(defeated ? `${nameOf(targetId)} defeated` : damage ? `${nameOf(targetId)} took ${damage}` : `${nameOf(targetId)} is ${label?.toLowerCase()}`);
      });
      set({ opponents: next, pending: { ...pending, resolved: true }, feedback, message: `${spell.name}: ${parts.join(', ')}.` });
    },
    finishCast(id) {
      const { pending } = get();
      if (!pending || pending.id !== id || !pending.resolved) return;
      restoreStance(pending);
      const won = Object.values(get().opponents).every(actor => actor.defeated);
      set({ pending: null, fieldTurns: won ? 0 : get().fieldTurns, status: won ? 'won' : 'active' });
      // Casting hands the turn to the wolves once the spell has played out.
      if (!won && pending.autoEndTurn) get().endTurn();
    },
    rest() {
      const state = get(), player = playerStore.getState();
      if (state.pending || state.enemyTurn || state.activeId !== 'player' || state.status !== 'active' || player.health <= 0) return;
      // Advance first to lock the action against repeat clicks/subscriber requests.
      get().endTurn();
      if (!get().enemyTurn) return;
      player.setStanceValue(player.stanceValue + 45);
      player.setMagicPower(player.magicPower + 3);
      set({ message: 'You rest, recovering stance and Magic Power.' });
    },
    endTurn() {
      const state = get();
      if (state.pending || state.enemyTurn || state.status !== 'active') return;
      let engine = createEncounter(state.encounterId);
      const queue = ['player', ...enemyOrder.filter(id => state.opponents[id] && !state.opponents[id].defeated)];
      if (queue.length < 2) return;
      engine = { ...engine, actors: { ...engine.actors, ...state.opponents }, queue, roundPending: [...queue], serial: ++nextTurnSession * 1000 };
      engine = encounterReducer(engine, { type: 'pass', turn: engine.serial });
      set({ fieldTurns: Math.max(0, state.fieldTurns - 1), enemyTurn: engine, activeId: engine.queue[0], turnNumber: state.turnNumber + 1, feedback: [], message: 'Opponents are acting.' });
    },
    beginEnemy() {
      const state = get(), engine = state.enemyTurn;
      if (!engine || engine.action || engine.queue[0] === 'player' || state.status !== 'active') return;
      const next = encounterReducer(engine, { type: 'begin', actorId: engine.queue[0], turn: engine.serial });
      if (next !== engine) {
        if (next.action && !engine.action) useDefense.getState().begin(next.action.id, next.action.moveId);
        applyEngine(engine, next);
      }
    },
    enemyStep(type, actionId) {
      const state = get(), engine = state.enemyTurn;
      if (!engine || state.status !== 'active') return;
      const next = encounterReducer(engine, { type, actionId });
      if (next !== engine) applyEngine(engine, next);
    },
    diagnosticKillAll() {
      const state = get();
      if (state.status !== 'active') return;
      useDefense.getState().clear();
      if (state.pending) restoreStance(state.pending);
      set({ opponents: Object.fromEntries(Object.entries(state.opponents).map(([id, actor]) => [id, { ...actor, hp: 0, defeated: true, statuses: [] }])),
        fieldTurns: 0, pending: null, enemyTurn: null, feedback: [], activeId: 'player', status: 'won', message: 'Diagnostics: all opponents defeated.' });
    },
    cancelCast() {
      const pending = get().pending;
      if (pending) restoreStance(pending);
      set({ pending: null, feedback: [] });
    },
    reset(encounterId = get().encounterId) {
      useDefense.getState().clear();
      get().cancelCast();
      set({ encounterId, fieldTurns: 0, opponents: initialOpponents(encounterId), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', playerDefense: null, message: 'Choose a spell and a target.' });
    },
  };
});
