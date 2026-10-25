/**
 * In-app Quest Box: `POST /api/quest-chat`. The venue-Wi-Fi fallback for the Muse connector.
 *
 * Runs a short Muse Spark tool loop (at most {@link MAX_TOOL_ITERATIONS} calls) over the same
 * 4 Quest Master tools the MCP server offers. If Muse is unavailable, fails, or never calls a
 * tool, a deterministic parser pulls names and difficulty out of the prompt and calls
 * `create_quest` directly, so the box always produces a room.
 */
import type { Express, Request, Response } from 'express';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { QuestChatRequest, QuestChatResponse, QuestDifficulty } from '@once-upon/shared';
import type { ServerContext } from '../contracts';
import {
  MAX_QUEST_PLAYERS,
  cleanPlayerName,
  executeQuestTool,
  questToolsForMuse,
  type QuestToolResult,
} from './quest-tools';

export const MAX_TOOL_ITERATIONS = 4;
/** The whole Muse loop gives up after this long and the parser answers instead. */
export const QUEST_CHAT_BUDGET_MS = 20_000;
const QUEST_CHAT_CALL_TIMEOUT_MS = 8_000;
export const MAX_PROMPT_CHARS = 1000;
const MAX_REPLY_CHARS = 800;
export const DEFAULT_HOST_NAME = 'Spellbearer';

type ToolCallRecord = QuestChatResponse['toolCalls'][number];

// ---------------------------------------------------------------------------
// Deterministic parser
// ---------------------------------------------------------------------------

export interface ParsedQuestPrompt {
  playerNames: string[];
  difficulty: QuestDifficulty;
}

const HARD_WORDS = /\b(hard|harder|hardest|difficult|tough|challenging|brutal|nightmare|insane|expert)\b/i;
const EASY_WORDS = /\b(easy|easier|gentle|simple|casual|relaxed|beginners?|chill|cozy)\b/i;
const NORMAL_WORDS = /\b(normal|medium|regular|standard|moderate)\b/i;

/** Words that start a list of names. */
const LIST_STARTERS = new Set(['with', 'for', 'and', 'plus', '&', ',', 'featuring', 'including', 'invite', 'inviting']);
const SELF_WORDS = new Set(['me', 'myself', 'i']);
/** Capitalized words that are never names. */
const NOT_NAMES = new Set([
  'a', 'an', 'the', 'set', 'setup', 'start', 'create', 'make', 'begin', 'open', 'new', 'quest',
  'game', 'room', 'run', 'adventure', 'story', 'please', 'hey', 'hi', 'hello', 'muse', 'it', 'us',
  'we', 'them', 'they', 'everyone', 'everybody', 'team', 'friends', 'friend', 'my', 'our',
  'hard', 'harder', 'difficult', 'tough', 'easy', 'easier', 'normal', 'medium', 'mode',
  'difficulty', 'level', 'can', 'could', 'would', 'will', 'let', "let's", 'lets', 'thanks',
  'thank', 'you', 'ok', 'okay', 'so', 'then', 'now', 'today', 'tonight', 'boss', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'spellbearer', 'partner',
  "i'm", 'i’m', "i'd", "i'll",
]);

function isNameToken(token: string): boolean {
  return /^[A-Z][A-Za-z'’-]*$/.test(token) && !NOT_NAMES.has(token.toLowerCase());
}

function stripPossessive(name: string): string {
  return name.replace(/['’]s$/i, '');
}

export function parseDifficulty(prompt: string): QuestDifficulty {
  if (HARD_WORDS.test(prompt)) return 'hard';
  if (EASY_WORDS.test(prompt)) return 'easy';
  if (NORMAL_WORDS.test(prompt)) return 'normal';
  return 'normal';
}

/** "I'm Maya", "I am Maya", "my name is Maya", "this is Maya". */
function parseSelfName(prompt: string): string | null {
  const m = /\b(?:[Ii]['’]?m|[Ii] am|[Mm]y name is|[Tt]his is|[Cc]all me)\s+([A-Z][A-Za-z'’-]*)/.exec(prompt);
  if (!m?.[1] || NOT_NAMES.has(m[1].toLowerCase())) return null;
  return stripPossessive(m[1]);
}

/**
 * Pulls player names and difficulty out of a request like "Set up a quest for me and Dev,
 * make it hard". Names are capitalized words in a list started by "me and", "with", "for",
 * or commas. The asker ("me") always plays first, as `hostName`, a name they gave ("I'm
 * Maya"), or "Spellbearer".
 */
export function parseQuestPrompt(prompt: string, hostName?: string): ParsedQuestPrompt {
  const text = prompt.slice(0, MAX_PROMPT_CHARS);
  const selfName = cleanPlayerName(hostName ?? '') || parseSelfName(text) || DEFAULT_HOST_NAME;
  // Sentence punctuation is kept as a token so it ends a name list.
  const tokens = text.match(/[A-Za-z][A-Za-z'’-]*|[,&.!?;:]/g) ?? [];

  const names: string[] = [];
  let inList = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (SELF_WORDS.has(lower)) {
      // "me and Dev" / "Dev and me": "me" continues or starts a list.
      inList = true;
      continue;
    }
    if (LIST_STARTERS.has(lower)) {
      inList = true;
      continue;
    }
    if (inList && isNameToken(token)) {
      names.push(stripPossessive(token));
      continue;
    }
    inList = false;
  }

  const seen = new Set<string>([selfName.toLowerCase()]);
  const playerNames = [selfName];
  for (const raw of names) {
    const name = cleanPlayerName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    playerNames.push(name);
    if (playerNames.length >= MAX_QUEST_PLAYERS) break;
  }
  return { playerNames, difficulty: parseDifficulty(text) };
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

interface QuestLinks {
  roomCode?: string;
  joinLink?: string;
  players?: { playerName: string; joinLink: string }[];
  difficulty?: string;
}

function linksFrom(result: QuestToolResult): QuestLinks {
  if (!result.ok) return {};
  const d = result.data;
  return {
    roomCode: typeof d.roomCode === 'string' ? d.roomCode : undefined,
    joinLink: typeof d.joinLink === 'string' ? d.joinLink : undefined,
    players: Array.isArray(d.players) ? (d.players as QuestLinks['players']) : undefined,
    difficulty: typeof d.difficulty === 'string' ? d.difficulty : undefined,
  };
}

function scriptedReply(links: QuestLinks): string {
  const names = links.players?.map((p) => p.playerName) ?? [];
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const others = (links.players ?? []).slice(1);
  return [
    `Once upon a time, a ${links.difficulty ?? 'new'} quest opened in room ${links.roomCode}${who ? ` for ${who}` : ''}.`,
    ...others.map((p) => `${p.playerName} can join here: ${p.joinLink}`),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Muse tool loop
// ---------------------------------------------------------------------------

const QUEST_SYSTEM_PROMPT = [
  'You are Muse, the Quest Master for Once Upon a Memory, a co-op fairy-tale game played on two laptops.',
  'Turn the request into tool calls. To set up a quest, call create_quest once with the person asking as the first player name.',
  'If they call themselves "me" and give no name, use "{HOST}" for them. Pick the difficulty from their words (default normal).',
  'Call list_memory_cards first only if they mention a specific memory. Use get_quest_status for questions about a room, and invite_player to add someone to an existing room.',
  'When you are done, reply in one or two short, warm storybook sentences with the room code. Do not invent room codes or links.',
].join(' ');

export async function runQuestChat(
  ctx: ServerContext,
  prompt: string,
  hostName?: string,
): Promise<QuestChatResponse> {
  const text = prompt.slice(0, MAX_PROMPT_CHARS);
  const toolCalls: ToolCallRecord[] = [];
  let links: QuestLinks = {};
  let reply = '';

  const muse = ctx.ai.muse;
  if (muse?.available) {
    const host = cleanPlayerName(hostName ?? '') || DEFAULT_HOST_NAME;
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: QUEST_SYSTEM_PROMPT.replace('{HOST}', host) },
      { role: 'user', content: text },
    ];
    const tools = questToolsForMuse();
    const deadline = Date.now() + QUEST_CHAT_BUDGET_MS;
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) break;
      const msg = await muse.complete({
        messages,
        tools,
        toolChoice: 'auto',
        temperature: 0.3,
        maxTokens: 500,
        timeoutMs: Math.min(remaining, QUEST_CHAT_CALL_TIMEOUT_MS),
      });
      if (!msg) break;
      const calls = (msg.tool_calls ?? []).filter(
        (tc): tc is Extract<ChatCompletionMessageToolCall, { type: 'function' }> => tc.type === 'function',
      );
      if (calls.length === 0) {
        reply = typeof msg.content === 'string' ? msg.content.trim() : '';
        break;
      }
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args: unknown;
        let result: QuestToolResult;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = await executeQuestTool(ctx, call.function.name, args);
        } catch {
          args = call.function.arguments;
          result = { ok: false, error: 'Arguments were not valid JSON.' };
        }
        toolCalls.push({
          name: call.function.name,
          args,
          result: result.ok ? result.data : { error: result.error },
        });
        if (result.ok && call.function.name === 'create_quest') links = linksFrom(result);
        if (result.ok && call.function.name === 'invite_player' && !links.joinLink) {
          links = { ...links, ...linksFrom(result) };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.ok ? `${result.text}\n${JSON.stringify(result.data)}` : `Error: ${result.error}`,
        });
      }
    }
  }

  // Listing cards alone does not answer the request; a quest, invite or status does.
  const museSucceeded = toolCalls.some(
    (c) =>
      c.name !== 'list_memory_cards' &&
      !(c.result && typeof c.result === 'object' && 'error' in c.result),
  );
  if (!museSucceeded) {
    // Muse unavailable, failed, or produced no useful call: parse the prompt ourselves.
    const parsed = parseQuestPrompt(text, hostName);
    const args = { difficulty: parsed.difficulty, player_names: parsed.playerNames };
    const result = await executeQuestTool(ctx, 'create_quest', args);
    toolCalls.push({ name: 'create_quest', args, result: result.ok ? result.data : { error: result.error } });
    if (!result.ok) throw new Error(result.error);
    links = linksFrom(result);
    reply = '';
  }

  if (!reply) {
    reply = links.roomCode ? scriptedReply(links) : 'The Quest Master has done as you asked.';
  }
  if (reply.length > MAX_REPLY_CHARS) reply = `${reply.slice(0, MAX_REPLY_CHARS - 1)}…`;

  return { reply, roomCode: links.roomCode, joinLink: links.joinLink, toolCalls };
}

// ---------------------------------------------------------------------------
// Rate limit and route
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** True when the key may proceed; counts the hit. */
  hit(key: string, now?: number): boolean;
}

/** Fixed-window in-memory limiter: `limit` hits per `windowMs` per key. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now = Date.now()) {
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      w.count++;
      return w.count <= limit;
    },
  };
}

export const QUEST_CHAT_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

export function registerQuestChatRoute(
  app: Express,
  ctx: ServerContext,
  limiter: RateLimiter = createRateLimiter(QUEST_CHAT_RATE_LIMIT.limit, QUEST_CHAT_RATE_LIMIT.windowMs),
): void {
  app.post('/api/quest-chat', async (req: Request, res: Response) => {
    if (!limiter.hit(req.ip ?? req.socket.remoteAddress ?? 'unknown')) {
      res.setHeader('Retry-After', String(Math.ceil(QUEST_CHAT_RATE_LIMIT.windowMs / 1000)));
      res.status(429).json({ error: 'Too many quest requests. Try again in a minute.' });
      return;
    }
    const body = (req.body ?? {}) as Partial<QuestChatRequest> & { hostName?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt === '') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    const hostName = typeof body.hostName === 'string' ? body.hostName : undefined;
    try {
      const response = await runQuestChat(ctx, prompt, hostName);
      res.json(response);
    } catch (err) {
      console.error('[quest-chat] failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'The Quest Master could not open a quest. Try again.' });
    }
  });
}
