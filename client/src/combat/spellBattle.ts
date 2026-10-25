import { create } from 'zustand';
import { combatants, createEncounter, armorValue, encounterReducer, type EncounterState, type ActorState } from './encounter';
import { playerStore, type PlayerStance } from './playerState';
import { buildSpell, type Spell, type SpellInput } from './spells';
export type DodgeMode = 'natural' | 'hit' | 'dodge';
export type Cast = { id: number; spell: Spell; targetId: string; dodgeMode: DodgeMode; previousStance: PlayerStance; resolved: boolean };
export type HitFeedback = { id: number; targetId: string; kind: 'hurt' | 'dodge'; damage: number };
interface SpellBattle {
  opponents: Record<string, ActorState>;
  enemyTurn: EncounterState | null;
  activeId: string;
  turnNumber: number;
  status: 'active' | 'won';
  endTurn: () => void;
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
    if (player.health <= 0 || !['balanced', 'guarding'].includes(player.stance)) return fail('Return to a balanced or guarding stance to cast.');
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
    if (playerStore.getState().stance === 'casting') playerStore.getState().setStance(pending.previousStance);
    set({ pending: null, status: Object.values(get().opponents).every(actor => actor.defeated) ? 'won' : 'active' });
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
    if (!engine) return;
    const next = encounterReducer(engine, { type, actionId });
    if (next === engine) return;
    const activeId = next.queue[0];
    set({ enemyTurn: activeId === 'player' ? null : next, activeId,
      turnNumber: state.turnNumber + (activeId !== state.activeId ? 1 : 0),
      opponents: Object.fromEntries(Object.entries(next.actors).filter(([id]) => id !== 'player')),
      message: activeId === 'player' ? 'Your turn. Build a spell or end your turn.' : next.lastMove });
  },
  cancelCast() {
    const pending = get().pending;
    if (pending && playerStore.getState().stance === 'casting') playerStore.getState().setStance(pending.previousStance);
    set({ pending: null, feedback: null });
  },
  reset() {
    get().cancelCast();
    set({ opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active', message: 'Choose a spell and a target.' });
  },
}));
