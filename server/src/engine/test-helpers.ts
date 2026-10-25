/**
 * In-memory fakes for engine tests: a Socket.IO server/socket pair, an AiService and a
 * BossPlanner. Only what the engine touches is implemented. Not imported by runtime code.
 */
import type {
  BossPlan,
  GamePhase,
  MemoryCard,
  RoomJoinAck,
  TranscribeResponse,
  WorldImage,
  WorldSchema,
} from '@once-upon/shared';
import type { AiService, BossPlanner, BossPlannerInput, GameServer, GameSocket } from '../contracts';
import { createEngine, type Engine, type EngineOptions } from './index';

type Handler = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Received {
  event: string;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class FakeIo {
  readonly sockets = new Map<string, FakeSocket>();
  readonly members = new Map<string, Set<string>>();
  /** Every room broadcast, in order. */
  readonly log: (Received & { room: string })[] = [];

  to(room: string) {
    return {
      emit: (event: string, payload: unknown) => {
        this.log.push({ room, event, payload: clone(payload) });
        for (const id of this.members.get(room) ?? []) this.sockets.get(id)?.deliver(event, payload);
        return true;
      },
    };
  }

  asServer(): GameServer {
    return this as unknown as GameServer;
  }

  events(event: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.log.filter((e) => e.event === event).map((e) => e.payload);
  }
}

let nextSocketId = 1;

export class FakeSocket {
  readonly id = `sock-${nextSocketId++}`;
  data: { roomCode?: string; playerId?: string } = {};
  readonly handlers = new Map<string, Handler>();
  readonly received: Received[] = [];
  connected = true;

  constructor(private readonly io: FakeIo) {
    io.sockets.set(this.id, this);
  }

  // --- server-side API used by the engine ---
  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, payload: unknown): boolean {
    this.deliver(event, payload);
    return true;
  }

  to(room: string) {
    return {
      emit: (event: string, payload: unknown) => {
        for (const id of this.io.members.get(room) ?? []) {
          if (id !== this.id) this.io.sockets.get(id)?.deliver(event, payload);
        }
        return true;
      },
    };
  }

  join(room: string): void {
    if (!this.io.members.has(room)) this.io.members.set(room, new Set());
    this.io.members.get(room)!.add(this.id);
  }

  leave(room: string): void {
    this.io.members.get(room)?.delete(this.id);
  }

  deliver(event: string, payload: unknown): void {
    if (this.connected) this.received.push({ event, payload: clone(payload) });
  }

  asSocket(): GameSocket {
    return this as unknown as GameSocket;
  }

  // --- client-side helpers for tests ---
  send(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }

  request(event: string, payload: unknown): Promise<RoomJoinAck> {
    return new Promise((resolve) => this.send(event, payload, resolve));
  }

  disconnect(): void {
    this.connected = false;
    for (const set of this.io.members.values()) set.delete(this.id);
    this.send('disconnect', 'transport close');
    this.io.sockets.delete(this.id);
  }

  all(event: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.received.filter((r) => r.event === event).map((r) => r.payload);
  }

  last(event: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.all(event).at(-1);
  }
}

export const TEST_CARDS: MemoryCard[] = [
  { id: 'card-a', quote: 'the car is making the noise', date: '2025-06-01', people: ['Maya', 'Dev'], mood: 'chaotic', color: '#E85D04' },
  { id: 'card-b', quote: 'the library is closing', date: '2025-12-10', people: ['Maya', 'Dev'], mood: 'tense', color: '#4CC9F0' },
  { id: 'card-c', quote: 'i am a gardener now', date: '2026-03-02', people: ['Dev'], mood: 'proud', color: '#52B788' },
];

export function testWorld(overrides: Partial<WorldSchema> = {}): WorldSchema {
  return {
    title: 'Test Wood',
    intro: 'Once upon a time two friends walked into a test.',
    incantations: {
      ember: 'forty miles from anything',
      frost: 'the library is closing',
      bloom: 'i am a gardener now',
      storm: 'storm words',
      moon: 'moon words',
      starlight: 'starlight words',
    },
    encounters: [
      {
        memory: 'card-a',
        name: 'The Rusted Steed',
        template: 'charger',
        attacks: ['low_sweep', 'high_swing', 'projectile'],
        weakness: 'frost',
        tier: 1,
        lines: ['It charges!'],
        artPrompt: 'a rusted horse',
      },
    ],
    boss: {
      memory: 'card-b',
      name: 'The Night Librarian',
      template: 'guardian',
      attacks: ['high_swing', 'projectile', 'low_sweep'],
      weakness: 'ember',
      tier: 3,
      ward: 'twin_cast',
      lines: ['Shhh!'],
      artPrompt: 'a librarian',
    },
    ...overrides,
  };
}

export interface FakeAiOptions {
  world?: WorldSchema;
  generated?: WorldSchema;
  narrate?: (kind: string) => Promise<string>;
}

export function createFakeAi(opts: FakeAiOptions = {}): AiService & { narrated: string[]; generateCalls: number } {
  const world = opts.world ?? testWorld();
  const ai = {
    narrated: [] as string[],
    generateCalls: 0,
    listMemoryCards: () => TEST_CARDS,
    generateWorld: async () => {
      ai.generateCalls += 1;
      return opts.generated ?? world;
    },
    getCachedWorld: () => world,
    getCachedPicks: () => ({ encounterCardId: 'card-a', bossCardId: 'card-b' }),
    generateImages: async (_w: WorldSchema, onImage: (img: WorldImage) => void) => {
      onImage({ kind: 'cover', url: 'https://img.test/cover.png' });
      onImage({ kind: 'boss', url: 'https://img.test/boss.png' });
    },
    narrate: async (event: { kind: string }) => {
      ai.narrated.push(event.kind);
      return opts.narrate ? opts.narrate(event.kind) : `line:${event.kind}`;
    },
    muse: { available: false, complete: async () => null },
  };
  return ai;
}

export type PlanFn = (input: BossPlannerInput, deadlineMs: number) => Partial<BossPlan> | null | Promise<Partial<BossPlan> | null>;

/** A planner that records its inputs; by default it targets everyone with the enemy's first attack. */
export function createFakePlanner(fn?: PlanFn): BossPlanner & { inputs: BossPlannerInput[] } {
  const planner = {
    inputs: [] as BossPlannerInput[],
    planNextRound: async (input: BossPlannerInput, deadlineMs: number): Promise<BossPlan> => {
      planner.inputs.push(structuredClone(input));
      const custom = fn ? await fn(input, deadlineMs) : null;
      return {
        attackType: input.enemy.attacks[0] ?? 'low_sweep',
        targetPlayerIds: input.players.map((p) => p.id),
        defenseWindowMs: 1500,
        raiseWard: false,
        taunt: null,
        effects: [],
        source: 'agent',
        ...(custom ?? {}),
      } as BossPlan;
    },
  };
  return planner;
}

export function passed(phrase = 'words', overrides: Partial<TranscribeResponse> = {}): TranscribeResponse {
  return { transcript: phrase, expected: phrase, matchRatio: 1, passed: true, mercy: false, attempt: 1, power: 1, ...overrides };
}

export interface Harness {
  engine: Engine;
  io: FakeIo;
  ai: ReturnType<typeof createFakeAi>;
  planner: ReturnType<typeof createFakePlanner>;
  connect(): FakeSocket;
}

export function createHarness(
  opts: { ai?: FakeAiOptions; plan?: PlanFn; planner?: BossPlanner; engine?: EngineOptions } = {},
): Harness {
  const io = new FakeIo();
  const ai = createFakeAi(opts.ai);
  const planner = createFakePlanner(opts.plan);
  const engine = createEngine(
    { io: io.asServer(), ai, boss: opts.planner ?? planner },
    { rng: () => 0.5, log: () => undefined, ...opts.engine },
  );
  return {
    engine,
    io,
    ai,
    planner,
    connect() {
      const socket = new FakeSocket(io);
      engine.registerSocketHandlers(socket.asSocket());
      return socket;
    },
  };
}

/** Advances fake timers in small steps until the room reaches `phase` (or throws). */
export async function advanceUntil(
  engine: Engine,
  roomCode: string,
  predicate: GamePhase | ((phase: GamePhase) => boolean),
  advance: (ms: number) => Promise<unknown>,
  maxMs = 120_000,
  stepMs = 50,
): Promise<void> {
  const test = typeof predicate === 'string' ? (p: GamePhase) => p === predicate : predicate;
  for (let t = 0; t <= maxMs; t += stepMs) {
    const phase = engine.getState(roomCode)?.phase;
    if (phase && test(phase)) return;
    await advance(stepMs);
  }
  throw new Error(`room ${roomCode} never reached ${String(predicate)} (at ${engine.getState(roomCode)?.phase})`);
}
