import { beforeEach, describe, expect, it } from 'vitest';
import { useSpellBattle } from './spellBattle';
import { playerStore } from './playerState';
beforeEach(() => { useSpellBattle.getState().reset('wolves'); playerStore.getState().reset(); });
describe('instant kill diagnostics', () => {
  it('wins every roster and clears active statuses', () => {
    for (const encounter of ['wolves', 'knight'] as const) {
      useSpellBattle.getState().reset(encounter);
      useSpellBattle.getState().diagnosticKillAll();
      expect(useSpellBattle.getState().status).toBe('won');
      for (const actor of Object.values(useSpellBattle.getState().opponents)) expect(actor).toMatchObject({hp:0,defeated:true,statuses:[]});
    }
  });
  it('cancels a spell and ignores delayed spell callbacks', () => {
    const battle=useSpellBattle.getState();
    battle.castSpell({spellId:'ember-bolt',targetId:'left'});
    const id=useSpellBattle.getState().pending!.id;
    battle.diagnosticKillAll();battle.resolveCast(id);battle.finishCast(id);
    expect(useSpellBattle.getState()).toMatchObject({status:'won',pending:null,enemyTurn:null});
    expect(playerStore.getState().stance).toBe('balanced');
  });
  it('cancels enemy impact and cannot resurrect a lost encounter', () => {
    const battle=useSpellBattle.getState();battle.endTurn();battle.beginEnemy();
    const id=useSpellBattle.getState().enemyTurn!.action!.id;
    battle.enemyStep('play',id);battle.diagnosticKillAll();battle.enemyStep('impact',id);battle.enemyStep('return',id);
    expect(playerStore.getState().health).toBe(100);
    expect(useSpellBattle.getState().status).toBe('won');
    useSpellBattle.setState({status:'lost'});battle.diagnosticKillAll();
    expect(useSpellBattle.getState().status).toBe('lost');
  });
});
