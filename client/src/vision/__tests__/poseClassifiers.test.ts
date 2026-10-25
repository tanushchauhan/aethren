import {
  ARM_RAISE_HOLD_MS,
  CALIBRATION_DURATION_MS,
  DUCK_THRESHOLD,
  POSE_LANDMARK,
  POSE_LANDMARK_COUNT,
  ZONE_WIDTH_MULTIPLIER,
} from '@aethren/shared';
import type { CalibrationBaseline, NormalizedLandmark } from '@aethren/shared';
import { describe, expect, it } from 'vitest';
import {
  APPROACH_RING_START_SCALE,
  ARM_RAISE_CLEARANCE,
  ArmRaiseHoldDetector,
  HEAD_FALLBACK_DROP,
  PART_TARGET_MAX_RADIUS,
  PART_TARGET_MIN_RADIUS,
  PART_TARGET_RADIUS,
  STROBE_END_HZ,
  STROBE_START_HZ,
  SWIPE_SPEED_THRESHOLD,
  THRUST_SPEED_THRESHOLD,
  WristVelocityTracker,
  approachRingScale,
  baselineHeadY,
  checkInZone,
  checkPartClearance,
  checkPartClearances,
  headCenter,
  classifyDodgeAndPose,
  computeCalibrationBaseline,
  getZoneBounds,
  judgePartTarget,
  judgePartTargets,
  judgeTelegraphDefense,
  judgeZoneBlast,
  lockPartTarget,
  lockPartTargets,
  partTargetRadius,
  resolveTorso,
  strobeCycles,
  strobeFrequencyHz,
  strobeIsRed,
  VIRTUAL_HIP_DROP,
  VIRTUAL_HIP_MAX_Y,
} from '../poseClassifiers';
import {
  SYNTHETIC_BODY,
  SYNTHETIC_GESTURE_CYCLE_MS,
  SyntheticPuppet,
  generateSequence,
  interpolateSyntheticPose,
  sampleSyntheticPose,
  silhouetteFromMetrics,
} from '../syntheticPoseGenerator';

function shiftLandmarks(
  landmarks: NormalizedLandmark[],
  indices: readonly number[],
  dx: number,
  dy: number,
): NormalizedLandmark[] {
  return landmarks.map((landmark, index) =>
    indices.includes(index) ? { ...landmark, x: landmark.x + dx, y: landmark.y + dy } : landmark,
  );
}

/** Grows the whole body around a point, like the player walking toward the camera. */
function scaleAbout(landmarks: NormalizedLandmark[], cx: number, cy: number, factor: number): NormalizedLandmark[] {
  return landmarks.map((landmark) => ({
    ...landmark,
    x: cx + (landmark.x - cx) * factor,
    y: cy + (landmark.y - cy) * factor,
  }));
}

function standingBaseline(): CalibrationBaseline {
  const frames = generateSequence('standing_in_zone', CALIBRATION_DURATION_MS, 0, 30, { breathe: false });
  const baseline = computeCalibrationBaseline(
    frames.map((frame) => frame.landmarks),
    CALIBRATION_DURATION_MS,
  );
  if (!baseline) throw new Error('standing clip did not produce a baseline');
  return baseline;
}

/** MediaPipe face points: nose, eyes, ears, mouth. */
const HEAD_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const LEFT_EAR = 7;
const RIGHT_EAR = 8;

function withLandmark(
  landmarks: NormalizedLandmark[],
  index: number,
  next: Partial<NormalizedLandmark>,
): NormalizedLandmark[] {
  return landmarks.map((landmark, landmarkIndex) =>
    landmarkIndex === index ? { ...landmark, ...next } : landmark,
  );
}

describe('computeCalibrationBaseline', () => {
  it('averages a 3 second standing clip into shoulder, hip, center, and head', () => {
    const baseline = standingBaseline();
    const head = headCenter(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }));
    expect(baseline.noseY).toBeCloseTo(head?.y ?? Number.NaN, 5);
    expect(baseline.noseY).toBeLessThan(baseline.shoulderY);
    expect(baseline.shoulderY).toBeCloseTo(SYNTHETIC_BODY.shoulderY, 5);
    expect(baseline.shoulderWidth).toBeCloseTo(SYNTHETIC_BODY.shoulderHalf * 2, 5);
    expect(baseline.hipY).toBeCloseTo(SYNTHETIC_BODY.hipY, 5);
    expect(baseline.centerX).toBeCloseTo(SYNTHETIC_BODY.centerX, 5);
    expect(baseline.calibratedAt).toBe(CALIBRATION_DURATION_MS);
  });

  it('stays near the standing body when the puppet is breathing', () => {
    const frames = generateSequence('standing_in_zone', CALIBRATION_DURATION_MS, 0, 30, { breathe: true });
    const baseline = computeCalibrationBaseline(
      frames.map((frame) => frame.landmarks),
      CALIBRATION_DURATION_MS,
    );
    expect(baseline).not.toBeNull();
    expect(baseline?.shoulderY).toBeCloseTo(SYNTHETIC_BODY.shoulderY, 2);
    expect(baseline?.centerX).toBeCloseTo(SYNTHETIC_BODY.centerX, 2);
    expect(baseline?.shoulderWidth).toBeCloseTo(SYNTHETIC_BODY.shoulderHalf * 2, 2);
  });

  it('returns null when no frame has shoulders and hips', () => {
    expect(computeCalibrationBaseline([], 0)).toBeNull();
    expect(computeCalibrationBaseline([[]], 10)).toBeNull();
    const short = Array.from({ length: 5 }, () => ({ x: 0.2, y: 0.2, z: 0, visibility: 1 }));
    expect(computeCalibrationBaseline([short], 10)).toBeNull();
  });

  it('skips broken frames and averages the rest', () => {
    const good = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const baseline = computeCalibrationBaseline([[], good, good], 42);
    expect(baseline?.centerX).toBeCloseTo(SYNTHETIC_BODY.centerX, 5);
    expect(baseline?.calibratedAt).toBe(42);
  });
});

describe('zone bounds and overlap', () => {
  it('places the horizontal zone a little wider than the shoulders', () => {
    const baseline: CalibrationBaseline = {
      shoulderY: 0.4,
      shoulderWidth: 0.2,
      hipY: 0.62,
      centerX: 0.5,
      calibratedAt: 1,
    };
    const bounds = getZoneBounds(baseline);
    const half = (baseline.shoulderWidth * ZONE_WIDTH_MULTIPLIER) / 2;
    expect(bounds.minX).toBeCloseTo(baseline.centerX - half, 5);
    expect(bounds.maxX).toBeCloseTo(baseline.centerX + half, 5);
    expect(bounds.topY).toBeLessThan(baseline.shoulderY);
    expect(bounds.bottomY).toBeGreaterThan(baseline.hipY);
  });

  it('fills the silhouette while standing and fades as the body leaves', () => {
    const baseline = standingBaseline();
    const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const partial = sampleSyntheticPose('out_of_zone', 0, { breathe: false });
    const left = sampleSyntheticPose('side_step_left', 0, { breathe: false });
    const right = sampleSyntheticPose('side_step_right', 0, { breathe: false });

    const standingZone = checkInZone(standing, baseline);
    const partialZone = checkInZone(partial, baseline);
    const leftZone = checkInZone(left, baseline);
    const rightZone = checkInZone(right, baseline);

    expect(standing).toHaveLength(POSE_LANDMARK_COUNT);
    expect(standingZone.inZone).toBe(true);
    expect(standingZone.overlapScore).toBeGreaterThan(0.85);
    expect(partialZone.inZone).toBe(false);
    expect(partialZone.overlapScore).toBeLessThan(standingZone.overlapScore);
    expect(partialZone.overlapScore).toBeGreaterThan(leftZone.overlapScore);
    expect(leftZone.inZone).toBe(false);
    expect(rightZone.inZone).toBe(false);
    expect(leftZone.overlapScore).toBeLessThan(0.2);
    expect(rightZone.overlapScore).toBeLessThan(0.2);
  });

  it('keeps a breathing stand inside the zone', () => {
    const baseline = standingBaseline();
    const frames = generateSequence('standing_in_zone', 1200, 0, 30, { breathe: true });
    for (const frame of frames) {
      expect(checkInZone(frame.landmarks, baseline).inZone).toBe(true);
    }
  });
});

describe('classifyDodgeAndPose', () => {
  const baseline = standingBaseline();

  it('reads a side step only after both shoulders and both hips clear the box', () => {
    const left = classifyDodgeAndPose(sampleSyntheticPose('side_step_left', 0, { breathe: false }), baseline);
    const right = classifyDodgeAndPose(sampleSyntheticPose('side_step_right', 0, { breathe: false }), baseline);
    const standing = classifyDodgeAndPose(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }), baseline);
    const partial = classifyDodgeAndPose(sampleSyntheticPose('out_of_zone', 0, { breathe: false }), baseline);

    expect(left.isSideStepLeft).toBe(true);
    expect(left.isSideStepRight).toBe(false);
    expect(right.isSideStepRight).toBe(true);
    expect(right.isSideStepLeft).toBe(false);
    expect(standing.isSideStepLeft).toBe(false);
    expect(standing.isSideStepRight).toBe(false);
    expect(partial.isSideStepLeft).toBe(false);
    expect(partial.isSideStepRight).toBe(false);
    expect(left.confidence).toBeGreaterThan(0.9);
  });

  it('ducks only once the shoulder midpoint drops past the threshold', () => {
    const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const exact = withLandmark(
      withLandmark(standing, POSE_LANDMARK.leftShoulder, {
        y: baseline.shoulderY + DUCK_THRESHOLD,
      }),
      POSE_LANDMARK.rightShoulder,
      { y: baseline.shoulderY + DUCK_THRESHOLD },
    );
    const past = withLandmark(
      withLandmark(standing, POSE_LANDMARK.leftShoulder, {
        y: baseline.shoulderY + DUCK_THRESHOLD + 0.01,
      }),
      POSE_LANDMARK.rightShoulder,
      { y: baseline.shoulderY + DUCK_THRESHOLD + 0.01 },
    );

    expect(classifyDodgeAndPose(standing, baseline).isDucking).toBe(false);
    expect(classifyDodgeAndPose(exact, baseline).isDucking).toBe(false);
    expect(classifyDodgeAndPose(past, baseline).isDucking).toBe(true);
    expect(classifyDodgeAndPose(sampleSyntheticPose('duck', 0, { breathe: false }), baseline).isDucking).toBe(true);
  });

  it('raises the right arm only when the wrist is above the nose', () => {
    const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const nose = standing[POSE_LANDMARK.nose];
    if (!nose) throw new Error('missing nose');
    const level = withLandmark(standing, POSE_LANDMARK.rightWrist, { y: nose.y - ARM_RAISE_CLEARANCE });
    const above = withLandmark(standing, POSE_LANDMARK.rightWrist, { y: nose.y - ARM_RAISE_CLEARANCE - 0.01 });

    expect(classifyDodgeAndPose(standing, baseline).isRightArmRaised).toBe(false);
    expect(classifyDodgeAndPose(level, baseline).isRightArmRaised).toBe(false);
    expect(classifyDodgeAndPose(above, baseline).isRightArmRaised).toBe(true);
    const raisedFrames = generateSequence('arm_raise', 400, 0, 30, { breathe: true });
    for (const frame of raisedFrames) {
      expect(classifyDodgeAndPose(frame.landmarks, baseline).isRightArmRaised).toBe(true);
    }
  });
});

describe('ArmRaiseHoldDetector', () => {
  it('locks the wheel once after a 1 second hold and ignores the rest of that raise', () => {
    const baseline = standingBaseline();
    const detector = new ArmRaiseHoldDetector();
    const frames = generateSequence('arm_raise', 1500, 0, 30, { breathe: true });
    const locks: number[] = [];
    for (const frame of frames) {
      const pose = classifyDodgeAndPose(frame.landmarks, baseline);
      const state = detector.update(pose.isRightArmRaised, frame.timestampMs);
      if (frame.timestampMs < ARM_RAISE_HOLD_MS) expect(state.locked).toBe(false);
      if (state.locked) locks.push(frame.timestampMs);
    }
    expect(locks).toHaveLength(1);
    expect(locks[0]).toBeGreaterThanOrEqual(ARM_RAISE_HOLD_MS);
    expect(locks[0]).toBeLessThan(ARM_RAISE_HOLD_MS + 40);
  });

  it('requires the arm to drop and the cooldown to finish before the next slot', () => {
    const detector = new ArmRaiseHoldDetector();
    expect(detector.update(true, 0).locked).toBe(false);
    expect(detector.update(true, 1000)).toMatchObject({ locked: true, heldMs: 1000 });
    expect(detector.update(true, 1600).locked).toBe(false);
    expect(detector.update(false, 1700)).toMatchObject({ locked: false, counting: false });
    expect(detector.update(true, 1800)).toMatchObject({ locked: false, counting: false, heldMs: 0 });
    expect(detector.update(true, 1950)).toMatchObject({ counting: true, heldMs: 0 });
    expect(detector.update(true, 2949).locked).toBe(false);
    expect(detector.update(true, 2950).locked).toBe(true);
  });

  it('cancels a hold that drops before the second is up', () => {
    const detector = new ArmRaiseHoldDetector();
    detector.update(true, 0);
    expect(detector.update(true, 400).heldMs).toBe(400);
    detector.update(false, 500);
    expect(detector.update(true, 800).heldMs).toBe(0);
    expect(detector.update(true, 1799).locked).toBe(false);
    expect(detector.update(true, 1800).locked).toBe(true);
  });
});

describe('WristVelocityTracker', () => {
  it('detects a left swipe, a right swipe, and a thrust with power in range', () => {
    const cases = [
      { preset: 'swipe_left' as const, action: 'swipe_left' as const },
      { preset: 'swipe_right' as const, action: 'swipe_right' as const },
      { preset: 'thrust' as const, action: 'thrust' as const },
    ];

    for (const entry of cases) {
      const tracker = new WristVelocityTracker();
      const frames = generateSequence(entry.preset, SYNTHETIC_GESTURE_CYCLE_MS, 0, 30, { breathe: true });
      const hits = frames
        .map((frame) => tracker.update(frame.landmarks, frame.timestampMs))
        .filter((gesture) => gesture.action === entry.action);
      expect(hits.length, entry.preset).toBeGreaterThan(0);
      expect(hits.some((gesture) => gesture.action !== entry.action)).toBe(false);
      for (const hit of hits) {
        expect(hit.power).toBeGreaterThanOrEqual(1);
        expect(hit.power).toBeLessThanOrEqual(1.5);
        expect(hit.speed).toBeGreaterThan(0);
      }
    }
  });

  it('does not invent a swipe or thrust from standing, ducking, or an arm raise', () => {
    for (const preset of ['standing_in_zone', 'duck', 'arm_raise'] as const) {
      const tracker = new WristVelocityTracker();
      const frames = generateSequence(preset, SYNTHETIC_GESTURE_CYCLE_MS, 0, 30, { breathe: true });
      for (const frame of frames) {
        expect(tracker.update(frame.landmarks, frame.timestampMs).action).toBe('none');
      }
    }
  });

  it('keeps swipe speed above the horizontal threshold and thrust speed above the forward threshold', () => {
    const swipe = new WristVelocityTracker();
    const swipeFrames = generateSequence('swipe_left', SYNTHETIC_GESTURE_CYCLE_MS, 0, 30, { breathe: false });
    const swipeHits = swipeFrames
      .map((frame) => swipe.update(frame.landmarks, frame.timestampMs))
      .filter((gesture) => gesture.action === 'swipe_left');
    expect(Math.max(...swipeHits.map((gesture) => gesture.speed))).toBeGreaterThan(SWIPE_SPEED_THRESHOLD);

    const thrust = new WristVelocityTracker();
    const thrustFrames = generateSequence('thrust', SYNTHETIC_GESTURE_CYCLE_MS, 0, 30, { breathe: false });
    const thrustHits = thrustFrames
      .map((frame) => thrust.update(frame.landmarks, frame.timestampMs))
      .filter((gesture) => gesture.action === 'thrust');
    expect(Math.max(...thrustHits.map((gesture) => gesture.speed))).toBeGreaterThan(THRUST_SPEED_THRESHOLD);
  });
});

describe('close-up webcam with hips off screen', () => {
  /** Zoom the standing puppet the way a laptop camera sees someone 1 m away. Anything below the frame fades out. */
  function closeUp(landmarks: NormalizedLandmark[], shiftX = 0, shiftY = 0): NormalizedLandmark[] {
    return landmarks.map((landmark) => {
      const x = 0.5 + (landmark.x - 0.5) * 2.2 + shiftX;
      const y = 0.05 + landmark.y * 2 + shiftY;
      return { ...landmark, x, y, visibility: y > 1 ? 0.05 : landmark.visibility };
    });
  }

  const standing = closeUp(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }));
  const baseline = computeCalibrationBaseline([standing], 7);

  it('places virtual hips under the shoulders when the real hips are below the frame', () => {
    const torso = resolveTorso(standing);
    expect(torso?.hipsEstimated).toBe(true);
    const leftShoulder = standing[POSE_LANDMARK.leftShoulder];
    const rightShoulder = standing[POSE_LANDMARK.rightShoulder];
    if (!leftShoulder || !rightShoulder || !torso) throw new Error('missing shoulders');
    const midY = (leftShoulder.y + rightShoulder.y) / 2;
    const width = Math.abs(leftShoulder.x - rightShoulder.x);
    expect(torso.leftHip.y).toBeCloseTo(Math.min(VIRTUAL_HIP_MAX_Y, midY + width * VIRTUAL_HIP_DROP), 5);
    expect(torso.leftHip.x).toBeGreaterThan(Math.min(leftShoulder.x, rightShoulder.x));
    expect(torso.leftHip.x).toBeLessThan(Math.max(leftShoulder.x, rightShoulder.x));
  });

  it('calibrates, sits in the zone, and reports upper-body confidence', () => {
    expect(baseline).not.toBeNull();
    if (!baseline) return;
    expect(baseline.hipY).toBeLessThanOrEqual(VIRTUAL_HIP_MAX_Y);
    const zone = checkInZone(standing, baseline);
    expect(zone.inZone).toBe(true);
    expect(zone.overlapScore).toBeGreaterThan(0.85);
    const pose = classifyDodgeAndPose(standing, baseline);
    expect(pose.hipsEstimated).toBe(true);
    expect(pose.confidence).toBeGreaterThan(0.9);
  });

  it('still reads side steps and ducks', () => {
    if (!baseline) throw new Error('no close-up baseline');
    const left = classifyDodgeAndPose(closeUp(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }), 0.48), baseline);
    const right = classifyDodgeAndPose(closeUp(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }), -0.48), baseline);
    const duck = classifyDodgeAndPose(
      closeUp(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }), 0, DUCK_THRESHOLD + 0.03),
      baseline,
    );
    expect(left.isSideStepLeft).toBe(true);
    expect(right.isSideStepRight).toBe(true);
    expect(duck.isDucking).toBe(true);
    expect(classifyDodgeAndPose(standing, baseline).isDucking).toBe(false);
    expect(checkInZone(closeUp(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }), 0.48), baseline).inZone).toBe(false);
  });

  it('keeps using the real hips when the full body is in frame', () => {
    const full = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    expect(resolveTorso(full)?.hipsEstimated).toBe(false);
    expect(classifyDodgeAndPose(full, standingBaseline()).hipsEstimated).toBe(false);
  });

  it('still needs both shoulders', () => {
    const noShoulder = withLandmark(standing, POSE_LANDMARK.leftShoulder, { visibility: 0.1 });
    expect(resolveTorso(noShoulder)).toBeNull();
    expect(computeCalibrationBaseline([noShoulder], 1)).toBeNull();
    expect(classifyDodgeAndPose(noShoulder, standingBaseline()).confidence).toBe(0);
  });
});

describe('telegraph defense', () => {
  const baseline = standingBaseline();
  const poseOf = (preset: 'standing_in_zone' | 'side_step_left' | 'side_step_right' | 'duck') =>
    classifyDodgeAndPose(sampleSyntheticPose(preset, 0, { breathe: false }), baseline);

  it('matches each P0 telegraph to the body that answers it', () => {
    const standing = poseOf('standing_in_zone');
    const left = poseOf('side_step_left');
    const right = poseOf('side_step_right');
    const duck = poseOf('duck');

    expect(judgeTelegraphDefense('low_sweep', standing).dodged).toBe(false);
    expect(judgeTelegraphDefense('low_sweep', duck).dodged).toBe(false);
    expect(judgeTelegraphDefense('low_sweep', left)).toMatchObject({ dodged: true, action: 'side_step_left' });
    expect(judgeTelegraphDefense('low_sweep', right)).toMatchObject({ dodged: true, action: 'side_step_right' });

    expect(judgeTelegraphDefense('high_swing', left).dodged).toBe(false);
    expect(judgeTelegraphDefense('high_swing', duck)).toMatchObject({ dodged: true, action: 'duck' });

    expect(judgeTelegraphDefense('projectile', standing).dodged).toBe(false);
    expect(judgeTelegraphDefense('projectile', right).dodged).toBe(true);
    expect(judgeTelegraphDefense('projectile', standing, true)).toMatchObject({ dodged: true });
  });
});

describe('synthetic puppet continuity', () => {
  it('interpolates shoulder height from a stand into a duck', () => {
    const standing = sampleSyntheticPose('standing_in_zone', 1000, { breathe: false });
    const duck = sampleSyntheticPose('duck', 1000, { breathe: false });
    const mid = interpolateSyntheticPose('standing_in_zone', 'duck', 1000, 0.5, { breathe: false });
    const shoulder = POSE_LANDMARK.leftShoulder;
    const from = standing[shoulder];
    const to = duck[shoulder];
    const blended = mid[shoulder];
    if (!from || !to || !blended) throw new Error('missing shoulder');
    expect(blended.y).toBeCloseTo((from.y + to.y) / 2, 4);
  });

  it('eases the puppet onto the requested preset', () => {
    const puppet = new SyntheticPuppet(200);
    puppet.setPreset('duck', 0);
    const atStart = puppet.sample(0, { breathe: false });
    const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const shoulder = POSE_LANDMARK.leftShoulder;
    expect(atStart[shoulder]?.y).toBeCloseTo(standing[shoulder]?.y ?? 0, 4);

    const atEnd = puppet.sample(200, { breathe: false });
    const duck = sampleSyntheticPose('duck', 200, { breathe: false });
    expect(atEnd[shoulder]?.y).toBeCloseTo(duck[shoulder]?.y ?? 0, 4);
  });
});

describe('Osu! body-part target rings', () => {
  const aspect = 16 / 9;
  const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
  const target = (part: Parameters<typeof lockPartTarget>[1]) => {
    const locked = lockPartTarget(standing, part, aspect);
    if (!locked) throw new Error(`no ${part} target`);
    return locked;
  };

  /** Slide only the given landmarks, leaving the rest of the body where it was. */
  function shift(landmarks: NormalizedLandmark[], indices: readonly number[], dx: number, dy: number): NormalizedLandmark[] {
    return landmarks.map((landmark, index) =>
      indices.includes(index) ? { ...landmark, x: landmark.x + dx, y: landmark.y + dy } : landmark,
    );
  }

  it('locks on the part and sizes the circle from shoulder width in frame-height units', () => {
    const head = target('head');
    const nose = standing[POSE_LANDMARK.nose];
    const leftEar = standing[LEFT_EAR];
    const rightEar = standing[RIGHT_EAR];
    expect(head.x).toBeCloseTo(((nose?.x ?? 0) + (leftEar?.x ?? 0) + (rightEar?.x ?? 0)) / 3, 6);
    expect(head.y).toBeCloseTo(((nose?.y ?? 0) + (leftEar?.y ?? 0) + (rightEar?.y ?? 0)) / 3, 6);
    expect(head.radius).toBeCloseTo(SYNTHETIC_BODY.shoulderHalf * 2 * PART_TARGET_RADIUS.head * aspect, 6);

    const left = target('left_shoulder');
    expect(left.x).toBeCloseTo(standing[POSE_LANDMARK.leftShoulder]?.x ?? 0, 6);
    const chest = target('chest');
    expect(chest.x).toBeCloseTo(SYNTHETIC_BODY.centerX, 6);
    expect(chest.y).toBeCloseTo(SYNTHETIC_BODY.shoulderY, 6);

    const noShoulder = withLandmark(standing, POSE_LANDMARK.rightShoulder, { visibility: 0 });
    expect(lockPartTarget(noShoulder, 'head', aspect)).toBeNull();
  });

  it('stays in danger while the part sits still, for every part', () => {
    for (const part of ['head', 'left_shoulder', 'right_shoulder', 'chest'] as const) {
      const clearance = checkPartClearance(standing, target(part));
      expect(clearance.cleared).toBe(false);
      expect(clearance.inside).toBeGreaterThan(0);
      expect(clearance.closest).toBeLessThanOrEqual(1);
    }
  });

  it('measures a round circle on a wide frame', () => {
    const head = target('head');
    const edgeX = head.radius / head.aspect;
    const moved = (dx: number, dy: number) => shift(standing, HEAD_INDICES, dx, dy);
    expect(checkPartClearance(moved(edgeX * 0.98, 0), head).cleared).toBe(false);
    expect(checkPartClearance(moved(edgeX * 1.02, 0), head).cleared).toBe(true);
    expect(checkPartClearance(moved(0, head.radius * 1.02), head).cleared).toBe(true);
  });

  it('needs the whole head to leave, so a nose tilt alone stays in danger', () => {
    const noseOnly = shift(standing, [POSE_LANDMARK.nose], 0.06, 0.02);
    expect(checkPartClearance(noseOnly, target('head')).cleared).toBe(false);
  });

  it('clears only the part that moved', () => {
    const headIndices = HEAD_INDICES;
    const leftArm = [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.leftElbow, POSE_LANDMARK.leftWrist];
    const headTilt = shift(standing, headIndices, 0.06, 0.02);
    expect(checkPartClearance(headTilt, target('head')).cleared).toBe(true);
    expect(checkPartClearance(headTilt, target('left_shoulder')).cleared).toBe(false);

    const leanLeft = shift(standing, leftArm, 0.07, 0);
    expect(checkPartClearance(leanLeft, target('left_shoulder')).cleared).toBe(true);
    expect(checkPartClearance(leanLeft, target('right_shoulder')).cleared).toBe(false);
    expect(checkPartClearance(leanLeft, target('head')).cleared).toBe(false);
  });

  it('reads whole-body dodges as clearing every ring', () => {
    const duck = sampleSyntheticPose('duck', 0, { breathe: false });
    const stepLeft = sampleSyntheticPose('side_step_left', 0, { breathe: false });
    expect(checkPartClearance(duck, target('head')).cleared).toBe(true);
    expect(checkPartClearance(duck, target('chest')).cleared).toBe(true);
    expect(checkPartClearance(stepLeft, target('left_shoulder')).cleared).toBe(true);
    expect(checkPartClearance(stepLeft, target('right_shoulder')).cleared).toBe(true);
  });

  it('counts a part that left the frame as cleared', () => {
    expect(checkPartClearance(null, target('head'))).toMatchObject({ cleared: true, tracked: 0 });
  });

  it('judges HIT inside the circle, DODGED outside or with a parry', () => {
    const head = target('head');
    expect(judgePartTarget(head, checkPartClearance(standing, head)).dodged).toBe(false);
    expect(judgePartTarget(head, checkPartClearance(standing, head), true).dodged).toBe(true);
    const duck = sampleSyntheticPose('duck', 0, { breathe: false });
    expect(judgePartTarget(head, checkPartClearance(duck, head))).toMatchObject({ dodged: true, part: 'head' });
  });

  it('shrinks the approach ring from the start scale to the inner circle', () => {
    expect(approachRingScale(0)).toBe(APPROACH_RING_START_SCALE);
    expect(approachRingScale(0.5)).toBeCloseTo((APPROACH_RING_START_SCALE + 1) / 2, 6);
    expect(approachRingScale(1)).toBe(1);
    expect(approachRingScale(-1)).toBe(APPROACH_RING_START_SCALE);
    expect(approachRingScale(2)).toBe(1);
  });
});

describe('silhouette head', () => {
  it('falls back to a head center a fixed share of shoulder width above the shoulders', () => {
    const baseline: CalibrationBaseline = { shoulderY: 0.4, shoulderWidth: 0.2, hipY: 0.8, centerX: 0.5, calibratedAt: 0 };
    const aspect = 16 / 9;
    expect(baselineHeadY(baseline, aspect)).toBeCloseTo(0.4 - 0.2 * aspect * HEAD_FALLBACK_DROP, 6);
    expect(baselineHeadY({ ...baseline, noseY: 0.22 }, aspect)).toBe(0.22);
  });

  it('leaves the head out of the baseline when no face was seen', () => {
    const faceless = sampleSyntheticPose('standing_in_zone', 0, { breathe: false }).map((landmark, index) =>
      HEAD_INDICES.includes(index as (typeof HEAD_INDICES)[number]) ? { ...landmark, visibility: 0 } : landmark,
    );
    const baseline = computeCalibrationBaseline([faceless], 0);
    expect(baseline?.noseY).toBeUndefined();
  });

  it('scales face points with the calibrated shoulders instead of using a fixed-size face', () => {
    const metrics = { centerX: 0.5, shoulderY: 0.4, hipY: 0.8, noseY: 0.25 };
    const narrow = silhouetteFromMetrics({ ...metrics, shoulderHalf: 0.09, hipHalf: 0.075 });
    const wide = silhouetteFromMetrics({ ...metrics, shoulderHalf: 0.18, hipHalf: 0.15 });
    const earSpan = (landmarks: NormalizedLandmark[]) =>
      Math.abs((landmarks[LEFT_EAR]?.x ?? 0) - (landmarks[RIGHT_EAR]?.x ?? 0));
    expect(earSpan(wide)).toBeCloseTo(earSpan(narrow) * 2, 6);
    expect(wide[POSE_LANDMARK.nose]?.y).toBe(0.25);
  });
});

describe('proportional ring sizing', () => {
  const aspect = 16 / 9;

  it('scales every ring linearly with shoulder width between the clamps', () => {
    for (const part of ['head', 'left_shoulder', 'right_shoulder', 'chest'] as const) {
      const far = partTargetRadius(part, 0.15);
      const near = partTargetRadius(part, 0.3);
      expect(far).toBeCloseTo(0.15 * PART_TARGET_RADIUS[part], 6);
      expect(near).toBeCloseTo(far * 2, 6);
    }
  });

  it('keeps a tiny far body visible and a face at the lens dodgeable', () => {
    expect(partTargetRadius('head', 0.01)).toBe(PART_TARGET_MIN_RADIUS);
    expect(partTargetRadius('head', 0)).toBe(PART_TARGET_MIN_RADIUS);
    expect(partTargetRadius('head', Number.NaN)).toBe(PART_TARGET_MIN_RADIUS);
    expect(partTargetRadius('head', 0.9)).toBe(PART_TARGET_MAX_RADIUS.head);
    expect(partTargetRadius('chest', 0.9)).toBe(PART_TARGET_MAX_RADIUS.chest);
  });

  it('sizes the head ring a little wider than the head, about half a shoulder width across', () => {
    const width = 0.2;
    const diameter = partTargetRadius('head', width) * 2;
    expect(diameter / width).toBeGreaterThan(0.5);
    expect(diameter / width).toBeLessThan(0.6);
  });

  it('sizes from the calibrated shoulder width when given, even with the torso turned', () => {
    const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const turned = shiftLandmarks(standing, [POSE_LANDMARK.leftShoulder], -0.06, 0);
    const live = lockPartTarget(turned, 'head', aspect);
    const calibrated = lockPartTarget(turned, 'head', aspect, 0.18);
    expect(calibrated?.radius).toBeCloseTo(partTargetRadius('head', 0.18) * aspect, 6);
    expect(live?.radius ?? 0).toBeLessThan(calibrated?.radius ?? 0);
  });

  it('locks a head ring from the calibrated width even when a shoulder drops out', () => {
    const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const noShoulder = withLandmark(standing, POSE_LANDMARK.rightShoulder, { visibility: 0 });
    expect(lockPartTarget(noShoulder, 'head', aspect)).toBeNull();
    expect(lockPartTarget(noShoulder, 'head', aspect, 0.18)?.part).toBe('head');
  });

  it('matches a closer player with a proportionally bigger ring', () => {
    const near = scaleAbout(sampleSyntheticPose('standing_in_zone', 0, { breathe: false }), 0.5, 0.4, 2);
    const far = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
    const nearHead = lockPartTarget(near, 'head', aspect);
    const farHead = lockPartTarget(far, 'head', aspect);
    expect((nearHead?.radius ?? 0) / (farHead?.radius ?? 1)).toBeCloseTo(2, 6);
  });
});

describe('dual target rings', () => {
  const aspect = 16 / 9;
  const standing = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
  const leftArm = [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.leftElbow, POSE_LANDMARK.leftWrist];
  const rightArm = [POSE_LANDMARK.rightShoulder, POSE_LANDMARK.rightElbow, POSE_LANDMARK.rightWrist];

  function lock(parts: Parameters<typeof lockPartTargets>[1]) {
    const targets = lockPartTargets(standing, parts, aspect);
    if (!targets) throw new Error('no targets');
    return targets;
  }

  it('locks one ring per part, in order', () => {
    const targets = lock(['head', 'left_shoulder']);
    expect(targets.map((target) => target.part)).toEqual(['head', 'left_shoulder']);
    expect(lockPartTargets(withLandmark(standing, POSE_LANDMARK.leftShoulder, { visibility: 0 }), ['head', 'left_shoulder'], aspect)).toBeNull();
  });

  it('keeps rings from overlapping on a standing body', () => {
    const [head, left] = lock(['head', 'left_shoulder']);
    if (!head || !left) throw new Error('missing ring');
    const gap = Math.hypot((head.x - left.x) * aspect, head.y - left.y);
    expect(gap).toBeGreaterThan(head.radius + left.radius);
  });

  it('judges HIT when only one of two parts cleared', () => {
    const targets = lock(['head', 'left_shoulder']);
    const headOnly = shiftLandmarks(standing, HEAD_INDICES, 0.08, 0);
    const clearances = checkPartClearances(headOnly, targets);
    expect(clearances.map((clearance) => clearance.cleared)).toEqual([true, false]);
    const judgment = judgePartTargets(targets, clearances);
    expect(judgment).toMatchObject({ kind: 'part_ring', dodged: false, parts: ['head', 'left_shoulder'] });
    expect(judgment.detail).toContain('Left Shoulder');
  });

  it('judges DODGED only when both parts are outside their circles', () => {
    const targets = lock(['left_shoulder', 'right_shoulder']);
    const both = shiftLandmarks(shiftLandmarks(standing, leftArm, 0.08, 0), rightArm, -0.08, 0);
    const clearances = checkPartClearances(both, targets);
    expect(clearances.every((clearance) => clearance.cleared)).toBe(true);
    expect(judgePartTargets(targets, clearances).dodged).toBe(true);
  });

  it('treats a whole-body side step as clearing every ring at once', () => {
    const targets = lock(['head', 'right_shoulder']);
    const stepped = sampleSyntheticPose('side_step_left', 0, { breathe: false });
    expect(judgePartTargets(targets, checkPartClearances(stepped, targets)).dodged).toBe(true);
  });

  it('counts a missing clearance as still inside, and a parry as a dodge', () => {
    const targets = lock(['head', 'left_shoulder']);
    const clearances = checkPartClearances(standing, targets);
    expect(judgePartTargets(targets, clearances.slice(0, 1)).dodged).toBe(false);
    expect(judgePartTargets(targets, clearances, true).dodged).toBe(true);
    expect(judgePartTargets([], []).dodged).toBe(false);
  });

  it('matches the single-ring verdict for one target', () => {
    const [head] = lock(['head']);
    if (!head) throw new Error('missing ring');
    const clearance = checkPartClearance(standing, head);
    expect(judgePartTargets([head], [clearance])).toEqual(judgePartTarget(head, clearance));
  });
});

describe('whole-body silhouette blast', () => {
  const durationMs = 3000;

  it('ramps the strobe from the start rate to the end rate, faster near impact', () => {
    expect(strobeFrequencyHz(0)).toBe(STROBE_START_HZ);
    expect(strobeFrequencyHz(1)).toBe(STROBE_END_HZ);
    expect(strobeFrequencyHz(5)).toBe(STROBE_END_HZ);
    let previous = 0;
    for (let i = 0; i <= 10; i += 1) {
      const hz = strobeFrequencyHz(i / 10);
      expect(hz).toBeGreaterThanOrEqual(previous);
      previous = hz;
    }
    const firstHalf = strobeFrequencyHz(0.5) - strobeFrequencyHz(0);
    const secondHalf = strobeFrequencyHz(1) - strobeFrequencyHz(0.5);
    expect(secondHalf).toBeGreaterThan(firstHalf);
  });

  it('integrates the rate into a smooth cycle count', () => {
    expect(strobeCycles(0, durationMs)).toBe(0);
    const total = (durationMs / 1000) * (STROBE_START_HZ + (STROBE_END_HZ - STROBE_START_HZ) / 3);
    expect(strobeCycles(1, durationMs)).toBeCloseTo(total, 6);
    const dp = 1e-4;
    for (const p of [0.1, 0.5, 0.9]) {
      const rate = (strobeCycles(p + dp, durationMs) - strobeCycles(p, durationMs)) / (dp * (durationMs / 1000));
      expect(rate).toBeCloseTo(strobeFrequencyHz(p), 2);
    }
  });

  it('opens on red, flips more often near impact, and locks red at impact', () => {
    expect(strobeIsRed(0, durationMs)).toBe(true);
    expect(strobeIsRed(1, durationMs)).toBe(true);
    expect(strobeIsRed(1.4, durationMs)).toBe(true);
    const flipsBetween = (from: number, to: number): number => {
      let flips = 0;
      let last = strobeIsRed(from, durationMs);
      for (let p = from; p < to; p += 0.001) {
        const red = strobeIsRed(p, durationMs);
        if (red !== last) flips += 1;
        last = red;
      }
      return flips;
    };
    expect(flipsBetween(0.9, 0.999)).toBeGreaterThan(flipsBetween(0, 0.1) * 3);
  });

  it('dodges only when the torso leaves the silhouette or ducks under it', () => {
    const baseline = standingBaseline();
    const poseOf = (preset: 'standing_in_zone' | 'side_step_left' | 'side_step_right' | 'duck') =>
      classifyDodgeAndPose(sampleSyntheticPose(preset, 0, { breathe: false }), baseline);
    expect(judgeZoneBlast(poseOf('standing_in_zone')).dodged).toBe(false);
    expect(judgeZoneBlast(poseOf('side_step_left'))).toMatchObject({ dodged: true, action: 'side_step_left' });
    expect(judgeZoneBlast(poseOf('side_step_right'))).toMatchObject({ dodged: true, action: 'side_step_right' });
    expect(judgeZoneBlast(poseOf('duck'))).toMatchObject({ dodged: true, action: 'duck' });
  });
});
