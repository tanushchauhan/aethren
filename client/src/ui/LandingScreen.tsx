import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStoryStore as useUiStore } from '../net/storyStore';
const getUiStore = useUiStore.getState;
import './title-screen.css';
import { ForestCanvas } from './ForestCanvas';

/** Preset names the glove can cycle with T, so nobody has to type to start playing. */
const NAMES = ['Spellbearer', 'Alden', 'Lyra', 'Rowan', 'Soren'] as const;
type Choice = 'solo' | 'coop';
type CoopMode = 'host' | 'join';

export function LandingScreen() {
  const nameInStore = useUiStore(s => s.playerName);
  const connection = useUiStore(s => s.connection);
  const networkError = useUiStore(s => s.lastError);
  const [highlighted, setHighlighted] = useState<Choice>('solo');
  const [open, setOpen] = useState(false);
  const [coop, setCoop] = useState<CoopMode>('host');
  const [name, setName] = useState<string>(nameInStore || NAMES[0]);
  const [code, setCode] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setError('');
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => { if (open) getUiStore().connect(); }, [open]);
  const cycleName = () => setName(current => NAMES[(NAMES.indexOf(current as typeof NAMES[number]) + 1) % NAMES.length]!);
  const startSolo = () => getUiStore().createRoom(name.trim() || NAMES[0], 'singleplayer');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const player = name.trim() || NAMES[0];
    if (coop === 'join' && !/^[A-Z]{4}$/.test(code)) { setError('Enter the four-letter room code.'); return; }
    if (connection !== 'connected') { setError('Waiting for the game server.'); return; }
    setBusy(true); setError('');
    try {
      const store = getUiStore();
      if (coop === 'host') store.createRoom(player, 'online');
      else store.joinRoom(code, player);
    } catch { setError('The path is closed for now. Please try again.'); }
    finally { setBusy(false); }
  }
  const menu = [
    { id: 'solo', label: 'New adventure', key: 'B1', glove: { 'data-glove-b1': 'Play' }, onClick: startSolo },
    { id: 'coop', label: 'Co-op / Online', key: 'B2', glove: { 'data-glove-b2': 'Co-op' }, onClick: () => setOpen(true) },
  ] as const;
  return <main className="title-screen">
    <ForestCanvas />
    <section className="title-content" aria-label="Main menu">
      <h1 className="game-title"><img src="/art/memory-logo.png" alt="Once in a Memory" /></h1>
      <nav className="title-menu" aria-label="Choose your adventure">
        {menu.map(item => (
          <button key={item.id} data-active={highlighted === item.id} {...item.glove}
            onPointerEnter={() => setHighlighted(item.id)} onFocus={() => setHighlighted(item.id)}
            onClick={() => { setHighlighted(item.id); item.onClick(); }}>
            <span className="menu-diamond" aria-hidden="true">◆</span>{item.label}
            <kbd className="glove-key">{item.key}</kbd>
            <span className="menu-flourish" aria-hidden="true">✦</span>
          </button>
        ))}
      </nav>
      <button type="button" className="title-name" data-glove-t onClick={cycleName}>
        Playing as <b>{name}</b> <kbd className="glove-key">T</kbd>
      </button>
      <p className="title-glove-hint"><kbd className="glove-key">Dial</kbd> choose <kbd className="glove-key">B1</kbd> start <kbd className="glove-key">B2</kbd> co-op <kbd className="glove-key">T</kbd> name</p>
    </section>
    <footer className="title-footer"><span>A spellcasting adventure</span><span>Every memory has its magic.</span></footer>
    <dialog ref={dialog} className="title-dialog vn-setup" aria-labelledby="setup-title" onCancel={() => setOpen(false)}>
      <button className="dialog-close" aria-label="Back to title screen" onClick={() => setOpen(false)}>×<kbd className="glove-key">B2</kbd></button>
      <span className="vn-nameplate">The storyteller</span>
      <div className="vn-setup-story">
        <h2 id="setup-title">Play with friends</h2>
        <p>{coop === 'host' ? 'Open a room and share its code.' : 'Somewhere in the wood, your friends are waiting.'}</p>
      </div>
      <form onSubmit={submit}>
        <fieldset className="adventure-modes">
          <legend>Turn the dial to choose <kbd className="glove-key">Dial</kbd></legend>
          {([['host', 'Host a room'], ['join', 'Join a room']] as const).map(([id, label]) => (
            <button key={id} type="button" className="coop-option" data-glove-pick aria-pressed={coop === id}
              onFocus={() => setCoop(id)} onClick={() => setCoop(id)}>{label}</button>
          ))}
        </fieldset>
        <button type="button" className="title-name" data-glove-t onClick={cycleName}>
          Playing as <b>{name}</b> <kbd className="glove-key">T</kbd>
        </button>
        {coop === 'join' && <label>Room code<input value={code} maxLength={4} autoCapitalize="characters" autoComplete="off" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></label>}
        {connection !== 'connected' && <div className="title-connection"><span>{connection === 'connecting' ? 'Connecting…' : 'Game server unavailable'}</span><button type="button" onClick={() => getUiStore().connect()}>Retry</button></div>}
        <button className="title-confirm" data-glove-b1="Go" disabled={busy || connection !== 'connected'}>
          {busy ? 'Summoning…' : coop === 'join' ? 'Join' : 'Open room'}<kbd className="glove-key">B1</kbd>
        </button>
        {(error || networkError) && <p className="title-error" role="status">{error || networkError}</p>}
      </form>
    </dialog>
  </main>;
}
