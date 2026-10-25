import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getUiStore, useUiStore } from './storeBindings';
import './title-screen.css';

type Menu = 'create' | 'join' | 'demo' | 'quest';
export function LandingScreen() {
  const nameInStore = useUiStore(s => s.playerName);
  const mock = useUiStore(s => s.mockMode);
  const connection = useUiStore(s => s.connection);
  const networkError = useUiStore(s => s.lastError);
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
    <div className="title-backdrop" aria-hidden="true" />
    <div className="title-rain" aria-hidden="true">{Array.from({ length: 44 }, (_, i) => <i key={i} style={{ left: `${(i * 37) % 103}%`, animationDelay: `${-i * .17}s`, animationDuration: `${.7 + (i % 5) * .12}s`, opacity: .08 + (i % 4) * .05 }} />)}</div>
    <section className="title-content" aria-label="Main menu">
      <h1 className="game-title"><span>Once Upon</span><strong>a Memory</strong></h1>
      <nav className="title-menu" aria-label="Choose your adventure">
        <button onClick={() => setMenu('create')}>New adventure</button>
        <button onClick={() => setMenu('join')}>Join adventure</button>
        <button onClick={() => setMenu('demo')}>Quick start</button>
        <button onClick={() => setMenu('quest')}>The oracle</button>
      </nav>
    </section>
    <footer className="title-footer"><span>A co-op spellcasting adventure</span><span>Every memory has its magic.</span></footer>
    <dialog ref={dialog} className="title-dialog" onCancel={() => setMenu(null)}>
      <button className="dialog-close" aria-label="Back to title screen" onClick={() => setMenu(null)}>×</button>
      <h2>{menu ? titles[menu] : ''}</h2>
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
