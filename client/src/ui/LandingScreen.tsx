import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getUiStore, useUiStore } from './storeBindings';
import './title-screen.css';
import { ForestCanvas } from './ForestCanvas';

type Menu = 'create' | 'join';
export function LandingScreen() {
  const nameInStore = useUiStore(s => s.playerName);
  const [mode, setMode] = useState<'singleplayer' | 'online'>('singleplayer');
  const connection = useUiStore(s => s.connection);
  const networkError = useUiStore(s => s.lastError);
  const [highlighted, setHighlighted] = useState<Menu>('create');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [name, setName] = useState(nameInStore);
  const [code, setCode] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setError('');
    if (menu) { dialog.current?.showModal(); getUiStore().connect(); }
    else dialog.current?.close();
  }, [menu]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError('Every spellbearer needs a name.'); return; }
    if (menu === 'join' && !/^[A-Z]{4}$/.test(code)) { setError('Enter the four-letter room code.'); return; }
    if (connection !== 'connected') { setError('Waiting for the game server.'); return; }
    setBusy(true); setError('');
    try {
      const store = getUiStore();
      if (menu === 'create') store.createRoom(name.trim(), 'spellbearer', mode);
      else if (menu === 'join') store.joinRoom(code, name.trim(), 'spellbearer');
    } catch { setError('The path is closed for now. Please try again.'); }
    finally { setBusy(false); }
  }
  const titles = { create: 'Begin your story', join: 'Find your friends' };
  return <main className="title-screen">
    <ForestCanvas />
    <section className="title-content" aria-label="Main menu">
      <h1 className="game-title"><img src="/art/memory-logo.png" alt="Once in a Memory" /></h1>
      <nav className="title-menu" aria-label="Choose your adventure">
        {([['create', 'New adventure'], ['join', 'Join adventure']] as const).map(([item, label]) => (
          <button key={item} data-active={highlighted === item}
            onPointerEnter={() => setHighlighted(item)} onFocus={() => setHighlighted(item)}
            onClick={() => { setHighlighted(item); setMenu(item); }}>
            <span className="menu-diamond" aria-hidden="true">◆</span>{label}
            <span className="menu-flourish" aria-hidden="true">✦</span>
          </button>
        ))}
      </nav>
    </section>
    <footer className="title-footer"><span>A spellcasting adventure</span><span>Every memory has its magic.</span></footer>
    <dialog ref={dialog} className="title-dialog vn-setup" aria-labelledby="setup-title" onCancel={() => setMenu(null)}>
      <button className="dialog-close" aria-label="Back to title screen" onClick={() => setMenu(null)}>×</button>
      <span className="vn-nameplate">The storyteller</span>
      <div className="vn-setup-story">
        <p className="vn-chapter">{menu === 'join' ? 'A familiar path' : 'The first page'}</p>
        <h2 id="setup-title">{menu ? titles[menu] : ''}</h2>
        <p>{menu === 'join' ? 'Somewhere in the wood, your friends are waiting. What name shall we call, and which path will lead you to them?' : 'Every tale begins with a name. Yours is about to become part of the magic.'}</p>
      </div>
      <form onSubmit={submit}>
        {menu === 'create' && <fieldset className="adventure-modes">
          <legend>Choose your adventure</legend>
          <label><input type="radio" name="mode" checked={mode === 'singleplayer'} onChange={() => setMode('singleplayer')} />Singleplayer</label>
          <label><input type="radio" name="mode" checked={mode === 'online'} onChange={() => setMode('online')} />Play online</label>
          <p>{mode === 'singleplayer' ? 'Journey with an enchanted companion.' : 'Invite a friend with your room code.'} Face the minions, then challenge the boss.</p>
        </fieldset>}
        <label>Your name<input value={name} maxLength={32} autoComplete="nickname" onChange={e => setName(e.target.value)} /></label>
        {menu === 'join' && <label>Room code<input value={code} maxLength={4} autoCapitalize="characters" autoComplete="off" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></label>}
        {connection !== 'connected' && <div className="title-connection"><span>{connection === 'connecting' ? 'Connecting…' : 'Game server unavailable'}</span><button type="button" onClick={() => getUiStore().connect()}>Retry</button></div>}
        <button className="title-confirm" disabled={busy || connection !== 'connected'}>{busy ? 'Summoning…' : menu === 'join' ? 'Join' : 'Begin adventure'}</button>
        {(error || networkError) && <p className="title-error" role="status">{error || networkError}</p>}

      </form>
    </dialog>
  </main>;
}
