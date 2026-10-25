import { describe, expect, it } from 'vitest';
import { defenseWindow } from '../defenseWindow';
const attack = { attackId: 'a', attackType: 'low_sweep' as const, targetPlayerIds: ['me'], impactServerMs: 1000, windowMs: 2000, narratorHint: 'Step' };
describe('camera defense timing', () => {
  it('samples only during the authoritative defense window', () => {
    expect(defenseWindow(attack, 999, 'me').sampling).toBe(false);
    expect(defenseWindow(attack, 1000, 'me').sampling).toBe(true);
    expect(defenseWindow(attack, 3000, 'me').sampling).toBe(true);
    expect(defenseWindow(attack, 3001, 'me').sampling).toBe(false);
  });
  it('reports within server grace and ignores other targets or stale attacks', () => {
    expect(defenseWindow(attack, 3050, 'me')).toMatchObject({ targeted: true, reportable: true });
    expect(defenseWindow(attack, 3050, 'partner').targeted).toBe(false);
    expect(defenseWindow(attack, 3501, 'me').reportable).toBe(false);
  });
});
