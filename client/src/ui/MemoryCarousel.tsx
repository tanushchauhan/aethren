import { useEffect, useRef } from 'react';
import { useUiStore } from './storeBindings';
import { beginTale } from './taleActions';
import { TaleStage } from './components/TaleStage';
import { chooseScenarioMemories } from './scenarioMemories';

export function MemoryCarousel() {
  const game = useUiStore(s => s.gameState);
  const started = useRef(false);
  const picks = chooseScenarioMemories(game?.memoryCards ?? []);
  useEffect(() => {
    if (started.current || !picks || !game) return;
    started.current = true;
    beginTale({ selectedMemoryIds: [picks.encounter.id], bossMemoryId: picks.boss.id, roomCode: game.roomCode });
  }, [game, picks]);
  return <TaleStage screen="opening" roomCode={game?.roomCode} caption="The forest is awakening your story.">
    <header className="ouam-hero"><h1 className="ouam-title">A memory awakens</h1>
    <p className="ouam-subtitle">{picks ? 'Your story begins with minions, then a boss.' : 'Gathering the story memories…'}</p></header>
  </TaleStage>;
}
