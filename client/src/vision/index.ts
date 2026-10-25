export {
  APPROACH_RING_START_SCALE,
  ARM_RAISE_CLEARANCE,
  ARM_RAISE_COOLDOWN_MS,
  GESTURE_COOLDOWN_MS,
  SWIPE_SPEED_THRESHOLD,
  THRUST_SPEED_THRESHOLD,
  ArmRaiseHoldDetector,
  BODY_PART_LABEL,
  BODY_PART_TAG,
  BODY_PART_TARGETS,
  PART_TARGET_MIN_RADIUS,
  PART_TARGET_RADIUS,
  STROBE_END_HZ,
  STROBE_START_HZ,
  WristVelocityTracker,
  actionBadgeLabel,
  approachRingScale,
  bodyPartPoints,
  checkPartClearance,
  distanceInRadii,
  buildPoseFrame,
  checkInZone,
  classifyDodgeAndPose,
  computeCalibrationBaseline,
  expectedDefense,
  getZoneBounds,
  judgePartTarget,
  judgeTelegraphDefense,
  judgeZoneBlast,
  lockPartTarget,
  normalizeGesturePower,
  resolveActiveAction,
  resolveTorso,
  strobeCycles,
  strobeFrequencyHz,
  strobeIsRed,
  VIRTUAL_HIP_DROP,
  VIRTUAL_HIP_MAX_Y,
} from './poseClassifiers';
export type {
  ArmRaiseHoldState,
  BodyPartTarget,
  CombatJudgment,
  DefenseJudgment,
  DodgeClassification,
  P0AttackType,
  PartClearance,
  PartTarget,
  ResolvedTorso,
  WristGesture,
  WristSample,
  WristTrackerOptions,
  ZoneBounds,
  ZoneCheck,
} from './poseClassifiers';

export {
  SYNTHETIC_BODY,
  SYNTHETIC_GESTURE_CYCLE_MS,
  SYNTHETIC_PRESETS,
  SYNTHETIC_PRESET_LABEL,
  SYNTHETIC_STRIKE_END_MS,
  SYNTHETIC_STRIKE_START_MS,
  SyntheticPuppet,
  buildSyntheticSkeleton,
  generateSequence,
  interpolateSyntheticPose,
  sampleSyntheticPose,
  silhouetteFromMetrics,
} from './syntheticPoseGenerator';
export type {
  SilhouetteMetrics,
  SyntheticPoseFrame,
  SyntheticPosePreset,
  SyntheticSampleOptions,
} from './syntheticPoseGenerator';

export {
  POSE_MODEL_URL,
  VISION_WASM_BASE,
  PoseLandmarkerService,
  isWebcamApiAvailable,
  isWebGlAvailable,
} from './poseLandmarkerService';
export type { PoseLandmarkerServiceOptions, PoseServiceStatus, VisionSourceMode } from './poseLandmarkerService';

export { VisionCanvas, primeVisionAudio } from './VisionCanvas';
export type { CombatOverlay, VisionCanvasModel, VisionCanvasProps } from './VisionCanvas';

export { VISION_TEST_PATH, VisionTestPage } from './VisionTestPage';
