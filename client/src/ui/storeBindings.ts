import type { HardwareEvent } from '../net/contract';
import type { GameStore } from '../net/store';
import { isColorToken, type ColorToken } from './colors';
import { useGameStore } from './_store-shim';

export interface HardwareSlice {
  dialSlot: 0 | 1 | 2;
  colorToken: ColorToken | null;
  armed: boolean;
  buttonPressed: boolean;
}

const QUIET_HARDWARE: HardwareSlice = {
  dialSlot: 0,
  colorToken: null,
  armed: false,
  buttonPressed: false,
};

export function useUiStore<T>(selector: (state: GameStore) => T): T {
  return useGameStore(selector);
}

export function getUiStore(): GameStore {
  return useGameStore.getState();
}

export function normalizeHardware(hardware: HardwareEvent | null | undefined): HardwareSlice {
  if (!hardware) return QUIET_HARDWARE;
  const dialSlot = hardware.dialSlot === 1 || hardware.dialSlot === 2 ? hardware.dialSlot : 0;
  return {
    dialSlot,
    colorToken: isColorToken(hardware.colorToken) ? hardware.colorToken : null,
    armed: hardware.armed,
    buttonPressed: hardware.buttonPressed,
  };
}
