import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import type { MemoryCard, QuestStatus } from '@once-upon/shared';
import type { CreateRoomOptions, MuseChat, MuseChatRequest, ServerContext } from '../contracts';
import { createRateLimiter, parseQuestPrompt, runQuestChat } from './quest-chat';
import { executeQuestTool, questToolsForMuse } from './quest-tools';

const CARDS: MemoryCard[] = [
  { id: 'card-roadtrip', quote: 'the car is making the noise again', date: '2025-07-12', people: [], mood: 'chaotic', color: '#E85D04' },
];

function fakeCtx(complete?: MuseChat['complete']) {
  const created: CreateRoomOptions[] = [];
  const codes = new Set<string>();
  const ctx = {
    ai: {
      listMemoryCards: () => CARDS,
      muse: { available: Boolean(complete), complete: complete ?? (async () => null) },
    },
    rooms: {
      createRoom: vi.fn(async (opts: CreateRoomOptions) => {
        created.push(opts);
        const roomCode = `R${String(created.length).padStart(3, '0')}`;
        codes.add(roomCode);
        return { roomCode, hostPlayerId: 'host' };
      }),
      getQuestStatus: (code: string): QuestStatus | null =>
        codes.has(code.toUpperCase())
          ? { roomCode: code.toUpperCase(), phase: 'lobby', hearts: 5, maxHearts: 5, enemyName: null, enemyHp: 0, enemyMaxHp: 0, wardActive: false }
          : null,
      buildJoinLink: (code: string, name?: string) =>
        `https://game.test/?room=${code}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    },
  } as unknown as ServerContext;
  return { ctx, created };
}

function toolReply(name: string, args: string): ChatCompletionMessage {
  return {
    role: 'assistant',
    content: null,
    refusal: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
  } as ChatCompletionMessage;
}

function textReply(content: string): ChatCompletionMessage {
  return { role: 'assistant', content, refusal: null } as ChatCompletionMessage;
}

describe('parseQuestPrompt', () => {
  it.each([
    ['Set up a quest for me and Dev, make it hard', undefined, ['Spellbearer', 'Dev'], 'hard'],
    ['Set up a quest for me and Dev, make it hard', 'Maya', ['Maya', 'Dev'], 'hard'],
    ['Start an easy quest with Dev, Sam and Priya', undefined, ['Spellbearer', 'Dev', 'Sam', 'Priya'], 'easy'],
    ["Hi, I'm Maya. Make a quest for Dev and me", undefined, ['Maya', 'Dev'], 'normal'],
    ['Hey Muse, can you start a quest for Dev? Thanks!', undefined, ['Spellbearer', 'Dev'], 'normal'],
    ['A brutal quest with Ana, Bo, Cy, Di and Ed', undefined, ['Spellbearer', 'Ana', 'Bo', 'Cy'], 'hard'],
    ['quest for me please', undefined, ['Spellbearer'], 'normal'],
    ["Dev's and my quest, with Dev. Hard mode", undefined, ['Spellbearer', 'Dev'], 'hard'],
  ])('%s (host %s)', (prompt, host, names, difficulty) => {
    expect(parseQuestPrompt(prompt, host)).toEqual({ playerNames: names, difficulty });
  });
});

describe('runQuestChat', () => {
  it('uses the deterministic parser when Muse is unavailable', async () => {
    const { ctx, created } = fakeCtx();
    const res = await runQuestChat(ctx, 'Set up a quest for me and Dev, make it hard');
    expect(created).toEqual([
      { hostName: 'Spellbearer', hostRole: 'spellbearer', difficulty: 'hard', encounterCardId: undefined, playerNames: ['Dev'] },
    ]);
    expect(res.roomCode).toBe('R001');
    expect(res.joinLink).toBe('https://game.test/?room=R001&name=Spellbearer');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({
      name: 'create_quest',
      args: { difficulty: 'hard', player_names: ['Spellbearer', 'Dev'] },
    });
    expect(res.reply).toContain('R001');
    expect(res.reply).toContain('https://game.test/?room=R001&name=Dev');
  });

  it('runs the Muse tool loop with the shared tools', async () => {
    const requests: MuseChatRequest[] = [];
    const replies = [
      toolReply('create_quest', JSON.stringify({ difficulty: 'hard', player_names: ['Maya', 'Dev'], encounter_card_id: 'card-roadtrip' })),
      textReply('Your hard quest awaits in room R001!'),
    ];
    const { ctx, created } = fakeCtx(async (req) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      return replies.shift() ?? null;
    });
    const res = await runQuestChat(ctx, "I'm Maya, set up a quest for me and Dev, make it hard");
    expect(created[0]).toMatchObject({ hostName: 'Maya', difficulty: 'hard', encounterCardId: 'card-roadtrip', playerNames: ['Dev'] });
    expect(res).toMatchObject({
      reply: 'Your hard quest awaits in room R001!',
      roomCode: 'R001',
      joinLink: 'https://game.test/?room=R001&name=Maya',
    });
    expect(res.toolCalls.map((c) => c.name)).toEqual(['create_quest']);
    expect(requests[0]?.tools?.map((t) => (t.type === 'function' ? t.function.name : ''))).toEqual([
      'list_memory_cards',
      'create_quest',
      'invite_player',
      'get_quest_status',
    ]);
    // Second call carries the tool result back to Muse.
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('stops after 4 tool iterations', async () => {
    const complete = vi.fn(async () => toolReply('list_memory_cards', '{}'));
    const { ctx } = fakeCtx(complete);
    const res = await runQuestChat(ctx, 'Quest for me and Dev');
    expect(complete).toHaveBeenCalledTimes(4);
    // Listing cards alone does not answer the request, so the parser creates the room.
    expect(res.toolCalls.map((c) => c.name)).toEqual([
      'list_memory_cards',
      'list_memory_cards',
      'list_memory_cards',
      'list_memory_cards',
      'create_quest',
    ]);
    expect(res.roomCode).toBe('R001');
  });

  it('falls back when Muse sends malformed arguments or fails', async () => {
    const replies: (ChatCompletionMessage | null)[] = [toolReply('create_quest', '{"player_names": ["Ma'), null];
    const { ctx, created } = fakeCtx(async () => replies.shift() ?? null);
    const res = await runQuestChat(ctx, 'Make an easy quest with Dev');
    expect(res.toolCalls[0]).toMatchObject({ name: 'create_quest', result: { error: expect.any(String) } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ hostName: 'Spellbearer', difficulty: 'easy', playerNames: ['Dev'] });
    expect(res.roomCode).toBe('R001');
  });
});

describe('quest tools', () => {
  it('rejects unknown cards and rooms with a helpful error', async () => {
    const { ctx } = fakeCtx();
    const bad = await executeQuestTool(ctx, 'create_quest', { player_names: ['Maya'], encounter_card_id: 'nope' });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('card-roadtrip') });
    expect(await executeQuestTool(ctx, 'invite_player', { room_code: 'ZZZZ', player_name: 'Dev' })).toMatchObject({ ok: false });
    expect(await executeQuestTool(ctx, 'create_quest', { player_names: [] })).toMatchObject({ ok: false });
    expect(await executeQuestTool(ctx, 'create_quest', { player_names: ['a', 'b', 'c', 'd', 'e'] })).toMatchObject({ ok: false });
  });

  it('dedupes names and returns a join link per player', async () => {
    const { ctx, created } = fakeCtx();
    const res = await executeQuestTool(ctx, 'create_quest', { player_names: ['  Maya ', 'maya', 'Dev'] });
    expect(created[0]).toMatchObject({ hostName: 'Maya', difficulty: 'normal', playerNames: ['Dev'] });
    expect(res.ok && res.data.players).toEqual([
      { playerName: 'Maya', joinLink: 'https://game.test/?room=R001&name=Maya' },
      { playerName: 'Dev', joinLink: 'https://game.test/?room=R001&name=Dev' },
    ]);
  });

  it('exposes OpenAI function schemas without $schema', () => {
    const tools = questToolsForMuse();
    expect(tools).toHaveLength(4);
    for (const t of tools) expect(t.function.parameters).not.toHaveProperty('$schema');
    expect(tools[1]!.function.parameters).toMatchObject({ required: ['player_names'] });
  });
});

describe('createRateLimiter', () => {
  it('allows 10 hits per minute per key', () => {
    const limiter = createRateLimiter(10, 60_000);
    for (let i = 0; i < 10; i++) expect(limiter.hit('1.2.3.4', 1000 + i)).toBe(true);
    expect(limiter.hit('1.2.3.4', 2000)).toBe(false);
    expect(limiter.hit('5.6.7.8', 2000)).toBe(true);
    expect(limiter.hit('1.2.3.4', 61_000)).toBe(true);
  });
});
