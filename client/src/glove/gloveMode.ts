import { create } from 'zustand';

/** While combat controls are live they own the glove; menu navigation steps aside. */
export const useGloveMode = create<{ combatControl: boolean; setCombatControl: (on: boolean) => void }>((set) => ({
  combatControl: false,
  setCombatControl: (on) => set({ combatControl: on }),
}));
