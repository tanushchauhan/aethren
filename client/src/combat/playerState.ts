import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { StatusEffect } from './statusEffects';
import type { SpellInput } from './spells';

export const STANCES = ['balanced', 'casting', 'guarding', 'shaken', 'staggered'] as const;
export type PlayerStance = typeof STANCES[number];

export type PlayerStats = {
  health: number; maxHealth: number;
  magicPower: number; maxMagicPower: number;
  stance: PlayerStance;
  stanceValue: number;
};
export type AttackRequest = {
  id: number; source: 'diagnostic' | 'glove'; requestedAt: number;
  snapshot: PlayerStats; canRetaliate: boolean; input?: SpellInput;
};
export interface PlayerState extends PlayerStats {
  statuses: StatusEffect<'bleeding'>[];
  hurt: { id: number; damage: number; kind: 'slash' | 'bleed' } | null;
  receiveAttack: (damage: number, stanceDamage: number) => void;
  startTurn: () => void;
  setStanceValue: (value: number) => void;
  attackRequestCount: number;
  lastAttackRequest: AttackRequest | null;
  setHealth: (value: number) => void;
  setMagicPower: (value: number) => void;
  setStance: (value: PlayerStance) => void;
  requestAttack: (source?: AttackRequest['source'], input?: SpellInput) => AttackRequest | null;
  reset: () => void;
}
export const INITIAL_PLAYER_STATS: Readonly<PlayerStats> = {
  health: 100, maxHealth: 100, magicPower: 6, maxMagicPower: 12, stance: 'balanced', stanceValue: 100,
};
/** Readiness only; timing windows and individual attack requirements are not defined yet. */
export const selectCanRetaliate = (state: PlayerStats) => state.health > 0 && (state.stance === 'balanced' || state.stance === 'guarding' || state.stance === 'shaken');
export const STANCE_LABELS: Record<PlayerStance, string> = { balanced: 'Balanced', casting: 'Casting', shaken: 'Shaken', guarding: 'Guarding', staggered: 'Staggered' };
export const selectStanceLabel = (state: PlayerStats) => state.health <= 0 ? 'Incapacitated' : STANCE_LABELS[state.stance];
const statsSnapshot = (state: PlayerStats): PlayerStats => ({ health: state.health, maxHealth: state.maxHealth,
  magicPower: state.magicPower, maxMagicPower: state.maxMagicPower, stance: state.stance, stanceValue: state.stanceValue });

export const stanceFromValue = (value: number): PlayerStance => value >= 60 ? 'balanced' : value >= 30 ? 'shaken' : 'staggered';
let hurtId = 0;

/** One observable client-side state shared by the HUD, diagnostics, and future glove adapters. */
export const playerStore = createStore<PlayerState>((set, get) => ({
  ...INITIAL_PLAYER_STATS, statuses: [], hurt: null, attackRequestCount: 0, lastAttackRequest: null,
  setHealth(value) { if (Number.isFinite(value)) set({ health: Math.max(0, Math.min(get().maxHealth, value)) }); },
  setMagicPower(value) { if (Number.isFinite(value)) set({ magicPower: Math.max(0, Math.min(get().maxMagicPower, value)) }); },
  setStanceValue(value) {
    if (!Number.isFinite(value)) return;
    const stanceValue = Math.max(0, Math.min(100, value));
    set({ stanceValue, stance: stanceFromValue(stanceValue) });
  },
  setStance(value) {
    if (!STANCES.includes(value)) return;
    if (value === 'casting' || value === 'guarding') { set({ stance: value }); return; }
    get().setStanceValue(value === 'balanced' ? 100 : value === 'shaken' ? 45 : 0);
  },
  receiveAttack(damage, stanceDamage) {
    if (!Number.isFinite(damage) || !Number.isFinite(stanceDamage) || damage <= 0 || get().health <= 0) return;
    const state = get(), guarding = state.stance === 'guarding';
    const amount = Math.min(state.health, Math.max(1, Math.floor(damage * (guarding ? .5 : 1))));
    const stanceValue = Math.max(0, state.stanceValue - Math.max(0, stanceDamage) * (guarding ? .5 : 1));
    set({ health: state.health - amount, stanceValue, stance: stanceFromValue(stanceValue),
      statuses: [{ id: 'bleeding', remaining: 2 }], hurt: { id: ++hurtId, damage: amount, kind: 'slash' } });
  },
  startTurn() {
    const state = get();
    if (state.health <= 0) return;
    const damage = state.statuses.some(status => status.id === 'bleeding') ? Math.min(2, state.health) : 0;
    const stanceValue = Math.min(100, state.stanceValue + 35);
    set({ health: state.health - damage, stanceValue, stance: stanceFromValue(stanceValue),
      statuses: state.statuses.map(status => ({ ...status, remaining: status.remaining - 1 })).filter(status => status.remaining > 0),
      ...(damage ? { hurt: { id: ++hurtId, damage, kind: 'bleed' as const } } : {}) });
  },
  requestAttack(source = 'diagnostic', input) {
    const state = get();
    if (state.health <= 0) return null;
    const request: AttackRequest = { id: state.attackRequestCount + 1, source, requestedAt: Date.now(),
      snapshot: statsSnapshot(state), canRetaliate: selectCanRetaliate(state), input: input ? { ...input } : undefined };
    // An input hook, not an attack implementation: no damage, costs, or turn advancement.
    set({ attackRequestCount: request.id, lastAttackRequest: request });
    return request;
  },
  reset() { set({ ...INITIAL_PLAYER_STATS, statuses: [], hurt: null, attackRequestCount: 0, lastAttackRequest: null }); },
}));
export function usePlayerState<T>(selector: (state: PlayerState) => T): T {
  return useStore(playerStore, selector);
}
