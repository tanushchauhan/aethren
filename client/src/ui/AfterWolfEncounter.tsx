import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { RainOverlay } from './components/RainOverlay';

export function AfterWolfEncounter({ muted, onToggleSound }: { muted: boolean; onToggleSound: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => { heading.current?.focus(); }, []);
  return <motion.main className="wolf-combat-stage after-wolf-encounter" aria-label="Beyond the clearing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? .1 : 1.2 }}>
    <img className="wolf-combat-backdrop" src="/art/forest-base.png" alt="Moonlight filters through a quiet forest" />
    <RainOverlay />
    <section className="after-encounter-story">
      <p>The journey continues</p><h1 ref={heading} tabIndex={-1}>Beyond the clearing</h1>
      <p>The last growl fades into the rain. Between the trees, a narrow path catches the moonlight. You step forward.</p>
    </section>
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
