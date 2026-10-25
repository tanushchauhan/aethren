import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_PLAYER_STATS, playerStore, selectCanRetaliate } from './playerState';

beforeEach(() => playerStore.getState().reset());
describe('shared player state', () => {
  it('starts with the chosen resources and ready stance', () => {
    expect(playerStore.getState()).toMatchObject(INITIAL_PLAYER_STATS);
    expect(selectCanRetaliate(playerStore.getState())).toBe(true);
  });
  it('makes stance and health determine retaliation eligibility', () => {
    const { setStance, setHealth } = playerStore.getState();
    setStance('staggered');
    expect(selectCanRetaliate(playerStore.getState())).toBe(false);
    setStance('guarding');
    expect(selectCanRetaliate(playerStore.getState())).toBe(true);
    setStance('casting');
    expect(selectCanRetaliate(playerStore.getState())).toBe(false);
    setHealth(0);
    expect(selectCanRetaliate(playerStore.getState())).toBe(false);
  });
  it('clamps resources and ignores invalid input from adapters', () => {
    const { setHealth, setMagicPower, setStance } = playerStore.getState();
    setHealth(-20); setMagicPower(100); setStance('staggered');
    expect(playerStore.getState()).toMatchObject({ health: 0, magicPower: 12, stance: 'staggered' });
    setHealth(Infinity); setMagicPower(NaN); setStance('balanced');
    expect(playerStore.getState()).toMatchObject({ health: 0, magicPower: 12, stance: 'balanced' });
  });
  it('notifies non-React modules and records attack requests without applying effects', () => {
    const events: number[] = [];
    const unsubscribe = playerStore.subscribe((state, previous) => {
      if (state.lastAttackRequest !== previous.lastAttackRequest && state.lastAttackRequest) events.push(state.lastAttackRequest.id);
    });
    const first = playerStore.getState().requestAttack();
    playerStore.getState().setStance('staggered');
    const second = playerStore.getState().requestAttack('glove');
    expect(first).toMatchObject({ id: 1, source: 'diagnostic', canRetaliate: true });
    expect(second).toMatchObject({ id: 2, source: 'glove', canRetaliate: false });
    expect(first?.snapshot.stance).toBe('balanced');
    expect(events).toEqual([1, 2]);
    expect(playerStore.getState()).toMatchObject({ health: 100, magicPower: 6, stance: 'staggered' });
    unsubscribe();
  });
  it('blocks requests when incapacitated and resets cleanly for a new adventure', () => {
    playerStore.getState().requestAttack();
    playerStore.getState().setHealth(0);
    expect(playerStore.getState().requestAttack()).toBeNull();
    playerStore.getState().reset();
    expect(playerStore.getState()).toMatchObject({ ...INITIAL_PLAYER_STATS, attackRequestCount: 0, lastAttackRequest: null });
  });
});
