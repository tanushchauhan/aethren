import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CalibrationBaseline, NormalizedLandmark, PoseActionType, PoseFrame } from '@once-upon/shared';
import { actionBadgeLabel, getZoneBounds } from './poseClassifiers';
import { silhouetteFromMetrics } from './syntheticPoseGenerator';
import type { VisionSourceMode } from './poseLandmarkerService';

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

function drawZone(
  ctx: CanvasRenderingContext2D,
  baseline: CalibrationBaseline,
  rect: FrameRect,
  inZone: boolean,
  locked: boolean,
  nowMs: number,
): void {
  const bounds = getZoneBounds(baseline);
  const a = mapPoint(bounds.minX, bounds.topY, rect, true);
  const b = mapPoint(bounds.maxX, bounds.bottomY, rect, true);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
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

  if (model.baseline) {
    drawZone(ctx, model.baseline, rect, model.inZone, model.calibrated, nowMs);
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
    drawSkeleton(ctx, outline, rect, true, {
      stroke: model.inZone ? `rgba(141, 255, 193, ${0.75 + 0.25 * pulse})` : `rgba(245, 193, 108, ${0.35 + 0.5 * pulse})`,
      fill: model.inZone ? `rgba(141, 255, 193, ${fillAlpha})` : `rgba(245, 193, 108, ${fillAlpha})`,
      glow: model.inZone ? GREEN : GOLD,
      lineWidth: Math.max(2.5, rect.w * 0.006),
      fillBody: true,
    }, null);
    drawReturnSnap(ctx, rect, snapStartedAt, nowMs);
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
