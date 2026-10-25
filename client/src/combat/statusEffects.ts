/** Shared vocabulary for active effects; add definitions here as mechanics are implemented. */
export const STATUS_EFFECTS = {
  bleeding: { label: 'Bleeding', description: 'Lose 2 health at the start of your turn.', icon: 'droplet', color: '#ff899c' },
  roused: { label: 'Roused', description: 'Damage increased by 25%; armor increased by 2.', icon: 'swords', color: '#ffd585' },
} as const;
export type StatusEffectId = keyof typeof STATUS_EFFECTS;
export interface StatusEffect<Id extends StatusEffectId = StatusEffectId> {
  id: Id;
  remaining: number;
}
/** Smoothly increases from half health to zero; independent of damage animations. */
export function lowHealthIntensity(health: number, maxHealth: number): number {
  if (!Number.isFinite(health) || !Number.isFinite(maxHealth) || maxHealth <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - health / (maxHealth * .5)));
}
