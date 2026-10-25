import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERCY_POWER } from '@once-upon/shared';
import type { ChatUploadResponse, P0ElementType, TranscribeResponse } from '@once-upon/shared';
import type { RoomService, ServerContext } from '../contracts';
import { registerAiRoutes } from './routes';
import { CACHED_WORLD, createAiServiceWith } from './service';
import { testRuntime } from './test-utils';

const sampleExport = readFileSync(new URL('./fixtures/sample-instagram-export.json', import.meta.url));

const recorded: { roomCode: string; playerId: string; element: P0ElementType; result: TranscribeResponse }[] = [];
const emitted: { room: string; event: string; payload: unknown }[] = [];

const rooms: RoomService = {
  createRoom: async () => ({ roomCode: 'ABCD', hostPlayerId: 'p1' }),
  getState: () => null,
  getQuestStatus: () => null,
  getIncantation: (code, element) => (code === 'ROOM' && element === 'ember' ? 'by the noisy car burn' : null),
  buildJoinLink: () => 'http://localhost',
  recordIncantation: (roomCode, playerId, element, result) => recorded.push({ roomCode, playerId, element, result }),
};

let server: Server;
let base: string;
const ai = createAiServiceWith(testRuntime());

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const io = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
  };
  const ctx = { io, rooms, ai, boss: { planNextRound: async () => { throw new Error('unused'); } } } as unknown as ServerContext;
  registerAiRoutes(app, ctx);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function transcribe(fields: Record<string, string>, audio?: Buffer) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (audio) form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'clip.wav');
  return fetch(`${base}/api/transcribe`, { method: 'POST', body: form });
}

describe('POST /api/chat-upload', () => {
  it('turns the sample export into real cards and replaces the fixtures', async () => {
    const form = new FormData();
    form.append('file', new Blob([sampleExport], { type: 'application/json' }), 'message_1.json');
    form.append('roomCode', 'abcd');
    const res = await fetch(`${base}/api/chat-upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatUploadResponse;
    expect(body.cards.length).toBeGreaterThanOrEqual(3);
    expect(body.cards.length).toBeLessThanOrEqual(5);
    for (const c of body.cards) {
      expect(c.quote.length).toBeLessThanOrEqual(140);
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['Maya', 'Dev', 'Priya']).toEqual(expect.arrayContaining(c.people));
    }
    expect(ai.listMemoryCards()).toEqual(body.cards);
    expect(emitted.at(-1)).toMatchObject({ room: 'ABCD', event: 'memory:cards' });
  });

  it('rejects uploads that are not an export', async () => {
    const form = new FormData();
    form.append('file', new Blob(['{"hello":1}'], { type: 'application/json' }), 'x.json');
    expect((await fetch(`${base}/api/chat-upload`, { method: 'POST', body: form })).status).toBe(422);
    const empty = new FormData();
    empty.append('note', 'no file');
    expect((await fetch(`${base}/api/chat-upload`, { method: 'POST', body: empty })).status).toBe(400);
  });
});

describe('POST /api/transcribe', () => {
  it('validates fields', async () => {
    expect((await transcribe({ roomCode: 'ROOM', playerId: 'p1', element: 'storm' })).status).toBe(400);
  });

  it('matches a transcript override against the room incantation and records it', async () => {
    const res = await transcribe({ roomCode: 'ROOM', playerId: 'p1', element: 'ember', transcriptOverride: 'by the noisy car, burn!' });
    const body = (await res.json()) as TranscribeResponse;
    expect(body).toMatchObject({ expected: 'by the noisy car burn', matchRatio: 1, passed: true, mercy: false, power: 1 });
    expect(recorded.at(-1)).toMatchObject({ roomCode: 'ROOM', playerId: 'p1', element: 'ember' });
  });

  it('falls back to the cached incantation and applies the mercy rule', async () => {
    const fields = { roomCode: 'NOPE', playerId: 'p2', element: 'frost', transcriptOverride: 'banana' };
    const a = (await (await transcribe(fields)).json()) as TranscribeResponse;
    const b = (await (await transcribe(fields)).json()) as TranscribeResponse;
    const c = (await (await transcribe(fields)).json()) as TranscribeResponse;
    expect(a.expected).toBe(CACHED_WORLD.incantations.frost);
    expect([a.passed, b.passed, c.passed]).toEqual([false, false, true]);
    expect(c).toMatchObject({ mercy: true, attempt: 3, power: MERCY_POWER });
  });

  it('counts an attempt as a failure when no transcriber is configured', async () => {
    const audio = Buffer.from('RIFF....WAVEfmt ');
    const body = (await (await transcribe({ roomCode: 'ROOM', playerId: 'p3', element: 'bloom' }, audio)).json()) as TranscribeResponse;
    expect(body).toMatchObject({ transcript: '', passed: false, attempt: 1 });
  });
});

describe('TTS, images and placeholders', () => {
  it('POST /api/tts tells the client to use speechSynthesis when no provider works', async () => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Once upon a time', speaker: 'narrator' }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ fallback: 'speech_synthesis', text: 'Once upon a time' });
  });

  it('GET /api/tts answers 503 so an <audio> element errors out', async () => {
    const res = await fetch(`${base}/api/tts?text=${encodeURIComponent('Duck!')}&speaker=boss`);
    expect(res.status).toBe(503);
    expect((await fetch(`${base}/api/tts`)).status).toBe(400);
  });

  it('serves placeholder SVGs and 404s unknown images', async () => {
    const svg = await fetch(`${base}/api/placeholder/boss.svg`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('<svg');
    expect((await fetch(`${base}/api/placeholder/dragon.svg`)).status).toBe(404);
    expect((await fetch(`${base}/api/images/does-not-exist`)).status).toBe(404);
  });
});
