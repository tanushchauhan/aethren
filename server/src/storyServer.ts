import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { registerStoryRooms } from './storyRooms';

export async function startServer(port = Number(process.env.PORT ?? 3001)) {
  const app = express();
  const http = createServer(app);
  const origin = process.env.CLIENT_ORIGIN?.split(',').map(value => value.trim()) ?? true;
  const io = new Server(http, { cors: { origin } });
  registerStoryRooms(io);
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  const dist = fileURLToPath(new URL('../../client/dist', import.meta.url));
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/socket.io')) res.sendFile(path.join(dist, 'index.html'));
      else next();
    });
  }
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, resolve); });
  return { http, io, close: () => new Promise<void>(resolve => io.close(() => resolve())) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer();
  console.log(`Story server listening on port ${process.env.PORT ?? 3001}`);
  const stop = () => { void server.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
