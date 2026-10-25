import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorldImage } from '@once-upon/shared';
import { createImageService } from './images';
import { parseTranscript } from './providers';
import { ELEVENLABS_BOSS_VOICE_ID } from './runtime';
import { CACHED_WORLD } from './service';
import { audioResponse, jsonResponse, requestUrl, testRuntime } from './test-utils';
import { createTranscriber } from './transcribe';
import { createTts, ttsKey } from './tts';
import { makeToneWav } from './wav';

type FetchArgs = [input: unknown, init?: RequestInit];

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (...[input, init]: FetchArgs) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const allTts = { spark: false, transcribe: false, image: false, tts: true };

describe('tts provider chain', () => {
  it('loads saved narration on a cold start with every provider offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'storybook-audio-'));
    try {
      const key = ttsKey('narrator', 'A saved story.');
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify([{ key, provider: 'elevenlabs' }]));
      writeFileSync(join(dir, `${key}.mp3`), Buffer.from('saved mp3 fixture'));
      const calls = stubFetch(() => { throw new Error('No network allowed'); });
      const tts = createTts(testRuntime(), pathToFileURL(dir + '/'));
      expect((await tts.synthesize('A saved story.', 'narrator'))?.audio.toString()).toBe('saved mp3 fixture');
      expect(await tts.synthesize('An uncached story.', 'narrator')).toBeNull();
      expect(calls).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('tries Muse TTS first when the capability is on', async () => {
    const calls = stubFetch(() => audioResponse());
    const rt = testRuntime(
      { caps: allTts, hasElevenLabs: true, hasOpenAI: true },
      { MUSE_TTS_MODEL: 'muse-tts-test', MUSE_TTS_VOICE: 'story', OPENAI_API_KEY: 'test-openai' },
    );
    const out = await createTts(rt).synthesize('Once upon a time', 'narrator');
    expect(out?.provider).toBe('muse');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/audio/speech');
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ model: 'muse-tts-test', voice: 'story', input: 'Once upon a time' });
  });

  it('goes Muse -> ElevenLabs -> OpenAI as each one fails', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('api.meta.ai')) return new Response('nope', { status: 404 });
      if (url.includes('elevenlabs')) return new Response('quota', { status: 429 });
      return audioResponse();
    });
    const rt = testRuntime(
      { caps: allTts, hasElevenLabs: true, hasOpenAI: true },
      { MUSE_TTS_MODEL: 'muse-tts-test', OPENAI_API_KEY: 'test-openai' },
    );
    const out = await createTts(rt).synthesize('The wood holds its breath.', 'narrator');
    expect(out?.provider).toBe('openai');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.meta.ai', 'api.elevenlabs.io', 'api.openai.com']);
    const el = calls[1]!;
    expect(el.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_22050_32');
    expect((el.init?.headers as Record<string, string>)['xi-api-key']).toBe('test-eleven-key');
    expect(JSON.parse(String(el.init?.body))).toEqual({ text: 'The wood holds its breath.', model_id: 'eleven_flash_v2_5' });
    expect(JSON.parse(String(calls[2]!.init?.body))).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin' });
  });

  it('skips Muse TTS when MUSE_TTS_MODEL is unset and returns null when all fail', async () => {
    const calls = stubFetch(() => new Response('down', { status: 500 }));
    const rt = testRuntime({ caps: { ...allTts, tts: false }, hasElevenLabs: true });
    expect(await createTts(rt).synthesize('hello there', 'narrator')).toBeNull();
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.elevenlabs.io']);
  });

  it('skips a provider that is down for a while', async () => {
    const calls = stubFetch((url) => (url.includes('elevenlabs') ? new Response('down', { status: 503 }) : audioResponse()));
    const tts = createTts(testRuntime({ hasElevenLabs: true, hasOpenAI: true }, { OPENAI_API_KEY: 'test-openai' }));
    expect((await tts.synthesize('line one', 'narrator'))?.provider).toBe('openai');
    expect((await tts.synthesize('line two', 'narrator'))?.provider).toBe('openai');
    expect(calls.filter((c) => c.url.includes('elevenlabs'))).toHaveLength(1);
  });

  it('rejects JSON bodies that pretend to be audio', async () => {
    stubFetch(() => jsonResponse({ detail: 'error' }));
    const rt = testRuntime({ hasElevenLabs: true });
    expect(await createTts(rt).synthesize('hello there', 'narrator')).toBeNull();
  });

  it('uses a distinct boss voice, retrying with the narrator voice if it is missing', async () => {
    const calls = stubFetch((url) =>
      url.includes(ELEVENLABS_BOSS_VOICE_ID) ? new Response('voice_not_found', { status: 404 }) : audioResponse(),
    );
    const out = await createTts(testRuntime({ hasElevenLabs: true })).synthesize('Shhh.', 'boss');
    expect(out?.provider).toBe('elevenlabs');
    expect(calls[0]!.url).toContain(ELEVENLABS_BOSS_VOICE_ID);
    expect(calls[1]!.url).toContain('JBFqnCBsd6RMkjVDRZzb');
  });

  it('caches by speaker and text, and dedupes concurrent requests', async () => {
    const calls = stubFetch(() => audioResponse());
    const tts = createTts(testRuntime({ hasElevenLabs: true }));
    const [a, b] = await Promise.all([tts.synthesize('Duck!', 'narrator'), tts.synthesize('Duck!', 'narrator')]);
    expect(a?.audio).toBe(b?.audio);
    await tts.synthesize('Duck!', 'narrator');
    expect(calls).toHaveLength(1);
    await tts.synthesize('Duck!', 'boss');
    expect(calls.length).toBeGreaterThan(1);
  });

  it('gives each provider its own short budget', async () => {
    stubFetch((url, init) =>
      url.includes('elevenlabs')
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        : audioResponse(),
    );
    const rt = testRuntime({ hasElevenLabs: true, hasOpenAI: true }, { OPENAI_API_KEY: 'test-openai' });
    const started = Date.now();
    const out = await createTts(rt).synthesize('slow line', 'narrator');
    expect(out?.provider).toBe('openai');
    expect(Date.now() - started).toBeLessThan(4000);
  }, 8000);
});

describe('transcription chain', () => {
  const wav = makeToneWav({ seconds: 0.2 });
  const museOn = { spark: false, transcribe: true, image: false, tts: false };

  it('uses the documented Muse request + audio multipart contract', async () => {
    const calls = stubFetch(() => jsonResponse({ results: [{ text: 'forty miles from anything' }] }));
    const out = await createTranscriber(testRuntime({ caps: museOn })).transcribe(wav, 'audio/wav', 'clip.wav');
    expect(out).toEqual({ text: 'forty miles from anything', provider: 'muse-asr' });
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/asr/transcribe');
    const form = calls[0]!.init?.body as FormData;
    expect(JSON.parse(await (form.get('request') as Blob).text())).toEqual({
      model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK',
    });
    expect((form.get('request') as Blob).type).toBe('application/json');
    expect((form.get('audio') as File).name).toBe('audio.wav');
    expect(form.has('file')).toBe(false);
    expect((calls[0]!.init?.headers as Record<string, string>).Accept).toBe('application/json');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer test-muse-key');
  });

  it('falls back to /audio/transcriptions on 404 and remembers it', async () => {
    const calls = stubFetch((url) =>
      url.endsWith('/asr/transcribe') ? new Response('', { status: 404 }) : jsonResponse({ text: 'the library is closing' }),
    );
    const transcriber = createTranscriber(testRuntime({ caps: museOn }));
    expect(await transcriber.transcribe(wav, 'audio/wav')).toEqual({ text: 'the library is closing', provider: 'muse-openai-compat' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.meta.ai/v1/asr/transcribe',
      'https://api.meta.ai/v1/audio/transcriptions',
    ]);
    await transcriber.transcribe(wav, 'audio/wav');
    expect(calls.at(-1)!.url).toBe('https://api.meta.ai/v1/audio/transcriptions');
    expect(calls).toHaveLength(3);
  });

  it('falls back to OpenAI when Muse errors, and still tries Muse with non-WAV audio', async () => {
    const warn = vi.fn();
    const calls = stubFetch((url) =>
      url.includes('api.meta.ai') ? new Response('bad audio', { status: 400 }) : jsonResponse({ text: 'i am a gardener now' }),
    );
    const rt = testRuntime({ caps: museOn, hasOpenAI: true, warn }, { OPENAI_API_KEY: 'test-openai' });
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    const out = await createTranscriber(rt).transcribe(webm, 'audio/webm;codecs=opus', 'blob');
    expect(out).toEqual({ text: 'i am a gardener now', provider: 'openai' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.meta.ai/v1/asr/transcribe',
      'https://api.openai.com/v1/audio/transcriptions',
    ]);
    expect(((calls[1]!.init?.body as FormData).get('file') as File).name).toBe('audio.webm');
    expect((calls[1]!.init?.body as FormData).get('model')).toBe('gpt-4o-mini-transcribe');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('non-WAV');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('test-muse-key');
  });

  it('returns null when nothing is configured', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'x' }));
    expect(await createTranscriber(testRuntime()).transcribe(wav, 'audio/wav')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('parses transcripts from many response shapes', () => {
    expect(parseTranscript({ text: ' hi ' })).toBe('hi');
    expect(parseTranscript({ transcript: 'hey' })).toBe('hey');
    expect(parseTranscript({ results: [{ text: 'a' }, { text: 'b' }] })).toBe('a b');
    expect(parseTranscript({ data: { text: 'nested' } })).toBe('nested');
    expect(parseTranscript('plain')).toBe('plain');
    expect(parseTranscript({ nope: 1 })).toBeNull();
  });
});

describe('images', () => {
  const imageOn = { spark: false, transcribe: false, image: true, tts: false };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

  it('stores b64 images in memory and serves them by id', async () => {
    const calls = stubFetch(() => jsonResponse({ data: [{ b64_json: png.toString('base64') }] }));
    const svc = createImageService(testRuntime({ caps: imageOn }), 'not the cached world');
    const got: WorldImage[] = [];
    await svc.generateImages(CACHED_WORLD, (img) => got.push(img));
    expect(got.map((g) => g.kind).sort()).toEqual(['boss', 'cover', 'monster']);
    for (const img of got) {
      expect(img.url).toMatch(/^\/api\/images\/[0-9a-f]{32}$/);
      const stored = svc.getImage(img.url.split('/').pop()!);
      expect(stored?.contentType).toBe('image/png');
      expect(stored?.buf.equals(png)).toBe(true);
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/images/generations');
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ model: 'muse-image-1.0', n: 1 });
  });

  it('passes URLs through and caches by prompt', async () => {
    const calls = stubFetch(() => jsonResponse({ data: [{ url: 'https://cdn.example/img.png' }] }));
    const svc = createImageService(testRuntime({ caps: imageOn }), 'x');
    const first: WorldImage[] = [];
    await svc.generateImages(CACHED_WORLD, (img) => first.push(img));
    expect(first.every((i) => i.url === 'https://cdn.example/img.png')).toBe(true);
    await svc.generateImages(CACHED_WORLD, () => {});
    expect(calls).toHaveLength(3);
  });

  it('retries once without size on a 400, then falls back to placeholders on failure', async () => {
    const calls = stubFetch(() => new Response('bad', { status: 400 }));
    const svc = createImageService(testRuntime({ caps: imageOn }), 'x', new URL('./fixtures/no-cached-images/', import.meta.url));
    const got: WorldImage[] = [];
    await svc.generateImages(CACHED_WORLD, (img) => got.push(img));
    expect(calls).toHaveLength(6);
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect(bodies.filter((b) => 'size' in b)).toHaveLength(3);
    expect(bodies.filter((b) => !('size' in b))).toHaveLength(3);
    expect(got.find((g) => g.kind === 'boss')?.url).toBe('/api/placeholder/boss.svg');
  });

  it('serves all three shipped demo images with the network unavailable', async () => {
    const calls = stubFetch(() => { throw new Error('No network allowed'); });
    const svc = createImageService(testRuntime(), CACHED_WORLD.title);
    const got: WorldImage[] = [];
    await svc.generateImages(CACHED_WORLD, (image) => got.push(image));
    expect(got).toHaveLength(3);
    for (const image of got) {
      expect(image.url).toBe(`/api/images/cached-${image.kind}`);
      expect(svc.getImage(`cached-${image.kind}`)!.length).toBeGreaterThan(100);
    }
    expect(calls).toHaveLength(0);
  });

  it('uses placeholders straight away when Muse Image is off, and survives a throwing callback', async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const svc = createImageService(testRuntime(), 'x');
    let n = 0;
    await svc.generateImages(CACHED_WORLD, () => {
      n++;
      throw new Error('client bug');
    });
    expect(n).toBe(3);
    expect(calls).toHaveLength(0);
  });
});
