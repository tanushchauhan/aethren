import { hasStatus, withStatus, type StatusEffect } from './statusEffects';
export type MoveId = 'roar' | 'charge-slash' | 'jaw-grab' | 'rest' | 'dark-slash' | 'aura-flash' | 'descent' | 'scorn-inferno';
export type CombatMove = { id: MoveId; name: string; cost: number; cooldown: number; video?: string; sound?: string; start: number; impact: number; end: number };
export const moves: Record<MoveId, CombatMove> = {
  roar: { id: 'roar', name: 'Roar', cost: 3, cooldown: 3, video: '/art/combat/moves/roar.mp4', start: 0, impact: 1.5, end: 4.8 },
  'charge-slash': { id: 'charge-slash', name: 'Charge and Slash', cost: 4, cooldown: 0, video: '/art/combat/moves/charge-slash.mp4', start: 4.8, impact: 6.2, end: 9.95 },
  'jaw-grab': { id: 'jaw-grab', name: 'Jaw and Grab', cost: 8, cooldown: 3, video: '/art/combat/moves/jaw-grab.mp4', start: 0, impact: 1.8, end: 4.95 },
  'dark-slash': { id: 'dark-slash', name: 'Scorn Cleave', cost: 5, cooldown: 0, video: '/art/boss/dark-slash.mp4', sound: '/audio/axe-swing.wav', start: 0, impact: 1.4, end: 4.95 },
  'aura-flash': { id: 'aura-flash', name: 'Eclipse of Scorn', cost: 12, cooldown: 3, video: '/art/boss/aura-flash.mp4', sound: '/audio/axe-swing.wav', start: 0, impact: 1.35, end: 4.95 },
  'scorn-inferno': { id: 'scorn-inferno', name: 'Scorn Inferno', cost: 16, cooldown: 7, video: '/art/boss/scorn-inferno.mp4', sound: '/audio/scorn-flames.wav', start: 0, impact: 1.5, end: 4.95 },
  descent: { id: 'descent', name: 'The gatekeeper descends', cost: 0, cooldown: 0, video: '/art/boss/descent.mp4', start: 0, impact: 1.8, end: 4.95 },
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
export const knight: Combatant = { id: 'knight', name: 'The Ruined Gatekeeper', side: 'enemy', sprite: '/art/boss/ruined-knight-advancing.png', kind: 'knight', maxHp: 240, maxEnergy: 16, damage: 14, armor: 4, moves: ['dark-slash', 'aura-flash', 'scorn-inferno', 'rest'] };
combatants.push(knight);
export type EncounterId = 'wolves' | 'knight';
export const rosterFor = (id: EncounterId) => combatants.filter(actor => actor.side === 'player' || (id === 'knight' ? actor.id === 'knight' : actor.id !== 'knight'));
export const definition = (id: string) => combatants.find(actor => actor.id === id)!;
export type OpponentStatus = StatusEffect<'roused' | 'burning' | 'chilled' | 'frozen' | 'drained'> & { source: string; appliedAction: number };
/** Player spells are not opponent actions, so their effects start ticking on the target's very next turn. */
export const PLAYER_ACTION = -1;
/** `maxHp` overrides the roster's when an encounter is scaled, as the knight is for two heroes. */
export type ActorState = { hp: number; maxHp?: number; energy: number; cooldowns: Partial<Record<MoveId, number>>; statuses: OpponentStatus[]; turns: number; defeated: boolean };
export type PendingMove = { id: number; actorId: string; moveId: MoveId; phase: 'approaching' | 'playing' | 'returning'; resolved: boolean };
export type AttackEvent = { actionId: number; source: string; target: string; damage: number; stanceDamage: number; type: 'standard' | 'grab' | 'scorn' | 'eclipse' | 'inferno' };
export type EncounterState = {
  actors: Record<string, ActorState>; queue: string[]; round: number; roundPending: string[];
  serial: number; action: PendingMove | null; lastMove: string; lastAttack: AttackEvent | null;
  /** The latest start-of-turn burn, so the scene can show it once. */
  lastTick: { serial: number; actorId: string; damage: number } | null;
};
export function createEncounter(id: EncounterId = 'wolves'): EncounterState {
  const roster = rosterFor(id);
  const queue = roster.map(actor => actor.id);
  return { actors: Object.fromEntries(roster.map(actor => [actor.id, { hp: actor.maxHp, energy: actor.maxEnergy, cooldowns: {}, statuses: [], turns: 0, defeated: false }])),
    queue, round: 1, roundPending: [...queue], serial: 0, action: null, lastMove: 'The encounter begins.', lastAttack: null, lastTick: null };
}
export const isRoused = (actor: ActorState) => hasStatus(actor.statuses, 'roused');
export const CHILL_FACTOR = .7;
const chill = (actor: ActorState) => hasStatus(actor.statuses, 'chilled') ? CHILL_FACTOR : 1;
export const attackDamage = (id: string, actor: ActorState) => Math.floor(definition(id).damage * (isRoused(actor) ? 1.25 : 1) * chill(actor));
export const armorValue = (id: string, actor: ActorState) => definition(id).armor + (isRoused(actor) ? 2 : 0);
export function canUseMove(id: string, actor: ActorState, move: MoveId) {
  return !actor.defeated && definition(id).moves.includes(move) && actor.energy >= moves[move].cost && !(actor.cooldowns[move] ?? 0)
    && (move !== 'roar' || !isRoused(actor))
    && (move !== 'jaw-grab' || !hasStatus(actor.statuses, 'chilled'));
}
/** Preview what move an enemy will choose on its next turn, and which element counters it. */
export function previewIntent(id: string, actor: ActorState): { moveId: MoveId; moveName: string; counterTip: string } | null {
  if (actor.defeated) return null;
  if (hasStatus(actor.statuses, 'frozen')) return { moveId: 'rest', moveName: 'Frozen', counterTip: 'Fire shatters ice (+50% dmg)!' };
  const ready: ActorState = {
    ...actor,
    energy: Math.min(definition(id).maxEnergy, actor.energy + 3),
    cooldowns: Object.fromEntries(Object.entries(actor.cooldowns).map(([k, v]) => [k, Math.max(0, (v ?? 0) - 1)])),
  };
  const moveId = selectMove(id, ready);
  const moveName = moves[moveId].name;
  const counterTip =
    moveId === 'jaw-grab' ? 'Counter: Frost chills grab · Static Shock strips Roused'
    : moveId === 'roar' ? 'Counter: Static Shock drains energy · Frost Prison freezes'
    : moveId === 'scorn-inferno' || moveId === 'aura-flash' ? 'Counter: Ice Shield blocks curse · Static Shock drains'
    : moveId === 'rest' ? 'Vulnerable: Punish with Fire!'
    : isRoused(actor) ? 'Roused (+2 Armor): Counter with Fire Lance or Static Shock'
    : 'Counter: Chill with Frost or Dodge on impact';
  return { moveId, moveName, counterTip };
}
export function selectMove(id: string, actor: ActorState): MoveId {
  if (hasStatus(actor.statuses, 'drained')) return 'rest';
  if (id === 'knight') {
    // Save energy for the ultimate after three actions; Drain and Freeze still interrupt.
    if (actor.turns >= 3 && !(actor.cooldowns['scorn-inferno'] ?? 0)) return canUseMove(id, actor, 'scorn-inferno') ? 'scorn-inferno' : 'rest';
    if (actor.turns > 0 && canUseMove(id, actor, 'aura-flash')) return 'aura-flash';
    return canUseMove(id, actor, 'dark-slash') ? 'dark-slash' : 'rest';
  }
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
/** Ends the actor's own turn: effects it did not apply this turn count down, then the queue moves on. */
function endOwnTurn(state: EncounterState, actorId: string, actionId: number): EncounterState {
  const actor = state.actors[actorId];
  const statuses = actor.statuses.map(status => status.appliedAction === actionId ? status : { ...status, remaining: status.remaining - 1 }).filter(status => status.remaining > 0);
  return advance({ ...state, actors: { ...state.actors, [actorId]: { ...actor, statuses, turns: actor.turns + 1 } } });
}
function resolveMove(state: EncounterState): EncounterState {
  const action = state.action;
  if (!action || action.resolved) return state;
  const actor = state.actors[action.actorId];
  let updated = actor;
  let lastAttack = state.lastAttack;
  if (action.moveId === 'roar') updated = { ...actor, statuses: withStatus(actor.statuses, { id: 'roused', source: action.actorId, remaining: 2, appliedAction: action.id }) };
  if (action.moveId === 'rest') updated = { ...actor, energy: Math.min(definition(action.actorId).maxEnergy, actor.energy + 5) };
  if (action.moveId === 'charge-slash' || action.moveId === 'jaw-grab') {
    // The battle store consumes this event once and applies player health, stance and bleeding.
    lastAttack = { actionId: action.id, source: action.actorId, target: 'player', damage: attackDamage(action.actorId, actor), stanceDamage: Math.floor((action.moveId === 'jaw-grab' ? 55 : action.actorId === 'center' ? 30 : 22) * chill(actor)), type: action.moveId === 'jaw-grab' ? 'grab' : 'standard' };
  }
  if (action.moveId === 'dark-slash' || action.moveId === 'aura-flash') {
    const aura = action.moveId === 'aura-flash';
    lastAttack = { actionId: action.id, source: action.actorId, target: 'player', damage: Math.floor((aura ? 22 : 14) * chill(actor)), stanceDamage: Math.floor((aura ? 50 : 26) * chill(actor)), type: aura ? 'eclipse' : 'scorn' };
  }
  if (action.moveId === 'scorn-inferno') lastAttack = { actionId: action.id, source: action.actorId, target: 'player', damage: Math.floor(10 * chill(actor)), stanceDamage: Math.floor(35 * chill(actor)), type: 'inferno' };
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
    let actor = state.actors[action.actorId];
    let next = state;
    const burning = actor.statuses.find(status => status.id === 'burning');
    if (burning) {
      // Burning ignores armor and can finish the wolf before it acts.
      const damage = Math.min(actor.hp, burning.amount ?? 0), hp = actor.hp - damage;
      actor = { ...actor, hp, defeated: hp === 0, statuses: hp === 0 ? [] : actor.statuses };
      next = { ...state, actors: { ...state.actors, [action.actorId]: actor }, lastTick: { serial: state.serial, actorId: action.actorId, damage } };
      if (actor.defeated) return advance({ ...next, lastMove: `${definition(action.actorId).name} burned away.` });
    }
    if (hasStatus(actor.statuses, 'frozen')) return endOwnTurn({ ...next, lastMove: `${definition(action.actorId).name} is frozen solid.` }, action.actorId, state.serial);
    const ready: ActorState = { ...actor, energy: Math.min(definition(action.actorId).maxEnergy, actor.energy + 3),
      cooldowns: Object.fromEntries(Object.entries(actor.cooldowns).map(([id, value]) => [id, Math.max(0, value - 1)])) };
    const moveId = selectMove(action.actorId, ready);
    if (!canUseMove(action.actorId, ready, moveId)) return next;
    const move = moves[moveId];
    return { ...next, actors: { ...next.actors, [action.actorId]: { ...ready, energy: ready.energy - move.cost, cooldowns: { ...ready.cooldowns, [moveId]: move.cooldown } } },
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
  if (action.type === 'finish' && pending.phase === 'returning') return endOwnTurn(state, pending.actorId, pending.id);
  return state;
}
