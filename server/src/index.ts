/**
 * Server entrypoint. ORCHESTRATOR-OWNED: wires Express, Socket.IO and the three modules.
 *
 * One Node service serves the Socket.IO and (when built) the Vite client
 * from `client/dist`, so a single Render/Railway service is the whole deployment.
 */
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { Server } from 'socket.io';
import { config } from './config';
import type { GameServer, ServerContext } from './contracts';
import { createRoomService } from './engine';
import { registerStoryRooms } from './storyRooms';

/** Paths the SPA fallback must never answer. */
const NON_SPA_PREFIXES = ['/api', '/socket.io', '/health'];

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
  const io: GameServer = new Server(httpServer, { cors: { origin: config.clientOrigin } });

  const rooms = createRoomService({ io });
  const ctx: ServerContext = { io, rooms };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, serverTimeMs: Date.now() });
  });

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
  // Authored-story room codes (`story:*` events), alongside the combat rooms.
  registerStoryRooms(io as unknown as Parameters<typeof registerStoryRooms>[0]);

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
    `[server] listening on :${server.port}`,
  );
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
