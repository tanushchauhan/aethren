import {
  ACCEL_POWER,
  ARM_RAISE_HOLD_MS,
  ATTACK_DEFENSE,
  DUCK_THRESHOLD,
  POSE_LANDMARK,
  SWIPE_WINDOW_MS,
  ZONE_WIDTH_MULTIPLIER,
} from '@aethren/shared';
import type {
  AttackType,
  CalibrationBaseline,
  NormalizedLandmark,
  PoseActionType,
  PoseFrame,
} from '@aethren/shared';

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

/**
 * When the hips sit below a close-up laptop camera, a virtual hip line is placed this many
 * shoulder widths under the shoulder midpoint.
 */
export const VIRTUAL_HIP_DROP = 1.45;

/** Virtual hips never go lower than this, so the zone stays mostly on screen. */
export const VIRTUAL_HIP_MAX_Y = 0.95;

/** Virtual hips sit a little inside the shoulders, like a real torso. */
const VIRTUAL_HIP_INSET = 0.85;

const UPPER_BODY_INDICES = [
  POSE_LANDMARK.nose,
  POSE_LANDMARK.leftShoulder,
  POSE_LANDMARK.rightShoulder,
  POSE_LANDMARK.leftWrist,
  POSE_LANDMARK.rightWrist,
] as const;

const HIP_INDICES = [POSE_LANDMARK.leftHip, POSE_LANDMARK.rightHip] as const;

/** MediaPipe face points. The shared map only lists body joints. */
const FACE_LANDMARK = { leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8 } as const;

/**
 * With no face seen during calibration, the head center sits this many shoulder widths
 * (measured in pixels) above the shoulder line.
 */
export const HEAD_FALLBACK_DROP = 0.42;

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
  /** True when the hips were off screen and the torso used virtual hips under the shoulders. */
  hipsEstimated?: boolean;
}

export interface ResolvedTorso {
  leftShoulder: NormalizedLandmark;
  rightShoulder: NormalizedLandmark;
  leftHip: NormalizedLandmark;
  rightHip: NormalizedLandmark;
  hipsEstimated: boolean;
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

/** A hip below the bottom edge is a guess, even when MediaPipe reports it as visible. */
function onScreenHip(landmarks: NormalizedLandmark[], index: number): NormalizedLandmark | null {
  const hip = landmarkAt(landmarks, index);
  return hip && hip.y <= 1 ? hip : null;
}

/**
 * Shoulders are required. Hips are optional: when either hip is off screen or faint, both are
 * replaced with virtual hips {@link VIRTUAL_HIP_DROP} shoulder widths below the shoulders.
 * This keeps a close-up laptop webcam and a full-body stand two meters back on the same rules.
 */
export function resolveTorso(landmarks: NormalizedLandmark[]): ResolvedTorso | null {
  const leftShoulder = landmarkAt(landmarks, POSE_LANDMARK.leftShoulder);
  const rightShoulder = landmarkAt(landmarks, POSE_LANDMARK.rightShoulder);
  if (!leftShoulder || !rightShoulder) return null;

  const leftHip = onScreenHip(landmarks, POSE_LANDMARK.leftHip);
  const rightHip = onScreenHip(landmarks, POSE_LANDMARK.rightHip);
  if (leftHip && rightHip) {
    return { leftShoulder, rightShoulder, leftHip, rightHip, hipsEstimated: false };
  }

  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
  const hipY = Math.min(VIRTUAL_HIP_MAX_Y, shoulderMidY + shoulderWidth * VIRTUAL_HIP_DROP);
  const virtualHip = (shoulder: NormalizedLandmark): NormalizedLandmark => ({
    x: shoulderMidX + (shoulder.x - shoulderMidX) * VIRTUAL_HIP_INSET,
    y: hipY,
    z: shoulder.z,
    visibility: 0,
  });

  return {
    leftShoulder,
    rightShoulder,
    leftHip: virtualHip(leftShoulder),
    rightHip: virtualHip(rightShoulder),
    hipsEstimated: true,
  };
}

function torsoPoints(torso: ResolvedTorso): NormalizedLandmark[] {
  return [torso.leftShoulder, torso.rightShoulder, torso.leftHip, torso.rightHip];
}

/** Upper body always counts. Hips only count when they are really in frame. */
function classifierConfidence(landmarks: NormalizedLandmark[], hipsEstimated: boolean): number {
  const indices: readonly number[] = hipsEstimated ? UPPER_BODY_INDICES : [...UPPER_BODY_INDICES, ...HIP_INDICES];
  return averageVisibility(landmarks, indices);
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
 * Middle of the head: the nose and both ears averaged. When an ear is hidden (a turned head),
 * the eyes stand in so the center does not slide toward the one visible ear.
 */
export function headCenter(landmarks: NormalizedLandmark[]): NormalizedLandmark | null {
  const nose = landmarkAt(landmarks, POSE_LANDMARK.nose);
  const leftEar = landmarkAt(landmarks, FACE_LANDMARK.leftEar);
  const rightEar = landmarkAt(landmarks, FACE_LANDMARK.rightEar);
  const sides =
    leftEar && rightEar
      ? [leftEar, rightEar]
      : [landmarkAt(landmarks, FACE_LANDMARK.leftEye), landmarkAt(landmarks, FACE_LANDMARK.rightEye)];
  const points = [nose, ...sides].filter((point): point is NormalizedLandmark => point !== null);
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
    z += point.z;
  }
  return { x: x / points.length, y: y / points.length, z: z / points.length };
}

/**
 * Average a standing clip into shoulder height, shoulder width, hip height, center x, and the
 * head center when the face is visible.
 * The caller collects the clip for {@link CALIBRATION_DURATION_MS} (3 seconds), or passes a
 * single recent frame for an instant lock. Hips off screen fall back to {@link resolveTorso}.
 * Returns null when no frame contains both shoulders.
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
  let headY = 0;
  let headCount = 0;

  for (const frame of samples) {
    const torso = resolveTorso(frame);
    if (!torso) continue;
    const { leftShoulder, rightShoulder, leftHip, rightHip } = torso;

    shoulderY += (leftShoulder.y + rightShoulder.y) / 2;
    shoulderWidth += Math.abs(leftShoulder.x - rightShoulder.x);
    hipY += (leftHip.y + rightHip.y) / 2;
    centerX += (leftShoulder.x + rightShoulder.x) / 2;
    count += 1;

    const head = headCenter(frame);
    if (head) {
      headY += head.y;
      headCount += 1;
    }
  }

  if (count === 0) return null;

  return {
    shoulderY: shoulderY / count,
    shoulderWidth: shoulderWidth / count,
    hipY: hipY / count,
    centerX: centerX / count,
    calibratedAt: timestampMs,
    ...(headCount > 0 ? { noseY: headY / headCount } : {}),
  };
}

/**
 * Head center height for drawing the silhouette. Uses the calibrated head when there is one,
 * otherwise {@link HEAD_FALLBACK_DROP} shoulder widths above the shoulders. `aspect` (frame
 * width / height) turns the shoulder width from x units into y units.
 */
export function baselineHeadY(baseline: CalibrationBaseline, aspect = 1): number {
  if (baseline.noseY !== undefined && Number.isFinite(baseline.noseY)) return baseline.noseY;
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return baseline.shoulderY - baseline.shoulderWidth * safeAspect * HEAD_FALLBACK_DROP;
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
 * Both shoulders and both hips (real or virtual) must sit inside the zone.
 * Overlap fades from 1 to 0 as the torso center leaves the silhouette, so the outline can fill in on the way back.
 */
export function checkInZone(
  landmarks: NormalizedLandmark[],
  baseline: CalibrationBaseline,
): ZoneCheck {
  const resolved = resolveTorso(landmarks);
  if (!resolved || baseline.shoulderWidth <= 0.001) {
    return { inZone: false, overlapScore: 0 };
  }

  const bounds = getZoneBounds(baseline);
  const { leftShoulder, rightShoulder, leftHip, rightHip } = resolved;
  const torso = torsoPoints(resolved);

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
  hipsEstimated: false,
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
  const resolved = resolveTorso(landmarks);
  if (!resolved) return EMPTY_DODGE;

  const { leftShoulder, rightShoulder } = resolved;
  const bounds = getZoneBounds(baseline);
  const torso = torsoPoints(resolved);
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
    confidence: classifierConfidence(landmarks, resolved.hipsEstimated),
    hipsEstimated: resolved.hipsEstimated,
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
      detail: dodged ? 'Duck slipped the high swing.' : 'Still standing. The high swing lands.',
    };
  }

  if (attackType === 'projectile') {
    const dodged = parried || stepped;
    const action: PoseActionType = parried ? 'none' : stepAction;
    let detail = 'Still in the path. Step aside, or parry with the glove.';
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

/** Body parts an Osu!-style target ring can lock onto. Left and right are the player's own sides. */
export type BodyPartTarget = 'head' | 'left_shoulder' | 'right_shoulder' | 'chest';

export const BODY_PART_TARGETS: readonly BodyPartTarget[] = ['head', 'left_shoulder', 'right_shoulder', 'chest'];

export const BODY_PART_LABEL: Record<BodyPartTarget, string> = {
  head: 'Head / Face',
  left_shoulder: 'Left Shoulder / Arm',
  right_shoulder: 'Right Shoulder / Arm',
  chest: 'Chest / Core',
};

/** Short tags drawn next to the ring on the canvas. */
export const BODY_PART_TAG: Record<BodyPartTarget, string> = {
  head: 'HEAD',
  left_shoulder: 'L ARM',
  right_shoulder: 'R ARM',
  chest: 'CORE',
};

/**
 * Inner circle radius as a share of the calibrated shoulder width. The head ring is a bit wider
 * than a real head (about half a shoulder width across), so it covers the face without swallowing
 * the shoulders, and it scales with the player whether they stand 1 m or 2 m back.
 */
export const PART_TARGET_RADIUS: Record<BodyPartTarget, number> = {
  head: 0.28,
  left_shoulder: 0.3,
  right_shoulder: 0.3,
  chest: 0.32,
};

/** Floor for the inner radius in normalized x units, so a tiny far-away body still gets a visible ring. */
export const PART_TARGET_MIN_RADIUS = 0.03;

/** Ceiling for the inner radius in normalized x units, so a face right at the lens can still lean out. */
export const PART_TARGET_MAX_RADIUS: Record<BodyPartTarget, number> = {
  head: 0.11,
  left_shoulder: 0.12,
  right_shoulder: 0.12,
  chest: 0.13,
};

/** The approach ring starts this many inner radii wide and shrinks to 1 at impact. */
export const APPROACH_RING_START_SCALE = 3;

/** Whole-body blast strobe ramps from this rate to {@link STROBE_END_HZ} as impact gets closer. */
export const STROBE_START_HZ = 2;
export const STROBE_END_HZ = 12;

const PART_LANDMARKS: Record<Exclude<BodyPartTarget, 'chest' | 'head'>, readonly number[]> = {
  left_shoulder: [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.leftElbow, POSE_LANDMARK.leftWrist],
  right_shoulder: [POSE_LANDMARK.rightShoulder, POSE_LANDMARK.rightElbow, POSE_LANDMARK.rightWrist],
};

/**
 * A target circle frozen in image space at the moment the telegraph starts.
 * `radius` is in frame-height units; distances scale dx by `aspect` (frame width / height)
 * so the circle stays round on a wide canvas.
 */
export interface PartTarget {
  part: BodyPartTarget;
  x: number;
  y: number;
  radius: number;
  aspect: number;
}

export interface PartClearance {
  /** True once every tracked point of the part sits outside the inner circle. */
  cleared: boolean;
  tracked: number;
  inside: number;
  /** Closest tracked point, in inner radii. Above 1 is outside. Infinity when nothing is tracked. */
  closest: number;
}

export interface CombatJudgment {
  kind: 'part_ring' | 'zone_blast';
  part: BodyPartTarget | null;
  /** Every ring in a multi-ring attack. Absent for a blast. */
  parts?: readonly BodyPartTarget[];
  dodged: boolean;
  action: PoseActionType;
  detail: string;
}

function shoulderMidpoint(landmarks: NormalizedLandmark[]): NormalizedLandmark | null {
  const left = landmarkAt(landmarks, POSE_LANDMARK.leftShoulder);
  const right = landmarkAt(landmarks, POSE_LANDMARK.rightShoulder);
  if (!left || !right) return null;
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, z: (left.z + right.z) / 2 };
}

/**
 * Tracked points that decide whether a body part is still in the circle. Head is the head center,
 * so the whole head has to leave, not just a tilted nose. Chest is the shoulder midpoint.
 */
export function bodyPartPoints(landmarks: NormalizedLandmark[], part: BodyPartTarget): NormalizedLandmark[] {
  if (part === 'chest') {
    const mid = shoulderMidpoint(landmarks);
    return mid ? [mid] : [];
  }
  if (part === 'head') {
    const head = headCenter(landmarks);
    return head ? [head] : [];
  }
  return PART_LANDMARKS[part]
    .map((index) => landmarkAt(landmarks, index))
    .filter((landmark): landmark is NormalizedLandmark => landmark !== null);
}

/**
 * Inner ring radius in normalized x units: {@link PART_TARGET_RADIUS} of the shoulder width,
 * clamped between {@link PART_TARGET_MIN_RADIUS} and {@link PART_TARGET_MAX_RADIUS}.
 */
export function partTargetRadius(part: BodyPartTarget, shoulderWidth: number): number {
  const width = Number.isFinite(shoulderWidth) ? Math.max(0, shoulderWidth) : 0;
  return Math.min(PART_TARGET_MAX_RADIUS[part], Math.max(PART_TARGET_MIN_RADIUS, width * PART_TARGET_RADIUS[part]));
}

/**
 * Freezes a ring on the part where it is right now. Head locks on the head center (nose and
 * ears), a shoulder on its shoulder joint, chest on the shoulder midpoint.
 * The circle is sized from `calibratedShoulderWidth` when given, so a torso that is turned or
 * mid-dodge at lock time does not shrink the ring. Without it, both live shoulders are required.
 */
export function lockPartTarget(
  landmarks: NormalizedLandmark[],
  part: BodyPartTarget,
  aspect: number,
  calibratedShoulderWidth?: number,
): PartTarget | null {
  const left = landmarkAt(landmarks, POSE_LANDMARK.leftShoulder);
  const right = landmarkAt(landmarks, POSE_LANDMARK.rightShoulder);
  const calibrated =
    calibratedShoulderWidth !== undefined && Number.isFinite(calibratedShoulderWidth) && calibratedShoulderWidth > 0.001
      ? calibratedShoulderWidth
      : null;
  const shoulderWidth = calibrated ?? (left && right ? Math.abs(left.x - right.x) : null);
  if (shoulderWidth === null) return null;

  let anchor: NormalizedLandmark | null;
  if (part === 'head') anchor = headCenter(landmarks);
  else if (part === 'left_shoulder') anchor = left;
  else if (part === 'right_shoulder') anchor = right;
  else anchor = shoulderMidpoint(landmarks);
  if (!anchor) return null;

  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const radius = partTargetRadius(part, shoulderWidth) * safeAspect;
  return { part, x: anchor.x, y: anchor.y, radius, aspect: safeAspect };
}

/** Locks every ring of a multi-ring attack on the same frame. Null if any part cannot be found. */
export function lockPartTargets(
  landmarks: NormalizedLandmark[],
  parts: readonly BodyPartTarget[],
  aspect: number,
  calibratedShoulderWidth?: number,
): PartTarget[] | null {
  const targets: PartTarget[] = [];
  for (const part of parts) {
    const target = lockPartTarget(landmarks, part, aspect, calibratedShoulderWidth);
    if (!target) return null;
    targets.push(target);
  }
  return targets.length > 0 ? targets : null;
}

/** Distance from the ring center in inner radii, measured on a round (aspect corrected) circle. */
export function distanceInRadii(point: Pick<NormalizedLandmark, 'x' | 'y'>, target: PartTarget): number {
  if (target.radius <= 0) return Number.POSITIVE_INFINITY;
  return Math.hypot((point.x - target.x) * target.aspect, point.y - target.y) / target.radius;
}

/**
 * Live overlap check for one ring. Any tracked point of the part inside the circle keeps it in danger.
 * A part that has left the frame entirely counts as cleared.
 */
export function checkPartClearance(landmarks: NormalizedLandmark[] | null, target: PartTarget): PartClearance {
  const points = landmarks ? bodyPartPoints(landmarks, target.part) : [];
  let inside = 0;
  let closest = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = distanceInRadii(point, target);
    closest = Math.min(closest, distance);
    if (distance <= 1) inside += 1;
  }
  return { cleared: inside === 0, tracked: points.length, inside, closest };
}

/** One live clearance per ring, in the same order as `targets`. */
export function checkPartClearances(
  landmarks: NormalizedLandmark[] | null,
  targets: readonly PartTarget[],
): PartClearance[] {
  return targets.map((target) => checkPartClearance(landmarks, target));
}

/** Outer ring scale over the countdown: {@link APPROACH_RING_START_SCALE} at 0, exactly 1 at impact. */
export function approachRingScale(progress: number): number {
  return APPROACH_RING_START_SCALE - (APPROACH_RING_START_SCALE - 1) * clamp01(progress);
}

/** Strobe rate at a point in the countdown. Eases in quadratically so the last second turns frantic. */
export function strobeFrequencyHz(progress: number): number {
  const p = clamp01(progress);
  return STROBE_START_HZ + (STROBE_END_HZ - STROBE_START_HZ) * p * p;
}

/** Full red/green cycles completed so far: the integral of {@link strobeFrequencyHz} over elapsed time. */
export function strobeCycles(progress: number, durationMs: number): number {
  const p = clamp01(progress);
  const seconds = Math.max(0, durationMs) / 1000;
  return seconds * (STROBE_START_HZ * p + ((STROBE_END_HZ - STROBE_START_HZ) * p * p * p) / 3);
}

/** Each cycle shows red, then green. The strobe opens on red and locks solid red at impact. */
export function strobeIsRed(progress: number, durationMs: number): boolean {
  if (progress >= 1) return true;
  return Math.floor(strobeCycles(progress, durationMs) * 2) % 2 === 0;
}

export function judgePartTarget(target: PartTarget, clearance: PartClearance, parried = false): CombatJudgment {
  const label = BODY_PART_LABEL[target.part];
  const dodged = parried || clearance.cleared;
  let detail = `${label} was still inside the circle.`;
  if (parried) detail = `Glove parry knocked the shot away from your ${label.toLowerCase()}.`;
  else if (clearance.cleared) detail = `${label} cleared the circle in time.`;
  return { kind: 'part_ring', part: target.part, parts: [target.part], dodged, action: 'none', detail };
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Multi-ring verdict: dodged only when every targeted part is outside its own circle at impact
 * (or the glove parried). A missing clearance counts as still inside.
 */
export function judgePartTargets(
  targets: readonly PartTarget[],
  clearances: readonly PartClearance[],
  parried = false,
): CombatJudgment {
  const first = targets[0];
  if (!first) {
    return { kind: 'part_ring', part: null, parts: [], dodged: parried, action: 'none', detail: 'No ring was locked on.' };
  }
  if (targets.length === 1) {
    const clearance = clearances[0] ?? { cleared: false, tracked: 0, inside: 0, closest: 0 };
    return judgePartTarget(first, clearance, parried);
  }

  const parts = targets.map((target) => target.part);
  const stuck = targets
    .filter((_, index) => !(clearances[index]?.cleared ?? false))
    .map((target) => BODY_PART_LABEL[target.part]);
  const dodged = parried || stuck.length === 0;
  let detail = `${joinLabels(stuck)} ${stuck.length > 1 ? 'were' : 'was'} still inside the circle.`;
  if (parried) detail = `Glove parry knocked away all ${targets.length} shots.`;
  else if (stuck.length === 0) detail = `${joinLabels(parts.map((part) => BODY_PART_LABEL[part]))} all cleared in time.`;
  return { kind: 'part_ring', part: first.part, parts, dodged, action: 'none', detail };
}

/** Whole-body blast: the torso has to leave the silhouette to either side, or duck under it. */
export function judgeZoneBlast(pose: DodgeClassification): CombatJudgment {
  const action: PoseActionType = pose.isSideStepLeft
    ? 'side_step_left'
    : pose.isSideStepRight
      ? 'side_step_right'
      : pose.isDucking
        ? 'duck'
        : 'none';
  const dodged = action !== 'none';
  return {
    kind: 'zone_blast',
    part: null,
    dodged,
    action,
    detail: dodged
      ? action === 'duck'
        ? 'Ducked under the silhouette blast.'
        : 'Stepped clear of the silhouette blast.'
      : 'Still inside the silhouette when it blew.',
  };
}
