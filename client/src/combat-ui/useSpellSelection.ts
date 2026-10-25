import { useEffect, useRef, useState } from 'react';
import { ELEMENTS_P0, type ElementP0 } from '../net/contract';
import { useGameStore } from '../net/store';
import { findLocalPlayer } from './localPlayer';
import { spellPhrase } from './spellText';

export type DialSlot = 0 | 1 | 2;

export interface SpellSelection {
  slot: DialSlot;
  element: ElementP0;
  phrase: string;
  generated: boolean;
  locked: boolean;
  fistCharged: boolean;
  hardwareDrives: boolean;
  choose: (slot: DialSlot) => void;
  toggleLock: () => void;
}

function isDialSlot(value: number): value is DialSlot {
  return value === 0 || value === 1 || value === 2;
}

export function useSpellSelection(): SpellSelection {
  const dialSlot = useGameStore((state) => state.hardware?.dialSlot);
  const buttonPressed = useGameStore((state) => state.hardware?.buttonPressed ?? false);
  const fistCharged = useGameStore((state) => state.hardware?.fistCharged ?? false);
  const role = useGameStore((state) => state.localRole);
  const incantations = useGameStore((state) => state.gameState?.world?.incantations);
  const elementLocked = useGameStore(
    (state) => findLocalPlayer(state.gameState?.players, state.localPlayerId, state.localRole)?.elementLocked ?? false,
  );
  const selectedElement = useGameStore(
    (state) => findLocalPlayer(state.gameState?.players, state.localPlayerId, state.localRole)?.selectedElement,
  );

  const [slot, setSlot] = useState<DialSlot>(0);
  const [localLock, setLocalLock] = useState(false);
  const [buttonLatched, setButtonLatched] = useState(false);

  const hardwareDrives = dialSlot !== undefined && role !== 'partner';

  useEffect(() => {
    if (hardwareDrives || !selectedElement) return;
    const index = ELEMENTS_P0.indexOf(selectedElement);
    if (isDialSlot(index)) setSlot(index);
  }, [hardwareDrives, selectedElement]);

  useEffect(() => {
    if (dialSlot === undefined) return;
    setSlot(dialSlot);
  }, [dialSlot]);

  useEffect(() => {
    if (!buttonPressed) return;
    setButtonLatched(true);
  }, [buttonPressed]);

  const dialReady = useRef(false);
  useEffect(() => {
    if (!dialReady.current) {
      dialReady.current = true;
      return;
    }
    setButtonLatched(false);
    setLocalLock(false);
  }, [dialSlot]);

  const choose = (next: DialSlot) => {
    if (hardwareDrives) return;
    setSlot(next);
    setLocalLock(false);
    setButtonLatched(false);
  };

  const phrase = spellPhrase(incantations, ELEMENTS_P0[slot]);

  return {
    slot,
    element: ELEMENTS_P0[slot],
    phrase: phrase.text,
    generated: phrase.generated,
    locked: elementLocked || localLock || buttonLatched || buttonPressed,
    fistCharged,
    hardwareDrives,
    choose,
    toggleLock: () => setLocalLock((value) => !value),
  };
}
