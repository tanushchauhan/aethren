import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark as MpLandmark } from '@mediapipe/tasks-vision';
import { POSE_LANDMARK } from '@aethren/shared';
import type { NormalizedLandmark } from '@aethren/shared';
import { SyntheticPuppet, type SyntheticPosePreset, type SyntheticSampleOptions } from './syntheticPoseGenerator';

/** WASM assets that match the installed `@mediapipe/tasks-vision` package. */
export const VISION_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

/** Lite pose model. One person, fast enough for a 30 fps combat loop. */
export const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export type VisionSourceMode = 'webcam' | 'synthetic';

export interface PoseServiceStatus {
  mode: VisionSourceMode;
  requested: VisionSourceMode;
  landmarkerReady: boolean;
  /** Set when webcam or WASM/WebGL could not start and the puppet took over. */
  fallbackReason: string | null;
}

export interface PoseLandmarkerServiceOptions {
  wasmBase?: string;
  modelAssetPath?: string;
  numPoses?: number;
  /** Ignore a detection this small. A bystander far behind the player reads as a tiny torso. */
  minShoulderWidth?: number;
}

const DEFAULT_MIN_SHOULDER_WIDTH = 0.045;

export function isWebcamApiAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function isWebGlAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return gl !== null;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function toSharedLandmark(landmark: MpLandmark): NormalizedLandmark {
  return {
    x: landmark.x,
    y: landmark.y,
    z: landmark.z,
    visibility: landmark.visibility,
  };
}

function shoulderWidth(landmarks: readonly NormalizedLandmark[]): number {
  const left = landmarks[POSE_LANDMARK.leftShoulder];
  const right = landmarks[POSE_LANDMARK.rightShoulder];
  if (!left || !right) return 0;
  return Math.abs(left.x - right.x);
}

/**
 * MediaPipe Pose Landmarker in VIDEO mode, `numPoses: 1`.
 * If the webcam, WebGL, or WASM runtime is missing, {@link sample} keeps producing
 * puppet landmarks so the combat classifiers still run.
 */
export class PoseLandmarkerService {
  private readonly wasmBase: string;
  private readonly modelAssetPath: string;
  private readonly numPoses: number;
  private readonly minShoulderWidth: number;
  private readonly puppet = new SyntheticPuppet();

  private landmarker: PoseLandmarker | null = null;
  private gpuCanvas: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private mode: VisionSourceMode = 'synthetic';
  private requested: VisionSourceMode = 'synthetic';
  private fallbackReason: string | null = null;
  private lastTimestampMs = Number.NEGATIVE_INFINITY;
  private lastLandmarks: NormalizedLandmark[] | null = null;
  private lastVideoTime = -1;
  private session = 0;

  constructor(options: PoseLandmarkerServiceOptions = {}) {
    this.wasmBase = options.wasmBase ?? VISION_WASM_BASE;
    this.modelAssetPath = options.modelAssetPath ?? POSE_MODEL_URL;
    this.numPoses = options.numPoses ?? 1;
    this.minShoulderWidth = options.minShoulderWidth ?? DEFAULT_MIN_SHOULDER_WIDTH;
  }

  getStatus(): PoseServiceStatus {
    return {
      mode: this.mode,
      requested: this.requested,
      landmarkerReady: this.landmarker !== null,
      fallbackReason: this.fallbackReason,
    };
  }

  getPreset(): SyntheticPosePreset {
    return this.puppet.preset;
  }

  setPreset(preset: SyntheticPosePreset, nowMs: number, immediate = false): void {
    this.puppet.setPreset(preset, nowMs, immediate);
  }

  /**
   * Start the requested source. A webcam or landmarker failure resolves to `'synthetic'`
   * instead of throwing, so a cloud VM can still drive the vision page.
   */
  async start(video: HTMLVideoElement, prefer: VisionSourceMode = 'webcam'): Promise<VisionSourceMode> {
    this.stop();
    const session = this.session;
    this.video = video;
    this.requested = prefer;
    return this.startInner(video, prefer, session);
  }

  stop(): void {
    this.session += 1;
    this.releaseStream();
    this.releaseLandmarker();
    this.lastLandmarks = null;
    this.lastTimestampMs = Number.NEGATIVE_INFINITY;
    this.lastVideoTime = -1;
    if (this.mode === 'webcam') this.mode = 'synthetic';
  }

  /**
   * One body at `timestampMs`. Synthetic mode always returns 33 landmarks.
   * Webcam mode returns null until a person large enough to be the player is in frame.
   */
  sample(timestampMs: number, options: SyntheticSampleOptions = {}): NormalizedLandmark[] | null {
    if (this.mode === 'synthetic') {
      return this.puppet.sample(timestampMs, { breathe: true, ...options });
    }
    return this.sampleWebcam(timestampMs);
  }

  private async startInner(
    video: HTMLVideoElement,
    prefer: VisionSourceMode,
    session: number,
  ): Promise<VisionSourceMode> {
    if (session !== this.session) return this.mode;

    if (prefer === 'synthetic') {
      this.mode = 'synthetic';
      this.fallbackReason = null;
      return 'synthetic';
    }

    if (!isWebcamApiAvailable()) {
      return this.useSyntheticFallback('This browser has no webcam API, so the puppet is standing in.');
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (session !== this.session) {
        for (const track of stream.getTracks()) track.stop();
        return this.mode;
      }
      this.stream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      if (session !== this.session) {
        this.releaseStream();
        return this.mode;
      }
      await this.ensureLandmarker();
      if (session !== this.session) {
        this.releaseStream();
        this.releaseLandmarker();
        return this.mode;
      }
      this.mode = 'webcam';
      this.fallbackReason = null;
      return 'webcam';
    } catch (error: unknown) {
      if (session !== this.session) return this.mode;
      this.releaseStream();
      this.releaseLandmarker();
      return this.useSyntheticFallback(
        errorMessage(error, 'Webcam or Pose Landmarker failed, so the puppet is standing in.'),
      );
    }
  }

  private useSyntheticFallback(reason: string): VisionSourceMode {
    this.mode = 'synthetic';
    this.fallbackReason = reason;
    return 'synthetic';
  }

  private async ensureLandmarker(): Promise<void> {
    if (this.landmarker) return;
    const gpuReady = isWebGlAvailable();
    if (gpuReady) {
      try {
        this.landmarker = await this.createLandmarker('GPU');
        return;
      } catch {
        this.releaseLandmarker();
      }
    }
    this.landmarker = await this.createLandmarker('CPU');
  }

  private async createLandmarker(delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(this.wasmBase);
    const gpuCanvas = delegate === 'GPU' ? this.ensureGpuCanvas() : null;
    return PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: this.modelAssetPath,
        delegate,
      },
      runningMode: 'VIDEO',
      numPoses: this.numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      ...(gpuCanvas ? { canvas: gpuCanvas } : {}),
    });
  }

  private ensureGpuCanvas(): HTMLCanvasElement {
    if (this.gpuCanvas) return this.gpuCanvas;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    this.gpuCanvas = canvas;
    return canvas;
  }

  private sampleWebcam(timestampMs: number): NormalizedLandmark[] | null {
    const video = this.video;
    const landmarker = this.landmarker;
    if (!video || !landmarker || video.readyState < 2) return this.lastLandmarks;
    if (video.currentTime === this.lastVideoTime) return this.lastLandmarks;
    if (timestampMs <= this.lastTimestampMs) return this.lastLandmarks;

    this.lastVideoTime = video.currentTime;
    this.lastTimestampMs = timestampMs;

    let detected: NormalizedLandmark[] | null = null;
    try {
      const result = landmarker.detectForVideo(video, timestampMs);
      const pose = result.landmarks[0];
      if (pose && pose.length > 0) {
        const mapped = pose.map(toSharedLandmark);
        if (shoulderWidth(mapped) >= this.minShoulderWidth) detected = mapped;
      }
    } catch (error: unknown) {
      this.fallbackReason = errorMessage(error, 'Pose Landmarker stopped responding.');
      this.mode = 'synthetic';
      this.releaseLandmarker();
      return this.puppet.sample(timestampMs, { breathe: true });
    }

    this.lastLandmarks = detected;
    return detected;
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  private releaseLandmarker(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
