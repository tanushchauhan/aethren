import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { Cast } from '../../combat/spellBattle';
import { buildSpellVfx, SPELL_TIMING } from '../../combat/spellVfx';

export function SpellEffect({ cast, reduced }: { cast: Cast; reduced: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ x: 50, y: 43 });
  const fx = useMemo(() => buildSpellVfx(cast.spell), [cast.spell]);
  useLayoutEffect(() => {
    const measure = () => {
      const bounds = root.current?.getBoundingClientRect();
      const target = document.getElementById(`opponent-${cast.targetId}`)?.getBoundingClientRect();
      if (bounds && target) setPoint({ x: (target.x + target.width / 2 - bounds.x) / bounds.width * 100, y: (target.y + target.height * .55 - bounds.y) / bounds.height * 100 });
    };
    measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure);
  }, [cast.targetId]);
  const mask = (file: string, color = fx.color) => ({ maskImage: `url(${file})`, WebkitMaskImage: `url(${file})`, backgroundColor: color, color });
  const travel = SPELL_TIMING.impactMs / 1000;
  return <div ref={root} className={`spell-effect spell-${cast.spell.element}`} aria-hidden="true">
    {!reduced && !cast.resolved && <>
      <motion.span className="spell-particle spell-casting-sigil" style={mask('/art/particles/circle_01.png', fx.highlight)}
        initial={{ scale: .25, opacity: 0, rotate: 0 }} animate={{ scale: [ .25, 1.2, .8 ], opacity: [0, .8, 0], rotate: 90 }} transition={{ duration: travel }} />
      {Array.from({ length: fx.trailCount }, (_, i) => <motion.span key={`trail-${i}`} className="spell-particle spell-trail" style={mask(fx.trail)}
        initial={{ left: '50%', top: '68%', opacity: 0, scale: .25 }}
        animate={{ left: `${point.x}%`, top: `${point.y}%`, opacity: [0, .7, 0], scale: [.3, .55, .1], rotate: i * 47 }}
        transition={{ delay: i * .018, duration: travel - i * .018, ease: 'easeIn' }} />)}
      <motion.div className="spell-travel-core" initial={{ left: '50%', top: '68%' }} animate={{ left: `${point.x}%`, top: `${point.y}%` }} transition={{ duration: travel, ease: 'easeIn' }}>
        <motion.span className="spell-projectile spell-particle" style={mask(fx.core)} initial={{ scale: .25, opacity: 0 }} animate={{ scale: fx.coreScale, opacity: [0, 1, 1], rotate: cast.spell.element === 'frost' ? 160 : 30 }} transition={{ duration: travel }} />
        <motion.span className="spell-particle spell-inner-core" style={mask(fx.core, fx.highlight)} initial={{ scale: .1 }} animate={{ scale: [.1, .65, .4], opacity: [.3, 1, .7] }} transition={{ duration: travel }} />
        {Array.from({ length: fx.orbitCount }, (_, i) => {
          const angle = i * Math.PI * 2 / fx.orbitCount;
          return <motion.span key={`orbit-${i}`} className="spell-particle spell-fragment" style={mask(fx.accent, fx.highlight)}
            animate={{ x: [Math.cos(angle) * 30, Math.cos(angle + 2) * 42, 0], y: [Math.sin(angle) * 30, Math.sin(angle + 2) * 42, 0], rotate: [0, 130], opacity: [.3, 1, .5] }} transition={{ duration: travel }} />;
        })}
      </motion.div>
    </>}
    {cast.resolved && <div className="spell-impact" style={{ left: `${point.x}%`, top: `${point.y}%` }}>
      {Array.from({ length: reduced ? 1 : fx.ringCount }, (_, i) => <motion.span key={`ring-${i}`} className="spell-particle spell-wave" style={mask('/art/particles/circle_01.png', i % 2 ? fx.highlight : fx.color)}
        initial={{ scale: .2, opacity: .8 }} animate={{ scale: reduced ? .8 : 1.2 + i * .65, opacity: 0, rotate: i * 30 }} transition={{ delay: i * .08, duration: .65 }} />)}
      {!reduced && <>
        <motion.span className="spell-particle spell-residue" style={mask(fx.residue)} initial={{ scale: .5, opacity: .6 }} animate={{ scale: 2.5, opacity: 0, y: -20 }} transition={{ duration: .85 }} />
        {Array.from({ length: fx.shardCount }, (_, i) => {
          const angle = i * 2.4, distance = fx.spread * (.4 + (i % 7) / 10);
          return <motion.span key={`shard-${i}`} className="spell-particle spell-fragment" style={mask(i % 3 ? fx.accent : fx.core, i % 4 ? fx.color : fx.highlight)}
            initial={{ x: 0, y: 0, scale: .8, opacity: 1 }} animate={{ x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, scale: .05, opacity: 0, rotate: i * 50 }} transition={{ duration: .65 + (i % 3) * .07 }} />;
        })}
      </>}
    </div>}
  </div>;
}
