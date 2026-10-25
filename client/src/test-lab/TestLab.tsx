import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, BookOpen, Check, ChevronRight, FlaskConical, Heart, Mic, Play, Radio, RefreshCw, Shield, Sparkles, Terminal, Volume2, WandSparkles, Wifi, Zap } from 'lucide-react';
import type { NarratorLine } from '@once-upon/shared';
import { useSeat, type Seat } from './useSeat';
import { startMicrophone } from './audio';
import { serverUrl } from '../combat-ui/audio/serverUrl';
import './lab.css';

type Entry = { id: number; time: string; event: string; payload: unknown; seat?: string };
const phases = ['lobby', 'opening', 'intro', 'calibration', 'telegraph', 'defense', 'return', 'team_turn', 'resolve', 'ending'];
const pretty = (value: string) => value.replaceAll('_', ' ');
/** Marks actions that call a paid provider (Muse / ElevenLabs) when it is configured. */
// Lines from the saved demo world, so voice tests play cached audio instead of spending credits.
const SAVED_NARRATOR_LINE = 'Once upon a time, Maya and Dev followed a road that refused to end. Behind them, the lanterns of a great stone library guttered at three in the morning. Ahead, the trees leaned close to listen. For this wood remembers every word friends ever said to each other, and tonight it has come to collect.';
const SAVED_BOSS_LINE = 'Shhh. The library is closing, little ones, and you have not even started.';
const Paid = () => <span className="paid" title="Calls a paid provider when configured">credits</span>;

function Player({ seat, room, shared }: { seat: Seat; room: string; shared: Seat['state'] }) {
  const [recording, setRecording] = useState(false);
  const [startingMic, setStartingMic] = useState(false);
  const stop = useRef<null | (() => Promise<Blob>)>(null);
  const [power, setPower] = useState(1.2);
  const [armed, setArmed] = useState(true);
  const [fist, setFist] = useState(false);
  const [noise, setNoise] = useState(0);
  const [words, setWords] = useState('');
  // A disconnected seat stops receiving state, so read its player from the other seat's live view.
  const player = (seat.connected ? seat.state : shared ?? seat.state)?.players.find((p) => p.id === seat.playerId);
  const active = seat.connected && !!seat.playerId;
  const canCast = active && seat.state?.phase === 'team_turn' && !seat.state.paused;
  useEffect(() => () => { if (stop.current) void stop.current(); }, []);
  async function record() {
    try {
      if (stop.current) {
        const finish = stop.current; stop.current = null; setRecording(false);
        await seat.transcribe(await finish());
      } else {
        setStartingMic(true);
        stop.current = await startMicrophone(); setRecording(true);
      }
    } catch (error) { seat.setError(`Microphone: ${String(error)}`); }
    finally { setStartingMic(false); }
  }
  return <section className="panel player-panel">
    <div className="panel-heading"><div className={`avatar avatar-${seat.label.toLowerCase()}`}>{seat.label}</div><div><h2>Laptop {seat.label}</h2><span className="muted">{seat.label === 'A' ? 'Spellbearer · host' : 'Partner · second socket'}</span></div><span className={`status-dot ${seat.connected ? 'on' : ''}`} title={seat.connected ? 'Connected' : 'Disconnected'} /></div>
    <label className="field">Player name<input value={seat.name} onChange={(e) => seat.setName(e.target.value)} disabled={active} /></label>
    {!active && player?.role === 'bot' && <div className="seat-state"><span>Bot has taken over this seat</span></div>}
    {!active ? <button className="button full" disabled={!room || seat.busy} onClick={() => void seat.enter('join', room)}><Wifi size={15} />{seat.playerId ? 'Reconnect to room' : 'Join this room'}</button> : <div className="seat-state"><span>{player?.role === 'bot' ? 'Bot has taken over' : player?.canCast ? 'Ready to cast' : 'Sitting out'}</span><button className="text-button" onClick={seat.disconnect}>Disconnect</button></div>}
    <label className="toggle-row"><span>Assist this player<small>Simulated dodges & incantations</small></span><input type="checkbox" checked={seat.auto} onChange={(e) => seat.setAuto(e.target.checked)} /></label>
    <div className="divider" />
    <div className="section-label">01 / BODY INPUTS <span>SIMULATED</span></div>
    <div className="button-row"><button disabled={!active} onClick={seat.calibrate}>Calibrate</button><button disabled={!active} className={seat.inZone ? 'selected' : ''} onClick={() => seat.pose(!seat.inZone)}>{seat.inZone ? 'In zone' : 'Out of zone'}</button></div>
    <div className="button-row"><button disabled={!active || !['telegraph', 'defense'].includes(seat.state?.phase ?? '')} onClick={() => seat.defend('dodge')}>Dodge</button><button disabled={!active || seat.telegraph?.attackType !== 'projectile'} onClick={() => seat.defend('parry')}>Parry</button><button disabled={!active || !['telegraph', 'defense'].includes(seat.state?.phase ?? '')} onClick={() => seat.defend('hit')}>Take hit</button></div>
    <div className="divider" />
    <div className="section-label">02 / SPELL & VOICE</div>
    <div className="elements">{(['ember', 'frost', 'bloom'] as const).map((element) => <button key={element} className={`${element} ${seat.element === element ? 'active' : ''}`} onClick={() => { seat.setElement(element); setWords(''); }}>{element === 'ember' ? '✦' : element === 'frost' ? '❄' : '✿'} {element}</button>)}</div>
    <div className="incantation"><span>YOUR INCANTATION</span><p>“{seat.state?.world?.incantations[seat.element] ?? 'Start a story to reveal your words'}”</p></div>
    <button className={`button full ${recording ? 'recording' : ''}`} disabled={!active || seat.busy || startingMic} onClick={() => void record()}><Mic size={16} />{recording ? 'Stop & transcribe' : startingMic ? 'Opening microphone…' : 'Record real incantation'}<Paid /></button>
    <small className="helper">Real mic → 16 kHz WAV → Muse ASR. Stop recording before the team turn ends.</small>
    <details><summary>Simulate words / test failure</summary><input aria-label={`Simulated words laptop ${seat.label}`} placeholder="Blank uses the expected phrase" value={words} onChange={(e) => setWords(e.target.value)} /><button className="full" disabled={!active || seat.busy} onClick={() => void seat.transcribe(undefined, words || undefined)}>Submit simulated words</button></details>
    {seat.verdict && <div className={`verdict ${seat.verdict.passed ? 'pass' : 'fail'}`}><b>{seat.verdict.mercy ? 'Mercy pass' : seat.verdict.passed ? 'Incantation passed' : 'Incantation failed'}</b><span>{Math.round(seat.verdict.matchRatio * 100)}% match · {seat.verdict.power}× voice power</span><small>{seat.verdict.transcript || '(empty transcript)'}</small></div>}
    <label className="range-label">Gesture power <b>{power.toFixed(1)}×</b><input type="range" min="0.5" max="1.5" step="0.1" value={power} onChange={(e) => setPower(Number(e.target.value))} /></label>
    <button className="button primary full" disabled={!canCast} onClick={() => seat.cast(power, seat.element)}><Zap size={16} />Cast {seat.element}<ArrowRight size={16} /></button>
    <small className="helper">A valid incantation must precede the cast. The server applies voice power.</small>
    {seat.label === 'A' && <details><summary>Glove simulator</summary><label className="toggle-row">Armed<input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} /></label><label className="toggle-row">Fist charged<input type="checkbox" checked={fist} onChange={(e) => setFist(e.target.checked)} /></label><label className="field">Noise level<input type="number" min="0" max="1023" value={noise} onChange={(e) => setNoise(Number(e.target.value))} /></label><button disabled={!active} className="full" onClick={() => seat.glove(armed, fist, noise)}>Send glove frame</button><small className="helper">Output: {seat.hardware ? JSON.stringify(seat.hardware) : 'waiting for buzzer / servo'}</small></details>}
    {seat.error && <p role="alert" className="error">{seat.error}</p>}
  </section>;
}

type OpStats = { count: number; ok: number; fallback: number; error: number; lastMs: number; p50Ms: number; p95Ms: number; maxMs: number };
const OP_LABELS: Record<string, string> = {
  'muse.chat': 'Muse Spark request (raw)', 'world.generate': 'World generation', 'cards.extract': 'Memory card extraction',
  'image.generate': 'Image (each)', 'asr.transcribe': 'Speech to text', 'tts.provider': 'Voice synthesis', 'tts.cache_hit': 'Voice cache hit',
  narrate: 'Live narration', 'boss.plan': 'Boss plan', 'quest.chat': 'Quest Master',
};
const ms = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;

/** Live latency of every AI step the server ran since start (or the last reset). Free: reads counters only. */
function Timings() {
  const [data, setData] = useState<{ since: number; operations: Record<string, OpStats> } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (reset = false) => {
    try {
      const response = await fetch(reset ? '/api/metrics/ai/reset' : '/api/metrics/ai', { method: reset ? 'POST' : 'GET' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json()); setError('');
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]);
  const rows = Object.entries(data?.operations ?? {});
  return <section className="panel tool-panel result-panel">
    <div className="panel-heading"><Activity size={19} /><h2>AI timings</h2><button className="timings-reset" onClick={() => void load(true)}>Reset</button></div>
    <p className="muted">Measured on the server for every AI step since {data ? new Date(data.since).toLocaleTimeString() : '—'}. Play a round or run a tool, then watch it update. Reading this costs nothing.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {rows.length === 0 ? <div className="empty"><Activity size={28} /><p>No AI steps yet. Start a live world, extract a chat, or play a round.</p></div> :
      <div className="timings-wrap"><table className="timings"><thead><tr><th>Step</th><th>Runs</th><th>OK / fallback / error</th><th>Last</th><th>Median</th><th>p95</th><th>Max</th></tr></thead><tbody>
        {rows.map(([op, s]) => <tr key={op}><td title={op}>{OP_LABELS[op] ?? op}</td><td>{s.count}</td><td><span className="good">{s.ok}</span> / {s.fallback} / <span className={s.error ? 'bad' : ''}>{s.error}</span></td><td>{ms(s.lastMs)}</td><td>{ms(s.p50Ms)}</td><td>{ms(s.p95Ms)}</td><td>{ms(s.maxMs)}</td></tr>)}
      </tbody></table></div>}
    <small className="helper">Fallback means the game used its offline backup (cached world, scripted boss, prewritten line). For repeatable numbers, run <code>bench:ai</code> in a terminal.</small>
  </section>;
}

export default function TestLab() {
  const [events, setEvents] = useState<Entry[]>([]);
  const serial = useRef(0);
  const log = useCallback((event: string, payload: unknown, seat?: string) => setEvents((current) => [{ id: ++serial.current, time: new Date().toLocaleTimeString(), event, payload, seat }, ...current].slice(0, 200)), []);
  const [line, setLine] = useState<NarratorLine | null>(null);
  const [voice, setVoice] = useState(false);
  const voiceRef = useRef(false); voiceRef.current = voice;
  const audio = useRef<HTMLAudioElement | null>(null);
  const [audioNote, setAudioNote] = useState('');
  const playVoice = useCallback(async (text: string, speaker: 'narrator' | 'boss') => {
    try {
      // The game server's TTS chain, not the dev server's /api/tts (which /debug/audio provides).
      const response = await fetch(`${serverUrl()}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, speaker }) });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
      audio.current?.pause(); speechSynthesis.cancel();
      if (response.headers.get('Content-Type')?.includes('audio')) {
        const url = URL.createObjectURL(await response.blob());
        const next = new Audio(url); audio.current = next;
        next.onended = () => URL.revokeObjectURL(url);
        await next.play(); setAudioNote(`Playing ${response.headers.get('X-TTS-Provider') ?? 'server audio'}`);
      } else {
        const result = await response.json();
        speechSynthesis.speak(new SpeechSynthesisUtterance(result.text)); setAudioNote('Browser speech fallback');
      }
      log('TTS playback', { speaker, status: response.status, provider: response.headers.get('X-TTS-Provider') });
    } catch (error) { setAudioNote(String(error)); log('TTS error', String(error)); }
  }, [log]);
  const narration = useCallback((next: NarratorLine) => { setLine(next); if (voiceRef.current) void playVoice(next.text, next.speaker); }, [playVoice]);
  const a = useSeat('A', log, narration);
  const b = useSeat('B', log, narration);
  const state = a.state;
  const [room, setRoom] = useState(new URLSearchParams(location.search).get('room') ?? '');
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState('');
  const [toolResult, setToolResult] = useState<unknown>(null);
  const [prompt, setPrompt] = useState('Create a normal quest for Maya and Dev.');
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('play');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async () => {
    try { const response = await fetch('/health'); if (!response.ok) throw new Error(`HTTP ${response.status}`); setHealth(await response.json()); setHealthError(''); }
    catch (error) { setHealth(null); setHealthError(String(error)); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
  async function create(quick: boolean) {
    b.disconnect(); a.setAuto(false); b.setAuto(false);
    const code = await a.enter(quick ? 'quick' : 'create');
    if (code) setRoom(code);
  }
  async function assisted() {
    setPending('demo');
    try {
      b.disconnect();
      const code = await a.enter('quick');
      if (!code) return;
      setRoom(code);
      if (!await b.enter('join', code)) return;
      a.setElement('ember'); b.setElement('ember'); a.setAuto(true); b.setAuto(true);
      a.start(); log('assisted demo', 'Both sockets use synthetic inputs. AI boss, phases and damage remain authoritative server logic.');
    } finally { setPending(''); }
  }
  async function tool(name: string, action: () => Promise<unknown>) {
    setPending(name);
    try { const result = await action(); setToolResult(result); log(name, result); }
    catch (error) { setToolResult({ error: String(error) }); log(`${name} failed`, String(error)); }
    finally { setPending(''); }
  }
  async function json(url: string, body: unknown) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`); return result;
  }
  const phase = state?.phase ?? 'lobby';
  const remaining = Math.max(0, ((state?.phaseEndsServerMs ?? now) - now - a.offset) / 1000);
  const enemy = state?.currentEncounter;
  const art = state?.images?.[state.fightingBoss ? 'boss' : state.currentEncounter ? 'monster' : 'cover'] ?? '/api/images/cached-cover';
  const filtered = events.filter((entry) => `${entry.event} ${JSON.stringify(entry.payload)}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="lab">
    <aside className="rail"><a className="brand" href="/debug/server" aria-label="Once Upon a Memory test lab"><BookOpen size={25} /></a><button className={tab === 'play' ? 'active' : ''} onClick={() => setTab('play')} title="Playground"><WandSparkles size={21} /></button><button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')} title="Provider tests"><FlaskConical size={21} /></button><button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')} title="Event stream"><Terminal size={21} /></button><span className="rail-bottom">P0</span></aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">ONCE UPON A MEMORY <ChevronRight size={13} /><strong>Developer lab</strong></div><div className="server-badge"><span className={`status-dot ${health ? 'on' : ''}`} />{health ? 'Server online' : 'Server unavailable'}<button className="icon-button" aria-label="Refresh server health" onClick={() => void refresh()}><RefreshCw size={13} /></button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">THE STORYBOOK WORKBENCH</div><h1>Make a little magic.<span>Inspect every step.</span></h1><p>Two laptops. One authoritative server. A place to test the whole tale.</p></div><div className="lab-tag"><FlaskConical size={18} /><div>DEVELOPMENT INTERFACE<small>Live server · simulated body & glove</small></div></div></div>
        <div className="nav-tabs"><button className={tab === 'play' ? 'active' : ''} onClick={() => setTab('play')}><WandSparkles size={16} />Playground</button><button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}><FlaskConical size={16} />Providers & tools</button><button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}><Activity size={16} />Event stream <span>{events.length}</span></button></div>
        {healthError && <div role="alert" className="notice error">Server connection failed. Start the backend on port 3001. {healthError}</div>}
        {tab === 'play' && <>
          <section className="launchbar"><div><span className="section-label">ROOM CONTROL</span><div className="room-code">{state?.roomCode ?? '— — — —'}<span>{state ? `${state.players.length} seats` : 'No active story'}</span></div></div><div className="launch-actions"><button disabled={!!pending || a.busy} onClick={() => void create(true)}>Quick-start room</button><button disabled={!!pending || a.busy} onClick={() => void create(false)}>New live world<Paid /></button><button className="button primary" disabled={!!pending || a.busy} onClick={() => void assisted()}><Play size={15} />{pending === 'demo' ? 'Connecting…' : 'Run assisted demo'}</button></div><div className="join-control"><input aria-label="Room code" placeholder="CODE" maxLength={4} value={room} onChange={(e) => setRoom(e.target.value.toUpperCase())} /><button disabled={room.length !== 4 || a.busy} onClick={() => void a.enter('join', room)}>Join as A</button></div></section>
          <div className="play-grid"><Player seat={a} room={room} shared={b.state} /><div className="stage-column"><section className="stage panel"><div className="stage-art" style={{ backgroundImage: `linear-gradient(180deg,rgba(10,16,18,.1),rgba(10,16,18,.96)),url("${art}")` }}><div className="stage-top"><span className="pill"><Radio size={12} />{state ? pretty(phase) : 'Ready when you are'}</span><span className="round">ROUND {state ? state.roundIndex + 1 : '—'}</span></div><div className="story-title"><div className="eyebrow">{state?.fightingBoss ? 'THE FINAL CHAPTER' : 'ONCE UPON A TIME'}</div><h2>{enemy?.name ?? state?.world?.title ?? 'The Wood of Unfinished Roads'}</h2><p>{state ? state.world?.title : 'Create a room, invite a partner, and put the engine through its paces.'}</p></div><div className="stage-stats"><span className="hearts">{Array.from({ length: 5 }, (_, i) => <Heart key={i} size={22} fill={i < (state?.hearts ?? 5) ? 'currentColor' : 'none'} opacity={i < (state?.hearts ?? 5) ? 1 : .25} />)}</span><span className={state?.wardActive ? 'ward active' : 'ward'}><Shield size={15} />{state?.wardActive ? 'WARD UP · TWIN CAST' : 'Ward inactive'}</span></div>{enemy && <div className="hp"><span>ENEMY HEALTH <b>{state?.enemyHp} / {state?.enemyMaxHp}</b></span><div><i style={{ width: `${100 * (state?.enemyHp ?? 0) / (state?.enemyMaxHp || 1)}%` }} /></div></div>}</div>
              <div className="phase-display"><div><span className="section-label">CURRENT PHASE</span><h3>{state?.paused ? 'Paused · waiting for player' : pretty(phase)}</h3></div><div className="countdown">{state?.paused ? 'Ⅱ' : remaining.toFixed(1)}<small>seconds</small></div></div><div className="phase-track">{phases.map((p) => <span key={p} className={p === phase ? 'active' : ''} title={pretty(p)} />)}</div>
              {a.telegraph && ['telegraph', 'defense', 'return'].includes(phase) && <div className="attack-banner"><Shield size={20} /><div><b>{pretty(a.telegraph.attackType)}</b><p>{a.telegraph.narratorHint}</p></div></div>}
              <div className="caption"><span>{line?.speaker === 'boss' ? 'THE BOSS' : 'THE NARRATOR'}</span><p>{line?.text ?? '“Every good story starts with a little curiosity.”'}</p></div>
              <div className="stage-footer"><button disabled={!a.connected || !['lobby', 'opening'].includes(phase)} onClick={a.start}><Play size={14} />{phase === 'opening' ? 'Generate & begin' : 'Start story'}</button><label><input type="checkbox" checked={voice} onChange={(e) => { setVoice(e.target.checked); if (!e.target.checked) { audio.current?.pause(); speechSynthesis.cancel(); } }} /><Volume2 size={15} />Narration</label></div>
            </section>
            <section className="panel briefing"><h3><Sparkles size={17} />Your first test run</h3><ol><li><b>Run assisted demo</b> connects both laptops and plays automatically.</li><li>Turn assistance off to test dodges, speech, casts and failures manually.</li><li>Disconnect laptop B to verify the pause and bot takeover.</li></ol><p>Assistance uses a development transcript override, not Muse ASR. Use the microphone or Providers tab to test real transcription.</p></section>
            {phase === 'opening' && <section className="panel cards"><h3>Choose the memories</h3>{state?.memoryCards?.map((card) => <article key={card.id}><p>“{card.quote}”</p><div className="button-row"><button className={state.picks?.encounterCardId === card.id ? 'selected' : ''} onClick={() => a.pick(card.id, 'encounter')}>Encounter</button><button className={state.picks?.bossCardId === card.id ? 'selected' : ''} onClick={() => a.pick(card.id, 'boss')}>Boss</button></div></article>)}</section>}
            {state?.lastResolution && <div className="resolution"><Check size={17} />Last round: {state.lastResolution.damageDealt} damage · {state.lastResolution.heartsLost} hearts lost {state.lastResolution.wardShattered && '· Ward shattered!'}</div>}
          </div><Player seat={b} room={room} shared={a.state} /></div>
        </>}
        {tab === 'tools' && <div className="tools-grid"><section className="panel tool-panel"><h2>Connected providers</h2><p className="muted">These flags show configuration. Run an action to verify a real request.</p>{[['Muse', health?.muse], ['ElevenLabs', health?.elevenLabs], ['OpenAI fallback', health?.openai], ['MCP bearer auth', health?.mcpAuth]].map(([name, enabled]) => <div className="provider-row" key={String(name)}><span>{String(name)}</span><span className={enabled ? 'good' : 'muted'}>{enabled ? 'Configured' : 'Not configured'}</span></div>)}<div className="divider" /><h3>Voice output</h3><p>Plays actual audio from the server’s TTS chain. These two buttons use saved demo lines and play offline for free; other narration uses ElevenLabs credits when configured.</p><div className="button-row"><button onClick={() => void playVoice(SAVED_NARRATOR_LINE, 'narrator')}>Test narrator</button><button onClick={() => void playVoice(SAVED_BOSS_LINE, 'boss')}>Test boss</button></div><small className="helper">{audioNote}</small><h3>Real ASR fixture</h3><p>Send a synthetic spoken WAV saying “forty miles from anything”. Use Ember in a quick-start room.</p><button disabled={!a.playerId || !!pending} onClick={() => void tool('spoken WAV test', async () => { const response = await fetch('/test-incantation.wav'); if (!response.ok) throw new Error('Audio fixture missing'); return await a.transcribe(await response.blob()); })}><Mic size={15} />Transcribe sample audio<Paid /></button></section>
          <section className="panel tool-panel"><h2>Quest Master</h2><p className="muted">Ask Muse to create a room through the actual server tools.</p><label className="field">Your request<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label><button className="button primary" disabled={!!pending} onClick={() => void tool('Quest Master', async () => { const result = await json('/api/quest-chat', { prompt, hostName: a.name }); if (result.roomCode) setRoom(result.roomCode); return result; })}><WandSparkles size={16} />{pending === 'Quest Master' ? 'Asking Muse…' : 'Send to Quest Master'}<Paid /></button><div className="divider" /><h3>Memory extraction</h3><p>Use the fictional chat fixture, or an Instagram export whose participants have consented.</p><button disabled={!!pending} onClick={() => void tool('memory extraction', async () => { const fixture = await (await fetch('/sample-chat.json')).json(); return json('/api/chat-upload', fixture); })}>Extract from sample chat<Paid /></button><label className="upload-label">Upload chat JSON<input type="file" accept=".json" disabled={!!pending} onChange={(e) => { const file = e.target.files?.[0]; if (file) void tool('chat upload', async () => { const form = new FormData(); form.set('file', file); const response = await fetch('/api/chat-upload', { method: 'POST', body: form }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }); }} /></label><small className="helper">After extraction, create a “New live world” room to select cards and generate the story and art.</small></section>
          <Timings /><section className="panel tool-panel result-panel"><div className="panel-heading"><Terminal size={19} /><h2>Request result</h2>{pending && <span className="pill">Working…</span>}</div><pre>{JSON.stringify(toolResult ?? { message: 'Run a provider or tool action to inspect its response.' }, null, 2)}</pre><div className="notice">MCP’s bearer token stays on the server. Authenticated MCP is tested with <code>check:pipeline</code> in the terminal; this page does not expose credentials.</div></section></div>}
        {tab === 'events' && <section className="panel events-panel"><div className="event-heading"><div><h2>What the server actually said</h2><p className="muted">Last 200 events · click a row to inspect its payload</p></div><input aria-label="Filter events" placeholder="Filter events…" value={filter} onChange={(e) => setFilter(e.target.value)} /><button onClick={() => setEvents([])}>Clear</button><button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'storybook-test-events.json'; link.click(); URL.revokeObjectURL(url); }}>Export JSON</button></div>{filtered.length === 0 && <div className="empty"><Activity size={32} /><p>No matching events yet. Start a story to see the engine at work.</p></div>}{filtered.map((entry) => <details className="event" key={entry.id}><summary><time>{entry.time}</time><span className="seat-tag">{entry.seat ?? 'API'}</span><b>{entry.event}</b><span>{typeof entry.payload === 'object' ? JSON.stringify(entry.payload).slice(0, 80) : String(entry.payload).slice(0, 80)}</span></summary><pre>{JSON.stringify(entry.payload, null, 2)}</pre></details>)}<details className="snapshot"><summary>Full room state</summary><pre>{JSON.stringify(state, null, 2)}</pre></details></section>}
        <footer className="footer"><span><span className="status-dot on" />LOCAL TEST LAB <i>/</i> HACKTX 2026</span><span>Camera tracking, physical glove & public MCP deployment require separate integration tests.</span></footer>
      </main>
    </div>
  </div>;
}
