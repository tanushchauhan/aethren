/** Live checks using synthetic fixtures only; no personal chat or microphone data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../index';
import { config } from '../config';
import { extractMemoryCards } from './cards';
import { parseInstagramExport } from './instagram';
import type { QuestChatResponse, TranscribeResponse } from '@once-upon/shared';

const server = await startServer({ port: 0 });
const base = `http://localhost:${server.port}`;
const client = new Client({ name: 'local-pipeline-check', version: '1.0.0' });
try {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/sample-instagram-export.json', import.meta.url), 'utf8'));
  const cards = await extractMemoryCards(server.ctx.ai.muse, parseInstagramExport(fixture), 15_000);
  assert.equal(cards.source, 'muse', 'Memory extraction used a fallback');
  assert.ok(cards.cards.length >= 3);
  console.log(`PASS real Muse extraction: ${cards.cards.length} validated memory cards`);

  let liveToolCalls = 0;
  const complete = server.ctx.ai.muse.complete.bind(server.ctx.ai.muse);
  server.ctx.ai.muse.complete = async (request) => {
    const reply = await complete(request);
    liveToolCalls += reply?.tool_calls?.length ?? 0;
    return reply;
  };
  const response = await fetch(`${base}/api/quest-chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Create a normal quest for Maya and Dev.', hostName: 'Maya' }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  const quest = await response.json() as QuestChatResponse;
  assert.ok(quest.roomCode && /^[A-Z]{4}$/.test(quest.roomCode));
  assert.ok(liveToolCalls > 0, 'Quest setup used a local fallback instead of live tool calls');
  console.log(`PASS live Quest Master: ${liveToolCalls} model tool calls, room ${quest.roomCode}`);

  const audio = readFileSync(new URL('./fixtures/spoken-incantation.wav', import.meta.url));
  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'incantation.wav');
  form.append('roomCode', quest.roomCode!);
  form.append('playerId', server.ctx.rooms.getState(quest.roomCode!)!.players[0]!.id);
  form.append('element', 'ember');
  const transcription = await fetch(`${base}/api/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
  assert.equal(transcription.status, 200);
  const verdict = await transcription.json() as TranscribeResponse;
  assert.equal(verdict.passed, true);
  assert.equal(verdict.mercy, false);
  assert.ok(verdict.transcript.length > 0);
  console.log(`PASS spoken WAV -> Muse -> incantation match: "${verdict.transcript}"`);

  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: config.mcpBearerToken ? { Authorization: `Bearer ${config.mcpBearerToken}` } : {} },
  }));
  assert.equal((await client.listTools()).tools.length, 4);
  const status = await client.callTool({ name: 'get_quest_status', arguments: { room_code: quest.roomCode } });
  assert.ok(!status.isError);
  console.log('PASS authenticated MCP discovery and quest status');
} finally {
  await client.close();
  await server.close();
}
