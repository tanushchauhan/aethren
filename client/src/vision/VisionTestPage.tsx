import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CALIBRATION_DURATION_MS,
  ELEMENT_META,
  P0_ELEMENTS,
  POSE_SEND_HZ,
  POSE_TRACK_HZ,
} from '@once-upon/shared';
import type { CalibrationBaseline, NormalizedLandmark, PoseFrame } from '@once-upon/shared';
import { VisionCanvas, primeVisionAudio, type CombatOverlay, type VisionCanvasModel } from './VisionCanvas';
import {
  ArmRaiseHoldDetector,
  BODY_PART_LABEL,
  BODY_PART_TARGETS,
  STROBE_END_HZ,
  STROBE_START_HZ,
  WristVelocityTracker,
  actionBadgeLabel,
  buildPoseFrame,
  checkInZone,
  classifyDodgeAndPose,
  computeCalibrationBaseline,
  checkPartClearance,
  judgePartTarget,
  judgeTelegraphDefense,
  judgeZoneBlast,
  lockPartTarget,
  resolveActiveAction,
  resolveTorso,
  type BodyPartTarget,
  type DodgeClassification,
  type P0AttackType,
  type PartTarget,
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

/** Telegraph wind-up before the pose is judged. */
export const ATTACK_COUNTDOWN_MS = 3000;

/** On webcam, the 3 second calibration waits this long so the player can step back first. */
export const CALIBRATION_GET_READY_MS = 2000;

/** A live webcam body has to stay in view this long before the first automatic lock. */
const AUTO_CALIBRATE_AFTER_MS = 800;

/** Pause between attacks in the demo round, while the last result is on screen. */
const DEMO_GAP_MS = 1800;

const RESULT_FLASH_MS = 1600;

/** After a blast, the silhouette keeps calling the player back for up to this long. */
const BLAST_CALLBACK_MS = 4000;

/** Rings and bursts only need the burst window when the player is already home. */
const IMPACT_OVERLAY_MS = 900;

/** Synthetic frames fill the 16:9 canvas. Webcam frames use the video's own shape. */
const DEFAULT_FRAME_ASPECT = 16 / 9;

/** Instant calibration averages this many recent frames to smooth out jitter. */
const RECENT_FRAME_COUNT = 6;

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

const P0_ATTACKS: readonly P0AttackType[] = ['low_sweep', 'high_swing', 'projectile'];

const ATTACK_META: Record<P0AttackType, { label: string; cue: string; how: string }> = {
  low_sweep: {
    label: 'Low sweep',
    cue: 'STEP LEFT OR RIGHT NOW!',
    how: 'Step fully out of the box to either side.',
  },
  high_swing: {
    label: 'High swing',
    cue: 'DUCK NOW!',
    how: 'Bend your knees so your shoulders drop well below the line.',
  },
  projectile: {
    label: 'Projectile',
    cue: 'STEP ASIDE OR PARRY NOW!',
    how: 'Step out of the box, or tick the glove parry below.',
  },
};

/** Every attack the tester can throw. Classic telegraphs are the original P0 banner attacks. */
type IncomingAttack =
  | { kind: 'classic'; attack: P0AttackType }
  | { kind: 'part_ring'; part: BodyPartTarget }
  | { kind: 'zone_blast' };

interface AttackResult {
  kind: IncomingAttack['kind'];
  label: string;
  dodged: boolean;
  detail: string;
}

const RING_HOW: Record<BodyPartTarget, string> = {
  head: 'Tilt your head or duck to clear just your head.',
  left_shoulder: 'Lean or pull your left side away.',
  right_shoulder: 'Lean or pull your right side away.',
  chest: 'Step or lean so your shoulder line leaves the circle.',
};

const COMBO_WAVE: readonly IncomingAttack[] = [
  { kind: 'part_ring', part: 'head' },
  { kind: 'part_ring', part: 'left_shoulder' },
  { kind: 'part_ring', part: 'right_shoulder' },
  { kind: 'zone_blast' },
];

const CLASSIC_WAVE: readonly IncomingAttack[] = P0_ATTACKS.map((attack) => ({ kind: 'classic', attack }));

function attackLabel(incoming: IncomingAttack): string {
  if (incoming.kind === 'classic') return ATTACK_META[incoming.attack].label;
  if (incoming.kind === 'part_ring') return `Target ring: ${BODY_PART_LABEL[incoming.part]}`;
  return 'Silhouette blast';
}

function attackCue(incoming: IncomingAttack, clear: boolean): string {
  if (incoming.kind === 'classic') return clear ? 'CLEAR! HOLD IT!' : ATTACK_META[incoming.attack].cue;
  if (incoming.kind === 'part_ring') {
    const part = BODY_PART_LABEL[incoming.part].toUpperCase();
    return clear ? `CLEAR! KEEP YOUR ${part} OUT!` : `MOVE YOUR ${part} OUT OF THE CIRCLE!`;
  }
  return clear ? 'CLEAR! STAY OUT OF THE OUTLINE!' : 'STEP OR DUCK FULLY OUT OF YOUR SILHOUETTE!';
}

type ChecklistKey = 'stand' | 'step' | 'return' | 'duck' | 'wheel' | 'cast';

const CHECKLIST: readonly { key: ChecklistKey; title: string; hint: string }[] = [
  { key: 'stand', title: 'Stand in the zone', hint: 'Line your body up with the glowing outline until it turns green.' },
  { key: 'step', title: 'Step left or right out of the box', hint: 'Move your whole torso past either edge of the box.' },
  { key: 'return', title: 'Return to the silhouette', hint: 'Step back inside after a side step. Listen for the chime.' },
  { key: 'duck', title: 'Duck down', hint: 'Bend your knees so your shoulders drop clearly lower.' },
  {
    key: 'wheel',
    title: 'Hold your right hand above your head for 1s',
    hint: 'Keep it up until the bar fills. The spell wheel turns one slot.',
  },
  { key: 'cast', title: 'Swipe or punch a hand to cast', hint: 'A fast sideways swipe or a quick punch toward the camera.' },
];

type Checklist = Record<ChecklistKey, boolean>;

const EMPTY_CHECKLIST: Checklist = {
  stand: false,
  step: false,
  return: false,
  duck: false,
  wheel: false,
  cast: false,
};

type TeammatePreview = 'off' | 'duck' | 'out_of_zone';

const TEAMMATE_LABEL: Record<TeammatePreview, string> = {
  off: 'Teammate hidden',
  duck: 'Teammate ducking',
  out_of_zone: 'Teammate out of zone',
};

type CalibrationPhase = 'idle' | 'get_ready' | 'sampling';

type TrackingState = 'none' | 'upper' | 'full';

interface PendingAttack {
  incoming: IncomingAttack;
  /** The countdown banner starts here. Demo attacks after the first wait out a short gap. */
  startAt: number;
  judgeAt: number;
  /** A ring freezes on its body part the moment the warning starts, then stays put. */
  target: PartTarget | null;
}

interface ImpactRecord {
  incoming: IncomingAttack;
  target: PartTarget | null;
  dodged: boolean;
  at: number;
}

interface HudState {
  calibrationPhase: CalibrationPhase;
  /** Time left in the current calibration phase. */
  phaseRemainingMs: number;
  countdown: { incoming: IncomingAttack; remainingMs: number; waitingMs: number; clear: boolean; locking: boolean } | null;
  flash: AttackResult | null;
  tracking: TrackingState;
}

const IDLE_HUD: HudState = {
  calibrationPhase: 'idle',
  phaseRemainingMs: 0,
  countdown: null,
  flash: null,
  tracking: 'none',
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

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function VisionTestPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<PoseLandmarkerService | null>(null);
  if (serviceRef.current === null) serviceRef.current = new PoseLandmarkerService();

  const trackerRef = useRef(new WristVelocityTracker());
  const armRef = useRef(new ArmRaiseHoldDetector());
  const baselineRef = useRef<CalibrationBaseline | null>(null);
  const calibratedRef = useRef(false);
  const calPhaseRef = useRef<CalibrationPhase>('idle');
  const phaseStartedRef = useRef(0);
  const samplesRef = useRef<NormalizedLandmark[][]>([]);
  const recentRef = useRef<NormalizedLandmark[][]>([]);
  const autoCalibratedRef = useRef(false);
  const personSinceRef = useRef<number | null>(null);
  const poseRef = useRef<DodgeClassification>(EMPTY_POSE);
  const teammateRef = useRef<TeammatePreview>('off');
  const wheelRef = useRef(0);
  const modeRef = useRef<VisionSourceMode>('synthetic');
  const fallbackRef = useRef<string | null>(null);
  const checklistRef = useRef<Checklist>(EMPTY_CHECKLIST);
  const prevInZoneRef = useRef<boolean | null>(null);
  const parryRef = useRef(false);
  const pendingRef = useRef<PendingAttack | null>(null);
  const demoQueueRef = useRef<IncomingAttack[]>([]);
  const demoActiveRef = useRef(false);
  const flashRef = useRef<{ judgment: AttackResult; at: number } | null>(null);
  const impactRef = useRef<ImpactRecord | null>(null);
  const landmarksRef = useRef<NormalizedLandmark[] | null>(null);

  const [requestedMode, setRequestedMode] = useState<VisionSourceMode>('synthetic');
  const [status, setStatus] = useState<PoseServiceStatus>({
    mode: 'synthetic',
    requested: 'synthetic',
    landmarkerReady: false,
    fallbackReason: null,
  });
  const [model, setModel] = useState<VisionCanvasModel>(initialModel);
  const [hud, setHud] = useState<HudState>(IDLE_HUD);
  const [preset, setPreset] = useState<SyntheticPosePreset>('standing_in_zone');
  const [wheelSlot, setWheelSlot] = useState(0);
  const [wheelNotice, setWheelNotice] = useState<{ id: number; label: string } | null>(null);
  const [defense, setDefense] = useState<AttackResult | null>(null);
  const [parry, setParry] = useState(false);
  const [instantJudge, setInstantJudge] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [demoResults, setDemoResults] = useState<AttackResult[] | null>(null);
  const [demoTotal, setDemoTotal] = useState(0);
  const [guideOpen, setGuideOpen] = useState(true);
  const [checklist, setChecklist] = useState<Checklist>(EMPTY_CHECKLIST);
  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);
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

    // A zone locked on the puppet means nothing on the webcam, and the reverse.
    baselineRef.current = null;
    calibratedRef.current = false;
    calPhaseRef.current = 'idle';
    autoCalibratedRef.current = false;
    personSinceRef.current = null;
    recentRef.current = [];
    prevInZoneRef.current = null;
    checklistRef.current = EMPTY_CHECKLIST;
    setChecklist(EMPTY_CHECKLIST);
    setCalibrationNote(null);

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
        const liveStatus = service.getStatus();
        const landmarks = service.sample(now);
        const torso = landmarks ? resolveTorso(landmarks) : null;

        if (landmarks && torso) {
          recentRef.current.push(landmarks);
          if (recentRef.current.length > RECENT_FRAME_COUNT) recentRef.current.shift();
        }

        // Lock the zone on its own the first time a webcam player shows up.
        if (liveStatus.mode === 'webcam' && !autoCalibratedRef.current && !calibratedRef.current && torso) {
          if (personSinceRef.current === null) personSinceRef.current = now;
          if (calPhaseRef.current === 'idle' && now - personSinceRef.current >= AUTO_CALIBRATE_AFTER_MS) {
            autoCalibratedRef.current = true;
            lockBaseline(recentRef.current, now, 'Auto-locked the moment you appeared. Re-lock any time.');
          }
        } else if (!torso) {
          personSinceRef.current = null;
        }

        const baseline = baselineRef.current ?? PREVIEW_BASELINE;
        const pose = landmarks && baseline ? classifyDodgeAndPose(landmarks, baseline) : EMPTY_POSE;
        const zone = landmarks && baseline ? checkInZone(landmarks, baseline) : { inZone: false, overlapScore: 0 };
        const gesture = landmarks ? trackerRef.current.update(landmarks, now) : IDLE_GESTURE;
        const arm = armRef.current.update(pose.isRightArmRaised, now);
        poseRef.current = pose;
        landmarksRef.current = landmarks;

        if (arm.locked) {
          const nextSlot = (wheelRef.current + 1) % P0_ELEMENTS.length;
          wheelRef.current = nextSlot;
          const element = P0_ELEMENTS[nextSlot] ?? 'ember';
          setWheelSlot(nextSlot);
          setWheelNotice({ id: now, label: ELEMENT_META[element].label });
        }

        if (calPhaseRef.current === 'get_ready' && now - phaseStartedRef.current >= CALIBRATION_GET_READY_MS) {
          calPhaseRef.current = 'sampling';
          phaseStartedRef.current = now;
          samplesRef.current = [];
        }
        if (calPhaseRef.current === 'sampling') {
          if (landmarks) samplesRef.current.push(landmarks);
          if (now - phaseStartedRef.current >= CALIBRATION_DURATION_MS) {
            calPhaseRef.current = 'idle';
            lockBaseline(samplesRef.current, now, 'Locked from a 3 second average of your standing pose.');
          }
        }

        // Checklist rows only count against a real zone on the webcam.
        if (landmarks && (calibratedRef.current || liveStatus.mode === 'synthetic')) {
          const current = checklistRef.current;
          const next: Checklist = {
            stand: current.stand || zone.inZone,
            step: current.step || pose.isSideStepLeft || pose.isSideStepRight,
            return: current.return || (current.step && prevInZoneRef.current === false && zone.inZone),
            duck: current.duck || pose.isDucking,
            wheel: current.wheel || arm.locked,
            cast: current.cast || gesture.action !== 'none',
          };
          if (CHECKLIST.some(({ key }) => next[key] !== current[key])) {
            checklistRef.current = next;
            setChecklist(next);
          }
          prevInZoneRef.current = zone.inZone;
        }

        const pending = pendingRef.current;
        if (pending && pending.incoming.kind === 'part_ring' && !pending.target && now >= pending.startAt) {
          // No ring without a body to aim at. The countdown waits until the part is found.
          pending.target = landmarks ? lockPartTarget(landmarks, pending.incoming.part, frameAspect()) : null;
          pending.startAt = now;
          pending.judgeAt = now + ATTACK_COUNTDOWN_MS;
        }
        if (pending && now >= pending.judgeAt) {
          pendingRef.current = null;
          resolveAttack(pending, now);
        }
        const live = pendingRef.current;
        const liveClear = live && now >= live.startAt ? judgeAttack(live).dodged : false;

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

        if (liveStatus.mode !== modeRef.current || liveStatus.fallbackReason !== fallbackRef.current) {
          modeRef.current = liveStatus.mode;
          fallbackRef.current = liveStatus.fallbackReason;
          setStatus(liveStatus);
        }

        const phase = calPhaseRef.current;
        const phaseElapsed = now - phaseStartedRef.current;
        const calibrationMs =
          phase === 'sampling'
            ? Math.min(CALIBRATION_DURATION_MS, phaseElapsed)
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
          calibrating: phase === 'sampling',
          streamHz: POSE_SEND_HZ,
          streamPulse,
          teammatePoses,
          armHoldMs: arm.heldMs,
          armCounting: arm.counting,
          confidence: pose.confidence,
          actionNote: actionNoteFor(gesture, arm.heldMs, arm.counting),
          combat: combatOverlay(live, liveClear, zone.inZone, now),
        });

        const flash = flashRef.current;
        setHud({
          calibrationPhase: phase,
          phaseRemainingMs:
            phase === 'get_ready'
              ? CALIBRATION_GET_READY_MS - phaseElapsed
              : phase === 'sampling'
                ? CALIBRATION_DURATION_MS - phaseElapsed
                : 0,
          countdown: live
            ? {
                incoming: live.incoming,
                remainingMs: Math.max(0, live.judgeAt - now),
                waitingMs: Math.max(0, live.startAt - now),
                clear: liveClear,
                locking: live.incoming.kind === 'part_ring' && !live.target,
              }
            : null,
          flash: flash && now - flash.at < RESULT_FLASH_MS ? flash.judgment : null,
          tracking: !torso ? 'none' : pose.hipsEstimated ? 'upper' : 'full',
        });
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The loop reads everything through refs, so it is started once.
  }, []);

  /** Shared by instant, 3 second, and automatic calibration. Only touches refs and state setters. */
  function lockBaseline(samples: NormalizedLandmark[][], now: number, note: string): boolean {
    const measured = computeCalibrationBaseline(samples, now);
    if (!measured) {
      setCalibrationNote('No body found. Step into view so both shoulders are visible, then try again.');
      return false;
    }
    baselineRef.current = measured;
    calibratedRef.current = true;
    prevInZoneRef.current = null;
    trackerRef.current.reset();
    setCalibrationNote(note);
    return true;
  }

  function frameAspect(): number {
    const video = videoRef.current;
    if (modeRef.current === 'webcam' && video && video.videoWidth > 0 && video.videoHeight > 0) {
      return video.videoWidth / video.videoHeight;
    }
    return DEFAULT_FRAME_ASPECT;
  }

  /** The same call drives the live CLEAR indicator and the final verdict at 0.0s. */
  function judgeAttack(pending: PendingAttack): AttackResult {
    const { incoming } = pending;
    const label = attackLabel(incoming);
    if (incoming.kind === 'classic') {
      const judgment = judgeTelegraphDefense(
        incoming.attack,
        poseRef.current,
        incoming.attack === 'projectile' && parryRef.current,
      );
      return { kind: 'classic', label, dodged: judgment.dodged, detail: judgment.detail };
    }
    if (incoming.kind === 'zone_blast') {
      const judgment = judgeZoneBlast(poseRef.current);
      return { kind: 'zone_blast', label, dodged: judgment.dodged, detail: judgment.detail };
    }
    if (!pending.target) {
      return { kind: 'part_ring', label, dodged: false, detail: 'No body in view to aim at yet.' };
    }
    const clearance = checkPartClearance(landmarksRef.current, pending.target);
    const judgment = judgePartTarget(pending.target, clearance, parryRef.current);
    return { kind: 'part_ring', label, dodged: judgment.dodged, detail: judgment.detail };
  }

  /** Live ring or strobe while an attack runs, then the burst and the blast call-back pulse. */
  function combatOverlay(
    live: PendingAttack | null,
    clear: boolean,
    inZone: boolean,
    now: number,
  ): CombatOverlay | null {
    if (live && live.incoming.kind !== 'classic' && now >= live.startAt) {
      if (live.incoming.kind === 'part_ring' && !live.target) return null;
      return {
        kind: live.incoming.kind,
        startAt: live.startAt,
        judgeAt: live.judgeAt,
        target: live.target,
        clear,
        impact: null,
      };
    }
    const impact = impactRef.current;
    if (!impact || impact.incoming.kind === 'classic') return null;
    const age = now - impact.at;
    const keep =
      age < IMPACT_OVERLAY_MS || (impact.incoming.kind === 'zone_blast' && age < BLAST_CALLBACK_MS && !inZone);
    if (!keep) return null;
    return {
      kind: impact.incoming.kind,
      startAt: impact.at - ATTACK_COUNTDOWN_MS,
      judgeAt: impact.at,
      target: impact.target,
      clear: impact.dodged,
      impact: { at: impact.at, dodged: impact.dodged },
    };
  }

  /** Judges the held pose, flashes the result, and queues the next demo attack. */
  function resolveAttack(pending: PendingAttack, now: number): void {
    const judgment = judgeAttack(pending);
    setDefense(judgment);
    flashRef.current = { judgment, at: now };
    impactRef.current = { incoming: pending.incoming, target: pending.target, dodged: judgment.dodged, at: now };
    if (!demoActiveRef.current) return;

    setDemoResults((previous) => [...(previous ?? []), judgment]);
    const next = demoQueueRef.current.shift();
    if (next) {
      const startAt = now + DEMO_GAP_MS;
      pendingRef.current = { incoming: next, startAt, judgeAt: startAt + ATTACK_COUNTDOWN_MS, target: null };
    } else {
      demoActiveRef.current = false;
      setDemoActive(false);
    }
  }

  /** Uses frames the loop already sampled, so the landmarker never sees an out-of-order timestamp. */
  function instantCalibrate(): void {
    calPhaseRef.current = 'idle';
    lockBaseline([...recentRef.current], performance.now(), 'Locked around where you are standing right now.');
  }

  function beginCalibration(): void {
    const service = serviceRef.current;
    const webcam = service?.getStatus().mode === 'webcam';
    if (service && !webcam) {
      service.setPreset('standing_in_zone', performance.now(), true);
      setPreset('standing_in_zone');
    }
    samplesRef.current = [];
    phaseStartedRef.current = performance.now();
    calPhaseRef.current = webcam ? 'get_ready' : 'sampling';
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

  /** Rings always count down: an instant ring would lock on and judge the same frame. */
  function launchAttack(incoming: IncomingAttack): void {
    primeVisionAudio();
    const now = performance.now();
    const pending: PendingAttack = { incoming, startAt: now, judgeAt: now + ATTACK_COUNTDOWN_MS, target: null };
    if (instantJudge && incoming.kind !== 'part_ring') {
      resolveAttack(pending, now);
      return;
    }
    pendingRef.current = pending;
  }

  function startWave(wave: readonly IncomingAttack[]): void {
    primeVisionAudio();
    const now = performance.now();
    const [first, ...rest] = wave;
    if (!first) return;
    demoQueueRef.current = rest;
    demoActiveRef.current = true;
    setDemoActive(true);
    setDemoResults([]);
    setDemoTotal(wave.length);
    pendingRef.current = { incoming: first, startAt: now, judgeAt: now + ATTACK_COUNTDOWN_MS, target: null };
  }

  function cancelAttacks(): void {
    pendingRef.current = null;
    demoQueueRef.current = [];
    demoActiveRef.current = false;
    setDemoActive(false);
  }

  function resetChecklist(): void {
    checklistRef.current = EMPTY_CHECKLIST;
    prevInZoneRef.current = null;
    setChecklist(EMPTY_CHECKLIST);
  }

  function updateParry(next: boolean): void {
    parryRef.current = next;
    setParry(next);
  }

  const webcamLive = status.mode === 'webcam';
  const showPuppetControls = requestedMode === 'synthetic' || (status.mode === 'synthetic' && !starting);
  const activeElement = P0_ELEMENTS[wheelSlot] ?? 'ember';
  const doneCount = CHECKLIST.filter(({ key }) => checklist[key]).length;
  const calibrationBusy = hud.calibrationPhase !== 'idle';
  const attackBusy = hud.countdown !== null;
  const demoDodged = demoResults?.filter((result) => result.dodged).length ?? 0;

  return (
    <main className="min-h-screen bg-[#07110d] text-amber-50">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.28em] text-amber-200/70">Once Upon a Memory</p>
          <h1 className="font-serif text-3xl sm:text-4xl">Vision Lab</h1>
          <p className="max-w-2xl text-sm text-amber-100/75">
            Three quick steps: lock your play zone, try every body move, then survive a few enemy attacks. Works up
            close at a laptop (head and shoulders in view) or standing about 2 m back with your full body in frame.
          </p>
        </header>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
          <div className="flex flex-col gap-3 lg:sticky lg:top-4">
            {guideOpen ? (
              <AttackGuide compact onDismiss={() => setGuideOpen(false)} />
            ) : (
              <button
                type="button"
                className={`${chipClass(false)} self-start text-xs`}
                onClick={() => setGuideOpen(true)}
                data-testid="attack-guide-toggle"
              >
                Show attack guide (2 attack types)
              </button>
            )}
            <div className="relative">
              <VisionCanvas model={model} videoRef={videoRef} />
              <CanvasBanner hud={hud} />
            </div>
            <p className="text-xs text-amber-100/60">
              The glowing outline is your zone. The white skeleton is you. Badges on top show the move being read
              right now: <span className="text-amber-100">{actionBadgeLabel(model.activeAction)}</span>.
            </p>
          </div>

          <div className="flex flex-col gap-5">
            <StepCard
              step={1}
              title="Camera and calibration"
              done={model.calibrated}
              summary={model.calibrated ? 'Zone locked' : 'Not locked yet'}
            >
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

              {status.fallbackReason ? (
                <p
                  className="mt-3 rounded-2xl border border-amber-200/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-100"
                  role="status"
                >
                  {status.fallbackReason}
                </p>
              ) : null}

              <p className="mt-3 text-sm text-amber-100/80" data-testid="tracking-status">
                {starting
                  ? 'Starting the camera…'
                  : hud.tracking === 'none'
                    ? 'No body yet. Move until your head and both shoulders are on screen.'
                    : hud.tracking === 'upper'
                      ? 'Tracking your upper body. Hips are below the frame, so they are estimated.'
                      : 'Tracking your full body.'}
                {webcamLive && !model.calibrated && hud.tracking !== 'none'
                  ? ' Hold still, the zone locks automatically.'
                  : ''}
              </p>

              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  className="w-full rounded-full bg-amber-200 px-4 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
                  onClick={instantCalibrate}
                  disabled={calibrationBusy}
                  data-testid="instant-calibrate-button"
                >
                  Instant Calibrate (Lock Current Pose Now)
                </button>
                <button
                  type="button"
                  className="w-full rounded-full border border-amber-200/50 px-4 py-2 text-sm text-amber-50 disabled:opacity-50"
                  onClick={beginCalibration}
                  disabled={calibrationBusy}
                  data-testid="calibrate-button"
                >
                  {hud.calibrationPhase === 'get_ready'
                    ? `Get ready… sampling in ${seconds(hud.phaseRemainingMs)}`
                    : hud.calibrationPhase === 'sampling'
                      ? `Hold still… ${seconds(hud.phaseRemainingMs)}`
                      : `Calibrate standing pose (3s)${webcamLive ? ' with 2s to get ready' : ''}`}
                </button>
              </div>
              <p className="mt-2 text-xs text-amber-100/60" data-testid="calibration-note">
                {calibrationNote ??
                  (webcamLive
                    ? 'The zone locks on its own the first time you are seen. Use either button to re-lock it.'
                    : 'Instant locks around the puppet now. The 3 second option averages a still stand.')}
              </p>
            </StepCard>

            <StepCard
              step={2}
              title="Live body move checklist"
              done={doneCount === CHECKLIST.length}
              summary={`${doneCount} / ${CHECKLIST.length} moves`}
            >
              <p className="text-sm text-amber-100/75">Do each move. Rows turn green the moment it is read.</p>
              <ol className="mt-3 flex flex-col gap-2" data-testid="move-checklist">
                {CHECKLIST.map((item, index) => {
                  const done = checklist[item.key];
                  return (
                    <li
                      key={item.key}
                      data-testid={`check-${item.key}`}
                      data-done={done}
                      className={`flex items-start gap-3 rounded-2xl border px-3 py-2 transition-colors ${
                        done
                          ? 'border-emerald-200/50 bg-emerald-300/15 text-emerald-50'
                          : 'border-white/10 bg-black/20 text-amber-50/85'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                          done ? 'bg-emerald-300 text-stone-950' : 'border border-amber-100/30 text-amber-100/70'
                        }`}
                        aria-hidden
                      >
                        {done ? '✓' : index + 1}
                      </span>
                      <span>
                        <span className="block text-sm font-medium">{item.title}</span>
                        <span className="block text-xs opacity-70">{item.hint}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              {webcamLive && !model.calibrated ? (
                <p className="mt-2 text-xs text-amber-200/80">Finish Step 1 first so the moves have a zone to measure.</p>
              ) : null}

              <div className="mt-4 grid grid-cols-3 gap-2">
                {P0_ELEMENTS.map((element, index) => {
                  const meta = ELEMENT_META[element];
                  const active = index === wheelSlot;
                  return (
                    <div
                      key={element}
                      className={`rounded-2xl border px-2 py-2 text-center text-sm ${active ? 'text-stone-950' : 'text-amber-50/80'}`}
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
              <p className="mt-2 text-xs text-amber-100/70" data-testid="wheel-status">
                {wheelNotice
                  ? `Spell wheel turned to ${wheelNotice.label}. Lower your hand to turn it again.`
                  : `Spell wheel: ${ELEMENT_META[activeElement].label}. Raise your right hand for 1s to turn it.`}
              </p>
              <button type="button" className={`${chipClass(false)} mt-3`} onClick={resetChecklist}>
                Reset checklist
              </button>
            </StepCard>

            <StepCard
              step={3}
              title="Incoming enemy attack tester"
              done={demoResults !== null && !demoActive && demoTotal > 0 && demoResults.length === demoTotal}
              summary={
                demoResults && demoResults.length > 0
                  ? `${demoDodged} / ${demoResults.length} dodged`
                  : `${ATTACK_COUNTDOWN_MS / 1000}s warning`
              }
            >
              <AttackGuide />

              <p className="mt-3 text-sm text-amber-100/75">
                Pick an attack. It plays out on the video for {ATTACK_COUNTDOWN_MS / 1000} seconds and you are judged
                the instant it lands.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {BODY_PART_TARGETS.map((part) => (
                  <AttackButton
                    key={part}
                    testId={`attack-ring-${part}`}
                    title={`🎯 Osu! Ring → ${BODY_PART_LABEL[part]}`}
                    hint={RING_HOW[part]}
                    disabled={attackBusy}
                    onClick={() => launchAttack({ kind: 'part_ring', part })}
                  />
                ))}
                <AttackButton
                  testId="attack-zone-blast"
                  title="⚡ Flashing Silhouette Whole-Body Blast"
                  hint={`Step or duck completely out of your outline as the strobe speeds up from ${STROBE_START_HZ} to ${STROBE_END_HZ} Hz.`}
                  disabled={attackBusy}
                  onClick={() => launchAttack({ kind: 'zone_blast' })}
                />
              </div>

              <button
                type="button"
                className="mt-3 w-full rounded-full bg-gradient-to-r from-rose-400 via-amber-300 to-emerald-300 px-4 py-2 text-sm font-semibold text-stone-950 disabled:opacity-50"
                onClick={() => startWave(COMBO_WAVE)}
                disabled={attackBusy}
                data-testid="combo-wave-button"
              >
                {demoActive ? 'Wave running…' : `🔥 Auto-Play Combo Wave (${COMBO_WAVE.length} Attacks in a Row)`}
              </button>
              <p className="mt-1 text-xs text-amber-100/60">
                Head ring, left arm ring, right arm ring, then the silhouette blast. Step back and play.
              </p>
              {attackBusy ? (
                <button type="button" className={`${chipClass(false)} mt-2 w-full`} onClick={cancelAttacks}>
                  Cancel attack
                </button>
              ) : null}

              <details className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                <summary className="cursor-pointer text-xs uppercase tracking-[0.18em] text-amber-200/70">
                  Classic telegraphs
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {P0_ATTACKS.map((attack) => (
                    <AttackButton
                      key={attack}
                      testId={`attack-${attack}`}
                      title={ATTACK_META[attack].label}
                      hint={ATTACK_META[attack].how}
                      disabled={attackBusy}
                      onClick={() => launchAttack({ kind: 'classic', attack })}
                    />
                  ))}
                  <button
                    type="button"
                    className={`${chipClass(false)} w-full`}
                    onClick={() => startWave(CLASSIC_WAVE)}
                    disabled={attackBusy}
                    data-testid="demo-round-button"
                  >
                    Auto-Play 3-Attack Demo Round
                  </button>
                </div>
              </details>

              <div className="mt-3 flex flex-col gap-1 text-sm text-amber-100/80">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={parry} onChange={(event) => updateParry(event.target.checked)} />
                  Glove thumb parry (target rings and projectile)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={instantJudge}
                    onChange={(event) => setInstantJudge(event.target.checked)}
                    data-testid="instant-judge-toggle"
                  />
                  Judge now (instant, no countdown; rings always count down)
                </label>
              </div>

              <p className="mt-3 text-sm" data-testid="defense-result">
                {defense
                  ? `${defense.dodged ? 'DODGED' : 'HIT'} · ${defense.label}: ${defense.detail}`
                  : 'No attack yet. Pick one above, or step back and auto-play the combo wave.'}
              </p>
              {demoResults && demoResults.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="demo-results">
                  {demoResults.map((result, index) => (
                    <li key={`${result.label}-${index}`} className={result.dodged ? 'text-emerald-200' : 'text-rose-200'}>
                      {index + 1}. {result.label}: {result.dodged ? 'dodged' : 'hit'}
                    </li>
                  ))}
                  {!demoActive ? (
                    <li className="text-amber-100/80">
                      Round complete: {demoDodged} of {demoResults.length} dodged.
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </StepCard>

            <section className="rounded-3xl border border-white/10 bg-white/5 p-4">
              <h2 className="text-xs uppercase tracking-[0.2em] text-amber-200/70">Extras</h2>
              {showPuppetControls ? (
                <>
                  <p className="mt-2 text-xs text-amber-100/60">Puppet poses (Synthetic Puppet mode only).</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {SYNTHETIC_PRESETS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={chipClass(preset === item)}
                        onClick={() => choosePreset(item)}
                        data-testid={`preset-${item}`}
                      >
                        {SYNTHETIC_PRESET_LABEL[item]}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <button type="button" className={`${chipClass(teammate !== 'off')} mt-3`} onClick={cycleTeammate}>
                {TEAMMATE_LABEL[teammate]}
              </button>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function CanvasBanner({ hud }: { hud: HudState }) {
  let tone: 'gold' | 'green' | 'red' = 'gold';
  let headline: string | null = null;
  let detail: string | null = null;
  // Attack banners sit at the top so the ring and the silhouette stay visible.
  let placement: 'center' | 'top' = 'center';

  if (hud.countdown) {
    placement = 'top';
    const label = attackLabel(hud.countdown.incoming).toUpperCase();
    if (hud.countdown.waitingMs > 0) {
      headline = `NEXT: ${label}`;
      detail = `Get back in your zone. Warning starts in ${seconds(hud.countdown.waitingMs)}.`;
    } else if (hud.countdown.locking) {
      headline = `AIMING: ${label}`;
      detail = 'Step into view so the ring can lock on.';
    } else {
      tone = hud.countdown.clear ? 'green' : 'red';
      headline = `${label} IN ${seconds(hud.countdown.remainingMs)}`;
      detail = attackCue(hud.countdown.incoming, hud.countdown.clear);
    }
  } else if (hud.flash) {
    placement = hud.flash.kind === 'classic' ? 'center' : 'top';
    tone = hud.flash.dodged ? 'green' : 'red';
    headline = hud.flash.dodged ? 'DODGED!' : 'HIT!';
    detail = hud.flash.detail;
  } else if (hud.calibrationPhase === 'get_ready') {
    headline = `GET READY ${seconds(hud.phaseRemainingMs)}`;
    detail = 'Step into place and stand still.';
  } else if (hud.calibrationPhase === 'sampling') {
    headline = `HOLD STILL ${seconds(hud.phaseRemainingMs)}`;
    detail = 'Measuring your standing pose.';
  }

  if (!headline) return null;
  const toneClass =
    tone === 'green'
      ? 'border-emerald-200/60 bg-emerald-950/75 text-emerald-50'
      : tone === 'red'
        ? 'border-rose-300/60 bg-rose-950/75 text-rose-50'
        : 'border-amber-200/60 bg-stone-950/75 text-amber-50';
  const top = placement === 'top';

  return (
    <div
      className={`pointer-events-none absolute inset-0 flex justify-center p-6 ${top ? 'items-start pt-14' : 'items-center'}`}
      data-testid="canvas-banner"
    >
      <div
        className={`max-w-[90%] rounded-3xl border text-center shadow-2xl backdrop-blur-sm ${toneClass} ${
          top ? 'px-4 py-2' : 'px-6 py-4'
        }`}
      >
        <p className={`font-serif font-semibold tracking-wide ${top ? 'text-lg sm:text-2xl' : 'text-2xl sm:text-4xl'}`}>
          {headline}
        </p>
        {detail ? (
          <p className={`mt-1 font-medium tracking-[0.12em] ${top ? 'text-xs sm:text-sm' : 'text-sm sm:text-lg'}`}>
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RingIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-12 w-12 shrink-0" aria-hidden>
      <circle cx="24" cy="24" r="9" fill="rgba(255,45,85,0.3)" stroke="#ff2d55" strokeWidth="2.5">
        <animate attributeName="stroke" values="#ff2d55;#ff2d55;#34f5a0;#34f5a0" dur="2.4s" repeatCount="indefinite" />
        <animate
          attributeName="fill"
          values="rgba(255,45,85,0.3);rgba(255,45,85,0.3);rgba(52,245,160,0.25);rgba(52,245,160,0.25)"
          dur="2.4s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx="24" cy="24" r="2.5" fill="#fff" />
      <circle cx="24" cy="24" r="22" fill="none" stroke="#ffe2e2" strokeWidth="1.5">
        <animate attributeName="r" values="22;9" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function SilhouetteIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-12 w-12 shrink-0" aria-hidden>
      <g fill="none" strokeWidth="2.5" strokeLinecap="round" stroke="#ff2d55">
        <animate
          attributeName="stroke"
          values="#ff2d55;#34f5a0;#ff2d55;#34f5a0;#ff2d55;#34f5a0;#ff2d55;#34f5a0;#ff2d55;#ff2d55"
          keyTimes="0;0.25;0.42;0.55;0.65;0.73;0.8;0.86;0.9;1"
          calcMode="discrete"
          dur="2.4s"
          repeatCount="indefinite"
        />
        <rect x="8" y="4" width="32" height="40" rx="3" strokeDasharray="4 3" strokeWidth="1.5" />
        <circle cx="24" cy="13" r="5" />
        <path d="M15 22 L33 22 L30 38 L18 38 Z" />
      </g>
    </svg>
  );
}

/** Explains both attack types before the first one lands. `compact` is the legend above the canvas. */
function AttackGuide({ compact = false, onDismiss }: { compact?: boolean; onDismiss?: () => void }) {
  return (
    <section
      className="rounded-2xl border border-amber-100/15 bg-black/30 p-3"
      data-testid={compact ? 'attack-legend' : 'attack-guide'}
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200/80">
          How Incoming Attacks Work (2 Attack Types)
        </h3>
        {onDismiss ? (
          <button type="button" className="text-xs text-amber-100/60 hover:text-amber-50" onClick={onDismiss}>
            Hide
          </button>
        ) : null}
      </header>
      <div className={`grid gap-2 ${compact ? 'sm:grid-cols-2' : ''}`}>
        <div className="flex items-start gap-3 rounded-xl border border-rose-300/25 bg-rose-950/20 p-2">
          <RingIcon />
          <p className="text-xs text-amber-50/85">
            <span className="block text-sm font-semibold text-rose-100">🎯 Type 1: Osu! Body-Part Target Ring</span>
            {compact
              ? 'Move only the targeted part out of the circle before the outer ring closes.'
              : 'A glowing circle locks onto one part of your body (Head, Left Arm, Right Arm). Move ONLY that body part outside the inner circle before the shrinking outer ring touches it! Red means still inside, green means CLEAR.'}
          </p>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-emerald-300/25 bg-emerald-950/20 p-2">
          <SilhouetteIcon />
          <p className="text-xs text-amber-50/85">
            <span className="block text-sm font-semibold text-emerald-100">
              ⚡ Type 2: Flashing Silhouette Blast (Whole-Body)
            </span>
            {compact
              ? 'Your outline strobes red and green, faster and faster. Get your whole body out.'
              : 'Your silhouette outline starts flashing Red & Green faster and faster. Step or duck your whole body completely out of the silhouette before the flash peaks! It pulses gold afterwards to call you back.'}
          </p>
        </div>
      </div>
    </section>
  );
}

function AttackButton({
  testId,
  title,
  hint,
  disabled,
  onClick,
}: {
  testId: string;
  title: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex flex-col items-start rounded-2xl border border-amber-100/20 bg-white/5 px-3 py-2 text-left transition-colors hover:bg-white/10 disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-amber-100/65">{hint}</span>
    </button>
  );
}

function StepCard({
  step,
  title,
  done,
  summary,
  children,
}: {
  step: number;
  title: string;
  done: boolean;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-3xl border p-4 ${done ? 'border-emerald-200/40 bg-emerald-300/5' : 'border-white/10 bg-white/5'}`}
      data-testid={`step-${step}`}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${
              done ? 'bg-emerald-300 text-stone-950' : 'bg-amber-200 text-stone-950'
            }`}
          >
            {done ? '✓' : step}
          </span>
          Step {step}: {title}
        </h2>
        <span className={`text-xs ${done ? 'text-emerald-200' : 'text-amber-200/70'}`}>{summary}</span>
      </header>
      {children}
    </section>
  );
}

function chipClass(active: boolean): string {
  return active
    ? 'rounded-full border border-emerald-200/50 bg-emerald-300/20 px-3 py-2 text-sm text-emerald-50 disabled:opacity-40'
    : 'rounded-full border border-amber-100/20 bg-white/5 px-3 py-2 text-sm text-amber-50 disabled:opacity-40';
}
