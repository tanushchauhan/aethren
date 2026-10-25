/**
 * Boss agent and Quest Master (Agent 1C). STUB: replace freely, keeping the exported signatures.
 *
 * Exports `createBossPlanner(ai)` (implements `BossPlanner` from `../contracts.ts`) and
 * `registerAgentRoutes(app, ctx)` for `POST /api/quest-chat` and the `/mcp` endpoint.
 */
import type { Express } from 'express';
import { DEFENSE_WINDOW_MS, WARD_HP_RATIO } from '@once-upon/shared';
import type { BossPlan, QuestChatRequest, QuestChatResponse, QuestDifficulty } from '@once-upon/shared';
import type { AiService, BossPlanner, BossPlannerInput, ServerContext } from '../contracts';

/** Scripted cycle: the template's attacks in order, alternating a single target. */
function scriptedPlan(input: BossPlannerInput): BossPlan {
  const attacks = input.enemy.attacks.length > 0 ? input.enemy.attacks : (['low_sweep'] as const);
  const attackType = attacks[input.roundIndex % attacks.length]!;
  const ids = input.players.map((p) => p.id);
  const target = ids.length > 0 ? [ids[input.roundIndex % ids.length]!] : [];
  const raiseWard =
    input.isBoss &&
    !input.wardActive &&
    !input.wardRaisedThisPhase &&
    input.enemyHp < input.enemyMaxHp * WARD_HP_RATIO;
  return {
    attackType,
    targetPlayerIds: target,
    defenseWindowMs: DEFENSE_WINDOW_MS.default,
    raiseWard,
    taunt: null,
    effects: [],
    source: 'scripted',
  };
}

export function createBossPlanner(_ai: AiService): BossPlanner {
  return {
    planNextRound: async (input) => scriptedPlan(input),
  };
}

export function registerAgentRoutes(app: Express, ctx: ServerContext): void {
  // Stub quest box: creates a room for the prompt without calling Muse Spark.
  app.post('/api/quest-chat', async (req, res) => {
    const { prompt } = (req.body ?? {}) as Partial<QuestChatRequest>;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    const lower = prompt.toLowerCase();
    const difficulty: QuestDifficulty = lower.includes('hard')
      ? 'hard'
      : lower.includes('easy')
        ? 'easy'
        : 'normal';
    const args = { hostName: 'Spellbearer', hostRole: 'spellbearer' as const, difficulty };
    const { roomCode } = await ctx.rooms.createRoom(args);
    const joinLink = ctx.rooms.buildJoinLink(roomCode);
    const body: QuestChatResponse = {
      reply: `Your quest awaits in room ${roomCode}.`,
      roomCode,
      joinLink,
      toolCalls: [{ name: 'create_quest', args, result: { roomCode } }],
    };
    res.json(body);
  });

  // Placeholder for the MCP Streamable HTTP endpoint (Bearer auth via config.mcpBearerToken).
  app.all('/mcp', (_req, res) => {
    res.status(501).json({ error: 'MCP server not implemented yet' });
  });
}
