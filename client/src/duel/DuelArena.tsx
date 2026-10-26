import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion, useAnimate, useReducedMotion } from 'motion/react';
import type { BuzzPattern, CalibrationBaseline, NormalizedLandmark } from '@aethren/shared';
import { PoseLandmarkerService } from '../vision/poseLandmarkerService';
import {
  BODY_PART_LABEL,
  BODY_PART_TAG,
  classifyDodgeAndPose,
  computeCalibrationBaseline,
  headCenter,
  resolveTorso,
  type BodyPartTarget,
  type DodgeClassification,
} from '../vision/poseClassifiers';
import { projectBodyPoint } from '../ui/components/DefenseProjection';
import { RainOverlay } from '../ui/components/RainOverlay';
import { SpellEffect } from '../ui/components/SpellEffect';
import { playCastSound, playImpactSound } from '../combat/spellSound';
import { buildSpellVfx, HAND, HIT_TIMING, spellTiming } from '../combat/spellVfx';
import {
  combineRitualMultiplier,
  gradeStepTiming,
  matchRitualPrefix,
  MISSED_STEP_MULTIPLIER,
  PERFECT_WINDOW_END,
  PERFECT_WINDOW_START,
  RITUAL_LABELS,
  SPELLS,
  SPELLS_BY_ELEMENT,
  type RitualStep,
  type Spell,
  type SpellElement,
  type TimingGrade,
} from '../combat/spells';
import type { Cast, HitFeedback } from '../combat/spellBattle';
import { dialSlot, type GloveInputEvent } from '../glove/gloveInput';
import { useGloveMode } from '../glove/gloveMode';
import { gloveProfile } from '../glove/gloveProfile';
import { readDial, useOptionalGloveSession } from '../glove/GloveSession';
import { usePause } from '../pause/pauseStore';
import { useStoryStore } from '../net/storyStore';
import { useBattleMusic } from '../ui/useBattleMusic';
import {
  castDuelSpell,
  clearOutgoingVisual,
  cycleCastSpeed,
  duelDefenseJudge,
  leaveDuel,
  markReady,
  notifyDuelWeaving,
  openDuel,
  requestRematch,
  resolveOutgoingVisual,
  restDuel,
  setCastSpeed,
  startPracticeDuel,
  triggerDuelParry,
  useDuel,
  type IncomingAttack,
} from './duelGame';
import { CAST_SPEED_PROFILES, type CastSpeedTier } from './duelSpells';
import '../ui/wolf-combat-stage.css';
import '../ui/components/combat-camera.css';
import '../ui/components/player-status-panel.css';
import '../glove/glove-combat.css';
import './duel.css';

const ELEMENTS: SpellElement[] = ['fire', 'frost', 'storm'];
const ELEMENT_RGB: Record<SpellElement, [number, number, number]> = {
  fire: [255, 110, 30],
  frost: [80, 200, 255],
  storm: [170, 110, 255],
};
const ELEMENT_COLOR: Record<SpellElement, string> = {
  fire: '#ff8a3d',
  frost: '#7fd8ff',
  storm: '#c49bff',
};
const ELEMENT_CREST: Record<SpellElement, string> = { fire: '🔥', frost: '❄', storm: '⚡' };
const WHEEL = ELEMENTS.flatMap((el) => SPELLS_BY_ELEMENT[el]);
const SLOTS = WHEEL.length;
const PER_ELEMENT = SLOTS / ELEMENTS.length;
const POSE_HOLD_FOR_STEP_MS = 110;

const CENTER = 180;
const R_IN = 106;
const R_OUT = 164;
const R_ARC_IN = 168;
const R_ARC_OUT = 175;
const WEDGE_DEG = 360 / SLOTS;

const polar = (radius: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)] as const;
};
function sector(inner: number, outer: number, from: number, to: number) {
  const [x0, y0] = polar(outer, from);
  const [x1, y1] = polar(outer, to);
  const [x2, y2] = polar(inner, to);
  const [x3, y3] = polar(inner, from);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${outer} ${outer} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}A${inner} ${inner} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}Z`;
}
const wedgeStart = (index: number) => -90 + index * WEDGE_DEG;
const wedgeCenter = (index: number) => wedgeStart(index) + WEDGE_DEG / 2;

const RIVAL_SPRITES = {
  male: '/art/spellbearer-male.png',
  female: '/art/spellbearer-female.png',
} as const;

interface ActiveRitualState {
  spellId: Spell['id'];
  steps: RitualStep[];
  grades: TimingGrade[];
  lastFeedback: string | null;
  stepStartedAt: number;
}

/** Projects a targeted body part onto the 640×480 SVG defense space (`projectBodyPoint`). */
function projectPartAnchor(
  part: BodyPartTarget,
  landmarks: NormalizedLandmark[],
  baseline: CalibrationBaseline,
): { x: number; y: number } {
  if (part === 'head') {
    const hc = headCenter(landmarks) ?? landmarks[0];
    return hc ? projectBodyPoint(hc, baseline) : { x: 320, y: 112 };
  }
  if (part === 'left_shoulder') {
    const ls = landmarks[11];
    return ls ? projectBodyPoint(ls, baseline) : { x: 245, y: 170 };
  }
  if (part === 'right_shoulder') {
    const rs = landmarks[12];
    return rs ? projectBodyPoint(rs, baseline) : { x: 395, y: 170 };
  }
  const l = landmarks[11];
  const r = landmarks[12];
  if (l && r) {
    return projectBodyPoint({ x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 + 0.03 }, baseline);
  }
  return { x: 320, y: 205 };
}

const FALLBACK_ANCHOR: Record<BodyPartTarget, { x: number; y: number }> = {
  head: { x: 320, y: 112 },
  left_shoulder: { x: 245, y: 170 },
  right_shoulder: { x: 395, y: 170 },
  chest: { x: 320, y: 205 },
};

const TARGET_RING_RADIUS_PX = 40;

/**
 * High-performance (zero React re-renders per frame!) Osu! body-pose defense overlay.
 * - Uses direct SVG DOM refs (`setAttribute('r', ...)`) inside `requestAnimationFrame` instead of `setState(now)`,
 *   eliminating the 60fps SVG `drop-shadow` GPU re-rasterization lag on secondary laptops!
 * - Locks each disjoint ring onto the player's current body position at the exact moment that ring's staggered
 *   `startAt` timer begins (`now >= ring.startAt`), so the player cannot dodge all circles with one early move!
 */
function DuelBodyDefenseOverlay({
  attack,
  landmarksRef,
  baselineRef,
  trackingRef,
  poseRef,
}: {
  attack: IncomingAttack;
  landmarksRef: React.MutableRefObject<NormalizedLandmark[] | null>;
  baselineRef: React.MutableRefObject<CalibrationBaseline | null>;
  trackingRef: React.MutableRefObject<boolean>;
  poseRef: React.MutableRefObject<DodgeClassification | null>;
}) {
  const stripeId = useId().replaceAll(':', '');
  const bodyPolyRef = useRef<SVGPolygonElement>(null);
  const headEllipseRef = useRef<SVGEllipseElement>(null);
  const bodyGroupRef = useRef<SVGGElement>(null);
  const groupRefs = useRef<Map<string, SVGGElement>>(new Map());
  const approachRefs = useRef<Map<string, SVGCircleElement>>(new Map());
  const targetRefs = useRef<Map<string, SVGCircleElement>>(new Map());
  const labelRefs = useRef<Map<string, SVGTextElement>>(new Map());
  const countdownRef = useRef<HTMLElement>(null);
  const statusStrongRef = useRef<HTMLElement>(null);

  // Each ring's anchor is locked dynamically when `now >= ring.startAt`!
  const lockedAnchors = useRef<Map<string, { x: number; y: number }>>(new Map());
  const clearedMap = useRef<Map<string, boolean>>(new Map());

  const attackRef = useRef(attack);
  attackRef.current = attack;

  useEffect(() => {
    lockedAnchors.current.clear();
    clearedMap.current.clear();
  }, [attack.id]);

  // Register per-ring clearance judge for `duelGame.ts`
  useEffect(() => {
    duelDefenseJudge.checkRing = (ringId, part) => {
      const lm = landmarksRef.current;
      const base = baselineRef.current;
      const trk = trackingRef.current;
      const pose = poseRef.current;
      const anchor = lockedAnchors.current.get(ringId) ?? FALLBACK_ANCHOR[part];
      let dodged = false;
      if (lm && base && trk) {
        const cur = projectPartAnchor(part, lm, base);
        dodged = Math.hypot(cur.x - anchor.x, cur.y - anchor.y) > TARGET_RING_RADIUS_PX;
      }
      const parried = Boolean(pose && pose.confidence >= 0.55 && pose.isRightArmRaised);
      return { dodged, parried };
    };
    return () => {
      duelDefenseJudge.checkRing = null;
    };
  }, [landmarksRef, baselineRef, trackingRef, poseRef]);

  // Direct DOM animation loop (no React state updates -> buttery 60fps on any laptop!)
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const curAttack = attackRef.current;
      const lm = landmarksRef.current;
      const base = baselineRef.current;
      const trk = trackingRef.current;
      const pose = poseRef.current;

      // Update projected body polygon & head position directly
      if (bodyGroupRef.current) {
        bodyGroupRef.current.setAttribute('opacity', trk ? '1' : '0.45');
      }
      const torso = lm ? resolveTorso(lm) : null;
      const polyPts =
        torso && base
          ? [torso.leftShoulder, torso.rightShoulder, torso.rightHip, torso.leftHip].map((p) =>
              projectBodyPoint(p, base),
            )
          : [
              { x: 245, y: 170 },
              { x: 395, y: 170 },
              { x: 375, y: 330 },
              { x: 265, y: 330 },
            ];
      if (bodyPolyRef.current) {
        bodyPolyRef.current.setAttribute('points', polyPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      }
      const headPt = lm && base ? projectPartAnchor('head', lm, base) : FALLBACK_ANCHOR.head;
      if (headEllipseRef.current) {
        headEllipseRef.current.setAttribute('cx', headPt.x.toFixed(1));
        headEllipseRef.current.setAttribute('cy', headPt.y.toFixed(1));
      }

      const parriedByArm = Boolean(pose && pose.confidence >= 0.55 && pose.isRightArmRaised);
      let nextImpactIn = Infinity;
      let activeLabel = '';

      for (const ring of curAttack.rings) {
        const gEl = groupRefs.current.get(ring.ringId);
        const appEl = approachRefs.current.get(ring.ringId);
        const tgtEl = targetRefs.current.get(ring.ringId);
        const txtEl = labelRefs.current.get(ring.ringId);
        if (!gEl || !appEl || !tgtEl || !txtEl) continue;

        // Disjoint timer: if this ring hasn't started yet, show a subtle queued marker on the live body part
        if (now < ring.startAt) {
          const preview = lm && base ? projectPartAnchor(ring.part, lm, base) : FALLBACK_ANCHOR[ring.part];
          tgtEl.setAttribute('cx', preview.x.toFixed(1));
          tgtEl.setAttribute('cy', preview.y.toFixed(1));
          appEl.setAttribute('cx', preview.x.toFixed(1));
          appEl.setAttribute('cy', preview.y.toFixed(1));
          appEl.setAttribute('r', (TARGET_RING_RADIUS_PX * 2.6).toFixed(1));
          txtEl.setAttribute('x', preview.x.toFixed(1));
          txtEl.setAttribute('y', (preview.y + 6).toFixed(1));
          txtEl.textContent = `#${ring.index + 1} ${BODY_PART_TAG[ring.part]}`;
          gEl.setAttribute('opacity', '0.32');
          gEl.style.color = '#ffd479';
          continue;
        }

        // Already resolved ring
        if (ring.verdict !== null) {
          gEl.setAttribute('opacity', '0.18');
          gEl.style.color = ring.verdict === 'hit' ? '#ff4657' : '#9fffd4';
          txtEl.textContent = ring.verdict === 'hit' ? '✗' : '✓';
          continue;
        }

        // Lock this ring's coordinates at the moment its disjoint timer starts!
        let anchor = lockedAnchors.current.get(ring.ringId);
        if (!anchor) {
          anchor = lm && base ? projectPartAnchor(ring.part, lm, base) : FALLBACK_ANCHOR[ring.part];
          lockedAnchors.current.set(ring.ringId, anchor);
        }

        const duration = Math.max(1, ring.impactAt - ring.startAt);
        const p = Math.min(1, Math.max(0, (now - ring.startAt) / duration));
        const approachR = TARGET_RING_RADIUS_PX * (2.6 - 1.6 * p);

        let dodged = false;
        if (lm && base && trk) {
          const cur = projectPartAnchor(ring.part, lm, base);
          dodged = Math.hypot(cur.x - anchor.x, cur.y - anchor.y) > TARGET_RING_RADIUS_PX;
        }
        const parried = parriedByArm || ring.parriedUntil >= now;
        const safe = dodged || parried;
        clearedMap.current.set(ring.ringId, safe);

        tgtEl.setAttribute('cx', anchor.x.toFixed(1));
        tgtEl.setAttribute('cy', anchor.y.toFixed(1));
        appEl.setAttribute('cx', anchor.x.toFixed(1));
        appEl.setAttribute('cy', anchor.y.toFixed(1));
        appEl.setAttribute('r', approachR.toFixed(1));
        txtEl.setAttribute('x', anchor.x.toFixed(1));
        txtEl.setAttribute('y', (anchor.y + 6).toFixed(1));
        txtEl.textContent = safe ? '✓' : `#${ring.index + 1} ${BODY_PART_TAG[ring.part]}`;
        gEl.setAttribute('opacity', '1');
        gEl.style.color = safe ? '#9fffd4' : '#ff6b7a';

        const rem = ring.impactAt - now;
        if (rem < nextImpactIn) {
          nextImpactIn = rem;
            activeLabel = safe
            ? parried
              ? `🛡 Ring #${ring.index + 1} Parried!`
              : `✓ Ring #${ring.index + 1} (${BODY_PART_LABEL[ring.part]}) Dodged!`
            : `Move ${BODY_PART_LABEL[ring.part]} or Parry (Shake / T) — Ring #${ring.index + 1} of ${ring.total}`;
        }
      }

      if (statusStrongRef.current && activeLabel) {
        statusStrongRef.current.textContent = activeLabel;
      }
      if (countdownRef.current && Number.isFinite(nextImpactIn)) {
        countdownRef.current.textContent = `${Math.max(0, nextImpactIn / 1000).toFixed(2)}s until next ring · Disjoint sequential timers (${CAST_SPEED_PROFILES[curAttack.speedTier].label})`;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [landmarksRef, baselineRef, trackingRef, poseRef]);

  return (
    <div className="defense-encounter-overlay duel-defense-overlay">
      <svg
        className="defense-projection duel-fast-svg"
        viewBox="0 0 640 480"
        role="img"
        aria-label="Your projected body and staggered Osu! spell target rings"
      >
        <defs>
          <pattern id={stripeId} patternUnits="userSpaceOnUse" width="16" height="16" patternTransform="rotate(35)">
            <rect width="16" height="16" fill="#df263518" />
            <rect width="3" height="16" fill="#ff46572e" />
          </pattern>
        </defs>

        <g ref={bodyGroupRef} className="projected-body" opacity="0.85">
          <polygon ref={bodyPolyRef} points="245,170 395,170 375,330 265,330" />
          <ellipse ref={headEllipseRef} cx="320" cy="112" rx="29" ry="36" />
        </g>

        {attack.rings.map((ring) => {
          const initialPos = FALLBACK_ANCHOR[ring.part];
          return (
            <g
              key={ring.ringId}
              ref={(el) => {
                if (el) groupRefs.current.set(ring.ringId, el);
                else groupRefs.current.delete(ring.ringId);
              }}
              className="projected-impact"
              style={{ color: '#ff6b7a' }}
            >
              <circle
                ref={(el) => {
                  if (el) targetRefs.current.set(ring.ringId, el);
                  else targetRefs.current.delete(ring.ringId);
                }}
                cx={initialPos.x}
                cy={initialPos.y}
                r={TARGET_RING_RADIUS_PX}
                className="impact-target"
              />
              <circle
                ref={(el) => {
                  if (el) approachRefs.current.set(ring.ringId, el);
                  else approachRefs.current.delete(ring.ringId);
                }}
                cx={initialPos.x}
                cy={initialPos.y}
                r={TARGET_RING_RADIUS_PX * 2.6}
                className="impact-approach"
              />
              <text
                ref={(el) => {
                  if (el) labelRefs.current.set(ring.ringId, el);
                  else labelRefs.current.delete(ring.ringId);
                }}
                x={initialPos.x}
                y={initialPos.y + 6}
                textAnchor="middle"
              >
                #{ring.index + 1} {BODY_PART_TAG[ring.part]}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="defense-impact-caption" role="status">
        <small>
          ⚠ INCOMING {attack.spell.name.toUpperCase()} ({attack.rings.length} STAGGERED RINGS)
        </small>
        <strong ref={statusStrongRef}>
          Dodge each ring in sequence or Parry (Shake / T)!
        </strong>
        <small ref={countdownRef}>
          Staggered Osu! rings — keep weaving while dodging!
        </small>
      </div>
    </div>
  );
}

export function DuelArena() {
  const {
    status,
    practice,
    castSpeed,
    foeName,
    foeAvatar,
    health,
    maxHealth,
    foeHealth,
    foeMaxHealth,
    magicPower,
    maxMagicPower,
    shield,
    overcharged,
    foeWeaving,
    incoming,
    outgoing,
    feedback,
    hurt,
    defended,
    message,
    castCount,
    foeCastCount,
    winner,
    readyMine,
    rematchMine,
    countdownEnd,
  } = useDuel();

  const speedProfile = CAST_SPEED_PROFILES[castSpeed];
  const stepDurationMs = speedProfile.stepDurationMs;

  const name = useStoryStore((s) => s.playerName);
  const session = useOptionalGloveSession();
  const hub = session?.hub ?? null;
  const glove = session?.glove ?? null;
  const setCombatControl = useGloveMode((s) => s.setCombatControl);
  const reduced = useReducedMotion();
  const [world, animateWorld] = useAnimate<HTMLDivElement>();

  const [muted, setMuted] = useState(false);
  useBattleMusic(muted, '/audio/final-surge.mp3');

  // Webcam pose tracking state stored in refs so 20Hz pose samples never trigger full DuelArena React re-renders!
  const video = useRef<HTMLVideoElement>(null);
  const baseline = useRef<CalibrationBaseline | null>(null);
  const landmarksRef = useRef<NormalizedLandmark[] | null>(null);
  const trackingRef = useRef(false);
  const livePoseRef = useRef<DodgeClassification | null>(null);
  const [camMessage, setCamMessage] = useState('Starting camera…');
  const [tracking, setTracking] = useState(false);

  // Spell wheel & timed ritual state
  const [slot, setSlot] = useState(0);
  const [ritual, setRitual] = useState<ActiveRitualState | null>(null);
  const [stepProgress, setStepProgress] = useState(0);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);
  const [count, setCount] = useState(3);

  const slotRef = useRef<number>(0);
  const ritualRef = useRef<ActiveRitualState | null>(null);
  ritualRef.current = ritual;
  const pointerRotation = useRef(wedgeCenter(0));
  const heldB2 = useRef(false);
  const activePoseRef = useRef<{ step: RitualStep | null; since: number; fired: boolean }>({
    step: null,
    since: 0,
    fired: false,
  });

  const buzz = (p: BuzzPattern) => {
    if (hub && glove) hub.send(glove.id, { cmd: 'buzz', p });
  };
  const buzzRef = useRef(buzz);
  buzzRef.current = buzz;

  // Claim combat control so `GloveMenuNav` does not intercept B1/B2/T/Dial
  useEffect(() => {
    setCombatControl(true);
    return () => setCombatControl(false);
  }, [setCombatControl]);

  useEffect(() => {
    openDuel(name);
    return () => {
      duelDefenseJudge.checkRing = null;
      leaveDuel();
    };
  }, [name]);

  // Ensure leaving duel always returns to the title screen cleanly (even if storyStore had started=true)
  const exitToTitle = () => {
    duelDefenseJudge.checkRing = null;
    leaveDuel();
    useStoryStore.setState({ started: false, room: null });
  };

  // Countdown ticker
  useEffect(() => {
    if (status !== 'countdown') return;
    setCount(Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000)));
    const timer = window.setInterval(
      () => setCount(Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000))),
      80,
    );
    return () => clearInterval(timer);
  }, [status, countdownEnd]);

  // Camera tracking + calibration (updates refs at 20Hz without re-rendering React tree every frame!)
  useEffect(() => {
    if (!video.current) return;
    const service = new PoseLandmarkerService();
    let disposed = false;
    let frame = 0;
    let last = 0;
    const samples: NormalizedLandmark[][] = [];

    const tick = (now: number) => {
      if (disposed) return;
      if (now - last > 50 && video.current) {
        last = now;
        const sampled = service.sample(now);
        if (service.getStatus().mode !== 'webcam') {
          trackingRef.current = false;
          setTracking(false);
          setCamMessage('Camera off — use Shake / T to Parry incoming spells');
          markReady();
          return;
        }
        const valid = sampled && resolveTorso(sampled);
        if (valid && sampled) {
          landmarksRef.current = sampled;
          if (!baseline.current) {
            samples.push(sampled);
            setCamMessage(`Stand centered with arms down · ${Math.min(100, Math.round((samples.length / 16) * 100))}%`);
            if (samples.length >= 16) {
              const centers = samples.map((pts) => (pts[11]!.x + pts[12]!.x) / 2);
              const candidate = computeCalibrationBaseline(samples, now);
              if (candidate && Math.max(...centers) - Math.min(...centers) < 0.08) {
                baseline.current = candidate;
                trackingRef.current = true;
                setTracking(true);
                setCamMessage('Tracking ready');
                markReady();
              } else {
                samples.splice(0, 8);
                setCamMessage('Hold steady briefly to calibrate…');
              }
            }
          } else {
            const pose = classifyDodgeAndPose(sampled, baseline.current);
            livePoseRef.current = pose;
            const ok = pose.confidence >= 0.55;
            if (ok !== trackingRef.current) {
              trackingRef.current = ok;
              setTracking(ok);
            }
            // Feed CV Raise Arm pose into active ritual directly
            const active = ritualRef.current;
            if (active && ok) {
              const detected: RitualStep | null = pose.isRightArmRaised ? 'raise' : null;
              if (!detected) {
                activePoseRef.current = { step: null, since: 0, fired: false };
              } else if (activePoseRef.current.step !== detected) {
                activePoseRef.current = { step: detected, since: now, fired: false };
              } else if (!activePoseRef.current.fired && now - activePoseRef.current.since >= POSE_HOLD_FOR_STEP_MS) {
                activePoseRef.current.fired = true;
                latest.current.pushRitualStep(detected, 1.15);
              }
            }
          }
        } else {
          if (trackingRef.current) {
            trackingRef.current = false;
            setTracking(false);
          }
          livePoseRef.current = null;
          setCamMessage('Move into camera view: show head & shoulders');
        }
      }
      frame = requestAnimationFrame(tick);
    };

    void service
      .start(video.current, 'webcam')
      .then((mode) => {
        if (disposed) {
          service.stop();
          return;
        }
        if (mode !== 'webcam') {
          service.stop();
          trackingRef.current = false;
          setTracking(false);
          setCamMessage('No webcam — use Shake / T to Parry incoming spells');
          markReady();
          return;
        }
        frame = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!disposed) {
          trackingRef.current = false;
          setTracking(false);
          setCamMessage('No webcam — use Shake / T to Parry incoming spells');
          markReady();
        }
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      service.stop();
    };
  }, []);

  // Fast outgoing spell projectile lifecycle (scales by selected `castSpeed` so spells fly much faster!)
  useEffect(() => {
    if (!outgoing) return;
    const id = outgoing.id;
    const baseTiming = spellTiming(outgoing.spell, !!reduced);
    const scale = CAST_SPEED_PROFILES[outgoing.speedTier].vfxDurationScale;
    const chargeMs = Math.round(baseTiming.chargeMs * scale);
    const travelMs = Math.round(baseTiming.travelMs * scale);
    const impactMs = chargeMs + travelMs;
    const finishMs = impactMs + 380;
    if (!muted && !reduced) {
      playCastSound(outgoing.spell, chargeMs / 1000, travelMs / 1000);
    }
    const impact = window.setTimeout(() => resolveOutgoingVisual(id), impactMs);
    const finish = window.setTimeout(() => clearOutgoingVisual(id), finishMs);
    return () => {
      clearTimeout(impact);
      clearTimeout(finish);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoing?.id, reduced]);

  useEffect(() => {
    if (!outgoing?.resolved) return;
    const landed = outgoing.spell.target === 'self' || outgoing.result !== 'dodged';
    if (!muted) playImpactSound(outgoing.spell, landed);
    if (!landed) buzzRef.current('fizzle');
    if (reduced || !landed || outgoing.spell.target === 'self') return;
    const a = buildSpellVfx(outgoing.spell).shake;
    void animateWorld(
      world.current,
      { x: [0, -a, a * 0.8, -a * 0.5, a * 0.25, 0], y: [0, a * 0.6, -a * 0.5, a * 0.3, -a * 0.1, 0] },
      { duration: 0.32, ease: 'easeOut' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoing?.id, outgoing?.resolved]);

  useEffect(() => {
    if (!hurt) return;
    if (hurt.guarded) buzzRef.current('tick');
    else buzzRef.current('hit');
  }, [hurt?.id]);

  // Ritual step timing bar loop (uses selected `stepDurationMs` for fast slider movement!)
  useEffect(() => {
    if (status !== 'fighting') {
      ritualRef.current = null;
      setRitual(null);
      setStepProgress(0);
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const active = ritualRef.current;
      if (active) {
        const dur = CAST_SPEED_PROFILES[useDuel.getState().castSpeed].stepDurationMs;
        const elapsed = now - active.stepStartedAt;
        const p = Math.min(1, Math.max(0, elapsed / dur));
        setStepProgress(p);
        if (elapsed >= dur) {
          latest.current.missRitualStep();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  const activeSpellId = ritual ? ritual.spellId : WHEEL[slot]!;
  const spell = SPELLS[activeSpellId];
  const element = spell.element;

  const cancelRitual = (notice?: string) => {
    ritualRef.current = null;
    setRitual(null);
    setStepProgress(0);
    notifyDuelWeaving(null);
    if (notice !== undefined) setBannerNotice(notice);
  };

  const moveTo = (next: number, withBuzz = false) => {
    const wrapped = ((next % SLOTS) + SLOTS) % SLOTS;
    if (withBuzz && wrapped !== slotRef.current) buzz('tick');
    slotRef.current = wrapped;
    setSlot(wrapped);
    setBannerNotice(null);
  };

  const beginRitualMode = (forSpell: Spell = SPELLS[WHEEL[slotRef.current]!]) => {
    const state = useDuel.getState();
    if (state.status !== 'fighting') return;
    if (state.magicPower < forSpell.cost) {
      buzz('fizzle');
      setBannerNotice(`Not enough MP for ${forSpell.name} (${forSpell.cost} MP). Hold B2 to Rest (+4 MP)!`);
      return;
    }
    const foundIndex = WHEEL.indexOf(forSpell.id);
    if (foundIndex >= 0) {
      slotRef.current = foundIndex;
      setSlot(foundIndex);
    }
    const now = performance.now();
    const nextState: ActiveRitualState = {
      spellId: forSpell.id,
      steps: [],
      grades: [],
      lastFeedback: null,
      stepStartedAt: now,
    };
    ritualRef.current = nextState;
    setRitual(nextState);
    setStepProgress(0);
    setBannerNotice(null);
    notifyDuelWeaving(forSpell.id, 1, forSpell.ritual.length);
    buzz('tick');
  };

  const finishRitualCast = (chosen: Spell, grades: readonly TimingGrade[], swingBoost = 1) => {
    const { multiplier, summary } = combineRitualMultiplier(grades);
    const finalPower = Math.round(multiplier * Math.max(1, swingBoost > 1 ? 1.05 : 1) * 100) / 100;
    const ok = castDuelSpell(chosen, finalPower, summary);
    if (!ok) {
      buzz('fizzle');
      cancelRitual(useDuel.getState().message);
      return;
    }
    buzz('cast');
    ritualRef.current = null;
    setRitual(null);
    setStepProgress(0);
  };

  const pushRitualStep = (step: RitualStep, swingBoost = 1) => {
    const state = useDuel.getState();
    if (state.status !== 'fighting') return;
    const currentRitual = ritualRef.current;
    if (!currentRitual) return;

    const now = performance.now();
    const dur = CAST_SPEED_PROFILES[state.castSpeed].stepDurationMs;
    const currentSpell = SPELLS[currentRitual.spellId];
    const nextSteps = [...currentRitual.steps, step];
    const elapsedStep = Math.max(0, now - currentRitual.stepStartedAt);
    const progress = Math.min(1, elapsedStep / dur);
    const timing = gradeStepTiming(progress);

    const matchesCurrent =
      nextSteps.length <= currentSpell.ritual.length &&
      nextSteps.every((s, idx) => currentSpell.ritual[idx] === s);

    const prefixMatch = matchesCurrent ? null : matchRitualPrefix(nextSteps);
    const resolvedSpell = matchesCurrent
      ? currentSpell
      : prefixMatch?.exact ??
        prefixMatch?.candidates.find((c) => c.element === currentSpell.element) ??
        prefixMatch?.candidates[0] ??
        null;

    if (!resolvedSpell) {
      if (step === 'swing') return;
      buzz('fizzle');
      const expectedStep = currentSpell.ritual[currentRitual.steps.length]!;
      cancelRitual(`Ritual broken! Expected ${RITUAL_LABELS[expectedStep].label}.`);
      return;
    }

    if (state.magicPower < resolvedSpell.cost) {
      buzz('fizzle');
      cancelRitual(`Not enough Magic Power for ${resolvedSpell.name} (${resolvedSpell.cost} MP).`);
      return;
    }

    const foundIndex = WHEEL.indexOf(resolvedSpell.id);
    if (foundIndex >= 0 && foundIndex !== slotRef.current) {
      slotRef.current = foundIndex;
      setSlot(foundIndex);
    }

    const nextGrades = [...currentRitual.grades, timing.grade];
    buzz('tick');

    if (nextSteps.length === resolvedSpell.ritual.length) {
      finishRitualCast(resolvedSpell, nextGrades, swingBoost);
      return;
    }

    const updated: ActiveRitualState = {
      spellId: resolvedSpell.id,
      steps: nextSteps,
      grades: nextGrades,
      lastFeedback: `${timing.label} (×${timing.multiplier.toFixed(2)})`,
      stepStartedAt: now,
    };
    ritualRef.current = updated;
    setRitual(updated);
    setStepProgress(0);
    notifyDuelWeaving(resolvedSpell.id, nextSteps.length + 1, resolvedSpell.ritual.length);
  };

  const missRitualStep = () => {
    const currentRitual = ritualRef.current;
    if (!currentRitual) return;
    const currentSpell = SPELLS[currentRitual.spellId];
    const expected = currentSpell.ritual[currentRitual.steps.length];
    if (!expected) return;
    buzz('fizzle');
    const nextSteps = [...currentRitual.steps, expected];
    const nextGrades: TimingGrade[] = [...currentRitual.grades, 'missed'];
    if (nextSteps.length === currentSpell.ritual.length) {
      finishRitualCast(currentSpell, nextGrades, 1);
      return;
    }
    const updated: ActiveRitualState = {
      ...currentRitual,
      steps: nextSteps,
      grades: nextGrades,
      lastFeedback: `✗ MISSED (×${MISSED_STEP_MULTIPLIER.toFixed(2)})`,
      stepStartedAt: performance.now(),
    };
    ritualRef.current = updated;
    setRitual(updated);
    setStepProgress(0);
    notifyDuelWeaving(currentSpell.id, nextSteps.length + 1, currentSpell.ritual.length);
  };

  // Dedicated non-conflicting controls:
  // - Touch (T) when NOT in a ritual step that expects 'T' = PARRY incoming Osu! ring (or cycles Cast Speed if no incoming spell!)
  // - B1 = Open / Advance Ritual (never conflicts with Parry!)
  // - B2 = Next Element (or Ritual step B2), Hold B2 = Rest (+4 MP)
  // - Swing = Parry incoming Osu! ring + Ritual swing step
  const onGlove = (event: GloveInputEvent) => {
    const state = useDuel.getState();

    if (state.status !== 'fighting') {
      if (event.type === 'down' && event.button === 'B1') {
        if (state.status === 'over') requestRematch();
        else if (state.status === 'seeking' || state.status === 'unavailable') startPracticeDuel();
        else if (state.status === 'paired' && !state.readyMine) markReady();
      } else if (event.type === 'down' && event.button === 'T') {
        cycleCastSpeed();
        buzz('tick');
      }
      return;
    }

    const hasIncoming = state.incoming.length > 0;
    const activeRitual = ritualRef.current;
    const expectedStep = activeRitual ? SPELLS[activeRitual.spellId].ritual[activeRitual.steps.length] : null;

    if (event.type === 'dial' && !activeRitual) {
      moveTo(dialSlot(event.value, SLOTS, slotRef.current), true);
      return;
    }

    if (event.type === 'gesture') {
      if (hasIncoming) {
        triggerDuelParry(950);
        buzz('tick');
      }
      if (activeRitual) pushRitualStep('swing', event.power);
      return;
    }

    if (event.type === 'down' && event.button === 'B2') {
      heldB2.current = false;
      if (hasIncoming && expectedStep !== 'B2') {
        triggerDuelParry(950);
        buzz('tick');
      }
    } else if (event.type === 'hold' && event.button === 'B2') {
      heldB2.current = true;
      if (restDuel()) buzz('tick');
    } else if (event.type === 'up' && event.button === 'B2') {
      if (!heldB2.current) {
        if (activeRitual) pushRitualStep('B2');
        else moveTo(slotRef.current + PER_ELEMENT, true);
      }
    } else if (event.type === 'down' && event.button === 'T') {
      if (activeRitual && expectedStep === 'T') {
        pushRitualStep('T');
        if (hasIncoming) triggerDuelParry(950);
      } else if (hasIncoming) {
        triggerDuelParry(950);
        buzz('tick');
      } else if (activeRitual) {
        pushRitualStep('T');
      } else {
        // When on the wheel with no incoming spell, T cycles the Cast Speed tier (1× / 1.5× / 2×)!
        cycleCastSpeed();
        buzz('tick');
      }
    } else if (event.type === 'down' && event.button === 'B1') {
      if (activeRitual) pushRitualStep('B1');
      else beginRitualMode();
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || usePause.getState().open) return;
    const el = event.target instanceof Element ? event.target : null;
    if (el?.closest('input, select, textarea, [contenteditable]')) return;
    const onButton = Boolean(el?.closest('button, a'));
    const state = useDuel.getState();
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (state.status !== 'fighting') {
      if ((key === 'Enter' || key === ' ') && !onButton && !event.repeat) {
        event.preventDefault();
        if (state.status === 'over') requestRematch();
        else if (state.status === 'seeking' || state.status === 'unavailable') startPracticeDuel();
        else if (state.status === 'paired' && !state.readyMine) markReady();
      } else if (!event.repeat && key === 'f') {
        cycleCastSpeed();
      }
      return;
    }

    if (key === 'Escape' && ritualRef.current) {
      cancelRitual('Ritual cancelled.');
      event.preventDefault();
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && !ritualRef.current) {
      moveTo(slotRef.current + (key === 'ArrowRight' ? 1 : -1));
      event.preventDefault();
    } else if (!event.repeat && key === 'e' && !ritualRef.current) {
      moveTo(slotRef.current + PER_ELEMENT);
    } else if (!event.repeat && key === 'f') {
      cycleCastSpeed();
    } else if (!event.repeat && key === 'r') {
      restDuel();
    } else if (!event.repeat && (key === 't' || key === 'q' || key === 'Shift')) {
      if (state.incoming.length > 0) {
        triggerDuelParry(950);
      } else {
        cycleCastSpeed();
      }
    } else if (!event.repeat && key === '1') {
      if (ritualRef.current) pushRitualStep('B1');
      else beginRitualMode();
    } else if (!event.repeat && key === '2') {
      if (ritualRef.current) pushRitualStep('B2');
      else moveTo(slotRef.current + PER_ELEMENT);
    } else if (!event.repeat && key === '3') {
      if (ritualRef.current) pushRitualStep('T');
      else if (state.incoming.length > 0) triggerDuelParry(950);
    } else if (!event.repeat && key === ' ' && !onButton) {
      event.preventDefault();
      if (state.incoming.length > 0) triggerDuelParry(950);
      if (ritualRef.current) pushRitualStep('swing', 1.25);
    } else if (!event.repeat && key === 'w') {
      if (ritualRef.current) pushRitualStep('raise');
    } else if (key === 'Enter' && !onButton && !event.repeat) {
      if (!ritualRef.current) beginRitualMode();
      event.preventDefault();
    }
  };

  const latest = useRef({ onGlove, onKey, pushRitualStep, missRitualStep });
  latest.current = { onGlove, onKey, pushRitualStep, missRitualStep };

  useEffect(() => {
    if (!session || !glove) return;
    const id = glove.id;
    return session.onInput((event, gloveId) => {
      if (gloveId === id && !usePause.getState().open) latest.current.onGlove(event);
    });
  }, [session?.onInput, glove?.id]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => latest.current.onKey(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!hub || !glove) return;
    const value = readDial(hub, glove.id);
    if (value !== null) moveTo(dialSlot(value, SLOTS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glove?.id, hub]);

  // Update physical glove LCD with spell + speed + duel status
  const lcd = useMemo(() => {
    const [r, g, b] = ELEMENT_RGB[element];
    return {
      cmd: 'lcd',
      l1: `${spell.name.slice(0, 10)} ${speedProfile.tag}`.slice(0, 16),
      l2: `HP${health} MP${magicPower} VS${foeHealth}`.slice(0, 16),
      r,
      g,
      b,
      ms: 4000,
    };
  }, [element, spell, speedProfile.tag, health, magicPower, foeHealth]);
  const lcdKey = JSON.stringify(lcd);
  useEffect(() => {
    if (!hub || !glove || status !== 'fighting') return;
    const push = () => hub.send(glove.id, lcd);
    push();
    const timer = window.setInterval(push, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glove?.id, status, lcdKey]);

  const wanted = wedgeCenter(slot);
  pointerRotation.current += ((wanted - pointerRotation.current + 540) % 360) - 180;
  const profile = glove ? gloveProfile(glove) : null;
  const canAfford = magicPower >= spell.cost;
  const currentStepIndex = ritual ? ritual.steps.length : 0;
  const currentExpectedStep = ritual ? spell.ritual[currentStepIndex] : spell.ritual[0];
  const currentStepInfo = currentExpectedStep ? RITUAL_LABELS[currentExpectedStep] : null;
  const inSweetSpot = stepProgress >= PERFECT_WINDOW_START && stepProgress <= PERFECT_WINDOW_END;
  const stepRemainingSec = (((1 - stepProgress) * stepDurationMs) / 1000).toFixed(1);

  // Rival reaction animation & SpellEffect adapter
  const latestReaction = feedback.at(-1) ?? null;
  const struck = !reduced && latestReaction?.kind === 'hurt';
  const stop = HIT_TIMING.hitStop / HIT_TIMING.react;
  const activeIncoming = incoming[0] ?? null;

  const pendingCast: Cast | null = outgoing
    ? {
        id: outgoing.id,
        casterId: 'player',
        spell: outgoing.spell,
        targetId: outgoing.spell.target === 'self' ? 'player' : 'rival',
        dodgeMode: 'natural',
        previousStance: 'balanced',
        power: outgoing.power,
        resolved: outgoing.resolved,
      }
    : null;
  const castHits: HitFeedback[] = outgoing
    ? feedback
        .filter((f) => f.castId === outgoing.id)
        .map((f) => ({ id: f.id, castId: f.castId, targetId: f.targetId, kind: f.kind, damage: f.damage, label: f.label }))
    : [];

  return (
    <motion.main
      className="wolf-combat-stage duel-combat-stage"
      aria-label="Spellbearer Duel Clearing"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0.15 : 0.6 }}
    >
      <video className="defense-hidden-video" ref={video} muted playsInline autoPlay aria-hidden="true" />

      <div ref={world} className="combat-world">
        <img
          className="wolf-combat-backdrop"
          src="/art/combat/wolf-clearing.png"
          alt="A moonlit forest clearing surrounded by wet bushes"
        />

        {/* Centered Rival Spellbearer Sprite in the clearing */}
        <div className="wolf-formation duel-formation" role="group" aria-label="Rival Spellbearer">
          <div className="wolf-slot duel-rival-slot" id="opponent-rival">
            <motion.div
              key={latestReaction?.id ?? 0}
              initial={false}
              animate={
                struck
                  ? {
                      x: [0, 0, 22, -8, 3, 0],
                      y: [0, 0, -16, 5, 0, 0],
                      scale: [1, 1.07, 0.91, 1.03, 1, 1],
                    }
                  : activeIncoming
                    ? { y: [0, -8, 0], scale: 1.06 }
                    : { x: 0, y: 0, scale: 1 }
              }
              transition={
                struck
                  ? {
                      duration: HIT_TIMING.react,
                      times: [0, stop, stop + 0.18, stop + 0.42, stop + 0.64, 1],
                      ease: 'easeOut',
                    }
                  : { duration: 0.35 }
              }
              className={`wolf-combatant duel-rival-combatant${foeWeaving || activeIncoming ? ' is-active' : ''}`}
            >
              <div className="wolf-bars duel-rival-bars">
                <div className="duel-rival-nameplate">
                  <strong>{foeName || 'Rival Spellbearer'}</strong>
                  <small>{practice ? 'AI Speed Caster' : 'PvP Rival'}</small>
                </div>
                <div className="wolf-stat-bar health">
                  <div
                    className="wolf-stat-track"
                    role="progressbar"
                    aria-label={`${foeName || 'Rival'} health`}
                    aria-valuemin={0}
                    aria-valuemax={foeMaxHealth}
                    aria-valuenow={foeHealth}
                  >
                    <span className="wolf-stat-fill" style={{ width: `${(foeHealth / foeMaxHealth) * 100}%` }} />
                    <span className="wolf-stat-markers" aria-hidden="true">
                      {Array.from({ length: 9 }, (_, index) => (
                        <i key={index} style={{ left: `${(index + 1) * 10}%` }} />
                      ))}
                    </span>
                  </div>
                  <img className="wolf-stat-icon" src="/art/resources/health.png" alt="" />
                </div>

                {foeWeaving && (
                  <div className="wolf-intent-tag duel-weaving-tag">
                    <span>
                      ⚡ Weaving <b>{SPELLS[foeWeaving.spellId].name}</b> ({foeWeaving.step}/{foeWeaving.total}) ·{' '}
                      <b>{CAST_SPEED_PROFILES[foeWeaving.speedTier].label}</b>
                    </span>
                    <small>Finish your spell first or get ready to dodge!</small>
                  </div>
                )}
                {activeIncoming && (
                  <div className="wolf-intent-tag jaw-grab">
                    <span>
                      🔥 Incoming <b>{activeIncoming.spell.name}</b> ({activeIncoming.rings.length} staggered rings ·{' '}
                      <b>{CAST_SPEED_PROFILES[activeIncoming.speedTier].label}</b>)!
                    </span>
                  </div>
                )}
              </div>

              <div className="wolf-turn-ring" aria-hidden="true" />
              {status === 'fighting' && (
                <span className="wolf-target-badge" role="status">
                  ◆ Rival Spellbearer · {foeHealth}/{foeMaxHealth} HP
                </span>
              )}

              <img
                className={`wolf-sprite duel-rival-sprite${latestReaction?.kind === 'hurt' ? ' wolf-hurt' : ''}`}
                src={RIVAL_SPRITES[foeAvatar]}
                alt={foeName || 'Rival Spellbearer'}
                draggable={false}
              />

              {latestReaction && (
                <motion.span
                  key={latestReaction.id}
                  className={`wolf-hit-feedback ${latestReaction.kind}${latestReaction.damage >= 14 ? ' is-heavy' : ''}`}
                  initial={{ x: '-50%', opacity: 0, scale: reduced ? 1 : 0.3 }}
                  animate={
                    reduced
                      ? { opacity: [1, 1, 0] }
                      : { opacity: [0, 1, 1, 0], scale: [0.3, 1.6, 1, 0.95], y: [0, -14, -30, -52] }
                  }
                  transition={
                    reduced ? { duration: 1.4 } : { duration: 1.3, times: [0, 0.1, 0.25, 1], ease: 'easeOut' }
                  }
                >
                  {latestReaction.kind === 'dodge' ? 'Dodged' : `−${latestReaction.damage}`}
                  {latestReaction.label && <small>{latestReaction.label}</small>}
                </motion.span>
              )}
            </motion.div>
          </div>
        </div>

        <RainOverlay />

        {pendingCast && (
          <SpellEffect key={pendingCast.id} cast={pendingCast} hits={castHits} reduced={!!reduced} own hand={HAND} />
        )}
      </div>

      {/* Hurt & Defended screen overlays */}
      {hurt && (
        <motion.div
          key={hurt.id}
          className={`player-hurt-overlay ${hurt.guarded ? 'blocked' : 'slash'}`}
          aria-hidden="true"
          initial={{ opacity: reduced ? 0.35 : 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.75 }}
        >
          {!reduced && !hurt.guarded && (
            <div className="player-slash-marks">
              <i />
              <i />
              <i />
            </div>
          )}
          <span>
            {hurt.guarded
              ? `Parried · −${hurt.damage} HP`
              : `−${hurt.damage} HP${hurt.absorbed ? ` · ${hurt.absorbed} shielded` : ''}`}
          </span>
        </motion.div>
      )}

      {defended && (
        <motion.div
          key={defended.id}
          className={`defense-result ${defended.kind}`}
          role="status"
          initial={{ opacity: 0 }}
          animate={{
            opacity: [0, 1, 1, 0],
            ...(reduced ? {} : { scale: [0.6, 1.2, 1, 1], y: [10, 0, -6, -22] }),
          }}
          transition={{ duration: reduced ? 0.8 : 1.1, times: [0, 0.12, 0.7, 1], ease: 'easeOut' }}
        >
          {defended.kind === 'dodged' ? 'DODGED!' : 'PARRIED!'}
        </motion.div>
      )}

      {/* High-Performance Disjoint Osu! Body Pose Defense Overlay */}
      {status === 'fighting' && activeIncoming && (
        <section className="combat-defense" aria-label="Movement defense">
          <DuelBodyDefenseOverlay
            key={activeIncoming.id}
            attack={activeIncoming}
            landmarksRef={landmarksRef}
            baselineRef={baseline}
            trackingRef={trackingRef}
            poseRef={livePoseRef}
          />
        </section>
      )}

      {/* Top Speed Contest HUD bar + Cast Speed Selector + Radial Spell Wheel + Ritual Stage */}
      {status === 'fighting' && (
        <aside
          className="glove-combat"
          data-element={element}
          data-phase={ritual ? 'ritual' : 'wheel'}
          style={{ '--el': ELEMENT_COLOR[element] } as CSSProperties}
          aria-label="Duel spell wheel"
        >
          <header className="player-turn-timer" data-urgent={Boolean(activeIncoming)} role="status">
            <div className="turn-timer-row">
              <span className="turn-timer-label">
                {activeIncoming ? '⚠ INCOMING · DODGE OR PARRY!' : `⚡ SPEED DUEL (${speedProfile.label})`}
              </span>
              <div className="duel-speed-selector" role="group" aria-label="Spell cast speed">
                {([1, 2, 3] as const).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    className="duel-speed-btn"
                    data-active={castSpeed === tier}
                    onClick={() => setCastSpeed(tier)}
                    title={`Slider: ${CAST_SPEED_PROFILES[tier].stepDurationMs}ms · Enemy Osu! rings: ${CAST_SPEED_PROFILES[tier].osuWindupMs}ms · Damage ×${CAST_SPEED_PROFILES[tier].damageBonus}`}
                  >
                    {CAST_SPEED_PROFILES[tier].label}
                  </button>
                ))}
              </div>
              <button type="button" className="turn-pass-btn" onClick={exitToTitle}>
                Leave to Title
              </button>
            </div>
            <div className="turn-timer-track">
              <span
                className="turn-timer-fill"
                style={{ width: `${(foeHealth / foeMaxHealth) * 100}%` }}
              />
            </div>
          </header>

          {/* RADIAL 12-SPELL WHEEL */}
          <section className="spell-wheel" aria-hidden={Boolean(ritual)} aria-label="Radial spell wheel">
            <div className="spell-wheel-dial">
              <svg viewBox="0 0 360 360" role="group" aria-label="Spells">
                {ELEMENTS.map((id, index) => (
                  <path
                    key={id}
                    className="wheel-arc"
                    d={sector(
                      R_ARC_IN,
                      R_ARC_OUT,
                      wedgeStart(index * PER_ELEMENT) + 1.2,
                      wedgeStart((index + 1) * PER_ELEMENT) - 1.2,
                    )}
                    style={{ fill: ELEMENT_COLOR[id] }}
                    data-active={id === element}
                  />
                ))}
                {WHEEL.map((id, index) => {
                  const wedge = SPELLS[id];
                  const color = ELEMENT_COLOR[wedge.element];
                  const active = index === slot;
                  const affordable = magicPower >= wedge.cost;
                  const [tx, ty] = polar(131, wedgeCenter(index));
                  const [bx, by] = polar(169, wedgeCenter(index));
                  const words = wedge.name.split(' ');
                  const lines = words.length > 1 ? [words[0]!, words.slice(1).join(' ')] : [wedge.name];
                  return (
                    <g
                      key={id}
                      className="wheel-wedge"
                      data-active={active}
                      data-affordable={affordable}
                      data-locked={false}
                      role="button"
                      aria-label={`${wedge.name}, ${wedge.cost} MP`}
                      aria-pressed={active}
                      onClick={() => (active ? beginRitualMode(wedge) : moveTo(index))}
                    >
                      <path
                        d={sector(R_IN, R_OUT, wedgeStart(index) + 1.4, wedgeStart(index + 1) - 1.4)}
                        style={{ '--wedge': color } as CSSProperties}
                      />
                      <text x={tx} y={ty - (lines.length - 1) * 7} textAnchor="middle" dominantBaseline="middle">
                        {lines.map((line, i) => (
                          <tspan key={i} x={tx} dy={i === 0 ? 0 : 14}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                      <circle className="wheel-cost-gem" cx={bx} cy={by} r={9} />
                      <text className="wheel-cost" x={bx} y={by + 0.5} textAnchor="middle" dominantBaseline="middle">
                        {wedge.cost}
                      </text>
                    </g>
                  );
                })}
                <polygon
                  className="wheel-pointer"
                  points={`${CENTER + R_IN - 1},${CENTER} ${CENTER + R_IN - 15},${CENTER - 8} ${CENTER + R_IN - 15},${CENTER + 8}`}
                  style={{ transform: `rotate(${pointerRotation.current}deg)` }}
                />
              </svg>
              <div className="wheel-hub" role="status">
                <span className="wheel-hub-crest" aria-hidden="true">
                  {ELEMENT_CREST[element]}
                </span>
                <strong className="wheel-hub-name">{spell.name}</strong>
                <span className="wheel-hub-cost" data-affordable={canAfford}>
                  {spell.cost} MP · {speedProfile.label} (×{speedProfile.damageBonus} Dmg)
                </span>
                <p className="wheel-hub-detail">
                  {!canAfford ? 'Need more MP — wait or Hold B2 to Rest (+4 MP).' : `${spell.description} (${spell.hint})`}
                </p>
                <span className="wheel-hub-target">
                  <kbd>T</kbd> Speed: <b>{speedProfile.label}</b>
                </span>
                <button
                  type="button"
                  className="wheel-begin-btn"
                  disabled={!canAfford}
                  onClick={() => beginRitualMode(spell)}
                >
                  Begin Ritual <kbd>B1</kbd>
                </button>
              </div>
            </div>

            {bannerNotice && (
              <div className="wheel-notice" role="status">
                {bannerNotice}
              </div>
            )}

            <footer className="wheel-prompts">
              <span>
                <kbd>Dial</kbd> Choose
              </span>
              <span>
                <kbd>B1</kbd> Open Ritual
              </span>
              <span>
                <kbd>T</kbd> Speed · <kbd>Hold B2</kbd> Rest (+4 MP)
              </span>
              <span>
                <kbd>Shake</kbd> / <kbd>T</kbd> Parry Ring
              </span>
              {profile && <small className="wheel-glove">{profile.label}</small>}
            </footer>
          </section>

          {/* ON-SCREEN RITUAL COMMAND STAGE */}
          {ritual && (
            <section className="ritual-stage-overlay" role="region" aria-label="Spell ritual commands">
              <header className="ritual-stage-header">
                <div>
                  <span className="ritual-stage-element">
                    {ELEMENT_CREST[element]} {element.toUpperCase()} · {speedProfile.label.toUpperCase()} WEAVE (×{speedProfile.damageBonus} DMG)
                  </span>
                  <h3 className="ritual-stage-title">
                    {spell.name} <small>({spell.cost} MP → {spell.target === 'self' ? 'Self' : foeName || 'Rival'})</small>
                  </h3>
                </div>
                {ritual.lastFeedback && <span className="ritual-last-grade">{ritual.lastFeedback}</span>}
                <button type="button" className="ritual-cancel-btn" onClick={() => cancelRitual('Ritual cancelled.')}>
                  Wheel
                </button>
              </header>

              <ol className="ritual-command-cards" aria-label="Required movements and inputs">
                {spell.ritual.map((step, idx) => {
                  const done = idx < ritual.steps.length;
                  const current = idx === ritual.steps.length;
                  const grade = ritual.grades[idx];
                  const info = RITUAL_LABELS[step];
                  return (
                    <li
                      key={idx}
                      className="ritual-command-card"
                      data-state={done ? 'done' : current ? 'current' : 'upcoming'}
                      data-kind={info.kind}
                      data-grade={grade}
                    >
                      <span className="ritual-card-step">
                        #{idx + 1} · {info.kind === 'pose' ? 'POSE' : 'GLOVE'}
                      </span>
                      <div className="ritual-kbd-row">
                        <kbd className="ritual-main-kbd">{info.short}</kbd>
                      </div>
                      <strong className="ritual-card-action">{info.label}</strong>
                      <span className="ritual-card-sub">
                        {done
                          ? grade === 'perfect'
                            ? '★ ×1.45'
                            : grade === 'good'
                              ? '✓ ×1.15'
                              : '×0.75'
                          : current
                            ? 'DO NOW'
                            : 'NEXT'}
                      </span>
                    </li>
                  );
                })}
              </ol>

              {currentStepInfo && (
                <div className="ritual-timing-box" data-sweet={inSweetSpot}>
                  <div className="ritual-timing-instructions">
                    <span>
                      Hit <kbd>{currentStepInfo.short}</kbd> in <b>★ PERFECT</b> ({speedProfile.label})
                    </span>
                    <span className="ritual-step-clock">
                      <b>{stepRemainingSec}s</b>
                    </span>
                  </div>
                  <div
                    className="ritual-timing-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(stepProgress * 100)}
                  >
                    <div className="ritual-zone early">×0.75</div>
                    <div className="ritual-zone good-left">×1.15</div>
                    <div className="ritual-zone perfect">★ PERFECT ×1.45</div>
                    <div className="ritual-zone good-right">×1.15</div>
                    <div className="ritual-zone late">×0.75</div>
                    <div className="ritual-timing-cursor" style={{ left: `${stepProgress * 100}%` }} />
                  </div>
                </div>
              )}
            </section>
          )}
        </aside>
      )}

      {/* Bottom Player Status Panel */}
      <section className="player-status-panel" aria-label="Player status">
        <h2 className="player-nameplate">{name || 'Spellbearer'}</h2>
        <div className="player-resource-grid">
          <div className="player-resource health">
            <div className="player-resource-heading">
              <img src="/art/resources/health.png" alt="" />
              <span id="duel-health-label">Health</span>
              <span className="player-resource-numbers">
                {health}
                <small> / {maxHealth}</small>
                {shield > 0 && <small className="duel-shield-pill"> +{shield} Shield</small>}
              </span>
            </div>
            <div
              className="player-resource-track"
              role="progressbar"
              aria-labelledby="duel-health-label"
              aria-valuemin={0}
              aria-valuemax={maxHealth}
              aria-valuenow={health}
            >
              <span style={{ width: `${(health / maxHealth) * 100}%` }} />
            </div>
          </div>

          <div className="player-resource magic">
            <div className="player-resource-heading">
              <img src="/art/resources/mana.png" alt="" />
              <span id="duel-magic-label">Magic Power (Fast Regen)</span>
              <span className="player-resource-numbers">
                {magicPower}
                <small> / {maxMagicPower}</small>
              </span>
            </div>
            <div
              className="player-resource-track"
              role="progressbar"
              aria-labelledby="duel-magic-label"
              aria-valuemin={0}
              aria-valuemax={maxMagicPower}
              aria-valuenow={magicPower}
            >
              <span style={{ width: `${(magicPower / maxMagicPower) * 100}%` }} />
            </div>
          </div>

          <div className="player-stance" aria-label="Duel Pace">
            <span className="player-stance-label">Cast Speed</span>
            <strong data-stance={activeIncoming ? 'shaken' : 'balanced'}>
              {overcharged ? `${speedProfile.label} · ×1.5` : speedProfile.label}
            </strong>
            <small>
              You: {castCount} casts · Rival: {foeCastCount} casts
            </small>
          </div>
        </div>
        <footer className="player-panel-footer">
          <button
            type="button"
            className="player-rest"
            disabled={status !== 'fighting'}
            onClick={() => restDuel()}
          >
            Rest (+4 MP) <kbd className="glove-hint-badge">Hold B2</kbd>
          </button>
          <button
            type="button"
            className="diagnostic-end-turn"
            disabled={status !== 'fighting' || !activeIncoming}
            onClick={() => triggerDuelParry(950)}
          >
            Parry Next Ring <kbd className="glove-hint-badge">Shake / T</kbd>
          </button>
          <button
            type="button"
            className="diagnostic-end-turn"
            onClick={() => cycleCastSpeed()}
          >
            Speed: {speedProfile.label} <kbd className="glove-hint-badge">T</kbd>
          </button>
          <button
            type="button"
            className="diagnostic-end-turn"
            onClick={exitToTitle}
          >
            Leave to Title
          </button>
          <p role="status" aria-live="polite">
            {tracking ? 'Webcam body dodge active' : camMessage}
          </p>
        </footer>
      </section>

      {/* Matchmaking / Countdown / Victory & Defeat Overlays */}
      {status !== 'fighting' && (
        <section className="encounter-victory duel-modal-overlay" role="status">
          {status === 'seeking' && (
            <>
              <p>Duel (PvP)</p>
              <h2>Waiting in the clearing…</h2>
              <span>
                Open <b>Duel (PvP)</b> on the second laptop connected to the glove hub—or duel the AI Rival Spellbearer right now.
              </span>
              <div className="duel-speed-selector modal-speed" role="group" aria-label="Select cast speed">
                <span>Cast Speed:</span>
                {([1, 2, 3] as const).map((tier: CastSpeedTier) => (
                  <button
                    key={tier}
                    type="button"
                    className="duel-speed-btn"
                    data-active={castSpeed === tier}
                    onClick={() => setCastSpeed(tier)}
                  >
                    {CAST_SPEED_PROFILES[tier].label}
                  </button>
                ))}
              </div>
              <div className="duel-modal-actions">
                <button type="button" autoFocus onClick={startPracticeDuel}>
                  Duel AI Rival Now <kbd className="glove-key">B1</kbd>
                </button>
                <button type="button" onClick={exitToTitle}>
                  Leave to Title
                </button>
              </div>
            </>
          )}
          {status === 'unavailable' && (
            <>
              <p>Duel (PvP)</p>
              <h2>Glove Hub Offline</h2>
              <span>
                Start <code>pnpm --dir firmware hub</code> for two-screen PvP, or race the AI Rival Spellbearer on this screen.
              </span>
              <div className="duel-modal-actions">
                <button type="button" autoFocus onClick={startPracticeDuel}>
                  Duel AI Rival Now <kbd className="glove-key">B1</kbd>
                </button>
                <button type="button" onClick={exitToTitle}>
                  Leave to Title
                </button>
              </div>
            </>
          )}
          {status === 'paired' && (
            <>
              <p>Rival Found</p>
              <h2>{foeName} stands across the clearing</h2>
              <span>{readyMine ? 'Waiting for your rival to calibrate…' : camMessage}</span>
              <div className="duel-modal-actions">
                {!readyMine && (
                  <button type="button" autoFocus onClick={markReady}>
                    Start Duel Now <kbd className="glove-key">B1</kbd>
                  </button>
                )}
                <button type="button" onClick={exitToTitle}>
                  Leave to Title
                </button>
              </div>
            </>
          )}
          {status === 'countdown' && (
            <>
              <p>Speed Spellcasting Contest ({speedProfile.label})</p>
              <h2 className="duel-countdown-number">{count}</h2>
              <span>Weave spells faster than {foeName} — and dodge or parry their staggered Osu! circles!</span>
              <div className="duel-modal-actions">
                <button type="button" onClick={exitToTitle}>
                  Leave to Title
                </button>
              </div>
            </>
          )}
          {status === 'over' && (
            <>
              <p>{winner === 'me' ? 'Duel Won' : 'Duel Lost'}</p>
              <h2>{winner === 'me' ? 'The clearing is yours' : 'Your rival prevailed'}</h2>
              <span>{message}</span>
              <div className="duel-modal-actions">
                <button type="button" autoFocus onClick={requestRematch} disabled={rematchMine}>
                  {rematchMine ? 'Waiting for rival…' : 'Rematch'} <kbd className="glove-key">B1</kbd>
                </button>
                {!practice && (
                  <button type="button" onClick={startPracticeDuel}>
                    Duel AI Rival
                  </button>
                )}
                <button type="button" onClick={exitToTitle}>
                  Leave to Title
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <button className="intro-sound" aria-pressed={muted} onClick={() => setMuted(!muted)}>
        {muted ? 'Sound off' : 'Sound on'}
      </button>
    </motion.main>
  );
}
