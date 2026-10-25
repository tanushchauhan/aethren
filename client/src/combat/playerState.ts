import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { withStatus, type StatusEffect } from './statusEffects';
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
  statuses: PlayerStatus[];
  /** `absorbed` is what an Ice Shield soaked up; a fully absorbed hit is `blocked`. */
  hurt: { id: number; damage: number; absorbed?: number; impact?: 'axe'; kind: 'slash' | 'bleed' | 'blocked' | 'curse' } | null;
  addStatus: (effect: PlayerStatus) => void;
  removeStatus: (id: PlayerStatus['id']) => void;
  receiveAttack: (damage: number, stanceDamage: number, curse?: 'scorn' | 'eclipse') => void;
  startTurn: () => void;
  receiveFieldDamage: (damage: number) => void;
  setStanceValue: (value: number) => void;
  attackRequestCount: number;
  lastAttackRequest: AttackRequest | null;
  setHealth: (value: number) => void;
  setMagicPower: (value: number) => void;
  setStance: (value: PlayerStance) => void;
  requestAttack: (source?: AttackRequest['source'], input?: SpellInput) => AttackRequest | null;
  reset: () => void;
}
export type PlayerStatus = StatusEffect<'bleeding' | 'shielded' | 'overcharged' | 'scorn' | 'eclipse'>;
/** Magic Power regained at the start of each of your turns. */
export const MAGIC_REGEN = 2;
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
  addStatus(effect) { set({ statuses: withStatus(get().statuses, effect) }); },
  removeStatus(id) { set({ statuses: get().statuses.filter(status => status.id !== id) }); },
  receiveAttack(damage, stanceDamage, curse) {
    if (!Number.isFinite(damage) || !Number.isFinite(stanceDamage) || damage <= 0 || get().health <= 0) return;
    const state = get(), guarding = state.stance === 'guarding';
    const incoming = Math.max(1, Math.floor(damage * (guarding ? .5 : 1)));
    // Guarding halves first, then an Ice Shield soaks up what it can.
    const shield = state.statuses.find(status => status.id === 'shielded');
    const absorbed = Math.min(incoming, shield?.amount ?? 0), left = (shield?.amount ?? 0) - absorbed;
    const statuses = shield ? left > 0 ? withStatus(state.statuses, { ...shield, amount: left }) : state.statuses.filter(status => status !== shield) : state.statuses;
    const amount = Math.min(state.health, incoming - absorbed);
    // A fully blocked hit still jars your stance a little but does not open a wound.
    const stanceLoss = Math.max(0, stanceDamage) * (guarding ? .5 : 1) * (amount ? 1 : .5);
    const stanceValue = Math.max(0, state.stanceValue - stanceLoss);
    set({ health: state.health - amount, stanceValue, stance: stanceFromValue(stanceValue),
      statuses: amount ? withStatus(statuses, { id: curse ?? 'bleeding', remaining: curse === 'scorn' ? 3 : 2 }) : statuses,
      hurt: { id: ++hurtId, damage: amount, absorbed, ...(amount && curse ? { impact: 'axe' as const } : {}), kind: amount ? curse ? 'curse' : 'slash' : 'blocked' } });
  },
  receiveFieldDamage(damage) {
    if (!Number.isFinite(damage) || damage <= 0 || get().health <= 0) return;
    const state = get(), shield = state.statuses.find(status => status.id === 'shielded');
    const absorbed = Math.min(damage, shield?.amount ?? 0), left = (shield?.amount ?? 0) - absorbed;
    const amount = Math.min(state.health, damage - absorbed);
    const statuses = shield ? left > 0 ? withStatus(state.statuses, { ...shield, amount: left }) : state.statuses.filter(status => status !== shield) : state.statuses;
    set({ health: state.health - amount, statuses, hurt: { id: ++hurtId, damage: amount, absorbed, kind: amount ? 'curse' : 'blocked' } });
  },
  startTurn() {
    const state = get();
    if (state.health <= 0) return;
    const tick = state.statuses.reduce((sum, effect) => sum + (effect.id === 'bleeding' ? 2 : effect.id === 'scorn' ? 3 : effect.id === 'eclipse' ? 4 : 0), 0);
    const eclipsed = state.statuses.some(effect => effect.id === 'eclipse');
    const damage = Math.min(tick, state.health);
    const stanceValue = Math.min(100, state.stanceValue + (eclipsed ? 15 : 35));
    set({ health: state.health - damage, stanceValue, stance: stanceFromValue(stanceValue),
      magicPower: Math.min(state.maxMagicPower, state.magicPower + (eclipsed ? 0 : MAGIC_REGEN)),
      statuses: state.statuses.map(status => ({ ...status, remaining: status.remaining - 1 })).filter(status => status.remaining > 0),
      ...(damage ? { hurt: { id: ++hurtId, damage, kind: (state.statuses.some(effect => effect.id === 'scorn' || effect.id === 'eclipse') ? 'curse' : 'bleed') as 'curse' | 'bleed' } } : {}) });
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
