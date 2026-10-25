import { useEffect, useRef, useState } from 'react';
import type { CalibrationBaseline, NormalizedLandmark } from '@once-upon/shared';
import { PoseLandmarkerService } from '../vision/poseLandmarkerService';
import { VisionCanvas, type VisionCanvasModel } from '../vision/VisionCanvas';
import { checkInZone, classifyDodgeAndPose, computeCalibrationBaseline, judgeTelegraphDefense, resolveActiveAction, WristVelocityTracker } from '../vision/poseClassifiers';
import type { SyntheticPosePreset } from '../vision/syntheticPoseGenerator';
import { getServerNow, useGameStore } from '../net/store';
import { defenseWindow } from './defenseWindow';
const initial: VisionCanvasModel = { source: 'webcam', landmarks: null, baseline: null, calibrated: false, inZone: false, overlapScore: 0, activeAction: 'none', calibrationMs: 0, calibrating: false, streamHz: 15, streamPulse: 0, teammatePoses: [], armHoldMs: 0, armCounting: false, confidence: 0, actionNote: '' };
export function GameVision() {
  const video = useRef<HTMLVideoElement>(null);
  const service = useRef<PoseLandmarkerService | null>(null);
  const baseline = useRef<CalibrationBaseline | null>(null);
  const samples = useRef<NormalizedLandmark[][]>([]);
  const calibratingAt = useRef<number | null>(null);
  const enabled = useRef(false);
  const generation = useRef(0);
  const [model, setModel] = useState(initial);
  const [status, setStatus] = useState('Enable your camera, then stand still to set your casting zone.');
  const [starting, setStarting] = useState(false);
  const mock = useGameStore(s => s.mockMode);
  const phase = useGameStore(s => s.gameState?.phase);
  const attack = useGameStore(s => s.latestTelegraph);
  const combatPhase = useGameStore(s => s.gameState?.combatPhase);
  async function start(mode: 'webcam' | 'synthetic') {
    if (!video.current) return;
    const token = ++generation.current;
    enabled.current = false; baseline.current = null; calibratingAt.current = null;
    setModel(initial); setStarting(true); service.current?.stop();
    const next = new PoseLandmarkerService(); service.current = next;
    try {
      const actual = await next.start(video.current, mode);
      if (generation.current !== token) { next.stop(); return; }
      if (mode === 'webcam' && actual !== 'webcam') { setStatus(`${next.getStatus().fallbackReason || 'Camera unavailable.'} Retry your camera${mock ? ' or use practice controls.' : '.'}`); next.stop(); return; }
      enabled.current = true;
      setStatus(mode === 'synthetic' ? 'Practice controls enabled. Calibrate, then use the movement buttons.' : 'Camera ready. Stand where your head and torso are visible, then calibrate.');
    } catch { setStatus('Camera could not start. Check permissions and try again.'); }
    finally { if (generation.current === token) setStarting(false); }
  }
  useEffect(() => {
    const tracker = new WristVelocityTracker();
    let raf = 0, last = 0, pulse = 0;
    let lastParry = false, parryAt = Number.NEGATIVE_INFINITY;
    let judgment = { id: '', dodged: false, parried: false, sent: false };
    const tick = (now: number) => {
      if (now - last >= 1000 / 15) {
        last = now;
        const store = useGameStore.getState();
        const source = service.current?.getStatus().mode ?? 'webcam';
        if (enabled.current && service.current?.getStatus().requested === 'webcam' && source !== 'webcam') {
          enabled.current = false; baseline.current = null; setStatus('Camera tracking stopped. Retry and recalibrate.');
        }
        const landmarks = enabled.current && !document.hidden ? service.current?.sample(now) ?? null : null;
        if (calibratingAt.current !== null) {
          if (landmarks) samples.current.push(landmarks);
          else { samples.current = []; calibratingAt.current = now; }
          if (now - calibratingAt.current >= 3000) {
            baseline.current = computeCalibrationBaseline(samples.current, now); calibratingAt.current = null;
            setStatus(baseline.current ? 'Zone set. Dodge, then return to your outline to cast.' : 'No stable pose found. Face the camera and calibrate again.');
          }
        }
        const pose = landmarks && baseline.current ? classifyDodgeAndPose(landmarks, baseline.current) : null;
        const zone = landmarks && baseline.current ? checkInZone(landmarks, baseline.current) : { inZone: false, overlapScore: 0 };
        const gesture = landmarks && baseline.current ? tracker.update(landmarks, now) : null;
        if (!landmarks) tracker.reset();
        const action = pose && gesture ? resolveActiveAction(pose, gesture, pose.isRightArmRaised) : 'none';
        store.sendPose(landmarks ?? [], zone.inZone, action, pose?.confidence ?? 0);
        if (gesture && gesture.action !== 'none' && store.gameState?.combatPhase === 'team_turn' && zone.inZone) {
          window.dispatchEvent(new CustomEvent('ouam:gesture', { detail: { gesture: gesture.action === 'thrust' ? 'thrust' : 'swipe' } }));
        }
        const parryPressed = store.hardware?.armed === true && store.hardware.parryTriggered;
        if (parryPressed && !lastParry) parryAt = getServerNow();
        lastParry = parryPressed;
        const tele = store.latestTelegraph;
        if (tele) {
          if (judgment.id !== tele.attackId) judgment = { id: tele.attackId, dodged: false, parried: false, sent: false };
          const timing = defenseWindow(tele, getServerNow(), store.localPlayerId);
          if (timing.targeted && timing.sampling && pose) {
            const parry = tele.attackType === 'projectile' && parryAt >= tele.impactServerMs && parryAt <= tele.impactServerMs + tele.windowMs;
            judgment.dodged ||= judgeTelegraphDefense(tele.attackType, pose, parry).dodged; judgment.parried ||= parry;
          }
          if (timing.targeted && timing.reportable && !judgment.sent) {
            judgment.sent = true;
            store.sendDodge({ attackId: tele.attackId, dodged: judgment.dodged, parried: judgment.parried, serverTimestampMs: getServerNow() });
            setStatus(judgment.dodged ? 'Dodged! Return to your outline and prepare to cast.' : 'Hit taken. Watch the cue and move during the next attack.');
          }
        }
        setModel({ ...initial, source, landmarks, baseline: baseline.current, calibrated: !!baseline.current,
          calibrating: calibratingAt.current !== null, calibrationMs: calibratingAt.current !== null ? now - calibratingAt.current : baseline.current ? 3000 : 0,
          inZone: zone.inZone, overlapScore: zone.overlapScore, activeAction: action, streamPulse: ++pulse, confidence: pose?.confidence ?? 0 });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); generation.current++; enabled.current = false; service.current?.stop(); };
  }, []);
  function calibrate() {
    samples.current = []; baseline.current = null; calibratingAt.current = performance.now();
    if (service.current?.getStatus().mode === 'synthetic') service.current.setPreset('standing_in_zone', performance.now(), true);
    setStatus('Stand still for three seconds…');
  }
  function move(preset: SyntheticPosePreset) { service.current?.setPreset(preset, performance.now(), true); }
  const cue = attack && (combatPhase === 'telegraph' || combatPhase === 'defense') ? attack.narratorHint : phase === 'calibrating' ? 'Set your casting zone' : 'Return to the outline to cast';
  return <aside className="game-camera" aria-label="Camera and movement">
    <header><span className="vn-chapter">Your spellbearer</span><h2>Move to make magic</h2></header>
    <VisionCanvas model={model} videoRef={video} />
    <p className="camera-cue" aria-live="polite">{cue}</p><p className="camera-status" role="status">{status}</p>
    <div className="camera-buttons"><button disabled={starting} onClick={() => void start('webcam')}>{starting ? 'Opening camera…' : 'Enable camera'}</button><button disabled={!enabled.current || model.calibrating} onClick={calibrate}>{model.calibrating ? 'Calibrating…' : 'Calibrate zone'}</button>{mock && <button disabled={starting} onClick={() => void start('synthetic')}>Practice without camera</button>}</div>
    {mock && enabled.current && model.source === 'synthetic' && <div className="camera-buttons" aria-label="Practice movement"><button onClick={() => move('side_step_left')}>Step left</button><button onClick={() => move('duck')}>Duck</button><button onClick={() => move('standing_in_zone')}>Return to zone</button></div>}
    {phase === 'calibrating' && <button className="camera-begin" disabled={!model.calibrated || !model.inZone} onClick={() => useGameStore.getState().setPhase('encounter', 'idle')}>{mock ? 'Begin training' : 'Ready for training'}</button>}
    <p className="camera-status">Side-step sweeps and projectiles. Duck high swings. Video stays on this device; only pose points are shared.</p>
  </aside>;
}
