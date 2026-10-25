import type { CSSProperties } from 'react';
import { ELEMENT_COLORS, ELEMENTS_P0, type ElementP0 } from '../net/contract';
import { useGameStore } from '../net/store';
import styles from './combat.module.css';
import { ELEMENT_LABEL } from './spellText';
import { useSpellSelection, type DialSlot } from './useSpellSelection';

const WHEEL: readonly { slot: DialSlot; element: ElementP0; angle: number }[] = ELEMENTS_P0.map(
  (element, index) => ({
    slot: index as DialSlot,
    element,
    angle: index * 120,
  }),
);

function sigilOffset(angle: number): { x: string; y: string } {
  const radians = (angle * Math.PI) / 180;
  const x = Math.sin(radians) * 34;
  const y = -Math.cos(radians) * 34;
  return { x: x.toFixed(4), y: y.toFixed(4) };
}

export function SpellWheel() {
  const { slot, element, phrase, locked, fistCharged, hardwareDrives, choose, toggleLock } = useSpellSelection();
  const role = useGameStore((state) => state.localRole);
  const hint =
    role === 'partner'
      ? 'Raise your right arm to turn the wheel'
      : 'Turn the dial. Click to lock. Fist + hold to speak.';
  const housingStyle = { '--glow': ELEMENT_COLORS[element] } as CSSProperties;

  return (
    <div>
      <div
        className={styles.housing}
        data-locked={locked ? 'true' : 'false'}
        data-charged={fistCharged ? 'true' : 'false'}
        style={housingStyle}
      >
        <div className={styles.pointer} aria-hidden="true" />
        <div className={styles.rotor} style={{ transform: `rotate(${slot * -120}deg)` }}>
          {WHEEL.map((entry) => {
            const offset = sigilOffset(entry.angle);
            const selected = entry.slot === slot;
            return (
              <button
                key={entry.element}
                type="button"
                className={selected ? styles.sigilOn : styles.sigil}
                style={{
                  background: ELEMENT_COLORS[entry.element],
                  left: `calc(50% + ${offset.x}%)`,
                  top: `calc(50% + ${offset.y}%)`,
                }}
                disabled={hardwareDrives}
                aria-pressed={selected}
                aria-label={ELEMENT_LABEL[entry.element]}
                onClick={() => choose(entry.slot)}
              >
                <span className={styles.sigilLabel} style={{ transform: `rotate(${slot * 120}deg)` }}>
                  {ELEMENT_LABEL[entry.element]}
                </span>
              </button>
            );
          })}
        </div>
        <div className={styles.hub} aria-hidden="true" />
        <button
          type="button"
          className={locked ? styles.lockOn : styles.lock}
          disabled={hardwareDrives}
          aria-pressed={locked}
          aria-label={locked ? 'Unlock element' : 'Lock element'}
          onClick={() => {
            if (hardwareDrives) return;
            toggleLock();
          }}
        >
          {locked ? 'LOCKED' : 'LOCK'}
        </button>
      </div>
      <p className={styles.elementName} style={{ color: ELEMENT_COLORS[element] }}>
        {ELEMENT_LABEL[element]}
      </p>
      <div className={styles.slip}>
        <p className={styles.phrase}>{phrase}</p>
      </div>
      <p className={styles.wheelHint}>{hint}</p>
    </div>
  );
}
