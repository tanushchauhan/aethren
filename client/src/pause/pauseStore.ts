import { create } from 'zustand';
import { useCoop } from '../net/coopLink';
import { freezeTime, setSoundOff, thawTime } from './pauseEngine';

interface PauseState {
  /** The settings menu is open. */
  open: boolean;
  /** True only when the game itself is stopped; in a two-screen fight your partner keeps playing. */
  frozen: boolean;
  soundOff: boolean;
  openMenu: () => void;
  closeMenu: () => void;
  toggleMenu: () => void;
  setSoundOff: (off: boolean) => void;
}

export const usePause = create<PauseState>((set, get) => ({
  open: false,
  frozen: false,
  soundOff: false,
  openMenu() {
    if (get().open) return;
    const together = useCoop.getState().status === 'paired';
    if (!together) freezeTime();
    set({ open: true, frozen: !together });
  },
  closeMenu() {
    if (!get().open) return;
    thawTime();
    set({ open: false, frozen: false });
  },
  toggleMenu() {
    if (get().open) get().closeMenu(); else get().openMenu();
  },
  setSoundOff(off) {
    setSoundOff(off);
    set({ soundOff: off });
  },
}));
