import { useEffect, useRef, useState } from 'react';
import {
  CALIBRATION_DURATION_MS,
  ELEMENT_META,
  P0_ELEMENTS,
  POSE_SEND_HZ,
  POSE_TRACK_HZ,
} from '@once-upon/shared';
import type { CalibrationBaseline, PoseFrame } from '@once-upon/shared';
import { VisionCanvas, type VisionCanvasModel } from './VisionCanvas';
import {
  ArmRaiseHoldDetector,
  WristVelocityTracker,
  actionBadgeLabel,
  buildPoseFrame,
  checkInZone,
  classifyDodgeAndPose,
  computeCalibrationBaseline,
  judgeTelegraphDefense,
  resolveActiveAction,
  type DefenseJudgment,
  type DodgeClassification,
  type P0AttackType,
  type WristGesture,
} from './poseClassifiers';
import { PoseLandmarkerService, type PoseServiceStatus, type VisionSourceMode } from './poseLandmarkerService';
import {
  SYNTHETIC_PRESET_LABEL,
  SYNTHETIC_PRESETS,
  sampleSyntheticPose,
  type SyntheticPosePreset,
} from './syntheticPoseGenerator';

/** Mount this view at `/vision-test`. The app shell is owned by another teammate. */
export const VISION_TEST_PATH = '/vision-test';

const PREVIEW_BASELINE = computeCalibrationBaseline(
  [sampleSyntheticPose('standing_in_zone', 0, { breathe: false })],
  0,
);

const IDLE_GESTURE: WristGesture = { action: 'none', power: 0, speed: 0, wrist: null };

const EMPTY_POSE: DodgeClassification = {
  isSideStepLeft: false,
  isSideStepRight: false,
  isDucking: false,
  isRightArmRaised: false,
  confidence: 0,
};

type TeammatePreview = 'off' | 'duck' | 'out_of_zone';

const TEAMMATE_LABEL: Record<TeammatePreview, string> = {
  off: 'Teammate hidden',
  duck: 'Teammate ducking',
  out_of_zone: 'Teammate out of zone',
};

function initialModel(): VisionCanvasModel {
  const landmarks = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
  const zone = PREVIEW_BASELINE ? checkInZone(landmarks, PREVIEW_BASELINE) : { inZone: false, overlapScore: 0 };
  return {
    source: 'synthetic',
    landmarks,
    baseline: PREVIEW_BASELINE,
    calibrated: false,
    inZone: zone.inZone,
    overlapScore: zone.overlapScore,
    activeAction: 'none',
    calibrationMs: 0,
    calibrating: false,
    streamHz: POSE_SEND_HZ,
    streamPulse: 0,
    teammatePoses: [],
    armHoldMs: 0,
    armCounting: false,
    confidence: 1,
    actionNote: '',
  };
}

function actionNoteFor(gesture: WristGesture, armHeldMs: number, counting: boolean): string {
  if (gesture.action === 'swipe_left') return 'LEFT';
  if (gesture.action === 'swipe_right') return 'RIGHT';
  if (gesture.action === 'thrust') return `${gesture.power.toFixed(2)}×`;
  if (counting) return `${(armHeldMs / 1000).toFixed(1)}s`;
  return '';
}

export function VisionTestPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<PoseLandmarkerService | null>(null);
  if (serviceRef.current === null) serviceRef.current = new PoseLandmarkerService();

  const trackerRef = useRef(new WristVelocityTracker());
  const armRef = useRef(new ArmRaiseHoldDetector());
  const baselineRef = useRef<CalibrationBaseline | null>(null);
  const calibratedRef = useRef(false);
  const calibratingRef = useRef(false);
  const calibrationStartedRef = useRef(0);
  const samplesRef = useRef<ReturnType<typeof sampleSyntheticPose>[]>([]);
  const poseRef = useRef<DodgeClassification>(EMPTY_POSE);
  const teammateRef = useRef<TeammatePreview>('off');
  const wheelRef = useRef(0);
  const modeRef = useRef<VisionSourceMode>('synthetic');
  const fallbackRef = useRef<string | null>(null);

  const [requestedMode, setRequestedMode] = useState<VisionSourceMode>('synthetic');
  const [status, setStatus] = useState<PoseServiceStatus>({
    mode: 'synthetic',
    requested: 'synthetic',
    landmarkerReady: false,
    fallbackReason: null,
  });
  const [model, setModel] = useState<VisionCanvasModel>(initialModel);
  const [preset, setPreset] = useState<SyntheticPosePreset>('standing_in_zone');
  const [wheelSlot, setWheelSlot] = useState(0);
  const [wheelNotice, setWheelNotice] = useState<{ id: number; label: string } | null>(null);
  const [defense, setDefense] = useState<DefenseJudgment | null>(null);
  const [parry, setParry] = useState(false);
  const [teammate, setTeammate] = useState<TeammatePreview>('off');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!wheelNotice) return;
    const timeout = window.setTimeout(() => setWheelNotice(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [wheelNotice]);

  useEffect(() => {
    const video = videoRef.current;
    const service = serviceRef.current;
    if (!video || !service) return;
    let cancelled = false;
    setStarting(true);
    void service.start(video, requestedMode).then(() => {
      if (cancelled) return;
      const next = service.getStatus();
      modeRef.current = next.mode;
      setStatus(next);
      setStarting(false);
    });
    return () => {
      cancelled = true;
      service.stop();
    };
  }, [requestedMode]);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;
    let raf = 0;
    let lastDetect = 0;
    let lastStream = 0;
    let streamPulse = 0;
    let teammatePoses: PoseFrame[] = [];
    const detectStep = 1000 / POSE_TRACK_HZ;
    const streamStep = 1000 / POSE_SEND_HZ;

    const tick = (now: number): void => {
      if (now - lastDetect >= detectStep) {
        lastDetect = now;
        const landmarks = service.sample(now);
        const baseline = baselineRef.current ?? PREVIEW_BASELINE;
        const pose = landmarks && baseline ? classifyDodgeAndPose(landmarks, baseline) : EMPTY_POSE;
        const zone = landmarks && baseline ? checkInZone(landmarks, baseline) : { inZone: false, overlapScore: 0 };
        const gesture = landmarks ? trackerRef.current.update(landmarks, now) : IDLE_GESTURE;
        const arm = armRef.current.update(pose.isRightArmRaised, now);
        poseRef.current = pose;

        if (arm.locked) {
          const nextSlot = (wheelRef.current + 1) % P0_ELEMENTS.length;
          wheelRef.current = nextSlot;
          const element = P0_ELEMENTS[nextSlot] ?? 'ember';
          setWheelSlot(nextSlot);
          setWheelNotice({ id: now, label: ELEMENT_META[element].label });
        }

        if (calibratingRef.current && landmarks) {
          samplesRef.current.push(landmarks);
          const elapsed = now - calibrationStartedRef.current;
          if (elapsed >= CALIBRATION_DURATION_MS) {
            const measured = computeCalibrationBaseline(samplesRef.current, now);
            calibratingRef.current = false;
            if (measured) {
              baselineRef.current = measured;
              calibratedRef.current = true;
            }
          }
        }

        if (now - lastStream >= streamStep) {
          lastStream = now;
          streamPulse += 1;
          const preview = teammateRef.current;
          if (preview === 'off' || !PREVIEW_BASELINE) {
            teammatePoses = [];
          } else {
            const teammateLandmarks = sampleSyntheticPose(preview, now);
            const teammateZone = checkInZone(teammateLandmarks, PREVIEW_BASELINE);
            const teammatePose = classifyDodgeAndPose(teammateLandmarks, PREVIEW_BASELINE);
            teammatePoses = [
              buildPoseFrame({
                playerId: 'Teammate',
                landmarks: teammateLandmarks,
                inZone: teammateZone.inZone,
                activeAction: resolveActiveAction(teammatePose, IDLE_GESTURE, teammatePose.isRightArmRaised),
                confidence: teammatePose.confidence,
                serverTimestampMs: now,
              }),
            ];
          }
        }

        const liveStatus = service.getStatus();
        if (liveStatus.mode !== modeRef.current || liveStatus.fallbackReason !== fallbackRef.current) {
          modeRef.current = liveStatus.mode;
          fallbackRef.current = liveStatus.fallbackReason;
          setStatus(liveStatus);
        }

        const calibrationMs = calibratingRef.current
          ? Math.min(CALIBRATION_DURATION_MS, now - calibrationStartedRef.current)
          : calibratedRef.current
            ? CALIBRATION_DURATION_MS
            : 0;

        setModel({
          source: liveStatus.mode,
          landmarks,
          baseline,
          calibrated: calibratedRef.current,
          inZone: zone.inZone,
          overlapScore: zone.overlapScore,
          activeAction: resolveActiveAction(pose, gesture, pose.isRightArmRaised),
          calibrationMs,
          calibrating: calibratingRef.current,
          streamHz: POSE_SEND_HZ,
          streamPulse,
          teammatePoses,
          armHoldMs: arm.heldMs,
          armCounting: arm.counting,
          confidence: pose.confidence,
          actionNote: actionNoteFor(gesture, arm.heldMs, arm.counting),
        });
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function beginCalibration(): void {
    const service = serviceRef.current;
    if (service && service.getStatus().mode === 'synthetic') {
      service.setPreset('standing_in_zone', performance.now(), true);
      setPreset('standing_in_zone');
    }
    samplesRef.current = [];
    calibrationStartedRef.current = performance.now();
    calibratingRef.current = true;
    trackerRef.current.reset();
  }

  function choosePreset(next: SyntheticPosePreset): void {
    setPreset(next);
    serviceRef.current?.setPreset(next, performance.now());
    trackerRef.current.reset();
  }

  function cycleTeammate(): void {
    const order: TeammatePreview[] = ['off', 'duck', 'out_of_zone'];
    const index = order.indexOf(teammateRef.current);
    const next = order[(index + 1) % order.length] ?? 'off';
    teammateRef.current = next;
    setTeammate(next);
  }

  function judge(attackType: P0AttackType): void {
    setDefense(judgeTelegraphDefense(attackType, poseRef.current, attackType === 'projectile' && parry));
  }

  const puppetLive = status.mode === 'synthetic';
  const activeElement = P0_ELEMENTS[wheelSlot] ?? 'ember';

  return (
    <main className="min-h-screen bg-[#07110d] text-amber-50">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-amber-200/70">Once Upon a Memory</p>
            <h1 className="font-serif text-3xl sm:text-4xl">Vision Lab</h1>
            <p className="mt-1 max-w-xl text-sm text-amber-100/70">
              Diagnostic for <code className="text-amber-100">{VISION_TEST_PATH}</code>. The same pose rules run on a
              webcam or on the cloud puppet.
            </p>
          </div>
          <div className="flex gap-2" data-testid="vision-mode">
            <button
              type="button"
              className={chipClass(requestedMode === 'webcam')}
              onClick={() => setRequestedMode('webcam')}
              disabled={starting}
            >
              Live Webcam
            </button>
            <button
              type="button"
              className={chipClass(requestedMode === 'synthetic')}
              onClick={() => setRequestedMode('synthetic')}
              disabled={starting}
            >
              Synthetic Puppet
            </button>
          </div>
        </header>

        {status.fallbackReason ? (
          <p className="rounded-2xl border border-amber-200/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100" role="status">
            {status.fallbackReason}
          </p>
        ) : null}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(18rem,0.9fr)]">
          <VisionCanvas model={model} videoRef={videoRef} />

          <div className="flex flex-col gap-5">
            <section className="rounded-3xl border border-white/10 bg-white/5 p-4">
              <h2 className="text-xs uppercase tracking-[0.2em] text-amber-200/70">Calibration</h2>
              <p className="mt-2 text-sm text-amber-100/75">
                Stand inside the outline for 3 seconds. Shoulder height and width become the zone.
              </p>
              <button
                type="button"
                className="mt-3 w-full rounded-full bg-amber-200 px-4 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
                onClick={beginCalibration}
                disabled={model.calibrating}
                data-testid="calibrate-button"
              >
                {model.calibrating ? 'Hold still…' : 'Calibrate standing pose (3s)'}
              </button>
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/5 p-4">
              <h2 className="text-xs uppercase tracking-[0.2em] text-amber-200/70">Telegraph defense</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {(['low_sweep', 'high_swing', 'projectile'] as const).map((attack) => (
                  <button key={attack} type="button" className={chipClass(false)} onClick={() => judge(attack)}>
                    {attack.replace('_', ' ')}
                  </button>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-amber-100/80">
                <input
                  type="checkbox"
                  checked={parry}
                  onChange={(event) => setParry(event.target.checked)}
                />
                Glove thumb parry (projectile)
              </label>
              <p className="mt-3 text-sm" data-testid="defense-result">
                {defense
                  ? `${defense.dodged ? 'DODGED' : 'HIT'} · ${defense.detail}`
                  : 'Trigger a telegraph to judge the pose you are holding.'}
              </p>
              <p className="mt-1 text-xs uppercase tracking-[0.14em] text-amber-200/60">
                Now: {actionBadgeLabel(model.activeAction)}
              </p>
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/5 p-4">
              <h2 className="text-xs uppercase tracking-[0.2em] text-amber-200/70">Spell wheel</h2>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {P0_ELEMENTS.map((element, index) => {
                  const meta = ELEMENT_META[element];
                  const active = index === wheelSlot;
                  return (
                    <div
                      key={element}
                      className={`rounded-2xl border px-2 py-3 text-center text-sm ${active ? 'text-stone-950' : 'text-amber-50/80'}`}
                      style={{
                        borderColor: meta.color,
                        background: active ? meta.color : 'transparent',
                      }}
                    >
                      {meta.label}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-sm text-amber-100/80" data-testid="wheel-status">
                {wheelNotice
                  ? `Locked ${wheelNotice.label}. One slot per raise.`
                  : `Hold the right arm up for 1 second to turn from ${ELEMENT_META[activeElement].label}.`}
              </p>
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/5 p-4">
              <h2 className="text-xs uppercase tracking-[0.2em] text-amber-200/70">Puppet</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {SYNTHETIC_PRESETS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={chipClass(preset === item)}
                    onClick={() => choosePreset(item)}
                    disabled={!puppetLive}
                    data-testid={`preset-${item}`}
                  >
                    {SYNTHETIC_PRESET_LABEL[item]}
                  </button>
                ))}
              </div>
              <button type="button" className={`${chipClass(teammate !== 'off')} mt-3`} onClick={cycleTeammate}>
                {TEAMMATE_LABEL[teammate]}
              </button>
              {!puppetLive ? (
                <p className="mt-2 text-xs text-amber-100/60">Puppet actions wait while the webcam is live.</p>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function chipClass(active: boolean): string {
  return active
    ? 'rounded-full border border-emerald-200/50 bg-emerald-300/20 px-3 py-2 text-sm text-emerald-50 disabled:opacity-40'
    : 'rounded-full border border-amber-100/20 bg-white/5 px-3 py-2 text-sm text-amber-50 disabled:opacity-40';
}
