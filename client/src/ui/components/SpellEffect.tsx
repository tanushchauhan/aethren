import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { motion } from 'motion/react';
import type { Cast, HitFeedback } from '../../combat/spellBattle';
import type { SpellElement } from '../../combat/spells';
import { buildSpellVfx, CHAIN_STEP_MS, HAND, SPELL_VISUALS, spellTiming, type SpellVfxProfile } from '../../combat/spellVfx';
import './spell-effect.css';

type Point = { x: number; y: number };
/** Where the caster's hand is: yours, or your co-op partner's at the edge of the screen. */
const HandPoint = createContext<Point>(HAND);
/** `big` picks the large impact; `size` scales the projectile; `cluster` is a six-point crystal rather than one icicle. */
type Visual = { fx: SpellVfxProfile; big: boolean; size: number; cluster: boolean; angle: number; random: () => number; id: number };
type ProjectileProps = Visual & { charge: number; released: boolean };

/** Seeded so a cast's bolts and shards keep their shape across re-renders. */
function seeded(seed: number) {
  let state = seed * 7919 % 2147483647 || 1;
  return () => (state = state * 16807 % 2147483647) / 2147483647;
}

/** A jagged lightning path between two points, kinked perpendicular to the line. */
function jag(from: Point, to: Point, segments: number, amplitude: number, random: () => number): string {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1, nx = -dy / length, ny = dx / length;
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, offset = i === 0 || i === segments ? 0 : (random() * 2 - 1) * amplitude;
    return `${(from.x + dx * t + nx * offset).toFixed(2)},${(from.y + dy * t + ny * offset).toFixed(2)}`;
  }).join(' ');
}

const mask = (file: string, color: string): CSSProperties => ({ maskImage: `url(${file})`, WebkitMaskImage: `url(${file})`, backgroundColor: color, color });

/** An icicle pointing along +x; facet lines sell it as cut crystal rather than a flat triangle. */
function IceShard({ id, size = 1, style }: { id: number; size?: number; style?: CSSProperties }) {
  return <svg className="ice-shard" viewBox="-56 -16 116 32" width={116 * size} height={32 * size} style={{ marginLeft: -58 * size, marginTop: -16 * size, ...style }}>
    <defs><linearGradient id={`ice-${id}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#ffffff" /><stop offset=".45" stopColor="#c4f4ff" /><stop offset="1" stopColor="#3b82d6" />
    </linearGradient></defs>
    <polygon points="58,0 8,-14 -26,-7 -52,0 -26,7 8,14" fill={`url(#ice-${id})`} stroke="#f4feff" strokeWidth="2" strokeLinejoin="round" />
    <path d="M58 0 L-52 0 M8 -14 L-6 0 L8 14 M-26 -7 L-14 0 L-26 7" stroke="#ffffff" strokeOpacity=".8" strokeWidth="1.3" fill="none" />
  </svg>;
}

/** The spell forming in the caster's hand: a pulsing aura, a turning sigil and element motes drawn inward. */
function HandCharge({ element, charge, released, random }: { element: SpellElement; charge: number; released: boolean; random: () => number }) {
  const HAND = useContext(HandPoint);
  const motes = useMemo(() => Array.from({ length: 14 }, (_, i) => ({ angle: i / 14 * Math.PI * 2 + random() * .4, radius: 95 + random() * 45, delay: random() * .5 })), [random]);
  return <motion.div className="hand-charge" style={{ left: `${HAND.x}%`, top: `${HAND.y}%` }}
    initial={{ opacity: 0, scale: .4 }} animate={{ opacity: released ? 0 : 1, scale: released ? 1.3 : 1 }} transition={{ duration: released ? .12 : charge * .6 }}>
    <span className="hand-sigil" />
    <span className="hand-aura" />
    {motes.map((mote, i) => <motion.span key={i} className={`hand-mote mote-${element}`} style={{ rotate: mote.angle * 180 / Math.PI }}
      initial={{ x: Math.cos(mote.angle) * mote.radius, y: Math.sin(mote.angle) * mote.radius, opacity: 0 }}
      animate={{ x: 0, y: element === 'fire' ? -10 : 0, opacity: [0, 1, 0], scale: [.6, 1.2, .3] }}
      transition={{ duration: .55, delay: mote.delay, repeat: Infinity, repeatDelay: .05, ease: 'easeIn' }} />)}
  </motion.div>;
}

/** Fireball: a flickering flame body with a tail that streams out behind it once thrown. */
function FireProjectile({ fx, size, angle, charge, released }: ProjectileProps) {
  return <motion.div className="fire-ball" style={{ rotate: angle }} initial={{ scale: 0 }} animate={{ scale: size }} transition={{ duration: charge, ease: [.3, 1.3, .5, 1] }}>
    <motion.span className="fire-tail" initial={{ scaleX: 0, opacity: 0 }} animate={released ? { scaleX: 1, opacity: 1 } : {}} transition={{ duration: .12 }} />
    <span className="fire-outer" />
    <span className="spell-particle fire-lick" style={mask(fx.core, fx.color)} />
    <span className="fire-core" />
  </motion.div>;
}

/** Fire Lance: a spear of flame drawn out to full length in the hand, then thrown point first. */
function LanceProjectile({ size, angle, charge, released }: ProjectileProps) {
  // The axis carries the angle so the lance can stretch along its own length.
  return <span className="fire-lance" style={{ transform: `rotate(${angle}deg)` }}>
    <motion.span className="lance-body" initial={{ scaleX: .1, scaleY: .5, opacity: 0 }} animate={{ scaleX: size, scaleY: size, opacity: 1 }} transition={{ duration: charge, ease: [.3, 1.2, .5, 1] }}>
      <motion.span className="fire-tail lance-tail" initial={{ scaleX: 0, opacity: 0 }} animate={released ? { scaleX: 1, opacity: 1 } : {}} transition={{ duration: .1 }} />
      <span className="lance-shaft" /><span className="lance-tip" />
    </motion.span>
  </span>;
}

/** Frost: the crystal spins as it forms, then locks onto the target. Prison and Nova use a six-point cluster. */
function FrostProjectile({ cluster, size, angle, charge, id }: ProjectileProps) {
  return <motion.div className="frost-crystal" initial={{ scale: 0, rotate: angle - 540 }} animate={{ scale: size, rotate: angle }} transition={{ duration: charge, ease: [.2, .8, .3, 1] }}>
    <span className="frost-glow" />
    {cluster ? <>
      {Array.from({ length: 6 }, (_, i) => <span key={i} className="frost-arm" style={{ transform: `rotate(${i * 60}deg) translateX(26px)` }}><IceShard id={id} size={.5} /></span>)}
      <IceShard id={id} size={.62} />
    </> : <IceShard id={id} />}
  </motion.div>;
}

/** Storm: a crackling orb with arcs jumping off it. */
function StormProjectile({ size, charge, random }: ProjectileProps) {
  const arcs = useMemo(() => Array.from({ length: 5 }, (_, i) => {
    const angle = i / 5 * Math.PI * 2 + random(), length = 34 + random() * 26;
    return jag({ x: 0, y: 0 }, { x: Math.cos(angle) * length, y: Math.sin(angle) * length }, 5, 7, random);
  }), [random]);
  return <motion.div className="storm-orb-wrap" initial={{ scale: 0 }} animate={{ scale: size }} transition={{ duration: charge, ease: [.3, 1.3, .5, 1] }}>
    <svg className="storm-arcs" width="0" height="0">
      {arcs.map((points, i) => <polyline key={i} points={points} style={{ animationDelay: `${i * -.07}s` }} />)}
    </svg>
    <span className="storm-orb" />
  </motion.div>;
}

/** Sparks or crystals dropped along the flight path, each appearing as the projectile passes. */
function PathTrail({ element, from, point, travel, count }: { element: SpellElement; from: Point; point: Point; travel: number; count: number }) {
  return <>{Array.from({ length: count }, (_, i) => {
    const t = (i + 1) / (count + 1);
    return <motion.span key={i} className={`path-trail trail-${element}`} style={{ left: `${from.x + (point.x - from.x) * t}%`, top: `${from.y + (point.y - from.y) * t}%` }}
      initial={{ opacity: 0, scale: 0 }} animate={{ opacity: [0, 1, 0], scale: [0, 1, .3], y: element === 'fire' ? -26 : 18, rotate: element === 'frost' ? 90 : 0 }}
      transition={{ delay: travel * t * t, duration: .55 }} />;
  })}</>;
}

/** The thrown lightning: a flickering channel between two points that outlives the orb by a beat. */
function StormChannel({ from, to, travel, random }: { from: Point; to: Point; travel: number; random: () => number }) {
  const paths = useMemo(() => [0, 1, 2].map(() => jag(from, to, 12, 2.6, random)), [from.x, from.y, to.x, to.y, random]);
  return <motion.svg className="storm-channel" viewBox="0 0 100 100" preserveAspectRatio="none"
    initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0] }} transition={{ duration: travel + .3, times: [0, .7, 1] }}>
    {paths.map((points, i) => <g key={i} className="storm-flicker" style={{ animationDelay: `${i * -.05}s` }}>
      <polyline className="bolt-glow" points={points} /><polyline className="bolt-core" points={points} />
    </g>)}
  </motion.svg>;
}

function FireImpact({ fx, big: burst, random }: Visual) {
  const flames = useMemo(() => Array.from({ length: fx.pieces }, (_, i) => ({ angle: i / fx.pieces * Math.PI * 2 + random() * .4, distance: fx.spread * (.3 + random() * .45), spin: random() * 120 - 60, size: 1.2 + random() * .8 })), [fx, random]);
  const embers = useMemo(() => Array.from({ length: fx.pieces + 6 }, () => ({ x: (random() * 2 - 1) * fx.spread, rise: 60 + random() * fx.spread, delay: random() * .1 })), [fx, random]);
  return <>
    {Array.from({ length: burst ? 2 : 1 }, (_, i) => <motion.span key={`ring-${i}`} className="fire-ring" initial={{ scale: .2, opacity: 1 }}
      animate={{ scale: 2 + i * 1.1, opacity: 0 }} transition={{ delay: i * .08, duration: .55, ease: [.1, .8, .3, 1] }} />)}
    {flames.map((flame, i) => <motion.span key={`flame-${i}`} className="spell-particle fire-tongue" style={mask(fx.core, i % 3 ? fx.color : fx.highlight)}
      initial={{ x: 0, y: 0, scale: .3, opacity: 1 }}
      animate={{ x: Math.cos(flame.angle) * flame.distance, y: Math.sin(flame.angle) * flame.distance * .6 - 34, scale: flame.size, opacity: [1, 1, 0], rotate: flame.spin }}
      transition={{ duration: .6 + (i % 3) * .08, ease: [.1, .7, .4, 1] }} />)}
    {embers.map((ember, i) => <motion.span key={`ember-${i}`} className="fire-ember" initial={{ x: 0, y: 0, opacity: 1 }}
      animate={{ x: ember.x, y: [0, -ember.rise, -ember.rise + 30], opacity: [1, 1, 0] }} transition={{ delay: ember.delay, duration: 1.1, ease: 'easeOut' }} />)}
    {[0, 1, 2].map(i => <motion.span key={`smoke-${i}`} className="spell-particle fire-smoke" style={mask(fx.residue, '#3a2620')}
      initial={{ x: (i - 1) * 30, scale: .5, opacity: 0 }} animate={{ y: -90, scale: 2.4, opacity: [0, .75, 0] }} transition={{ delay: .1 + i * .08, duration: 1.3 }} />)}
  </>;
}

function FrostImpact({ fx, big: burst, random, id }: Visual) {
  const shards = useMemo(() => Array.from({ length: fx.pieces + 4 }, () => ({ angle: random() * Math.PI * 2, distance: fx.spread * (.4 + random() * .6), size: .18 + random() * .2, spin: random() * 540 - 270 })), [fx, random]);
  const spikeCount = burst ? 9 : 5;
  const spikes = useMemo(() => Array.from({ length: spikeCount }, (_, i) => {
    const angle = burst ? i / spikeCount * Math.PI * 2 : -Math.PI / 2 + (i - (spikeCount - 1) / 2) * .5;
    return { angle, height: .7 + random() * .6, delay: random() * .08 };
  }), [burst, random]);
  return <>
    {Array.from({ length: burst ? 2 : 1 }, (_, i) => <motion.svg key={`hex-${i}`} className="frost-hex" viewBox="-50 -50 100 100" initial={{ scale: .2, opacity: 1, rotate: 0 }}
      animate={{ scale: 2.2 + i * 1.1, opacity: 0, rotate: 30 }} transition={{ delay: i * .08, duration: .6, ease: [.1, .8, .3, 1] }}>
      <polygon points="0,-46 40,-23 40,23 0,46 -40,23 -40,-23" />
    </motion.svg>)}
    {spikes.map((spike, i) => burst
      // Frost Nova: a ring of ice erupts from the ground around the target.
      ? <motion.span key={`spike-${i}`} className="ice-spike" style={{ left: Math.cos(spike.angle) * 95, top: 40 + Math.sin(spike.angle) * 30, rotate: Math.cos(spike.angle) * 22, height: 90 * spike.height }}
          initial={{ scaleY: 0, opacity: 1 }} animate={{ scaleY: [0, 1.15, 1, 1], opacity: [1, 1, 1, 0] }} transition={{ delay: spike.delay, duration: 1.05, times: [0, .12, .2, 1] }} />
      // Frost Shard: crystals bloom out of the wound where the icicle struck.
      : <span key={`bloom-${i}`} className="frost-arm" style={{ transform: `rotate(${spike.angle}rad)` }}>
          <motion.span style={{ display: 'block' }} initial={{ x: 0, scale: 0, opacity: 1 }} animate={{ x: 30, scale: [0, spike.height, spike.height], opacity: [1, 1, 0] }} transition={{ delay: spike.delay, duration: .85, times: [0, .18, 1] }}>
            <IceShard id={id} size={.5} />
          </motion.span>
        </span>)}
    {shards.map((shard, i) => <motion.span key={`shard-${i}`} className="frost-arm" initial={{ x: 0, y: 0, opacity: 1, rotate: shard.angle * 180 / Math.PI }}
      animate={{ x: Math.cos(shard.angle) * shard.distance, y: [0, Math.sin(shard.angle) * shard.distance - 20, Math.sin(shard.angle) * shard.distance + 50], rotate: shard.angle * 180 / Math.PI + shard.spin, opacity: [1, 1, 0] }}
      transition={{ duration: .75 + (i % 3) * .1, ease: 'easeOut' }}><IceShard id={id} size={shard.size} /></motion.span>)}
    <motion.span className="spell-particle frost-mist" style={mask(fx.residue, '#dff8ff')} initial={{ scale: .6, opacity: .8 }} animate={{ scale: 2.8, opacity: 0, y: 10 }} transition={{ duration: 1 }} />
  </>;
}

function StormImpact({ fx, big: burst, random }: Visual) {
  const branchCount = burst ? 10 : 6;
  const branches = useMemo(() => Array.from({ length: branchCount }, (_, i) => {
    const angle = i / branchCount * Math.PI * 2 + random() * .5, length = fx.spread * (.6 + random() * .5);
    return jag({ x: 0, y: 0 }, { x: Math.cos(angle) * length, y: Math.sin(angle) * length }, 7, 12, random);
  }), [burst, fx, random]);
  const sparks = useMemo(() => Array.from({ length: fx.pieces }, (_, i) => ({ angle: i / fx.pieces * Math.PI * 2 + random() * .3, distance: fx.spread * (.7 + random() * .5) })), [fx, random]);
  return <>
    <motion.svg className="storm-branches" width="0" height="0" initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0] }} transition={{ duration: .45, times: [0, .6, 1] }}>
      {branches.map((points, i) => <g key={i} className="storm-flicker" style={{ animationDelay: `${i * -.03}s` }}>
        <polyline className="bolt-glow" points={points} /><polyline className="bolt-core" points={points} />
      </g>)}
    </motion.svg>
    {Array.from({ length: burst ? 2 : 1 }, (_, i) => <motion.span key={`ring-${i}`} className="storm-ring" initial={{ scale: .2, opacity: 1, rotate: 0 }}
      animate={{ scale: 1.9 + i, opacity: 0, rotate: 90 }} transition={{ delay: i * .1, duration: .5, ease: [.1, .8, .3, 1] }} />)}
    {sparks.map((spark, i) => <span key={`spark-${i}`} className="spell-spark-axis" style={{ transform: `rotate(${spark.angle}rad)` }}>
      <motion.span className="spell-spark" initial={{ x: 0, scaleX: 1.6, opacity: 1 }} animate={{ x: spark.distance, scaleX: .1, opacity: [1, 1, 0] }}
        transition={{ duration: .3 + (i % 3) * .06, ease: [.05, .7, .3, 1] }} />
    </span>)}
  </>;
}

/** Ice Shield: crystals fly out of the hand and take their places in the wall in front of you. */
function ShieldForm({ travel, id }: { travel: number; id: number }) {
  return <>{Array.from({ length: 7 }, (_, i) => <motion.span key={i} className="frost-arm" initial={{ left: `${HAND.x}%`, top: `${HAND.y}%`, scale: .2, opacity: 0, rotate: -90 }}
    animate={{ left: `${27 + i * 7.6}%`, top: '66%', scale: 1, opacity: [0, 1, 0], rotate: -90 }} transition={{ duration: travel + .15, delay: i * .03, ease: [.2, .8, .3, 1] }}>
    <IceShard id={id} size={.55} />
  </motion.span>)}</>;
}

/** Overcharge: lightning is pulled out of the air and coils into the hand. */
function OverchargeForm({ travel, random }: { travel: number; random: () => number }) {
  const HAND = useContext(HandPoint);
  const arcs = useMemo(() => Array.from({ length: 5 }, (_, i) => {
    const angle = i / 5 * Math.PI * 2 + random() * .6;
    return jag({ x: HAND.x + Math.cos(angle) * 16, y: HAND.y + Math.sin(angle) * 22 }, HAND, 7, 1.6, random);
  }), [random]);
  return <motion.svg className="storm-channel" viewBox="0 0 100 100" preserveAspectRatio="none" initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0] }} transition={{ duration: travel + .2, times: [0, .7, 1] }}>
    {arcs.map((points, i) => <g key={i} className="storm-flicker" style={{ animationDelay: `${i * -.04}s` }}>
      <polyline className="bolt-glow" points={points} /><polyline className="bolt-core" points={points} />
    </g>)}
  </motion.svg>;
}

/** Mounts its children after a pause, so each jump of a chain lands in turn. */
function Delayed({ ms, children }: { ms: number; children: ReactNode }) {
  const [shown, setShown] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const timer = window.setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return shown ? <>{children}</> : null;
}

const projectiles = { fireball: FireProjectile, meteor: FireProjectile, lance: LanceProjectile, icicle: FrostProjectile, crystal: FrostProjectile, orb: StormProjectile, none: null };
const impacts = { fire: FireImpact, frost: FrostImpact, storm: StormImpact, none: null };

/** `hits` are this cast's landed and dodged targets, primary first; self spells have none. */
/** `hand` is where the spell leaves from; a partner's (`own` false) self spells take shape at their side, not in front of you. */
export function SpellEffect({ cast, hits, reduced, hand = HAND, own = true }: { cast: Cast; hits: HitFeedback[]; reduced: boolean; hand?: Point; own?: boolean }) {
  const HAND = hand;
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<{ points: Record<string, Point>; width: number; height: number }>({ points: {}, width: 1000, height: 600 });
  const spell = cast.spell, look = SPELL_VISUALS[spell.id];
  const fx = useMemo(() => buildSpellVfx(spell), [spell]);
  const random = useMemo(() => seeded(cast.id), [cast.id]);
  const timing = spellTiming(spell, reduced);
  const [released, setReleased] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setReleased(true), timing.chargeMs);
    return () => clearTimeout(timer);
  }, []);
  useLayoutEffect(() => {
    // Every wolf's position, since area, splash and chain spells land on more than one.
    const measure = () => {
      const bounds = root.current?.getBoundingClientRect();
      if (!bounds) return;
      const points: Record<string, Point> = {};
      document.querySelectorAll<HTMLElement>('[id^="opponent-"]').forEach(element => {
        const target = element.getBoundingClientRect();
        points[element.id.slice('opponent-'.length)] = { x: (target.x + target.width / 2 - bounds.x) / bounds.width * 100, y: (target.y + target.height * .55 - bounds.y) / bounds.height * 100 };
      });
      setStage({ points, width: bounds.width, height: bounds.height });
    };
    measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure);
  }, []);
  const point = stage.points[cast.targetId] ?? { x: 50, y: 43 };
  // A meteor forms high in the sky above and beside its target instead of in the hand.
  const from = look.projectile === 'meteor' ? { x: Math.min(88, point.x + 22), y: 4 } : HAND;
  const visual: Visual = { fx, big: look.big, size: look.size, cluster: look.projectile === 'crystal', random, id: cast.id,
    angle: Math.atan2((point.y - from.y) * stage.height, (point.x - from.x) * stage.width) * 180 / Math.PI };
  const palette = { '--fx': fx.color, '--fx-hi': fx.highlight, '--fx-deep': fx.deep } as CSSProperties;
  const charge = timing.chargeMs / 1000, travel = timing.travelMs / 1000;
  const Projectile = projectiles[look.projectile], Impact = impacts[look.impact], element = spell.element;
  const struck = hits.some(hit => hit.kind === 'hurt');
  return <HandPoint.Provider value={hand}><div ref={root} className={`spell-effect spell-${element} spell-${spell.id}${cast.power > 1 ? ' is-overcharged' : ''}`} style={palette} aria-hidden="true">
    {!reduced && !cast.resolved && <>
      <HandCharge element={element} charge={charge} released={released} random={random} />
      {released && <motion.span className="hand-release" style={{ left: `${HAND.x}%`, top: `${HAND.y}%` }} initial={{ scale: .4, opacity: 1 }} animate={{ scale: 2, opacity: 0 }} transition={{ duration: .3 }} />}
      {look.projectile === 'meteor' && <motion.span className="meteor-sky-glow" style={{ left: `${from.x}%`, top: `${from.y}%` }} initial={{ opacity: 0, scale: .3 }} animate={{ opacity: released ? 0 : 1, scale: 1 }} transition={{ duration: released ? .2 : charge }} />}
      {released && Projectile && element !== 'storm' && <PathTrail element={element} from={from} point={point} travel={travel} count={fx.trail} />}
      {released && own && look.self === 'shield' && <ShieldForm travel={travel} id={cast.id} />}
      {released && look.self === 'overcharge' && <OverchargeForm travel={travel} random={random} />}
      {Projectile && <motion.div className="spell-travel-core" initial={{ left: `${from.x}%`, top: `${from.y}%` }}
        animate={released ? { left: `${point.x}%`, top: `${point.y}%` } : undefined} transition={{ duration: travel, ease: [.45, 0, .9, .55] }}>
        {cast.power > 1 && <span className="overcharge-ring" />}
        <Projectile {...visual} charge={charge} released={released} />
      </motion.div>}
    </>}
    {!reduced && released && element === 'storm' && Projectile && <StormChannel from={HAND} to={point} travel={travel} random={random} />}
    {cast.resolved && struck && !reduced && <motion.span className="spell-screen-flash" initial={{ opacity: look.big ? .75 : .55 }} animate={{ opacity: 0 }} transition={{ duration: .28, ease: 'easeOut' }} />}
    {cast.resolved && look.self && <motion.span className="hand-release" style={{ left: `${HAND.x}%`, top: `${HAND.y}%` }} initial={{ scale: .6, opacity: 1 }} animate={{ scale: 3, opacity: 0 }} transition={{ duration: .4 }} />}
    {cast.resolved && hits.map((hit, index) => {
      const at = stage.points[hit.targetId];
      if (!at) return null;
      const lag = spell.chain ? index * CHAIN_STEP_MS : 0, previous = index ? stage.points[hits[index - 1].targetId] : undefined;
      // The primary target, and every wolf an area spell lands on, gets the full impact; splash and chain hits a smaller one.
      const full = index === 0 || !!spell.area;
      return <Delayed key={hit.id} ms={lag}>
        {spell.chain && previous && !reduced && <StormChannel from={previous} to={at} travel={.12} random={random} />}
        <div className="spell-impact" style={{ left: `${at.x}%`, top: `${at.y}%` }}>
          <motion.span className="spell-flash-core" initial={{ scale: .3, opacity: 1 }} animate={{ scale: hit.kind === 'dodge' ? 1 : fx.scale * (full ? 2.1 : 1.3), opacity: [1, 1, 0] }}
            transition={{ duration: hit.kind === 'dodge' ? .22 : .32, times: [0, .35, 1], ease: 'easeOut' }} />
          {hit.kind !== 'dodge' && !reduced && Impact && <Impact {...visual} big={full && look.big} />}
          {hit.kind !== 'dodge' && !reduced && index === 0 && spell.pierce && <span className="lance-pierce" style={{ transform: `rotate(${visual.angle}deg)` }}>
            <motion.span initial={{ scaleX: 0, opacity: 1 }} animate={{ scaleX: 1, opacity: [1, 1, 0] }} transition={{ duration: .4, ease: 'easeOut' }} />
          </span>}
          {hit.kind === 'dodge' && !reduced && <motion.span className="spell-particle spell-whiff" style={mask(fx.residue, fx.color)} initial={{ scale: .4, opacity: .7 }} animate={{ scale: 1.6, opacity: 0, x: 40 }} transition={{ duration: .5 }} />}
        </div>
      </Delayed>;
    })}
  </div></HandPoint.Provider>;
}
