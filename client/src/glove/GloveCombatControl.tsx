import { usePause } from '../pause/pauseStore';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { useReducedMotion } from 'motion/react';
import type { BuzzPattern } from '@once-upon/shared';
import { heroStore, isHero, useLocalHero, usePlayerState } from '../combat/playerState';
import { useCoop } from '../net/coopLink';
import { useSpellBattle } from '../combat/spellBattle';
import { useWolfTutorial } from '../combat/wolfTutorial';
import { useDefense } from '../combat/defense';
import { combatants } from '../combat/encounter';
import {
  combineRitualMultiplier,
  gradeStepTiming,
  matchRitualPrefix,
  PERFECT_WINDOW_END,
  PERFECT_WINDOW_START,
  RITUAL_LABELS,
  RITUAL_STEP_DURATION_MS,
  SPELLS,
  SPELLS_BY_ELEMENT,
  type RitualStep,
  type Spell,
  type SpellElement,
  type TimingGrade,
} from '../combat/spells';
import { spellTiming } from '../combat/spellVfx';
import { dialSlot, type GloveInputEvent } from './gloveInput';
import { useGloveMode } from './gloveMode';
import { gloveProfile } from './gloveProfile';
import { readDial, useOptionalGloveSession, type GloveSession } from './GloveSession';
import './glove-combat.css';

const ELEMENTS: SpellElement[] = ['fire', 'frost', 'storm'];
const ELEMENT_RGB: Record<SpellElement, [number, number, number]> = { fire: [255, 110, 30], frost: [80, 200, 255], storm: [170, 110, 255] };
const ELEMENT_COLOR: Record<SpellElement, string> = { fire: '#ff8a3d', frost: '#7fd8ff', storm: '#c49bff' };
const ELEMENT_CREST: Record<SpellElement, string> = { fire: '🔥', frost: '❄', storm: '⚡' };
const TARGET_CLASS = 'glove-target';
/** Fire, frost, then storm: four spells each, so a wedge index / 4 is its element. */
const WHEEL = ELEMENTS.flatMap((element) => SPELLS_BY_ELEMENT[element]);
const SLOTS = WHEEL.length;
const PER_ELEMENT = SLOTS / ELEMENTS.length;
/** A swing right after the turn starts is usually the parry shake from the wolves' turn, not a cast. */
const ARM_DELAY_MS = 650;
const RESEND_DEFENSE_MS = 500;
const POSE_HOLD_FOR_STEP_MS = 140;
/** Total time allowed for the player's turn before it automatically passes. */
const TURN_DURATION_MS = 22000;

const ALL_RITUAL_STEPS: RitualStep[] = ['raise', 'duck', 'B1', 'B2', 'T', 'swing'];

/** The wolf the next cast will hit, or null when it is not your turn or the spell targets you. Read by the stage. */
export const useWheelSelection = create<{ targetId: string | null }>(() => ({ targetId: null }));

// Wheel geometry in a 360 x 360 viewBox. Wedge 0 starts at 12 o'clock and the wheel runs clockwise.
const CENTER = 180, R_IN = 106, R_OUT = 164, R_ARC_IN = 168, R_ARC_OUT = 175, WEDGE_DEG = 360 / SLOTS;
const polar = (radius: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)] as const;
};
function sector(inner: number, outer: number, from: number, to: number) {
  const [x0, y0] = polar(outer, from), [x1, y1] = polar(outer, to), [x2, y2] = polar(inner, to), [x3, y3] = polar(inner, from);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${outer} ${outer} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}A${inner} ${inner} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}Z`;
}
const wedgeStart = (index: number) => -90 + index * WEDGE_DEG;
const wedgeCenter = (index: number) => wedgeStart(index) + WEDGE_DEG / 2;

interface ActiveRitualState {
  /** Which spell is being woven (selected from wheel or narrowed by freeform inputs). */
  spellId: Spell['id'];
  /** Completed steps so far. */
  steps: RitualStep[];
  /** Timing grade earned for each completed step. */
  grades: TimingGrade[];
  /** Label of the most recent step's timing judgment. */
  lastFeedback: string | null;
  /** Timestamp (`performance.now()`) when the current step's timing bar started. */
  stepStartedAt: number;
}

/**
 * Spell casting for combat:
 * 1. Top Turn Timer bar counts down your turn and lets you Pass Turn at any time.
 * 2. Selecting a spell or starting a movement ritual HIDES the radial wheel and opens the On-Screen Ritual Stage.
 * 3. Every spell (known or unknown) requires completing its movement + glove ritual before the step timer runs out,
 *    with a Sweet-Spot timing bar that scales the spell's effectiveness (0.75x .. 1.45x).
 */
export function GloveCombatControl() {
  return <SpellWheel session={useOptionalGloveSession()} />;
}

function SpellWheel({ session }: { session: GloveSession | null }) {
  const hub = session?.hub ?? null;
  const glove = session?.glove ?? null;
  const setCombatControl = useGloveMode((s) => s.setCombatControl);
  const battle = useSpellBattle();
  const me = useLocalHero();
  const lessonOpen = useWolfTutorial((s) => s.activeStep !== null);
  const magic = usePlayerState((s) => s.magicPower);
  const maxMagic = usePlayerState((s) => s.maxMagicPower);
  const cvPose = useDefense((s) => s.pose);
  const cvEnabled = useDefense((s) => s.enabled);

  const [slot, setSlot] = useState(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const [ritual, setRitual] = useState<ActiveRitualState | null>(null);
  const [stepProgress, setStepProgress] = useState(0);
  const [turnRemainingMs, setTurnRemainingMs] = useState(TURN_DURATION_MS);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: number; mode: 'dodge' | 'parry' } | null>(null);

  const slotRef = useRef<number | null>(0);
  const ritualRef = useRef<ActiveRitualState | null>(null);
  ritualRef.current = ritual;
  const heldB2 = useRef(false);
  const armedAt = useRef(0);
  const lastDefense = useRef({ mode: '', at: 0 });
  const flashId = useRef(0);
  const pointerRotation = useRef(wedgeCenter(0));
  const turnDeadlineRef = useRef<number>(0);
  const activePoseRef = useRef<{ step: RitualStep | null; since: number; fired: boolean }>({
    step: null,
    since: 0,
    fired: false,
  });

  const live = battle.status === 'active';
  useEffect(() => {
    setCombatControl(live);
    return () => setCombatControl(false);
  }, [live, setCombatControl]);

  const wolves = combatants.filter((actor) => actor.side === 'enemy' && battle.opponents[actor.id] && !battle.opponents[actor.id]?.defeated);
  const target = wolves[targetIndex % Math.max(1, wolves.length)];
  const activeSpellId = ritual ? ritual.spellId : WHEEL[slot]!;
  const spell = SPELLS[activeSpellId];
  const isDiscovered = battle.discoveredSpells.includes(spell.id);
  const isHinted = battle.hintedSpellId === spell.id;
  const element = spell.element;
  const myTurn = live && battle.activeId === me && !battle.pending;
  const attacking = live && !!battle.enemyTurn && battle.activeId !== me;
  const boss = battle.encounterId === 'knight';

  const buzz = (p: BuzzPattern) => { if (hub && glove) hub.send(glove.id, { cmd: 'buzz', p }); };
  const buzzRef = useRef(buzz);
  buzzRef.current = buzz;

  const cancelRitual = (notice?: string) => {
    ritualRef.current = null;
    setRitual(null);
    setStepProgress(0);
    if (notice !== undefined) setBannerNotice(notice);
  };

  /** Start channeling the currently selected spell: hides the wheel and starts the Step 1 timing bar! */
  const beginRitualMode = (forSpell: Spell = SPELLS[WHEEL[slotRef.current ?? slot]!]) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active' || state.activeId !== me || state.pending) return;
    const tutStep = useWolfTutorial.getState().activeStep;
    if (tutStep && tutStep !== 'cast') return;
    if (heroStore(me).getState().magicPower < forSpell.cost) {
      buzz('fizzle');
      setBannerNotice(`Not enough MP for ${ state.discoveredSpells.includes(forSpell.id) ? forSpell.name : 'this rune' } (${forSpell.cost} MP). Rest or Pass Turn!`);
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
    useWolfTutorial.getState().notifyAction('cast');
    useWolfTutorial.getState().triggerFirstRitualTutorial();
    buzz('tick');
  };

  const moveTo = (next: number, withBuzz = false) => {
    const wrapped = ((next % SLOTS) + SLOTS) % SLOTS;
    if (wrapped !== slotRef.current) useWolfTutorial.getState().notifyAction('dial');
    if (withBuzz && wrapped !== slotRef.current) buzz('tick');
    slotRef.current = wrapped;
    setSlot(wrapped);
    setBannerNotice(null);
  };

  const executeSpellCast = (chosen: Spell, powerBoost: number, timingSummary: string) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active' || state.activeId !== me || state.pending) return false;
    const ok = state.castSpell(
      chosen.target === 'self' ? { spellId: chosen.id } : { spellId: chosen.id, targetId: target?.id },
      'glove',
      'natural',
      { autoEndTurn: true, powerBoost },
    );
    if (!ok) {
      buzz('fizzle');
      cancelRitual(useSpellBattle.getState().message);
      return false;
    }
    useWolfTutorial.getState().notifyAction('cast');
    useSpellBattle.setState((s) => ({
      message: `${s.message} · ${timingSummary}`,
    }));
    cancelRitual();
    return true;
  };

  /**
   * Feed one ritual action (from CV body pose, glove button/swing, or keyboard).
   * - Opening the ritual stage always requires pressing B1 / Enter / clicking Begin Ritual first, so passive camera movements never open it early.
   * - Once inside Ritual Mode, evaluates the step against the live Timing Bar (Early / Good / ★ Perfect / Late)
   *   and advances or completes the spell!
   */
  const pushRitualStep = (step: RitualStep, swingBoost = 1) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active' || state.activeId !== me || state.pending) return;

    const currentRitual = ritualRef.current;
    if (!currentRitual) return;

    const tutStep = useWolfTutorial.getState().activeStep;
    if (tutStep === 'ritual') {
      useWolfTutorial.getState().notifyAction('ritual');
    } else if (tutStep !== null) {
      return;
    }

    const now = performance.now();

    // Already inside the On-Screen Ritual Stage!
    const currentSpell = SPELLS[currentRitual.spellId];
    const nextSteps = [...currentRitual.steps, step];
    const elapsedStep = Math.max(0, now - currentRitual.stepStartedAt);
    const progress = Math.min(1, elapsedStep / RITUAL_STEP_DURATION_MS);
    const timing = gradeStepTiming(progress);

    // Does `nextSteps` match the current spell's ritual prefix, or pivot to another spell sharing the prefix?
    const matchesCurrent =
      nextSteps.length <= currentSpell.ritual.length &&
      nextSteps.every((s, idx) => currentSpell.ritual[idx] === s);

    const prefixMatch = matchesCurrent ? null : matchRitualPrefix(nextSteps);
    const resolvedSpell = matchesCurrent
      ? currentSpell
      : prefixMatch?.exact ?? prefixMatch?.candidates.find((c) => c.element === currentSpell.element) ?? prefixMatch?.candidates[0] ?? null;

    if (!resolvedSpell) {
      // Wrong input during timed ritual -> ritual breaks!
      buzz('fizzle');
      const expectedStep = currentSpell.ritual[currentRitual.steps.length]!;
      cancelRitual(`Ritual broken! Expected ${RITUAL_LABELS[expectedStep].label}.`);
      return;
    }

    if (heroStore(me).getState().magicPower < resolvedSpell.cost) {
      buzz('fizzle');
      cancelRitual(`Not enough Magic Power for ${resolvedSpell.name} (${resolvedSpell.cost} MP).`);
      return;
    }

    const foundIndex = WHEEL.indexOf(resolvedSpell.id);
    if (foundIndex >= 0 && foundIndex !== (slotRef.current ?? slot)) {
      slotRef.current = foundIndex;
      setSlot(foundIndex);
    }

    const nextGrades = [...currentRitual.grades, timing.grade];
    buzz('tick');

    // Did this step finish the ritual?
    if (nextSteps.length === resolvedSpell.ritual.length) {
      const { multiplier, summary } = combineRitualMultiplier(nextGrades);
      const finalPower = Math.round(multiplier * Math.max(1, swingBoost > 1 ? 1.05 : 1) * 100) / 100;
      executeSpellCast(resolvedSpell, finalPower, summary);
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
  };

  const passTurn = () => {
    const state = useSpellBattle.getState();
    if (state.status === 'active' && state.activeId === me && !state.pending) {
      cancelRitual();
      state.endTurn();
    }
  };

  const rest = () => {
    const state = useSpellBattle.getState();
    if (state.status === 'active' && state.activeId === me && !state.pending) {
      cancelRitual();
      state.rest();
    }
  };

  const cycleTarget = (withBuzz = false) => {
    setTargetIndex((index) => (index + 1) % Math.max(1, wolves.length));
    if (withBuzz) buzz('tick');
    useWolfTutorial.getState().notifyAction('target');
  };
  const nextElement = (withBuzz = false) => {
    moveTo((slotRef.current ?? slot) + PER_ELEMENT, withBuzz);
    useWolfTutorial.getState().notifyAction('element');
  };

  const defend = (mode: 'dodge' | 'parry', label: string, ms: number) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active' || !state.enemyTurn || isHero(state.activeId)) return;
    const now = Date.now();
    const held = me === 'ally' ? state.allyDefense : state.playerDefense;
    if (mode === 'parry' && held?.mode === 'dodge' && held.untilMs > now) return;
    if (lastDefense.current.mode === mode && now - lastDefense.current.at < RESEND_DEFENSE_MS) return;
    lastDefense.current = { mode, at: now };
    state.triggerDefense(mode, label, ms, me);
    if (mode === 'parry') heroStore(me).getState().setStance('guarding');
    useWolfTutorial.getState().notifyAction('parry');
    setFlash({ id: ++flashId.current, mode });
  };

  const swung = (power: number) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active') return;
    if (state.enemyTurn && state.activeId !== me) defend('parry', 'Glove Ward', 1600);
    else if (state.activeId === me && !state.pending && performance.now() >= armedAt.current) {
      pushRitualStep('swing', power);
    }
  };

  const onGlove = (event: GloveInputEvent) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active') return;
    const enemyTurn = !!state.enemyTurn && state.activeId !== me;
    const mine = state.activeId === me && !state.pending;
    if (event.type === 'gesture') swung(event.power);
    else if (event.type === 'dial' && !ritualRef.current) moveTo(dialSlot(event.value, SLOTS, slotRef.current), true);
    else if (event.type === 'down' && event.button === 'B2') {
      heldB2.current = false;
      if (enemyTurn) defend('parry', 'Glove Ward', 1600);
    } else if (event.type === 'up' && event.button === 'B2') {
      if (!heldB2.current && !enemyTurn && mine) {
        if (ritualRef.current) pushRitualStep('B2');
        else nextElement(true);
      }
    } else if (event.type === 'hold' && event.button === 'B2') {
      heldB2.current = true;
      if (mine) rest();
    } else if (event.type === 'down' && event.button === 'T') {
      if (enemyTurn) defend('parry', 'Glove Ward', 1600);
      else if (mine) {
        if (ritualRef.current) pushRitualStep('T');
        else cycleTarget(true);
      }
    }     if (event.type === 'down' && event.button === 'B1' && mine) {
      if (useWolfTutorial.getState().activeStep === 'ritual') {
        useWolfTutorial.getState().notifyAction('ritual');
        return;
      }
      if (ritualRef.current) pushRitualStep('B1');
      else beginRitualMode();
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || useSpellBattle.getState().status !== 'active') return;
    const el = event.target instanceof Element ? event.target : null;
    if (el?.closest('input, select, textarea, [contenteditable]')) return;
    const onButton = Boolean(el?.closest('button, a'));
    const state = useSpellBattle.getState();
    const enemyTurn = !!state.enemyTurn && state.activeId !== me;
    const mine = state.activeId === me && !state.pending;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (key === 'Escape' && ritualRef.current) {
      cancelRitual('Ritual cancelled.');
      event.preventDefault();
      return;
    }
    const tutStep = useWolfTutorial.getState().activeStep;
    if (tutStep === 'ritual' && (key === 'Enter' || key === ' ') && !onButton && !event.repeat) {
      useWolfTutorial.getState().notifyAction('ritual');
      event.preventDefault();
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && !ritualRef.current) {
      moveTo((slotRef.current ?? slot) + (key === 'ArrowRight' ? 1 : -1));
      event.preventDefault();
    } else if (key === 't' || (key === 'Tab' && !event.shiftKey && !onButton)) {
      if (enemyTurn) defend('parry', 'Glove Ward', 1600);
      else if (!event.repeat) cycleTarget();
      if (key === 'Tab') event.preventDefault();
    } else if (mine && !event.repeat && key === '1') {
      pushRitualStep('B1');
    } else if (mine && !event.repeat && key === '2') {
      pushRitualStep('B2');
    } else if (mine && !event.repeat && key === '3') {
      pushRitualStep('T');
    } else if (mine && !event.repeat && key === ' ' && !onButton) {
      pushRitualStep('swing', 1.25);
      event.preventDefault();
    } else if (mine && !event.repeat && key === 'w') {
      pushRitualStep('raise');
    } else if (mine && !event.repeat && key === 's') {
      pushRitualStep('duck');
    } else if (mine && !event.repeat && key === 'h') {
      const next = state.cycleHint(element);
      if (next) {
        const idx = WHEEL.indexOf(next);
        if (idx >= 0) moveTo(idx);
      }
    } else if (mine && !event.repeat && key === 'p') {
      passTurn();
    } else if (key === 'Enter' && !onButton && mine && !event.repeat) {
      if (!ritualRef.current) beginRitualMode();
      event.preventDefault();
    } else if (key === 'r' && !event.repeat) rest();
    else if (key === 'e' && !event.repeat && !enemyTurn && !ritualRef.current) nextElement();
  };

  const latest = useRef({ onGlove, onKey, defend, swung, pushRitualStep, passTurn, cancelRitual });
  latest.current = { onGlove, onKey, defend, swung, pushRitualStep, passTurn, cancelRitual };

  // Turn timer & step timing loop: updates the top turn clock and the active ritual step progress bar.
  // Pauses completely whenever any tutorial overlay (`lessonOpen`) is on screen!
  useEffect(() => {
    if (!myTurn) {
      cancelRitual();
      setTurnRemainingMs(TURN_DURATION_MS);
      return;
    }
    turnDeadlineRef.current = performance.now() + TURN_DURATION_MS;
    setTurnRemainingMs(TURN_DURATION_MS);
    let raf = 0;
    let lastTick = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastTick);
      lastTick = now;
      if (useWolfTutorial.getState().activeStep !== null) {
        // Freeze both the turn countdown and the active ritual step clock while a tutorial is open!
        turnDeadlineRef.current += dt;
        if (ritualRef.current) {
          ritualRef.current.stepStartedAt += dt;
        }
        raf = requestAnimationFrame(tick);
        return;
      }
      const rem = Math.max(0, turnDeadlineRef.current - now);
      setTurnRemainingMs(rem);
      if (rem <= 0) {
        buzzRef.current('fizzle');
        latest.current.passTurn();
        return;
      }
      const active = ritualRef.current;
      if (active) {
        const stepElapsed = now - active.stepStartedAt;
        const p = Math.min(1, Math.max(0, stepElapsed / RITUAL_STEP_DURATION_MS));
        setStepProgress(p);
        if (stepElapsed >= RITUAL_STEP_DURATION_MS) {
          buzzRef.current('fizzle');
          latest.current.cancelRitual('⏳ Step timed out! Start the ritual again.');
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTurn, battle.turnNumber]);

  // Feed CV body poses (Raise Arm / Duck) into the active spell-weaving ritual when in Ritual Mode!
  useEffect(() => {
    if (!myTurn || !ritual || lessonOpen || !cvEnabled || !cvPose || cvPose.confidence < 0.6) {
      activePoseRef.current = { step: null, since: 0, fired: false };
      return;
    }
    const detected: RitualStep | null = cvPose.isRightArmRaised
      ? 'raise'
      : cvPose.isDucking
        ? 'duck'
        : null;
    const now = performance.now();
    if (!detected) {
      activePoseRef.current = { step: null, since: 0, fired: false };
      return;
    }
    if (activePoseRef.current.step !== detected) {
      activePoseRef.current = { step: detected, since: now, fired: false };
      return;
    }
    if (!activePoseRef.current.fired && now - activePoseRef.current.since >= POSE_HOLD_FOR_STEP_MS) {
      activePoseRef.current.fired = true;
      latest.current.pushRitualStep(detected, 1.15);
    }
  }, [myTurn, ritual, lessonOpen, cvEnabled, cvPose]);

  useEffect(() => {
    if (!session || !glove) return;
    const id = glove.id;
    return session.onInput((event, gloveId) => { if (gloveId === id && !usePause.getState().open) latest.current.onGlove(event); });
  }, [session?.onInput, glove?.id]);
  useEffect(() => {
    if (!live) return;
    const handler = (event: KeyboardEvent) => latest.current.onKey(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [live]);

  useEffect(() => {
    if (!hub || !glove) return;
    const value = readDial(hub, glove.id);
    if (value !== null) moveTo(dialSlot(value, SLOTS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glove?.id, hub]);

  const previousActive = useRef(battle.activeId);
  useEffect(() => {
    const was = previousActive.current;
    previousActive.current = battle.activeId;
    if (!live || battle.activeId !== me || was === me) return;
    buzzRef.current('tick');
    const second = window.setTimeout(() => buzzRef.current('tick'), 140);
    return () => window.clearTimeout(second);
  }, [battle.activeId, live]);

  const reduced = useReducedMotion();
  const pending = battle.pending;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => buzzRef.current('cast'), spellTiming(pending.spell, !!reduced).chargeMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);
  useEffect(() => {
    if (!pending?.resolved) return;
    const hits = useSpellBattle.getState().feedback.filter((hit) => hit.castId === pending.id);
    if (hits.length && hits.every((hit) => hit.kind === 'dodge')) buzzRef.current('fizzle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, pending?.resolved]);

  const hurt = usePlayerState((s) => s.hurt);
  const seenHurt = useRef(hurt?.id);
  useEffect(() => {
    if (!hurt || hurt.id === seenHurt.current) return;
    seenHurt.current = hurt.id;
    if (hurt.kind === 'blocked') buzzRef.current('tick');
    else if (hurt.kind === 'slash' || hurt.impact === 'axe') buzzRef.current('hit');
  }, [hurt?.id]);

  const rejected = useCoop((s) => s.rejected?.id);
  useEffect(() => { if (rejected) buzzRef.current('fizzle'); }, [rejected]);

  useEffect(() => { if (myTurn) armedAt.current = performance.now() + ARM_DELAY_MS; }, [myTurn]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash((current) => (current?.id === flash.id ? null : current)), flash.mode === 'dodge' ? 1800 : 1600);
    return () => window.clearTimeout(timer);
  }, [flash?.id]);

  const targetId = myTurn && spell.target === 'enemy' && target ? target.id : null;
  useEffect(() => {
    document.querySelectorAll(`.${TARGET_CLASS}`).forEach((el) => el.classList.remove(TARGET_CLASS));
    if (targetId) document.getElementById(`opponent-${targetId}`)?.classList.add(TARGET_CLASS);
    useWheelSelection.setState({ targetId });
    return () => {
      document.querySelectorAll(`.${TARGET_CLASS}`).forEach((el) => el.classList.remove(TARGET_CLASS));
      useWheelSelection.setState({ targetId: null });
    };
  }, [targetId]);

  const lcd = useMemo(() => {
    const [r, g, b] = ELEMENT_RGB[element];
    const where = spell.target === 'self' ? 'self' : (target?.name.replace(' wolf', '').slice(0, 8) ?? '-');
    const title = isDiscovered ? spell.name : `??? (${spell.ritual[0]})`;
    return { cmd: 'lcd', l1: `${title} ${spell.cost}MP`.slice(0, 16), l2: `MP${magic}/${maxMagic} > ${where}`.slice(0, 16), r, g, b, ms: 4000 };
  }, [element, spell, isDiscovered, target, magic, maxMagic]);
  const lcdKey = JSON.stringify(lcd);
  useEffect(() => {
    if (!hub || !glove || !live) return;
    const push = () => hub.send(glove.id, lcd);
    push();
    const timer = window.setInterval(push, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glove?.id, live, lcdKey]);

  if (!live) return null;

  const wanted = wedgeCenter(slot);
  pointerRotation.current += ((wanted - pointerRotation.current + 540) % 360) - 180;
  const profile = glove ? gloveProfile(glove) : null;
  const phase = !myTurn || lessonOpen ? 'banner' : ritual ? 'ritual' : 'wheel';
  const dodging = flash?.mode === 'dodge', parrying = flash?.mode === 'parry';
  const targetLine = spell.target === 'self' ? 'Self' : (target?.name ?? 'none');
  const canAfford = magic >= spell.cost;
  const hintedSpell = battle.hintedSpellId ? SPELLS[battle.hintedSpellId] : null;
  const turnSeconds = (turnRemainingMs / 1000).toFixed(1);
  const turnFraction = Math.max(0, Math.min(1, turnRemainingMs / TURN_DURATION_MS));

  // Current ritual step details when `phase === 'ritual'`
  const currentStepIndex = ritual ? ritual.steps.length : 0;
  const currentExpectedStep = ritual ? spell.ritual[currentStepIndex] : spell.ritual[0];
  const currentStepInfo = currentExpectedStep ? RITUAL_LABELS[currentExpectedStep] : null;
  const inSweetSpot = stepProgress >= PERFECT_WINDOW_START && stepProgress <= PERFECT_WINDOW_END;
  const stepRemainingSec = (((1 - stepProgress) * RITUAL_STEP_DURATION_MS) / 1000).toFixed(1);

  return <aside className="glove-combat" data-element={element} data-phase={phase} style={{ '--el': ELEMENT_COLOR[element] } as CSSProperties} aria-label="Spell wheel">
    {/* TOP TURN TIMER BAR: counts down your turn and automatically passes when it hits 0.0s */}
    {myTurn && (
      <header className="player-turn-timer" data-urgent={turnRemainingMs < 6000} role="timer" aria-label="Turn time remaining">
        <div className="turn-timer-row">
          <span className="turn-timer-label">
            {lessonOpen ? '⏸ PAUSED · ' : '⏳ Your Turn · '}<b>{turnSeconds}s</b>
          </span>
          <span className="turn-timer-sub">
            {ritual ? `Weaving ${isDiscovered ? spell.name : 'Unknown Rune'}…` : 'Select a rune or perform a pose to begin weaving'}
          </span>
          <button type="button" className="turn-pass-btn" onClick={passTurn}>
            Pass Turn <kbd>P</kbd>
          </button>
        </div>
        <div className="turn-timer-track">
          <span className="turn-timer-fill" style={{ width: `${turnFraction * 100}%` }} />
        </div>
      </header>
    )}

    {/* RADIAL SPELL WHEEL (hidden as soon as you start casting/weaving a spell!) */}
    <section className="spell-wheel" aria-hidden={phase !== 'wheel'} aria-label="Radial spell wheel">
      <div className="spell-wheel-dial">
        <svg viewBox="0 0 360 360" role="group" aria-label="Spells">
          {ELEMENTS.map((id, index) => <path key={id} className="wheel-arc" d={sector(R_ARC_IN, R_ARC_OUT, wedgeStart(index * PER_ELEMENT) + 1.2, wedgeStart((index + 1) * PER_ELEMENT) - 1.2)}
            style={{ fill: ELEMENT_COLOR[id] }} data-active={id === element} />)}
          {WHEEL.map((id, index) => {
            const wedge = SPELLS[id], color = ELEMENT_COLOR[wedge.element], active = index === slot, affordable = magic >= wedge.cost;
            const known = battle.discoveredSpells.includes(id);
            const hinted = battle.hintedSpellId === id && !known;
            const [tx, ty] = polar(131, wedgeCenter(index)), [bx, by] = polar(169, wedgeCenter(index));
            const labelText = known ? wedge.name : hinted ? '? Hint' : '???';
            const words = labelText.split(' ');
            const lines = words.length > 1 ? [words[0]!, words.slice(1).join(' ')] : [labelText];
            return <g key={id} className="wheel-wedge" data-active={active} data-affordable={affordable} data-locked={!known} data-hinted={hinted}
              role="button" aria-label={known ? `${wedge.name}, ${wedge.cost} MP` : `Unknown ${wedge.element} spell, ${wedge.cost} MP`} aria-pressed={active}
              onClick={() => (active ? beginRitualMode(wedge) : moveTo(index))}>
              <path d={sector(R_IN, R_OUT, wedgeStart(index) + 1.4, wedgeStart(index + 1) - 1.4)} style={{ '--wedge': color } as CSSProperties} />
              <text x={tx} y={ty - (lines.length - 1) * 7} textAnchor="middle" dominantBaseline="middle">
                {lines.map((line, i) => <tspan key={i} x={tx} dy={i === 0 ? 0 : 14}>{line}</tspan>)}
              </text>
              <circle className="wheel-cost-gem" cx={bx} cy={by} r={9} />
              <text className="wheel-cost" x={bx} y={by + 0.5} textAnchor="middle" dominantBaseline="middle">{wedge.cost}</text>
            </g>;
          })}
          <polygon className="wheel-pointer" points={`${CENTER + R_IN - 1},${CENTER} ${CENTER + R_IN - 15},${CENTER - 8} ${CENTER + R_IN - 15},${CENTER + 8}`}
            style={{ transform: `rotate(${pointerRotation.current}deg)` }} />
        </svg>
        <div className="wheel-hub" role="status">
          <span className="wheel-hub-crest" aria-hidden="true">{ELEMENT_CREST[element]}</span>
          <strong className="wheel-hub-name">{isDiscovered ? spell.name : '??? · Unknown Rune'}</strong>
          <span className="wheel-hub-cost" data-affordable={canAfford}>
            {spell.cost} MP · {battle.discoveredSpells.length}/{SLOTS} known
          </span>
          <p className="wheel-hub-detail">
            {!canAfford
              ? 'Not enough Magic Power. Rest (+3 MP) or Pass Turn.'
              : isDiscovered
                ? `${spell.description} ${spell.counterHint}`
                : `Whisper: ${spell.hint}`}
          </p>
          <span className="wheel-hub-target"><kbd>T</kbd> Target: <b>{targetLine}</b></span>
          <button
            type="button"
            className="wheel-begin-btn"
            disabled={!canAfford}
            onClick={() => beginRitualMode(spell)}
          >
            {isDiscovered ? 'Begin Ritual' : 'Attempt Discovery'} <kbd>Enter</kbd>
          </button>
        </div>
      </div>

      {bannerNotice && <div className="wheel-notice" role="status">{bannerNotice}</div>}

      <footer className="wheel-prompts">
        <span><kbd>⟳ Dial</kbd> / <kbd>←</kbd><kbd>→</kbd> Choose</span>
        <span><kbd>B1</kbd> / <kbd>Enter</kbd> Open Ritual</span>
        <span><kbd>T</kbd> Target · <kbd>R</kbd> Rest (+3 MP)</span>
        {hintedSpell && !battle.discoveredSpells.includes(hintedSpell.id) && (
          <button type="button" className="ritual-hint-btn" onClick={() => {
            const next = battle.cycleHint();
            if (next) {
              const idx = WHEEL.indexOf(next);
              if (idx >= 0) moveTo(idx);
            }
          }}>
            💡 Next Hint <kbd>H</kbd>
          </button>
        )}
        {profile && <small className="wheel-glove">{profile.label}</small>}
      </footer>
    </section>

    {/* ON-SCREEN RITUAL COMMAND STAGE: hides the wheel and displays kbd combo + concise timing bar */}
    {ritual && myTurn && (
      <section className="ritual-stage-overlay" role="region" aria-label="Spell ritual commands">
        <header className="ritual-stage-header">
          <div>
            <span className="ritual-stage-element">{ELEMENT_CREST[element]} {element.toUpperCase()} MANEUVER</span>
            <h3 className="ritual-stage-title">
              {isDiscovered ? spell.name : '??? · Unknown Rune'} <small>({spell.cost} MP → {targetLine})</small>
            </h3>
          </div>
          {ritual.lastFeedback && <span className="ritual-last-grade">{ritual.lastFeedback}</span>}
          <button type="button" className="ritual-cancel-btn" onClick={() => cancelRitual('Ritual cancelled.')}>
            Wheel <kbd>Esc</kbd>
          </button>
        </header>

        {/* Sequence of required movements & glove inputs as kbd keycaps */}
        <ol className="ritual-command-cards" aria-label="Required movements and inputs">
          {spell.ritual.map((step, idx) => {
            const done = idx < ritual.steps.length;
            const current = idx === ritual.steps.length;
            const grade = ritual.grades[idx];
            const reveal = isDiscovered || isHinted || idx <= ritual.steps.length;
            const info = RITUAL_LABELS[step];
            return (
              <li
                key={idx}
                className="ritual-command-card"
                data-state={done ? 'done' : current ? 'current' : 'upcoming'}
                data-kind={info.kind}
                data-grade={grade}
              >
                <span className="ritual-card-step">#{idx + 1} · {info.kind === 'pose' ? 'POSE' : 'GLOVE'}</span>
                <div className="ritual-kbd-row">
                  <kbd className="ritual-main-kbd">{reveal ? info.short : '?'}</kbd>
                  {reveal && <kbd className="ritual-sub-kbd">{info.keyHint}</kbd>}
                </div>
                <strong className="ritual-card-action">{reveal ? info.label : '??? Hint'}</strong>
                <span className="ritual-card-sub">
                  {done
                    ? grade === 'perfect' ? '★ ×1.45' : grade === 'good' ? '✓ ×1.15' : '×0.75'
                    : current ? 'DO NOW' : 'NEXT'}
                </span>
              </li>
            );
          })}
        </ol>

        {/* Concise Timing Window Bar */}
        {currentStepInfo && (
          <div className="ritual-timing-box" data-sweet={inSweetSpot}>
            <div className="ritual-timing-instructions">
              <span>
                Hit <kbd>{isDiscovered || isHinted || currentStepIndex === 0 ? currentStepInfo.short : '?'}</kbd>{' '}
                {(isDiscovered || isHinted || currentStepIndex === 0) && <kbd>{currentStepInfo.keyHint}</kbd>} in <b>★ PERFECT</b>
              </span>
              <span className="ritual-step-clock"><b>{stepRemainingSec}s</b></span>
            </div>
            <div className="ritual-timing-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stepProgress * 100)}>
              <div className="ritual-zone early">×0.75</div>
              <div className="ritual-zone good-left">×1.15</div>
              <div className="ritual-zone perfect">★ PERFECT ×1.45</div>
              <div className="ritual-zone good-right">×1.15</div>
              <div className="ritual-zone late">×0.75</div>
              <div className="ritual-timing-cursor" style={{ left: `${stepProgress * 100}%` }} />
            </div>
            {!isDiscovered && <p className="ritual-timing-explain">Hint: <b>{spell.hint}</b></p>}
          </div>
        )}

        {/* Interactive Pose + Glove Step kbd Buttons */}
        <div className="ritual-step-buttons">
          {ALL_RITUAL_STEPS.map((step) => {
            const info = RITUAL_LABELS[step];
            const isExpected = isDiscovered && currentExpectedStep === step;
            return (
              <button
                key={step}
                type="button"
                className="ritual-step-btn"
                data-kind={info.kind}
                data-expected={isExpected}
                onClick={() => pushRitualStep(step, step === 'swing' ? 1.25 : 1)}
                title={`${info.label} (Key: ${info.keyHint})`}
              >
                <kbd>{info.short}</kbd>
                <small>{info.keyHint}</small>
              </button>
            );
          })}
        </div>
      </section>
    )}

    <section className="defense-banner" data-urgent={attacking} data-defending={dodging || parrying} aria-hidden={phase !== 'banner'} role="status">
      {dodging && <strong className="defense-flash" data-mode="dodge">⚡ DODGED!</strong>}
      {parrying && !dodging && <strong className="defense-flash" data-mode="parry">🛡 PARRYING (GLOVE WARD)!</strong>}
      {attacking
        ? <p className="defense-prompt">⚔ {boss ? 'GATEKEEPER ATTACKING!' : 'WOLF ATTACKING!'} Dodge with CV or Shake Glove / <kbd>T</kbd> / <kbd>B2</kbd> to PARRY!</p>
        : <p className="defense-prompt" data-calm="true">{battle.pending ? `✦ Casting ${battle.pending.spell.name}…` : battle.activeId === me ? 'Your turn…' : isHero(battle.activeId) ? `${battle.heroNames[battle.activeId]}’s turn…` : boss ? 'The Gatekeeper raises his axe…' : 'The wolves are moving…'}</p>}
      <small className="defense-meta">Turn {battle.turnNumber} · MP {magic}/{maxMagic} · Spells {battle.discoveredSpells.length}/{SLOTS}</small>
    </section>
  </aside>;
}
