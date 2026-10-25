import { beforeEach, describe, expect, it } from 'vitest';
import { createEncounter, encounterReducer, knight, moves } from './encounter';
import { playerStore } from './playerState';
import { useSpellBattle } from './spellBattle';
beforeEach(() => { useSpellBattle.getState().reset('knight'); playerStore.getState().reset(); });
const cycle = () => {
  const battle = useSpellBattle.getState(); battle.endTurn(); battle.beginEnemy();
  const id = useSpellBattle.getState().enemyTurn!.action!.id;
  for (const type of ['play', 'impact', 'return', 'finish'] as const) battle.enemyStep(type, id);
};
describe('ruined gatekeeper', () => {
  it('keeps boss and wolf actors isolated and retains the current encounter on retry', () => {
    expect(createEncounter().queue).toEqual(['player', 'left', 'center', 'right']);
    expect(createEncounter('knight').queue).toEqual(['player', 'knight']);
    expect(Object.keys(useSpellBattle.getState().opponents)).toEqual(['knight']);
    expect(knight.maxHp).toBe(240);
    useSpellBattle.getState().reset();
    expect(useSpellBattle.getState().encounterId).toBe('knight');
    useSpellBattle.getState().reset('wolves');
    expect(Object.keys(useSpellBattle.getState().opponents)).toEqual(['left', 'center', 'right']);
  });
  it('opens with a slash, then uses a costly aura with stronger effects', () => {
    cycle();
    expect(playerStore.getState()).toMatchObject({health:83, magicPower:8});
    expect(playerStore.getState().statuses).toContainEqual({id:'scorn',remaining:2});
    cycle();
    expect(playerStore.getState()).toMatchObject({health:54, magicPower:8});
    expect(playerStore.getState().statuses).toContainEqual({id:'eclipse',remaining:1});
    expect(useSpellBattle.getState().opponents.knight.energy).toBe(2);
    expect(moves['aura-flash'].cost).toBeGreaterThan(moves['dark-slash'].cost);
  });
  it('shield prevents the curse when it fully absorbs a hit; curses expire and recovery resumes', () => {
    const player=playerStore.getState();
    player.addStatus({id:'shielded',remaining:2,amount:18});
    player.receiveAttack(14,26,'scorn');
    expect(playerStore.getState().health).toBe(100);
    expect(playerStore.getState().statuses.some(s=>s.id==='scorn')).toBe(false);
    player.addStatus({id:'eclipse',remaining:2}); player.setMagicPower(0); player.setStanceValue(0);
    player.startTurn(); player.startTurn();
    expect(playerStore.getState()).toMatchObject({health:92, magicPower:0, stanceValue:30});
    player.startTurn();
    expect(playerStore.getState()).toMatchObject({health:92, magicPower:2, stanceValue:65});
  });
  it('supports spells, caps boss freeze at one turn and resolves boss victory', () => {
    let battle=useSpellBattle.getState();
    playerStore.getState().setMagicPower(12);
    battle.castSpell({spellId:'frost-prison', targetId:'knight'}, 'diagnostic','hit');
    let id=useSpellBattle.getState().pending!.id; battle.resolveCast(id);battle.finishCast(id);
    expect(useSpellBattle.getState().opponents.knight.statuses[0].remaining).toBe(1);
    battle.endTurn();battle.beginEnemy();
    expect(useSpellBattle.getState().activeId).toBe('player');
    const opponent=useSpellBattle.getState().opponents.knight;
    useSpellBattle.setState({opponents:{knight:{...opponent,hp:1}}});
    battle=useSpellBattle.getState();battle.castSpell({spellId:'fire-lance',targetId:'knight'},'diagnostic','hit');
    id=useSpellBattle.getState().pending!.id;battle.resolveCast(id);battle.finishCast(id);
    expect(useSpellBattle.getState().status).toBe('won');
  });
  it('media fallback applies boss attacks only once', () => {
    let state=createEncounter('knight'); state=encounterReducer(state,{type:'pass',turn:0});
    state=encounterReducer(state,{type:'begin',actorId:'knight',turn:state.serial});
    const actionId=state.action!.id;
    state=encounterReducer(state,{type:'play',actionId});state=encounterReducer(state,{type:'return',actionId});
    expect(state.lastAttack).toMatchObject({type:'scorn',damage:14,stanceDamage:26});
    expect(encounterReducer(state,{type:'return',actionId})).toBe(state);
  });
});


it('shows an axe gash only for a damaging direct boss hit, not a curse tick or shield block', () => {
  const player=playerStore.getState();
  player.receiveAttack(14,26,'scorn');
  expect(playerStore.getState().hurt?.impact).toBe('axe');
  player.startTurn();
  expect(playerStore.getState().hurt?.impact).toBeUndefined();
  player.receiveFieldDamage(4);
  expect(playerStore.getState().hurt?.impact).toBeUndefined();
  player.addStatus({id:'shielded',remaining:2,amount:30});
  player.receiveAttack(14,26,'scorn');
  expect(playerStore.getState().hurt).toMatchObject({kind:'blocked'});
  expect(playerStore.getState().hurt?.impact).toBeUndefined();
});
