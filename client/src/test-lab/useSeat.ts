import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, GameState, RoomJoinAck, P0ElementType, TelegraphPayload, HardwareCommand, NarratorLine } from '@once-upon/shared';

export type Log = (event: string, payload: unknown, seat?: string) => void;
export function useSeat(label: string, log: Log, narrate: (line: NarratorLine) => void) {
  const socket = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [name, setName] = useState(label === 'A' ? 'Maya' : 'Dev');
  const [element, setElement] = useState<P0ElementType>('ember');
  const [auto, setAuto] = useState(false);
  const [inZone, setInZone] = useState(true);
  const [telegraph, setTelegraph] = useState<TelegraphPayload | null>(null);
  const [hardware, setHardware] = useState<HardwareCommand | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const latest = useRef({ state, playerId, element, auto, inZone });
  latest.current = { state, playerId, element, auto, inZone };
  const autoRounds = useRef(new Set<string>());
  const role = label === 'A' ? 'spellbearer' : 'partner';

  useEffect(() => {
    const s = io({ autoConnect: false });
    socket.current = s;
    s.on('connect', () => { setConnected(true); setError(''); s.emit('clock:ping', { clientSendMs: Date.now() }); });
    s.on('disconnect', (reason) => { setConnected(false); log('disconnect', reason, label); });
    s.on('connect_error', (e) => setError(e.message));
    s.on('clock:pong', (p) => setOffset((p.serverRecvMs + p.serverSendMs) / 2 - (p.clientSendMs + Date.now()) / 2));
    s.on('room:state', (next) => {
      const previous = latest.current.state;
      if (previous?.phase !== next.phase || previous?.roundIndex !== next.roundIndex) log('phase', { phase: next.phase, round: next.roundIndex, hearts: next.hearts }, label);
      setState(next);
    });
    s.on('combat:telegraph', setTelegraph);
    s.on('hardware:command', setHardware);
    s.on('narrator:line', (line) => { if (label === 'A') narrate(line); });
    s.on('room:error', ({ message }) => setError(message));
    s.onAny((event, payload) => { if (!['room:state', 'clock:pong', 'player:pose'].includes(event)) log(event, payload, label); });
    const timer = window.setInterval(() => { if (s.connected) s.emit('clock:ping', { clientSendMs: Date.now() }); }, 10000);
    return () => { clearInterval(timer); s.disconnect(); };
  }, [label, log, narrate]);

  async function enter(mode: 'create' | 'join', code = '') {
    const s = socket.current!;
    setError(''); setBusy(true); autoRounds.current.clear();
    try {
      s.connect();
      const result = await new Promise<RoomJoinAck>((resolve, reject) => {
        const ack = (err: Error | null, value: RoomJoinAck) => err ? reject(new Error('Server did not respond. Check port 3001.')) : resolve(value);
        if (mode === 'join') s.timeout(10000).emit('room:join', { roomCode: code, playerName: name, role }, ack);
        else s.timeout(10000).emit('room:create', { playerName: name, role }, ack);
      });
      if (!result.ok) throw new Error(result.error);
      setPlayerId(result.playerId); setState(result.state); setTelegraph(null);
      log('room joined', { roomCode: result.roomCode, playerId: result.playerId }, label);
      return result.roomCode;
    } catch (e) { setError(String(e)); return null; }
    finally { setBusy(false); }
  }
  function pose(value: boolean) {
    setInZone(value);
    socket.current?.emit('player:pose', { playerId, landmarks: [], inZone: value, activeAction: 'none', confidence: 1, serverTimestampMs: Date.now() + offset });
  }
  function defend(kind: 'dodge' | 'parry' | 'hit') {
    if (!telegraph) return;
    socket.current?.emit('player:dodge_result', { playerId, attackId: telegraph.attackId, dodged: kind !== 'hit', parried: kind === 'parry', serverTimestampMs: Date.now() + offset });
  }
  function calibrate() {
    socket.current?.emit('calibration:done', { baseline: { shoulderY: .3, hipY: .6, shoulderWidth: .2, centerX: .5, calibratedAt: Date.now() + offset } });
    pose(true);
  }
  function cast(power = 1, chosen = element) {
    socket.current?.emit('player:cast', { playerId: latest.current.playerId, element: chosen, gesture: 'thrust', transcript: '', power, serverTimestampMs: Date.now() + offset });
  }
  useEffect(() => {
    if (!auto || !connected || !state || state.paused) return;
    if (state.phase === 'calibration') calibrate();
    if (state.phase === 'return') pose(true);
    if (state.phase === 'telegraph' && telegraph) defend('dodge');
    if (state.phase === 'team_turn') {
      const key = `${state.roomCode}:${state.roundIndex}`;
      if (!autoRounds.current.has(key)) {
        autoRounds.current.add(key);
        cast(1.2);
      }
    }
  }, [auto, connected, state?.phase, state?.roundIndex, state?.paused, telegraph?.attackId]);

  return { label, name, setName, connected, state, playerId, element, setElement, auto, setAuto, inZone, pose, telegraph,
    hardware, error, setError, busy, offset, enter, calibrate, defend, cast,
    start: () => socket.current?.emit('game:start'),
    disconnect: () => socket.current?.disconnect(),
    glove: (armed: boolean, fistCharged: boolean, noiseLevel: number) => socket.current?.emit('hardware:event', {
      dialSlot: ['ember', 'frost', 'bloom'].indexOf(element), armed, fistCharged, noiseLevel, buttonPressed: false, parryTriggered: false, colorToken: null,
    }),
  };
}
export type Seat = ReturnType<typeof useSeat>;
