import { POSE_LANDMARK_COUNT, POSE_TRACK_HZ } from '@aethren/shared';
import type { NormalizedLandmark } from '@aethren/shared';

/**
 * Cloud / no-webcam puppet. Landmarks use MediaPipe image space:
 * the person faces the camera, so their right side has smaller x.
 * A mirrored preview flips x, which puts the player's left step on the left of the screen.
 */
export type SyntheticPosePreset =
  | 'standing_in_zone'
  | 'side_step_left'
  | 'side_step_right'
  | 'duck'
  | 'arm_raise'
  | 'swipe_left'
  | 'swipe_right'
  | 'thrust'
  | 'out_of_zone';

export const SYNTHETIC_PRESETS: readonly SyntheticPosePreset[] = [
  'standing_in_zone',
  'side_step_left',
  'side_step_right',
  'duck',
  'arm_raise',
  'swipe_left',
  'swipe_right',
  'thrust',
  'out_of_zone',
];

export const SYNTHETIC_PRESET_LABEL: Record<SyntheticPosePreset, string> = {
  standing_in_zone: 'Standing',
  side_step_left: 'Step Left',
  side_step_right: 'Step Right',
  duck: 'Duck',
  arm_raise: 'Raise Right Arm',
  swipe_left: 'Swipe Left',
  swipe_right: 'Swipe Right',
  thrust: 'Thrust',
  out_of_zone: 'Out of Zone',
};

/** Canonical standing body, normalized to the frame. Shoulder width is `shoulderHalf * 2`. */
export const SYNTHETIC_BODY = {
  centerX: 0.5,
  shoulderHalf: 0.09,
  hipHalf: 0.075,
  shoulderY: 0.34,
  hipY: 0.56,
  noseY: 0.2,
} as const;

/** Gesture cycle. The strike is fast; the recovery is slow so it does not read as the opposite swipe. */
export const SYNTHETIC_GESTURE_CYCLE_MS = 1100;
export const SYNTHETIC_STRIKE_START_MS = 220;
export const SYNTHETIC_STRIKE_END_MS = 460;

export interface SyntheticSampleOptions {
  /** Subtle breathing and sway. Off for exact calibration fixtures. */
  breathe?: boolean;
  /** 0 is a neutral stand. 1 is the full preset. */
  intensity?: number;
}

export interface SyntheticPoseFrame {
  preset: SyntheticPosePreset;
  timestampMs: number;
  landmarks: NormalizedLandmark[];
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface WristOffset extends Vec3 {
  side: 'left' | 'right';
}

interface MotionSample {
  translateX: number;
  duck: number;
  armRaise: number;
  shoulderScale: number;
  translateZ: number;
  wrist: WristOffset | null;
}

interface BodyMetrics {
  centerX: number;
  shoulderHalf: number;
  hipHalf: number;
  shoulderY: number;
  hipY: number;
  noseY: number;
}

const STANDING_MOTION: MotionSample = {
  translateX: 0,
  duck: 0,
  armRaise: 0,
  shoulderScale: 1,
  translateZ: 0,
  wrist: null,
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function breathOffset(timestampMs: number): { x: number; y: number } {
  const seconds = timestampMs / 1000;
  return {
    y: Math.sin(seconds * Math.PI * 2 * 0.28) * 0.0035,
    x: Math.sin(seconds * Math.PI * 2 * 0.13) * 0.0015,
  };
}

/**
 * Linear strike from `from` to `to` between the strike marks, then a slow return.
 * Wind-up eases a short distance the other way so the hit has a tell.
 */
function strikeValue(timestampMs: number, from: number, to: number, windup: number): number {
  const t = timestampMs % SYNTHETIC_GESTURE_CYCLE_MS;
  if (t < SYNTHETIC_STRIKE_START_MS) {
    const p = t / SYNTHETIC_STRIKE_START_MS;
    return from + (windup - from) * p;
  }
  if (t < SYNTHETIC_STRIKE_END_MS) {
    const p = (t - SYNTHETIC_STRIKE_START_MS) / (SYNTHETIC_STRIKE_END_MS - SYNTHETIC_STRIKE_START_MS);
    return windup + (to - windup) * p;
  }
  const p = (t - SYNTHETIC_STRIKE_END_MS) / (SYNTHETIC_GESTURE_CYCLE_MS - SYNTHETIC_STRIKE_END_MS);
  return to + (from - to) * p;
}

function swipeWrist(timestampMs: number, direction: 1 | -1): WristOffset {
  const x = strikeValue(timestampMs, 0, direction * 0.4, direction * -0.05);
  const y = strikeValue(timestampMs, 0, -0.08, 0.02);
  const z = strikeValue(timestampMs, 0, -0.03, 0.015);
  return { side: 'right', x, y, z };
}

function motionFor(preset: SyntheticPosePreset, timestampMs: number): MotionSample {
  switch (preset) {
    case 'standing_in_zone':
      return STANDING_MOTION;
    case 'side_step_left':
      return { ...STANDING_MOTION, translateX: 0.28 };
    case 'side_step_right':
      return { ...STANDING_MOTION, translateX: -0.28 };
    case 'duck':
      return { ...STANDING_MOTION, duck: 0.2 };
    case 'arm_raise':
      return { ...STANDING_MOTION, armRaise: 1 };
    case 'out_of_zone':
      return { ...STANDING_MOTION, translateX: 0.12 };
    case 'swipe_left':
      return { ...STANDING_MOTION, wrist: swipeWrist(timestampMs, 1) };
    case 'swipe_right':
      return { ...STANDING_MOTION, wrist: swipeWrist(timestampMs, -1) };
    case 'thrust':
      return {
        ...STANDING_MOTION,
        shoulderScale: strikeValue(timestampMs, 1, 1.28, 1),
        translateZ: strikeValue(timestampMs, 0, -0.36, 0.03),
        wrist: {
          side: 'right',
          x: 0,
          y: strikeValue(timestampMs, 0, -0.1, 0.02),
          z: 0,
        },
      };
    default: {
      const neverPreset: never = preset;
      return neverPreset;
    }
  }
}

function applyIntensity(motion: MotionSample, intensity: number): MotionSample {
  const t = clamp01(intensity);
  return {
    translateX: motion.translateX * t,
    duck: motion.duck * t,
    armRaise: motion.armRaise * t,
    shoulderScale: 1 + (motion.shoulderScale - 1) * t,
    translateZ: motion.translateZ * t,
    wrist: motion.wrist
      ? {
          side: motion.wrist.side,
          x: motion.wrist.x * t,
          y: motion.wrist.y * t,
          z: motion.wrist.z * t,
        }
      : null,
  };
}

function point(x: number, y: number, z: number): NormalizedLandmark {
  return { x, y, z, visibility: 0.99 };
}

function blendPoint(from: Vec3, to: Vec3, t: number): Vec3 {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    z: lerp(from.z, to.z, t),
  };
}

export type SilhouetteMetrics = BodyMetrics;

/**
 * Build the 33-landmark puppet. `metrics` defaults to {@link SYNTHETIC_BODY}
 * so a calibrated outline can reuse the same skeleton at the player's scale.
 */
export function buildSyntheticSkeleton(
  motion: MotionSample,
  timestampMs: number,
  breathe: boolean,
  metrics: BodyMetrics = SYNTHETIC_BODY,
): NormalizedLandmark[] {
  const breath = breathe ? breathOffset(timestampMs) : { x: 0, y: 0 };
  const centerX = metrics.centerX + motion.translateX + breath.x;
  const shoulderHalf = metrics.shoulderHalf * motion.shoulderScale;
  const hipHalf = metrics.hipHalf * (1 + (motion.shoulderScale - 1) * 0.45);
  const shoulderY = metrics.shoulderY + motion.duck + breath.y;
  const hipY = metrics.hipY + motion.duck * 0.35 + breath.y * 0.3;
  const noseY = metrics.noseY + motion.duck * 0.85 + breath.y * 1.1;
  const z = motion.translateZ;
  // Face and limb offsets were tuned on the default body. A calibrated outline rescales them so a
  // wide or narrow player gets a head and arms in proportion, not a fixed-size face.
  const s = metrics.shoulderHalf / SYNTHETIC_BODY.shoulderHalf;

  const landmarks: NormalizedLandmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, () =>
    point(centerX, 0.5, z),
  );
  const set = (index: number, landmark: NormalizedLandmark): void => {
    landmarks[index] = landmark;
  };

  set(0, point(centerX, noseY, z));
  set(1, point(centerX + 0.015 * s, noseY - 0.018 * s, z - 0.01));
  set(2, point(centerX + 0.028 * s, noseY - 0.02 * s, z - 0.01));
  set(3, point(centerX + 0.042 * s, noseY - 0.018 * s, z - 0.005));
  set(4, point(centerX - 0.015 * s, noseY - 0.018 * s, z - 0.01));
  set(5, point(centerX - 0.028 * s, noseY - 0.02 * s, z - 0.01));
  set(6, point(centerX - 0.042 * s, noseY - 0.018 * s, z - 0.005));
  set(7, point(centerX + 0.055 * s, noseY - 0.01 * s, z + 0.01));
  set(8, point(centerX - 0.055 * s, noseY - 0.01 * s, z + 0.01));
  set(9, point(centerX + 0.018 * s, noseY + 0.02 * s, z - 0.005));
  set(10, point(centerX - 0.018 * s, noseY + 0.02 * s, z - 0.005));

  const leftShoulder = point(centerX + shoulderHalf, shoulderY, z);
  const rightShoulder = point(centerX - shoulderHalf, shoulderY, z);
  set(11, leftShoulder);
  set(12, rightShoulder);

  let leftElbow: Vec3 = { x: centerX + shoulderHalf + 0.03 * s, y: shoulderY + 0.12 * s, z: z - 0.02 };
  let leftWrist: Vec3 = { x: centerX + shoulderHalf + 0.045 * s, y: shoulderY + 0.24 * s, z: z - 0.04 };
  let rightElbow: Vec3 = { x: centerX - shoulderHalf - 0.03 * s, y: shoulderY + 0.12 * s, z: z - 0.02 };
  let rightWrist: Vec3 = { x: centerX - shoulderHalf - 0.045 * s, y: shoulderY + 0.24 * s, z: z - 0.04 };

  if (motion.duck > 0) {
    leftElbow = { ...leftElbow, y: leftElbow.y + motion.duck * 0.25 };
    leftWrist = { ...leftWrist, y: leftWrist.y + motion.duck * 0.12 };
    rightElbow = { ...rightElbow, y: rightElbow.y + motion.duck * 0.25 };
    rightWrist = { ...rightWrist, y: rightWrist.y + motion.duck * 0.12 };
  }

  if (motion.armRaise > 0) {
    const raisedElbow = { x: centerX - shoulderHalf - 0.01 * s, y: shoulderY - 0.16 * s, z: z - 0.03 };
    const raisedWrist = { x: centerX - shoulderHalf + 0.01 * s, y: noseY - 0.14 * s, z: z - 0.05 };
    rightElbow = blendPoint(rightElbow, raisedElbow, motion.armRaise);
    rightWrist = blendPoint(rightWrist, raisedWrist, motion.armRaise);
  }

  if (motion.wrist) {
    const apply = motion.wrist.side === 'left';
    if (apply) {
      leftWrist = {
        x: leftWrist.x + motion.wrist.x,
        y: leftWrist.y + motion.wrist.y,
        z: leftWrist.z + motion.wrist.z,
      };
      leftElbow = {
        x: leftElbow.x + motion.wrist.x * 0.45,
        y: leftElbow.y + motion.wrist.y * 0.45,
        z: leftElbow.z + motion.wrist.z * 0.45,
      };
    } else {
      rightWrist = {
        x: rightWrist.x + motion.wrist.x,
        y: rightWrist.y + motion.wrist.y,
        z: rightWrist.z + motion.wrist.z,
      };
      rightElbow = {
        x: rightElbow.x + motion.wrist.x * 0.45,
        y: rightElbow.y + motion.wrist.y * 0.45,
        z: rightElbow.z + motion.wrist.z * 0.45,
      };
    }
  }

  set(13, point(leftElbow.x, leftElbow.y, leftElbow.z));
  set(14, point(rightElbow.x, rightElbow.y, rightElbow.z));
  set(15, point(leftWrist.x, leftWrist.y, leftWrist.z));
  set(16, point(rightWrist.x, rightWrist.y, rightWrist.z));
  set(17, point(leftWrist.x + 0.012 * s, leftWrist.y + 0.02 * s, leftWrist.z));
  set(18, point(rightWrist.x - 0.012 * s, rightWrist.y + 0.02 * s, rightWrist.z));
  set(19, point(leftWrist.x + 0.004 * s, leftWrist.y + 0.03 * s, leftWrist.z - 0.01));
  set(20, point(rightWrist.x - 0.004 * s, rightWrist.y + 0.03 * s, rightWrist.z - 0.01));
  set(21, point(leftWrist.x - 0.012 * s, leftWrist.y + 0.014 * s, leftWrist.z));
  set(22, point(rightWrist.x + 0.012 * s, rightWrist.y + 0.014 * s, rightWrist.z));

  const leftHip = point(centerX + hipHalf, hipY, z + 0.01);
  const rightHip = point(centerX - hipHalf, hipY, z + 0.01);
  set(23, leftHip);
  set(24, rightHip);

  const kneeY = hipY + 0.16 - motion.duck * 0.04;
  const ankleY = Math.min(0.96, 0.9 + motion.duck * 0.02);
  set(25, point(leftHip.x + 0.01, kneeY, z));
  set(26, point(rightHip.x - 0.01, kneeY, z));
  set(27, point(leftHip.x + 0.012, ankleY, z + 0.02));
  set(28, point(rightHip.x - 0.012, ankleY, z + 0.02));
  set(29, point(leftHip.x - 0.008, ankleY + 0.02, z + 0.04));
  set(30, point(rightHip.x + 0.008, ankleY + 0.02, z + 0.04));
  set(31, point(leftHip.x + 0.028, ankleY + 0.012, z - 0.02));
  set(32, point(rightHip.x - 0.028, ankleY + 0.012, z - 0.02));

  return landmarks;
}

export function sampleSyntheticPose(
  preset: SyntheticPosePreset,
  timestampMs: number,
  options: SyntheticSampleOptions = {},
): NormalizedLandmark[] {
  const breathe = options.breathe ?? true;
  const intensity = options.intensity ?? 1;
  const motion = applyIntensity(motionFor(preset, timestampMs), intensity);
  return buildSyntheticSkeleton(motion, timestampMs, breathe);
}

export function interpolateSyntheticPose(
  from: SyntheticPosePreset,
  to: SyntheticPosePreset,
  timestampMs: number,
  blend: number,
  options: SyntheticSampleOptions = {},
): NormalizedLandmark[] {
  const t = smoothstep(blend);
  const start = sampleSyntheticPose(from, timestampMs, options);
  const end = sampleSyntheticPose(to, timestampMs, options);
  return start.map((landmark, index) => {
    const target = end[index] ?? landmark;
    return {
      x: lerp(landmark.x, target.x, t),
      y: lerp(landmark.y, target.y, t),
      z: lerp(landmark.z, target.z, t),
      visibility: landmark.visibility,
    };
  });
}

export function generateSequence(
  preset: SyntheticPosePreset,
  durationMs: number,
  startMs = 0,
  fps: number = POSE_TRACK_HZ,
  options: SyntheticSampleOptions = {},
): SyntheticPoseFrame[] {
  const safeFps = fps > 0 ? fps : POSE_TRACK_HZ;
  const step = 1000 / safeFps;
  const count = Math.floor(durationMs / step) + 1;
  const frames: SyntheticPoseFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    const timestampMs = Math.min(startMs + durationMs, Math.round(startMs + i * step));
    frames.push({
      preset,
      timestampMs,
      landmarks: sampleSyntheticPose(preset, timestampMs, options),
    });
  }
  return frames;
}

/** Standing outline rebuilt at a calibrated shoulder width, hip line, and center. */
export function silhouetteFromMetrics(metrics: SilhouetteMetrics): NormalizedLandmark[] {
  return buildSyntheticSkeleton(STANDING_MOTION, 0, false, metrics);
}

/**
 * Smooth puppet for the diagnostic page. Preset changes ease over `blendDurationMs`
 * so the same classifier sees a continuous body instead of a pop.
 */
export class SyntheticPuppet {
  private from: SyntheticPosePreset = 'standing_in_zone';
  private to: SyntheticPosePreset = 'standing_in_zone';
  private blendStartMs = 0;

  constructor(private readonly blendDurationMs = 280) {}

  get preset(): SyntheticPosePreset {
    return this.to;
  }

  setPreset(preset: SyntheticPosePreset, nowMs: number, immediate = false): void {
    if (immediate) {
      this.from = preset;
      this.to = preset;
      this.blendStartMs = nowMs - this.blendDurationMs;
      return;
    }
    if (preset === this.to) return;
    this.from = this.to;
    this.to = preset;
    this.blendStartMs = nowMs;
  }

  sample(nowMs: number, options: SyntheticSampleOptions = {}): NormalizedLandmark[] {
    const duration = this.blendDurationMs <= 0 ? 1 : this.blendDurationMs;
    const blend = clamp01((nowMs - this.blendStartMs) / duration);
    return interpolateSyntheticPose(this.from, this.to, nowMs, blend, options);
  }
}
