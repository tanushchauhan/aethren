import { useState } from 'react';
import { ELEMENTS_P0 } from '../net/contract';
import { ColorBadge } from './components/ColorBadge';
import { TaleArt } from './components/TaleArt';
import { TaleStage } from './components/TaleStage';
import { cx } from './cx';
import { MOCK_WORLD } from './fixtures';
import { useUiStore } from './storeBindings';
import { continueIntro } from './taleActions';

export function StorybookIntro() {
  const gameState = useUiStore((state) => state.gameState);
  const phase = gameState?.phase === 'generating' ? 'generating' : 'intro';
  const waiting = phase === 'generating';
  const world = gameState?.world ?? (waiting ? undefined : MOCK_WORLD);
  const [note, setNote] = useState('');
  const narrator = gameState?.narratorCaption?.trim() ?? '';
  const caption = narrator || (waiting ? 'Muse is illuminating the tale.' : 'Listen. The tale is opening.');

  function onContinue() {
    const moved = continueIntro();
    if (!moved) setNote('The wood opens when the tale advances.');
  }

  return (
    <TaleStage
      screen={waiting ? 'generating' : 'intro'}
      roomCode={gameState?.roomCode}
      caption={caption}
    >
      <article className={cx('ouam-book', waiting && 'is-inking')} aria-labelledby="tale-title">
        <div className="ouam-book-cover">
          <TaleArt
            src={world?.coverArtUrl}
            alt={world ? `Cover illustration for ${world.title}` : 'A storybook waiting for its cover'}
            variant="cover"
          />
        </div>
        <div className="ouam-book-page">
          {world ? (
            <>
              <p className="ouam-eyebrow">{waiting ? 'Illuminating' : 'The tale opens'}</p>
              <h1 id="tale-title" className="ouam-book-title">
                {world.title}
              </h1>
              <p className="ouam-intro">{world.intro}</p>
              <h2 className="ouam-panel-title">Magic words from your chat</h2>
              <ul className="ouam-spells">
                {ELEMENTS_P0.map((element) => {
                  const phrase = world.incantations[element];
                  if (!phrase) return null;
                  return (
                    <li key={element}>
                      <ColorBadge color={element} />
                      <span className="ouam-spell-phrase">{phrase}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <p className="ouam-eyebrow">Illuminating</p>
              <h1 id="tale-title" className="ouam-book-title">
                The tale is being written
              </h1>
              <p className="ouam-intro">Muse is binding your memories into a wood, a monster, and a boss.</p>
            </>
          )}
          <div className="ouam-actions">
            <button className="ouam-button ouam-button-gold" type="button" disabled={waiting} onClick={onContinue}>
              {waiting ? 'The ink is still wet' : 'Continue'}
            </button>
          </div>
          {note ? (
            <p className="ouam-note" role="status">
              {note}
            </p>
          ) : null}
        </div>
      </article>
    </TaleStage>
  );
}
