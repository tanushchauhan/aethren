import { useEffect } from 'react';
import { useGameStore } from '../net/store';
import { playNarration, stopNarration } from './audio/tts';
export function Narrator() {
  const narrates = useGameStore(s => !!s.localPlayerId && s.gameState?.players[0]?.id === s.localPlayerId);
  const line = useGameStore(s => s.lastNarrator);
  const caption = useGameStore(s => s.gameState?.narratorCaption);
  useEffect(() => {
    if (!narrates) return;
    const text = caption || line?.text;
    if (text) playNarration(line?.text === text ? line : { text });
    return stopNarration;
  }, [narrates, line, caption]);
  return null;
}
