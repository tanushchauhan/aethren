import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Connect } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const synthesize = vi.fn();

vi.mock('../ttsEngines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ttsEngines')>();
  return { ...actual, synthesize: (...args: unknown[]) => synthesize(...args), warmKokoro: vi.fn(() => Promise.resolve()) };
});

const { debugTtsPlugin } = await import('../../vite.config');
const { EngineUnavailableError, escapeXml, splitForGoogle } = await import('../ttsEngines');

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function middleware(): Connect.NextHandleFunction {
  let handler: Connect.NextHandleFunction | null = null;
  const plugin = debugTtsPlugin();
  const hook = plugin.configureServer as (server: unknown) => void;
  hook({ middlewares: { use: (fn: Connect.NextHandleFunction) => (handler = fn) } });
  return handler!;
}

function call(
  handler: Connect.NextHandleFunction,
  method: string,
  url: string,
  body?: unknown,
): Promise<FakeResponse | 'next'> {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    req.method = method;
    req.url = url;
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: (name: string, value: string | number) => {
        headers[name.toLowerCase()] = String(value);
      },
      end: (chunk?: Buffer | string) => {
        resolve({ status: res.statusCode, headers, body: Buffer.from(chunk ?? '') });
      },
    };
    handler(req, res as unknown as ServerResponse, () => resolve('next'));
  });
}

function json(response: FakeResponse | 'next'): Record<string, unknown> {
  if (response === 'next') throw new Error('request fell through');
  return JSON.parse(response.body.toString()) as Record<string, unknown>;
}

beforeEach(() => {
  synthesize.mockReset();
});

describe('debug TTS middleware', () => {
  it('ignores routes it does not own', async () => {
    expect(await call(middleware(), 'GET', '/src/main.tsx')).toBe('next');
    expect(await call(middleware(), 'GET', '/api/debug-ttsx')).toBe('next');
  });

  it('rejects missing text and voices outside the catalog without synthesizing', async () => {
    const handler = middleware();
    const empty = await call(handler, 'POST', '/api/debug-tts', { engine: 'edge-neural', voice: 'en-GB-RyanNeural' });
    expect(empty).toMatchObject({ status: 400 });
    const unknown = await call(handler, 'POST', '/api/debug-tts', { text: 'hi', engine: 'macos-say', voice: 'Fred' });
    expect(unknown).toMatchObject({ status: 400 });
    expect(json(unknown).error).toBe('Unknown engine or voice');
    const long = await call(handler, 'POST', '/api/debug-tts', { text: 'x'.repeat(601), engine: 'macos-say', voice: 'Daniel' });
    expect(long).toMatchObject({ status: 413 });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('returns audio with engine, cache, and latency headers, then serves the repeat from cache', async () => {
    synthesize.mockResolvedValue({ audio: Buffer.from('RIFFdata'), contentType: 'audio/wav' });
    const handler = middleware();
    const first = await call(handler, 'GET', '/api/debug-tts?engine=kokoro-local&voice=bm_fable&text=Once%20upon%20a%20time');
    if (first === 'next') throw new Error('fell through');
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('audio/wav');
    expect(first.headers['x-tts-engine']).toBe('kokoro-local');
    expect(first.headers['x-tts-cached']).toBe('miss');
    expect(Number(first.headers['x-tts-latency-ms'])).toBeGreaterThanOrEqual(0);
    expect(first.body.toString()).toBe('RIFFdata');

    const second = await call(handler, 'POST', '/api/debug-tts', { text: 'Once upon a time', engine: 'kokoro-local', voice: 'bm_fable' });
    expect(second).toMatchObject({ status: 200, headers: { 'x-tts-cached': 'hit' } });
    expect(synthesize).toHaveBeenCalledTimes(1);

    await call(handler, 'POST', '/api/debug-tts', { text: 'Once upon a time', engine: 'kokoro-local', voice: 'bm_fable', nocache: true });
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('answers /api/tts with the Royal Bard when the game sends only text', async () => {
    synthesize.mockResolvedValue({ audio: Buffer.from('mp3'), contentType: 'audio/mpeg' });
    const response = await call(middleware(), 'POST', '/api/tts', { text: 'Step out of your silhouette now!' });
    expect(response).toMatchObject({ status: 200, headers: { 'x-tts-engine': 'edge-neural', 'x-tts-voice': 'en-GB-RyanNeural' } });
  });

  it('tells the game to use browser speech for the browser engine', async () => {
    const response = await call(middleware(), 'POST', '/api/tts', { text: 'hi', engine: 'browser-web-speech', voice: 'en-GB' });
    expect(json(response)).toMatchObject({ useBrowserTts: true });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('reports an upstream refusal as JSON so the card can show it', async () => {
    synthesize.mockRejectedValue(new EngineUnavailableError('Upstream answered 401', 502));
    const response = await call(middleware(), 'POST', '/api/debug-tts', { text: 'hi', engine: 'streamelements-polly', voice: 'Brian' });
    expect(response).toMatchObject({ status: 502 });
    expect(json(response)).toMatchObject({ error: 'Upstream answered 401', engine: 'streamelements-polly' });
  });

  it('exposes engine status', async () => {
    const response = await call(middleware(), 'GET', '/api/debug-tts/status');
    const status = json(response);
    expect(status).toHaveProperty('kokoro.state');
    expect(status).toHaveProperty('macosSay');
    expect(status).toHaveProperty('cacheSize', 0);
  });
});

describe('engine helpers', () => {
  it('escapes text before it goes into Edge SSML', () => {
    expect(escapeXml(`<voice name="x">Tom & Jerry's</voice>`)).toBe(
      '&lt;voice name=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/voice&gt;',
    );
  });

  it('splits long lines on word boundaries for Google Translate', () => {
    const line = 'Once upon a time, in a wood woven from your midnight group chat, the Rusted Corolla stirred beneath the roots.';
    const parts = splitForGoogle(line, 40);
    expect(parts.every((part) => part.length <= 40)).toBe(true);
    expect(parts.join(' ')).toBe(line);
    expect(splitForGoogle('short')).toEqual(['short']);
  });
});
