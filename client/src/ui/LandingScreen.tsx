import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PlayerRole } from '../net/contract';
import { ParchmentPanel } from './components/ParchmentPanel';
import { TaleStage } from './components/TaleStage';
import { cx } from './cx';
import { getUiStore, useUiStore } from './storeBindings';

const DEFAULT_QUEST = 'Set up a quest for me and Dev. Make it hard.';

type RoomAction = 'create' | 'join' | 'quick';

interface FormError {
  field: 'name' | 'code' | 'form';
  message: string;
}

export function LandingScreen() {
  const storeName = useUiStore((state) => state.playerName);
  const storeRole = useUiStore((state) => state.localRole);
  const roomCode = useUiStore((state) => state.gameState?.roomCode);
  const [name, setName] = useState(storeName);
  const [role, setRole] = useState<PlayerRole>(storeRole ?? 'spellbearer');
  const [code, setCode] = useState('');
  const [quest, setQuest] = useState(DEFAULT_QUEST);
  const [busy, setBusy] = useState<RoomAction | 'quest' | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const [questNote, setQuestNote] = useState('');
  const roleTouched = useRef(false);

  useEffect(() => {
    setName((current) => (current.trim().length === 0 ? storeName : current));
  }, [storeName]);

  useEffect(() => {
    if (roleTouched.current || !storeRole) return;
    setRole(storeRole);
  }, [storeRole]);

  function chooseRole(next: PlayerRole) {
    roleTouched.current = true;
    setRole(next);
  }

  function requireName(): boolean {
    if (name.trim().length === 0) {
      setError({ field: 'name', message: 'Write your name so the tale knows who to call.' });
      return false;
    }
    setError(null);
    return true;
  }

  async function run(action: RoomAction, task: () => void | Promise<void>) {
    setBusy(action);
    try {
      await task();
    } catch {
      setError({ field: 'form', message: 'The tale could not open. Try the demo.' });
    } finally {
      setBusy(null);
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requireName()) return;
    const player = name.trim();
    void run('create', () => getUiStore().createRoom(player, role));
  }

  function onJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requireName()) return;
    if (!/^[A-Z]{4}$/.test(code)) {
      setError({ field: 'code', message: 'A room code is four letters.' });
      return;
    }
    const player = name.trim();
    void run('join', () => getUiStore().joinRoom(code, player, role));
  }

  function onQuick() {
    if (!requireName()) return;
    const player = name.trim();
    void run('quick', () => getUiStore().quickStart(player, role));
  }

  function onQuest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = quest.trim();
    if (prompt.length === 0) return;
    setBusy('quest');
    setQuestNote('');
    void (async () => {
      try {
        await getUiStore().sendQuestPrompt(prompt);
        setQuestNote('Muse has the request.');
      } catch {
        setQuestNote('Muse could not take that quest.');
      } finally {
        setBusy(null);
      }
    })();
  }

  const roomBusy = busy === 'create' || busy === 'join' || busy === 'quick';

  return (
    <TaleStage screen="landing" roomCode={roomCode}>
      <header className="ouam-hero">
        <h1 className="ouam-title">Once Upon a Memory</h1>
        <p className="ouam-subtitle">a co-op fairy-tale built from your group chat</p>
      </header>
      <div className="ouam-landing">
        <ParchmentPanel>
          <form onSubmit={onCreate}>
            <div className="ouam-field">
              <label className="ouam-label" htmlFor="player-name">
                Your name
              </label>
              <input
                id="player-name"
                className="ouam-input"
                value={name}
                maxLength={32}
                autoComplete="nickname"
                autoFocus={storeName.trim().length === 0}
                aria-required="true"
                aria-invalid={error?.field === 'name' ? true : undefined}
                aria-describedby={error ? 'landing-error' : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <fieldset className="ouam-roles">
              <legend>Who are you at this laptop?</legend>
              <RoleChoice
                value="spellbearer"
                current={role}
                title="Spellbearer"
                detail="Laptop A, wears the glove"
                onSelect={chooseRole}
              />
              <RoleChoice
                value="partner"
                current={role}
                title="Partner"
                detail="Laptop B, bare-handed"
                onSelect={chooseRole}
              />
            </fieldset>
            <button className="ouam-button ouam-button-block" type="submit" disabled={roomBusy}>
              Create Room
            </button>
          </form>
          <form onSubmit={onJoin}>
            <p className="ouam-or">or join a room</p>
            <div className="ouam-join">
              <div className="ouam-field">
                <label htmlFor="room-code">Room code</label>
                <input
                  id="room-code"
                  className="ouam-code"
                  value={code}
                  maxLength={4}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error?.field === 'code' ? true : undefined}
                  aria-describedby={error ? 'landing-error' : undefined}
                  onChange={(event) =>
                    setCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))
                  }
                />
              </div>
              <button className="ouam-button" type="submit" disabled={roomBusy}>
                Join
              </button>
            </div>
          </form>
          {error ? (
            <p id="landing-error" className="ouam-error" role="alert">
              {error.message}
            </p>
          ) : null}
        </ParchmentPanel>
        <div className="ouam-landing-side">
          <button
            className="ouam-button ouam-button-gold ouam-quick"
            type="button"
            disabled={roomBusy}
            onClick={onQuick}
          >
            Quick-Start Demo
          </button>
          <p className="ouam-quick-note">Skips setup and starts a ready tale.</p>
          <ParchmentPanel title="In-App Quest Master">
            <form onSubmit={onQuest}>
              <div className="ouam-field">
                <label htmlFor="quest-prompt">Ask Muse for a quest</label>
                <textarea
                  id="quest-prompt"
                  value={quest}
                  maxLength={400}
                  autoComplete="off"
                  onChange={(event) => setQuest(event.target.value)}
                />
              </div>
              <button
                className="ouam-button ouam-button-gold ouam-button-block"
                type="submit"
                disabled={busy !== null || quest.trim().length === 0}
              >
                Ask Muse
              </button>
              {questNote ? (
                <p className="ouam-note" role="status">
                  {questNote}
                </p>
              ) : null}
            </form>
          </ParchmentPanel>
        </div>
      </div>
    </TaleStage>
  );
}

function RoleChoice({
  value,
  current,
  title,
  detail,
  onSelect,
}: {
  value: PlayerRole;
  current: PlayerRole;
  title: string;
  detail: string;
  onSelect: (role: PlayerRole) => void;
}) {
  return (
    <label className={cx('ouam-role', current === value && 'is-selected')}>
      <input
        type="radio"
        name="player-role"
        value={value}
        checked={current === value}
        onChange={() => onSelect(value)}
      />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}
