import { beforeEach, describe, expect, it } from 'vitest';
import { useSpellBattle } from './spellBattle';
import { playerStore } from './playerState';
import { selectMove, moves } from './encounter';
beforeEach(() => { useSpellBattle.getState().reset('knight'); playerStore.getState().reset(); });
function act() {
  const battle=useSpellBattle.getState();battle.endTurn();battle.beginEnemy();
  const action=useSpellBattle.getState().enemyTurn!.action!;
  for(const type of ['play','impact','impact','return','finish'] as const) battle.enemyStep(type,action.id);
  return action;
}
function primeUltimate() {
  const k=useSpellBattle.getState().opponents.knight;
  useSpellBattle.setState({opponents:{knight:{...k,turns:3,energy:16}}});
}
describe('Scorn Inferno', () => {
  it('reserves energy, respects cooldown and costs the full energy pool', () => {
    const k=useSpellBattle.getState().opponents.knight;
    expect(selectMove('knight',{...k,turns:3,energy:8})).toBe('rest');
    expect(selectMove('knight',{...k,turns:3,energy:16})).toBe('scorn-inferno');
    expect(selectMove('knight',{...k,turns:3,energy:16,cooldowns:{'scorn-inferno':2}})).not.toBe('scorn-inferno');
    primeUltimate();expect(act().moveId).toBe('scorn-inferno');
    expect(useSpellBattle.getState().opponents.knight.energy).toBe(0);
    expect(moves['scorn-inferno'].cost).toBe(16);
    expect(playerStore.getState().health).toBe(83);
  });
  it('persists across exactly five player turns, not seconds or individual enemy actions', () => {
    primeUltimate();act();expect(useSpellBattle.getState().fieldTurns).toBe(5);
    for (const remaining of [4,3,2,1,0]) {
      playerStore.getState().reset();
      const k=useSpellBattle.getState().opponents.knight;
      useSpellBattle.setState({opponents:{knight:{...k,statuses:[{id:'drained',remaining:1,source:'player',appliedAction:-1}]}}});
      act();
      expect(useSpellBattle.getState().fieldTurns).toBe(remaining);
      expect(playerStore.getState().health).toBe(remaining ? 96 : 100);
    }
  });
  it('shield blocks field damage without adding bleeding or losing stance', () => {
    const p=playerStore.getState();p.addStatus({id:'shielded',remaining:2,amount:8});p.receiveFieldDamage(4);
    expect(playerStore.getState()).toMatchObject({health:100,stanceValue:100});
    expect(playerStore.getState().statuses).toEqual([{id:'shielded',remaining:2,amount:4}]);
  });
  it('clears the field on diagnostics victory, reset and defeat', () => {
    primeUltimate();act();useSpellBattle.getState().diagnosticKillAll();expect(useSpellBattle.getState().fieldTurns).toBe(0);
    useSpellBattle.getState().reset();expect(useSpellBattle.getState().fieldTurns).toBe(0);
    primeUltimate();playerStore.getState().setHealth(1);act();
    expect(useSpellBattle.getState()).toMatchObject({status:'lost',fieldTurns:0});
  });
});
