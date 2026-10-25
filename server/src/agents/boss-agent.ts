/**
 * Boss agent: Muse Spark plans each round with tool calls, inside a hard deadline.
 *
 * Flow per round:
 * 1. Summarize the players' habits (dodge directions, element use) from the engine's input.
 * 2. Ask Muse Spark, in character as the enemy, to call the 5 boss tools.
 * 3. Validate every call against code-owned limits and merge it over the scripted plan.
 * 4. On a timeout, a `null` reply or no valid `choose_attack`, return the scripted plan.
 *
 * `planNextRound` never rejects and always resolves by the deadline.
 */
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import {
  ATTACK_DEFENSE,
  BOSS_AGENT_DEADLINE_MS,
  DEFENSE_WINDOW_MS,
  ENEMY_TEMPLATES,
  P0_ELEMENTS,
  TAUNT_MAX_CHARS,
  WARD_HP_RATIO,
} from '@once-upon/shared';
import type {
  AttackType,
  BossEffectName,
  BossPlan,
  BossToolCall,
  P0ElementType,
  PlayerRole,
} from '@once-upon/shared';
import type { AiService, BossPlanner, BossPlannerInput, MuseChat } from '../contracts';
import { aiTimings } from '../ai/timings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFECT_SET: Record<BossEffectName, true> = {
  tick: true,
  cast: true,
  fizzle: true,
  hit: true,
  servo_open: true,
};
/** Every `BossEffectName`, built from an exhaustive record so a new name can't be missed. */
export const BOSS_EFFECT_NAMES = Object.keys(EFFECT_SET) as BossEffectName[];

export const BOSS_TOOL_NAMES = [
  'choose_attack',
  'adjust_timing',
  'raise_ward',
  'taunt',
  'trigger_effect',
] as const;
export type BossToolName = (typeof BOSS_TOOL_NAMES)[number];

/** At most this many effects fire per round, so the glove does not buzz nonstop. */
export const MAX_EFFECTS_PER_ROUND = 2;

/** A same-direction streak this long marks a habit worth punishing. */
export const HABIT_STREAK_MIN = 2;

/** An element is "overused" at this many recent casts and at least this share of them. */
const OVERUSE_MIN_COUNT = 3;
const OVERUSE_MIN_SHARE = 0.5;

const FALLBACK_ATTACK: AttackType = 'low_sweep';

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export type DodgeDirection = 'left' | 'right' | 'down';

export interface PlayerHabit {
  id: string;
  name: string;
  role: PlayerRole;
  /** The last 3 known dodge directions, oldest first. */
  lastDirections: DodgeDirection[];
  /** Direction of the newest run of identical directions, and its length. */
  streakDirection: DodgeDirection | null;
  streak: number;
  directionCounts: Record<DodgeDirection, number>;
  dodges: number;
  parries: number;
  hits: number;
}

export interface HabitSummary {
  players: PlayerHabit[];
  /** The player with the longest same-direction streak (at least {@link HABIT_STREAK_MIN}). */
  habitTarget: PlayerHabit | null;
  elementCounts: Record<P0ElementType, number>;
  overusedElement: P0ElementType | null;
}

/** Pure summary of the input that both the prompt and the scripted fallback use. */
export function summarizeHabits(input: BossPlannerInput): HabitSummary {
  const players: PlayerHabit[] = input.players.map((p) => {
    const history = input.dodgeHistory[p.id] ?? [];
    const directions = history
      .map((h) => h.direction)
      .filter((d): d is DodgeDirection => d === 'left' || d === 'right' || d === 'down');
    const directionCounts: Record<DodgeDirection, number> = { left: 0, right: 0, down: 0 };
    for (const d of directions) directionCounts[d]++;

    const newest = directions[directions.length - 1] ?? null;
    let streak = 0;
    for (let i = directions.length - 1; i >= 0 && directions[i] === newest; i--) streak++;

    return {
      id: p.id,
      name: p.name,
      role: p.role,
      lastDirections: directions.slice(-3),
      streakDirection: newest,
      streak,
      directionCounts,
      dodges: history.filter((h) => h.dodged && !h.parried).length,
      parries: history.filter((h) => h.parried).length,
      hits: history.filter((h) => !h.dodged && !h.parried).length,
    };
  });

  let habitTarget: PlayerHabit | null = null;
  for (const p of players) {
    if (p.streak < HABIT_STREAK_MIN || !p.streakDirection) continue;
    const pCount = p.directionCounts[p.streakDirection];
    if (
      !habitTarget ||
      p.streak > habitTarget.streak ||
      (p.streak === habitTarget.streak && pCount > habitTarget.directionCounts[habitTarget.streakDirection!])
    ) {
      habitTarget = p;
    }
  }

  const elementCounts: Record<P0ElementType, number> = { ember: 0, frost: 0, bloom: 0 };
  for (const e of input.recentElements) if (e in elementCounts) elementCounts[e]++;
  const total = input.recentElements.length;
  let overusedElement: P0ElementType | null = null;
  const sorted = [...P0_ELEMENTS].sort((a, b) => elementCounts[b] - elementCounts[a]);
  const top = sorted[0]!;
  const second = sorted[1]!;
  if (
    elementCounts[top] >= OVERUSE_MIN_COUNT &&
    elementCounts[top] / Math.max(1, total) >= OVERUSE_MIN_SHARE &&
    elementCounts[top] > elementCounts[second]
  ) {
    overusedElement = top;
  }

  return { players, habitTarget, elementCounts, overusedElement };
}

// ---------------------------------------------------------------------------
// Rules and validation
// ---------------------------------------------------------------------------

/** The attacks this enemy may use: its own list, else its template's default cycle. */
export function allowedAttacks(input: BossPlannerInput): AttackType[] {
  if (input.enemy.attacks.length > 0) return [...new Set(input.enemy.attacks)];
  const defaults = ENEMY_TEMPLATES[input.enemy.template]?.defaultAttacks ?? [];
  return defaults.length > 0 ? [...new Set(defaults)] : [FALLBACK_ATTACK];
}

/** True when the team is down to its last heart and the boss should ease off. */
export function shouldEaseOff(input: BossPlannerInput): boolean {
  return input.hearts <= 1;
}

/** Ward rule: boss only, not already up, not used this phase, HP at most half (and alive). */
export function canRaiseWard(input: BossPlannerInput): boolean {
  return (
    input.isBoss &&
    !input.wardActive &&
    !input.wardRaisedThisPhase &&
    input.enemyMaxHp > 0 &&
    input.enemyHp > 0 &&
    input.enemyHp <= input.enemyMaxHp * WARD_HP_RATIO
  );
}

/**
 * Clamps a defense window into `DEFENSE_WINDOW_MS`. While easing off (hearts <= 1) the
 * window never drops below the default, so the team can finish the story.
 */
export function clampDefenseWindow(ms: number, input?: BossPlannerInput): number {
  const min = input && shouldEaseOff(input) ? DEFENSE_WINDOW_MS.default : DEFENSE_WINDOW_MS.min;
  const value = Number.isFinite(ms) ? Math.round(ms) : DEFENSE_WINDOW_MS.default;
  return Math.min(DEFENSE_WINDOW_MS.max, Math.max(min, value));
}

/** Trims quotes and whitespace and cuts to `TAUNT_MAX_CHARS` on a word boundary. `null` if empty. */
export function cleanTaunt(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  let text = line
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (text === '') return null;
  if (text.length > TAUNT_MAX_CHARS) {
    const cut = text.slice(0, TAUNT_MAX_CHARS - 1);
    const lastSpace = cut.lastIndexOf(' ');
    text = `${(lastSpace > TAUNT_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
  }
  return text;
}

/**
 * Maps model-supplied targets onto real player IDs. Accepts IDs or names (any case), a single
 * string or an array; drops anything else. Order is kept and duplicates removed.
 */
export function filterTargets(raw: unknown, input: BossPlannerInput): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase();
    const player =
      input.players.find((p) => p.id.toLowerCase() === key) ??
      input.players.find((p) => p.name.trim().toLowerCase() === key);
    if (player && !out.includes(player.id)) out.push(player.id);
  }
  return out;
}

/** Default target: the habit target, otherwise a rotation through the seats. */
export function defaultTargets(input: BossPlannerInput, habits = summarizeHabits(input)): string[] {
  if (habits.habitTarget) return [habits.habitTarget.id];
  if (input.players.length === 0) return [];
  const idx = ((input.roundIndex % input.players.length) + input.players.length) % input.players.length;
  return [input.players[idx]!.id];
}

/** A tool call as the model sent it: `arguments` is usually a JSON string. */
export interface RawToolCall {
  name: string;
  arguments: unknown;
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return {};
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (value === undefined || value === null) return {};
  return typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Validates one tool call against the code-owned limits. Returns the clamped call, or `null`
 * when it must be ignored (unknown tool, malformed JSON, disallowed pattern, ward not allowed,
 * unknown effect, empty taunt).
 */
export function validateToolCall(call: RawToolCall, input: BossPlannerInput): BossToolCall | null {
  const args = parseArgs(call.arguments);
  if (args === null) return null;

  switch (call.name) {
    case 'choose_attack': {
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
      const allowed = allowedAttacks(input);
      if (!allowed.includes(pattern as AttackType)) return null;
      let targets = filterTargets(args.targets, input);
      if (targets.length === 0) targets = defaultTargets(input);
      return { name: 'choose_attack', args: { pattern: pattern as AttackType, targets } };
    }
    case 'adjust_timing': {
      const ms = typeof args.ms === 'string' ? Number(args.ms) : args.ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
      return { name: 'adjust_timing', args: { ms: clampDefenseWindow(ms, input) } };
    }
    case 'raise_ward':
      return canRaiseWard(input) ? { name: 'raise_ward', args: {} } : null;
    case 'taunt': {
      const line = cleanTaunt(args.line);
      return line ? { name: 'taunt', args: { line } } : null;
    }
    case 'trigger_effect': {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      return BOSS_EFFECT_NAMES.includes(name as BossEffectName)
        ? { name: 'trigger_effect', args: { name: name as BossEffectName } }
        : null;
    }
    default:
      return null;
  }
}

/** Pulls function tool calls out of a chat reply. */
export function extractToolCalls(reply: ChatCompletionMessage | null): RawToolCall[] {
  if (!reply?.tool_calls) return [];
  const out: RawToolCall[] = [];
  for (const tc of reply.tool_calls) {
    if (tc.type === 'function' && tc.function) {
      out.push({ name: tc.function.name, arguments: tc.function.arguments });
    }
  }
  return out;
}

/**
 * Merges validated calls over the scripted plan. Needs a valid `choose_attack` (the first one
 * wins); every other field keeps the scripted value unless the agent set it. Returns `null`
 * when there is no valid `choose_attack`, so the caller uses the scripted plan.
 */
export function mergeAgentPlan(calls: BossToolCall[], fallback: BossPlan): BossPlan | null {
  const attack = calls.find((c) => c.name === 'choose_attack');
  if (!attack) return null;

  const timing = calls.find((c) => c.name === 'adjust_timing');
  const taunt = calls.find((c) => c.name === 'taunt');
  const ward = calls.some((c) => c.name === 'raise_ward');
  const effects: BossEffectName[] = [];
  for (const c of calls) {
    if (c.name === 'trigger_effect' && !effects.includes(c.args.name)) effects.push(c.args.name);
  }

  return {
    attackType: attack.args.pattern,
    targetPlayerIds: attack.args.targets,
    defenseWindowMs: timing ? timing.args.ms : fallback.defenseWindowMs,
    raiseWard: ward || fallback.raiseWard,
    taunt: taunt ? taunt.args.line : fallback.taunt,
    effects: effects.slice(0, MAX_EFFECTS_PER_ROUND),
    source: 'agent',
  };
}

// ---------------------------------------------------------------------------
// Scripted fallback
// ---------------------------------------------------------------------------

function storybookName(name: string): string {
  const trimmed = name.trim() || 'The creature';
  return /^the\s/i.test(trimmed) ? trimmed.replace(/^the/i, 'The') : `The ${trimmed}`;
}

/**
 * Deterministic plan: cycles through the enemy's attacks, targets the habit player (or
 * rotates), raises the ward by the same rule as the agent, and taunts from `enemy.lines`.
 */
export function scriptedPlan(input: BossPlannerInput, habits = summarizeHabits(input)): BossPlan {
  const attacks = allowedAttacks(input);
  const round = Math.max(0, Math.floor(input.roundIndex));
  const attackType = attacks[round % attacks.length]!;

  let taunt: string | null = null;
  if (habits.habitTarget && habits.habitTarget.streak >= 3) {
    taunt = cleanTaunt(`${storybookName(input.enemy.name)} has learned your habits, ${habits.habitTarget.name}.`);
  } else if (input.enemy.lines.length > 0) {
    taunt = cleanTaunt(input.enemy.lines[round % input.enemy.lines.length]);
  }

  return {
    attackType,
    targetPlayerIds: defaultTargets(input, habits),
    defenseWindowMs: shouldEaseOff(input) ? DEFENSE_WINDOW_MS.max : DEFENSE_WINDOW_MS.default,
    raiseWard: canRaiseWard(input),
    taunt,
    effects: [],
    source: 'scripted',
  };
}

// ---------------------------------------------------------------------------
// Prompt and tools
// ---------------------------------------------------------------------------

const DEFENSE_HINT: Record<string, string> = {
  side_step: 'side-stepped left or right',
  duck: 'ducked',
  parry: 'parried with the glove',
  jump: 'jumped',
  freeze: 'stood still',
};

export function buildBossTools(input: BossPlannerInput): ChatCompletionFunctionTool[] {
  const ids = input.players.map((p) => p.id);
  const tools: ChatCompletionFunctionTool[] = [
    {
      type: 'function',
      function: {
        name: 'choose_attack',
        description:
          'Required every round. Picks your next attack and which players it targets (by player id).',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              enum: allowedAttacks(input),
              description: 'The attack: low_sweep is beaten by a side step, high_swing by a duck, projectile by a glove parry.',
            },
            targets: {
              type: 'array',
              items: { type: 'string', enum: ids },
              minItems: 1,
              maxItems: Math.max(1, ids.length),
              description: 'Player ids to target.',
            },
          },
          required: ['pattern', 'targets'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'adjust_timing',
        description: `Sets the defense window in milliseconds (${DEFENSE_WINDOW_MS.min} to ${DEFENSE_WINDOW_MS.max}, default ${DEFENSE_WINDOW_MS.default}). Shorter is harder.`,
        parameters: {
          type: 'object',
          properties: {
            ms: { type: 'integer', minimum: DEFENSE_WINDOW_MS.min, maximum: DEFENSE_WINDOW_MS.max },
          },
          required: ['ms'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'taunt',
        description: `One line you say aloud this round, at most ${TAUNT_MAX_CHARS} characters, in storybook voice.`,
        parameters: {
          type: 'object',
          properties: { line: { type: 'string', maxLength: TAUNT_MAX_CHARS } },
          required: ['line'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'trigger_effect',
        description:
          'Fires a physical effect: tick (nervous buzz on the glove), hit (heavy buzz), cast or fizzle (spell buzzes), servo_open (opens the prop storybook; rare, dramatic moments only).',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', enum: BOSS_EFFECT_NAMES } },
          required: ['name'],
        },
      },
    },
  ];
  if (input.isBoss) {
    tools.splice(2, 0, {
      type: 'function',
      function: {
        name: 'raise_ward',
        description:
          'Raises your ward, which only a Twin Cast (both players casting the same element together) breaks. Only when canRaiseWard is true.',
        parameters: { type: 'object', properties: {} },
      },
    });
  }
  return tools;
}

export function buildBossSystemPrompt(input: BossPlannerInput): string {
  const e = input.enemy;
  const lines = e.lines.slice(0, 4).map((l) => `"${l}"`).join(' ');
  const counters = (Object.entries(ATTACK_DEFENSE) as [AttackType, string][])
    .filter(([a]) => allowedAttacks(input).includes(a))
    .map(([a, d]) => `${a} is beaten when a player ${DEFENSE_HINT[d] ?? d}`)
    .join('; ');
  return [
    `You are ${e.name}, ${input.isBoss ? 'the final boss' : 'a creature'} in a cozy fairy-tale storybook game, born from the shared memory "${e.memory}".`,
    lines ? `You speak like this: ${lines}` : '',
    'Each round you plan your next attack against the players by calling tools. Always call choose_attack exactly once. You may also call adjust_timing, taunt, trigger_effect' +
      (input.isBoss ? ' and raise_ward' : '') +
      ' once each. Never reply with plain text; use only tool calls.',
    `Your attacks: ${counters}.`,
    'Tactics:',
    '- If a player keeps dodging the same way (habitTarget), target them with an attack that their usual dodge does not beat.',
    '- If the team overuses one element (overusedElement), counter it: against frost, shorten the window; against ember, press harder with a fast attack; against bloom healing, target both players.',
    input.isBoss
      ? '- Raise your ward once your HP is at or below half, but only when canRaiseWard is true.'
      : '- You are not the boss, so you have no ward.',
    '- If the team has 1 heart or fewer (easeOff), ease off: one target, a long window (2000 ms), and a gentler line. The tale must be able to end happily.',
    `- taunt: at most ${TAUNT_MAX_CHARS} characters, in storybook voice, naming the player whose habit you learned, for example "${storybookName(e.name)} has learned your habits, Dev."`,
    'Keep it playful and family-friendly.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Compact JSON summary of the round for the user message. */
export function buildBossUserMessage(input: BossPlannerInput, habits = summarizeHabits(input)): string {
  const summary = {
    round: input.roundIndex,
    enemy: {
      name: input.enemy.name,
      isBoss: input.isBoss,
      hp: `${input.enemyHp}/${input.enemyMaxHp}`,
      wardActive: input.wardActive,
      canRaiseWard: canRaiseWard(input),
      attacks: allowedAttacks(input),
    },
    team: {
      hearts: `${input.hearts}/${input.maxHearts}`,
      easeOff: shouldEaseOff(input),
      difficulty: input.difficulty,
    },
    players: habits.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      last3Dodges: p.lastDirections.length > 0 ? p.lastDirections.join(', ') : 'none yet',
      dodged: p.dodges,
      parried: p.parries,
      hit: p.hits,
    })),
    habitTarget: habits.habitTarget
      ? {
          id: habits.habitTarget.id,
          name: habits.habitTarget.name,
          keepsDodging: habits.habitTarget.streakDirection,
          times: habits.habitTarget.streak,
        }
      : null,
    elementCounts: habits.elementCounts,
    overusedElement: habits.overusedElement,
  };
  return JSON.stringify(summary);
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface BossPlannerOptions {
  /** Retained for callers; Meta requests always use auto. */
  toolChoice?: 'required' | 'auto';
  /** Optional debug log for fallback reasons. Off by default. */
  log?: (message: string) => void;
}

export type PlanOutcome = 'agent' | 'unavailable' | 'timeout' | 'null_reply' | 'no_valid_attack' | 'error';

export function createBossPlanner(ai: AiService, opts: BossPlannerOptions = {}): BossPlanner {
  const log = opts.log ?? (() => {});

  async function askMuse(
    muse: MuseChat,
    input: BossPlannerInput,
    habits: HabitSummary,
    deadlineMs: number,
  ): Promise<{ outcome: PlanOutcome; reply: ChatCompletionMessage | null }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, deadlineMs);
    });
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildBossSystemPrompt(input) },
      { role: 'user', content: buildBossUserMessage(input, habits) },
    ];
    try {
      const request = Promise.resolve()
        .then(() =>
          muse.complete({
            messages,
            tools: buildBossTools(input),
            toolChoice: 'auto',
            temperature: 0.7,
            maxTokens: 400,
            timeoutMs: deadlineMs,
            signal: controller.signal,
          }),
        )
        .catch(() => 'error' as const);
      const winner = await Promise.race([request, timeout]);
      if (winner === 'timeout') return { outcome: 'timeout', reply: null };
      if (winner === 'error') return { outcome: 'error', reply: null };
      if (winner === null) return { outcome: 'null_reply', reply: null };
      return { outcome: 'agent', reply: winner };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async planNextRound(input, deadlineMs) {
      let habits: HabitSummary;
      let fallback: BossPlan;
      try {
        habits = summarizeHabits(input);
        fallback = scriptedPlan(input, habits);
      } catch {
        // Malformed input from the engine: still answer with something playable.
        return {
          attackType: input?.enemy?.attacks?.[0] ?? FALLBACK_ATTACK,
          targetPlayerIds: input?.players?.[0] ? [input.players[0].id] : [],
          defenseWindowMs: DEFENSE_WINDOW_MS.default,
          raiseWard: false,
          taunt: null,
          effects: [],
          source: 'scripted',
        };
      }

      const muse = ai.muse;
      const budget = Number.isFinite(deadlineMs) ? deadlineMs : BOSS_AGENT_DEADLINE_MS;
      if (!muse?.available || budget <= 0) {
        log(`[boss] round ${input.roundIndex}: scripted (unavailable)`);
        return fallback;
      }

      const started = Date.now();
      const done = (plan: BossPlan) => {
        aiTimings.record('boss.plan', Date.now() - started, plan.source === 'agent' ? 'ok' : 'fallback');
        return plan;
      };
      try {
        const { outcome, reply } = await askMuse(muse, input, habits, budget);
        if (!reply) {
          log(`[boss] round ${input.roundIndex}: scripted (${outcome})`);
          return done(fallback);
        }
        const calls = extractToolCalls(reply)
          .map((c) => validateToolCall(c, input))
          .filter((c): c is BossToolCall => c !== null);
        const plan = mergeAgentPlan(calls, fallback);
        if (!plan) {
          log(`[boss] round ${input.roundIndex}: scripted (no_valid_attack)`);
          return done(fallback);
        }
        return done(plan);
      } catch {
        return done(fallback);
      }
    },
  };
}
