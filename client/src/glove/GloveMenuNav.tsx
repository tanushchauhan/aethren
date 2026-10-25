import { useEffect, useRef } from 'react';
import { dialSlot } from './gloveInput';
import { useGloveMode } from './gloveMode';
import { useGloveInput, useGloveSession } from './GloveSession';

const FOCUS_ATTR = 'data-glove-focus';
/** Buttons the glove never lands on: toggles and the skip shortcut stay mouse-only so they are not hit by accident. */
const IGNORED = '.intro-sound, .intro-skip, .glove-badge button, .glove-lost button';

function candidates(): HTMLElement[] {
  const scope = document.querySelector('dialog[open]') ?? document;
  return [...scope.querySelectorAll<HTMLElement>('main button:not(:disabled), dialog[open] button:not(:disabled)')]
    .filter((el) => !el.matches(IGNORED) && !el.closest('.player-status-panel') && el.getClientRects().length > 0);
}

function clearFocus(): void {
  document.querySelector(`[${FOCUS_ATTR}]`)?.removeAttribute(FOCUS_ATTR);
}

/**
 * Lets the glove drive every ordinary screen: the dial moves a highlight over the buttons,
 * T or B1 presses the highlighted one (or advances dialogue), B2 closes a dialog.
 */
export function GloveMenuNav() {
  const { hub, glove } = useGloveSession();
  const combatControl = useGloveMode((s) => s.combatControl);
  const slot = useRef<number | null>(null);

  useEffect(() => () => clearFocus(), []);
  useEffect(() => { if (combatControl) clearFocus(); }, [combatControl]);

  useGloveInput((event) => {
    if (combatControl) return;
    if (event.type === 'dial') {
      const items = candidates();
      if (items.length === 0) return;
      slot.current = dialSlot(event.value, items.length, slot.current);
      clearFocus();
      const target = items[slot.current]!;
      target.setAttribute(FOCUS_ATTR, '');
      target.focus({ preventScroll: true });
      return;
    }
    if (event.type !== 'down') return;
    if (event.button === 'B2') {
      document.querySelector<HTMLElement>('dialog[open] .dialog-close, [data-glove-back]')?.click();
      return;
    }
    const highlighted = document.querySelector<HTMLElement>(`[${FOCUS_ATTR}]`);
    if (highlighted?.isConnected) {
      highlighted.click();
      clearFocus();
      slot.current = null;
      return;
    }
    // Nothing highlighted: advance dialogue if it is showing, otherwise take the first choice.
    const next = document.querySelector<HTMLElement>('.novel-next');
    (next ?? candidates()[0])?.click();
  });

  // A new screen means the old highlight no longer exists; start fresh from wherever the dial sits.
  useEffect(() => {
    if (!glove) return;
    const observer = new MutationObserver(() => {
      if (!document.querySelector(`[${FOCUS_ATTR}]`)) slot.current = null;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [glove, hub]);
  return null;
}
