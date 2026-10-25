import {
  ACCEL_POWER,
  ARM_RAISE_HOLD_MS,
  ATTACK_DEFENSE,
  DUCK_THRESHOLD,
  POSE_LANDMARK,
  SWIPE_WINDOW_MS,
  ZONE_WIDTH_MULTIPLIER,
} from '@once-upon/shared';
import type {
  AttackType,
  CalibrationBaseline,
  NormalizedLandmark,
  PoseActionType,
  PoseFrame,
} from '@once-upon/shared';

/**
 * Right wrist must sit this far above the nose (smaller y) to count as an arm raise.
 * MediaPipe y grows downward.
 */
export const ARM_RAISE_CLEARANCE = 0.03;

/** Horizontal wrist speed, in normalized units per second, that counts as a swipe. */
export const SWIPE_SPEED_THRESHOLD = 0.9;

/**
 * Forward wrist speed toward the camera (`-dz/dt`), in normalized units per second.
 * MediaPipe z is smaller when the landmark is closer to the lens.
 */
export const THRUST_SPEED_THRESHOLD = 0.8;

/** After a wheel lock, the arm must drop before another raise can start counting. */
export const ARM_RAISE_COOLDOWN_MS = 250;

/** One gesture per burst, so a single swipe does not retrigger while the hand recovers. */
export const GESTURE_COOLDOWN_MS = 400;

const TORSO_INDICES = [
  POSE_LANDMARK.leftShoulder,
  POSE_LANDMARK.rightShoulder,
  POSE_LANDMARK.leftHip,
  POSE_LANDMARK.rightHip,
] as const;

const CLASSIFIER_INDICES = [
  ...TORSO_INDICES,
  POSE_LANDMARK.nose,
  POSE_LANDMARK.leftWrist,
  POSE_LANDMARK.rightWrist,
] as const;

export interface ZoneBounds {
  minX: number;
  maxX: number;
  topY: number;
  bottomY: number;
}

export interface ZoneCheck {
  inZone: boolean;
  /** 0 when the torso has left the silhouette, 1 when it lines up with the calibrated outline. */
  overlapScore: number;
}

export interface DodgeClassification {
  isSideStepLeft: boolean;
  isSideStepRight: boolean;
  isDucking: boolean;
  isRightArmRaised: boolean;
  confidence: number;
}

export type P0AttackType = Extract<AttackType, 'low_sweep' | 'high_swing' | 'projectile'>;

export interface DefenseJudgment {
  attackType: P0AttackType;
  dodged: boolean;
  action: PoseActionType;
  detail: string;
}

export interface WristSample {
  x: number;
  y: number;
  z: number;
  timestampMs: number;
}

export interface WristGesture {
  action: Extract<PoseActionType, 'none' | 'swipe_left' | 'swipe_right' | 'thrust'>;
  /** 0 while idle. A detected swipe or thrust is normalized into {@link ACCEL_POWER}. */
  power: number;
  speed: number;
  wrist: 'left' | 'right' | null;
}

export interface ArmRaiseHoldState {
  /** True on the single sample that should advance the spell wheel one slot. */
  locked: boolean;
  heldMs: number;
  /** True while the arm is up and this raise is counting toward the lock. */
  counting: boolean;
}

export interface WristTrackerOptions {
  windowMs?: number;
  cooldownMs?: number;
  swipeSpeed?: number;
  thrustSpeed?: number;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function usableLandmark(landmark: NormalizedLandmark | undefined): landmark is NormalizedLandmark {
  if (!landmark) return false;
  if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) || !Number.isFinite(landmark.z)) {
    return false;
  }
  if (landmark.visibility !== undefined && landmark.visibility < 0.25) return false;
  return true;
}

function landmarkAt(
  landmarks: NormalizedLandmark[],
  index: number,
): NormalizedLandmark | null {
  const landmark = landmarks[index];
  return usableLandmark(landmark) ? landmark : null;
}

function torsoOf(landmarks: NormalizedLandmark[]): NormalizedLandmark[] | null {
  const points: NormalizedLandmark[] = [];
  for (const index of TORSO_INDICES) {
    const point = landmarkAt(landmarks, index);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

function averageVisibility(landmarks: NormalizedLandmark[], indices: readonly number[]): number {
  let sum = 0;
  let count = 0;
  for (const index of indices) {
    const landmark = landmarks[index];
    if (!usableLandmark(landmark)) continue;
    sum += landmark.visibility ?? 1;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Average a standing clip into shoulder height, shoulder width, hip height, and center x.
 * The caller collects the clip for {@link CALIBRATION_DURATION_MS} (3 seconds).
 * Returns null when no frame contains both shoulders and both hips.
 */
export function computeCalibrationBaseline(
  samples: NormalizedLandmark[][],
  timestampMs: number,
): CalibrationBaseline | null {
  let shoulderY = 0;
  let shoulderWidth = 0;
  let hipY = 0;
  let centerX = 0;
  let count = 0;

  for (const frame of samples) {
    const leftShoulder = landmarkAt(frame, POSE_LANDMARK.leftShoulder);
    const rightShoulder = landmarkAt(frame, POSE_LANDMARK.rightShoulder);
    const leftHip = landmarkAt(frame, POSE_LANDMARK.leftHip);
    const rightHip = landmarkAt(frame, POSE_LANDMARK.rightHip);
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;

    shoulderY += (leftShoulder.y + rightShoulder.y) / 2;
    shoulderWidth += Math.abs(leftShoulder.x - rightShoulder.x);
    hipY += (leftHip.y + rightHip.y) / 2;
    centerX += (leftShoulder.x + rightShoulder.x) / 2;
    count += 1;
  }

  if (count === 0) return null;

  return {
    shoulderY: shoulderY / count,
    shoulderWidth: shoulderWidth / count,
    hipY: hipY / count,
    centerX: centerX / count,
    calibratedAt: timestampMs,
  };
}

/**
 * Horizontal bounds are `centerX ± (shoulderWidth * ZONE_WIDTH_MULTIPLIER) / 2`.
 * Vertical bounds pad the standing torso so shoulders and hips fit inside while upright.
 */
export function getZoneBounds(baseline: CalibrationBaseline): ZoneBounds {
  const halfWidth = (Math.max(0, baseline.shoulderWidth) * ZONE_WIDTH_MULTIPLIER) / 2;
  const torso = Math.abs(baseline.hipY - baseline.shoulderY);
  const pad = Math.max(0.04, torso * 0.2);
  const top = Math.min(baseline.shoulderY, baseline.hipY);
  const bottom = Math.max(baseline.shoulderY, baseline.hipY);

  return {
    minX: baseline.centerX - halfWidth,
    maxX: baseline.centerX + halfWidth,
    topY: top - pad,
    bottomY: bottom + pad,
  };
}

function pointInside(point: NormalizedLandmark, bounds: ZoneBounds): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.topY &&
    point.y <= bounds.bottomY
  );
}

/**
 * Both shoulders and both hips must sit inside the zone.
 * Overlap fades from 1 to 0 as the torso center leaves the silhouette, so the outline can fill in on the way back.
 */
export function checkInZone(
  landmarks: NormalizedLandmark[],
  baseline: CalibrationBaseline,
): ZoneCheck {
  const torso = torsoOf(landmarks);
  if (!torso || baseline.shoulderWidth <= 0.001) {
    return { inZone: false, overlapScore: 0 };
  }

  const bounds = getZoneBounds(baseline);
  const leftShoulder = torso[0];
  const rightShoulder = torso[1];
  const leftHip = torso[2];
  const rightHip = torso[3];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return { inZone: false, overlapScore: 0 };
  }

  const inZone = torso.every((point) => pointInside(point, bounds));
  const playerCenterX = (leftShoulder.x + rightShoulder.x) / 2;
  const playerShoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const playerHipY = (leftHip.y + rightHip.y) / 2;
  const playerWidth = Math.abs(leftShoulder.x - rightShoulder.x);

  const xReach = Math.max(1e-4, (baseline.shoulderWidth * ZONE_WIDTH_MULTIPLIER) / 2);
  const xScore = clamp01(1 - Math.abs(playerCenterX - baseline.centerX) / (xReach * 1.35));

  const yTol = Math.max(0.08, Math.abs(baseline.hipY - baseline.shoulderY) * 0.55);
  const shoulderYScore = clamp01(1 - Math.abs(playerShoulderY - baseline.shoulderY) / yTol);
  const hipYScore = clamp01(1 - Math.abs(playerHipY - baseline.hipY) / yTol);
  const yScore = 0.65 * shoulderYScore + 0.35 * hipYScore;

  const widthTol = Math.max(0.04, baseline.shoulderWidth * 0.5);
  const widthScore = clamp01(1 - Math.abs(playerWidth - baseline.shoulderWidth) / widthTol);

  const containScore = torso.filter((point) => pointInside(point, bounds)).length / torso.length;
  const overlapScore = clamp01(
    xScore * (0.75 + 0.25 * yScore) * (0.85 + 0.15 * widthScore) * (0.7 + 0.3 * containScore),
  );

  return { inZone, overlapScore };
}

const EMPTY_DODGE: DodgeClassification = {
  isSideStepLeft: false,
  isSideStepRight: false,
  isDucking: false,
  isRightArmRaised: false,
  confidence: 0,
};

/**
 * P0 body reads.
 * Side step left is the player's own left: in an unmirrored frame that is entirely past `maxX`
 * (a mirrored preview shows it on the left of the screen). Side step right clears `minX`.
 * Duck compares the shoulder midpoint with the standing baseline. Y grows downward.
 */
export function classifyDodgeAndPose(
  landmarks: NormalizedLandmark[],
  baseline: CalibrationBaseline,
): DodgeClassification {
  const leftShoulder = landmarkAt(landmarks, POSE_LANDMARK.leftShoulder);
  const rightShoulder = landmarkAt(landmarks, POSE_LANDMARK.rightShoulder);
  const leftHip = landmarkAt(landmarks, POSE_LANDMARK.leftHip);
  const rightHip = landmarkAt(landmarks, POSE_LANDMARK.rightHip);
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return EMPTY_DODGE;

  const bounds = getZoneBounds(baseline);
  const torso = [leftShoulder, rightShoulder, leftHip, rightHip];
  const isSideStepLeft = torso.every((point) => point.x > bounds.maxX);
  const isSideStepRight = torso.every((point) => point.x < bounds.minX);
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const isDucking = shoulderY > baseline.shoulderY + DUCK_THRESHOLD;

  const nose = landmarkAt(landmarks, POSE_LANDMARK.nose);
  const rightWrist = landmarkAt(landmarks, POSE_LANDMARK.rightWrist);
  const isRightArmRaised = Boolean(nose && rightWrist && rightWrist.y < nose.y - ARM_RAISE_CLEARANCE);

  return {
    isSideStepLeft,
    isSideStepRight,
    isDucking,
    isRightArmRaised,
    confidence: averageVisibility(landmarks, CLASSIFIER_INDICES),
  };
}

/**
 * Local defense judgment at impact time.
 * A low sweep or a projectile is dodged by leaving the zone to either side.
 * A projectile can also be parried with the glove. A high swing is dodged by ducking.
 */
export function judgeTelegraphDefense(
  attackType: P0AttackType,
  pose: DodgeClassification,
  parried = false,
): DefenseJudgment {
  const stepped = pose.isSideStepLeft || pose.isSideStepRight;
  const stepAction: PoseActionType = pose.isSideStepLeft
    ? 'side_step_left'
    : pose.isSideStepRight
      ? 'side_step_right'
      : 'none';

  if (attackType === 'high_swing') {
    const dodged = pose.isDucking;
    return {
      attackType,
      dodged,
      action: dodged ? 'duck' : 'none',
      detail: dodged ? 'Duck slipped the high swing.' : 'Still standing — the high swing lands.',
    };
  }

  if (attackType === 'projectile') {
    const dodged = parried || stepped;
    const action: PoseActionType = parried ? 'none' : stepAction;
    let detail = 'Still in the path — step aside, or parry with the glove.';
    if (parried) detail = 'Parry sends the projectile back.';
    else if (stepped) detail = 'Side step left the projectile’s path.';
    return { attackType, dodged, action, detail };
  }

  return {
    attackType,
    dodged: stepped,
    action: stepAction,
    detail: stepped ? 'Side step cleared the sweep.' : 'Still inside the sweep.',
  };
}

export function expectedDefense(attackType: P0AttackType): (typeof ATTACK_DEFENSE)[AttackType] {
  return ATTACK_DEFENSE[attackType];
}

/** Badge copy for the vision HUD. Directional swipes still read as SWIPE. */
export function actionBadgeLabel(action: PoseActionType): string {
  switch (action) {
    case 'side_step_left':
    case 'side_step_right':
      return 'SIDE STEP';
    case 'duck':
      return 'DUCK';
    case 'arm_raise':
      return 'ARM RAISE';
    case 'swipe_left':
    case 'swipe_right':
      return 'SWIPE';
    case 'thrust':
      return 'THRUST';
    case 'none':
      return 'READY';
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

export function resolveActiveAction(
  pose: DodgeClassification,
  gesture: WristGesture,
  armRaised: boolean,
): PoseActionType {
  if (gesture.action !== 'none') return gesture.action;
  if (armRaised) return 'arm_raise';
  if (pose.isDucking) return 'duck';
  if (pose.isSideStepLeft) return 'side_step_left';
  if (pose.isSideStepRight) return 'side_step_right';
  return 'none';
}

export function buildPoseFrame(input: PoseFrame): PoseFrame {
  return {
    playerId: input.playerId,
    landmarks: input.landmarks,
    inZone: input.inZone,
    activeAction: input.activeAction,
    confidence: input.confidence,
    serverTimestampMs: input.serverTimestampMs,
  };
}

export function normalizeGesturePower(speed: number, threshold: number): number {
  if (threshold <= 0) return ACCEL_POWER.min;
  const span = threshold * 1.25;
  const t = clamp01((speed - threshold) / span);
  return ACCEL_POWER.min + (ACCEL_POWER.max - ACCEL_POWER.min) * t;
}

const IDLE_GESTURE: WristGesture = { action: 'none', power: 0, speed: 0, wrist: null };

interface Velocity {
  vx: number;
  vy: number;
  vz: number;
}

function velocityOver(samples: readonly WristSample[]): Velocity | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  const dt = (last.timestampMs - first.timestampMs) / 1000;
  if (dt < 0.05) return null;
  return {
    vx: (last.x - first.x) / dt,
    vy: (last.y - first.y) / dt,
    vz: (last.z - first.z) / dt,
  };
}

interface WidthSample {
  width: number;
  timestampMs: number;
}

/**
 * Rolling {@link SWIPE_WINDOW_MS} window over both wrists.
 * `swipe_left` is the player's left (image x increasing). `thrust` is a rapid drop in z,
 * or a forward snap paired with the shoulders opening toward the camera.
 */
export class WristVelocityTracker {
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly swipeSpeed: number;
  private readonly thrustSpeed: number;
  private left: WristSample[] = [];
  private right: WristSample[] = [];
  private widths: WidthSample[] = [];
  private lastTimestampMs = Number.NEGATIVE_INFINITY;
  private lastFireAt = Number.NEGATIVE_INFINITY;

  constructor(options: WristTrackerOptions = {}) {
    this.windowMs = options.windowMs ?? SWIPE_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? GESTURE_COOLDOWN_MS;
    this.swipeSpeed = options.swipeSpeed ?? SWIPE_SPEED_THRESHOLD;
    this.thrustSpeed = options.thrustSpeed ?? THRUST_SPEED_THRESHOLD;
  }

  reset(): void {
    this.left = [];
    this.right = [];
    this.widths = [];
    this.lastTimestampMs = Number.NEGATIVE_INFINITY;
    this.lastFireAt = Number.NEGATIVE_INFINITY;
  }

  update(landmarks: NormalizedLandmark[], timestampMs: number): WristGesture {
    if (timestampMs < this.lastTimestampMs) this.reset();
    this.lastTimestampMs = timestampMs;

    const leftWrist = landmarkAt(landmarks, POSE_LANDMARK.leftWrist);
    const rightWrist = landmarkAt(landmarks, POSE_LANDMARK.rightWrist);
    const leftShoulder = landmarkAt(landmarks, POSE_LANDMARK.leftShoulder);
    const rightShoulder = landmarkAt(landmarks, POSE_LANDMARK.rightShoulder);

    if (leftWrist) this.left.push({ x: leftWrist.x, y: leftWrist.y, z: leftWrist.z, timestampMs });
    if (rightWrist) this.right.push({ x: rightWrist.x, y: rightWrist.y, z: rightWrist.z, timestampMs });
    if (leftShoulder && rightShoulder) {
      this.widths.push({
        width: Math.abs(leftShoulder.x - rightShoulder.x),
        timestampMs,
      });
    }

    this.prune(timestampMs);
    if (timestampMs - this.lastFireAt < this.cooldownMs) return IDLE_GESTURE;

    const leftGesture = this.classifyWrist('left', this.left);
    const rightGesture = this.classifyWrist('right', this.right);
    const best = this.stronger(leftGesture, rightGesture);
    if (best.action !== 'none') this.lastFireAt = timestampMs;
    return best;
  }

  private prune(timestampMs: number): void {
    const cutoff = timestampMs - this.windowMs;
    this.left = this.left.filter((sample) => sample.timestampMs >= cutoff);
    this.right = this.right.filter((sample) => sample.timestampMs >= cutoff);
    this.widths = this.widths.filter((sample) => sample.timestampMs >= cutoff);
  }

  private widthGrowth(): number {
    const first = this.widths[0];
    const last = this.widths[this.widths.length - 1];
    if (!first || !last || first.width <= 0.001) return 0;
    return (last.width - first.width) / first.width;
  }

  private classifyWrist(wrist: 'left' | 'right', samples: readonly WristSample[]): WristGesture {
    const velocity = velocityOver(samples);
    if (!velocity) return IDLE_GESTURE;

    const forward = Math.max(0, -velocity.vz);
    const expanding = this.widthGrowth() >= 0.12 && velocity.vy < -0.15;
    const thrustSpeed = expanding ? Math.max(forward, this.thrustSpeed) : forward;
    const thrust =
      forward >= this.thrustSpeed || (expanding && forward >= this.thrustSpeed * 0.45);

    const horizontal = Math.abs(velocity.vx);
    const swipe =
      horizontal >= this.swipeSpeed &&
      horizontal > Math.abs(velocity.vz) * 1.2 &&
      horizontal > Math.abs(velocity.vy) * 0.8;

    if (swipe && (!thrust || horizontal >= thrustSpeed)) {
      const action = velocity.vx >= 0 ? 'swipe_left' : 'swipe_right';
      return {
        action,
        power: normalizeGesturePower(horizontal, this.swipeSpeed),
        speed: horizontal,
        wrist,
      };
    }

    if (thrust) {
      return {
        action: 'thrust',
        power: normalizeGesturePower(Math.max(forward, this.thrustSpeed), this.thrustSpeed),
        speed: forward,
        wrist,
      };
    }

    return IDLE_GESTURE;
  }

  private stronger(left: WristGesture, right: WristGesture): WristGesture {
    if (left.action === 'none') return right;
    if (right.action === 'none') return left;
    return left.speed >= right.speed ? left : right;
  }
}

/**
 * Counts a continuous right-arm raise and emits one lock per raise after {@link ARM_RAISE_HOLD_MS}.
 * The arm has to drop (and sit out the cooldown) before the next slot can arm.
 */
export class ArmRaiseHoldDetector {
  private holdStart: number | null = null;
  private lockedThisHold = false;
  private armWasUp = false;
  private cooldownUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly holdMs = ARM_RAISE_HOLD_MS,
    private readonly cooldownMs = ARM_RAISE_COOLDOWN_MS,
  ) {}

  reset(): void {
    this.holdStart = null;
    this.lockedThisHold = false;
    this.armWasUp = false;
    this.cooldownUntil = Number.NEGATIVE_INFINITY;
  }

  update(isRightArmRaised: boolean, timestampMs: number): ArmRaiseHoldState {
    if (!isRightArmRaised) {
      if (this.armWasUp) this.cooldownUntil = timestampMs + this.cooldownMs;
      this.armWasUp = false;
      this.holdStart = null;
      this.lockedThisHold = false;
      return { locked: false, heldMs: 0, counting: false };
    }

    if (timestampMs < this.cooldownUntil) {
      return { locked: false, heldMs: 0, counting: false };
    }

    this.armWasUp = true;
    if (this.holdStart === null) this.holdStart = timestampMs;
    const heldMs = timestampMs - this.holdStart;
    if (!this.lockedThisHold && heldMs >= this.holdMs) {
      this.lockedThisHold = true;
      return { locked: true, heldMs, counting: true };
    }
    return { locked: false, heldMs, counting: true };
  }
}
