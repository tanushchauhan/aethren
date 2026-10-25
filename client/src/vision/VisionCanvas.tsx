import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CalibrationBaseline, NormalizedLandmark, PoseActionType, PoseFrame } from '@once-upon/shared';
import {
  BODY_PART_TAG,
  actionBadgeLabel,
  approachRingScale,
  getZoneBounds,
  strobeCycles,
  strobeIsRed,
  type PartTarget,
} from './poseClassifiers';
import { silhouetteFromMetrics } from './syntheticPoseGenerator';
import type { VisionSourceMode } from './poseLandmarkerService';

/**
 * A ring or blast attack the canvas animates. Times share the `performance.now()` clock, so the
 * ring shrinks and the strobe flips at the display rate instead of the pose tick rate.
 */
export interface CombatOverlay {
  kind: 'part_ring' | 'zone_blast';
  startAt: number;
  judgeAt: number;
  /** Frozen ring center for `part_ring`. Null for a blast. */
  target: PartTarget | null;
  /** True while the targeted part (or the whole torso) is out of danger right now. */
  clear: boolean;
  /** Set once the attack is judged, which plays the burst and the call-back pulse. */
  impact: { at: number; dodged: boolean } | null;
}

export interface VisionCanvasModel {
  source: VisionSourceMode;
  landmarks: NormalizedLandmark[] | null;
  baseline: CalibrationBaseline | null;
  calibrated: boolean;
  inZone: boolean;
  overlapScore: number;
  activeAction: PoseActionType;
  /** Elapsed calibration time, clamped to 0..3000 by the caller. */
  calibrationMs: number;
  calibrating: boolean;
  streamHz: number;
  streamPulse: number;
  teammatePoses: readonly PoseFrame[];
  armHoldMs: number;
  armCounting: boolean;
  confidence: number;
  actionNote: string;
  /** Optional so other labs can keep building the model without attacks. */
  combat?: CombatOverlay | null;
}

interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PaintStyle {
  stroke: string;
  fill: string;
  glow: string;
  lineWidth: number;
  /** Fill the head and torso so a silhouette can fade in with overlap. */
  fillBody: boolean;
}

const POSE_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

const GOLD = '#f5c16c';
const GREEN = '#8dffc1';
const BONE = '#e7fff4';
const CRIMSON = '#ff2d55';
const EMERALD = '#34f5a0';
const EMBER = '#ff8a3d';

/** How long the impact burst plays after an attack is judged. */
const IMPACT_BURST_MS = 900;

let audioContext: AudioContext | null = null;

function primeSilhouetteAudio(): void {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === 'suspended') void audioContext.resume();
}

function playSilhouetteChime(): void {
  try {
    primeSilhouetteAudio();
    if (!audioContext || audioContext.state !== 'running') return;
    const ctx = audioContext;
    const now = ctx.currentTime;
    const notes = [659.25, 987.77];
    for (let index = 0; index < notes.length; index += 1) {
      const freq = notes[index] ?? 880;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const start = now + index * 0.08;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.36);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    // A headless browser or a blocked autoplay policy still gets the green snap.
  }
}

/** Call from a click handler so the strobe ticks and impact sounds are allowed to play. */
export function primeVisionAudio(): void {
  primeSilhouetteAudio();
}

function playTone(freq: number, endFreq: number, durationS: number, type: OscillatorType, peak: number): void {
  try {
    if (!audioContext || audioContext.state !== 'running') return;
    const ctx = audioContext;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + durationS);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationS);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationS + 0.02);
  } catch {
    // Sound is a bonus. The canvas still shows every cue.
  }
}

/** Rising tension tick on each red flash. Pitch climbs with the countdown. */
function playStrobeTick(progress: number): void {
  const freq = 420 + 760 * progress;
  playTone(freq, freq * 1.04, 0.05, 'square', 0.05);
}

function playImpact(dodged: boolean): void {
  if (dodged) {
    playTone(784, 1568, 0.22, 'triangle', 0.14);
  } else {
    playTone(180, 45, 0.45, 'sawtooth', 0.2);
  }
}

function clampProgress(nowMs: number, overlay: CombatOverlay): number {
  const span = Math.max(1, overlay.judgeAt - overlay.startAt);
  return Math.min(1, Math.max(0, (nowMs - overlay.startAt) / span));
}

function contentRect(video: HTMLVideoElement | null, width: number, height: number, source: VisionSourceMode): FrameRect {
  if (source !== 'webcam' || !video || video.videoWidth === 0 || video.videoHeight === 0) {
    return { x: 0, y: 0, w: width, h: height };
  }
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

function mapPoint(x: number, y: number, rect: FrameRect, mirror: boolean): [number, number] {
  const mx = mirror ? 1 - x : x;
  return [rect.x + mx * rect.w, rect.y + y * rect.h];
}

function drawForest(ctx: CanvasRenderingContext2D, width: number, height: number, nowMs: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#07121c');
  sky.addColorStop(0.45, '#0c1c18');
  sky.addColorStop(1, '#07110d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const moonX = width * 0.78;
  const moonY = height * 0.18;
  const moonR = Math.min(width, height) * 0.07;
  const moon = ctx.createRadialGradient(moonX, moonY, moonR * 0.2, moonX, moonY, moonR * 3);
  moon.addColorStop(0, 'rgba(255, 236, 196, 0.95)');
  moon.addColorStop(0.25, 'rgba(245, 193, 108, 0.35)');
  moon.addColorStop(1, 'rgba(245, 193, 108, 0)');
  ctx.fillStyle = moon;
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonR * 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#040a08';
  const trees = [
    { x: 0.08, h: 0.62, w: 0.1 },
    { x: 0.18, h: 0.48, w: 0.07 },
    { x: 0.86, h: 0.7, w: 0.12 },
    { x: 0.94, h: 0.5, w: 0.08 },
    { x: 0.72, h: 0.42, w: 0.06 },
  ];
  for (const tree of trees) {
    const baseX = tree.x * width;
    const top = height * (1 - tree.h);
    ctx.beginPath();
    ctx.moveTo(baseX, height);
    ctx.lineTo(baseX + tree.w * width, height);
    ctx.lineTo(baseX + tree.w * width * 0.5, top);
    ctx.closePath();
    ctx.fill();
  }

  const mist = ctx.createLinearGradient(0, height * 0.62, 0, height);
  mist.addColorStop(0, 'rgba(120, 170, 140, 0)');
  mist.addColorStop(1, 'rgba(150, 190, 160, 0.16)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, height * 0.62, width, height * 0.38);

  for (let i = 0; i < 16; i += 1) {
    const phase = nowMs / 900 + i * 1.7;
    const x = ((i * 97) % 100) / 100 * width;
    const y = height * (0.2 + ((i * 53) % 60) / 100) + Math.sin(phase) * 8;
    const alpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 1.6));
    ctx.fillStyle = `rgba(255, 226, 160, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.4 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawVideo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, rect: FrameRect): void {
  ctx.save();
  ctx.translate(rect.x + rect.w, rect.y);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, rect.w, rect.h);
  ctx.restore();
  ctx.fillStyle = 'rgba(4, 12, 10, 0.28)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
}

function traceEdges(
  ctx: CanvasRenderingContext2D,
  landmarks: readonly NormalizedLandmark[],
  rect: FrameRect,
  mirror: boolean,
  placed?: readonly (readonly [number, number])[],
): void {
  ctx.beginPath();
  for (const [start, end] of POSE_EDGES) {
    const a = placed ? placed[start] : mapPoint(landmarks[start]?.x ?? 0, landmarks[start]?.y ?? 0, rect, mirror);
    const b = placed ? placed[end] : mapPoint(landmarks[end]?.x ?? 0, landmarks[end]?.y ?? 0, rect, mirror);
    if (!a || !b) continue;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
}

function placeLandmarks(
  landmarks: readonly NormalizedLandmark[],
  rect: FrameRect,
  mirror: boolean,
  slot: { x: number; y: number; scale: number } | null,
): [number, number][] {
  const raw = landmarks.map((landmark) => mapPoint(landmark.x, landmark.y, rect, mirror));
  if (!slot) return raw;
  let sx = 0;
  let sy = 0;
  for (const point of raw) {
    sx += point[0];
    sy += point[1];
  }
  const cx = sx / Math.max(1, raw.length);
  const cy = sy / Math.max(1, raw.length);
  return raw.map(([x, y]) => [slot.x + (x - cx) * slot.scale, slot.y + (y - cy) * slot.scale]);
}

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: readonly NormalizedLandmark[],
  rect: FrameRect,
  mirror: boolean,
  style: PaintStyle,
  slot: { x: number; y: number; scale: number } | null,
): void {
  const placed = placeLandmarks(landmarks, rect, mirror, slot);
  ctx.save();
  ctx.lineWidth = style.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = style.stroke;
  ctx.fillStyle = style.fill;
  if (style.fillBody) fillBody(ctx, placed);
  ctx.shadowColor = style.glow;
  ctx.shadowBlur = style.lineWidth * 4;
  traceEdges(ctx, landmarks, rect, mirror, placed);
  ctx.shadowBlur = 0;
  ctx.fillStyle = style.stroke;
  for (const index of JOINTS) {
    const joint = placed[index];
    if (!joint) continue;
    ctx.beginPath();
    ctx.arc(joint[0], joint[1], Math.max(2, style.lineWidth * 0.7), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function fillBody(ctx: CanvasRenderingContext2D, placed: readonly (readonly [number, number])[]): void {
  const nose = placed[0];
  const leftShoulder = placed[11];
  const rightShoulder = placed[12];
  const leftHip = placed[23];
  const rightHip = placed[24];
  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    ctx.beginPath();
    ctx.moveTo(leftShoulder[0], leftShoulder[1]);
    ctx.lineTo(rightShoulder[0], rightShoulder[1]);
    ctx.lineTo(rightHip[0], rightHip[1]);
    ctx.lineTo(leftHip[0], leftHip[1]);
    ctx.closePath();
    ctx.fill();
  }
  if (nose && leftShoulder && rightShoulder) {
    const shoulderY = (leftShoulder[1] + rightShoulder[1]) / 2;
    const radius = Math.max(10, Math.abs(shoulderY - nose[1]) * 0.72);
    ctx.beginPath();
    ctx.arc(nose[0], nose[1], radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function zoneRect(baseline: CalibrationBaseline, rect: FrameRect): FrameRect {
  const bounds = getZoneBounds(baseline);
  const a = mapPoint(bounds.minX, bounds.topY, rect, true);
  const b = mapPoint(bounds.maxX, bounds.bottomY, rect, true);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

/** Overrides the zone and silhouette colors while a blast is strobing or calling the player back. */
interface ZoneTint {
  color: string;
  glow: string;
  fillAlpha: number;
}

function drawZone(
  ctx: CanvasRenderingContext2D,
  baseline: CalibrationBaseline,
  rect: FrameRect,
  inZone: boolean,
  locked: boolean,
  nowMs: number,
  tint: ZoneTint | null,
): void {
  const { x, y, w, h } = zoneRect(baseline, rect);
  if (tint) {
    ctx.save();
    ctx.fillStyle = tint.color;
    ctx.globalAlpha = tint.fillAlpha * 0.35;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = tint.color;
    ctx.lineWidth = Math.max(3, rect.w * 0.007);
    ctx.shadowColor = tint.glow;
    ctx.shadowBlur = 28;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    return;
  }
  const pulse = inZone ? 1 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(nowMs / 180));
  ctx.save();
  ctx.strokeStyle = inZone ? `rgba(141, 255, 193, ${0.9})` : `rgba(245, 193, 108, ${0.35 + 0.65 * pulse})`;
  ctx.lineWidth = Math.max(2, rect.w * 0.004);
  ctx.setLineDash(inZone && locked ? [] : [10, 8]);
  ctx.shadowColor = inZone ? GREEN : GOLD;
  ctx.shadowBlur = inZone ? 18 : 10 + 16 * pulse;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/** `#rrggbb` to `rgba(...)`. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function drawReturnSnap(ctx: CanvasRenderingContext2D, rect: FrameRect, startedAt: number, nowMs: number): void {
  const life = (nowMs - startedAt) / 700;
  if (life < 0 || life > 1) return;
  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.42;
  ctx.save();
  ctx.strokeStyle = `rgba(210, 255, 230, ${1 - life})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, rect.h * (0.12 + life * 0.28), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function canvasFont(rect: FrameRect, scale: number, weight = 700): string {
  return `${weight} ${Math.max(12, rect.w * scale)}px ui-sans-serif, system-ui, sans-serif`;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  font: string,
): void {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Expanding shockwave rings and spokes, green for a dodge and red for a hit. */
function drawBurst(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  baseRadius: number,
  dodged: boolean,
  life: number,
): void {
  const color = dodged ? EMERALD : CRIMSON;
  const fade = 1 - life;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 24;
  for (let ring = 0; ring < 3; ring += 1) {
    const grow = Math.max(0, life - ring * 0.12);
    ctx.lineWidth = Math.max(1, 6 * (1 - grow));
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * (1 + grow * (2.2 + ring * 0.6)), 0, Math.PI * 2);
    ctx.stroke();
  }
  const spokes = 14;
  ctx.lineWidth = 3;
  for (let i = 0; i < spokes; i += 1) {
    const angle = (i / spokes) * Math.PI * 2 + (dodged ? 0 : 0.2);
    const inner = baseRadius * (1 + life * 1.2);
    const outer = baseRadius * (1.4 + life * 2.6);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.stroke();
  }
  if (!dodged && life < 0.35) {
    ctx.globalAlpha = (0.35 - life) * 1.6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Osu!-style ring: a bullseye frozen on the body part and an approach ring closing in on it. */
function drawPartRing(ctx: CanvasRenderingContext2D, rect: FrameRect, overlay: CombatOverlay, nowMs: number): void {
  const target = overlay.target;
  if (!target) return;
  const [cx, cy] = mapPoint(target.x, target.y, rect, true);
  const radius = Math.max(8, target.radius * rect.h);
  const tag = BODY_PART_TAG[target.part];
  const labelFont = canvasFont(rect, 0.022);

  if (overlay.impact) {
    const life = (nowMs - overlay.impact.at) / IMPACT_BURST_MS;
    if (life < 0 || life > 1) return;
    drawBurst(ctx, cx, cy, radius, overlay.impact.dodged, life);
    const pop = 1 + 0.35 * Math.sin(Math.min(1, life * 3) * Math.PI);
    drawLabel(
      ctx,
      overlay.impact.dodged ? 'DODGED!' : 'HIT!',
      cx,
      cy - radius * 1.6 - life * 20,
      overlay.impact.dodged ? EMERALD : CRIMSON,
      canvasFont(rect, 0.04 * pop, 900),
    );
    return;
  }

  const progress = clampProgress(nowMs, overlay);
  const danger = !overlay.clear;
  const throb = 0.5 + 0.5 * Math.sin(nowMs / (danger ? 70 : 160));
  const core = danger ? (throb > 0.5 ? CRIMSON : EMBER) : EMERALD;

  ctx.save();
  const glow = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
  glow.addColorStop(0, danger ? 'rgba(255, 60, 60, 0.45)' : 'rgba(52, 245, 160, 0.35)');
  glow.addColorStop(1, danger ? 'rgba(255, 138, 61, 0.12)' : 'rgba(52, 245, 160, 0.06)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = core;
  ctx.shadowColor = core;
  ctx.shadowBlur = 18 + 10 * throb;
  ctx.lineWidth = Math.max(3, radius * 0.08);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = Math.max(1.5, radius * 0.03);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  const tick = radius * 0.25;
  ctx.beginPath();
  ctx.moveTo(cx - radius - tick, cy);
  ctx.lineTo(cx - radius * 0.7, cy);
  ctx.moveTo(cx + radius * 0.7, cy);
  ctx.lineTo(cx + radius + tick, cy);
  ctx.moveTo(cx, cy - radius - tick);
  ctx.lineTo(cx, cy - radius * 0.7);
  ctx.moveTo(cx, cy + radius * 0.7);
  ctx.lineTo(cx, cy + radius + tick);
  ctx.stroke();

  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(3, radius * (0.1 + 0.04 * throb)), 0, Math.PI * 2);
  ctx.fill();

  const scale = approachRingScale(progress);
  ctx.globalAlpha = 0.45 + 0.55 * progress;
  ctx.strokeStyle = danger ? '#ffd1d1' : '#d4ffe9';
  ctx.shadowColor = core;
  ctx.shadowBlur = 16;
  ctx.lineWidth = Math.max(2, radius * (0.05 + 0.07 * progress));
  ctx.beginPath();
  ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const remaining = Math.max(0, (overlay.judgeAt - nowMs) / 1000);
  drawLabel(ctx, `🎯 ${tag}`, cx, cy - radius * 1.35, core, labelFont);
  drawLabel(ctx, danger ? 'MOVE!' : 'CLEAR!', cx, cy + radius * 1.35, core, labelFont);
  drawLabel(ctx, remaining.toFixed(1), cx, cy, '#ffffff', canvasFont(rect, 0.016));
}

/** Silhouette tint for a blast: accelerating red/green strobe, then a gold/green call-back pulse. */
function blastTint(overlay: CombatOverlay, nowMs: number): ZoneTint | null {
  if (overlay.kind !== 'zone_blast') return null;
  if (overlay.impact) {
    const age = nowMs - overlay.impact.at;
    if (age < IMPACT_BURST_MS * 0.4) {
      return overlay.impact.dodged
        ? { color: GOLD, glow: GOLD, fillAlpha: 0.9 }
        : { color: CRIMSON, glow: CRIMSON, fillAlpha: 1 };
    }
    const callBack = Math.sin(age / 160) > 0;
    return callBack ? { color: GOLD, glow: GOLD, fillAlpha: 0.45 } : { color: EMERALD, glow: GREEN, fillAlpha: 0.45 };
  }
  const progress = clampProgress(nowMs, overlay);
  const durationMs = overlay.judgeAt - overlay.startAt;
  const red = strobeIsRed(progress, durationMs);
  const strength = 0.45 + 0.55 * progress;
  return red
    ? { color: CRIMSON, glow: CRIMSON, fillAlpha: strength }
    : { color: EMERALD, glow: EMERALD, fillAlpha: strength * 0.8 };
}

function drawBlastOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rect: FrameRect,
  baseline: CalibrationBaseline,
  overlay: CombatOverlay,
  nowMs: number,
): void {
  const zone = zoneRect(baseline, rect);
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;
  const font = canvasFont(rect, 0.03, 900);

  if (overlay.impact) {
    const age = nowMs - overlay.impact.at;
    const life = age / IMPACT_BURST_MS;
    if (life <= 1) {
      drawBurst(ctx, cx, cy, Math.max(zone.w, zone.h) * 0.45, overlay.impact.dodged, life);
      drawLabel(
        ctx,
        overlay.impact.dodged ? 'DODGED!' : 'HIT!',
        cx,
        zone.y - rect.h * 0.05,
        overlay.impact.dodged ? EMERALD : CRIMSON,
        canvasFont(rect, 0.045, 900),
      );
    } else {
      drawLabel(ctx, 'BACK IN THE ZONE', cx, zone.y - rect.h * 0.05, GOLD, font);
    }
    return;
  }

  const progress = clampProgress(nowMs, overlay);
  const red = strobeIsRed(progress, overlay.judgeAt - overlay.startAt);
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.35,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.75,
  );
  vignette.addColorStop(0, 'rgba(255, 45, 85, 0)');
  vignette.addColorStop(1, `rgba(255, 45, 85, ${(red ? 0.15 : 0.05) + 0.35 * progress * progress})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  const remaining = Math.max(0, (overlay.judgeAt - nowMs) / 1000);
  drawLabel(
    ctx,
    overlay.clear ? `CLEAR! STAY OUT ${remaining.toFixed(1)}` : `⚡ GET OUT! ${remaining.toFixed(1)}`,
    cx,
    zone.y - rect.h * 0.05,
    overlay.clear ? EMERALD : red ? CRIMSON : EMERALD,
    font,
  );
}

function paint(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: VisionCanvasModel,
  video: HTMLVideoElement | null,
  nowMs: number,
  snapStartedAt: number,
): void {
  const rect = contentRect(video, width, height, model.source);
  const showVideo = model.source === 'webcam' && video !== null && video.readyState >= 2 && video.videoWidth > 0;
  if (showVideo && video) drawVideo(ctx, video, rect);
  else drawForest(ctx, width, height, nowMs);

  const combat = model.combat ?? null;
  const tint = combat ? blastTint(combat, nowMs) : null;

  if (model.baseline) {
    drawZone(ctx, model.baseline, rect, model.inZone, model.calibrated, nowMs, tint);
    const outline = silhouetteFromMetrics({
      centerX: model.baseline.centerX,
      shoulderHalf: Math.max(0.02, model.baseline.shoulderWidth / 2),
      hipHalf: Math.max(0.02, model.baseline.shoulderWidth * 0.42),
      shoulderY: model.baseline.shoulderY,
      hipY: model.baseline.hipY,
      noseY: model.baseline.shoulderY - Math.max(0.08, Math.abs(model.baseline.hipY - model.baseline.shoulderY) * 0.55),
    });
    const pulse = model.inZone ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(nowMs / 180));
    const fillAlpha = 0.05 + model.overlapScore * (model.inZone ? 0.55 : 0.28);
    const silhouetteStyle: PaintStyle = tint
      ? {
          stroke: tint.color,
          fill: withAlpha(tint.color, 0.12 + 0.4 * tint.fillAlpha),
          glow: tint.glow,
          lineWidth: Math.max(4, rect.w * 0.009),
          fillBody: true,
        }
      : {
          stroke: model.inZone ? `rgba(141, 255, 193, ${0.75 + 0.25 * pulse})` : `rgba(245, 193, 108, ${0.35 + 0.5 * pulse})`,
          fill: model.inZone ? `rgba(141, 255, 193, ${fillAlpha})` : `rgba(245, 193, 108, ${fillAlpha})`,
          glow: model.inZone ? GREEN : GOLD,
          lineWidth: Math.max(2.5, rect.w * 0.006),
          fillBody: true,
        };
    drawSkeleton(ctx, outline, rect, true, silhouetteStyle, null);
    drawReturnSnap(ctx, rect, snapStartedAt, nowMs);
    if (combat?.kind === 'zone_blast') drawBlastOverlay(ctx, width, height, rect, model.baseline, combat, nowMs);
  }

  if (model.landmarks && model.landmarks.length > 0) {
    drawSkeleton(ctx, model.landmarks, rect, true, {
      stroke: BONE,
      fill: 'rgba(231, 255, 244, 0.9)',
      glow: '#9dffe0',
      lineWidth: Math.max(2, rect.w * 0.0035),
      fillBody: false,
    }, null);
  }

  if (combat?.kind === 'part_ring') drawPartRing(ctx, rect, combat, nowMs);

  model.teammatePoses.forEach((pose, index) => {
    if (pose.landmarks.length === 0) return;
    const slot = {
      x: rect.x + rect.w * (index % 2 === 0 ? 0.17 : 0.83),
      y: rect.y + rect.h * 0.5,
      scale: 0.4,
    };
    const home = pose.inZone;
    drawSkeleton(ctx, pose.landmarks, rect, true, {
      stroke: home ? 'rgba(141, 255, 193, 0.85)' : 'rgba(245, 193, 108, 0.8)',
      fill: home ? 'rgba(141, 255, 193, 0.18)' : 'rgba(245, 193, 108, 0.14)',
      glow: home ? GREEN : GOLD,
      lineWidth: Math.max(1.5, rect.w * 0.0025),
      fillBody: true,
    }, slot);
    ctx.save();
    ctx.fillStyle = home ? GREEN : GOLD;
    ctx.font = `${Math.max(12, rect.w * 0.018)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(pose.playerId, slot.x, slot.y - rect.h * 0.28);
    ctx.restore();
  });
}

export interface VisionCanvasProps {
  model: VisionCanvasModel;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export function VisionCanvas({ model, videoRef }: VisionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [fps, setFps] = useState(0);
  const snapStartedAt = useRef(0);
  const prevInZone = useRef<boolean | null>(null);
  const lastChimeAt = useRef(0);
  const strobeHalf = useRef(-1);
  const impactHeardAt = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const resize = (): void => {
      const bounds = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    let frames = 0;
    let fpsStamp = performance.now();

    const loop = (nowMs: number): void => {
      const current = modelRef.current;
      const tracked = current.baseline !== null && current.landmarks !== null && current.landmarks.length > 0;
      const entered = tracked && prevInZone.current === false && current.inZone;
      if (entered && nowMs - lastChimeAt.current > 700) {
        snapStartedAt.current = nowMs;
        lastChimeAt.current = nowMs;
        playSilhouetteChime();
      }
      if (tracked) prevInZone.current = current.inZone;

      const combat = current.combat ?? null;
      if (combat?.kind === 'zone_blast' && !combat.impact) {
        const progress = clampProgress(nowMs, combat);
        const half = Math.floor(strobeCycles(progress, combat.judgeAt - combat.startAt) * 2);
        if (half !== strobeHalf.current) {
          strobeHalf.current = half;
          if (half % 2 === 0) playStrobeTick(progress);
        }
      } else {
        strobeHalf.current = -1;
      }
      if (combat?.impact && impactHeardAt.current !== combat.impact.at) {
        impactHeardAt.current = combat.impact.at;
        playImpact(combat.impact.dodged);
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paint(ctx, canvas.width, canvas.height, current, videoRef.current, nowMs, snapStartedAt.current);

      frames += 1;
      if (nowMs - fpsStamp >= 500) {
        setFps(Math.round((frames * 1000) / (nowMs - fpsStamp)));
        frames = 0;
        fpsStamp = nowMs;
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [videoRef]);

  const seconds = Math.min(3, Math.max(0, model.calibrationMs / 1000));
  const zoneLabel = model.baseline ? (model.inZone ? 'IN ZONE' : 'OUT OF ZONE') : 'NO ZONE';
  const streamLit = model.streamPulse % 2 === 0;

  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded-3xl border border-amber-100/15 bg-[#07110d] shadow-[0_20px_80px_rgba(0,0,0,0.35)]"
      onPointerDown={primeSilhouetteAudio}
      data-testid="vision-canvas"
    >
      <video
        ref={videoRef}
        className="pointer-events-none absolute h-px w-px opacity-0"
        playsInline
        muted
        autoPlay
      />
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap gap-2 p-3">
        <StatusPill testId="calibration-progress" tone="gold">
          CAL {seconds.toFixed(1)} / 3.0s
        </StatusPill>
        <StatusPill testId="zone-badge" tone={model.inZone ? 'green' : 'gold'}>
          {zoneLabel}
        </StatusPill>
        <StatusPill testId="action-badge" tone={model.activeAction === 'none' ? 'muted' : 'green'}>
          {actionBadgeLabel(model.activeAction)}
          {model.actionNote ? ` ${model.actionNote}` : ''}
        </StatusPill>
        <StatusPill testId="fps-badge" tone="muted">
          {fps} FPS
        </StatusPill>
        <StatusPill testId="stream-badge" tone="gold">
          <span className={streamLit ? 'text-amber-200' : 'text-amber-200/30'}>●</span> NET {model.streamHz} Hz
        </StatusPill>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3 text-xs text-amber-50/80">
        <div className="max-w-[70%]">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span>{model.calibrated ? 'Silhouette locked' : 'Preview silhouette'}</span>
            <span>{Math.round(model.overlapScore * 100)}% aligned</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
            <div
              className={model.inZone ? 'h-full bg-emerald-300' : 'h-full bg-amber-300'}
              style={{ width: `${Math.round(model.overlapScore * 100)}%` }}
            />
          </div>
          {model.armCounting ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40">
              <div
                className="h-full bg-amber-200"
                style={{ width: `${Math.min(100, (model.armHoldMs / 1000) * 100)}%` }}
              />
            </div>
          ) : null}
        </div>
        <div className="rounded-full bg-black/35 px-3 py-1">
          {model.source === 'webcam' ? 'Live webcam' : 'Synthetic puppet'} · conf {model.confidence.toFixed(2)}
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  children,
  testId,
  tone,
}: {
  children: ReactNode;
  testId: string;
  tone: 'gold' | 'green' | 'muted';
}) {
  const toneClass =
    tone === 'green'
      ? 'border-emerald-200/40 bg-emerald-300/15 text-emerald-100'
      : tone === 'gold'
        ? 'border-amber-200/40 bg-amber-300/15 text-amber-100'
        : 'border-white/15 bg-black/30 text-amber-50/80';
  return (
    <span
      data-testid={testId}
      className={`rounded-full border px-3 py-1 text-[11px] font-medium tracking-[0.14em] ${toneClass}`}
    >
      {children}
    </span>
  );
}
