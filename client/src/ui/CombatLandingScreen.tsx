import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getUiStore, useUiStore } from './storeBindings';
import './title-screen.css';
import { ForestCanvas } from './ForestCanvas';

type Menu = 'create' | 'join' | 'demo' | 'quest';
export function LandingScreen() {
  const nameInStore = useUiStore(s => s.playerName);
  const mock = useUiStore(s => s.mockMode);
  const connection = useUiStore(s => s.connection);
  const networkError = useUiStore(s => s.lastError);
  const [highlighted, setHighlighted] = useState<Menu>('create');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [name, setName] = useState(nameInStore);
  const [code, setCode] = useState('');
  const [quest, setQuest] = useState('Set up a quest for me and my friends.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setError('');
    if (menu) dialog.current?.showModal();
    else dialog.current?.close();
  }, [menu]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (menu !== 'quest' && !name.trim()) { setError('Every spellbearer needs a name.'); return; }
    if (menu === 'join' && !/^[A-Z]{4}$/.test(code)) { setError('Enter the four-letter room code.'); return; }
    if (menu === 'quest' && !quest.trim()) { setError('Tell the oracle what you seek.'); return; }
    setBusy(true); setError('');
    try {
      const store = getUiStore();
      if (menu === 'quest') {
        await store.sendQuestPrompt(quest.trim());
        setError(store.mockMode ? 'Demo wish saved. Play online to summon a live quest.' : 'The oracle has received your wish.');
      } else if (menu === 'create') store.createRoom(name.trim(), 'spellbearer');
      else if (menu === 'join') store.joinRoom(code, name.trim(), 'spellbearer');
      else if (menu === 'demo') { store.disconnect(); store.quickStart(name.trim(), 'spellbearer'); }
    } catch { setError('The path is closed for now. Please try again.'); }
    finally { setBusy(false); }
  }
  const titles = { create: 'Begin your story', join: 'Find your friends', demo: 'Step into the tale', quest: 'Consult the oracle' };
  return <main className="title-screen">
    <ForestCanvas />
    <section className="title-content" aria-label="Main menu">
      <h1 className="game-title"><img src="/art/memory-logo.png" alt="Once in a Memory" /></h1>
      <nav className="title-menu" aria-label="Choose your adventure">
        {([['create', 'New adventure'], ['join', 'Join adventure'], ['demo', 'Quick start'], ['quest', 'The oracle']] as const).map(([item, label]) => (
          <button key={item} data-active={highlighted === item}
            onPointerEnter={() => setHighlighted(item)} onFocus={() => setHighlighted(item)}
            onClick={() => { setHighlighted(item); setMenu(item); }}>
            <span className="menu-diamond" aria-hidden="true">◆</span>{label}
            <span className="menu-flourish" aria-hidden="true">✦</span>
          </button>
        ))}
      </nav>
    </section>
    <footer className="title-footer"><span>A co-op spellcasting adventure</span><span>Every memory has its magic.</span></footer>
    <dialog ref={dialog} className="title-dialog vn-setup" aria-labelledby="setup-title" onCancel={() => setMenu(null)}>
      <button className="dialog-close" aria-label="Back to title screen" onClick={() => setMenu(null)}>×</button>
      <span className="vn-nameplate">The storyteller</span>
      <div className="vn-setup-story">
        <p className="vn-chapter">{menu === 'join' ? 'A familiar path' : menu === 'quest' ? 'A whispered wish' : 'The first page'}</p>
        <h2 id="setup-title">{menu ? titles[menu] : ''}</h2>
        <p>{menu === 'join' ? 'Somewhere in the wood, your friends are waiting. What name shall we call, and which path will lead you to them?' : menu === 'quest' ? 'The forest is listening. Tell it the adventure you hope to find.' : 'Every tale begins with a name. Yours is about to become part of the magic.'}</p>
      </div>
      <form onSubmit={submit}>
        {menu === 'quest' ? <label>What do you seek?<textarea value={quest} maxLength={400} onChange={e => setQuest(e.target.value)} /></label> : <label>Your name<input value={name} maxLength={32} autoComplete="nickname" onChange={e => setName(e.target.value)} /></label>}
        {menu === 'join' && <label>Room code<input value={code} maxLength={4} autoCapitalize="characters" autoComplete="off" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></label>}
        {menu !== 'demo' && <div className="title-connection"><span>{mock ? 'Local demo' : connection === 'connected' ? 'Online' : 'Connecting…'}</span><button type="button" onClick={() => mock ? getUiStore().connect() : getUiStore().disconnect()}>{mock ? 'Play online' : 'Use local demo'}</button></div>}
        <button className="title-confirm" disabled={busy || (menu !== 'demo' && !mock && connection !== 'connected')}>{busy ? 'Summoning…' : menu === 'join' ? 'Join' : menu === 'quest' ? 'Ask the oracle' : 'Begin'}</button>
        {(error || (menu !== 'demo' && networkError)) && <p className="title-error" role="status">{error || networkError}</p>}
      </form>
    </dialog>
  </main>;
}
