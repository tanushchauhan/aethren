import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, BookOpen, Check, ChevronRight, Play, Shield, Wifi, Zap } from 'lucide-react';
import type { NarratorLine } from '@aethren/shared';
import { useSeat, type Seat } from './useSeat';
import './lab.css';

type Entry = { id: number; time: string; event: string; payload: unknown; seat?: string };
const pretty = (value: string) => value.replaceAll('_', ' ');

function Player({ seat, room, shared }: { seat: Seat; room: string; shared: Seat['state'] }) {
  const [power, setPower] = useState(1.2);
  const [armed, setArmed] = useState(true);
  const [fist, setFist] = useState(false);
  const [noise, setNoise] = useState(0);
  // A disconnected seat stops receiving state, so read its player from the other seat's live view.
  const player = (seat.connected ? seat.state : shared ?? seat.state)?.players.find((p) => p.id === seat.playerId);
  const active = seat.connected && !!seat.playerId;
  const canCast = active && seat.state?.phase === 'team_turn' && !seat.state.paused;
  const defending = ['telegraph', 'defense'].includes(seat.state?.phase ?? '');
  return <section className="panel player-panel">
    <div className="panel-heading"><div className={`avatar avatar-${seat.label.toLowerCase()}`}>{seat.label}</div><div><h2>Laptop {seat.label}</h2><span className="muted">{seat.label === 'A' ? 'Spellbearer · host' : 'Partner · second socket'}</span></div><span className={`status-dot ${seat.connected ? 'on' : ''}`} title={seat.connected ? 'Connected' : 'Disconnected'} /></div>
    <label className="field">Player name<input value={seat.name} onChange={(e) => seat.setName(e.target.value)} disabled={active} /></label>
    {!active && player?.role === 'bot' && <div className="seat-state"><span>Bot has taken over this seat</span></div>}
    {!active ? <button className="button full" disabled={!room || seat.busy} onClick={() => void seat.enter('join', room)}><Wifi size={15} />{seat.playerId ? 'Reconnect to room' : 'Join this room'}</button> : <div className="seat-state"><span>{player?.role === 'bot' ? 'Bot has taken over' : player?.canCast ? 'Ready to cast' : 'Sitting out'}</span><button className="text-button" onClick={seat.disconnect}>Disconnect</button></div>}
    <label className="toggle-row"><span>Assist this player<small>Simulated dodges and casts</small></span><input type="checkbox" checked={seat.auto} onChange={(e) => seat.setAuto(e.target.checked)} /></label>
    <div className="divider" />
    <div className="section-label">01 / BODY INPUTS <span>SIMULATED</span></div>
    <div className="button-row"><button disabled={!active} onClick={seat.calibrate}>Calibrate</button><button disabled={!active} className={seat.inZone ? 'selected' : ''} onClick={() => seat.pose(!seat.inZone)}>{seat.inZone ? 'In zone' : 'Out of zone'}</button></div>
    <div className="button-row"><button disabled={!active || !defending} onClick={() => seat.defend('dodge')}>Dodge</button><button disabled={!active || seat.telegraph?.attackType !== 'projectile'} onClick={() => seat.defend('parry')}>Parry</button><button disabled={!active || !defending} onClick={() => seat.defend('hit')}>Take hit</button></div>
    <div className="divider" />
    <div className="section-label">02 / SPELL</div>
    <div className="elements">{(['ember', 'frost', 'bloom'] as const).map((element) => <button key={element} className={`${element} ${seat.element === element ? 'active' : ''}`} onClick={() => seat.setElement(element)}>{element === 'ember' ? '✦' : element === 'frost' ? '❄' : '✿'} {element}</button>)}</div>
    <label className="range-label">Gesture power <b>{power.toFixed(1)}×</b><input type="range" min="0.5" max="1.5" step="0.1" value={power} onChange={(e) => setPower(Number(e.target.value))} /></label>
    <button className="button primary full" disabled={!canCast} onClick={() => seat.cast(power, seat.element)}><Zap size={16} />Cast {seat.element}<ArrowRight size={16} /></button>
    {seat.label === 'A' && <details><summary>Glove simulator</summary><label className="toggle-row">Armed<input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} /></label><label className="toggle-row">Fist charged<input type="checkbox" checked={fist} onChange={(e) => setFist(e.target.checked)} /></label><label className="field">Noise level<input type="number" min="0" max="1023" value={noise} onChange={(e) => setNoise(Number(e.target.value))} /></label><button disabled={!active} className="full" onClick={() => seat.glove(armed, fist, noise)}>Send glove frame</button><small className="helper">Output: {seat.hardware ? JSON.stringify(seat.hardware) : 'waiting for buzzer or servo commands'}</small></details>}
    {seat.error && <p role="alert" className="error">{seat.error}</p>}
  </section>;
}

export default function TestLab() {
  const [events, setEvents] = useState<Entry[]>([]);
  const serial = useRef(0);
  const log = useCallback((event: string, payload: unknown, seat?: string) => setEvents((current) => [{ id: ++serial.current, time: new Date().toLocaleTimeString(), event, payload, seat }, ...current].slice(0, 200)), []);
  const [line, setLine] = useState<NarratorLine | null>(null);
  const narration = useCallback((next: NarratorLine) => setLine(next), []);
  const a = useSeat('A', log, narration);
  const b = useSeat('B', log, narration);
  const state = a.state;
  const [room, setRoom] = useState(new URLSearchParams(location.search).get('room') ?? '');
  const [healthError, setHealthError] = useState('');
  const [online, setOnline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('play');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async () => {
    try { const response = await fetch('/health'); if (!response.ok) throw new Error(`HTTP ${response.status}`); setOnline(true); setHealthError(''); }
    catch (error) { setOnline(false); setHealthError(String(error)); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
  async function create() {
    b.disconnect(); a.setAuto(false); b.setAuto(false);
    const code = await a.enter('create');
    if (code) setRoom(code);
  }
  async function assisted() {
    b.disconnect();
    const code = await a.enter('create');
    if (!code) return;
    setRoom(code);
    if (!await b.enter('join', code)) return;
    a.setElement('ember'); b.setElement('ember'); a.setAuto(true); b.setAuto(true);
    a.start(); log('assisted demo', 'Both sockets use synthetic inputs. Phases, damage and the boss cycle stay authoritative server logic.');
  }
  const phase = state?.phase ?? 'lobby';
  const remaining = Math.max(0, ((state?.phaseEndsServerMs ?? now) - now - a.offset) / 1000);
  const enemy = state?.currentEncounter;
  const filtered = events.filter((entry) => `${entry.event} ${JSON.stringify(entry.payload)}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="lab">
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><BookOpen size={16} /> AETHREN <ChevronRight size={13} /><strong>Combat lab</strong></div><div className="server-badge"><span className={`status-dot ${online ? 'on' : ''}`} />{online ? 'Server online' : 'Server offline'}</div></header>
      <main>
        <div className="page-heading"><div><h1>Two laptops. One server.</h1><p>Drive a combat run with simulated players and inspect every event the engine sends.</p></div></div>
        <div className="nav-tabs"><button className={tab === 'play' ? 'active' : ''} onClick={() => setTab('play')}>Playground</button><button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events ({events.length})</button></div>
        {healthError && <div role="alert" className="notice error">Server connection failed. Start the backend on port 3001. {healthError}</div>}
        {tab === 'play' && <>
          <section className="launchbar"><div><span className="section-label">ROOM CONTROL</span><div className="room-code">{state?.roomCode ?? "----"}<span>{state ? `${state.players.length} seats` : 'No active run'}</span></div></div><div className="launch-actions"><button className="button primary" disabled={a.busy} onClick={() => void assisted()}><Play size={15} />Run assisted demo</button><button className="button" disabled={a.busy} onClick={() => void create()}>New room</button></div></section>
          <div className="play-grid"><Player seat={a} room={room} shared={b.state} />
            <div className="stage-column"><section className="stage panel">
              <div className="phase-display"><div><span className="section-label">CURRENT PHASE</span><h3>{state?.paused ? 'Paused · waiting for player' : pretty(phase)}</h3></div><div className="countdown">{state?.paused ? 'Ⅱ' : remaining.toFixed(1)}<small>sec</small></div></div>
              {enemy && <div className="resolution"><b>{enemy.name}</b> · {state?.enemyHp}/{state?.enemyMaxHp} HP{state?.wardActive && ' · Ward up'} · Hearts {state?.hearts}/{state?.maxHearts}</div>}
              {a.telegraph && ['telegraph', 'defense', 'return'].includes(phase) && <div className="attack-banner"><Shield size={20} /><div><b>{pretty(a.telegraph.attackType)}</b><p>{a.telegraph.narratorHint}</p></div></div>}
              <div className="caption"><span>{line?.speaker === 'boss' ? 'THE BOSS' : 'THE NARRATOR'}</span><p>{line?.text ?? 'Start a run to see the narrator.'}</p></div>
              <div className="stage-footer"><button disabled={!a.connected || phase !== 'lobby'} onClick={a.start}><Play size={14} />Start run</button></div>
            </section>
            {state?.lastResolution && <div className="resolution"><Check size={17} />Last round: {state.lastResolution.damageDealt} damage · {state.lastResolution.heartsLost} hearts lost {state.lastResolution.wardShattered && '· Ward shattered!'}</div>}
          </div><Player seat={b} room={room} shared={a.state} /></div>
        </>}
        {tab === 'events' && <section className="panel events-panel"><div className="event-heading"><div><h2>What the server actually said</h2><p className="muted">Last 200 events · click a row to inspect its payload</p></div><input aria-label="Filter events" placeholder="Filter events…" value={filter} onChange={(e) => setFilter(e.target.value)} /><button onClick={() => setEvents([])}>Clear</button></div>
          {filtered.length === 0 && <div className="empty"><Activity size={32} /><p>No matching events yet. Start a run to see the engine at work.</p></div>}
          {filtered.map((entry) => <details className="event-row" key={entry.id}><summary><time>{entry.time}</time><b>{entry.seat ? `${entry.seat} · ` : ''}{entry.event}</b></summary><pre>{JSON.stringify(entry.payload, null, 2)}</pre></details>)}
        </section>}
      </main>
    </div>
  </div>;
}
