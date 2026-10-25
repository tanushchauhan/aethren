import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export type PlayerStats = {
  health: number; maxHealth: number;
  magicPower: number; maxMagicPower: number;
  stance: number; maxStance: number;
};
export type AttackRequest = {
  id: number; source: 'diagnostic' | 'glove'; requestedAt: number;
  snapshot: PlayerStats; canRetaliate: boolean;
};
export interface PlayerState extends PlayerStats {
  attackRequestCount: number;
  lastAttackRequest: AttackRequest | null;
  setHealth: (value: number) => void;
  setMagicPower: (value: number) => void;
  setStance: (value: number) => void;
  requestAttack: (source?: AttackRequest['source']) => AttackRequest | null;
  reset: () => void;
}
export const INITIAL_PLAYER_STATS: Readonly<PlayerStats> = {
  health: 100, maxHealth: 100, magicPower: 6, maxMagicPower: 12, stance: 100, maxStance: 100,
};
/** Readiness only; timing windows and individual attack requirements are not defined yet. */
export const selectCanRetaliate = (state: PlayerStats) => state.health > 0 && state.stance > 0;
export const selectStanceLabel = (state: PlayerStats) => state.health <= 0 ? 'Incapacitated' : state.stance > 0 ? 'Ready to retaliate' : 'Stance broken';
const statsSnapshot = (state: PlayerStats): PlayerStats => ({ health: state.health, maxHealth: state.maxHealth,
  magicPower: state.magicPower, maxMagicPower: state.maxMagicPower, stance: state.stance, maxStance: state.maxStance });

/** One observable client-side state shared by the HUD, diagnostics, and future glove adapters. */
export const playerStore = createStore<PlayerState>((set, get) => ({
  ...INITIAL_PLAYER_STATS, attackRequestCount: 0, lastAttackRequest: null,
  setHealth(value) { if (Number.isFinite(value)) set({ health: Math.max(0, Math.min(get().maxHealth, value)) }); },
  setMagicPower(value) { if (Number.isFinite(value)) set({ magicPower: Math.max(0, Math.min(get().maxMagicPower, value)) }); },
  setStance(value) { if (Number.isFinite(value)) set({ stance: Math.max(0, Math.min(get().maxStance, value)) }); },
  requestAttack(source = 'diagnostic') {
    const state = get();
    if (state.health <= 0) return null;
    const request: AttackRequest = { id: state.attackRequestCount + 1, source, requestedAt: Date.now(),
      snapshot: statsSnapshot(state), canRetaliate: selectCanRetaliate(state) };
    // An input hook, not an attack implementation: no damage, costs, or turn advancement.
    set({ attackRequestCount: request.id, lastAttackRequest: request });
    return request;
  },
  reset() { set({ ...INITIAL_PLAYER_STATS, attackRequestCount: 0, lastAttackRequest: null }); },
}));
export function usePlayerState<T>(selector: (state: PlayerState) => T): T {
  return useStore(playerStore, selector);
}
