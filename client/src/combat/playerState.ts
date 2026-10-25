import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { SpellInput } from './spells';

export const STANCES = ['balanced', 'casting', 'guarding', 'staggered'] as const;
export type PlayerStance = typeof STANCES[number];

export type PlayerStats = {
  health: number; maxHealth: number;
  magicPower: number; maxMagicPower: number;
  stance: PlayerStance;
};
export type AttackRequest = {
  id: number; source: 'diagnostic' | 'glove'; requestedAt: number;
  snapshot: PlayerStats; canRetaliate: boolean; input?: SpellInput;
};
export interface PlayerState extends PlayerStats {
  attackRequestCount: number;
  lastAttackRequest: AttackRequest | null;
  setHealth: (value: number) => void;
  setMagicPower: (value: number) => void;
  setStance: (value: PlayerStance) => void;
  requestAttack: (source?: AttackRequest['source'], input?: SpellInput) => AttackRequest | null;
  reset: () => void;
}
export const INITIAL_PLAYER_STATS: Readonly<PlayerStats> = {
  health: 100, maxHealth: 100, magicPower: 6, maxMagicPower: 12, stance: 'balanced',
};
/** Readiness only; timing windows and individual attack requirements are not defined yet. */
export const selectCanRetaliate = (state: PlayerStats) => state.health > 0 && (state.stance === 'balanced' || state.stance === 'guarding');
export const STANCE_LABELS: Record<PlayerStance, string> = { balanced: 'Balanced', casting: 'Casting', guarding: 'Guarding', staggered: 'Staggered' };
export const selectStanceLabel = (state: PlayerStats) => state.health <= 0 ? 'Incapacitated' : STANCE_LABELS[state.stance];
const statsSnapshot = (state: PlayerStats): PlayerStats => ({ health: state.health, maxHealth: state.maxHealth,
  magicPower: state.magicPower, maxMagicPower: state.maxMagicPower, stance: state.stance });

/** One observable client-side state shared by the HUD, diagnostics, and future glove adapters. */
export const playerStore = createStore<PlayerState>((set, get) => ({
  ...INITIAL_PLAYER_STATS, attackRequestCount: 0, lastAttackRequest: null,
  setHealth(value) { if (Number.isFinite(value)) set({ health: Math.max(0, Math.min(get().maxHealth, value)) }); },
  setMagicPower(value) { if (Number.isFinite(value)) set({ magicPower: Math.max(0, Math.min(get().maxMagicPower, value)) }); },
  setStance(value) { if (STANCES.includes(value)) set({ stance: value }); },
  requestAttack(source = 'diagnostic', input) {
    const state = get();
    if (state.health <= 0) return null;
    const request: AttackRequest = { id: state.attackRequestCount + 1, source, requestedAt: Date.now(),
      snapshot: statsSnapshot(state), canRetaliate: selectCanRetaliate(state), input: input ? { ...input } : undefined };
    // An input hook, not an attack implementation: no damage, costs, or turn advancement.
    set({ attackRequestCount: request.id, lastAttackRequest: request });
    return request;
  },
  reset() { set({ ...INITIAL_PLAYER_STATS, attackRequestCount: 0, lastAttackRequest: null }); },
}));
export function usePlayerState<T>(selector: (state: PlayerState) => T): T {
  return useStore(playerStore, selector);
}
