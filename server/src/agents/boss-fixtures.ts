/**
 * Synthetic boss-planner inputs shared by the unit tests and `boss-sim.ts`.
 * Enemies mirror the cached demo world; nothing here is used at runtime.
 */
import type { BossSchema, EncounterSchema } from '@once-upon/shared';
import type { BossPlannerInput, DodgeHistoryEntry } from '../contracts';

export const STEED: EncounterSchema = {
  memory: 'card-roadtrip',
  name: 'The Rusted Iron Steed',
  template: 'charger',
  attacks: ['low_sweep', 'high_swing', 'projectile'],
  weakness: 'frost',
  tier: 1,
  lines: [
    'The Steed lowers its rusted head and paws the road!',
    'Gears grind; it rears to swing high!',
    'It coughs a bolt of hot exhaust your way!',
  ],
  artPrompt: 'A rusted iron horse',
};

export const LIBRARIAN: BossSchema = {
  memory: 'card-finals',
  name: 'The Night Librarian',
  template: 'guardian',
  attacks: ['high_swing', 'projectile', 'low_sweep'],
  weakness: 'ember',
  tier: 3,
  ward: 'twin_cast',
  lines: [
    'Shhh. The library is closing, little ones.',
    'Overdue! Overdue! The shelves sweep low!',
    'Not one word written, and the clock strikes three.',
  ],
  artPrompt: 'A towering storybook librarian',
};

export const MAYA = { id: 'p-maya', name: 'Maya', role: 'spellbearer' as const };
export const DEV = { id: 'p-dev', name: 'Dev', role: 'partner' as const };

export function dodges(
  directions: (DodgeHistoryEntry['direction'] | 'hit' | 'parry')[],
  startRound = 0,
): DodgeHistoryEntry[] {
  return directions.map((d, i) => ({
    roundIndex: startRound + i,
    attackType: d === 'parry' ? 'projectile' : d === 'down' ? 'high_swing' : 'low_sweep',
    dodged: d !== 'hit',
    parried: d === 'parry',
    direction: d === 'hit' || d === 'parry' ? null : d,
  }));
}

export function makeBossInput(overrides: Partial<BossPlannerInput> = {}): BossPlannerInput {
  return {
    roomCode: 'TEST',
    enemy: LIBRARIAN,
    isBoss: true,
    enemyHp: 160,
    enemyMaxHp: 160,
    wardActive: false,
    wardRaisedThisPhase: false,
    hearts: 5,
    maxHearts: 5,
    difficulty: 'normal',
    players: [MAYA, DEV],
    dodgeHistory: {},
    recentElements: [],
    roundIndex: 0,
    ...overrides,
  };
}
