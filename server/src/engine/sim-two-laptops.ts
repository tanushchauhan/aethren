/**
 * Two-laptop mock run: starts the real server, connects two Socket.IO clients (Maya with the
 * glove, Dev bare-handed), quick-starts, joins, calibrates and plays a full run to the ending.
 *
 *   pnpm --filter @once-upon/server exec tsx src/engine/sim-two-laptops.ts [--verbose]
 *
 * Phases run at `ENGINE_TIME_SCALE` (default 0.2 here, so a run takes well under a minute).
 * Maya records incantations through `ctx.rooms.recordIncantation`; Dev posts a fake clip to
 * `/api/transcribe` (falling back to `recordIncantation` if the route does not pass him).
 * Dev fizzles once and sits out once on purpose, Maya parries projectiles, and behind the boss
 * ward both cast Ember together for a Twin Cast. Dodges use a seeded PRNG, so runs repeat.
 */
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  GamePhase,
  GameState,
  P0ElementType,
  RoomJoinAck,
  ServerToClientEvents,
  TelegraphPayload,
  TranscribeResponse,
} from '@once-upon/shared';

process.env.ENGINE_TIME_SCALE ??= '0.2';
if (process.argv.includes('--verbose')) process.env.ENGINE_LOG ??= '1';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const t0 = Date.now();
const log = (who: string, msg: string) =>
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${who.padEnd(6)} ${msg}`);
const short = (text: string, n = 70) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

interface Laptop {
  name: 'Maya' | 'Dev';
  socket: ClientSocket;
  playerId: string;
  offsetMs: number;
  state: GameState | null;
}

const serverNow = (l: Laptop) => Date.now() + l.offsetMs;

/** Seeded PRNG (mulberry32) so every sim run plays the same way. */
let seed = 7;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Round in which Dev is slow to step back into his silhouette, to show a sit-out. */
const DEV_SITS_OUT_ROUND = 5;

async function main(): Promise<void> {
  const { startServer } = await import('../index');
  const server = await startServer({ port: 0 });
  const url = `http://localhost:${server.port}`;
  log('sim', `server on ${url} (ENGINE_TIME_SCALE=${process.env.ENGINE_TIME_SCALE})`);

  const open = () =>
    new Promise<ClientSocket>((resolve, reject) => {
      const s: ClientSocket = connect(url, { transports: ['websocket'], forceNew: true });
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });

  const syncClock = (s: ClientSocket) =>
    new Promise<number>((resolve) => {
      const clientSendMs = Date.now();
      s.once('clock:pong', (p) => {
        const rtt = Date.now() - p.clientSendMs;
        resolve(Math.round((p.serverRecvMs + p.serverSendMs) / 2 - (p.clientSendMs + rtt / 2)));
      });
      s.emit('clock:ping', { clientSendMs });
    });

  const ack = (s: ClientSocket, ev: 'room:quick_start' | 'room:join', payload: never) =>
    new Promise<RoomJoinAck>((resolve) => (s.emit as (e: string, p: unknown, cb: (r: RoomJoinAck) => void) => void)(ev, payload, resolve));

  const sa = await open();
  const sb = await open();
  const a: Laptop = { name: 'Maya', socket: sa, playerId: '', offsetMs: await syncClock(sa), state: null };
  const b: Laptop = { name: 'Dev', socket: sb, playerId: '', offsetMs: await syncClock(sb), state: null };
  log('sim', `clock offsets: Maya ${a.offsetMs} ms, Dev ${b.offsetMs} ms`);

  const created = await ack(sa, 'room:quick_start', { playerName: 'Maya', role: 'spellbearer' } as never);
  if (!created.ok) throw new Error(created.error);
  a.playerId = created.playerId;
  const code = created.roomCode;
  log('Maya', `quick start -> room ${code} (${created.state.world?.title})`);
  const joined = await ack(sb, 'room:join', { roomCode: code.toLowerCase(), playerName: 'Dev', role: 'partner' } as never);
  if (!joined.ok) throw new Error(joined.error);
  b.playerId = joined.playerId;
  log('Dev', `joined ${code} as ${joined.state.players.find((p) => p.id === b.playerId)?.role}`);

  const nameOf = (id: string) => (id === a.playerId ? 'Maya' : id === b.playerId ? 'Dev' : id.slice(0, 6));
  let rounds = 0;
  let twinCasts = 0;
  let fizzledOnce = false;
  let finished: (state: GameState) => void = () => undefined;
  const done = new Promise<GameState>((resolve) => (finished = resolve));

  // ---- room-wide events, logged once from laptop A ----
  sa.on('combat:telegraph', (t) => {
    rounds += 1;
    log('server', `telegraph ${t.attackType} -> ${t.targetPlayerIds.map(nameOf).join('+')} (window ${t.windowMs} ms) "${short(t.narratorHint, 50)}"`);
  });
  sa.on('player:dodge_result', (d) =>
    log('server', `${nameOf(d.playerId)} ${d.parried ? 'PARRIED' : d.dodged ? 'dodged' : 'was hit'}`),
  );
  sa.on('player:cast', (c) => log('server', `${nameOf(c.playerId)} cast ${c.element} (${c.gesture}, power ${c.power})`));
  sa.on('combat:twin_cast_progress', (p) => {
    if (!p.complete) return;
    twinCasts += 1;
    log('server', `TWIN CAST ${p.element} by ${p.castByPlayerIds.map(nameOf).join('+')}`);
  });
  sa.on('combat:resolve', (r) => {
    const s = a.state;
    log(
      'server',
      `resolve r${r.roundIndex}: dmg ${r.damageDealt}, hearts -${r.heartsLost}/+${r.heartsHealed}, parries ${r.parries}` +
        `${r.twinCast ? ', twin' : ''}${r.wardShattered ? ', WARD SHATTERED' : ''}` +
        `${r.fizzles.length ? `, fizzles ${r.fizzles.map(nameOf).join('+')}` : ''}` +
        `${r.sittingOut.length ? `, sitting out ${r.sittingOut.map(nameOf).join('+')}` : ''}` +
        ` | ${s?.currentEncounter?.name} ${s?.enemyHp}/${s?.enemyMaxHp}${r.enemyDefeated ? ' DEFEATED' : ''}`,
    );
  });
  sa.on('narrator:line', (l) => log(l.speaker, `"${short(l.text)}"`));
  sa.on('hardware:command', (c) => log('glove', c.type === 'servo' ? `servo ${c.servoOpen ? 'open' : 'closed'}` : `buzz ${c.pattern}`));
  sa.on('world:image', (img) => log('server', `image ${img.kind} ready`));

  // ---- each laptop's own behavior ----
  const transcribe = async (l: Laptop, element: P0ElementType): Promise<boolean> => {
    try {
      const form = new FormData();
      form.set('roomCode', code);
      form.set('playerId', l.playerId);
      form.set('element', element);
      form.set('audio', new Blob([new Uint8Array(1024)], { type: 'audio/webm' }), 'clip.webm');
      const res = await fetch(`${url}/api/transcribe`, { method: 'POST', body: form });
      if (!res.ok) return false;
      const body = (await res.json()) as TranscribeResponse;
      return body.passed || body.mercy;
    } catch {
      return false;
    }
  };

  const speak = async (l: Laptop, element: P0ElementType): Promise<void> => {
    const phrase = server.ctx.rooms.getIncantation(code, element) ?? element;
    if (l.name === 'Dev' && (await transcribe(l, element))) return;
    server.ctx.rooms.recordIncantation(code, l.playerId, element, {
      transcript: phrase,
      expected: phrase,
      matchRatio: 1,
      passed: true,
      mercy: false,
      attempt: 1,
      power: 1,
    });
  };

  const cast = (l: Laptop, element: P0ElementType, power: number) =>
    l.socket.emit('player:cast', {
      playerId: l.playerId,
      element,
      gesture: l.name === 'Maya' ? 'thrust' : 'swipe',
      transcript: '',
      power,
      serverTimestampMs: serverNow(l),
    });

  const pose = (l: Laptop, inZone: boolean) =>
    l.socket.emit('player:pose', {
      playerId: l.playerId,
      landmarks: [],
      inZone,
      activeAction: inZone ? 'none' : 'side_step_left',
      confidence: 0.9,
      serverTimestampMs: serverNow(l),
    });

  for (const l of [a, b]) {
    let lastPhase: GamePhase | null = null;
    l.socket.on('room:state', (s) => {
      l.state = s;
      const entered = s.phase !== lastPhase;
      lastPhase = s.phase;
      if (!entered) return;
      if (l === a) {
        log('server', `phase ${s.phase}${s.fightingBoss && s.phase === 'intro' ? ' (boss entrance)' : ''} | hearts ${s.hearts}/${s.maxHearts}${s.wardActive ? ' | WARD UP' : ''}`);
      }
      if (s.phase === 'calibration') {
        setTimeout(() => l.socket.emit('calibration:done', { baseline: { shoulderY: 0.3, shoulderWidth: 0.2, hipY: 0.6, centerX: 0.5, calibratedAt: serverNow(l) } }), 50);
      }
      if (s.phase === 'return') {
        const slow = l.name === 'Dev' && s.roundIndex === DEV_SITS_OUT_ROUND;
        if (slow) log('Dev', 'is slow to get back into his silhouette');
        pose(l, !slow);
      }
      if (s.phase === 'ending') finished(s);
      if (s.phase === 'team_turn') {
        const me = s.players.find((p) => p.id === l.playerId);
        if (!me?.canCast) return;
        let element: P0ElementType;
        if (s.wardActive) element = 'ember';
        else if (l.name === 'Maya') element = 'ember';
        else element = s.hearts <= 3 ? 'bloom' : 'frost';
        const delay = l.name === 'Maya' ? 60 : 160;
        setTimeout(async () => {
          if (l.name === 'Dev' && !fizzledOnce && s.roundIndex >= 1) {
            fizzledOnce = true;
            log('Dev', 'casts before speaking (expect a fizzle)');
            cast(l, element, 1);
            await new Promise((r) => setTimeout(r, 40));
          }
          await speak(l, element);
          cast(l, element, l.name === 'Maya' ? 1.2 : 1);
        }, delay);
      }
    });

    l.socket.on('combat:telegraph', (t: TelegraphPayload) => {
      if (!t.targetPlayerIds.includes(l.playerId)) return;
      const wait = t.impactServerMs - serverNow(l) + t.windowMs * 0.3;
      setTimeout(() => {
        const parry = l.name === 'Maya' && t.attackType === 'projectile';
        const dodged = parry || random() < 0.8;
        if (!dodged) pose(l, false); // a missed dodge: the player stumbled out of their zone
        l.socket.emit('player:dodge_result', {
          playerId: l.playerId,
          attackId: t.attackId,
          dodged,
          parried: parry,
          serverTimestampMs: serverNow(l),
        });
      }, Math.max(0, wait));
    });
  }

  sa.emit('game:start');
  log('Maya', 'game:start');

  const timeout = setTimeout(() => {
    log('sim', `TIMEOUT in phase ${a.state?.phase}`);
    process.exit(1);
  }, 5 * 60_000);

  const end = await done;
  clearTimeout(timeout);
  const victory = end.enemyHp <= 0 && end.hearts > 0;
  await new Promise((r) => setTimeout(r, 300)); // let the last narrator line arrive
  log(
    'sim',
    `ENDING: ${victory ? 'happily ever after' : 'the tale ended early'} after ${rounds} rounds, ` +
      `${twinCasts} twin cast(s), hearts ${end.hearts}/${end.maxHearts}, images ${Object.keys(end.images ?? {}).join(',') || 'none'}`,
  );
  sa.disconnect();
  sb.disconnect();
  await server.close();
  process.exit(victory ? 0 : 2);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
