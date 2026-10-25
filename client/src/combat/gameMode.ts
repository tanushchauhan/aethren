import { create } from 'zustand';

export type GameMode = 'standard' | 'fast';
const STORAGE_KEY = 'memory.mode';

/** Fast mode multiplies the damage your spells deal, so fights end in a handful of casts. */
export const FAST_DAMAGE_SCALE = 4;

function saved(): GameMode {
  try { return window.localStorage.getItem(STORAGE_KEY) === 'fast' ? 'fast' : 'standard'; } catch { return 'standard'; }
}

export const useGameMode = create<{ mode: GameMode; setMode: (mode: GameMode) => void }>((set) => ({
  mode: saved(),
  setMode(mode) {
    try { window.localStorage.setItem(STORAGE_KEY, mode); } catch { /* the choice just will not persist */ }
    set({ mode });
  },
}));

/** Scales damage the player's spells deal (direct hits and burn ticks); standard mode leaves it unchanged. */
export function scaleDamage(amount: number): number {
  if (amount <= 0 || useGameMode.getState().mode !== 'fast') return amount;
  return Math.round(amount * FAST_DAMAGE_SCALE);
}
