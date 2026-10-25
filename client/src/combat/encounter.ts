import type { StatusEffect } from './statusEffects';
export type MoveId = 'roar' | 'charge-slash' | 'jaw-grab' | 'rest';
export type CombatMove = { id: MoveId; name: string; cost: number; cooldown: number; video?: string; start: number; impact: number; end: number };
export const moves: Record<MoveId, CombatMove> = {
  roar: { id: 'roar', name: 'Roar', cost: 3, cooldown: 3, video: '/art/combat/moves/roar.mp4', start: 0, impact: 1.5, end: 4.8 },
  'charge-slash': { id: 'charge-slash', name: 'Charge and Slash', cost: 4, cooldown: 0, video: '/art/combat/moves/charge-slash.mp4', start: 4.8, impact: 6.2, end: 9.95 },
  'jaw-grab': { id: 'jaw-grab', name: 'Jaw and Grab', cost: 8, cooldown: 3, video: '/art/combat/moves/jaw-grab.mp4', start: 0, impact: 1.8, end: 4.95 },
  rest: { id: 'rest', name: 'Rest', cost: 0, cooldown: 0, start: 0, impact: .3, end: .8 },
};
export type Combatant = {
  id: string; name: string; side: 'player' | 'enemy'; sprite: string; kind: string;
  maxHp: number; maxEnergy: number; damage: number; armor: number; moves: MoveId[];
};
export const combatants: Combatant[] = [
  { id: 'player', name: 'You', side: 'player', sprite: '/art/spellbearer-male.png', kind: 'player', maxHp: 100, maxEnergy: 10, damage: 0, armor: 0, moves: [] },
  { id: 'left', name: 'Left wolf', side: 'enemy', sprite: '/art/combat/wolf-stalker.png', kind: 'flank', maxHp: 40, maxEnergy: 10, damage: 8, armor: 0, moves: ['roar', 'charge-slash', 'jaw-grab', 'rest'] },
  { id: 'center', name: 'Pack leader', side: 'enemy', sprite: '/art/combat/wolf-leader.png', kind: 'leader', maxHp: 60, maxEnergy: 10, damage: 12, armor: 1, moves: ['roar', 'charge-slash', 'jaw-grab', 'rest'] },
  { id: 'right', name: 'Right wolf', side: 'enemy', sprite: '/art/combat/wolf-stalker.png', kind: 'flank mirrored', maxHp: 40, maxEnergy: 10, damage: 8, armor: 0, moves: ['roar', 'charge-slash', 'jaw-grab', 'rest'] },
];
export const definition = (id: string) => combatants.find(actor => actor.id === id)!;
export type OpponentStatus = StatusEffect<'roused'> & { source: string; appliedAction: number };
export type ActorState = { hp: number; energy: number; cooldowns: Partial<Record<MoveId, number>>; statuses: OpponentStatus[]; turns: number; defeated: boolean };
export type PendingMove = { id: number; actorId: string; moveId: MoveId; phase: 'approaching' | 'playing' | 'returning'; resolved: boolean };
export type AttackEvent = { actionId: number; source: string; target: string; damage: number; stanceDamage: number; type: 'standard' | 'grab' };
export type EncounterState = {
  actors: Record<string, ActorState>; queue: string[]; round: number; roundPending: string[];
  serial: number; action: PendingMove | null; lastMove: string; lastAttack: AttackEvent | null;
};
export function createEncounter(): EncounterState {
  const queue = combatants.map(actor => actor.id);
  return { actors: Object.fromEntries(combatants.map(actor => [actor.id, { hp: actor.maxHp, energy: actor.maxEnergy, cooldowns: {}, statuses: [], turns: 0, defeated: false }])),
    queue, round: 1, roundPending: [...queue], serial: 0, action: null, lastMove: 'The encounter begins.', lastAttack: null };
}
export const isRoused = (actor: ActorState) => actor.statuses.some(status => status.id === 'roused');
export const attackDamage = (id: string, actor: ActorState) => Math.floor(definition(id).damage * (isRoused(actor) ? 1.25 : 1));
export const armorValue = (id: string, actor: ActorState) => definition(id).armor + (isRoused(actor) ? 2 : 0);
export function canUseMove(id: string, actor: ActorState, move: MoveId) {
  return !actor.defeated && definition(id).moves.includes(move) && actor.energy >= moves[move].cost && !(actor.cooldowns[move] ?? 0)
    && (move !== 'roar' || !isRoused(actor));
}
export function selectMove(id: string, actor: ActorState): MoveId {
  if (actor.turns === 0 && id !== 'center' && canUseMove(id, actor, 'charge-slash')) return 'charge-slash';
  if (actor.energy < 4) return 'rest';
  if (actor.turns > 0 && isRoused(actor) && canUseMove(id, actor, 'jaw-grab')) return 'jaw-grab';
  if (canUseMove(id, actor, 'roar')) return 'roar';
  if (canUseMove(id, actor, 'charge-slash')) return 'charge-slash';
  return 'rest';
}
export type EncounterAction =
  | { type: 'pass'; turn: number }
  | { type: 'begin'; actorId: string; turn: number }
  | { type: 'play' | 'impact' | 'return' | 'finish'; actionId: number }
  | { type: 'damage-opponent'; actorId: string; amount: number };

function advance(state: EncounterState): EncounterState {
  const current = state.queue[0];
  const queue = [...state.queue.slice(1), current].filter(id => id && !state.actors[id].defeated);
  const pending = state.roundPending.filter(id => id !== current && !state.actors[id].defeated);
  return { ...state, queue, roundPending: pending.length ? pending : [...queue], round: state.round + (pending.length ? 0 : 1), serial: state.serial + 1, action: null };
}
function resolveMove(state: EncounterState): EncounterState {
  const action = state.action;
  if (!action || action.resolved) return state;
  const actor = state.actors[action.actorId];
  let updated = actor;
  let lastAttack = state.lastAttack;
  if (action.moveId === 'roar') updated = { ...actor, statuses: [{ id: 'roused', source: action.actorId, remaining: 2, appliedAction: action.id }] };
  if (action.moveId === 'rest') updated = { ...actor, energy: Math.min(definition(action.actorId).maxEnergy, actor.energy + 5) };
  if (action.moveId === 'charge-slash' || action.moveId === 'jaw-grab') {
    // The battle store consumes this event once and applies player health, stance and bleeding.
    lastAttack = { actionId: action.id, source: action.actorId, target: 'player', damage: attackDamage(action.actorId, actor), stanceDamage: action.moveId === 'jaw-grab' ? 55 : action.actorId === 'center' ? 30 : 22, type: action.moveId === 'jaw-grab' ? 'grab' : 'standard' };
  }
  return { ...state, actors: { ...state.actors, [action.actorId]: updated }, lastAttack,
    action: { ...action, resolved: true }, lastMove: `${definition(action.actorId).name} used ${moves[action.moveId].name}.` };
}
export function encounterReducer(state: EncounterState, action: EncounterAction): EncounterState {
  if (action.type === 'damage-opponent') {
    const actor = state.actors[action.actorId];
    if (!actor || actor.defeated || definition(action.actorId).side !== 'enemy' || !Number.isFinite(action.amount) || action.amount <= 0) return state;
    const hp = Math.max(0, actor.hp - Math.max(1, Math.floor(action.amount) - armorValue(action.actorId, actor)));
    const next = { ...state, actors: { ...state.actors, [action.actorId]: { ...actor, hp, defeated: hp === 0, statuses: hp === 0 ? [] : actor.statuses } } };
    if (hp > 0) return next;
    if (state.queue[0] === action.actorId) return advance(next);
    const queue = next.queue.filter(id => id !== action.actorId);
    const pending = next.roundPending.filter(id => id !== action.actorId);
    return { ...next, queue, roundPending: pending.length ? pending : [...queue], round: next.round + (pending.length ? 0 : 1) };
  }
  if (action.type === 'pass') {
    if (state.action || state.queue[0] !== 'player' || action.turn !== state.serial || !state.queue.some(id => definition(id).side === 'enemy')) return state;
    return advance({ ...state, lastMove: 'You passed.' });
  }
  if (action.type === 'begin') {
    if (state.action || state.queue[0] !== action.actorId || action.turn !== state.serial || definition(action.actorId).side !== 'enemy') return state;
    const actor = state.actors[action.actorId];
    const ready: ActorState = { ...actor, energy: Math.min(definition(action.actorId).maxEnergy, actor.energy + 3),
      cooldowns: Object.fromEntries(Object.entries(actor.cooldowns).map(([id, value]) => [id, Math.max(0, value - 1)])) };
    const moveId = selectMove(action.actorId, ready);
    if (!canUseMove(action.actorId, ready, moveId)) return state;
    const move = moves[moveId];
    return { ...state, actors: { ...state.actors, [action.actorId]: { ...ready, energy: ready.energy - move.cost, cooldowns: { ...ready.cooldowns, [moveId]: move.cooldown } } },
      action: { id: state.serial, actorId: action.actorId, moveId, phase: 'approaching', resolved: false }, lastMove: `${definition(action.actorId).name} prepares ${move.name}.` };
  }
  const pending = state.action;
  if (!pending || pending.id !== action.actionId) return state;
  if (action.type === 'play' && pending.phase === 'approaching') return { ...state, action: { ...pending, phase: 'playing' } };
  if (action.type === 'impact' && pending.phase === 'playing') return resolveMove(state);
  if (action.type === 'return' && pending.phase === 'playing') {
    const resolved = resolveMove(state); // Also completes effects on media failure, once only.
    return { ...resolved, action: { ...resolved.action!, phase: 'returning' } };
  }
  if (action.type === 'finish' && pending.phase === 'returning') {
    const actor = state.actors[pending.actorId];
    const statuses = actor.statuses.map(status => status.appliedAction === pending.id ? status : { ...status, remaining: status.remaining - 1 }).filter(status => status.remaining > 0);
    return advance({ ...state, actors: { ...state.actors, [pending.actorId]: { ...actor, statuses, turns: actor.turns + 1 } } });
  }
  return state;
}
