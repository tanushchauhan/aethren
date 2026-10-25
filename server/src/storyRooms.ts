import { randomInt } from 'node:crypto';
import type { Server, Socket } from 'socket.io';

/** Online presence only: the authored story is played locally, with no combat engine. */
export function registerStoryRooms(io: Server) {
  const rooms = new Map<string, Map<string, string>>();
  const publish = (code: string) => ({ code, players: [...(rooms.get(code) ?? [])].map(([id, name]) => ({ id, name })) });
  const cleanName = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 32) : '';
  function leave(socket: Socket) {
    const code = socket.data.storyCode as string | undefined;
    if (!code) return;
    rooms.get(code)?.delete(socket.id); void socket.leave(code); delete socket.data.storyCode;
    if (!rooms.get(code)?.size) rooms.delete(code);
    else io.to(code).emit('story:room', publish(code));
  }
  io.on('connection', socket => {
    socket.on('story:create', (input: unknown) => {
      const name = cleanName((input as { name?: unknown } | null)?.name);
      if (!name) { socket.emit('story:error', { message: 'Enter your name.' }); return; }
      if (rooms.size >= 1000) { socket.emit('story:error', { message: 'The server is full. Try again later.' }); return; }
      leave(socket);
      let code: string;
      do { code = Array.from({ length: 4 }, () => String.fromCharCode(65 + randomInt(26))).join(''); } while (rooms.has(code));
      rooms.set(code, new Map([[socket.id, name]])); socket.data.storyCode = code;
      void socket.join(code); socket.emit('story:joined', publish(code));
    });
    socket.on('story:join', (input: unknown) => {
      const payload = input as { name?: unknown; code?: unknown } | null;
      const name = cleanName(payload?.name);
      const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!name || !room) { socket.emit('story:error', { message: !name ? 'Enter your name.' : 'Room not found.' }); return; }
      if (room.size >= 2 && !room.has(socket.id)) { socket.emit('story:error', { message: 'This adventure already has two players.' }); return; }
      if (socket.data.storyCode !== code) leave(socket);
      room.set(socket.id, name); socket.data.storyCode = code; void socket.join(code);
      socket.emit('story:joined', publish(code)); io.to(code).emit('story:room', publish(code));
    });
    socket.on('disconnect', () => leave(socket));
  });
}
