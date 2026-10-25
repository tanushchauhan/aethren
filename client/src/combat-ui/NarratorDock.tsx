import { useEffect, useState } from 'react';
import { useGameStore } from '../net/store';
import { onNarrationActive, playNarration, stopNarration } from './audio/tts';
import styles from './combat.module.css';

export function NarratorDock() {
  const caption = useGameStore((state) => state.gameState?.narratorCaption ?? '');
  const lastNarrator = useGameStore((state) => state.lastNarrator);
  const [speaking, setSpeaking] = useState(false);

  const narratorText = lastNarrator?.text?.trim() ? lastNarrator.text : '';
  const text = narratorText || caption;
  const audioUrl = narratorText ? lastNarrator?.audioUrl : undefined;
  const useBrowserTts = narratorText ? lastNarrator?.useBrowserTts : undefined;

  useEffect(() => onNarrationActive(setSpeaking), []);

  useEffect(() => {
    const spoken = text.trim();
    if (!spoken) return;
    playNarration({ text: spoken, audioUrl, useBrowserTts });
  }, [text, caption, audioUrl, useBrowserTts]);

  useEffect(() => () => stopNarration(), []);

  return (
    <footer className={styles.caption}>
      <span className={styles.speaking} data-on={speaking ? 'true' : 'false'} aria-hidden="true" />
      <p className={styles.captionText}>{text}</p>
    </footer>
  );
}
