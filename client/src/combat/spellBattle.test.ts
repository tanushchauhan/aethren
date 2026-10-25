import { beforeEach, describe, expect, it } from 'vitest';
import { playerStore } from './playerState';
import { useSpellBattle, resolveSpellHit } from './spellBattle';
import { buildSpell } from './spells';
const input = { element: 'fire' as const, form: 'bolt' as const, targetId: 'left' };
beforeEach(() => { useSpellBattle.getState().reset(); playerStore.getState().reset(); });
describe('spell builder and resolution', () => {
  it('builds elemental bolt and burst recipes and rejects unknown forms', () => {
    expect(buildSpell(input)).toMatchObject({ name: 'Ember Bolt', damage: 8, cost: 2 });
    expect(buildSpell({ element: 'storm', form: 'burst' })).toMatchObject({ damage: 16, cost: 4 });
    // @ts-expect-error Simulate malformed external input.
    expect(buildSpell({ element: 'fire', form: 'unknown' })).toBeNull();
  });
  it('spends magic once, locks a cast, damages the target once and restores stance', () => {
    playerStore.getState().setStance('guarding');
    expect(useSpellBattle.getState().castSpell(input, 'diagnostic', 'hit')).toBe(true);
    const id = useSpellBattle.getState().pending!.id;
    expect(playerStore.getState()).toMatchObject({ magicPower: 4, stance: 'casting' });
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
    useSpellBattle.getState().resolveCast(id);
    useSpellBattle.getState().resolveCast(id);
    expect(useSpellBattle.getState().opponents.left.hp).toBe(32);
    useSpellBattle.getState().finishCast(id);
    expect(playerStore.getState().stance).toBe('guarding');
    expect(playerStore.getState().lastAttackRequest?.input).toEqual(input);
  });
  it('dodges without damage but still spends magic; applies armor on hits', () => {
    useSpellBattle.getState().castSpell(input, 'diagnostic', 'dodge');
    useSpellBattle.getState().resolveCast(useSpellBattle.getState().pending!.id);
    expect(useSpellBattle.getState().opponents.left.hp).toBe(40);
    expect(useSpellBattle.getState().feedback?.kind).toBe('dodge');
    expect(playerStore.getState().magicPower).toBe(4);
    const spell = buildSpell(input)!;
    const target = useSpellBattle.getState().opponents.center;
    expect(resolveSpellHit(spell, 'center', target, 'hit', .5).damage).toBe(7);
    expect(resolveSpellHit(spell, 'center', target, 'natural', .05).dodged).toBe(true);
    expect(resolveSpellHit(spell, 'center', target, 'natural', .5).dodged).toBe(false);
  });
  it('rejects missing targets, low magic, incapacitation and staggered stance', () => {
    expect(useSpellBattle.getState().castSpell({ ...input, targetId: 'absent' })).toBe(false);
    playerStore.getState().setMagicPower(0);
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
    playerStore.getState().setMagicPower(12);
    playerStore.getState().setStance('staggered');
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
    playerStore.getState().setStance('balanced');
    playerStore.getState().setHealth(0);
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
  });
  it('preserves external stance changes and ignores stale effects after reset', () => {
    useSpellBattle.getState().castSpell(input);
    const id = useSpellBattle.getState().pending!.id;
    playerStore.getState().setStance('staggered');
    useSpellBattle.getState().resolveCast(id, .5);
    useSpellBattle.getState().finishCast(id);
    expect(playerStore.getState().stance).toBe('staggered');
    useSpellBattle.getState().reset(); playerStore.getState().reset();
    useSpellBattle.getState().castSpell(input);
    useSpellBattle.getState().resolveCast(id, .5);
    expect(useSpellBattle.getState().opponents.left.hp).toBe(40);
  });
  it('defeats opponents and rejects further casts at them', () => {
    for (let i = 0; i < 2; i++) {
      playerStore.getState().setMagicPower(12);
      useSpellBattle.getState().castSpell({ ...input, form: 'burst' }, 'diagnostic', 'hit');
      const id = useSpellBattle.getState().pending!.id;
      useSpellBattle.getState().resolveCast(id); useSpellBattle.getState().finishCast(id);
    }
    expect(useSpellBattle.getState().opponents.left).toMatchObject({ hp: 0, defeated: true });
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
  });
});

describe('diagnostic turn progression and victory', () => {
  it('cycles each surviving opponent back to the player with numbered turns', () => {
    const battle = useSpellBattle.getState();
    battle.endTurn();
    expect(useSpellBattle.getState()).toMatchObject({ activeId: 'left', turnNumber: 2 });
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
    useSpellBattle.getState().endTurn();
    expect(useSpellBattle.getState().turnNumber).toBe(2);
    for (const actor of ['left', 'center', 'right']) {
      expect(useSpellBattle.getState().activeId).toBe(actor);
      useSpellBattle.getState().beginEnemy();
      const id = useSpellBattle.getState().enemyTurn!.action!.id;
      for (const type of ['play', 'impact', 'return', 'finish'] as const) useSpellBattle.getState().enemyStep(type, id);
      const number = useSpellBattle.getState().turnNumber;
      useSpellBattle.getState().enemyStep('finish', id);
      expect(useSpellBattle.getState().turnNumber).toBe(number);
    }
    expect(useSpellBattle.getState()).toMatchObject({ activeId: 'player', turnNumber: 5, enemyTurn: null });
    expect(playerStore.getState().health).toBe(82);
    expect(useSpellBattle.getState().opponents.center.statuses[0].id).toBe('roused');
  });
  it('blocks ending mid-cast, skips defeated enemies, and wins only after the last effect finishes', () => {
    const hit = (targetId: string) => {
      playerStore.getState().setMagicPower(12);
      useSpellBattle.getState().castSpell({ ...input, form: 'burst', targetId }, 'diagnostic', 'hit');
      useSpellBattle.getState().endTurn();
      expect(useSpellBattle.getState().activeId).toBe('player');
      const id = useSpellBattle.getState().pending!.id;
      useSpellBattle.getState().resolveCast(id);
      expect(useSpellBattle.getState().status).toBe('active');
      useSpellBattle.getState().finishCast(id);
    };
    hit('left'); hit('left');
    useSpellBattle.getState().endTurn();
    expect(useSpellBattle.getState().activeId).toBe('center');
    useSpellBattle.getState().reset(); playerStore.getState().reset();
    for (const target of ['left', 'right', 'center']) for (let i = 0; i < (target === 'center' ? 4 : 2); i++) hit(target);
    expect(useSpellBattle.getState().status).toBe('won');
    const number = useSpellBattle.getState().turnNumber;
    useSpellBattle.getState().endTurn();
    expect(useSpellBattle.getState().turnNumber).toBe(number);
    expect(useSpellBattle.getState().castSpell(input)).toBe(false);
  });
});


describe('enemy damage integration', () => {
  it('applies slash once even with duplicate impact and return callbacks', () => {
    const battle = useSpellBattle.getState();
    battle.endTurn(); battle.beginEnemy();
    const id = useSpellBattle.getState().enemyTurn!.action!.id;
    battle.enemyStep('play', id); battle.enemyStep('impact', id);
    battle.enemyStep('impact', id); battle.enemyStep('return', id);
    expect(playerStore.getState()).toMatchObject({ health: 92, stanceValue: 78 });
    expect(playerStore.getState().statuses).toEqual([{ id: 'bleeding', remaining: 2 }]);
  });
  it('resolves failed media and stops combat on lethal damage', () => {
    playerStore.getState().setHealth(3);
    const battle = useSpellBattle.getState();
    battle.endTurn(); battle.beginEnemy();
    const id = useSpellBattle.getState().enemyTurn!.action!.id;
    battle.enemyStep('play', id); battle.enemyStep('return', id);
    expect(playerStore.getState().health).toBe(0);
    expect(useSpellBattle.getState()).toMatchObject({ status: 'lost', enemyTurn: null });
    battle.enemyStep('finish', id); battle.endTurn();
    expect(useSpellBattle.getState().status).toBe('lost');
  });
});


describe('player Rest', () => {
  it('recovers stance and magic once and hands control to opponents', () => {
    playerStore.getState().setStanceValue(10); playerStore.getState().setMagicPower(2);
    useSpellBattle.getState().rest(); useSpellBattle.getState().rest();
    expect(playerStore.getState()).toMatchObject({stanceValue: 55, stance: 'shaken', magicPower: 5, health: 100});
    expect(useSpellBattle.getState()).toMatchObject({activeId: 'left', turnNumber: 2});
  });
  it('caps recovery and cannot rest mid-cast', () => {
    playerStore.getState().setMagicPower(11);
    useSpellBattle.getState().rest();
    expect(playerStore.getState()).toMatchObject({stanceValue:100, magicPower:12});
    useSpellBattle.getState().reset(); playerStore.getState().reset();
    useSpellBattle.getState().castSpell(input);
    const magic = playerStore.getState().magicPower;
    useSpellBattle.getState().rest();
    expect(playerStore.getState().magicPower).toBe(magic);
    expect(useSpellBattle.getState().activeId).toBe('player');
  });
});
