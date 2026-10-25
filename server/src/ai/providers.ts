/**
 * Every external HTTP endpoint the AI module calls, one small function each.
 *
 * The Meta Model API shapes here come from search results and are UNVERIFIED. If
 * `src/ai/live-check.ts` shows one is wrong, fix it in the single function below.
 * Each function throws {@link ProviderError} on failure and uses the global `fetch`
 * at call time, so tests can stub it with `vi.stubGlobal('fetch', ...)`.
 */

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    /** HTTP status, or 0 for a timeout / network error. */
    readonly status: number,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

async function request(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: combined });
  } catch (err) {
    const reason = timeout.aborted ? `timeout after ${timeoutMs}ms` : err instanceof Error ? err.message : 'network error';
    throw new ProviderError(provider, 0, reason);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
    } catch {
      // ignore
    }
    throw new ProviderError(provider, res.status, `HTTP ${res.status} ${detail}`.trim());
  }
  return res;
}

function audioBlob(audio: Buffer, mimeType: string): Blob {
  return new Blob([new Uint8Array(audio)], { type: mimeType || 'application/octet-stream' });
}

/** Pulls the transcript out of whatever JSON (or plain text) a speech-to-text API returned. */
export function parseTranscript(body: unknown): string | null {
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const key of ['text', 'transcript', 'transcription']) {
    if (typeof b[key] === 'string') return (b[key] as string).trim();
  }
  const results = b.results ?? b.segments ?? b.alternatives;
  if (Array.isArray(results) && results.length > 0) {
    const parts = results
      .map((r) => (typeof r === 'string' ? r.trim() : r && typeof r === 'object' ? parseTranscript(r) : null))
      .filter((t): t is string => typeof t === 'string');
    if (parts.length > 0) return parts.join(' ').trim();
  }
  if (b.data && typeof b.data === 'object') return parseTranscript(b.data);
  if (b.result && typeof b.result === 'object') return parseTranscript(b.result);
  return null;
}

async function readTranscript(provider: string, res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  let parsed: unknown = raw;
  if (type.includes('json') || raw.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  const text = parseTranscript(parsed);
  if (text === null) throw new ProviderError(provider, res.status, 'no transcript field in response');
  return text;
}

export interface TranscribeCall {
  baseUrl: string;
  apiKey: string;
  model: string;
  audio: Buffer;
  filename: string;
  mimeType: string;
  timeoutMs: number;
}

/**
 * Muse Voice Transcribe, native endpoint (assumed):
 * `POST {base}/asr/transcribe`, multipart `file` (WAV, 16-bit PCM mono, 16/24 kHz) + `model`.
 */
export async function museAsrTranscribe(c: TranscribeCall): Promise<string> {
  const form = new FormData();
  form.append('file', audioBlob(c.audio, c.mimeType), c.filename);
  form.append('model', c.model);
  const res = await request(
    'muse-asr',
    `${c.baseUrl}/asr/transcribe`,
    { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form },
    c.timeoutMs,
  );
  return readTranscript('muse-asr', res);
}

/**
 * OpenAI-compatible speech-to-text: `POST {base}/audio/transcriptions`, multipart `file` + `model`.
 * Used for the Muse fallback path and for OpenAI itself.
 */
export async function openAiCompatTranscribe(c: TranscribeCall & { provider?: string }): Promise<string> {
  const provider = c.provider ?? 'openai-transcribe';
  const form = new FormData();
  form.append('file', audioBlob(c.audio, c.mimeType), c.filename);
  form.append('model', c.model);
  form.append('response_format', 'json');
  const res = await request(
    provider,
    `${c.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form },
    c.timeoutMs,
  );
  return readTranscript(provider, res);
}

export interface GeneratedImage {
  url?: string;
  b64?: string;
  mimeType?: string;
}

/**
 * Muse Image (assumed OpenAI-shaped): `POST {base}/images/generations`
 * `{model, prompt, n: 1, size: '1024x1024'}` -> `{data: [{url} | {b64_json}]}`.
 * Retries once without `size` if the API rejects the body with a 400.
 */
export async function museImageGenerate(c: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}): Promise<GeneratedImage> {
  const send = (body: Record<string, unknown>) =>
    request(
      'muse-image',
      `${c.baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      c.timeoutMs,
    );
  let res: Response;
  try {
    res = await send({ model: c.model, prompt: c.prompt, n: 1, size: '1024x1024' });
  } catch (err) {
    if (!(err instanceof ProviderError) || err.status !== 400) throw err;
    res = await send({ model: c.model, prompt: c.prompt });
  }
  const body = (await res.json()) as Record<string, unknown>;
  const first = (Array.isArray(body.data) ? body.data[0] : Array.isArray(body.images) ? body.images[0] : body) as
    | Record<string, unknown>
    | undefined;
  const url = first?.url ?? first?.image_url;
  const b64 = first?.b64_json ?? first?.b64 ?? first?.image_base64;
  const mime = first?.mime_type ?? first?.content_type ?? body.output_format;
  if (typeof url === 'string' && url) return { url };
  if (typeof b64 === 'string' && b64) {
    return { b64, mimeType: typeof mime === 'string' ? normalizeImageMime(mime) : undefined };
  }
  throw new ProviderError('muse-image', res.status, 'no url or b64_json in response');
}

function normalizeImageMime(m: string): string {
  if (m.includes('/')) return m;
  return m === 'jpg' ? 'image/jpeg' : `image/${m}`;
}

/**
 * ElevenLabs TTS: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_22050_32`
 * header `xi-api-key`, body `{text, model_id}` -> `audio/mpeg` bytes.
 */
export async function elevenLabsTts(c: {
  baseUrl: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const url = `${c.baseUrl}/text-to-speech/${encodeURIComponent(c.voiceId)}?output_format=mp3_22050_32`;
  const res = await request(
    'elevenlabs',
    url,
    {
      method: 'POST',
      headers: { 'xi-api-key': c.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: c.text, model_id: c.modelId }),
    },
    c.timeoutMs,
  );
  return readAudio('elevenlabs', res);
}

/**
 * OpenAI-shaped TTS: `POST {base}/audio/speech` `{model, voice, input, response_format: 'mp3'}`.
 * Used for OpenAI, and for Muse TTS when `MUSE_TTS_MODEL` is set (no Muse TTS is documented).
 */
export async function openAiCompatSpeech(c: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  instructions?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const body: Record<string, unknown> = {
    model: c.model,
    voice: c.voice,
    input: c.text,
    response_format: 'mp3',
  };
  if (c.instructions) body.instructions = c.instructions;
  const res = await request(
    c.provider,
    `${c.baseUrl}/audio/speech`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    c.timeoutMs,
  );
  return readAudio(c.provider, res);
}

async function readAudio(provider: string, res: Response): Promise<Buffer> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || type.startsWith('text/')) {
    throw new ProviderError(provider, res.status, `expected audio, got ${type}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new ProviderError(provider, res.status, 'audio response too small');
  return buf;
}
