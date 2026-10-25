import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../net/store';
import { INTRO_CONTINUE_EVENT } from '../ui/taleActions';
import {
  onNarrationQueue,
  playNarration,
  skipAllNarration,
  skipNarration,
  stopNarration,
  type NarrationQueueState,
} from './audio/tts';

/**
 * Plays every narrator line to the end, in order, on the narrating laptop (the first player).
 * A Skip control moves on early. On the story intro, the tale continues once its narration
 * has finished, or when a player presses Continue.
 */
export function Narrator() {
  const narrates = useGameStore(s => !!s.localPlayerId && s.gameState?.players[0]?.id === s.localPlayerId);
  const line = useGameStore(s => s.lastNarrator);
  const caption = useGameStore(s => s.gameState?.narratorCaption);
  const phase = useGameStore(s => s.gameState?.phase);
  const [queue, setQueue] = useState<NarrationQueueState>({ playing: null, waiting: 0, paused: false });
  const lastText = useRef('');
  const introHeard = useRef(false);
  const introDone = useRef(false);

  useEffect(() => onNarrationQueue(setQueue), []);

  useEffect(() => {
    if (!narrates) stopNarration();
    return stopNarration;
  }, [narrates]);

  useEffect(() => {
    if (!narrates || !line?.text) return;
    lastText.current = line.text.trim();
    playNarration(line);
  }, [narrates, line]);

  // Captions set without a line event (mock mode, a reconnect) are narrated too.
  useEffect(() => {
    const text = caption?.trim();
    if (!narrates || !text || text === lastText.current) return;
    lastText.current = text;
    playNarration({ text });
  }, [narrates, caption]);

  // Continue on the intro page also skips the intro narration.
  useEffect(() => {
    const onContinue = () => skipAllNarration();
    window.addEventListener(INTRO_CONTINUE_EVENT, onContinue);
    return () => window.removeEventListener(INTRO_CONTINUE_EVENT, onContinue);
  }, []);

  // The intro waits for its narration: once it has played out, ask the server to go on.
  useEffect(() => {
    if (phase !== 'intro') {
      introHeard.current = false;
      introDone.current = false;
      return;
    }
    if (!narrates) return;
    if (queue.playing) introHeard.current = true;
    else if (introHeard.current && queue.waiting === 0 && !introDone.current) {
      introDone.current = true;
      useGameStore.getState().setPhase('calibrating');
    }
  }, [narrates, phase, queue]);

  if (!narrates || !queue.playing) return null;
  return (
    <div className="ouam-narration-controls" role="group" aria-label="Narration">
      <span className="ouam-narration-status">{queue.paused ? 'Narration paused' : 'Narrating'}{queue.waiting > 0 ? ` · ${queue.waiting} more` : ''}</span>
      <button type="button" className="ouam-button" onClick={skipNarration}>Skip ▸</button>
      {queue.waiting > 0 && <button type="button" className="ouam-button" onClick={skipAllNarration}>Skip all</button>}
    </div>
  );
}
