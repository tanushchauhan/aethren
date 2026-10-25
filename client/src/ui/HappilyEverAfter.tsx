import { useState } from 'react';
import type { PlayerRole } from '../net/contract';
import { HeartRow } from './components/HeartRow';
import { ParchmentPanel } from './components/ParchmentPanel';
import { TaleArt } from './components/TaleArt';
import { TaleStage } from './components/TaleStage';
import { MOCK_WORLD } from './fixtures';
import { useUiStore } from './storeBindings';
import { playAgain } from './taleActions';

export function HappilyEverAfter() {
  const gameState = useUiStore((state) => state.gameState);
  const playerName = useUiStore((state) => state.playerName);
  const world = gameState?.world ?? MOCK_WORLD;
  const ending = world.ending?.trim() || 'Happily Ever After.';
  const encounter = world.encounters[0];
  const players = gameState?.players ?? [];
  const caption = gameState?.narratorCaption?.trim() || ending;
  const [note, setNote] = useState('');

  function onPlayAgain() {
    void playAgain().catch(() => setNote('The tale could not start over.'));
  }

  return (
    <TaleStage screen="ending" roomCode={gameState?.roomCode} caption={caption}>
      <header className="ouam-hero">
        <h1 className="ouam-title">{world.title}</h1>
      </header>
      <ParchmentPanel>
        <div className="ouam-gallery">
          <figure>
            <TaleArt src={world.coverArtUrl} alt={`Cover art for ${world.title}`} variant="cover" />
            <figcaption>The wood</figcaption>
          </figure>
          <figure>
            <TaleArt
              src={encounter?.artUrl}
              alt={encounter ? `${encounter.name}, the encounter` : 'The encounter'}
              variant="monster"
            />
            <figcaption>{encounter?.name ?? 'The encounter'}</figcaption>
          </figure>
          <figure>
            <TaleArt src={world.boss.artUrl} alt={`${world.boss.name}, the boss`} variant="boss" />
            <figcaption>{world.boss.name}</figcaption>
          </figure>
        </div>
        <p className="ouam-ending-line">{ending}</p>
        <div className="ouam-meta">
          {gameState?.roomCode ? <p className="ouam-room-prose">Played in room {gameState.roomCode}.</p> : null}
          <ul className="ouam-players">
            {players.length > 0 ? (
              players.map((player) => (
                <li key={player.id}>
                  {player.name.trim() || 'Friend'}
                  <span className="ouam-role-tag">{roleLabel(player.role)}</span>
                </li>
              ))
            ) : (
              <li>{playerName.trim() || 'Friend'}</li>
            )}
          </ul>
          <HeartRow filled={gameState?.teamHearts ?? 0} total={gameState?.maxTeamHearts || 5} />
          <button className="ouam-button ouam-button-gold" type="button" onClick={onPlayAgain}>
            Play again
          </button>
          {note ? (
            <p className="ouam-note" role="status">
              {note}
            </p>
          ) : null}
        </div>
      </ParchmentPanel>
    </TaleStage>
  );
}

function roleLabel(role: PlayerRole): string {
  return role === 'spellbearer' ? 'Spellbearer' : 'Partner';
}
