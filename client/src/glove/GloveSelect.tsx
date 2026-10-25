import { useEffect, useState } from 'react';
import type { GloveSummary } from '../hardware/useGloveHub';
import { useGloveSession } from './GloveSession';
import { CONTROL_LABELS, gloveProfile } from './gloveProfile';
import './glove-select.css';

type Availability = 'available' | 'yours' | 'in-use' | 'offline';

function availability(glove: GloveSummary, clientId: string | null): Availability {
  if (!glove.online) return 'offline';
  if (glove.claimedBy && glove.claimedBy === clientId) return 'yours';
  if (glove.claimedBy) return 'in-use';
  return 'available';
}

const STATUS_TEXT: Record<Availability, string> = {
  available: 'Available',
  yours: 'Yours',
  'in-use': 'In use by another player',
  offline: 'Offline',
};

/** Shown until a glove is claimed. `onBypass` is the temporary way past it without a glove (see GloveGate). */
export function GloveSelect({ lostGlove = false, onBypass }: { lostGlove?: boolean; onBypass?: () => void }) {
  const { hub, choose, onInput } = useGloveSession();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function pick(glove: GloveSummary) {
    if (busy) return;
    setBusy(true);
    const ok = await choose(glove.id);
    setBusy(false);
    setMessage(ok ? '' : `Glove ${glove.id} is not available right now.`);
  }

  // Pressing T, B1 or B2 on a free glove picks it, so the player never needs the mouse.
  useEffect(() => onInput((event, id) => {
    if (event.type !== 'down') return;
    const glove = hub.gloves.find((g) => g.id === id);
    if (glove && availability(glove, hub.clientId) === 'available') void pick(glove);
  }));

  const hubDown = hub.status !== 'open';
  const free = hub.gloves.filter((g) => availability(g, hub.clientId) === 'available').length;
  return <main className="glove-select">
    <section className="glove-panel" aria-labelledby="glove-select-title">
      <h1 id="glove-select-title">{lostGlove ? 'Your glove disconnected' : 'Choose your glove'}</h1>
      <p className="glove-lede">
        Once in a Memory is played with the enchanted glove. Pick up a glove and press
        {' '}<kbd className="glove-key">{CONTROL_LABELS.touch}</kbd>, <kbd className="glove-key">{CONTROL_LABELS.button1}</kbd> or <kbd className="glove-key">{CONTROL_LABELS.button2}</kbd> to claim it.
      </p>

      {hubDown && <p className="glove-alert" role="alert">
        Cannot reach the glove hub. Run <code>pnpm --dir firmware hub</code> and keep it open.
      </p>}

      {!hubDown && hub.gloves.length === 0 && <p className="glove-alert" role="status">
        No gloves found yet. Power a glove on and wait for it to join the hotspot.
      </p>}

      <ul className="glove-list">
        {hub.gloves.map((glove) => {
          const state = availability(glove, hub.clientId);
          const profile = gloveProfile(glove);
          const usable = state === 'available';
          return <li key={glove.id}>
            <button type="button" className="glove-card" data-state={state} disabled={!usable || busy}
              onClick={() => void pick(glove)}>
              <span className="glove-name">Glove {glove.id}</span>
              <span className="glove-kind">{profile.label}</span>
              <span className="glove-state"><i aria-hidden="true" />{STATUS_TEXT[state]}</span>
              <span className="glove-note">{profile.note}</span>
              {glove.online && <span className="glove-signal">Signal {glove.rssi} dBm</span>}
            </button>
            {usable && <button type="button" className="glove-buzz" onClick={() => hub.send(glove.id, { cmd: 'ident' })}>
              Buzz this glove
            </button>}
          </li>;
        })}
      </ul>

      {message && <p className="glove-alert" role="alert">{message}</p>}
      {!hubDown && hub.gloves.length > 0 && free === 0 && <p className="glove-hint">
        Every glove is busy or offline. Ask another player to give theirs back, or power on another glove.
      </p>}

      <footer className="glove-legend" aria-label="Glove controls">
        <span><kbd className="glove-key">{CONTROL_LABELS.touch}</kbd> touch sensor</span>
        <span><kbd className="glove-key">{CONTROL_LABELS.button1}</kbd> button 1</span>
        <span><kbd className="glove-key">{CONTROL_LABELS.button2}</kbd> button 2</span>
        <span><kbd className="glove-key">{CONTROL_LABELS.dial} ⟳</kbd> turn to choose</span>
        <span><kbd className="glove-key">Hold {CONTROL_LABELS.button2}</kbd> skip dialogue</span>
      </footer>

      {onBypass && <button type="button" className="glove-bypass" onClick={onBypass}>
        Continue without a glove <small>Temporary: play with the mouse and keyboard</small>
      </button>}
    </section>
  </main>;
}
