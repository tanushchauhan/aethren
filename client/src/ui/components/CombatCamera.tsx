import { useEffect, useRef, useState } from 'react';
import type { CalibrationBaseline, NormalizedLandmark } from '@once-upon/shared';
import { PoseLandmarkerService } from '../../vision/poseLandmarkerService';
import { classifyDodgeAndPose, computeCalibrationBaseline, resolveTorso } from '../../vision/poseClassifiers';
import { DEFENSE_LABELS, useDefense } from '../../combat/defense';
import { useSpellBattle } from '../../combat/spellBattle';
import { DefenseProjection } from './DefenseProjection';
import './combat-camera.css';

export function CombatCamera() {
  const [on, setOn] = useState(false);
  const [message, setMessage] = useState('Use your movements to defend.');
  const [tracking, setTracking] = useState(false);
  const [landmarks, setLandmarks] = useState<NormalizedLandmark[] | null>(null);
  const [centered, setCentered] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const baseline = useRef<CalibrationBaseline | null>(null);
  const samples = useRef<NormalizedLandmark[][]>([]);
  const { cue, result, enabled, blockable, progress, windupMs } = useDefense();
  const action = useSpellBattle(state => state.enemyTurn?.action);
  const ownTurn = useSpellBattle(state => state.activeId === 'player' && !state.pending);
  const activeCue = action && action.phase !== 'returning' && cue;
  useEffect(() => {
    if (!on || !video.current) return;
    const service = new PoseLandmarkerService();
    let disposed = false, frame = 0, last = 0, videoTime = -1;
    baseline.current = null; samples.current = [];
    setMessage('Starting camera…');
    const tick = (now: number) => {
      if (disposed) return;
      if (now - last > 50 && !document.hidden && video.current && video.current.currentTime !== videoTime) {
        last = now; videoTime = video.current.currentTime;
        try {
          const landmarks = service.sample(now);
          // The lab's synthetic fallback must never defend on behalf of a real player.
          if (service.getStatus().mode !== 'webcam') throw new Error('Camera tracking stopped. Disable and enable the camera to retry.');
          const valid = landmarks && resolveTorso(landmarks);
          if (valid && landmarks) setLandmarks(landmarks);
          if (!valid) {
            samples.current = []; setTracking(false);
            useDefense.getState().sample(null, now);
            setMessage('Move into view: show your head, shoulders and hands.');
          } else if (!baseline.current) {
            samples.current.push(landmarks);
            setMessage(`Stand centered with arms down · ${Math.min(100, Math.round(samples.current.length / 25 * 100))}%`);
            if (samples.current.length >= 25) {
              const candidate = computeCalibrationBaseline(samples.current, now);
              const centers = samples.current.map(points => (points[11].x + points[12].x) / 2);
              if (candidate && Math.max(...centers) - Math.min(...centers) < .06) {
                baseline.current = candidate; useDefense.getState().setEnabled(true);
              } else { samples.current = []; setMessage('Hold still briefly to calibrate.'); }
            }
          } else {
            const pose = classifyDodgeAndPose(landmarks, baseline.current);
            useDefense.getState().sample(pose, now);
            setTracking(pose.confidence >= .6);
            setCentered(Math.abs((valid.leftShoulder.x + valid.rightShoulder.x) / 2 - baseline.current.centerX) < baseline.current.shoulderWidth * .35 && Math.abs((valid.leftShoulder.y + valid.rightShoulder.y) / 2 - baseline.current.shoulderY) < .08);
            setMessage(pose.confidence < .6 ? 'Tracking uncertain — show your shoulders and hands.' : pose.isSideStepLeft ? 'Leaning left' : pose.isSideStepRight ? 'Leaning right' : pose.isDucking ? 'Ducking' : pose.isRightArmRaised ? 'Guard raised' : 'Tracking · centered');
          }
        } catch (error) {
          useDefense.getState().setEnabled(false); setTracking(false);
          setMessage(error instanceof Error ? error.message : 'Camera unavailable.');
          service.stop(); return;
        }
      }
      if (now - last > 350) { useDefense.getState().sample(null, now); setTracking(false); }
      frame = requestAnimationFrame(tick);
    };
    void service.start(video.current, 'webcam').then(mode => {
      if (disposed) { service.stop(); return; }
      if (mode !== 'webcam') {
        setMessage('Camera unavailable. Check camera permission, then disable and retry.'); service.stop(); return;
      }
      frame = requestAnimationFrame(tick);
    }).catch(() => { if (!disposed) setMessage('Camera could not start. Disable and retry.'); });
    return () => { disposed = true; cancelAnimationFrame(frame); service.stop(); useDefense.getState().setEnabled(false); };
  }, [on]);
  const recalibrate = () => { baseline.current = null; samples.current = []; setTracking(false); useDefense.getState().setEnabled(false); };
  const showProjection = on && enabled && activeCue && landmarks && baseline.current;
  const warning = on && (!enabled || !tracking || (ownTurn && !centered));
  return <section className="combat-defense" aria-label="Movement defense">
    <video className="defense-hidden-video" ref={video} muted playsInline autoPlay aria-hidden="true" />
    <button className="defense-camera-toggle" disabled={!on && !ownTurn} onClick={() => { setOn(!on); if (on) setMessage('Camera off.'); }}>{on ? 'Disable tracking' : 'Enable movement tracking'}</button>
    {warning && <div className="defense-tracking-prompt" role="status">
      <span>{enabled && tracking && !centered ? 'Return to center' : message}</span>
      <button disabled={!ownTurn} onClick={recalibrate}>Recalibrate{!ownTurn ? ' on your turn' : ''}</button>
    </div>}
    {showProjection && <div className={`defense-encounter-overlay ${result ?? ''}`}>
      <DefenseProjection key={action!.id} landmarks={landmarks} baseline={baseline.current!} cue={activeCue} progress={progress}
        approaching={action!.phase === 'approaching'} windupMs={windupMs} result={result} tracking={tracking} />
      <div className="defense-impact-caption" role="status">
        <small>{!tracking ? 'Tracking lost — move into view' : result ? 'Impact' : centered ? 'Tracking centered · incoming' : 'Tracking movement'}</small>
        <strong>{result ? result === 'hit' ? 'Hit' : result === 'dodged' ? 'Dodged!' : 'Blocked' : DEFENSE_LABELS[activeCue]}</strong>
        {!result && <small>{blockable && activeCue !== 'block' ? 'Or raise your right arm to block' : activeCue === 'block' ? 'Hold your guard until the rings meet' : 'Grab incoming · dodge only'}</small>}
      </div>
    </div>}
  </section>;
}
