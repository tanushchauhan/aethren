import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { ColorBadge } from './components/ColorBadge';
import { ParchmentPanel } from './components/ParchmentPanel';
import { TaleStage } from './components/TaleStage';
import { cx } from './cx';
import { cardsOrFixtures } from './fixtures';
import { advancePhase } from './taleActions';
import { useUiStore } from './storeBindings';
import { uploadInstagramExport } from './uploadChat';

const MAX_BYTES = 20 * 1024 * 1024;
const EXPORT_HELP = 'Accounts Center -> Your information -> Export, JSON, messages only';
// TODO(2A): expose setPhase('opening') so a failed upload or demo memories can leave this screen.

export function ChatUploadScreen() {
  const gameState = useUiStore((state) => state.gameState);
  const mockMode = useUiStore((state) => state.mockMode);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [holdLocal, setHoldLocal] = useState(false);
  const skipped = useRef(false);

  useEffect(() => {
    if (!mockMode || skipped.current) return;
    skipped.current = true;
    const moved = advancePhase('opening');
    if (!moved) {
      setHoldLocal(true);
      setMessage('These demo memories are ready, but the tale cannot open from this screen yet.');
    }
  }, [mockMode]);

  function openDemoMemories() {
    const moved = advancePhase('opening');
    if (!moved) {
      setHoldLocal(true);
      setMessage('These demo memories are ready, but the tale cannot open from this screen yet.');
    }
  }

  async function send(file: File) {
    if (sending) return;
    if (file.size === 0) {
      setMessage('That file is empty.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setMessage('That export is larger than 20MB. Use a messages-only JSON export, or the demo memories.');
      return;
    }
    setSending(true);
    setMessage('');
    try {
      const outcome = await uploadInstagramExport(file, gameState?.roomCode);
      if (!outcome.ok && outcome.reason === 'rejected') {
        setMessage('That file is not JSON. Export the chat as JSON, or use the demo memories.');
        return;
      }
      if (!outcome.ok) {
        const moved = advancePhase('opening');
        if (!moved) {
          setHoldLocal(true);
          setMessage('The storyteller is away, so these demo memories stay on this page until the tale can open.');
        }
        return;
      }
      if (outcome.cardsApplied) {
        advancePhase('opening');
        return;
      }
      setMessage('The chat is in. The tale will open when the memories are ready.');
    } finally {
      setSending(false);
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void send(file);
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void send(file);
    event.target.value = '';
  }

  const localCards = cardsOrFixtures(gameState?.memoryCards);

  return (
    <TaleStage screen="upload" roomCode={gameState?.roomCode}>
      <header className="ouam-hero">
        <h1 className="ouam-title">Bring the chat</h1>
        <p className="ouam-subtitle">The messages become the memories.</p>
      </header>
      <ParchmentPanel>
        <label
          className={cx('ouam-dropzone', dragging && 'is-dragging')}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            className="ouam-file"
            type="file"
            accept=".json,application/json"
            aria-describedby="upload-help upload-consent"
            onChange={onFile}
          />
          <span className="ouam-drop-title">{sending ? 'Carrying the pages…' : 'Drop the Instagram export here'}</span>
          <span>or choose a .json file</span>
        </label>
        <p id="upload-help" className="ouam-help">
          {EXPORT_HELP}
        </p>
        <p id="upload-consent" className="ouam-consent">
          Only upload a chat whose members consented.
        </p>
        <div className="ouam-actions">
          <button className="ouam-button ouam-button-gold" type="button" onClick={openDemoMemories} disabled={sending}>
            Use demo memories
          </button>
        </div>
        {message ? (
          <p className="ouam-note" role="status">
            {message}
          </p>
        ) : null}
        {holdLocal ? (
          <ul className="ouam-local-cards">
            {localCards.map((card) => (
              <li key={card.id} className="ouam-local-card">
                <span>{card.quote}</span>
                <ColorBadge color={card.color} />
              </li>
            ))}
          </ul>
        ) : null}
      </ParchmentPanel>
    </TaleStage>
  );
}
