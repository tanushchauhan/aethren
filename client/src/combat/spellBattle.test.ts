import { beforeEach, describe, expect, it } from 'vitest';
import { playerStore } from './playerState';
import { useSpellBattle, resolveSpellHit } from './spellBattle';
import { getSpell, SPELLS, SPELLS_BY_ELEMENT, type SpellId } from './spells';
const input = { spellId: 'ember-bolt' as const, targetId: 'left' };
const battle = () => useSpellBattle.getState();
/** Casts with the given enemy response and plays the cast to completion. */
function cast(spellId: SpellId, targetId?: string, mode: 'hit' | 'dodge' | 'natural' = 'hit') {
  playerStore.getState().setMagicPower(12);
  const ok = battle().castSpell(targetId ? { spellId, targetId } : { spellId }, 'diagnostic', mode);
  const id = battle().pending?.id;
  if (ok && id !== undefined) { battle().resolveCast(id, .5); battle().finishCast(id); }
  return ok;
}
/** Runs the active opponent's whole turn, or just its start when it skips. */
function opponentTurn() {
  battle().beginEnemy();
  const id = battle().enemyTurn?.action?.id;
  if (id === undefined) return;
  for (const type of ['play', 'impact', 'return', 'finish'] as const) battle().enemyStep(type, id);
}
beforeEach(() => { battle().reset(); playerStore.getState().reset(); });

describe('spell catalogue', () => {
  it('gives each element its own four spells and rejects unknown ids', () => {
    expect(Object.values(SPELLS_BY_ELEMENT).map(ids => ids.length)).toEqual([4, 4, 4]);
    for (const [element, ids] of Object.entries(SPELLS_BY_ELEMENT)) expect(ids.every(id => SPELLS[id].element === element)).toBe(true);
    expect(getSpell('fire-bolt')).toBeNull();
    expect(getSpell(undefined)).toBeNull();
  });
  it('keeps Fire the strongest per Magic Power on a single target', () => {
    const perMp = (id: SpellId) => SPELLS[id].damage / SPELLS[id].cost;
    const fire = Math.max(...['ember-bolt', 'fire-lance'].map(id => perMp(id as SpellId)));
    for (const id of ['frost-shard', 'storm-spark', 'static-shock', 'chain-lightning'] as SpellId[]) expect(perMp(id)).toBeLessThanOrEqual(fire);
  });
});

describe('spell resolution', () => {
  it('spends magic once, locks a cast, damages the target once and restores stance', () => {
    playerStore.getState().setStance('guarding');
    expect(battle().castSpell(input, 'diagnostic', 'hit')).toBe(true);
    const id = battle().pending!.id;
    expect(playerStore.getState()).toMatchObject({ magicPower: 4, stance: 'casting' });
    expect(battle().castSpell(input)).toBe(false);
    battle().resolveCast(id);
    battle().resolveCast(id);
    expect(battle().opponents.left.hp).toBe(26);
    battle().finishCast(id);
    expect(playerStore.getState().stance).toBe('guarding');
    expect(playerStore.getState().lastAttackRequest?.input).toEqual(input);
  });
  it('dodges without damage but still spends magic; applies armor on hits', () => {
    battle().castSpell(input, 'diagnostic', 'dodge');
    battle().resolveCast(battle().pending!.id);
    expect(battle().opponents.left.hp).toBe(40);
    expect(battle().feedback[0].kind).toBe('dodge');
    expect(playerStore.getState().magicPower).toBe(4);
    const target = battle().opponents.center;
    expect(resolveSpellHit(SPELLS['ember-bolt'], 'center', target, 'hit', .5).damage).toBe(13);
    expect(resolveSpellHit(SPELLS['ember-bolt'], 'center', target, 'natural', .05).dodged).toBe(true);
    expect(resolveSpellHit(SPELLS['ember-bolt'], 'center', target, 'natural', .5).dodged).toBe(false);
  });
  it('rejects missing targets, low magic, incapacitation and staggered stance', () => {
    expect(battle().castSpell({ ...input, targetId: 'absent' })).toBe(false);
    playerStore.getState().setMagicPower(0);
    expect(battle().castSpell(input)).toBe(false);
    playerStore.getState().setMagicPower(12);
    playerStore.getState().setStance('staggered');
    expect(battle().castSpell(input)).toBe(false);
    playerStore.getState().setStance('balanced');
    playerStore.getState().setHealth(0);
    expect(battle().castSpell(input)).toBe(false);
  });
  it('preserves external stance changes and ignores stale effects after reset', () => {
    battle().castSpell(input);
    const id = battle().pending!.id;
    playerStore.getState().setStance('staggered');
    battle().resolveCast(id, .5);
    battle().finishCast(id);
    expect(playerStore.getState().stance).toBe('staggered');
    battle().reset(); playerStore.getState().reset();
    battle().castSpell(input);
    battle().resolveCast(id, .5);
    expect(battle().opponents.left.hp).toBe(40);
  });
  it('defeats opponents and rejects further casts at them', () => {
    for (let i = 0; i < 3; i++) cast('fire-lance', 'left');
    expect(battle().opponents.left).toMatchObject({ hp: 0, defeated: true });
    expect(battle().castSpell(input)).toBe(false);
  });
});

describe('fire: damage', () => {
  it('Fire Lance ignores armor', () => {
    cast('fire-lance', 'center');
    expect(battle().opponents.center.hp).toBe(28);
  });
  it('Immolate burns at the start of each of the next three turns, ignoring armor', () => {
    cast('immolate', 'center');
    expect(battle().opponents.center.hp).toBe(53);
    expect(battle().opponents.center.statuses).toContainEqual(expect.objectContaining({ id: 'burning', remaining: 3, amount: 6 }));
    for (let round = 0; round < 4; round++) {
      battle().endTurn();
      while (battle().activeId !== 'player') opponentTurn();
    }
    expect(battle().opponents.center.hp).toBe(53 - 18);
    expect(battle().opponents.center.statuses.some(status => status.id === 'burning')).toBe(false);
  });
  it('shows a burn tick and can win the encounter during the opponents’ turn', () => {
    cast('immolate', 'left');
    battle().endTurn();
    battle().beginEnemy();
    expect(battle().feedback[0]).toMatchObject({ targetId: 'left', damage: 6, label: 'Burning', castId: null });
    battle().reset(); playerStore.getState().reset();
    for (const id of ['center', 'right'] as const) for (let i = 0; i < 2; i++) cast('fire-lance', id);
    cast('ember-bolt', 'left'); cast('ember-bolt', 'left');
    cast('immolate', 'left');
    expect(battle().opponents.left.hp).toBe(4);
    battle().endTurn();
    battle().beginEnemy();
    expect(battle()).toMatchObject({ status: 'won', enemyTurn: null });
  });
  it('Meteor hits the target and splashes every other wolf, and cannot be dodged', () => {
    cast('meteor', 'center', 'dodge');
    expect([battle().opponents.left.hp, battle().opponents.center.hp, battle().opponents.right.hp]).toEqual([24, 27, 24]);
  });
});

describe('frost: defense and control', () => {
  it('Frost Shard chills: the next attack loses 30% of its health and stance damage, then the chill ends', () => {
    cast('frost-shard', 'left');
    battle().endTurn();
    opponentTurn();
    expect(playerStore.getState()).toMatchObject({ health: 95, stanceValue: 85 });
    expect(battle().opponents.left.statuses.some(status => status.id === 'chilled')).toBe(false);
  });
  it('Ice Shield absorbs hits before health, and a fully blocked hit opens no wound', () => {
    cast('ice-shield');
    expect(playerStore.getState().statuses).toContainEqual({ id: 'shielded', remaining: 2, amount: 18 });
    playerStore.getState().receiveAttack(8, 22);
    expect(playerStore.getState()).toMatchObject({ health: 100, stanceValue: 89, hurt: expect.objectContaining({ kind: 'blocked', absorbed: 8 }) });
    expect(playerStore.getState().statuses).toEqual([{ id: 'shielded', remaining: 2, amount: 10 }]);
    playerStore.getState().receiveAttack(15, 0);
    expect(playerStore.getState().health).toBe(95);
    expect(playerStore.getState().statuses).toEqual([{ id: 'bleeding', remaining: 2 }]);
  });
  it('Frost Prison makes the wolf skip its next two turns', () => {
    cast('frost-prison', 'left');
    expect(battle().opponents.left.hp).toBe(40);
    for (let round = 0; round < 2; round++) {
      battle().endTurn();
      battle().beginEnemy();
      expect(battle().activeId).toBe('center');
      expect(battle().feedback[0]).toMatchObject({ targetId: 'left', kind: 'effect', label: 'Frozen' });
      while (battle().activeId !== 'player') opponentTurn();
    }
    battle().endTurn();
    battle().beginEnemy();
    expect(battle().enemyTurn?.action?.actorId).toBe('left');
  });
  it('Frost Nova damages and chills every wolf, and cannot be dodged', () => {
    cast('frost-nova', 'left', 'dodge');
    expect([battle().opponents.left.hp, battle().opponents.center.hp, battle().opponents.right.hp]).toEqual([28, 49, 28]);
    expect(Object.values(battle().opponents).every(wolf => wolf.statuses.some(status => status.id === 'chilled'))).toBe(true);
  });
});

describe('storm: tempo and disruption', () => {
  it('Chain Lightning jumps to the nearest wolf, then the last', () => {
    cast('chain-lightning', 'left');
    expect(battle().feedback.map(hit => hit.targetId)).toEqual(['left', 'center', 'right']);
    expect([battle().opponents.left.hp, battle().opponents.center.hp, battle().opponents.right.hp]).toEqual([24, 51, 34]);
  });
  it('Static Shock empties energy so the wolf can only rest', () => {
    cast('static-shock', 'left');
    expect(battle().opponents.left).toMatchObject({ hp: 32, energy: 0 });
    battle().endTurn();
    battle().beginEnemy();
    expect(battle().enemyTurn?.action?.moveId).toBe('rest');
  });
  it('Overcharge boosts the next damaging spell once and refunds 1 MP on a Storm spell', () => {
    cast('overcharge');
    expect(playerStore.getState().statuses.some(status => status.id === 'overcharged')).toBe(true);
    cast('ice-shield');
    expect(playerStore.getState().statuses.some(status => status.id === 'overcharged')).toBe(true);
    cast('ember-bolt', 'left');
    expect(battle().opponents.left.hp).toBe(19);
    expect(playerStore.getState().statuses.some(status => status.id === 'overcharged')).toBe(false);
    cast('overcharge');
    playerStore.getState().setMagicPower(5);
    battle().castSpell({ spellId: 'storm-spark', targetId: 'right' }, 'diagnostic', 'hit');
    expect(playerStore.getState().magicPower).toBe(5);
    battle().resolveCast(battle().pending!.id);
    expect(battle().opponents.right.hp).toBe(30);
  });
});

describe('diagnostic turn progression and victory', () => {
  it('cycles each surviving opponent back to the player with numbered turns', () => {
    battle().endTurn();
    expect(battle()).toMatchObject({ activeId: 'left', turnNumber: 2 });
    expect(battle().castSpell(input)).toBe(false);
    battle().endTurn();
    expect(battle().turnNumber).toBe(2);
    for (const actor of ['left', 'center', 'right']) {
      expect(battle().activeId).toBe(actor);
      battle().beginEnemy();
      const id = battle().enemyTurn!.action!.id;
      for (const type of ['play', 'impact', 'return', 'finish'] as const) battle().enemyStep(type, id);
      const number = battle().turnNumber;
      battle().enemyStep('finish', id);
      expect(battle().turnNumber).toBe(number);
    }
    expect(battle()).toMatchObject({ activeId: 'player', turnNumber: 5, enemyTurn: null });
    expect(playerStore.getState()).toMatchObject({ health: 82, magicPower: 8 });
    expect(battle().opponents.center.statuses[0].id).toBe('roused');
  });
  it('blocks ending mid-cast, skips defeated enemies, and wins only after the last effect finishes', () => {
    const hit = (targetId: string) => {
      playerStore.getState().setMagicPower(12);
      battle().castSpell({ spellId: 'fire-lance', targetId }, 'diagnostic', 'hit');
      battle().endTurn();
      expect(battle().activeId).toBe('player');
      const id = battle().pending!.id;
      battle().resolveCast(id);
      expect(battle().status).toBe('active');
      battle().finishCast(id);
    };
    for (let i = 0; i < 2; i++) hit('left');
    battle().endTurn();
    expect(battle().activeId).toBe('center');
    battle().reset(); playerStore.getState().reset();
    for (const target of ['left', 'right', 'center']) for (let i = 0; i < 2; i++) hit(target);
    expect(battle().status).toBe('won');
    const number = battle().turnNumber;
    battle().endTurn();
    expect(battle().turnNumber).toBe(number);
    expect(battle().castSpell(input)).toBe(false);
  });
});

describe('enemy damage integration', () => {
  it('applies slash once even with duplicate impact and return callbacks', () => {
    battle().endTurn(); battle().beginEnemy();
    const id = battle().enemyTurn!.action!.id;
    battle().enemyStep('play', id); battle().enemyStep('impact', id);
    battle().enemyStep('impact', id); battle().enemyStep('return', id);
    expect(playerStore.getState()).toMatchObject({ health: 92, stanceValue: 78 });
    expect(playerStore.getState().statuses).toEqual([{ id: 'bleeding', remaining: 2 }]);
  });
  it('resolves failed media and stops combat on lethal damage', () => {
    playerStore.getState().setHealth(3);
    battle().endTurn(); battle().beginEnemy();
    const id = battle().enemyTurn!.action!.id;
    battle().enemyStep('play', id); battle().enemyStep('return', id);
    expect(playerStore.getState().health).toBe(0);
    expect(battle()).toMatchObject({ status: 'lost', enemyTurn: null });
    battle().enemyStep('finish', id); battle().endTurn();
    expect(battle().status).toBe('lost');
  });
});

describe('player Rest', () => {
  it('recovers stance and magic once and hands control to opponents', () => {
    playerStore.getState().setStanceValue(10); playerStore.getState().setMagicPower(2);
    battle().rest(); battle().rest();
    expect(playerStore.getState()).toMatchObject({ stanceValue: 55, stance: 'shaken', magicPower: 5, health: 100 });
    expect(battle()).toMatchObject({ activeId: 'left', turnNumber: 2 });
  });
  it('caps recovery and cannot rest mid-cast', () => {
    playerStore.getState().setMagicPower(11);
    battle().rest();
    expect(playerStore.getState()).toMatchObject({ stanceValue: 100, magicPower: 12 });
    battle().reset(); playerStore.getState().reset();
    battle().castSpell(input);
    const magic = playerStore.getState().magicPower;
    battle().rest();
    expect(playerStore.getState().magicPower).toBe(magic);
    expect(battle().activeId).toBe('player');
  });
});
