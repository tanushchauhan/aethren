import { create } from 'zustand';
import { POSE_MODEL_URL, VISION_WASM_BASE } from '../vision/poseLandmarkerService';

/**
 * Downloads every art, audio, video and font file (plus the webcam model) before play, so nothing has to stream in
 * mid-fight. The files land in the browser's own cache, so a later visit or a second press is fast.
 *
 * Service workers and the Cache API only exist on https and localhost, so this works through the ordinary HTTP
 * cache instead; the servers mark these files cacheable (see `assetPreloadPlugin` and the story server).
 */
export type PrefetchStatus = 'idle' | 'running' | 'done' | 'error';

interface ManifestFile { path: string; size: number }
interface Manifest { version: string; files: ManifestFile[] }

interface PrefetchState {
  status: PrefetchStatus;
  open: boolean;
  loadedFiles: number;
  totalFiles: number;
  loadedBytes: number;
  totalBytes: number;
  current: string;
  failed: string[];
  /** The webcam model comes from the internet; false when it could not be fetched (offline). */
  webcamModel: boolean | null;
  /** True when everything for the current build is already downloaded. */
  ready: boolean;
  start: () => Promise<void>;
  cancel: () => void;
  close: () => void;
  checkReady: () => Promise<void>;
}

const STORAGE_KEY = 'memory.preloaded';
const CONCURRENCY = 4;
const RETRIES = 2;
const REMOTE_TIMEOUT_MS = 20_000;
const REMOTE_FILES = [
  `${VISION_WASM_BASE}/vision_wasm_internal.js`,
  `${VISION_WASM_BASE}/vision_wasm_internal.wasm`,
  `${VISION_WASM_BASE}/vision_wasm_nosimd_internal.js`,
  `${VISION_WASM_BASE}/vision_wasm_nosimd_internal.wasm`,
  POSE_MODEL_URL,
];

let controller: AbortController | null = null;

function savedVersion(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

async function loadManifest(signal?: AbortSignal): Promise<Manifest> {
  const response = await fetch('/asset-manifest.json', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('The file list is not available');
  return response.json() as Promise<Manifest>;
}

/** Reads the whole body (so the file is fully cached) and reports bytes as they arrive. */
async function download(url: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  const response = await fetch(url, { signal, cache: 'force-cache' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const reader = response.body?.getReader();
  if (!reader) { onBytes((await response.arrayBuffer()).byteLength); return; }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onBytes(value.byteLength);
  }
}

export const usePrefetch = create<PrefetchState>((set, get) => ({
  status: 'idle', open: false, loadedFiles: 0, totalFiles: 0, loadedBytes: 0, totalBytes: 0, current: '', failed: [],
  webcamModel: null, ready: false,

  async checkReady() {
    try {
      const manifest = await loadManifest();
      set({ ready: savedVersion() === manifest.version });
    } catch { set({ ready: false }); }
  },

  async start() {
    if (get().status === 'running') { set({ open: true }); return; }
    controller = new AbortController();
    const { signal } = controller;
    set({ open: true, status: 'running', loadedFiles: 0, totalFiles: 0, loadedBytes: 0, totalBytes: 0, current: 'Reading the file list', failed: [], webcamModel: null });
    let manifest: Manifest;
    try {
      manifest = await loadManifest(signal);
    } catch (error) {
      if (!signal.aborted) set({ status: 'error', current: error instanceof Error ? error.message : 'Could not read the file list', failed: ['file list'] });
      return;
    }
    const queue = [...manifest.files].sort((a, b) => b.size - a.size);
    set({ totalFiles: queue.length, totalBytes: manifest.files.reduce((sum, f) => sum + f.size, 0) });
    const failed: string[] = [];
    const next = async (): Promise<void> => {
      for (let file = queue.shift(); file && !signal.aborted; file = queue.shift()) {
        set({ current: file.path.slice(1) });
        let counted = 0;
        let ok = false;
        for (let attempt = 0; attempt <= RETRIES && !ok && !signal.aborted; attempt++) {
          try {
            counted = 0;
            await download(file.path, signal, (n) => { counted += n; set((s) => ({ loadedBytes: s.loadedBytes + n })); });
            ok = true;
          } catch {
            set((s) => ({ loadedBytes: Math.max(0, s.loadedBytes - counted) }));
            if (attempt < RETRIES) await new Promise((r) => window.setTimeout(r, 400 * (attempt + 1)));
          }
        }
        if (signal.aborted) return;
        if (!ok) failed.push(file.path);
        set((s) => ({ loadedFiles: s.loadedFiles + 1, failed: [...failed] }));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, next));
    if (signal.aborted) return;

    // The webcam model is optional: without internet the rest still works.
    set({ current: 'Webcam model' });
    const remoteSignal = AbortSignal.any([signal, AbortSignal.timeout(REMOTE_TIMEOUT_MS)]);
    const remote = await Promise.all(REMOTE_FILES.map((url) => download(url, remoteSignal, () => {}).then(() => true, () => false)));
    if (signal.aborted) return;
    const webcamModel = remote.every(Boolean);
    if (failed.length === 0) {
      try { window.localStorage.setItem(STORAGE_KEY, manifest.version); } catch { /* it just will not be remembered */ }
    }
    set({ status: failed.length === 0 ? 'done' : 'error', webcamModel, ready: failed.length === 0, current: '' });
  },

  cancel() {
    controller?.abort();
    controller = null;
    set({ status: 'idle', open: false });
  },

  close() {
    if (get().status === 'running') return;
    set({ open: false });
  },
}));
