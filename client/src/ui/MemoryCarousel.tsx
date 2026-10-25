import { useEffect, useRef, useState } from 'react';
import type { MemoryCard } from '../net/contract';
import { BossCrown, WaxSeal } from './components/WaxSeal';
import { ColorBadge } from './components/ColorBadge';
import { ParchmentPanel } from './components/ParchmentPanel';
import { TaleStage } from './components/TaleStage';
import { cx } from './cx';
import { cardsOrFixtures } from './fixtures';
import { canBeginTale, cardForColorToken } from './memoryMatch';
import { isColorToken } from './colors';
import { getUiStore, normalizeHardware, useUiStore } from './storeBindings';
import { beginTale } from './taleActions';

const HARDWARE_HINT =
  'Turn the dial to browse. Click the finger button to keep a memory. Hold a colored token in the well to choose the boss.';

const NO_SELECTION: readonly string[] = [];

export function MemoryCarousel() {
  const gameState = useUiStore((state) => state.gameState);
  const role = useUiStore((state) => state.localRole);
  const hardware = useUiStore((state) => state.hardware);
  const cards = cardsOrFixtures(gameState?.memoryCards);
  const selected = gameState?.selectedMemoryIds ?? NO_SELECTION;
  const bossId = gameState?.bossMemoryId;
  const hw = normalizeHardware(hardware);
  const [focus, setFocus] = useState(0);
  const [beginNote, setBeginNote] = useState('');
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndex = cards.length === 0 ? 0 : Math.min(focus, cards.length - 1);
  const focused = cards[focusIndex];
  const ready = canBeginTale(selected, bossId);
  const keptCount = selected.filter((id) => id !== bossId).length;

  useEffect(() => {
    if (role === 'partner') return;
    setFocus(Math.min(hw.dialSlot, Math.max(cards.length - 1, 0)));
  }, [hw.dialSlot, role, cards.length]);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    buttonRefs.current[focusIndex]?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [focusIndex]);

  const pressedNow = hw.buttonPressed === true;
  const wasPressed = useRef(pressedNow);
  useEffect(() => {
    if (pressedNow && !wasPressed.current && role !== 'partner') {
      const card = cards[focusIndex];
      if (card) getUiStore().selectCard(card.id);
    }
    wasPressed.current = pressedNow;
  }, [pressedNow, role, cards, focusIndex]);

  const tokenKey = `${hw.colorToken ?? ''}:${cards.map((card) => `${card.id}:${card.color}`).join('|')}`;
  const lastTokenKey = useRef('');
  useEffect(() => {
    if (tokenKey === lastTokenKey.current) return;
    lastTokenKey.current = tokenKey;
    if (!isColorToken(hw.colorToken) || cards.length === 0) return;
    const card = cardForColorToken(cards, hw.colorToken, selected, bossId);
    if (card) getUiStore().lockBoss(card.id);
  }, [tokenKey, hw.colorToken, cards, selected, bossId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat || cards.length === 0 || isTypingTarget(event.target)) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        setFocus((current) => Math.min(cards.length - 1, current + 1));
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        setFocus((current) => Math.max(0, current - 1));
      } else if (event.key === 'Enter') {
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        const card = cards[Math.min(focus, cards.length - 1)];
        if (card) getUiStore().selectCard(card.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards, focus]);

  function keep(card: MemoryCard) {
    setFocus(cards.findIndex((item) => item.id === card.id));
    getUiStore().selectCard(card.id);
  }

  function crown(card: MemoryCard) {
    setFocus(cards.findIndex((item) => item.id === card.id));
    getUiStore().lockBoss(card.id);
  }

  function onBegin() {
    if (!bossId || !ready) return;
    const advanced = beginTale({
      selectedMemoryIds: [...selected],
      bossMemoryId: bossId,
      roomCode: gameState?.roomCode,
    });
    if (!advanced) {
      setBeginNote('The picks are saved. The tale opens when the phase advances.');
    }
  }

  return (
    <TaleStage screen="opening" roomCode={gameState?.roomCode} caption={HARDWARE_HINT}>
      <header className="ouam-hero">
        <h1 className="ouam-title">Choose the memories</h1>
        <p className="ouam-subtitle">Keep one for the encounter. Crown another as the boss.</p>
      </header>
      {role === 'spellbearer' ? (
        <p className="ouam-hw" aria-live="polite">
          Dial slot {hw.dialSlot + 1}. {hw.colorToken ? `Token: ${hw.colorToken}.` : 'No token in the well.'}{' '}
          {hw.armed ? 'Glove armed.' : 'Glove is quiet.'}
        </p>
      ) : (
        <p className="ouam-hint">On this laptop: arrow keys browse, Enter keeps the focused memory.</p>
      )}
      <p className="ouam-sr" aria-live="polite">
        {focused ? `Focused memory: ${focused.quote}` : 'No memories yet.'}
      </p>
      <ul className="ouam-carousel" aria-label="Memory cards">
        {cards.map((card, index) => {
          const kept = selected.includes(card.id);
          const boss = card.id === bossId;
          return (
            <li key={card.id} className={cx(index === focusIndex && 'is-focused')}>
              <button
                ref={(node) => {
                  buttonRefs.current[index] = node;
                }}
                id={`memory-card-${card.id}`}
                type="button"
                className={cx('ouam-card', kept && 'is-kept', boss && 'is-boss')}
                aria-current={index === focusIndex ? 'true' : undefined}
                aria-pressed={kept}
                onClick={() => keep(card)}
              >
                {boss ? <BossCrown /> : null}
                {kept ? <WaxSeal /> : null}
                <span className="ouam-card-quote">{card.quote}</span>
                <span className="ouam-card-meta">
                  <span>{card.date}</span>
                  <span>{card.people.length > 0 ? card.people.join(', ') : 'the group'}</span>
                  <span>Mood · {card.mood}</span>
                </span>
                <ColorBadge color={card.color} />
              </button>
            </li>
          );
        })}
      </ul>
      <ParchmentPanel>
        <p className="ouam-browsing">
          Browsing {cards.length === 0 ? 0 : focusIndex + 1} of {cards.length}
          <span> · Kept {keptCount}</span>
          <span> · {bossId ? 'Boss crowned' : 'No boss yet'}</span>
        </p>
        <p role="status">
          {ready
            ? 'One memory is kept, and a boss is crowned.'
            : 'Keep one memory for the encounter, and crown a different memory as the boss.'}
        </p>
        <div className="ouam-actions">
          <button
            className="ouam-button"
            type="button"
            disabled={!focused}
            onClick={() => {
              if (focused) keep(focused);
            }}
          >
            Keep this memory
          </button>
          <button
            className="ouam-button"
            type="button"
            disabled={!focused}
            onClick={() => {
              if (focused) crown(focused);
            }}
          >
            {focused && focused.id === bossId ? 'Crowned' : 'Crown as the boss'}
          </button>
          {ready ? (
            <button className="ouam-button ouam-button-gold ouam-begin" type="button" onClick={onBegin}>
              Begin the tale
            </button>
          ) : null}
        </div>
        {beginNote ? (
          <p className="ouam-note" role="status">
            {beginNote}
          </p>
        ) : null}
      </ParchmentPanel>
    </TaleStage>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
