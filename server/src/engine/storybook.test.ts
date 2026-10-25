import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState } from '@once-upon/shared';
import { storybookRoom, toStorybookPhase, type StorybookGameState } from './storybook';
import { advanceUntil, createHarness, passed, type FakeSocket } from './test-helpers';

const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Storybook clients emit room events without an ack. */
function storybookJoin(socket: FakeSocket, event: string, payload: Record<string, unknown>): void {
  socket.send(event, payload);
}

const sbState = (socket: FakeSocket) => socket.last('room:state') as StorybookGameState;

describe('storybook client contract', () => {
  it('creates a full singleplayer adventure and rejects extra human seats', async () => {
    const h = createHarness();
    const host = h.connect();
    storybookJoin(host, 'room:create', { playerName: 'Maya', role: 'spellbearer', mode: 'singleplayer' });
    await adv(0);
    const state = sbState(host);
    expect(state.phase).toBe('upload');
    expect(state.quickStart).toBe(false);
    expect(h.engine.debugRoom(state.roomCode)?.singleplayer).toBe(true);
    const guest = h.connect();
    storybookJoin(guest, 'room:join', { code: state.roomCode, playerName: 'Dev', role: 'spellbearer' });
    expect(guest.last('room:error')).toEqual({ message: 'This is a singleplayer adventure. Create an online adventure to play together.' });
    expect(guest.all('room:joined')).toHaveLength(0);
  });

  it('answers an ack-less create with room:joined, then storybook-shaped state on its own channel', async () => {
    const h = createHarness();
    const sb = h.connect();
    storybookJoin(sb, 'room:create', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);

    expect(sb.received[0]).toMatchObject({ event: 'room:joined' });
    const playerId = (sb.received[0]!.payload as { playerId: string }).playerId;
    const state = sbState(sb);
    expect(state).toMatchObject({ phase: 'upload', combatPhase: 'idle', teamHearts: 5, maxTeamHearts: 5, wardUp: false, quickStart: false });
    expect(state.players).toEqual([expect.objectContaining({ id: playerId, name: 'Maya', role: 'spellbearer' })]);
    expect(sb.data).toMatchObject({ storybook: true, roomCode: state.roomCode });
    expect(h.io.members.get(storybookRoom(state.roomCode))?.has(sb.id)).toBe(true);
    expect(h.io.members.get(state.roomCode)?.has(sb.id) ?? false).toBe(false);

    // A shared-contract client in the same room keeps the shared shape.
    const shared = h.connect();
    const ack = await shared.request('room:join', { roomCode: state.roomCode, playerName: 'Dev', role: 'partner' });
    expect(ack.ok).toBe(true);
    expect((shared.last('room:state') as GameState).hearts).toBe(5);
    expect(sbState(sb).players.map((p) => p.role)).toEqual(['spellbearer', 'spellbearer']);
  });

  it('joins by `code`, and reports a missing room with room:error', async () => {
    const h = createHarness();
    const host = h.connect();
    storybookJoin(host, 'room:create', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);
    const code = sbState(host).roomCode;

    const guest = h.connect();
    storybookJoin(guest, 'room:join', { code: code.toLowerCase(), playerName: 'Dev', role: 'spellbearer' });
    expect(guest.all('room:joined')).toHaveLength(1);
    expect(sbState(guest).players).toHaveLength(2);

    const lost = h.connect();
    storybookJoin(lost, 'room:join', { code: 'ZZZZ', playerName: 'Ann', role: 'spellbearer' });
    expect(lost.last('room:error')).toEqual({ message: 'Room not found' });
  });

  it('plays from the upload page to combat through room:advance and the storybook card events', async () => {
    const h = createHarness();
    const sb = h.connect();
    storybookJoin(sb, 'room:create', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);
    const code = sbState(sb).roomCode;
    const me = (sb.all('room:joined')[0] as { playerId: string }).playerId;

    sb.send('room:advance', { phase: 'opening' });
    expect(sbState(sb).phase).toBe('opening');
    expect(sbState(sb).memoryCards.map((c) => c.id)).toEqual(['card-a', 'card-b', 'card-c']);

    sb.send('opening:select_card', { cardId: 'card-a' });
    sb.send('opening:lock_boss', { cardId: 'card-b' });
    expect(sbState(sb)).toMatchObject({ selectedMemoryIds: ['card-a', 'card-b'], bossMemoryId: 'card-b' });

    sb.send('room:advance', { phase: 'intro' });
    expect(['generating', 'intro']).toContain(sbState(sb).phase);
    await advanceUntil(h.engine, code, 'intro', adv);
    const intro = sbState(sb);
    expect(intro.phase).toBe('intro');
    expect(intro.world).toMatchObject({ title: 'Test Wood', coverArtUrl: 'https://img.test/cover.png' });
    expect(intro.world!.boss).toMatchObject({ name: 'The Night Librarian', ward: 'twin_cast', art_prompt: 'a librarian' });
    expect(intro.narratorCaption).toBe('Once upon a time two friends walked into a test.');

    // The intro waits for its narration instead of the usual 5-20 s timer...
    await adv(30_000);
    expect(sbState(sb).phase).toBe('intro');
    // ...until the client reports the narration finished (or Continue).
    sb.send('room:advance', { phase: 'calibrating' });
    expect(sbState(sb).phase).toBe('calibrating');
    // A missing camera must not time out into combat. Repeated pose frames must not
    // keep postponing the one-second ready timer.
    await adv(20_000);
    expect(sbState(sb).phase).toBe('calibrating');
    for (let i = 0; i < 20; i++) {
      sb.send('player:pose', { landmarks: [], inZone: true });
      await adv(75);
    }
    await advanceUntil(h.engine, code, 'telegraph', adv, 5_000);
    const fight = sbState(sb);
    expect(fight).toMatchObject({ phase: 'encounter', combatPhase: 'telegraph' });
    expect(fight.encounter).toMatchObject({ name: 'The Rusted Steed · minions', hp: fight.encounter!.maxHp });
    expect(sb.last('combat:telegraph')).toMatchObject({ attackType: expect.any(String), windowMs: expect.any(Number) });

    sb.send('player:dodge_result', { attackId: sb.last('combat:telegraph').attackId, dodged: true, parried: false, serverTimestampMs: Date.now() });
    await advanceUntil(h.engine, code, 'team_turn', adv);
    h.engine.recordIncantation(code, me, 'frost', passed());
    sb.send('player:cast', { element: 'frost', gesture: 'thrust', transcript: '', power: 1, serverTimestampMs: Date.now() });
    expect(sb.last('player:cast')).toMatchObject({ playerId: me, element: 'frost' });
    expect(sbState(sb).combatPhase).toBe('team_turn');
    // The calibrated pose keeps the player in the casting zone.
    expect(sbState(sb).players.find((p) => p.id === me)).toMatchObject({ inZone: true });
  });

  it('teaches all three defenses in one minion stage, then goes directly to the boss', async () => {
    const h = createHarness();
    const sb = h.connect();
    storybookJoin(sb, 'room:quick_start', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);
    const code = sbState(sb).roomCode;
    const me = sb.data.playerId!;
    sb.send('room:advance', { phase: 'intro' });
    await advanceUntil(h.engine, code, 'intro', adv);
    sb.send('room:advance', { phase: 'calibrating' });
    sb.send('player:pose', { landmarks: [], inZone: true });
    for (const expected of ['low_sweep', 'high_swing', 'projectile']) {
      await advanceUntil(h.engine, code, 'telegraph', adv);
      const attack = sb.last('combat:telegraph');
      expect(attack.attackType).toBe(expected);
      sb.send('player:dodge_result', { attackId: attack.attackId, dodged: true, parried: false, serverTimestampMs: Date.now() });
      await advanceUntil(h.engine, code, 'team_turn', adv);
      h.engine.debugRoom(code)!.state.enemyHp = 1;
      h.engine.recordIncantation(code, me, 'ember', passed());
      sb.send('player:cast', { element: 'ember', gesture: 'thrust', power: 1, serverTimestampMs: Date.now() });
      if (expected !== 'projectile') expect(h.engine.getState(code)!.enemyHp).toBe(1);
      await advanceUntil(h.engine, code, 'resolve', adv);
    }
    await advanceUntil(h.engine, code, 'intro', adv);
    expect(h.engine.getState(code)!.fightingBoss).toBe(true);
    h.engine.dispose();
  });

  it('keeps several cards like the client, and crowning a kept card falls back to another for the encounter', async () => {
    const h = createHarness();
    const sb = h.connect();
    storybookJoin(sb, 'room:create', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);
    const code = sbState(sb).roomCode;
    sb.send('room:advance', { phase: 'opening' });
    // Clicking a card keeps it, so focusing the future boss keeps it too.
    sb.send('opening:select_card', { cardId: 'card-a' });
    sb.send('opening:select_card', { cardId: 'card-b' });
    sb.send('opening:lock_boss', { cardId: 'card-b' });
    expect(h.engine.debugRoom(code)!.state.picks).toEqual({ encounterCardId: 'card-a', bossCardId: 'card-b' });
    expect(sbState(sb)).toMatchObject({ selectedMemoryIds: ['card-a', 'card-b'], bossMemoryId: 'card-b' });
    // Keeping the crowned card again does not un-crown it.
    sb.send('opening:select_card', { cardId: 'card-b' });
    expect(h.engine.debugRoom(code)!.state.picks).toEqual({ encounterCardId: 'card-a', bossCardId: 'card-b' });
  });

  it('still ends a held intro after the safety cap', async () => {
    const h = createHarness();
    const sb = h.connect();
    storybookJoin(sb, 'room:quick_start', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);
    const code = sbState(sb).roomCode;
    sb.send('room:advance', { phase: 'opening' });
    await advanceUntil(h.engine, code, 'intro', adv);
    await advanceUntil(h.engine, code, 'calibration', adv, 100_000, 1_000);
    expect(sbState(sb).phase).toBe('calibrating');
  });

  it('keeps the timed intro for shared-contract rooms', async () => {
    const h = createHarness();
    const a = h.connect();
    const ack = await a.request('room:quick_start', { playerName: 'Maya', role: 'spellbearer' });
    if (!ack.ok) throw new Error(ack.error);
    a.send('game:start');
    await advanceUntil(h.engine, ack.roomCode, 'calibration', adv, 21_000);
  });

  it('ignores room:advance requests the engine cannot honor', async () => {
    const h = createHarness();
    const sb = h.connect();
    storybookJoin(sb, 'room:create', { playerName: 'Maya', role: 'spellbearer' });
    await adv(0);
    sb.send('room:advance', { phase: 'ending' });
    sb.send('room:advance', { phase: 'boss' });
    sb.send('room:advance', {});
    expect(sbState(sb).phase).toBe('upload');
  });

  it('maps engine phases onto storybook screens', () => {
    const base = { phase: 'ending', hearts: 3, fightingBoss: true, roundIndex: 4 } as GameState;
    expect(toStorybookPhase(base, false)).toBe('ending');
    expect(toStorybookPhase({ ...base, hearts: 0 }, false)).toBe('defeat');
    expect(toStorybookPhase({ ...base, phase: 'opening' }, true)).toBe('generating');
    expect(toStorybookPhase({ ...base, phase: 'intro' }, false)).toBe('boss');
    expect(toStorybookPhase({ ...base, phase: 'intro', fightingBoss: false, roundIndex: 0 }, false)).toBe('intro');
    expect(toStorybookPhase({ ...base, phase: 'resolve', fightingBoss: false }, false)).toBe('encounter');
  });
});
