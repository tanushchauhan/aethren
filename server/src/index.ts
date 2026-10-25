/**
 * Server entrypoint. ORCHESTRATOR-OWNED: wires Express, Socket.IO and the three modules.
 *
 * One Node service serves the REST API, Socket.IO, `/mcp`, and (when built) the Vite client
 * from `client/dist`, so a single Render/Railway service is the whole deployment.
 */
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cors from 'cors';
import express, { type Express } from 'express';
import { Server } from 'socket.io';
import { createAiService, registerAiRoutes } from './ai';
import { createBossPlanner, registerAgentRoutes } from './agents';
import { config, hasElevenLabs, hasMuse, hasOpenAI, museCapabilities } from './config';
import type { GameServer, ServerContext } from './contracts';
import { createRoomService } from './engine';

/** Paths the SPA fallback must never answer. */
const NON_SPA_PREFIXES = ['/api', '/mcp', '/socket.io', '/health'];

const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

export interface StartedServer {
  app: Express;
  httpServer: HttpServer;
  io: GameServer;
  ctx: ServerContext;
  /** The bound port (useful with `port: 0` in tests). */
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: { port?: number } = {}): Promise<StartedServer> {
  const app = express();
  const httpServer = createHttpServer(app);
  const corsOptions = { origin: config.clientOrigin, credentials: true };

  const io: GameServer = new Server(httpServer, { cors: corsOptions });

  app.use(cors(corsOptions));
  app.use(express.json({ limit: '2mb' }));

  // Construction order resolves the rooms <-> MCP cycle: ai -> boss -> rooms -> routes.
  const ai = createAiService();
  const boss = createBossPlanner(ai);
  const rooms = createRoomService({ io, ai, boss });
  const ctx: ServerContext = { io, rooms, ai, boss };

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      muse: hasMuse,
      museCapabilities,
      elevenLabs: hasElevenLabs,
      openai: hasOpenAI,
      mcpAuth: Boolean(config.mcpBearerToken),
      useCachedWorld: config.useCachedWorld,
      serverTimeMs: Date.now(),
    });
  });

  registerAiRoutes(app, ctx);
  registerAgentRoutes(app, ctx);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    app.use(express.static(CLIENT_DIST));
    app.use((req, res, next) => {
      const isSpaRequest =
        (req.method === 'GET' || req.method === 'HEAD') &&
        !NON_SPA_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`));
      if (!isSpaRequest) return next();
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  io.on('connection', (socket) => rooms.registerSocketHandlers(socket));

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? config.port, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return {
    app,
    httpServer,
    io,
    ctx,
    port: (httpServer.address() as AddressInfo).port,
    close: async () => {
      rooms.dispose();
      await io.close();
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = await startServer();
  console.log(
    `[server] listening on :${server.port} (muse=${hasMuse}, elevenLabs=${hasElevenLabs}, openai=${hasOpenAI}, cachedWorld=${config.useCachedWorld})`,
  );
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
