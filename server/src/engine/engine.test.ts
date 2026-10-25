import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMBAT, DISCONNECT_PAUSE_MS, TAUNT_MAX_CHARS, TEAM_HEARTS_P0 } from '@once-upon/shared';
import type { CalibrationBaseline, GameState, RoundResolution, TelegraphPayload } from '@once-upon/shared';
import { advanceUntil, createHarness, passed, testWorld, type FakeSocket, type Harness, type PlanFn } from './test-helpers';

const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const baseline: CalibrationBaseline = { shoulderY: 0.3, shoulderWidth: 0.2, hipY: 0.6, centerX: 0.5, calibratedAt: 0 };

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

interface Table {
  h: Harness;
  code: string;
  a: FakeSocket;
  b: FakeSocket | null;
  maya: string;
  dev: string | null;
  state: () => GameState;
}

/** Quick start, seat Maya (and Dev), start, calibrate, and stop at the first telegraph. */
async function quickTable(
  opts: { solo?: boolean; plan?: PlanFn; world?: ReturnType<typeof testWorld>; harness?: Harness } = {},
): Promise<Table> {
  const h = opts.harness ?? createHarness({ plan: opts.plan, ai: { world: opts.world } });
  const a = h.connect();
  const ack = await a.request('room:quick_start', { playerName: 'Maya', role: 'spellbearer' });
  if (!ack.ok) throw new Error(ack.error);
  const code = ack.roomCode;
  let b: FakeSocket | null = null;
  let dev: string | null = null;
  if (!opts.solo) {
    b = h.connect();
    const joined = await b.request('room:join', { roomCode: code.toLowerCase(), playerName: 'Dev', role: 'partner' });
    if (!joined.ok) throw new Error(joined.error);
    dev = joined.playerId;
  }
  a.send('game:start');
  a.send('calibration:done', { baseline });
  b?.send('calibration:done', { baseline });
  await advanceUntil(h.engine, code, 'telegraph', adv);
  return { h, code, a, b, maya: ack.playerId, dev, state: () => h.engine.getState(code)! };
}

/** Plans that always aim `attackType` at the named players. */
function aimAt(names: string[], attackType: TelegraphPayload['attackType'] = 'low_sweep'): PlanFn {
  return (input) => ({
    attackType,
    targetPlayerIds: input.players.filter((p) => names.includes(p.name)).map((p) => p.id),
  });
}

function lastResolution(socket: FakeSocket): RoundResolution {
  return socket.last('combat:resolve') as RoundResolution;
}

describe('rooms', () => {
  it('uses unambiguous 4-letter codes, case-insensitive joins and reserved seats', async () => {
    const h = createHarness();
    const { roomCode, hostPlayerId } = await h.engine.createRoom({
      hostName: 'Maya',
      hostRole: 'spellbearer',
      playerNames: ['Dev'],
      difficulty: 'hard',
    });
    expect(roomCode).toMatch(/^[A-HJKMNP-Z]{4}$/);
    const state = h.engine.getState(roomCode.toLowerCase())!;
    expect(state.players.map((p) => [p.name, p.role, p.connected])).toEqual([
      ['Maya', 'spellbearer', false],
      ['Dev', 'partner', false],
    ]);

    const dev = h.connect();
    const ack = await dev.request('room:join', { roomCode: ` ${roomCode.toLowerCase()} `, playerName: 'dev', role: 'spellbearer' });
    expect(ack.ok && ack.playerId).toBe(state.players[1]!.id);
    const maya = h.connect();
    const mayaAck = await maya.request('room:join', { roomCode, playerName: 'Maya', role: 'spellbearer' });
    expect(mayaAck.ok && mayaAck.playerId).toBe(hostPlayerId);
    const full = await h.connect().request('room:join', { roomCode, playerName: 'Sam', role: 'partner' });
    expect(full).toEqual({ ok: false, error: 'Room is full' });

    expect(h.engine.getQuestStatus(roomCode)).toMatchObject({ roomCode, phase: 'lobby', hearts: TEAM_HEARTS_P0 });
    expect(h.engine.buildJoinLink(roomCode.toLowerCase(), 'Dev')).toContain(`room=${roomCode}&name=Dev`);
    expect(h.engine.getState('ZZZZ')).toBeNull();
    await expect(h.engine.createRoom({ hostName: 'X', hostRole: 'wizard' as never })).rejects.toThrow();
  });

  it('answers clock pings with server receive and send times', async () => {
    const h = createHarness();
    const s = h.connect();
    s.send('clock:ping', { clientSendMs: 42 });
    expect(s.last('clock:pong')).toEqual({ clientSendMs: 42, serverRecvMs: 1_000_000, serverSendMs: 1_000_000 });
  });
});

describe('opening flow', () => {
  it('lobby -> opening -> picks -> generation -> intro -> calibration', async () => {
    const h = createHarness();
    const a = h.connect();
    const ack = await a.request('room:create', { playerName: 'Maya', role: 'spellbearer' });
    if (!ack.ok) throw new Error(ack.error);
    const b = h.connect();
    await b.request('room:join', { roomCode: ack.roomCode, playerName: 'Dev', role: 'partner' });

    b.send('game:start'); // not the host
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('lobby');
    a.send('game:start');
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('opening');
    expect(b.last('memory:cards')).toHaveLength(3);

    a.send('opening:pick_card', { cardId: 'card-a', slot: 'encounter' });
    b.send('opening:pick_card', { cardId: 'card-c', slot: 'boss' });
    expect(h.engine.getState(ack.roomCode)!.picks).toEqual({ encounterCardId: 'card-a', bossCardId: 'card-c' });
    await adv(2_600);
    expect(h.ai.generateCalls).toBe(1);
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('intro');
    expect(b.all('world:image').map((i) => i.kind)).toEqual(['cover', 'boss']);
    expect(h.engine.getState(ack.roomCode)!.images).toEqual({
      cover: 'https://img.test/cover.png',
      boss: 'https://img.test/boss.png',
    });
    expect(b.all('narrator:line').map((l) => l.text)).toContain('Once upon a time two friends walked into a test.');

    await advanceUntil(h.engine, ack.roomCode, 'calibration', adv);
    a.send('calibration:done', { baseline });
    await adv(500);
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('calibration'); // still waiting on Dev
    b.send('calibration:done', { baseline });
    await adv(1_100);
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('telegraph');
  });

  it('auto-picks and generates when the opening times out', async () => {
    const h = createHarness();
    const a = h.connect();
    const ack = await a.request('room:create', { playerName: 'Maya', role: 'spellbearer' });
    if (!ack.ok) throw new Error(ack.error);
    a.send('game:start');
    await adv(60_100);
    const state = h.engine.getState(ack.roomCode)!;
    expect(state.picks).toEqual({ encounterCardId: 'card-a', bossCardId: 'card-b' });
    expect(state.phase).toBe('intro');
  });

  it('calibration times out after 15 s', async () => {
    const h = createHarness();
    const a = h.connect();
    const ack = await a.request('room:quick_start', { playerName: 'Maya', role: 'spellbearer' });
    if (!ack.ok) throw new Error(ack.error);
    a.send('game:start');
    await advanceUntil(h.engine, ack.roomCode, 'calibration', adv);
    await adv(14_900);
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('calibration');
    await adv(200);
    expect(h.engine.getState(ack.roomCode)!.phase).toBe('telegraph');
  });
});

describe('quick start', () => {
  it('loads the cached world and picks, skips generation, and seats a bot for a solo run', async () => {
    const h = createHarness();
    const a = h.connect();
    const ack = await a.request('room:quick_start', { playerName: 'Maya', role: 'partner' });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.state.phase).toBe('lobby');
    expect(ack.state.world?.title).toBe('Test Wood');
    expect(ack.state.picks).toEqual({ encounterCardId: 'card-a', bossCardId: 'card-b' });
    expect(a.data).toEqual({ roomCode: ack.roomCode, playerId: ack.playerId });

    a.send('game:start');
    const state = h.engine.getState(ack.roomCode)!;
    expect(state.phase).toBe('intro');
    expect(h.ai.generateCalls).toBe(0);
    expect(state.players.map((p) => [p.name, p.role])).toEqual([
      ['Maya', 'partner'],
      ['Wisp', 'bot'],
    ]);
    expect(state.currentEncounter?.name).toBe('The Rusted Steed');
    expect(state.enemyMaxHp).toBe(75);
  });
});

describe('combat round', () => {
  it('emits a telegraph scheduled in server time with the defense window', async () => {
    const t = await quickTable();
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    const state = t.state();
    expect(tele.impactServerMs).toBe(state.phaseEndsServerMs);
    expect(tele.windowMs).toBe(1500);
    expect(tele.targetPlayerIds.sort()).toEqual([t.maya, t.dev].sort());
    expect(tele.narratorHint).toMatch(/Maya and Dev, a low sweep/);
    await adv(tele.impactServerMs - Date.now());
    expect(t.state().phase).toBe('defense');
    expect(t.state().phaseEndsServerMs).toBe(tele.impactServerMs + tele.windowMs);
  });

  it('a targeted player with no dodge report loses a heart; a reported dodge is rebroadcast', async () => {
    const t = await quickTable();
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    t.a.send('player:dodge_result', { playerId: 'spoofed', attackId: tele.attackId, dodged: true, parried: false, serverTimestampMs: Date.now() });
    expect(t.b!.last('player:dodge_result')).toMatchObject({ playerId: t.maya, dodged: true });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    expect(t.state().hearts).toBe(TEAM_HEARTS_P0 - 1); // only Dev missed
    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(lastResolution(t.a)).toMatchObject({ heartsLost: 1, parries: 0, damageDealt: 0 });
    expect(t.state().lastResolution?.heartsLost).toBe(1);
    expect(t.a.all('hardware:command')).toContainEqual({ type: 'buzz', pattern: 'hit' });
  });

  it('a dodge report after the grace period counts as a miss', async () => {
    const t = await quickTable({ plan: aimAt(['Maya']) });
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    await adv(tele.impactServerMs - Date.now() + tele.windowMs + 600);
    t.a.send('player:dodge_result', { attackId: tele.attackId, dodged: true, parried: false, serverTimestampMs: Date.now() });
    expect(t.state().hearts).toBe(TEAM_HEARTS_P0 - 1);
  });

  it('a Spellbearer parry deals parry damage; a Partner "parry" only counts as a dodge', async () => {
    const t = await quickTable({ plan: aimAt(['Maya', 'Dev'], 'projectile') });
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    expect(tele.attackType).toBe('projectile');
    t.a.send('player:dodge_result', { attackId: tele.attackId, dodged: false, parried: true, serverTimestampMs: Date.now() });
    t.b!.send('player:dodge_result', { attackId: tele.attackId, dodged: false, parried: true, serverTimestampMs: Date.now() });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    expect(t.state().enemyHp).toBe(75 - COMBAT.parryDamage);
    expect(t.state().hearts).toBe(TEAM_HEARTS_P0);
    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(lastResolution(t.a)).toMatchObject({ parries: 1, damageDealt: COMBAT.parryDamage, heartsLost: 0 });
  });

  it('casts fizzle without a recorded incantation, and are dropped outside the team turn', async () => {
    const t = await quickTable({ plan: aimAt([]) });
    const cast = (s: FakeSocket, element: string) =>
      s.send('player:cast', { element, gesture: 'thrust', transcript: 'hi', power: 1, serverTimestampMs: Date.now() });

    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed('forty miles from anything'));
    cast(t.a, 'ember'); // telegraph: misfire, dropped
    expect(t.a.all('player:cast')).toHaveLength(0);

    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    cast(t.b!, 'ember'); // Dev never spoke
    expect(t.state().enemyHp).toBe(75);
    expect(t.a.all('narrator:line').length).toBeGreaterThan(0);
    await adv(10);
    expect(t.h.ai.narrated).toContain('fizzle');

    cast(t.a, 'ember'); // Maya's incantation from the telegraph is still fresh
    expect(t.b!.last('player:cast')).toMatchObject({ playerId: t.maya, element: 'ember', power: 1, transcript: 'forty miles from anything' });
    expect(t.state().enemyHp).toBe(65);
    cast(t.a, 'ember'); // one cast per turn
    expect(t.state().enemyHp).toBe(65);

    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(lastResolution(t.a)).toMatchObject({ fizzles: [t.dev], damageDealt: 10 });
  });

  it('an incantation older than about 15 s fizzles', async () => {
    const t = await quickTable({ plan: aimAt([]) });
    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed());
    await adv(16_000);
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    t.a.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.a.all('player:cast')).toHaveLength(0);
  });

  it('applies mercy power and clamps cast power to 0..2', async () => {
    const t = await quickTable({ plan: aimAt([]) });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed('x', { passed: false, mercy: true, power: 0.5 }));
    t.h.engine.recordIncantation(t.code, t.dev!, 'ember', passed());
    t.a.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1.5, serverTimestampMs: Date.now() - 5000 });
    expect(t.a.last('player:cast').power).toBe(0.75);
    // Dev's stamp is far from server time, so the server stamps it; 9 power clamps to 2.
    t.b!.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 9, serverTimestampMs: 1 });
    expect(t.a.last('player:cast')).toMatchObject({ power: 2, serverTimestampMs: Date.now() });
  });

  it('frost lengthens the next defense window; bloom heals up to the max', async () => {
    const t = await quickTable({ plan: aimAt(['Maya']) });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    expect(t.state().hearts).toBe(4);
    t.h.engine.recordIncantation(t.code, t.maya, 'frost', passed());
    t.h.engine.recordIncantation(t.code, t.dev!, 'bloom', passed());
    t.a.send('player:cast', { element: 'frost', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    t.b!.send('player:cast', { element: 'bloom', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.state().enemyHp).toBe(75 - 9); // frost on a frost-weak enemy
    expect(t.state().hearts).toBe(5);
    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(lastResolution(t.a)).toMatchObject({ heartsHealed: 1, damageDealt: 9 });
    await advanceUntil(t.h.engine, t.code, 'telegraph', adv);
    expect((t.a.last('combat:telegraph') as TelegraphPayload).windowMs).toBe(2000);
    expect(t.state().defenseWindowMs).toBe(2000);
  });

  it('players out of their zone at the team turn sit out', async () => {
    const t = await quickTable({ plan: aimAt([]) });
    t.a.send('player:pose', { landmarks: [], inZone: false, activeAction: 'none', confidence: 1, serverTimestampMs: Date.now() });
    expect(t.b!.last('player:pose')).toMatchObject({ playerId: t.maya, inZone: false });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    const maya = t.state().players.find((p) => p.id === t.maya)!;
    expect(maya.canCast).toBe(false);
    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed());
    t.a.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.a.all('player:cast')).toHaveLength(0);
    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(lastResolution(t.a).sittingOut).toEqual([t.maya]);
  });

  it('a twin cast on an encounter deals double damage and ends the turn early', async () => {
    const t = await quickTable({ plan: aimAt([]) });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed());
    t.h.engine.recordIncantation(t.code, t.dev!, 'ember', passed());
    t.a.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.b!.last('combat:twin_cast_progress')).toMatchObject({ castByPlayerIds: [t.maya], complete: false });
    await adv(1_000);
    t.b!.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.b!.last('combat:twin_cast_progress')).toMatchObject({ castByPlayerIds: [t.maya, t.dev], complete: true });
    expect(t.state().enemyHp).toBe(75 - 40);
    await adv(800);
    expect(t.state().phase).toBe('resolve');
    expect(lastResolution(t.a)).toMatchObject({ twinCast: true, wardShattered: false, damageDealt: 40 });
  });
});

describe('boss ward', () => {
  const bossOnly = testWorld({ encounters: [] });

  it('rises below half HP; only a twin cast hurts it, shatters it and opens the servo', async () => {
    const t = await quickTable({ plan: aimAt([]), world: bossOnly });
    expect(t.state().fightingBoss).toBe(true);
    expect(t.state().enemyMaxHp).toBe(160);
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    expect(t.state().wardActive).toBe(false);
    t.h.engine.debugRoom(t.code)!.state.enemyHp = 70; // planner already saw full HP: a stale "no ward"
    await advanceUntil(t.h.engine, t.code, 'telegraph', adv);
    expect(t.state()).toMatchObject({ wardActive: true, wardSpell: 'twin_cast' });
    await adv(10);
    expect(t.h.ai.narrated).toContain('ward_raised');

    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed());
    t.h.engine.recordIncantation(t.code, t.dev!, 'ember', passed());
    t.a.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.state().enemyHp).toBe(70); // blocked by the ward
    t.b!.send('player:cast', { element: 'ember', gesture: 'thrust', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(t.state().wardActive).toBe(false);
    expect(t.state().enemyHp).toBe(10); // 2 x (15 + 15)
    expect(t.a.all('hardware:command')).toContainEqual({ type: 'servo', servoOpen: true });
    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(lastResolution(t.a)).toMatchObject({ twinCast: true, wardShattered: true, damageDealt: 60 });

    // Only once per boss fight.
    await advanceUntil(t.h.engine, t.code, 'telegraph', adv);
    expect(t.state().wardActive).toBe(false);
  });

  it('blocks parry damage while up', async () => {
    const t = await quickTable({
      world: bossOnly,
      plan: (input) => ({
        attackType: 'projectile',
        targetPlayerIds: input.players.filter((p) => p.name === 'Maya').map((p) => p.id),
        raiseWard: true,
      }),
    });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    t.h.engine.debugRoom(t.code)!.state.enemyHp = 70;
    await advanceUntil(t.h.engine, t.code, 'telegraph', adv);
    expect(t.state().wardActive).toBe(true);
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    t.a.send('player:dodge_result', { attackId: tele.attackId, dodged: true, parried: true, serverTimestampMs: Date.now() });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    expect(t.state().enemyHp).toBe(70);
  });
});

describe('boss planner', () => {
  it('re-clamps a bad plan: attack, targets, window, ward, taunt and effects', async () => {
    const t = await quickTable({
      plan: () => ({
        attackType: 'stare',
        targetPlayerIds: ['ghost'],
        defenseWindowMs: 9_999,
        raiseWard: true,
        taunt: `Dev, you always step left. ${'Ha! '.repeat(60)}`,
        effects: ['servo_open', 'hit'],
      }),
    });
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    expect(['low_sweep', 'high_swing', 'projectile']).toContain(tele.attackType);
    expect(tele.attackType).not.toBe('stare');
    expect(tele.targetPlayerIds).toHaveLength(1);
    expect([t.maya, t.dev]).toContain(tele.targetPlayerIds[0]);
    expect(tele.windowMs).toBe(2000);
    expect(t.state().wardActive).toBe(false);
    const taunt = t.a.all('narrator:line').find((l) => l.speaker === 'boss');
    expect(taunt.text.length).toBeLessThanOrEqual(TAUNT_MAX_CHARS);
    expect(taunt.text.startsWith('Dev, you always step left.')).toBe(true);
    expect(t.a.all('hardware:command')).toEqual(
      expect.arrayContaining([
        { type: 'servo', servoOpen: true },
        { type: 'buzz', pattern: 'hit' },
      ]),
    );
  });

  it('falls back to the scripted cycle when the planner hangs or throws', async () => {
    const hang = createHarness({
      planner: { planNextRound: () => new Promise(() => undefined) },
    });
    const t = await quickTable({ harness: hang });
    expect((t.a.last('combat:telegraph') as TelegraphPayload).attackType).toBe('low_sweep');
    await advanceUntil(t.h.engine, t.code, (p) => p === 'telegraph' && t.state().roundIndex === 1, adv);
    expect((t.a.last('combat:telegraph') as TelegraphPayload).attackType).toBe('high_swing');

    const thrower = createHarness({
      planner: {
        planNextRound: () => {
          throw new Error('boom');
        },
      },
    });
    const t2 = await quickTable({ harness: thrower });
    expect((t2.a.last('combat:telegraph') as TelegraphPayload).attackType).toBe('low_sweep');
  });

  it('builds planner input from dodge history and recent elements', async () => {
    const t = await quickTable({ plan: aimAt(['Maya', 'Dev']) });
    const tele = t.a.last('combat:telegraph') as TelegraphPayload;
    await adv(tele.impactServerMs - Date.now() + 200);
    t.a.send('player:pose', { landmarks: [], inZone: false, activeAction: 'side_step_left', confidence: 1, serverTimestampMs: Date.now() });
    t.a.send('player:dodge_result', { attackId: tele.attackId, dodged: true, parried: false, serverTimestampMs: Date.now() });
    t.a.send('player:pose', { landmarks: [], inZone: true, activeAction: 'none', confidence: 1, serverTimestampMs: Date.now() });
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed());
    t.a.send('player:cast', { element: 'ember', gesture: 'swipe', transcript: '', power: 1, serverTimestampMs: Date.now() });
    await advanceUntil(t.h.engine, t.code, (p) => p === 'team_turn' && t.state().roundIndex === 1, adv);
    const input = t.h.planner.inputs.at(-1)!;
    expect(input.roundIndex).toBe(2);
    expect(input.dodgeHistory[t.maya]).toEqual([
      { roundIndex: 0, attackType: 'low_sweep', dodged: true, parried: false, direction: 'left' },
      { roundIndex: 1, attackType: 'low_sweep', dodged: false, parried: false, direction: null },
    ]);
    expect(input.dodgeHistory[t.dev!]).toHaveLength(2);
    expect(input.recentElements).toEqual(['ember']);
    expect(input.players.map((p) => p.name)).toEqual(['Maya', 'Dev']);
    expect(input.wardRaisedThisPhase).toBe(false);
  });
});

describe('disconnect, pause and bot', () => {
  it('pauses on disconnect, seats a bot after the pause, and lets the human reclaim the seat', async () => {
    const t = await quickTable({ plan: aimAt(['Dev']) });
    t.b!.disconnect();
    expect(t.state()).toMatchObject({ paused: true, pausedReason: 'Dev disconnected', phase: 'telegraph' });
    await adv(DISCONNECT_PAUSE_MS - 100);
    expect(t.state().phase).toBe('telegraph');
    await adv(200);
    const dev = t.state().players.find((p) => p.id === t.dev)!;
    expect(dev).toMatchObject({ role: 'bot', connected: true, inZone: true, name: 'Dev' });
    expect(t.state().paused).toBe(false);

    // The bot answers the replayed round and casts in the team turn.
    await advanceUntil(t.h.engine, t.code, 'resolve', adv);
    expect(t.a.all('player:dodge_result').some((d) => d.playerId === t.dev)).toBe(true);
    expect(t.a.all('player:cast').some((c) => c.playerId === t.dev)).toBe(true);

    const back = t.h.connect();
    const ack = await back.request('room:join', { roomCode: t.code, playerName: 'Dev', role: 'partner' });
    expect(ack.ok && ack.playerId).toBe(t.dev);
    expect(t.state().players.find((p) => p.id === t.dev)).toMatchObject({ role: 'partner', connected: true });
  });

  it('resumes without a bot when the player is back within the pause', async () => {
    const t = await quickTable();
    await advanceUntil(t.h.engine, t.code, 'team_turn', adv);
    const endsBefore = t.state().phaseEndsServerMs!;
    t.b!.disconnect();
    await adv(3_000);
    expect(t.state().phase).toBe('team_turn');
    const back = t.h.connect();
    await back.request('room:join', { roomCode: t.code, playerName: 'Dev', role: 'partner' });
    expect(t.state().paused).toBe(false);
    expect(t.state().players.find((p) => p.id === t.dev)!.role).toBe('partner');
    expect(t.state().phaseEndsServerMs!).toBeGreaterThan(endsBefore);
  });

  it('clears every timer when the room empties, and on dispose', async () => {
    const t = await quickTable();
    t.a.disconnect();
    t.b!.disconnect();
    expect(t.state().paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const t2 = await quickTable();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    t2.h.engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('full run', () => {
  /** Maya dodges every attack and casts ember (twin with the bot behind the ward). */
  async function play(t: Table, dodge: boolean): Promise<void> {
    let lastAttack = '';
    for (let i = 0; i < 4_000 && t.state().phase !== 'ending'; i++) {
      const tele = t.a.last('combat:telegraph') as TelegraphPayload | undefined;
      if (dodge && tele && tele.attackId !== lastAttack) {
        lastAttack = tele.attackId;
        t.a.send('player:dodge_result', { attackId: tele.attackId, dodged: true, parried: false, serverTimestampMs: Date.now() });
      }
      if (t.state().phase === 'team_turn' && !t.a.all('player:cast').some((c) => c.serverTimestampMs >= (t.state().phaseEndsServerMs ?? 0) - 8000)) {
        t.h.engine.recordIncantation(t.code, t.maya, 'ember', passed());
        t.a.send('player:cast', { element: 'ember', gesture: 'thrust', transcript: '', power: 1.2, serverTimestampMs: Date.now() });
      }
      await adv(100);
    }
  }

  it('a solo player and the bot reach a happy ending', async () => {
    const t = await quickTable({ solo: true });
    await play(t, true);
    expect(t.state().phase).toBe('ending');
    expect(t.state().hearts).toBeGreaterThan(0);
    expect(t.state().fightingBoss).toBe(true);
    expect(t.state().enemyHp).toBe(0);
    const resolutions = t.a.all('combat:resolve') as RoundResolution[];
    expect(resolutions.some((r) => r.wardShattered)).toBe(true);
    await adv(2_000);
    expect(t.h.ai.narrated).toContain('victory');
  });

  it('the tale ends early when the hearts run out', async () => {
    const t = await quickTable({ plan: aimAt(['Maya']) });
    await advanceUntil(t.h.engine, t.code, 'ending', adv, 200_000);
    expect(t.state().hearts).toBe(0);
    expect(t.state().roundIndex).toBe(4); // 5 hearts, one per round
    await adv(2_000);
    expect(t.h.ai.narrated).toContain('defeat');
  });
});
