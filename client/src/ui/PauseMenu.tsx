import { useEffect, useRef } from 'react';
import { useCoop } from '../net/coopLink';
import { usePause } from '../pause/pauseStore';
import { useGameMode } from '../combat/gameMode';
import { useOptionalGloveSession } from '../glove/GloveSession';
import './pause-menu.css';

/** Holding the touch sensor opens the menu from the glove. */
function GlovePauseBinding() {
  const session = useOptionalGloveSession();
  const gloveId = session?.glove?.id ?? null;
  const onInput = session?.onInput;
  useEffect(() => onInput?.((event, id) => {
    if (id === gloveId && event.type === 'hold' && event.button === 'T') usePause.getState().toggleMenu();
  }), [onInput, gloveId]);
  return null;
}

/** The settings button, and the menu it opens: pauses the game and its sound until you resume or leave. */
export function PauseMenu() {
  const { open, frozen, soundOff, openMenu, closeMenu, setSoundOff } = usePause();
  const mode = useGameMode(s => s.mode);
  const coop = useCoop(s => s.status === 'paired');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !usePause.getState().open) openMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openMenu]);
  // Leaving the game screen for any reason must not leave it frozen.
  useEffect(() => () => closeMenu(), [closeMenu]);

  return <>
    <GlovePauseBinding />
    <button type="button" className="pause-button" onClick={openMenu} aria-label="Open settings">
      Settings <kbd className="glove-key">Hold T</kbd>
    </button>
    <dialog ref={dialog} className="title-dialog pause-dialog" aria-labelledby="pause-title" onCancel={event => { event.preventDefault(); closeMenu(); }}>
      <button type="button" className="dialog-close" aria-label="Resume" onClick={closeMenu}>×</button>
      <h2 id="pause-title">{frozen ? 'Paused' : 'Settings'}</h2>
      {coop && <p className="pause-note">Your partner is still in the fight. The game keeps running for them while this menu is open.</p>}
      <div className="pause-actions">
        <button type="button" autoFocus data-glove-b1="Resume" onClick={closeMenu}>Resume <kbd className="glove-key">B2</kbd></button>
        <button type="button" aria-pressed={mode === 'fast'}
          onClick={() => useGameMode.getState().setMode(mode === 'fast' ? 'standard' : 'fast')}>
          Pace <b>{mode === 'fast' ? 'Fast' : 'Standard'}</b>
        </button>
        <button type="button" aria-pressed={soundOff} onClick={() => setSoundOff(!soundOff)}>
          Sound <b>{soundOff ? 'Off' : 'On'}</b>
        </button>
        <button type="button" className="pause-leave" onClick={() => window.location.reload()}>Leave to title</button>
      </div>
    </dialog>
  </>;
}
