import { useEffect, useRef, useState } from 'react';
import type { CalibrationBaseline, NormalizedLandmark } from '@aethren/shared';
import { PoseLandmarkerService } from '../vision/poseLandmarkerService';
import { classifyDodgeAndPose, computeCalibrationBaseline, resolveTorso } from '../vision/poseClassifiers';
import { useGloveSession } from '../glove/GloveSession';
import { dialSlot } from '../glove/gloveInput';
import { useStoryStore } from '../net/storyStore';
import { bodyInZone, castSpell, duelLive, leaveDuel, markReady, openDuel, requestRematch, selectSpell, sendPose, useDuel } from './duelGame';
import { DUEL_HEALTH, DUEL_MANA, DUEL_SPELLS, GUARD_MAX } from './duelSpells';
import './duel.css';

/** nose, shoulders, elbows, wrists, hips: the nine points sent to the rival. */
const PICK = [0, 11, 12, 13, 14, 15, 16, 23, 24] as const;
const BONES: ReadonlyArray<readonly [number, number]> = [[1, 2], [1, 3], [3, 5], [2, 4], [4, 6], [1, 7], [2, 8], [7, 8]];
const AVATARS: Record<'male' | 'female', HTMLImageElement> = { male: new Image(), female: new Image() };
AVATARS.male.src = '/art/spellbearer-male.png';
AVATARS.female.src = '/art/spellbearer-female.png';
/** Where the shoulders sit in the 1024x1536 art, and how wide they are, so the figure can be fitted onto a real body. */
const ART = { shoulderX: 520, shoulderY: 430, shoulderWidth: 320 };

/** The rival, drawn as a spellbearer from the game's art and lined up with their shoulders. */
function drawAvatar(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], w: number, h: number, avatar: 'male' | 'female') {
  const img = AVATARS[avatar];
  if (points.length < 3 || !img.complete || !img.naturalWidth) return;
  const [l, r] = [points[1]!, points[2]!];
  const widthPx = Math.max(Math.abs(l.x - r.x) * w, h * 0.08);
  const scale = widthPx / ART.shoulderWidth;
  const cx = ((l.x + r.x) / 2) * w, cy = ((l.y + r.y) / 2) * h;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.95;
  ctx.drawImage(img, cx - ART.shoulderX * scale, cy - ART.shoulderY * scale, img.naturalWidth * scale, img.naturalHeight * scale);
  ctx.restore();
}
const mirror = (l: NormalizedLandmark) => ({ x: 1 - l.x, y: l.y });

function drawBody(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], w: number, h: number, color: string, alpha: number) {
  if (points.length < 9) return;
  ctx.save();
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round'; ctx.shadowColor = color; ctx.shadowBlur = 18;
  ctx.lineWidth = Math.max(10, h * 0.045);
  for (const [a, b] of BONES) { ctx.beginPath(); ctx.moveTo(points[a]!.x * w, points[a]!.y * h); ctx.lineTo(points[b]!.x * w, points[b]!.y * h); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(points[0]!.x * w, points[0]!.y * h, h * 0.055, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawZone(ctx: CanvasRenderingContext2D, zone: { x: number; y: number; startAt: number; impactAt: number; spell: { radius: number; color: string } }, w: number, h: number, now: number, mine: boolean) {
  const t = Math.min(1, Math.max(0, (now - zone.startAt) / (zone.impactAt - zone.startAt)));
  const r = zone.spell.radius * h;
  const x = zone.x * w, y = zone.y * h;
  ctx.save();
  ctx.strokeStyle = zone.spell.color; ctx.fillStyle = zone.spell.color; ctx.lineWidth = 4;
  ctx.globalAlpha = mine ? 0.5 : 1;
  ctx.setLineDash(mine ? [10, 8] : []);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = (mine ? 0.12 : 0.18) + t * (mine ? 0.12 : 0.4);
  ctx.beginPath(); ctx.arc(x, y, r * (0.25 + 0.75 * t), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

export function DuelArena() {
  const { status, foeName, health, foeHealth, mana, guard, spellIndex, message, hurtTick, strikeTick, winner, readyMine, rematchMine, countdownEnd } = useDuel();
  const name = useStoryStore((s) => s.playerName);
  const { onInput } = useGloveSession();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const baseline = useRef<CalibrationBaseline | null>(null);
  const [camera, setCamera] = useState<'starting' | 'webcam' | 'mouse'>('starting');
  const [camMessage, setCamMessage] = useState('Starting camera');
  const [count, setCount] = useState(3);
  const mouse = useRef({ x: 0.5, y: 0.5, block: false });
  const cameraMode = useRef<'starting' | 'webcam' | 'mouse'>('starting');
  cameraMode.current = camera;

  useEffect(() => { openDuel(name); return () => leaveDuel(); }, [name]);

  // Camera: track the body, calibrate once, then keep body, aim and guard fresh for the arena.
  useEffect(() => {
    if (!video.current) return;
    const service = new PoseLandmarkerService();
    let disposed = false, frame = 0, last = 0, lastSend = 0;
    const samples: NormalizedLandmark[][] = [];
    const tick = (now: number) => {
      if (disposed) return;
      if (now - last > 40 && video.current) {
        last = now;
        const landmarks = service.sample(now);
        const torso = landmarks && resolveTorso(landmarks);
        if (landmarks && torso) {
          const pts = PICK.map((i) => mirror(landmarks[i]!));
          duelLive.body = pts;
          const wristL = landmarks[15]!, wristR = landmarks[16]!;
          const up = (wristL.visibility ?? 1) > 0.4 && wristL.y < wristR.y ? wristL : wristR;
          duelLive.aim = (up.visibility ?? 1) > 0.4 ? mirror(up) : null;
          if (!baseline.current) {
            samples.push(landmarks);
            setCamMessage(`Stand centered with arms down ${Math.min(100, Math.round(samples.length / 25 * 100))}%`);
            if (samples.length >= 25) {
              const centers = samples.map((p) => (p[11]!.x + p[12]!.x) / 2);
              const candidate = computeCalibrationBaseline(samples, now);
              if (candidate && Math.max(...centers) - Math.min(...centers) < 0.06) { baseline.current = candidate; setCamMessage('Calibrated'); markReady(); }
              else { samples.length = 0; setCamMessage('Hold still briefly to calibrate'); }
            }
          } else {
            const pose = classifyDodgeAndPose(landmarks, baseline.current);
            const guarding = pose.confidence >= 0.6 && pose.isRightArmRaised;
            if (guarding && !duelLive.blockSince) duelLive.blockSince = now;
            else if (!guarding) duelLive.blockSince = 0;
          }
          if (now - lastSend > 80) { lastSend = now; sendPose(pts); }
        } else { duelLive.body = null; duelLive.aim = null; samples.length = 0; setCamMessage('Move into view: head, shoulders and hands'); }
      }
      frame = requestAnimationFrame(tick);
    };
    void service.start(video.current, 'webcam').then((mode) => {
      if (disposed) { service.stop(); return; }
      if (mode !== 'webcam') { service.stop(); setCamera('mouse'); setCamMessage('No camera here: use the mouse (Shift guards)'); markReady(); return; }
      setCamera('webcam');
      frame = requestAnimationFrame(tick);
    }).catch(() => { if (!disposed) { setCamera('mouse'); markReady(); } });
    return () => { disposed = true; cancelAnimationFrame(frame); service.stop(); };
  }, []);

  // No-camera fallback: the mouse is the body and the aim, Shift is the guard.
  useEffect(() => {
    if (camera !== 'mouse') return;
    let lastSend = 0;
    const move = (e: PointerEvent) => {
      const box = canvas.current?.getBoundingClientRect();
      if (!box) return;
      mouse.current.x = (e.clientX - box.left) / box.width; mouse.current.y = (e.clientY - box.top) / box.height;
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Shift') duelLive.blockSince = e.type === 'keydown' ? duelLive.blockSince || performance.now() : 0; };
    const timer = window.setInterval(() => {
      const { x, y } = mouse.current;
      const body = Array.from({ length: 9 }, (_, i) => ({ x: x + (i % 3 - 1) * 0.03, y: y + (Math.floor(i / 3) - 1) * 0.05 }));
      duelLive.body = body; duelLive.aim = { x: Math.min(0.95, x + 0.08), y: Math.max(0.05, y - 0.1) };
      const now = performance.now();
      if (now - lastSend > 80) { lastSend = now; sendPose(body); }
    }, 40);
    window.addEventListener('pointermove', move); window.addEventListener('keydown', key); window.addEventListener('keyup', key);
    return () => { clearInterval(timer); window.removeEventListener('pointermove', move); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); };
  }, [camera]);

  // Glove: dial picks the spell, T or B1 casts, B2 steps to the next spell.
  useEffect(() => {
    let slot: number | null = null;
    return onInput((event) => {
      if (event.type === 'dial') { slot = dialSlot(event.value, DUEL_SPELLS.length, slot); selectSpell(slot); }
      else if (event.type === 'down') { if (event.button === 'B2') selectSpell(useDuel.getState().spellIndex + 1); else castSpell(); }
    });
  }, [onInput]);
  // Keyboard stand-ins for testing: 1-4 pick, Space casts.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key >= '1' && e.key <= '4') selectSpell(Number(e.key) - 1);
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); castSpell(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    if (status !== 'countdown') return;
    const timer = window.setInterval(() => setCount(Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000))), 100);
    return () => clearInterval(timer);
  }, [status, countdownEnd]);

  // Canvas: both ghosts, every spell zone, and the caster's aim.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = canvas.current;
      const ctx = el?.getContext('2d');
      if (!el || !ctx) return;
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      ctx.clearRect(0, 0, w, h);
      const now = performance.now();
      if (duelLive.foe) { drawAvatar(ctx, duelLive.foe, w, h, useDuel.getState().foeAvatar); drawBody(ctx, duelLive.foe, w, h, '#ff5fa8', 0.22); }
      if (duelLive.body) drawBody(ctx, duelLive.body, w, h, '#4fe3ff', 0.8);
      const state = useDuel.getState();
      for (const zone of state.outgoing) drawZone(ctx, zone, w, h, now, true);
      for (const zone of state.incoming) {
        drawZone(ctx, zone, w, h, now, false);
        if (bodyInZone(duelLive.body, zone)) { ctx.save(); ctx.fillStyle = '#ff2a2a'; ctx.font = `${Math.round(h * 0.05)}px 'Pixelify Sans', monospace`; ctx.textAlign = 'center'; ctx.fillText('MOVE', zone.x * w, zone.y * h - zone.spell.radius * h - 8); ctx.restore(); }
      }
      if (duelLive.aim && state.status === 'fighting') {
        ctx.save(); ctx.strokeStyle = DUEL_SPELLS[state.spellIndex]!.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(duelLive.aim.x * w, duelLive.aim.y * h, 14, 0, Math.PI * 2); ctx.moveTo(duelLive.aim.x * w - 22, duelLive.aim.y * h); ctx.lineTo(duelLive.aim.x * w + 22, duelLive.aim.y * h); ctx.stroke(); ctx.restore();
      }
      if (duelLive.blockSince && state.status === 'fighting') { ctx.save(); ctx.fillStyle = '#4fe3ff'; ctx.font = `${Math.round(h * 0.04)}px 'Pixelify Sans', monospace`; ctx.fillText('GUARD', 16, h - 16); ctx.restore(); }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const bar = (value: number, max: number, cls: string) => <div className={`duel-bar ${cls}`}><span style={{ width: `${Math.max(0, value / max * 100)}%` }} /><b>{Math.ceil(value)}</b></div>;
  return <main className="duel" data-hurt={hurtTick % 2} data-strike={strikeTick % 2} aria-label="Duel">
    <video className="duel-video" ref={video} muted playsInline autoPlay aria-hidden="true" />
    <canvas ref={canvas} className="duel-canvas" />
    <header className="duel-hud">
      <section><strong>{name || 'You'}</strong>{bar(health, DUEL_HEALTH, 'health')}{bar(mana, DUEL_MANA, 'mana')}{bar(guard, GUARD_MAX, 'guard')}</section>
      <section className="foe"><strong>{foeName || 'Waiting'}</strong>{bar(foeHealth, DUEL_HEALTH, 'health')}</section>
    </header>
    <ul className="duel-spells" aria-label="Spells">
      {DUEL_SPELLS.map((spell, i) => <li key={spell.id} data-active={i === spellIndex} style={{ ['--c' as string]: spell.color }}><b>{spell.name}</b><small>{spell.cost} mp</small></li>)}
    </ul>
    {message && status === 'fighting' && <p className="duel-feed" role="status">{message}</p>}
    {status !== 'fighting' && <section className="duel-card" role="status">
      {status === 'seeking' && <><h2>Duel</h2><p>Waiting for a rival on this glove hub. Open Duel on the other screen.</p></>}
      {status === 'unavailable' && <><h2>No glove hub</h2><p>Start the glove hub, then try again.</p></>}
      {status === 'paired' && <><h2>{foeName} is here</h2><p>{readyMine ? 'Waiting for your rival to calibrate' : camMessage}</p></>}
      {status === 'countdown' && <h2 className="duel-count">{count}</h2>}
      {status === 'over' && <><h2>{winner === 'me' ? 'Victory' : 'Defeated'}</h2><p>{message}</p>
        {foeName && <button type="button" onClick={requestRematch} disabled={rematchMine}>{rematchMine ? 'Waiting for rival' : 'Rematch'}</button>}</>}
      <button type="button" className="duel-leave" onClick={leaveDuel}>Leave duel</button>
    </section>}
    {status === 'fighting' && <button type="button" className="duel-leave small" onClick={leaveDuel}>Leave</button>}
    {camera === 'webcam' && status === 'fighting' && !duelLive.body && <p className="duel-feed" role="status">{camMessage}</p>}
  </main>;
}
