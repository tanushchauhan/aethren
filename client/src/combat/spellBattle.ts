import { create } from 'zustand';
import { combatants, createEncounter, armorValue, encounterReducer, PLAYER_ACTION, type EncounterState, type ActorState } from './encounter';
import { playerStore, stanceFromValue, type PlayerStance } from './playerState';
import { STATUS_EFFECTS, withStatus } from './statusEffects';
import { getSpell, SPELLS, type Spell, type SpellInput } from './spells';
export type DodgeMode = 'natural' | 'hit' | 'dodge';
/** `power` is the Overcharge multiplier locked in when the cast began. Self spells target `player`. */
export type Cast = { id: number; spell: Spell; targetId: string; dodgeMode: DodgeMode; previousStance: PlayerStance; resolved: boolean; power: number };
/** One wolf's reaction. `castId` is null for start-of-turn effects such as a burn tick. */
export type HitFeedback = { id: number; castId: number | null; targetId: string; kind: 'hurt' | 'dodge' | 'effect'; damage: number; label?: string };
interface SpellBattle {
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
  castSpell: (input: SpellInput, source?: 'diagnostic' | 'glove', dodgeMode?: DodgeMode) => boolean;
  resolveCast: (id: number, roll?: number) => void;
  finishCast: (id: number) => void;
  cancelCast: () => void;
  reset: () => void;
}
const initialOpponents = () => Object.fromEntries(Object.entries(createEncounter().actors).filter(([id]) => id !== 'player'));
const opponentsOf = (engine: EncounterState) => Object.fromEntries(Object.entries(engine.actors).filter(([id]) => id !== 'player'));
const nameOf = (id: string) => combatants.find(actor => actor.id === id)!.name;
const enemyOrder = combatants.filter(actor => actor.side === 'enemy').map(actor => actor.id);
let nextCastId = 0;
let nextTurnSession = 0;
let nextFeedbackId = 0;
const dodges = (targetId: string, dodgeMode: DodgeMode, roll: number) => dodgeMode === 'dodge' || (dodgeMode === 'natural' && roll < (targetId === 'center' ? .1 : .2));
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
    if (next.lastAttack && next.lastAttack !== engine.lastAttack) {
      playerStore.getState().receiveAttack(next.lastAttack.damage, next.lastAttack.stanceDamage);
    }
    const feedback: HitFeedback[] = [];
    const tick = next.lastTick !== engine.lastTick ? next.lastTick : null;
    const skippedId = !next.action && !engine.action && next.queue[0] !== engine.queue[0] ? engine.queue[0] : null;
    const frozen = skippedId && !next.actors[skippedId].defeated ? 'Frozen' : null;
    if (tick) feedback.push({ id: ++nextFeedbackId, castId: null, targetId: tick.actorId, kind: 'hurt', damage: tick.damage, label: frozen ? 'Burning · Frozen' : 'Burning' });
    else if (frozen) feedback.push({ id: ++nextFeedbackId, castId: null, targetId: skippedId!, kind: 'effect', damage: 0, label: frozen });
    const opponents = opponentsOf(next);
    const activeId = next.queue[0];
    if (activeId === 'player' && state.activeId !== 'player') playerStore.getState().startTurn();
    if (playerStore.getState().health <= 0) {
      set({ enemyTurn: null, status: 'lost', opponents, message: 'You have fallen. Try the encounter again.' });
      return;
    }
    const won = Object.values(opponents).every(actor => actor.defeated);
    set({ enemyTurn: activeId === 'player' || won ? null : next, activeId: won ? 'player' : activeId, opponents, status: won ? 'won' : 'active',
      turnNumber: state.turnNumber + (activeId !== state.activeId && !won ? 1 : 0),
      ...(feedback.length ? { feedback } : {}),
      message: activeId === 'player' ? 'Your turn. Choose a spell or end your turn.' : next.lastMove });
  }
  return {
    opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', pending: null, feedback: [], message: 'Choose a spell and a target.',
    castSpell(input, source = 'diagnostic', dodgeMode = 'natural') {
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
      // Lock the action before notifying external subscribers, preventing duplicate casts.
      set({ pending: { id, spell, targetId, dodgeMode: source === 'diagnostic' ? dodgeMode : 'natural', previousStance: player.stance, resolved: false,
        power: overcharged ? SPELLS.overcharge.overcharge!.multiplier : 1 }, feedback: [],
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
      const living = enemyOrder.filter(enemyId => !opponents[enemyId].defeated);
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
        if (!defeated && spell.applies) statuses = withStatus(statuses, { id: spell.applies.id, remaining: spell.applies.turns, amount: spell.applies.amount, source: 'player', appliedAction: PLAYER_ACTION });
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
      set({ pending: null, status: Object.values(get().opponents).every(actor => actor.defeated) ? 'won' : 'active' });
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
      let engine = createEncounter();
      const queue = ['player', ...enemyOrder.filter(id => !state.opponents[id].defeated)];
      if (queue.length < 2) return;
      engine = { ...engine, actors: { ...engine.actors, ...state.opponents }, queue, roundPending: [...queue], serial: ++nextTurnSession * 1000 };
      engine = encounterReducer(engine, { type: 'pass', turn: engine.serial });
      set({ enemyTurn: engine, activeId: engine.queue[0], turnNumber: state.turnNumber + 1, feedback: [], message: 'Opponents are acting.' });
    },
    beginEnemy() {
      const state = get(), engine = state.enemyTurn;
      if (!engine || engine.action || engine.queue[0] === 'player' || state.status !== 'active') return;
      const next = encounterReducer(engine, { type: 'begin', actorId: engine.queue[0], turn: engine.serial });
      if (next !== engine) applyEngine(engine, next);
    },
    enemyStep(type, actionId) {
      const state = get(), engine = state.enemyTurn;
      if (!engine || state.status !== 'active') return;
      const next = encounterReducer(engine, { type, actionId });
      if (next !== engine) applyEngine(engine, next);
    },
    cancelCast() {
      const pending = get().pending;
      if (pending) restoreStance(pending);
      set({ pending: null, feedback: [] });
    },
    reset() {
      get().cancelCast();
      set({ opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', message: 'Choose a spell and a target.' });
    },
  };
});
