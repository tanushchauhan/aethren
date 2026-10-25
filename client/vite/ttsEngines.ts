/**
 * Zero-key speech engines for the /debug/audio bench. Runs inside the Vite dev server (Node), never in the browser.
 * Every request is checked against the shared voice catalog before anything is synthesized.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TtsEngineId, VoiceOption } from '../src/audio-lab/voiceCatalog';

export interface SynthResult {
  audio: Buffer;
  contentType: string;
  /** Set when the primary path failed and a fallback produced the clip. */
  via?: string;
}

export class EngineUnavailableError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

export type KokoroState = 'idle' | 'loading' | 'ready' | 'error';

export interface KokoroStatus {
  state: KokoroState;
  progress: number;
  loadMs: number | null;
  error: string | null;
}

export interface EngineStatus {
  kokoro: KokoroStatus;
  macosSay: boolean;
}

const ONLINE_TIMEOUT_MS = 8000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

export function synthesize(option: VoiceOption, text: string): Promise<SynthResult> {
  switch (option.engine) {
    case 'edge-neural':
      return edgeNeural(option, text);
    case 'kokoro-local':
      return kokoroLocal(option, text);
    case 'macos-say':
      return macosSay(option, text);
    case 'google-translate-tts':
      return googleTranslate(option, text);
    case 'streamelements-polly':
      return streamElements(option, text);
    case 'tiktok-tts':
      return tiktok(option, text);
    case 'browser-web-speech':
      return Promise.reject(new EngineUnavailableError('browser-web-speech runs in the browser', 400));
  }
}

export function engineStatus(): EngineStatus {
  return { kokoro: { ...kokoro }, macosSay: macosSayAvailable() };
}

export function isServerEngine(engine: TtsEngineId): boolean {
  return engine !== 'browser-web-speech';
}

// Microsoft Edge Read Aloud neural voices

const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_WSS = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const EDGE_GEC_VERSION = '1-143.0.3650.96';
const EDGE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Sec-MS-GEC: SHA-256 of the Windows file-time (5-minute window) plus the trusted client token. */
function edgeGec(): string {
  let seconds = Math.floor(Date.now() / 1000) + 11644473600;
  seconds -= seconds % 300;
  const ticks = BigInt(seconds) * 10000000n;
  return createHash('sha256').update(`${ticks}${EDGE_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function edgeSsml(option: VoiceOption, text: string): string {
  const locale = option.voice.split('-').slice(0, 2).join('-');
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${option.voice}"><prosody pitch="${option.pitch ?? '+0Hz'}" rate="${option.rate ?? '+0%'}" volume="+0%">` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

async function edgeNeural(option: VoiceOption, text: string): Promise<SynthResult> {
  try {
    return { audio: await edgeViaNativeSocket(option, text), contentType: 'audio/mpeg' };
  } catch (nativeError) {
    try {
      return { audio: await edgeViaPackage(option, text), contentType: 'audio/mpeg', via: 'msedge-tts' };
    } catch {
      throw new EngineUnavailableError(`Edge neural TTS failed: ${errorMessage(nativeError)}`, 502);
    }
  }
}

/**
 * The Edge endpoint currently rejects the `ws` handshake that msedge-tts uses (it answers 200 instead of 101),
 * while Node's built-in WebSocket is accepted. This speaks the same protocol over the built-in client.
 */
function edgeViaNativeSocket(option: VoiceOption, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const connectionId = randomBytes(16).toString('hex');
    const url = `${EDGE_WSS}?Ocp-Apim-Subscription-Key=${EDGE_TOKEN}&Sec-MS-GEC=${edgeGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}&ConnectionId=${connectionId}`;
    const ws = new WebSocket(url, {
      headers: { 'User-Agent': BROWSER_UA, Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
    });
    ws.binaryType = 'arraybuffer';
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* Already closed. */
      }
      if (error) reject(error);
      else if (chunks.length === 0) reject(new Error('Edge returned no audio'));
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error('Edge timed out')), ONLINE_TIMEOUT_MS);

    ws.onopen = () => {
      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: EDGE_FORMAT,
            },
          },
        },
      });
      ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`);
      ws.send(
        `X-RequestId:${randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${edgeSsml(option, text)}`,
      );
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) finish(null);
        return;
      }
      const frame = Buffer.from(event.data as ArrayBuffer);
      if (frame.length < 2) return;
      const headerLength = frame.readUInt16BE(0);
      const header = frame.subarray(2, 2 + headerLength).toString();
      if (header.includes('Path:audio')) chunks.push(frame.subarray(2 + headerLength));
    };
    ws.onerror = () => finish(new Error('Edge WebSocket was refused'));
    ws.onclose = () => finish(chunks.length ? null : new Error('Edge closed before audio'));
  });
}

async function edgeViaPackage(option: VoiceOption, text: string): Promise<Buffer> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS({ connectionTimeoutMs: ONLINE_TIMEOUT_MS, synthesisTimeoutMs: ONLINE_TIMEOUT_MS });
  try {
    await tts.setMetadata(option.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text), { pitch: option.pitch, rate: option.rate });
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) chunks.push(Buffer.from(chunk as Uint8Array));
    if (chunks.length === 0) throw new Error('msedge-tts returned no audio');
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}

// Kokoro-82M through kokoro-js, loaded lazily so the dev server never waits on the model

interface KokoroAudio {
  toWav(): ArrayBuffer;
}

interface KokoroModel {
  generate(text: string, options: { voice: string; speed?: number }): Promise<KokoroAudio>;
}

interface ProgressEvent {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

const kokoro: KokoroStatus = { state: 'idle', progress: 0, loadMs: null, error: null };
let kokoroModel: Promise<KokoroModel> | null = null;
let kokoroQueue: Promise<unknown> = Promise.resolve();

export function warmKokoro(): Promise<KokoroModel> {
  if (kokoroModel) return kokoroModel;
  const started = performance.now();
  const files = new Map<string, { loaded: number; total: number }>();
  kokoro.state = 'loading';
  kokoro.progress = 0;
  kokoro.error = null;
  kokoroModel = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (event: ProgressEvent) => {
        if (event.status !== 'progress' || !event.file || !event.total) return;
        files.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
        let loaded = 0;
        let total = 0;
        for (const file of files.values()) {
          loaded += file.loaded;
          total += file.total;
        }
        kokoro.progress = total ? Math.min(1, loaded / total) : 0;
      },
    });
    kokoro.state = 'ready';
    kokoro.progress = 1;
    kokoro.loadMs = Math.round(performance.now() - started);
    return model as unknown as KokoroModel;
  })();
  kokoroModel.catch((error: unknown) => {
    kokoro.state = 'error';
    kokoro.error = errorMessage(error);
    kokoroModel = null;
  });
  return kokoroModel;
}

async function kokoroLocal(option: VoiceOption, text: string): Promise<SynthResult> {
  let model: KokoroModel;
  try {
    model = await warmKokoro();
  } catch (error) {
    throw new EngineUnavailableError(`Kokoro could not load: ${errorMessage(error)}`);
  }
  // One ONNX session: run generations one at a time.
  const run = kokoroQueue.then(() => model.generate(text, { voice: option.voice }));
  kokoroQueue = run.catch(() => undefined);
  const audio = await run;
  return { audio: Buffer.from(audio.toWav()), contentType: 'audio/wav' };
}

// macOS say + afconvert

const SAY = '/usr/bin/say';
const AFCONVERT = '/usr/bin/afconvert';

function macosSayAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SAY) && existsSync(AFCONVERT);
}

function run(command: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with ${code}`));
    });
    child.stdin.end(stdin ?? '');
  });
}

async function macosSay(option: VoiceOption, text: string): Promise<SynthResult> {
  if (!macosSayAvailable()) throw new EngineUnavailableError('macOS say is only available on a Mac');
  const dir = await mkdtemp(path.join(tmpdir(), 'ouam-say-'));
  try {
    const aiff = path.join(dir, 'line.aiff');
    const wav = path.join(dir, 'line.wav');
    const args = ['-v', option.voice, '-o', aiff];
    if (option.rate) args.push('-r', option.rate);
    // Text goes through stdin so a line starting with "-" is never read as a flag.
    await run(SAY, [...args, '-f', '-'], text);
    await run(AFCONVERT, ['-f', 'WAVE', '-d', 'LEI16@22050', aiff, wav]);
    return { audio: await readFile(wav), contentType: 'audio/wav' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Google Translate TTS (about 200 characters per request, so long lines are split and the MP3s joined)

export function splitForGoogle(text: string, limit = 180): string[] {
  const parts: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = word.length > limit ? word.slice(0, limit) : word;
    if (current && current.length + 1 + piece.length > limit) {
      parts.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function fetchAudio(url: string, init: RequestInit = {}): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(ONLINE_TIMEOUT_MS) });
  } catch (error) {
    throw new EngineUnavailableError(`Network error: ${errorMessage(error)}`, 502);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
    throw new EngineUnavailableError(`Upstream answered ${response.status}${detail ? `: ${detail}` : ''}`, 502);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function googleTranslate(option: VoiceOption, text: string): Promise<SynthResult> {
  const parts = splitForGoogle(text);
  const clips = await Promise.all(
    parts.map((part, index) =>
      fetchAudio(
        `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(option.voice)}` +
          `&total=${parts.length}&idx=${index}&textlen=${part.length}&q=${encodeURIComponent(part)}`,
        { headers: { 'User-Agent': BROWSER_UA } },
      ),
    ),
  );
  return { audio: Buffer.concat(clips), contentType: 'audio/mpeg' };
}

async function streamElements(option: VoiceOption, text: string): Promise<SynthResult> {
  const audio = await fetchAudio(
    `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(option.voice)}&text=${encodeURIComponent(text)}`,
    { headers: { 'User-Agent': BROWSER_UA } },
  );
  return { audio, contentType: 'audio/mpeg' };
}

async function tiktok(option: VoiceOption, text: string): Promise<SynthResult> {
  const body = await fetchAudio('https://tiktok-tts.weilnet.workers.dev/api/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify({ text: text.slice(0, 300), voice: option.voice }),
  });
  let payload: { success?: boolean; data?: string | null; error?: string | null };
  try {
    payload = JSON.parse(body.toString('utf8')) as typeof payload;
  } catch {
    throw new EngineUnavailableError('TikTok proxy did not return JSON', 502);
  }
  if (!payload.success || !payload.data) {
    throw new EngineUnavailableError(`TikTok proxy refused: ${payload.error ?? 'no audio'}`, 502);
  }
  return { audio: Buffer.from(payload.data, 'base64'), contentType: 'audio/mpeg' };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
