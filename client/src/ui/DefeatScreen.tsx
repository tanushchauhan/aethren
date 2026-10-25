import { useState } from 'react';
import type { PlayerRole } from '../net/contract';
import { HeartRow } from './components/HeartRow';
import { ParchmentPanel } from './components/ParchmentPanel';
import { TaleStage } from './components/TaleStage';
import { useUiStore } from './storeBindings';
import { playAgain } from './taleActions';

export function DefeatScreen() {
  const gameState = useUiStore((state) => state.gameState);
  const playerName = useUiStore((state) => state.playerName);
  const players = gameState?.players ?? [];
  const [note, setNote] = useState('');

  function onTryAgain() {
    void playAgain().catch(() => setNote('The tale could not start over.'));
  }

  return (
    <TaleStage screen="defeat" roomCode={gameState?.roomCode} caption="The wood remembers. Try again.">
      <header className="ouam-hero">
        <h1 className="ouam-title">The tale ended early.</h1>
      </header>
      <ParchmentPanel className="ouam-parchment-torn">
        <p className="ouam-ending-line">The wood remembers. Try again.</p>
        <div className="ouam-meta">
          <HeartRow filled={0} total={gameState?.maxTeamHearts || 5} emptyLabel="Shared hearts empty" />
          {gameState?.roomCode ? <p className="ouam-room-prose">Room {gameState.roomCode}.</p> : null}
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
          <button className="ouam-button ouam-button-gold" type="button" onClick={onTryAgain}>
            Try again
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

function roleLabel(_role: PlayerRole): string {
  return 'Spellbearer';
}
