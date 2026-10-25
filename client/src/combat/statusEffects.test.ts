import { describe, expect, it } from 'vitest';
import { lowHealthIntensity, STATUS_EFFECTS } from './statusEffects';
describe('status presentation', () => {
  it('scales low-health feedback from half health and clamps bounds', () => {
    expect([100, 50, 25, 10, 0, -1].map(hp => lowHealthIntensity(hp, 100))).toEqual([0, 0, .5, .8, 1, 1]);
    expect(lowHealthIntensity(50, 200)).toBe(.5);
    expect(lowHealthIntensity(NaN, 100)).toBe(0);
    expect(lowHealthIntensity(1, 0)).toBe(0);
  });
  it('gives implemented effects distinct, recognizable icons', () => {
    expect(STATUS_EFFECTS.bleeding.icon).toBe('droplet');
    expect(STATUS_EFFECTS.roused.icon).toBe('swords');
  });
});
