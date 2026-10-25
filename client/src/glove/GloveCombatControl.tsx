import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { useReducedMotion } from 'motion/react';
import type { BuzzPattern } from '@once-upon/shared';
import { playerStore, usePlayerState } from '../combat/playerState';
import { useSpellBattle } from '../combat/spellBattle';
import { useWolfTutorial } from '../combat/wolfTutorial';
import { combatants } from '../combat/encounter';
import { SPELLS, SPELLS_BY_ELEMENT, type SpellElement } from '../combat/spells';
import { spellTiming } from '../combat/spellVfx';
import { dialSlot, type GloveInputEvent } from './gloveInput';
import { useGloveMode } from './gloveMode';
import { gloveProfile } from './gloveProfile';
import { readDial, useOptionalGloveSession, type GloveSession } from './GloveSession';
import './glove-combat.css';

const ELEMENTS: SpellElement[] = ['fire', 'frost', 'storm'];
const ELEMENT_RGB: Record<SpellElement, [number, number, number]> = { fire: [255, 110, 30], frost: [80, 200, 255], storm: [170, 110, 255] };
const ELEMENT_COLOR: Record<SpellElement, string> = { fire: '#ff8a3d', frost: '#7fd8ff', storm: '#c49bff' };
const ELEMENT_CREST: Record<SpellElement, string> = { fire: '◆ Fire', frost: '❖ Frost', storm: '✦ Storm' };
const TARGET_CLASS = 'glove-target';
/** Fire, frost, then storm: four spells each, so a wedge index / 4 is its element. */
const WHEEL = ELEMENTS.flatMap((element) => SPELLS_BY_ELEMENT[element]);
const SLOTS = WHEEL.length;
const PER_ELEMENT = SLOTS / ELEMENTS.length;
/** A swing right after the turn starts is usually the parry shake from the wolves' turn, not a cast. */
const ARM_DELAY_MS = 800;
const RESEND_DEFENSE_MS = 500;

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

/**
 * Spell casting for combat: a 12-wedge radial wheel (fire, frost, storm) that shrinks to a banner on the wolves' turn.
 * The glove drives it when one is claimed; the keyboard and mouse always can. Without a glove session (`?noglove`) the wheel is still shown.
 */
export function GloveCombatControl() {
  return <SpellWheel session={useOptionalGloveSession()} />;
}

function SpellWheel({ session }: { session: GloveSession | null }) {
  const hub = session?.hub ?? null;
  const glove = session?.glove ?? null;
  const setCombatControl = useGloveMode((s) => s.setCombatControl);
  const battle = useSpellBattle();
  const magic = usePlayerState((s) => s.magicPower);
  const maxMagic = usePlayerState((s) => s.maxMagicPower);
  const [slot, setSlot] = useState(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const [flash, setFlash] = useState<{ id: number; mode: 'dodge' | 'parry' } | null>(null);
  const slotRef = useRef<number | null>(null);
  const heldB2 = useRef(false);
  const armedAt = useRef(0);
  const lastDefense = useRef({ mode: '', at: 0 });
  const flashId = useRef(0);
  const pointerRotation = useRef(wedgeCenter(0));

  const live = battle.status === 'active';
  useEffect(() => {
    setCombatControl(live);
    return () => setCombatControl(false);
  }, [live, setCombatControl]);

  const wolves = combatants.filter((actor) => actor.side === 'enemy' && battle.opponents[actor.id] && !battle.opponents[actor.id]?.defeated);
  const target = wolves[targetIndex % Math.max(1, wolves.length)];
  const spell = SPELLS[WHEEL[slot]!];
  const element = spell.element;
  const myTurn = live && battle.activeId === 'player' && !battle.pending;
  const lessonOpen = useWolfTutorial((s) => s.activeStep !== null);
  const attacking = live && !!battle.enemyTurn && battle.activeId !== 'player';
  const boss = battle.encounterId === 'knight';

  // The glove's buzzer confirms what the hand just did: a tick per selection step, a rising chirp
  // as the spell leaves the hand, a falling fizzle when a cast fails or misses, a thud when you are hit.
  const buzz = (p: BuzzPattern) => { if (hub && glove) hub.send(glove.id, { cmd: 'buzz', p }); };
  const buzzRef = useRef(buzz);
  buzzRef.current = buzz;

  const moveTo = (next: number, withBuzz = false) => {
    const wrapped = ((next % SLOTS) + SLOTS) % SLOTS;
    if (wrapped !== slotRef.current) {
      if (withBuzz) buzz('tick');
      useWolfTutorial.getState().notifyAction('dial');
    }
    slotRef.current = wrapped;
    setSlot(wrapped);
  };
  const cast = (source: 'glove' | 'diagnostic', powerBoost?: number) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active' || state.activeId !== 'player' || state.pending) return;
    const chosen = SPELLS[WHEEL[slotRef.current ?? slot]!];
    const ok = state.castSpell(
      chosen.target === 'self' ? { spellId: chosen.id } : { spellId: chosen.id, targetId: target?.id },
      source,
      'natural',
      powerBoost ? { autoEndTurn: true, powerBoost } : { autoEndTurn: true },
    );
    if (ok) useWolfTutorial.getState().notifyAction('cast');
    else if (source === 'glove') buzz('fizzle');
  };
  const rest = () => {
    const state = useSpellBattle.getState();
    if (state.status === 'active' && state.activeId === 'player' && !state.pending) state.rest();
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
  /** Dodge and parry only mean something while a wolf is attacking; a dodge is never downgraded to a parry. */
  const defend = (mode: 'dodge' | 'parry', label: string, ms: number) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active' || !state.enemyTurn || state.activeId === 'player') return;
    const now = Date.now();
    if (mode === 'parry' && state.playerDefense?.mode === 'dodge' && state.playerDefense.untilMs > now) return;
    if (lastDefense.current.mode === mode && now - lastDefense.current.at < RESEND_DEFENSE_MS) return;
    lastDefense.current = { mode, at: now };
    state.triggerDefense(mode, label, ms);
    if (mode === 'parry') playerStore.getState().setStance('guarding');
    useWolfTutorial.getState().notifyAction('parry');
    setFlash({ id: ++flashId.current, mode });
  };
  const swung = (power: number) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active') return;
    if (state.enemyTurn && state.activeId !== 'player') defend('parry', 'Glove Ward', 1600);
    else if (state.activeId === 'player' && !state.pending && performance.now() >= armedAt.current) cast('glove', power);
  };
  const onGlove = (event: GloveInputEvent) => {
    const state = useSpellBattle.getState();
    if (state.status !== 'active') return;
    const enemyTurn = !!state.enemyTurn && state.activeId !== 'player';
    const mine = state.activeId === 'player' && !state.pending;
    if (event.type === 'gesture') swung(event.power);
    else if (event.type === 'dial') moveTo(dialSlot(event.value, SLOTS, slotRef.current), true);
    else if (event.type === 'down' && event.button === 'B2') {
      heldB2.current = false;
      if (enemyTurn) defend('parry', 'Glove Ward', 1600);
    } else if (event.type === 'up' && event.button === 'B2') {
      if (!heldB2.current && !enemyTurn) nextElement(true);
    } else if (event.type === 'hold' && event.button === 'B2') {
      heldB2.current = true;
      if (mine) rest();
    } else if (event.type === 'down' && event.button === 'T') {
      if (enemyTurn) defend('parry', 'Glove Ward', 1600);
      else cycleTarget(true);
    } else if (event.type === 'down' && event.button === 'B1' && mine) cast('glove');
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || useSpellBattle.getState().status !== 'active') return;
    const el = event.target instanceof Element ? event.target : null;
    if (el?.closest('input, select, textarea, [contenteditable]')) return;
    const onButton = Boolean(el?.closest('button, a'));
    const state = useSpellBattle.getState();
    const enemyTurn = !!state.enemyTurn && state.activeId !== 'player';
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      moveTo((slotRef.current ?? slot) + (key === 'ArrowRight' ? 1 : -1));
      event.preventDefault();
    } else if (key === 't' || (key === 'Tab' && !event.shiftKey && !onButton)) {
      if (enemyTurn) defend('parry', 'Glove Ward', 1600);
      else if (!event.repeat) cycleTarget();
      if (key === 'Tab') event.preventDefault();
    } else if ((key === 'Enter' || key === ' ') && !onButton) {
      if (!event.repeat) cast('diagnostic');
      event.preventDefault();
    } else if (key === 'r' && !event.repeat) rest();
    else if (key === 'e' && !event.repeat && !enemyTurn) nextElement();
  };
  // The window and glove listeners are registered once and always call the handlers from the latest render.
  const latest = useRef({ onGlove, onKey, defend, swung });
  latest.current = { onGlove, onKey, defend, swung };

  useEffect(() => {
    if (!session || !glove) return;
    const id = glove.id;
    return session.onInput((event, gloveId) => { if (gloveId === id) latest.current.onGlove(event); });
  }, [session?.onInput, glove?.id]);
  useEffect(() => {
    if (!live) return;
    const handler = (event: KeyboardEvent) => latest.current.onKey(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [live]);

  // Start from wherever the dial already sits instead of waiting for the first turn of it.
  useEffect(() => {
    if (!hub || !glove) return;
    const value = readDial(hub, glove.id);
    if (value !== null) {
      const initial = dialSlot(value, SLOTS);
      slotRef.current = initial;
      setSlot(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glove?.id, hub]);

  // Double tick when control comes back to you after the enemies act, so a player watching the
  // glove knows it is their turn. The fight's opening turn is skipped: the encounter title covers it.
  const previousActive = useRef(battle.activeId);
  useEffect(() => {
    const was = previousActive.current;
    previousActive.current = battle.activeId;
    if (!live || battle.activeId !== 'player' || was === 'player') return;
    buzzRef.current('tick');
    const second = window.setTimeout(() => buzzRef.current('tick'), 140);
    return () => window.clearTimeout(second);
  }, [battle.activeId, live]);

  // Chirp when the charged spell is released, and fizzle if every target it reached dodged.
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

  // An enemy attack lands on you: a thud for a wound, a light tick when the Ice Shield takes it all.
  const hurt = usePlayerState((s) => s.hurt);
  const seenHurt = useRef(hurt?.id);
  useEffect(() => {
    if (!hurt || hurt.id === seenHurt.current) return;
    seenHurt.current = hurt.id;
    if (hurt.kind === 'blocked') buzzRef.current('tick');
    else if (hurt.kind === 'slash' || hurt.impact === 'axe') buzzRef.current('hit');
  }, [hurt?.id]);

  useEffect(() => { if (myTurn) armedAt.current = performance.now() + ARM_DELAY_MS; }, [myTurn]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash((current) => (current?.id === flash.id ? null : current)), flash.mode === 'dodge' ? 1800 : 1600);
    return () => window.clearTimeout(timer);
  }, [flash?.id]);

  // Ring the wolf that the next cast will hit, and tell the stage which one it is.
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

  // Mirror the selection on the glove's own screen. The v2 shows the element as a colour; the v4 has readable text.
  const lcd = useMemo(() => {
    const [r, g, b] = ELEMENT_RGB[element];
    const where = spell.target === 'self' ? 'self' : (target?.name.replace(' wolf', '').slice(0, 8) ?? '-');
    return { cmd: 'lcd', l1: `${spell.name} ${spell.cost}MP`.slice(0, 16), l2: `MP${magic}/${maxMagic} > ${where}`.slice(0, 16), r, g, b, ms: 4000 };
  }, [element, spell, target, magic, maxMagic]);
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

  // Turn the pointer the short way round so it never spins across the whole wheel.
  const wanted = wedgeCenter(slot);
  pointerRotation.current += ((wanted - pointerRotation.current + 540) % 360) - 180;
  const profile = glove ? gloveProfile(glove) : null;
  // A lesson card owns the screen while it is up; its own demo shows the controls, so the wheel stays out of its way.
  const wheelShown = myTurn && !lessonOpen;
  const dodging = flash?.mode === 'dodge', parrying = flash?.mode === 'parry';
  const targetLine = spell.target === 'self' ? 'Self' : (target?.name ?? 'none');
  const canAfford = magic >= spell.cost;

  return <aside className="glove-combat" data-element={element} data-phase={wheelShown ? 'wheel' : 'banner'} style={{ '--el': ELEMENT_COLOR[element] } as CSSProperties} aria-label="Spell wheel">
    <section className="spell-wheel" aria-hidden={!wheelShown} aria-label="Radial spell wheel">
      <div className="spell-wheel-dial">
        <svg viewBox="0 0 360 360" role="group" aria-label="Spells">
          {ELEMENTS.map((id, index) => <path key={id} className="wheel-arc" d={sector(R_ARC_IN, R_ARC_OUT, wedgeStart(index * PER_ELEMENT) + 1.2, wedgeStart((index + 1) * PER_ELEMENT) - 1.2)}
            style={{ fill: ELEMENT_COLOR[id] }} data-active={id === element} />)}
          {WHEEL.map((id, index) => {
            const wedge = SPELLS[id], color = ELEMENT_COLOR[wedge.element], active = index === slot, affordable = magic >= wedge.cost;
            const [tx, ty] = polar(131, wedgeCenter(index)), [bx, by] = polar(169, wedgeCenter(index));
            const words = wedge.name.split(' ');
            const lines = words.length > 1 ? [words[0]!, words.slice(1).join(' ')] : [wedge.name];
            return <g key={id} className="wheel-wedge" data-active={active} data-affordable={affordable} role="button" aria-label={`${wedge.name}, ${wedge.cost} MP`} aria-pressed={active}
              onClick={() => (active ? cast('diagnostic') : moveTo(index))}>
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
          <strong className="wheel-hub-name">{spell.name}</strong>
          <span className="wheel-hub-cost" data-affordable={canAfford}>{spell.cost} MP{canAfford ? '' : ' · too low'}</span>
          <p className="wheel-hub-detail">{canAfford ? spell.description : 'Not enough Magic Power. Rest to recover it.'}</p>
          <span className="wheel-hub-target"><kbd>T</kbd> Target: <b>{targetLine}</b></span>
        </div>
      </div>
      <footer className="wheel-prompts">
        <span><kbd>Dial</kbd> Spin Wheel</span>
        <span><kbd>B1</kbd> or <kbd>Swing</kbd> Cast</span>
        <span><kbd>T</kbd> Target</span>
        <span><kbd>B2</kbd> Element · <kbd>Hold B2</kbd> Rest</span>
        {!glove && <small className="wheel-keys">Keys: <kbd>←</kbd><kbd>→</kbd> spin · <kbd>Enter</kbd> cast · <kbd>T</kbd> target · <kbd>R</kbd> rest · or click a wedge</small>}
        {profile && <small className="wheel-glove">{profile.label}</small>}
      </footer>
    </section>

    <section className="defense-banner" data-urgent={attacking} data-defending={dodging || parrying} aria-hidden={wheelShown} role="status">
      {dodging && <strong className="defense-flash" data-mode="dodge">◆ DODGED!</strong>}
      {parrying && !dodging && <strong className="defense-flash" data-mode="parry">◆ PARRYING (GLOVE WARD)!</strong>}
      {attacking
        ? <p className="defense-prompt">◆ {boss ? 'GATEKEEPER ATTACKING!' : 'WOLF ATTACKING!'} Shake Glove or Press <kbd>T</kbd> / <kbd>B2</kbd> to PARRY!</p>
        : <p className="defense-prompt" data-calm="true">{battle.pending ? `✦ Casting ${battle.pending.spell.name}…` : battle.activeId === 'player' ? 'Your turn…' : boss ? 'The Gatekeeper raises his axe…' : 'The wolves are moving…'}</p>}
      <small className="defense-meta">Turn {battle.turnNumber} · MP {magic}/{maxMagic}</small>
    </section>
  </aside>;
}
