import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import type { BuzzPattern } from '@once-upon/shared';
import { usePlayerState } from '../combat/playerState';
import { useSpellBattle } from '../combat/spellBattle';
import { combatants } from '../combat/encounter';
import { SPELLS, SPELLS_BY_ELEMENT, type SpellElement } from '../combat/spells';
import { spellTiming } from '../combat/spellVfx';
import { dialSlot } from './gloveInput';
import { useGloveMode } from './gloveMode';
import { gloveProfile } from './gloveProfile';
import { readDial, useGloveInput, useGloveSession, useOptionalGloveSession } from './GloveSession';
import './glove-combat.css';

const ELEMENTS: SpellElement[] = ['fire', 'frost', 'storm'];
const ELEMENT_RGB: Record<SpellElement, [number, number, number]> = { fire: [255, 110, 30], frost: [80, 200, 255], storm: [170, 110, 255] };
const TARGET_CLASS = 'glove-target';

/**
 * Casting on the glove. Dial picks one of the element's four spells, B2 changes element,
 * T chooses the target wolf, B1 casts, and holding B2 rests. Renders the selection and
 * mirrors it on the glove's own screen.
 */
export function GloveCombatControl() {
  return useOptionalGloveSession() ? <ActiveGloveCombatControl /> : null;
}

function ActiveGloveCombatControl() {
  const { hub, glove } = useGloveSession();
  const setCombatControl = useGloveMode((s) => s.setCombatControl);
  const battle = useSpellBattle();
  const magic = usePlayerState((s) => s.magicPower);
  const maxMagic = usePlayerState((s) => s.maxMagicPower);
  const [element, setElement] = useState<SpellElement>('fire');
  const [slot, setSlot] = useState(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const slotRef = useRef<number | null>(null);
  const heldB2 = useRef(false);

  const live = battle.status === 'active';
  useEffect(() => {
    setCombatControl(live);
    return () => setCombatControl(false);
  }, [live, setCombatControl]);

  const wolves = combatants.filter((actor) => actor.side === 'enemy' && !battle.opponents[actor.id]?.defeated);
  const target = wolves[targetIndex % Math.max(1, wolves.length)];
  const spell = SPELLS[SPELLS_BY_ELEMENT[element][slot]!];
  const myTurn = live && battle.activeId === 'player' && !battle.pending;

  // Start from wherever the dial already sits instead of waiting for the first turn of it.
  useEffect(() => {
    if (!glove) return;
    const value = readDial(hub, glove.id);
    if (value !== null) {
      slotRef.current = dialSlot(value, 4);
      setSlot(slotRef.current);
    }
  }, [glove, hub, element]);

  // The glove's buzzer confirms what the hand just did: a tick per selection step, a rising chirp
  // as the spell leaves the hand, a falling fizzle when a cast fails or misses, a thud when you are hit.
  const buzz = (p: BuzzPattern) => { if (glove) hub.send(glove.id, { cmd: 'buzz', p }); };
  const buzzRef = useRef(buzz);
  buzzRef.current = buzz;

  useGloveInput((event) => {
    if (!live) return;
    if (event.type === 'dial') {
      const next = dialSlot(event.value, 4, slotRef.current);
      if (next !== slotRef.current) buzz('tick');
      slotRef.current = next;
      setSlot(next);
    } else if (event.type === 'up' && event.button === 'B2' && !heldB2.current) {
      setElement((current) => ELEMENTS[(ELEMENTS.indexOf(current) + 1) % ELEMENTS.length]!);
      buzz('tick');
    } else if (event.type === 'down' && event.button === 'B2') {
      heldB2.current = false;
    } else if (event.type === 'hold' && event.button === 'B2') {
      heldB2.current = true;
      if (myTurn) useSpellBattle.getState().rest();
    } else if (event.type === 'down' && event.button === 'T') {
      setTargetIndex((index) => (index + 1) % Math.max(1, wolves.length));
      buzz('tick');
    } else if (event.type === 'down' && event.button === 'B1' && myTurn) {
      const cast = useSpellBattle.getState().castSpell(
        spell.target === 'self' ? { spellId: spell.id } : { spellId: spell.id, targetId: target?.id },
        'glove',
      );
      if (!cast) buzz('fizzle');
    }
  });

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
  // Turn-start bleed/curse ticks and the Inferno's field flames stay silent; the knight's
  // attacks are the curse hits that carry an axe impact.
  const hurt = usePlayerState((s) => s.hurt);
  const seenHurt = useRef(hurt?.id);
  useEffect(() => {
    if (!hurt || hurt.id === seenHurt.current) return;
    seenHurt.current = hurt.id;
    if (hurt.kind === 'blocked') buzzRef.current('tick');
    else if (hurt.kind === 'slash' || hurt.impact === 'axe') buzzRef.current('hit');
  }, [hurt?.id]);

  // Ring the wolf that the next cast will hit.
  useEffect(() => {
    document.querySelectorAll(`.${TARGET_CLASS}`).forEach((el) => el.classList.remove(TARGET_CLASS));
    if (myTurn && spell.target === 'enemy' && target) document.getElementById(`opponent-${target.id}`)?.classList.add(TARGET_CLASS);
    return () => document.querySelectorAll(`.${TARGET_CLASS}`).forEach((el) => el.classList.remove(TARGET_CLASS));
  }, [myTurn, spell.target, target]);

  // Mirror the selection on the glove's own screen. The v2 shows the element as a colour; the v4 has readable text.
  const lcd = useMemo(() => {
    const [r, g, b] = ELEMENT_RGB[element];
    const where = spell.target === 'self' ? 'self' : (target?.name.replace(' wolf', '').slice(0, 8) ?? '-');
    return { cmd: 'lcd', l1: `${spell.name} ${spell.cost}MP`.slice(0, 16), l2: `MP${magic}/${maxMagic} > ${where}`.slice(0, 16), r, g, b, ms: 4000 };
  }, [element, spell, target, magic, maxMagic]);
  const lcdKey = JSON.stringify(lcd);
  useEffect(() => {
    if (!glove || !live) return;
    const push = () => hub.send(glove.id, lcd);
    push();
    const timer = window.setInterval(push, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glove?.id, live, lcdKey]);

  if (!glove || !live) return null;
  const profile = gloveProfile(glove);
  return <aside className="glove-combat" data-element={element} aria-label="Glove spell selection">
    <div className="glove-combat-elements" aria-label="Element">
      {ELEMENTS.map((id) => <span key={id} data-element={id} data-active={id === element}>{id}</span>)}
    </div>
    <ol className="glove-combat-spells">
      {SPELLS_BY_ELEMENT[element].map((id, index) => <li key={id} data-active={index === slot} data-affordable={magic >= SPELLS[id].cost}>
        <strong>{SPELLS[id].name}</strong><small>{SPELLS[id].cost} MP</small>
      </li>)}
    </ol>
    <p className="glove-combat-detail" role="status">{myTurn && battle.message !== 'Choose a spell and a target.' ? battle.message : spell.description} <span className="glove-combat-target">{spell.target === 'self' ? 'Targets you.' : <>Target: <b>{target?.name ?? 'none'}</b></>}</span></p>
    <footer>
      <span><kbd>Dial</kbd> spell</span><span><kbd>B2</kbd> element</span><span><kbd>T</kbd> target</span>
      <span><kbd>B1</kbd> cast</span><span><kbd>B2</kbd> hold: rest</span>
    </footer>
    <small className="glove-combat-glove">{profile.label}</small>
  </aside>;
}
