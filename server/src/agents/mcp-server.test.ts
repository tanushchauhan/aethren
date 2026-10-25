import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { QuestStatus } from '@once-upon/shared';
import type { ServerContext } from '../contracts';
import type { StartedServer } from '../index';

// Make sure a token is configured before `config.ts` loads (it reads process.env once).
process.env.MCP_BEARER_TOKEN ||= 'test-mcp-token';

let server: StartedServer;
let baseUrl: string;
let token: string;
const clients: Client[] = [];

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type TextContent = { type: 'text'; text: string };

beforeAll(async () => {
  const { startServer } = await import('../index');
  const { config } = await import('../config');
  token = config.mcpBearerToken!;
  server = await startServer({ port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await server.close();
});

describe('MCP Quest Master over HTTP', () => {
  it('lists the 4 tools with input schemas', async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_quest',
      'get_quest_status',
      'invite_player',
      'list_memory_cards',
    ]);
    const create = tools.find((t) => t.name === 'create_quest')!;
    expect(create.inputSchema.required).toEqual(['player_names']);
    expect(create.description).toMatch(/room code/i);
  });

  it('creates a quest that get_quest_status and invite_player can read', async () => {
    const client = await connect(token);

    const cards = await client.callTool({ name: 'list_memory_cards', arguments: {} });
    const cardList = (cards.structuredContent as { cards: { id: string }[] }).cards;
    expect(cardList.length).toBeGreaterThan(0);

    const created = await client.callTool({
      name: 'create_quest',
      arguments: { player_names: ['Maya', 'Dev'], difficulty: 'hard', encounter_card_id: cardList[0]!.id },
    });
    expect(created.isError).toBeFalsy();
    const data = created.structuredContent as {
      roomCode: string;
      players: { playerName: string; joinLink: string }[];
    };
    expect(data.roomCode).toMatch(/^[A-Z]{4}$/);
    expect(data.players.map((p) => p.playerName)).toEqual(['Maya', 'Dev']);
    expect(data.players[1]!.joinLink).toContain(`room=${data.roomCode}`);
    const content = created.content as TextContent[];
    expect(content[0]!.text).toContain(data.roomCode);
    expect(JSON.parse(content[1]!.text)).toEqual(data);

    const status = await client.callTool({
      name: 'get_quest_status',
      arguments: { room_code: data.roomCode.toLowerCase() },
    });
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent as unknown as QuestStatus).toMatchObject({
      roomCode: data.roomCode,
      phase: 'lobby',
    });

    const state = server.ctx.rooms.getState(data.roomCode);
    expect(state?.players.map((p) => p.name)).toEqual(['Maya', 'Dev']);

    const invite = await client.callTool({
      name: 'invite_player',
      arguments: { room_code: data.roomCode, player_name: 'Sam' },
    });
    expect((invite.structuredContent as { joinLink: string }).joinLink).toContain('name=Sam');

    const missing = await client.callTool({ name: 'get_quest_status', arguments: { room_code: 'QQQQ' } });
    expect(missing.isError).toBe(true);
  });

  it('rejects a wrong or missing token with 401 and WWW-Authenticate', async () => {
    await expect(connect(`${token}-wrong`)).rejects.toThrow();

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
  });

  it('answers GET and DELETE with 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp`, { method, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
      expect(((await res.json()) as { jsonrpc: string }).jsonrpc).toBe('2.0');
    }
  });

  it('serves clients that only accept application/json', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('once-upon-a-memory-quest-master');
  });

  it('serves the quest box over HTTP', async () => {
    // Force the deterministic parser so the test never waits on a live Muse call.
    const ai = server.ctx.ai as { muse: ServerContext['ai']['muse'] };
    const realMuse = ai.muse;
    ai.muse = { available: false, complete: async () => null };
    try {
      const res = await fetch(`${baseUrl}/api/quest-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Set up a quest for me and Dev, make it hard' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roomCode: string; joinLink: string };
      expect(body.roomCode).toMatch(/^[A-Z]{4}$/);
      expect(server.ctx.rooms.getQuestStatus(body.roomCode)).not.toBeNull();

      const bad = await fetch(`${baseUrl}/api/quest-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      ai.muse = realMuse;
    }
  });
});

describe('MCP auth without a token', () => {
  const fakeCtx = {
    ai: { listMemoryCards: () => [] },
    rooms: { getQuestStatus: () => null },
  } as unknown as ServerContext;

  async function serve(isProduction: boolean, warn: (m: string) => void): Promise<{ url: string; http: Server }> {
    const { registerMcpRoutes } = await import('./mcp-server');
    const app = express();
    app.use(express.json());
    registerMcpRoutes(app, fakeCtx, { token: undefined, isProduction, warn });
    const http = createServer(app);
    await new Promise<void>((r) => http.listen(0, r));
    return { url: `http://localhost:${(http.address() as AddressInfo).port}/mcp`, http };
  }

  const listTools = (url: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('returns 503 in production', async () => {
    const { url, http } = await serve(true, () => {});
    try {
      expect((await listTools(url)).status).toBe(503);
    } finally {
      http.close();
    }
  });

  it('allows requests in development and warns once', async () => {
    const warn = vi.fn();
    const { url, http } = await serve(false, warn);
    try {
      expect((await listTools(url)).status).toBe(200);
      expect((await listTools(url)).status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      http.close();
    }
  });
});
