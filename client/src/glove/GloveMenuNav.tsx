import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dialSlot } from './gloveInput';
import { useGloveMode } from './gloveMode';
import { useGloveInput, useGloveSession } from './GloveSession';

const FOCUS_ATTR = 'data-glove-focus';
/** Buttons the glove never lands on: toggles and the skip shortcut stay mouse-only so they are not hit by accident. */
const IGNORED = '.intro-sound, .intro-skip, .glove-badge button, .glove-lost button';
/** What holding B2 presses: the dialogue skip and the intro skip. */
const HOLD_B2_TARGETS = '[data-glove-hold-b2], .novel-skip, .intro-skip';
const LCD_REFRESH_MS = 2600;

function scope(): ParentNode {
  return document.querySelector('dialog[open]') ?? document;
}

/** The first visible, enabled element matching the selector, looking only inside an open dialog if there is one. */
function find(selector: string): HTMLElement | null {
  return [...scope().querySelectorAll<HTMLElement>(selector)]
    .find((el) => !el.matches(':disabled') && el.getClientRects().length > 0) ?? null;
}

function candidates(): HTMLElement[] {
  return [...scope().querySelectorAll<HTMLElement>('main button:not(:disabled), dialog[open] button:not(:disabled)')]
    .filter((el) => !el.matches(IGNORED) && !el.closest('.player-status-panel') && el.getClientRects().length > 0);
}

function clearFocus(): void {
  document.querySelector(`[${FOCUS_ATTR}]`)?.removeAttribute(FOCUS_ATTR);
}

/** The visible words of a control without its keycaps and decorative glyphs. */
function labelOf(el: HTMLElement, max = 28): string {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('kbd, [aria-hidden="true"]').forEach((node) => node.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A short word for the LCD: `data-glove-b1="Stay"` wins over the button text. */
function shortLabel(el: HTMLElement, attr: string, fallback: string): string {
  return el.getAttribute(attr) || labelOf(el, 10) || fallback;
}

interface Prompt { l1: string; l2: string }

/** Two 16-character lines telling the player what the glove does on the current screen. */
function promptFor(): Prompt {
  const b1 = find('[data-glove-b1]');
  const b2 = find('[data-glove-b2]');
  const dialog = document.querySelector('dialog[open]');
  let prompt: Prompt;
  if (find('.novel-next')) prompt = { l1: 'B1: Next Line', l2: find('.novel-skip') ? 'Hold B2: Skip' : 'T: Next Line' };
  else if (find('.intro-skip')) prompt = { l1: 'Hold B2: Skip', l2: 'T: Skip Intro' };
  else if (dialog) prompt = { l1: `B1: ${b1 ? shortLabel(b1, 'data-glove-b1', 'Confirm') : 'Select'}`, l2: 'B2: Back' };
  else if (b1 && b2) prompt = { l1: `B1: ${shortLabel(b1, 'data-glove-b1', 'Yes')}`, l2: `B2: ${shortLabel(b2, 'data-glove-b2', 'No')}` };
  else prompt = { l1: 'Dial: Choose', l2: 'B1: Select' };
  return { l1: prompt.l1.slice(0, 16), l2: prompt.l2.slice(0, 16) };
}

interface Selected { label: string; host: Element }

/**
 * Lets the glove drive every ordinary screen. The dial moves a highlight over the buttons.
 * B1 or T presses the highlighted one; with nothing highlighted B1 takes the screen's `data-glove-b1`
 * shortcut (or advances dialogue) and T takes `data-glove-t`. B2 steps back or takes `data-glove-b2`,
 * and holding B2 skips dialogue.
 */
export function GloveMenuNav() {
  const { hub, glove } = useGloveSession();
  const combatControl = useGloveMode((s) => s.combatControl);
  const slot = useRef<number | null>(null);
  const b2Consumed = useRef(false);
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => () => clearFocus(), []);
  useEffect(() => { if (combatControl) { clearFocus(); setSelected(null); } }, [combatControl]);

  function reset(): void {
    clearFocus();
    slot.current = null;
    setSelected(null);
  }

  /** The highlighted control, dropping a highlight whose screen has since closed. */
  function highlight(): HTMLElement | null {
    const el = document.querySelector<HTMLElement>(`[${FOCUS_ATTR}]`);
    if (el?.isConnected && el.getClientRects().length > 0) return el;
    if (el) reset();
    return null;
  }

  function pressB1OrT(button: 'B1' | 'T'): void {
    const highlighted = highlight();
    if (highlighted) {
      // A choice that applies as soon as the dial lands on it is confirmed rather than re-pressed.
      const confirm = highlighted.hasAttribute('data-glove-pick') ? find('[data-glove-b1]') : null;
      reset();
      (confirm ?? highlighted).click();
      return;
    }
    const next = find('.novel-next');
    const direct = find('[data-glove-b1]');
    const quick = button === 'T' ? find('[data-glove-t]') : null;
    const target = button === 'T'
      ? quick ?? next ?? direct ?? candidates()[0] ?? find('.intro-skip')
      : direct ?? next ?? candidates()[0];
    target?.click();
  }

  function pressB2(): void {
    const back = document.querySelector<HTMLElement>('dialog[open] .dialog-close, dialog[open] [data-glove-back]');
    if (back) { reset(); back.click(); return; }
    if (highlight()) { reset(); return; }
    (find('[data-glove-b2]') ?? find('[data-glove-back]'))?.click();
  }

  useGloveInput((event) => {
    if (combatControl) return;
    if (event.type === 'dial') {
      const items = candidates();
      if (items.length === 0) return;
      const next = dialSlot(event.value, items.length, slot.current);
      // Click like the combat dial does, but only when the highlight actually moves.
      if (next !== slot.current && glove) hub.send(glove.id, { cmd: 'buzz', p: 'tick' });
      slot.current = next;
      clearFocus();
      const target = items[slot.current]!;
      target.setAttribute(FOCUS_ATTR, '');
      target.focus({ preventScroll: true });
      setSelected({ label: labelOf(target), host: target.closest('dialog[open]') ?? document.body });
      return;
    }
    if (event.type === 'gesture') return;
    if (event.button === 'B2') {
      // B2 acts when released so a hold can skip without also triggering the tap.
      if (event.type === 'down') b2Consumed.current = false;
      else if (event.type === 'hold') {
        const skip = find(HOLD_B2_TARGETS);
        if (skip) { b2Consumed.current = true; reset(); skip.click(); }
      } else if (event.type === 'up' && !b2Consumed.current) pressB2();
      return;
    }
    if (event.type === 'down') pressB1OrT(event.button);
  });

  // A new screen means the old highlight no longer exists; start fresh from wherever the dial sits.
  useEffect(() => {
    if (!glove) return;
    const observer = new MutationObserver(() => {
      if (!document.querySelector(`[${FOCUS_ATTR}]`)) {
        slot.current = null;
        setSelected((current) => (current ? null : current));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [glove, hub]);

  // Outside combat the glove's LCD says what B1, B2 and the dial do right now.
  const gloveId = glove?.id ?? null;
  const gloveOnline = glove?.online ?? false;
  useEffect(() => {
    if (gloveId === null || !gloveOnline || combatControl) return;
    let lastKey = '';
    let lastAt = -Infinity;
    const push = () => {
      const prompt = promptFor();
      const key = `${prompt.l1}|${prompt.l2}`;
      const now = performance.now();
      if (key === lastKey && now - lastAt < LCD_REFRESH_MS) return;
      lastKey = key;
      lastAt = now;
      hub.send(gloveId, { cmd: 'lcd', ...prompt, r: 255, g: 200, b: 90, ms: 3000 });
    };
    push();
    const timer = window.setInterval(push, 500);
    return () => window.clearInterval(timer);
  }, [gloveId, gloveOnline, combatControl, hub.send]);

  if (!selected || !selected.host.isConnected) return null;
  return createPortal(
    <div className="glove-selected" role="status">
      <span aria-hidden="true">⟳</span> Selected · Press <kbd className="glove-key">B1</kbd>
      {selected.label && <b>{selected.label}</b>}
    </div>,
    selected.host,
  );
}
