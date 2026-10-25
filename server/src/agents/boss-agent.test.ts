import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import { BOSS_AGENT_DEADLINE_MS, DEFENSE_WINDOW_MS, TAUNT_MAX_CHARS } from '@once-upon/shared';
import type { AiService, MuseChat, MuseChatRequest } from '../contracts';
import {
  BOSS_EFFECT_NAMES,
  buildBossTools,
  buildBossUserMessage,
  canRaiseWard,
  clampDefenseWindow,
  cleanTaunt,
  createBossPlanner,
  mergeAgentPlan,
  scriptedPlan,
  summarizeHabits,
  validateToolCall,
} from './boss-agent';
import { DEV, MAYA, STEED, dodges, makeBossInput } from './boss-fixtures';

function reply(calls: { name: string; arguments: string }[]): ChatCompletionMessage {
  return {
    role: 'assistant',
    content: null,
    refusal: null,
    tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: c })),
  } as ChatCompletionMessage;
}

function fakeAi(complete: MuseChat['complete'], available = true): AiService {
  return { muse: { available, complete } } as unknown as AiService;
}

const call = (name: string, args: unknown) => ({ name, arguments: JSON.stringify(args) });

afterEach(() => {
  vi.useRealTimers();
});

describe('validateToolCall', () => {
  const input = makeBossInput();

  it('accepts only patterns from the enemy attacks', () => {
    expect(validateToolCall(call('choose_attack', { pattern: 'high_swing', targets: [DEV.id] }), input)).toEqual({
      name: 'choose_attack',
      args: { pattern: 'high_swing', targets: [DEV.id] },
    });
    expect(validateToolCall(call('choose_attack', { pattern: 'stare', targets: [DEV.id] }), input)).toBeNull();
    expect(validateToolCall(call('choose_attack', { pattern: 'laser', targets: [DEV.id] }), input)).toBeNull();
  });

  it('filters targets to real players, maps names, and never returns empty', () => {
    const v = validateToolCall(
      call('choose_attack', { pattern: 'projectile', targets: ['ghost', 'dev', DEV.id, 42] }),
      input,
    );
    expect(v).toEqual({ name: 'choose_attack', args: { pattern: 'projectile', targets: [DEV.id] } });

    const empty = validateToolCall(call('choose_attack', { pattern: 'projectile', targets: ['nobody'] }), input);
    expect(empty?.name).toBe('choose_attack');
    if (empty?.name === 'choose_attack') expect(empty.args.targets.length).toBe(1);

    const missing = validateToolCall(call('choose_attack', { pattern: 'projectile' }), input);
    if (missing?.name === 'choose_attack') expect(missing.args.targets.length).toBeGreaterThan(0);
  });

  it('clamps adjust_timing into DEFENSE_WINDOW_MS', () => {
    const ms = (v: unknown) => {
      const r = validateToolCall(call('adjust_timing', { ms: v }), input);
      return r?.name === 'adjust_timing' ? r.args.ms : null;
    };
    expect(ms(100)).toBe(DEFENSE_WINDOW_MS.min);
    expect(ms(99_999)).toBe(DEFENSE_WINDOW_MS.max);
    expect(ms(1234.6)).toBe(1235);
    expect(ms('1800')).toBe(1800);
    expect(ms('soon')).toBeNull();
    expect(ms(Number.NaN)).toBeNull();
  });

  it('keeps the window at or above the default while easing off at 1 heart', () => {
    const lastHeart = makeBossInput({ hearts: 1 });
    const r = validateToolCall(call('adjust_timing', { ms: 1000 }), lastHeart);
    expect(r).toEqual({ name: 'adjust_timing', args: { ms: DEFENSE_WINDOW_MS.default } });
    expect(clampDefenseWindow(1900, lastHeart)).toBe(1900);
  });

  it('truncates taunts to TAUNT_MAX_CHARS and drops empty ones', () => {
    const long = 'The Night Librarian '.repeat(20);
    const r = validateToolCall(call('taunt', { line: long }), input);
    expect(r?.name).toBe('taunt');
    if (r?.name === 'taunt') expect(r.args.line.length).toBeLessThanOrEqual(TAUNT_MAX_CHARS);
    expect(validateToolCall(call('taunt', { line: '   ' }), input)).toBeNull();
    expect(cleanTaunt('"Shhh, Dev."')).toBe('Shhh, Dev.');
    expect(cleanTaunt(null)).toBeNull();
  });

  it('accepts only known effects', () => {
    for (const name of BOSS_EFFECT_NAMES) {
      expect(validateToolCall(call('trigger_effect', { name }), input)).toEqual({
        name: 'trigger_effect',
        args: { name },
      });
    }
    expect(validateToolCall(call('trigger_effect', { name: 'explode' }), input)).toBeNull();
  });

  it('ignores malformed JSON and unknown tools', () => {
    expect(validateToolCall({ name: 'choose_attack', arguments: '{"pattern": "high_sw' }, input)).toBeNull();
    expect(validateToolCall({ name: 'choose_attack', arguments: '[1,2]' }, input)).toBeNull();
    expect(validateToolCall(call('summon_dragon', {}), input)).toBeNull();
  });
});

describe('ward rules', () => {
  it('allows raise_ward only for a boss at or below half HP, once per phase', () => {
    const half = { enemyHp: 80, enemyMaxHp: 160 };
    expect(canRaiseWard(makeBossInput(half))).toBe(true);
    expect(canRaiseWard(makeBossInput({ enemyHp: 81, enemyMaxHp: 160 }))).toBe(false);
    expect(canRaiseWard(makeBossInput({ ...half, isBoss: false, enemy: STEED }))).toBe(false);
    expect(canRaiseWard(makeBossInput({ ...half, wardActive: true }))).toBe(false);
    expect(canRaiseWard(makeBossInput({ ...half, wardRaisedThisPhase: true }))).toBe(false);
    expect(canRaiseWard(makeBossInput({ enemyHp: 0, enemyMaxHp: 160 }))).toBe(false);

    expect(validateToolCall(call('raise_ward', {}), makeBossInput(half))).toEqual({ name: 'raise_ward', args: {} });
    expect(validateToolCall(call('raise_ward', {}), makeBossInput())).toBeNull();
  });

  it('offers the raise_ward tool to bosses only', () => {
    const names = (i: ReturnType<typeof makeBossInput>) => buildBossTools(i).map((t) => t.function.name);
    expect(names(makeBossInput())).toContain('raise_ward');
    expect(names(makeBossInput({ isBoss: false, enemy: STEED }))).not.toContain('raise_ward');
  });

  it('scripted plan raises the ward by the same rule', () => {
    expect(scriptedPlan(makeBossInput({ enemyHp: 60, enemyMaxHp: 160 })).raiseWard).toBe(true);
    expect(scriptedPlan(makeBossInput({ enemyHp: 60, enemyMaxHp: 160, wardRaisedThisPhase: true })).raiseWard).toBe(false);
  });
});

describe('habit targeting', () => {
  it('summarizes dodges and finds the player who keeps dodging the same way', () => {
    const input = makeBossInput({
      dodgeHistory: {
        [MAYA.id]: dodges(['left', 'right', 'down']),
        [DEV.id]: dodges(['right', 'left', 'left', 'left']),
      },
      recentElements: ['ember', 'ember', 'frost', 'ember'],
    });
    const habits = summarizeHabits(input);
    expect(habits.habitTarget?.id).toBe(DEV.id);
    expect(habits.habitTarget?.streak).toBe(3);
    expect(habits.players.find((p) => p.id === DEV.id)?.lastDirections).toEqual(['left', 'left', 'left']);
    expect(habits.elementCounts).toEqual({ ember: 3, frost: 1, bloom: 0 });
    expect(habits.overusedElement).toBe('ember');

    const msg = JSON.parse(buildBossUserMessage(input, habits));
    expect(msg.players[1].last3Dodges).toBe('left, left, left');
    expect(msg.habitTarget).toMatchObject({ name: 'Dev', keepsDodging: 'left', times: 3 });
  });

  it('ignores parries and hits without a direction when counting a streak', () => {
    const input = makeBossInput({ dodgeHistory: { [MAYA.id]: dodges(['down', 'parry', 'down', 'hit']) } });
    expect(summarizeHabits(input).habitTarget).toMatchObject({ id: MAYA.id, streak: 2, streakDirection: 'down' });
  });

  it('has no overused element on an even split', () => {
    const input = makeBossInput({ recentElements: ['ember', 'frost', 'ember', 'frost'] });
    expect(summarizeHabits(input).overusedElement).toBeNull();
  });

  it('scripted fallback targets the habit player, otherwise rotates', () => {
    const habit = makeBossInput({ roundIndex: 0, dodgeHistory: { [DEV.id]: dodges(['left', 'left', 'left']) } });
    const plan = scriptedPlan(habit);
    expect(plan.targetPlayerIds).toEqual([DEV.id]);
    expect(plan.taunt).toBe('The Night Librarian has learned your habits, Dev.');

    expect(scriptedPlan(makeBossInput({ roundIndex: 0 })).targetPlayerIds).toEqual([MAYA.id]);
    expect(scriptedPlan(makeBossInput({ roundIndex: 1 })).targetPlayerIds).toEqual([DEV.id]);
  });

  it('scripted fallback cycles through the enemy attacks deterministically', () => {
    const seq = [0, 1, 2, 3].map((roundIndex) => scriptedPlan(makeBossInput({ roundIndex })).attackType);
    expect(seq).toEqual(['high_swing', 'projectile', 'low_sweep', 'high_swing']);
    const plan = scriptedPlan(makeBossInput({ roundIndex: 1 }));
    expect(plan.source).toBe('scripted');
    expect(plan.taunt).toBe('Overdue! Overdue! The shelves sweep low!');
    expect(scriptedPlan(makeBossInput({ hearts: 1 })).defenseWindowMs).toBe(DEFENSE_WINDOW_MS.max);
  });

  it('falls back to the template cycle when the enemy lists no attacks', () => {
    const input = makeBossInput({ enemy: { ...STEED, attacks: [] }, isBoss: false });
    expect(scriptedPlan(input).attackType).toBe('low_sweep');
  });
});

describe('mergeAgentPlan', () => {
  it('needs a valid choose_attack and fills the rest from the fallback', () => {
    const input = makeBossInput({ enemyHp: 40, enemyMaxHp: 160 });
    const fallback = scriptedPlan(input);
    expect(mergeAgentPlan([{ name: 'taunt', args: { line: 'Hi' } }], fallback)).toBeNull();

    const plan = mergeAgentPlan(
      [
        { name: 'choose_attack', args: { pattern: 'projectile', targets: [MAYA.id] } },
        { name: 'trigger_effect', args: { name: 'hit' } },
        { name: 'trigger_effect', args: { name: 'hit' } },
        { name: 'trigger_effect', args: { name: 'tick' } },
        { name: 'trigger_effect', args: { name: 'cast' } },
      ],
      fallback,
    );
    expect(plan).toMatchObject({
      attackType: 'projectile',
      targetPlayerIds: [MAYA.id],
      defenseWindowMs: fallback.defenseWindowMs,
      raiseWard: true,
      taunt: fallback.taunt,
      effects: ['hit', 'tick'],
      source: 'agent',
    });
  });
});

describe('createBossPlanner', () => {
  const habitInput = makeBossInput({
    roundIndex: 2,
    enemyHp: 70,
    enemyMaxHp: 160,
    dodgeHistory: { [DEV.id]: dodges(['left', 'left', 'left']) },
  });

  it('uses valid agent tool calls with source "agent" and sends tools with required choice', async () => {
    let seen: MuseChatRequest | undefined;
    const planner = createBossPlanner(
      fakeAi(async (req) => {
        seen = req;
        return reply([
          call('choose_attack', { pattern: 'high_swing', targets: [DEV.id] }),
          call('adjust_timing', { ms: 5000 }),
          call('raise_ward', {}),
          call('taunt', { line: 'The Night Librarian has learned your habits, Dev.' }),
          call('trigger_effect', { name: 'servo_open' }),
        ]);
      }),
    );
    const plan = await planner.planNextRound(habitInput, BOSS_AGENT_DEADLINE_MS);
    expect(plan).toEqual({
      attackType: 'high_swing',
      targetPlayerIds: [DEV.id],
      defenseWindowMs: DEFENSE_WINDOW_MS.max,
      raiseWard: true,
      taunt: 'The Night Librarian has learned your habits, Dev.',
      effects: ['servo_open'],
      source: 'agent',
    });
    expect(seen?.toolChoice).toBe('required');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.tools?.map((t) => (t.type === 'function' ? t.function.name : ''))).toEqual([
      'choose_attack',
      'adjust_timing',
      'raise_ward',
      'taunt',
      'trigger_effect',
    ]);
    expect(seen?.messages[0]?.content).toContain('The Night Librarian');
  });

  it('falls back to the scripted plan at the deadline when Muse never answers', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const planner = createBossPlanner(
      fakeAi((req) => {
        signal = req.signal;
        return new Promise<never>(() => {});
      }),
    );
    let settled = false;
    const pending = planner.planNextRound(habitInput, BOSS_AGENT_DEADLINE_MS).then((p) => {
      settled = true;
      return p;
    });
    await vi.advanceTimersByTimeAsync(BOSS_AGENT_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const plan = await pending;
    expect(plan).toEqual(scriptedPlan(habitInput));
    expect(plan.source).toBe('scripted');
    expect(signal?.aborted).toBe(true);
  });

  it('falls back on malformed tool calls', async () => {
    const planner = createBossPlanner(
      fakeAi(async () =>
        reply([
          { name: 'choose_attack', arguments: '{"pattern": "high_swing", "targets": [' },
          call('choose_attack', { pattern: 'stare', targets: [DEV.id] }),
          call('taunt', { line: 'I would have won.' }),
        ]),
      ),
    );
    const plan = await planner.planNextRound(habitInput, BOSS_AGENT_DEADLINE_MS);
    expect(plan).toEqual(scriptedPlan(habitInput));
  });

  it('falls back on a null reply, a rejecting Muse, and an unavailable Muse', async () => {
    const expected = scriptedPlan(habitInput);
    const nullPlanner = createBossPlanner(fakeAi(async () => null));
    expect(await nullPlanner.planNextRound(habitInput, 1000)).toEqual(expected);

    const throwing = createBossPlanner(
      fakeAi(() => {
        throw new Error('boom');
      }),
    );
    expect(await throwing.planNextRound(habitInput, 1000)).toEqual(expected);

    const complete = vi.fn(async () => reply([call('choose_attack', { pattern: 'high_swing', targets: [DEV.id] })]));
    const offline = createBossPlanner(fakeAi(complete, false));
    expect(await offline.planNextRound(habitInput, 1000)).toEqual(expected);
    expect(complete).not.toHaveBeenCalled();
  });

  it('probes toolChoice "auto" after repeated null replies, and keeps it once it answers', async () => {
    const choices: unknown[] = [];
    const planner = createBossPlanner(
      fakeAi(async (req) => {
        choices.push(req.toolChoice);
        return req.toolChoice === 'auto'
          ? reply([call('choose_attack', { pattern: 'high_swing', targets: [DEV.id] })])
          : null;
      }),
    );
    for (let i = 0; i < 5; i++) await planner.planNextRound(habitInput, 1000);
    expect(choices).toEqual(['required', 'required', 'auto', 'auto', 'auto']);
  });

  it('goes back to "required" when "auto" fails too (a network problem)', async () => {
    const choices: unknown[] = [];
    const planner = createBossPlanner(
      fakeAi(async (req) => {
        choices.push(req.toolChoice);
        return null;
      }),
    );
    for (let i = 0; i < 4; i++) await planner.planNextRound(habitInput, 1000);
    expect(choices).toEqual(['required', 'required', 'auto', 'required']);
  });

  it('merges a partially valid reply over fallback defaults', async () => {
    const planner = createBossPlanner(
      fakeAi(async () =>
        reply([
          call('choose_attack', { pattern: 'low_sweep', targets: ['Maya', 'ghost'] }),
          call('adjust_timing', { ms: 'fast' }),
          call('trigger_effect', { name: 'fireworks' }),
        ]),
      ),
    );
    const plan = await planner.planNextRound(habitInput, 1000);
    const fallback = scriptedPlan(habitInput);
    expect(plan).toEqual({
      ...fallback,
      attackType: 'low_sweep',
      targetPlayerIds: [MAYA.id],
      effects: [],
      source: 'agent',
    });
  });
});
