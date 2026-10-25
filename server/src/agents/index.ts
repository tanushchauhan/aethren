/**
 * Boss agent and Quest Master (Agent 1C).
 *
 * - `createBossPlanner(ai)`: Muse Spark plans each round with tool calls inside a deadline,
 *   falling back to the scripted cycle (`boss-agent.ts`).
 * - `registerAgentRoutes(app, ctx)`: the `/mcp` Streamable HTTP server (`mcp-server.ts`) and
 *   `POST /api/quest-chat` (`quest-chat.ts`), both running the tools in `quest-tools.ts`.
 *
 * `index.ts` installs `express.json()` before these routes, so `req.body` is already parsed
 * and is handed to the MCP transport as its parsed body.
 */
import type { Express } from 'express';
import type { AiService, BossPlanner, ServerContext } from '../contracts';
import { createBossPlanner as createAgentBossPlanner } from './boss-agent';
import { registerMcpRoutes } from './mcp-server';
import { registerQuestChatRoute } from './quest-chat';

export function createBossPlanner(ai: AiService): BossPlanner {
  return createAgentBossPlanner(ai);
}

export function registerAgentRoutes(app: Express, ctx: ServerContext): void {
  registerMcpRoutes(app, ctx);
  registerQuestChatRoute(app, ctx);
}
