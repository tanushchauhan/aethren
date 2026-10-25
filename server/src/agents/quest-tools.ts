/**
 * Quest Master tools, shared by the MCP server (`/mcp`) and the in-app quest box
 * (`POST /api/quest-chat`). One implementation, two callers.
 *
 * The tools only touch game data through `ctx.rooms` and `ctx.ai.listMemoryCards()`, read at
 * call time so the real engine works as soon as it is merged. They never see the raw chat.
 */
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { QuestDifficulty, QuestStatus } from '@once-upon/shared';
import type { ServerContext } from '../contracts';

export const QUEST_TOOL_NAMES = [
  'list_memory_cards',
  'create_quest',
  'invite_player',
  'get_quest_status',
] as const;
export type QuestToolName = (typeof QUEST_TOOL_NAMES)[number];

export const MAX_QUEST_PLAYERS = 4;
const MAX_NAME_CHARS = 40;

/** Trims, collapses whitespace and drops control characters from a player name. */
export function cleanPlayerName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
}

const playerNameSchema = z
  .string()
  .transform(cleanPlayerName)
  .pipe(z.string().min(1, 'Player names cannot be blank'));

const roomCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .describe('The 4-letter room code returned by create_quest, for example "ABCD". Case does not matter.');

const difficultySchema = z.enum(['easy', 'normal', 'hard']);

// ---------------------------------------------------------------------------
// Input and output shapes (zod raw shapes, as the MCP SDK's registerTool expects)
// ---------------------------------------------------------------------------

export const questToolInputShapes = {
  list_memory_cards: {},
  create_quest: {
    encounter_card_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional ID of the memory card that becomes the first encounter. Get IDs from list_memory_cards. Leave it out to let the players pick in the opening.',
      ),
    difficulty: difficultySchema
      .default('normal')
      .describe('How tough the enemies are: "easy", "normal" or "hard". Defaults to "normal".'),
    player_names: z
      .array(playerNameSchema)
      .min(1)
      .max(MAX_QUEST_PLAYERS)
      .describe(
        'Names of the 1 to 4 players, the person asking first. The first player becomes the host (the Spellbearer with the glove); the next one is the Partner. Use first names as the players say them, for example ["Maya", "Dev"].',
      ),
  },
  invite_player: {
    room_code: roomCodeSchema,
    player_name: playerNameSchema.describe('Name of the player to invite, for example "Dev".'),
  },
  get_quest_status: {
    room_code: roomCodeSchema,
  },
} as const;

const joinLinkShape = z.object({ playerName: z.string(), joinLink: z.string() });

export const questToolOutputShapes = {
  list_memory_cards: {
    cards: z.array(
      z.object({ id: z.string(), quote: z.string(), mood: z.string(), color: z.string() }),
    ),
  },
  create_quest: {
    roomCode: z.string(),
    difficulty: difficultySchema,
    encounterCardId: z.string().nullable(),
    hostName: z.string(),
    joinLink: z.string(),
    players: z.array(joinLinkShape),
  },
  invite_player: {
    roomCode: z.string(),
    playerName: z.string(),
    joinLink: z.string(),
  },
  get_quest_status: {
    roomCode: z.string(),
    phase: z.string(),
    hearts: z.number(),
    maxHearts: z.number(),
    enemyName: z.string().nullable(),
    enemyHp: z.number(),
    enemyMaxHp: z.number(),
    wardActive: z.boolean(),
  },
} as const;

export const questToolMeta: Record<QuestToolName, { title: string; description: string }> = {
  list_memory_cards: {
    title: 'List memory cards',
    description:
      "Lists the memory cards made from the group's shared chat: each card's id, a short quote, its mood and its color. Call this first if the players want a quest about a particular memory, then pass that card's id to create_quest. Takes no input.",
  },
  create_quest: {
    title: 'Create quest',
    description:
      'Creates a new Once Upon a Memory quest room and reserves a seat for every named player. Returns the 4-letter room code and a join link per player; share the links so each player opens theirs on their laptop. Call it once per request, with the person asking as the first name.',
  },
  invite_player: {
    title: 'Invite player',
    description:
      'Returns a join link for one more player in an existing quest room. Use it when someone asks to add a friend after the quest was created. Fails if the room code does not exist.',
  },
  get_quest_status: {
    title: 'Get quest status',
    description:
      "Reports how a quest is going: the current phase (lobby, opening, combat steps or ending), the team's hearts, the current enemy's name and hit points, and whether the boss's ward is up. Use it when players ask how the fight is going.",
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type QuestToolResult =
  | { ok: true; text: string; data: Record<string, unknown> }
  | { ok: false; error: string };

function fail(error: string): QuestToolResult {
  return { ok: false, error };
}

function formatStatus(s: QuestStatus): string {
  const enemy = s.enemyName
    ? `${s.enemyName} has ${s.enemyHp} of ${s.enemyMaxHp} HP${s.wardActive ? ' behind a raised ward' : ''}`
    : 'no enemy has appeared yet';
  return `Room ${s.roomCode} is in the ${s.phase} phase. The team has ${s.hearts} of ${s.maxHearts} hearts, and ${enemy}.`;
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

async function runListMemoryCards(ctx: ServerContext): Promise<QuestToolResult> {
  const cards = ctx.ai.listMemoryCards().map((c) => ({
    id: c.id,
    quote: c.quote,
    mood: c.mood,
    color: c.color,
  }));
  const text =
    cards.length === 0
      ? 'No memory cards yet. Upload a chat export in the app first.'
      : `${cards.length} memory cards:\n${cards
          .map((c) => `- ${c.id}: "${c.quote}" (${c.mood}, ${c.color})`)
          .join('\n')}`;
  return { ok: true, text, data: { cards } };
}

async function runCreateQuest(
  ctx: ServerContext,
  args: { encounter_card_id?: string; difficulty: QuestDifficulty; player_names: string[] },
): Promise<QuestToolResult> {
  const names = dedupeNames(args.player_names).slice(0, MAX_QUEST_PLAYERS);
  const hostName = names[0];
  if (!hostName) return fail('player_names needs at least one name.');

  let encounterCardId: string | undefined;
  if (args.encounter_card_id) {
    const cards = ctx.ai.listMemoryCards();
    const wanted = args.encounter_card_id.toLowerCase();
    const card = cards.find((c) => c.id.toLowerCase() === wanted);
    if (!card) {
      return fail(
        `Unknown encounter_card_id "${args.encounter_card_id}". Valid IDs: ${
          cards.map((c) => c.id).join(', ') || 'none'
        }. Call list_memory_cards, or leave encounter_card_id out.`,
      );
    }
    encounterCardId = card.id;
  }

  const rooms = ctx.rooms;
  const { roomCode } = await rooms.createRoom({
    hostName,
    hostRole: 'spellbearer',
    difficulty: args.difficulty,
    encounterCardId,
    playerNames: names.slice(1),
  });
  const players = names.map((playerName) => ({
    playerName,
    joinLink: rooms.buildJoinLink(roomCode, playerName),
  }));
  const data = {
    roomCode,
    difficulty: args.difficulty,
    encounterCardId: encounterCardId ?? null,
    hostName,
    joinLink: players[0]!.joinLink,
    players,
  };
  const text = [
    `Created a ${args.difficulty} quest in room ${roomCode} for ${names.join(', ')}.`,
    ...players.map((p) => `- ${p.playerName}: ${p.joinLink}`),
  ].join('\n');
  return { ok: true, text, data };
}

async function runInvitePlayer(
  ctx: ServerContext,
  args: { room_code: string; player_name: string },
): Promise<QuestToolResult> {
  const status = ctx.rooms.getQuestStatus(args.room_code);
  if (!status) return fail(`No quest room "${args.room_code}" exists. Check the code or create a quest.`);
  const joinLink = ctx.rooms.buildJoinLink(status.roomCode, args.player_name);
  return {
    ok: true,
    text: `${args.player_name} can join room ${status.roomCode} here: ${joinLink}`,
    data: { roomCode: status.roomCode, playerName: args.player_name, joinLink },
  };
}

async function runGetQuestStatus(
  ctx: ServerContext,
  args: { room_code: string },
): Promise<QuestToolResult> {
  const status = ctx.rooms.getQuestStatus(args.room_code);
  if (!status) return fail(`No quest room "${args.room_code}" exists. Check the code or create a quest.`);
  return { ok: true, text: formatStatus(status), data: { ...status } };
}

const inputObjects = {
  list_memory_cards: z.object(questToolInputShapes.list_memory_cards),
  create_quest: z.object(questToolInputShapes.create_quest),
  invite_player: z.object(questToolInputShapes.invite_player),
  get_quest_status: z.object(questToolInputShapes.get_quest_status),
};

export function isQuestToolName(name: string): name is QuestToolName {
  return (QUEST_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Validates `rawArgs` against the tool's zod schema and runs it. Never throws: invalid input,
 * unknown rooms and engine errors come back as `{ ok: false, error }`.
 */
export async function executeQuestTool(
  ctx: ServerContext,
  name: string,
  rawArgs: unknown,
): Promise<QuestToolResult> {
  if (!isQuestToolName(name)) return fail(`Unknown tool "${name}".`);
  try {
    switch (name) {
      case 'list_memory_cards':
        return await runListMemoryCards(ctx);
      case 'create_quest': {
        const parsed = inputObjects.create_quest.safeParse(rawArgs ?? {});
        if (!parsed.success) return fail(`Invalid create_quest input: ${parsed.error.message}`);
        return await runCreateQuest(ctx, parsed.data);
      }
      case 'invite_player': {
        const parsed = inputObjects.invite_player.safeParse(rawArgs ?? {});
        if (!parsed.success) return fail(`Invalid invite_player input: ${parsed.error.message}`);
        return await runInvitePlayer(ctx, parsed.data);
      }
      case 'get_quest_status': {
        const parsed = inputObjects.get_quest_status.safeParse(rawArgs ?? {});
        if (!parsed.success) return fail(`Invalid get_quest_status input: ${parsed.error.message}`);
        return await runGetQuestStatus(ctx, parsed.data);
      }
    }
  } catch (err) {
    return fail(`The ${name} tool failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The same 4 tools as OpenAI-format function tools, for Muse Spark in the quest box. */
export function questToolsForMuse(): ChatCompletionFunctionTool[] {
  return QUEST_TOOL_NAMES.map((name) => {
    // Some OpenAI-compatible providers reject the `$schema` keyword inside tool parameters.
    const { $schema: _ignored, ...parameters } = toJsonSchemaCompat(inputObjects[name], {
      pipeStrategy: 'input',
    });
    return {
      type: 'function',
      function: { name, description: questToolMeta[name].description, parameters },
    };
  });
}
