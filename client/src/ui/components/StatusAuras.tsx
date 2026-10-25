import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { OpponentStatus } from '../../combat/encounter';
import { usePlayerState } from '../../combat/playerState';
import { HAND } from '../../combat/spellVfx';
import { SPELLS } from '../../combat/spells';
import './status-auras.css';

const flame = { maskImage: 'url(/art/particles/fire_01.png)', WebkitMaskImage: 'url(/art/particles/fire_01.png)' };
/** Fixed lightning shapes in a 100×100 box; the flicker comes from CSS. */
const DRAIN_ARCS = ['18,30 30,22 26,40 40,34 38,50', '62,26 70,40 60,44 74,58', '34,62 46,56 44,70 58,66 56,80', '78,64 70,72 82,80'];

/** Lasting effects drawn on a wolf for as long as the status lasts, so you can read the board at a glance. */
export function WolfStatusAura({ statuses, reduced }: { statuses: readonly OpponentStatus[]; reduced: boolean }) {
  const has = (id: OpponentStatus['id']) => statuses.some(status => status.id === id);
  return <div className="wolf-auras" aria-hidden="true">
    <AnimatePresence>
      {has('chilled') && <motion.div key="chilled" className="aura-chilled" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .5 }}>
        {[0, 1, 2, 3, 4].map(i => <i key={i} style={{ left: `${18 + i * 16}%`, animationDelay: `${i * -.6}s` }} />)}
      </motion.div>}
      {has('burning') && <motion.div key="burning" className="aura-burning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .4 }}>
        {[0, 1, 2, 3].map(i => <i key={i} style={{ ...flame, left: `${16 + i * 20}%`, animationDelay: `${i * -.17}s` }} />)}
      </motion.div>}
      {has('drained') && <motion.svg key="drained" className="aura-drained" viewBox="0 0 100 100" preserveAspectRatio="none"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        {DRAIN_ARCS.map((points, i) => <polyline key={i} points={points} style={{ animationDelay: `${i * -.09}s` }} />)}
      </motion.svg>}
      {has('frozen') && <motion.div key="frozen" className="aura-frozen" initial={reduced ? { opacity: 0 } : { scaleY: 0, opacity: 1 }}
        animate={{ scaleY: 1, opacity: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.15, filter: 'brightness(2)' }}
        transition={{ duration: reduced ? .2 : .45, ease: [.2, .9, .3, 1.2] }}>
        <i /><i /><i />
      </motion.div>}
    </AnimatePresence>
  </div>;
}

/** Your own active spells: an ice wall in front of you while shielded, and crackling hands while Overcharged. */
export function PlayerWards({ reduced }: { reduced: boolean }) {
  const shield = usePlayerState(state => state.statuses.find(status => status.id === 'shielded'));
  const overcharged = usePlayerState(state => state.statuses.some(status => status.id === 'overcharged'));
  const hurt = usePlayerState(state => state.hurt);
  const max = SPELLS['ice-shield'].shield!.amount;
  const strength = shield ? (shield.amount ?? 0) / max : 0;
  // Each crystal pane of the wall, with a slight random lean, fixed for the encounter.
  const panes = useMemo(() => Array.from({ length: 7 }, (_, i) => ({ left: i * 13.5, height: 62 + (i % 3) * 16 + (i === 3 ? 22 : 0), lean: (i - 3) * 3 })), []);
  return <div className="player-wards" aria-hidden="true">
    <AnimatePresence>
      {shield && <motion.div key="wall" className={`ice-wall${strength <= .5 ? ' is-cracked' : ''}`}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scaleY: 0 }} animate={{ opacity: .55 + strength * .4, scaleY: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 40, scale: 1.08, filter: 'brightness(2.2)' }} transition={{ duration: reduced ? .2 : .4 }}>
        {panes.map((pane, i) => <i key={i} style={{ left: `${pane.left}%`, height: `${pane.height}%`, rotate: `${pane.lean}deg` }} />)}
        {/* A flash across the wall each time it soaks up a hit. */}
        {hurt?.absorbed ? <motion.span key={hurt.id} className="ice-wall-flash" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: .5 }} /> : null}
      </motion.div>}
      {overcharged && <motion.div key="overcharge" className="overcharge-hand" style={{ left: `${HAND.x}%`, top: `${HAND.y}%` }}
        initial={{ opacity: 0, scale: .5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.6 }} transition={{ duration: .3 }}>
        <span className="overcharge-core" />
        <svg viewBox="-50 -50 100 100">{DRAIN_ARCS.slice(0, 3).map((points, i) => <polyline key={i} points={points} transform={`rotate(${i * 120}) translate(-50 -50)`} />)}</svg>
      </motion.div>}
    </AnimatePresence>
  </div>;
}
