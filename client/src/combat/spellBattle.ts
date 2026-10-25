import { create } from 'zustand';
import { combatants, createEncounter, armorValue, encounterReducer, type EncounterState, type ActorState } from './encounter';
import { playerStore, stanceFromValue, type PlayerStance } from './playerState';
import { buildSpell, type Spell, type SpellInput } from './spells';
export type DodgeMode = 'natural' | 'hit' | 'dodge';
export type Cast = { id: number; spell: Spell; targetId: string; dodgeMode: DodgeMode; previousStance: PlayerStance; resolved: boolean };
export type HitFeedback = { id: number; targetId: string; kind: 'hurt' | 'dodge'; damage: number };
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
  feedback: HitFeedback | null;
  message: string;
  castSpell: (input: SpellInput, source?: 'diagnostic' | 'glove', dodgeMode?: DodgeMode) => boolean;
  resolveCast: (id: number, roll?: number) => void;
  finishCast: (id: number) => void;
  cancelCast: () => void;
  reset: () => void;
}
const initialOpponents = () => Object.fromEntries(Object.entries(createEncounter().actors).filter(([id]) => id !== 'player'));
let nextCastId = 0;
let nextTurnSession = 0;
export function resolveSpellHit(spell: Spell, targetId: string, target: ActorState, dodgeMode: DodgeMode, roll: number) {
  const dodged = dodgeMode === 'dodge' || (dodgeMode === 'natural' && roll < (targetId === 'center' ? .1 : .2));
  return { dodged, damage: dodged ? 0 : Math.max(1, spell.damage - armorValue(targetId, target)) };
}
export const useSpellBattle = create<SpellBattle>((set, get) => ({
  opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', pending: null, feedback: null, message: 'Choose a spell and a target.',
  castSpell(input, source = 'diagnostic', dodgeMode = 'natural') {
    const battle = get(), player = playerStore.getState(), target = battle.opponents[input.targetId], spell = buildSpell(input);
    const fail = (message: string) => { set({ message }); return false; };
    if (battle.pending || battle.activeId !== 'player' || battle.status !== 'active') return false;
    if (!spell || !target || target.defeated) return fail('Choose a living opponent.');
    if (player.health <= 0 || !['balanced', 'guarding', 'shaken'].includes(player.stance)) return fail('Staggered — end your turn to recover your stance.');
    if (player.magicPower < spell.cost) return fail('Not enough Magic Power. Refill it to keep testing.');
    const id = ++nextCastId;
    // Lock the action before notifying external subscribers, preventing duplicate casts.
    set({ pending: { id, spell, targetId: input.targetId, dodgeMode: source === 'diagnostic' ? dodgeMode : 'natural', previousStance: player.stance, resolved: false }, feedback: null,
      message: `${spell.name} → ${combatants.find(actor => actor.id === input.targetId)!.name}` });
    player.setMagicPower(player.magicPower - spell.cost);
    player.requestAttack(source, input);
    player.setStance('casting');
    return true;
  },
  resolveCast(id, roll = Math.random()) {
    const { pending, opponents } = get();
    if (!pending || pending.id !== id || pending.resolved) return;
    const target = opponents[pending.targetId];
    const { dodged, damage } = resolveSpellHit(pending.spell, pending.targetId, target, pending.dodgeMode, roll);
    const hp = Math.max(0, target.hp - damage);
    const name = combatants.find(actor => actor.id === pending.targetId)!.name;
    set({ opponents: { ...opponents, [pending.targetId]: { ...target, hp, defeated: hp === 0, statuses: hp === 0 ? [] : target.statuses } },
      pending: { ...pending, resolved: true }, feedback: { id, targetId: pending.targetId, kind: dodged ? 'dodge' : 'hurt', damage },
      message: dodged ? `${name} dodged ${pending.spell.name}.` : hp === 0 ? `${name} defeated.` : `${name} took ${damage} damage.` });
  },
  finishCast(id) {
    const { pending } = get();
    if (!pending || pending.id !== id || !pending.resolved) return;
    if (playerStore.getState().stance === 'casting') playerStore.setState({ stance: pending.previousStance === 'guarding' ? 'guarding' : stanceFromValue(playerStore.getState().stanceValue) });
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
    const queue = ['player', ...combatants.filter(actor => actor.side === 'enemy' && !state.opponents[actor.id].defeated).map(actor => actor.id)];
    if (queue.length < 2) return;
    engine = { ...engine, actors: { ...engine.actors, ...state.opponents }, queue, roundPending: [...queue], serial: ++nextTurnSession * 1000 };
    engine = encounterReducer(engine, { type: 'pass', turn: engine.serial });
    set({ enemyTurn: engine, activeId: engine.queue[0], turnNumber: state.turnNumber + 1, feedback: null, message: 'Opponents are acting.' });
  },
  beginEnemy() {
    const state = get(), engine = state.enemyTurn;
    if (!engine || engine.action || engine.queue[0] === 'player') return;
    const next = encounterReducer(engine, { type: 'begin', actorId: engine.queue[0], turn: engine.serial });
    set({ enemyTurn: next, opponents: Object.fromEntries(Object.entries(next.actors).filter(([id]) => id !== 'player')), message: next.lastMove });
  },
  enemyStep(type, actionId) {
    const state = get(), engine = state.enemyTurn;
    if (!engine || state.status !== 'active') return;
    const next = encounterReducer(engine, { type, actionId });
    if (next === engine) return;
    // Consume only a newly emitted attack, including the media-failure return path.
    if (next.lastAttack && next.lastAttack !== engine.lastAttack) {
      playerStore.getState().receiveAttack(next.lastAttack.damage, next.lastAttack.stanceDamage);
    }
    const activeId = next.queue[0];
    if (activeId === 'player' && state.activeId !== 'player') playerStore.getState().startTurn();
    if (playerStore.getState().health <= 0) {
      set({ enemyTurn: null, status: 'lost', message: 'You have fallen. Try the encounter again.' });
      return;
    }
    set({ enemyTurn: activeId === 'player' ? null : next, activeId,
      turnNumber: state.turnNumber + (activeId !== state.activeId ? 1 : 0),
      opponents: Object.fromEntries(Object.entries(next.actors).filter(([id]) => id !== 'player')),
      message: activeId === 'player' ? 'Your turn. Build a spell or end your turn.' : next.lastMove });
  },
  cancelCast() {
    const pending = get().pending;
    if (pending && playerStore.getState().stance === 'casting') playerStore.setState({ stance: pending.previousStance === 'guarding' ? 'guarding' : stanceFromValue(playerStore.getState().stanceValue) });
    set({ pending: null, feedback: null });
  },
  reset() {
    get().cancelCast();
    set({ opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', message: 'Choose a spell and a target.' });
  },
}));
