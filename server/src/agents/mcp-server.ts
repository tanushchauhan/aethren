/**
 * MCP Quest Master: the `/mcp` Streamable HTTP endpoint Muse's connector calls.
 *
 * Stateless mode: every POST gets a fresh `McpServer` and transport (`sessionIdGenerator:
 * undefined`), so no session state lives on the server and any instance can answer.
 * GET (standalone SSE stream) and DELETE (session end) are not offered and return 405.
 *
 * Auth: `Authorization: Bearer <MCP_BEARER_TOKEN>`, compared in constant time. Without a
 * token, development allows every request (with one warning) and production answers 503.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config';
import type { ServerContext } from '../contracts';
import {
  executeQuestTool,
  questToolInputShapes,
  questToolMeta,
  questToolOutputShapes,
  type QuestToolName,
} from './quest-tools';

export const MCP_SERVER_INFO = { name: 'once-upon-a-memory-quest-master', version: '0.1.0' } as const;

const MCP_INSTRUCTIONS = [
  'Quest Master for Once Upon a Memory, a co-op fairy-tale game played on two laptops.',
  'To set up a quest: optionally call list_memory_cards to pick a memory, then call create_quest once',
  'with the person asking as the first player name, and share each player\'s join link.',
  'Use invite_player to add someone later and get_quest_status to report how the fight is going.',
].join(' ');

export interface McpAuthOptions {
  /** Expected bearer token. Defaults to `config.mcpBearerToken`. */
  token?: string;
  /** Defaults to `config.isProduction`. */
  isProduction?: boolean;
  /** Where the one-time "no token" warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string compare. Hashing first hides the expected token's length. */
export function safeTokenEqual(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Extracts the token from `Authorization: Bearer <token>`, or `null`. */
export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** Express middleware enforcing the MCP bearer token. */
export function mcpAuth(opts: McpAuthOptions = {}): RequestHandler {
  const token = 'token' in opts ? opts.token : config.mcpBearerToken;
  const isProduction = opts.isProduction ?? config.isProduction;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let warned = false;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      if (isProduction) {
        jsonRpcError(res, 503, -32000, 'MCP is not configured on this server (MCP_BEARER_TOKEN is unset).');
        return;
      }
      if (!warned) {
        warned = true;
        warn('[mcp] MCP_BEARER_TOKEN is unset: /mcp accepts unauthenticated requests (development only).');
      }
      next();
      return;
    }
    const given = readBearerToken(req.get('authorization'));
    if (given === null || !safeTokenEqual(given, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
      jsonRpcError(res, 401, -32001, 'Unauthorized: send Authorization: Bearer <token>.');
      return;
    }
    next();
  };
}

function toCallToolResult(result: Awaited<ReturnType<typeof executeQuestTool>>): CallToolResult {
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: result.error }] };
  }
  return {
    content: [
      { type: 'text', text: result.text },
      { type: 'text', text: JSON.stringify(result.data) },
    ],
    structuredContent: result.data,
  };
}

/**
 * Builds a Quest Master server. Tool handlers read `ctx.rooms` / `ctx.ai` at call time,
 * never a captured copy, so a swapped-in engine is picked up immediately.
 */
export function createQuestMasterServer(ctx: ServerContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: MCP_INSTRUCTIONS });
  const run = async (name: QuestToolName, args: unknown) =>
    toCallToolResult(await executeQuestTool(ctx, name, args));

  server.registerTool(
    'list_memory_cards',
    {
      ...questToolMeta.list_memory_cards,
      inputSchema: questToolInputShapes.list_memory_cards,
      outputSchema: questToolOutputShapes.list_memory_cards,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run('list_memory_cards', {}),
  );
  server.registerTool(
    'create_quest',
    {
      ...questToolMeta.create_quest,
      inputSchema: questToolInputShapes.create_quest,
      outputSchema: questToolOutputShapes.create_quest,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => run('create_quest', args),
  );
  server.registerTool(
    'invite_player',
    {
      ...questToolMeta.invite_player,
      inputSchema: questToolInputShapes.invite_player,
      outputSchema: questToolOutputShapes.invite_player,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => run('invite_player', args),
  );
  server.registerTool(
    'get_quest_status',
    {
      ...questToolMeta.get_quest_status,
      inputSchema: questToolInputShapes.get_quest_status,
      outputSchema: questToolOutputShapes.get_quest_status,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => run('get_quest_status', args),
  );
  return server;
}

/**
 * The transport requires `Accept: application/json, text/event-stream`. Hand-written
 * connectors often send only `application/json`, so fill in whatever is missing.
 */
function normalizeAcceptHeader(req: IncomingMessage): void {
  const accept = req.headers.accept ?? '';
  const missing = ['application/json', 'text/event-stream'].filter((t) => !accept.includes(t));
  if (missing.length === 0) return;
  const value = [accept, ...missing].filter(Boolean).join(', ');
  req.headers.accept = value;
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === 'accept') {
      raw[i + 1] = value;
      found = true;
    }
  }
  if (!found) raw.push('Accept', value);
}

export function registerMcpRoutes(app: Express, ctx: ServerContext, auth: McpAuthOptions = {}): void {
  const requireToken = mcpAuth(auth);

  app.post('/mcp', requireToken, async (req: Request, res: Response) => {
    const server = createQuestMasterServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      normalizeAcceptHeader(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed: this MCP server is stateless, use POST.');
  };
  app.get('/mcp', requireToken, notAllowed);
  app.delete('/mcp', requireToken, notAllowed);
}
