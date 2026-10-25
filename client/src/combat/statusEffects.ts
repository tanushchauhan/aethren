/** Shared vocabulary for active effects; add definitions here as mechanics are implemented. */
export const STATUS_EFFECTS = {
  bleeding: { label: 'Bleeding', description: 'Lose 2 health at the start of your turn.', icon: 'droplet', color: '#ff899c' },
  roused: { label: 'Roused', description: 'Damage increased by 25%; armor increased by 2.', icon: 'swords', color: '#ffd585' },
  burning: { label: 'Burning', description: 'Takes fire damage at the start of each of its turns, ignoring armor.', icon: 'flame', color: '#ff9a52' },
  chilled: { label: 'Chilled', description: 'Its attacks deal 30% less health and stance damage.', icon: 'thermometer-snowflake', color: '#9fe3ff' },
  frozen: { label: 'Frozen', description: 'Encased in ice: skips its turns.', icon: 'snowflake', color: '#d9f6ff' },
  drained: { label: 'Drained', description: 'Energy emptied: it can only rest on its next turn.', icon: 'zap-off', color: '#c9a8ff' },
  shielded: { label: 'Ice Shield', description: 'Absorbs incoming health damage before it reaches you.', icon: 'shield', color: '#aeeaff' },
  overcharged: { label: 'Overcharged', description: 'Your next damaging spell hits 50% harder; a Storm spell also refunds 1 Magic Power.', icon: 'zap', color: '#d6b8ff' },
} as const;
export type StatusEffectId = keyof typeof STATUS_EFFECTS;
export interface StatusEffect<Id extends StatusEffectId = StatusEffectId> {
  id: Id;
  remaining: number;
  /** Strength for effects that carry one: burn damage per tick, or shield points left. */
  amount?: number;
}
/** Replaces any existing effect with the same id: effects refresh rather than stack. */
export function withStatus<T extends StatusEffect>(statuses: readonly T[], effect: T): T[] {
  return [...statuses.filter(status => status.id !== effect.id), effect];
}
export const hasStatus = (statuses: readonly StatusEffect[], id: StatusEffectId) => statuses.some(status => status.id === id);
/** Smoothly increases from half health to zero; independent of damage animations. */
export function lowHealthIntensity(health: number, maxHealth: number): number {
  if (!Number.isFinite(health) || !Number.isFinite(maxHealth) || maxHealth <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - health / (maxHealth * .5)));
}
