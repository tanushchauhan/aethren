import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allyStore, localHeroStore, playerStore, resetHeroes } from './playerState';
import { COOP_KNIGHT_HP, setBattleRemote, useSpellBattle, type BattleIntent } from './spellBattle';
import { applySnapshot, buildSnapshot } from '../net/coopLink';
import type { SpellId } from './spells';
const battle = () => useSpellBattle.getState();
/** Casts for whichever hero is up and plays the spell out; glove casts end the turn by themselves. */
function cast(spellId: SpellId, targetId = 'knight') {
  (battle().activeId === 'ally' ? allyStore : playerStore).getState().setMagicPower(12);
  expect(battle().castSpell({ spellId, targetId }, 'diagnostic', 'hit')).toBe(true);
  const id = battle().pending!.id;
  battle().resolveCast(id, .5); battle().finishCast(id);
}
/** The knight's whole turn, from his first step to handing back to the heroes. */
function knightTurn() {
  battle().beginEnemy();
  const id = battle().enemyTurn?.action?.id;
  if (id !== undefined) for (const type of ['play', 'impact', 'return', 'finish'] as const) battle().enemyStep(type, id);
}
beforeEach(() => { setBattleRemote(null); localHeroStore.setState({ hero: 'player' }); resetHeroes(); battle().reset('knight', true); useSpellBattle.setState({ heroNames: { player: 'Ada', ally: 'Bo' } }); });
afterEach(() => { setBattleRemote(null); localHeroStore.setState({ hero: 'player' }); });

describe('co-op boss fight', () => {
  it('scales the knight for two and leaves solo fights alone', () => {
    expect(battle().opponents.knight).toMatchObject({ hp: COOP_KNIGHT_HP, maxHp: COOP_KNIGHT_HP });
    battle().reset('knight', false);
    expect(battle().opponents.knight.hp).toBe(240);
    battle().reset('wolves');
    expect(battle().coop).toBe(false);
  });
  it('takes turns: host, then partner, then the knight, then back to the host', () => {
    allyStore.getState().setMagicPower(4);
    battle().endTurn();
    expect(battle()).toMatchObject({ activeId: 'ally', enemyTurn: null, message: 'Bo’s turn.' });
    expect(allyStore.getState().magicPower).toBe(6);
    battle().endTurn();
    expect(battle().activeId).toBe('knight');
    knightTurn();
    expect(battle().activeId).toBe('player');
    expect(battle().turnNumber).toBe(4);
  });
  it('sends the knight’s swing at whoever hurt him most, and his Eclipse at both', () => {
    battle().endTurn();
    cast('fire-lance');
    expect(battle().threat.ally).toBe(18);
    battle().endTurn(); battle().beginEnemy();
    const id = battle().enemyTurn!.action!.id;
    battle().enemyStep('play', id); battle().enemyStep('impact', id);
    expect(battle().message).toContain('on Bo');
    battle().enemyStep('return', id); battle().enemyStep('finish', id);
    expect(allyStore.getState().health).toBe(86);
    expect(playerStore.getState().health).toBe(100);
    expect(battle().threat).toEqual({ player: 0, ally: 0 });
    battle().endTurn(); battle().endTurn(); knightTurn();
    expect(playerStore.getState().health).toBeLessThan(100);
    expect(allyStore.getState().health).toBeLessThan(86);
  });
  it('skips a fallen hero and only loses when both are down', () => {
    playerStore.getState().setHealth(0);
    battle().endTurn(); battle().endTurn();
    knightTurn();
    expect(battle()).toMatchObject({ status: 'active', activeId: 'ally' });
    allyStore.getState().setHealth(1);
    battle().endTurn(); knightTurn();
    expect(battle().status).toBe('lost');
  });
  it('skips an ally whose screen went away, and the knight ignores them', () => {
    battle().endTurn();
    battle().setAllyAway(true);
    expect(battle().activeId).toBe('knight');
    knightTurn();
    expect(allyStore.getState().health).toBe(100);
    // 14 from the swing, then 3 from his Scorn curse as the host's next turn starts.
    expect(playerStore.getState().health).toBe(83);
    battle().endTurn();
    expect(battle().activeId).toBe('knight');
  });
  it('a guest screen sends its moves to the host instead of playing them', () => {
    const sent: BattleIntent[] = [];
    useSpellBattle.setState({ activeId: 'ally' });
    localHeroStore.setState({ hero: 'ally' });
    setBattleRemote(intent => sent.push(intent));
    allyStore.getState().setMagicPower(12);
    expect(battle().castSpell({ spellId: 'ember-bolt', targetId: 'knight' }, 'glove')).toBe(true);
    expect(battle().pending).toBeNull();
    expect(allyStore.getState().magicPower).toBe(12);
    battle().rest(); battle().beginEnemy();
    expect(sent.map(intent => intent.type)).toEqual(['cast', 'rest']);
    useSpellBattle.setState({ activeId: 'player' });
    expect(battle().castSpell({ spellId: 'ember-bolt', targetId: 'knight' })).toBe(false);
  });
  it('rebuilds the host’s fight from a snapshot, mid-cast', () => {
    battle().endTurn();
    allyStore.getState().setMagicPower(12);
    battle().castSpell({ spellId: 'frost-shard', targetId: 'knight' }, 'diagnostic', 'hit');
    battle().resolveCast(battle().pending!.id, .5);
    const snapshot = JSON.parse(JSON.stringify(buildSnapshot()));
    const before = { battle: battle().opponents, ally: allyStore.getState().magicPower, pending: battle().pending };
    battle().reset('knight', true); resetHeroes();
    applySnapshot({ kind: 'state', seq: 1, ...snapshot });
    expect(battle().opponents).toEqual(before.battle);
    expect(battle().pending).toEqual(before.pending);
    expect(battle()).toMatchObject({ activeId: 'ally', heroNames: { player: 'Ada', ally: 'Bo' } });
    expect(allyStore.getState().magicPower).toBe(before.ally);
  });
});
