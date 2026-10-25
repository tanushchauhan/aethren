import { describe, expect, it } from 'vitest';
import { armorValue, attackDamage, canUseMove, createEncounter, encounterReducer, selectMove, type EncounterState } from './encounter';
const pass = (state: EncounterState) => encounterReducer(state, { type: 'pass', turn: state.serial });
function begin(state: EncounterState) { return encounterReducer(state, { type: 'begin', actorId: state.queue[0], turn: state.serial }); }
function complete(state: EncounterState) {
  const actionId = state.action!.id;
  state = encounterReducer(state, { type: 'play', actionId });
  state = encounterReducer(state, { type: 'impact', actionId });
  state = encounterReducer(state, { type: 'return', actionId });
  return encounterReducer(state, { type: 'finish', actionId });
}
function round(state: EncounterState) {
  state = pass(state);
  for (let i = 0; i < 3; i++) state = complete(begin(state));
  return state;
}
describe('opponent combat', () => {
  it('runs a complete round with correct moves and no player damage', () => {
    let state = pass(createEncounter());
    state = begin(state);
    expect(state.action?.moveId).toBe('charge-slash');
    expect(state.actors.left.energy).toBe(6);
    state = complete(state);
    expect(state.lastAttack).toMatchObject({ source: 'left', target: 'player', damage: 8 });
    state = begin(state);
    expect(state.action?.moveId).toBe('roar');
    state = complete(state);
    expect(state.actors.center.energy).toBe(7);
    expect(state.actors.center.statuses[0].remaining).toBe(2);
    expect(attackDamage('center', state.actors.center)).toBe(15);
    expect(armorValue('center', state.actors.center)).toBe(3);
    state = complete(begin(state));
    expect(state.queue).toEqual(['player', 'left', 'center', 'right']);
    expect(state.round).toBe(2);
    expect(state.actors.player.hp).toBe(100);
    expect(state.actors.player.energy).toBe(10);
  });
  it('expires self buffs after two subsequent own turns and ticks cooldowns only for their owner', () => {
    let state = round(createEncounter());
    expect(state.actors.center.cooldowns.roar).toBe(3);
    state = pass(state);
    state = complete(begin(state));
    expect(state.actors.center.cooldowns.roar).toBe(3);
    state = complete(begin(state));
    expect(state.actors.center.statuses[0].remaining).toBe(1);
    expect(state.actors.center.cooldowns.roar).toBe(2);
    state = complete(begin(state));
    state = round(state);
    expect(state.actors.center.statuses).toEqual([]);
    expect(armorValue('center', state.actors.center)).toBe(1);
    expect(attackDamage('center', state.actors.center)).toBe(12);
    state = complete(begin(pass(state)));
    state = begin(state);
    expect(state.action?.moveId).toBe('roar');
  });
  it('prevents duplicate costs, impacts, finishes and out-of-turn actions', () => {
    let state = createEncounter();
    expect(encounterReducer(state, { type: 'begin', actorId: 'left', turn: 0 })).toBe(state);
    state = begin(pass(state));
    const actionId = state.action!.id;
    expect(begin(state)).toBe(state);
    expect(pass(state)).toBe(state);
    state = encounterReducer(state, { type: 'play', actionId });
    state = encounterReducer(state, { type: 'impact', actionId });
    expect(encounterReducer(state, { type: 'impact', actionId })).toBe(state);
    expect(state.actors.left.energy).toBe(6);
    state = encounterReducer(state, { type: 'return', actionId });
    state = encounterReducer(state, { type: 'finish', actionId });
    expect(encounterReducer(state, { type: 'finish', actionId })).toBe(state);
  });
  it('resolves a failed media action once before returning', () => {
    let state = begin(pass(createEncounter()));
    const actionId = state.action!.id;
    state = encounterReducer(state, { type: 'play', actionId });
    state = encounterReducer(state, { type: 'return', actionId });
    expect(state.lastAttack?.damage).toBe(8);
    expect(state.action?.resolved).toBe(true);
    expect(encounterReducer(state, { type: 'return', actionId })).toBe(state);
    state = encounterReducer(state, { type: 'finish', actionId });
    expect(state.queue[0]).toBe('center');
  });
  it('validates energy, prevents stacking, and falls back to Rest with capped recovery', () => {
    let state = pass(createEncounter());
    const actor = { ...state.actors.left, turns: 1, energy: 0, cooldowns: { roar: 3 } };
    expect(canUseMove('left', actor, 'charge-slash')).toBe(false);
    expect(selectMove('left', actor)).toBe('rest');
    state = { ...state, actors: { ...state.actors, left: actor } };
    state = begin(state);
    expect(state.action?.moveId).toBe('rest');
    expect(state.actors.left.energy).toBe(3);
    state = complete(state);
    expect(state.actors.left.energy).toBe(8);
    const buffed = { ...actor, energy: 10, cooldowns: {}, statuses: [{ id: 'roused' as const, remaining: 2, source: 'left', appliedAction: 0 }] };
    expect(canUseMove('left', buffed, 'roar')).toBe(false);
  });
  it('removes defeated enemies without duplicate turns or round errors', () => {
    let state = begin(pass(createEncounter()));
    const stale = state.action!.id;
    state = encounterReducer(state, { type: 'damage-opponent', actorId: 'left', amount: 100 });
    expect(state.actors.left.hp).toBe(0);
    expect(state.queue).toEqual(['center', 'right', 'player']);
    expect(state.action).toBeNull();
    expect(encounterReducer(state, { type: 'impact', actionId: stale })).toBe(state);
    state = complete(begin(state));
    state = encounterReducer(state, { type: 'damage-opponent', actorId: 'right', amount: 100 });
    expect(state.queue[0]).toBe('player');
    expect(state.round).toBe(2);
    state = encounterReducer(state, { type: 'damage-opponent', actorId: 'center', amount: 100 });
    expect(state.queue).toEqual(['player']);
    expect(pass(state)).toBe(state);
  });
  it('applies armor to incoming opponent damage and rejects non-positive values', () => {
    let state = createEncounter();
    state = encounterReducer(state, { type: 'damage-opponent', actorId: 'center', amount: 8 });
    expect(state.actors.center.hp).toBe(53);
    expect(encounterReducer(state, { type: 'damage-opponent', actorId: 'center', amount: -5 })).toBe(state);
  });
});


describe('Jaw and Grab and Rest', () => {
  it('spends 8 energy once, emits heavy stance damage once and starts cooldown', () => {
    let state = pass(createEncounter());
    state.actors.left = { ...state.actors.left, turns: 1, statuses: [{id: 'roused', source: 'left', remaining: 2, appliedAction: -1}] };
    state = begin(state);
    expect(state.action?.moveId).toBe('jaw-grab');
    expect(state.actors.left.energy).toBe(2);
    expect(state.actors.left.cooldowns['jaw-grab']).toBe(3);
    const actionId = state.action!.id;
    state = encounterReducer(state, {type: 'play', actionId});
    state = encounterReducer(state, {type: 'impact', actionId});
    expect(state.lastAttack).toMatchObject({ damage: 10, stanceDamage: 55, type: 'grab' });
    expect(encounterReducer(state, {type: 'impact', actionId})).toBe(state);
    expect(canUseMove('left', {...state.actors.left, energy: 10}, 'jaw-grab')).toBe(false);
    expect(canUseMove('left', {...state.actors.left, energy: 7, cooldowns: {}}, 'jaw-grab')).toBe(false);
  });
  it('rest replenishes energy without emitting damage, capped at maximum', () => {
    let state = begin(pass(createEncounter()));
    state = {...state, action: {...state.action!, moveId: 'rest'}, actors: {...state.actors, left: {...state.actors.left, energy: 9}}};
    state = complete(state);
    expect(state.actors.left.energy).toBe(10);
    expect(state.lastAttack).toBeNull();
  });
});
