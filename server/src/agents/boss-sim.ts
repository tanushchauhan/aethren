/**
 * Boss agent simulation: 6 rounds of synthetic input through the planner and the scripted
 * fallback, printing both plans per round.
 *
 *   pnpm --filter @once-upon/server exec tsx src/agents/boss-sim.ts          # real Muse if MUSE_API_KEY is set
 *   pnpm --filter @once-upon/server exec tsx src/agents/boss-sim.ts --fake   # scripted fake Muse
 *
 * The fake Muse reads the same JSON user message Spark would get and answers with tool calls,
 * including one malformed reply (round 3) and one that misses the deadline (round 4), so both
 * fallback paths show up. Live runs use the game's actual Muse adapter.
 */
import { createAiService } from '../ai';
import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import { BOSS_AGENT_DEADLINE_MS } from '@once-upon/shared';
import type { BossPlan, P0ElementType } from '@once-upon/shared';
import { config } from '../config';
import type { AiService, BossPlannerInput, DodgeHistoryEntry, MuseChat } from '../contracts';
import { createBossPlanner, scriptedPlan, summarizeHabits } from './boss-agent';
import { DEV, LIBRARIAN, MAYA, makeBossInput } from './boss-fixtures';

const useFake = process.argv.includes('--fake') || !config.muse.apiKey;

function toolReply(calls: { name: string; args: unknown }[], rawArgs?: string): ChatCompletionMessage {
  return {
    role: 'assistant',
    content: null,
    refusal: null,
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: c.name, arguments: rawArgs ?? JSON.stringify(c.args) },
    })),
  } as ChatCompletionMessage;
}

/** A fake Spark that plays the boss from the summary JSON, like the prompt asks. */
function fakeMuse(): MuseChat {
  return {
    available: true,
    async complete(req) {
      const user = req.messages.find((m) => m.role === 'user');
      const s = JSON.parse(String(user?.content ?? '{}'));
      if (s.round === 3) return toolReply([{ name: 'choose_attack', args: null }], '{"pattern": "high_sw');
      if (s.round === 4) {
        // Too slow: the deadline guard aborts us and the scripted plan answers.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, BOSS_AGENT_DEADLINE_MS + 1500);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        }).catch(() => null);
        return null;
      }
      const habit = s.habitTarget as { id: string; name: string; keepsDodging: string } | null;
      const players = s.players as { id: string; name: string }[];
      const target = habit?.id ?? players[s.round % players.length]!.id;
      // A side-stepper gets a high swing; a ducker gets a low sweep.
      const pattern = habit?.keepsDodging === 'down' ? 'low_sweep' : habit ? 'high_swing' : 'projectile';
      const calls: { name: string; args: unknown }[] = [
        { name: 'choose_attack', args: { pattern, targets: s.team.easeOff ? [target] : [target] } },
        { name: 'adjust_timing', args: { ms: s.team.easeOff ? 2000 : s.overusedElement === 'frost' ? 1100 : 1300 } },
      ];
      if (s.enemy.canRaiseWard) calls.push({ name: 'raise_ward', args: {} });
      calls.push({
        name: 'taunt',
        args: {
          line: s.team.easeOff
            ? 'Rest a moment, little ones. Even librarians allow one last page.'
            : habit
              ? `The Night Librarian has learned your habits, ${habit.name}. Always ${habit.keepsDodging}!`
              : 'Shhh. The library is closing.',
        },
      });
      calls.push({ name: 'trigger_effect', args: { name: s.team.easeOff ? 'tick' : 'hit' } });
      return toolReply(calls);
    },
  };
}

/** Use the same provider adapter as the running game. */
function realMuse(): MuseChat {
  return createAiService().muse;
}

/** Six rounds: Dev keeps side-stepping left, the team spams ember, HP and hearts fall. */
function syntheticRounds(): BossPlannerInput[] {
  const hp = [160, 135, 110, 76, 58, 40];
  const hearts = [5, 5, 4, 3, 2, 1];
  const devDirs: DodgeHistoryEntry['direction'][] = ['right', 'left', 'left', 'left', 'left', 'left'];
  const mayaDirs: DodgeHistoryEntry['direction'][] = ['down', 'left', 'right', 'down', 'right', 'left'];
  const elements: P0ElementType[] = ['ember', 'frost', 'ember', 'ember', 'bloom', 'ember', 'ember', 'ember', 'frost', 'ember'];
  return hp.map((enemyHp, round) => {
    const hist = (dirs: DodgeHistoryEntry['direction'][]) =>
      dirs.slice(0, round).map((direction, i) => ({
        roundIndex: i,
        attackType: 'low_sweep' as const,
        dodged: i !== 2,
        parried: false,
        direction,
      }));
    return makeBossInput({
      enemy: LIBRARIAN,
      roundIndex: round,
      enemyHp,
      hearts: hearts[round]!,
      dodgeHistory: { [MAYA.id]: hist(mayaDirs), [DEV.id]: hist(devDirs) },
      recentElements: elements.slice(0, round * 2),
    });
  });
}

const names: Record<string, string> = { [MAYA.id]: MAYA.name, [DEV.id]: DEV.name };

function show(label: string, plan: BossPlan, ms?: number): string {
  const targets = plan.targetPlayerIds.map((id) => names[id] ?? id).join('+');
  return `  ${label.padEnd(9)} [${plan.source.padEnd(8)}] ${plan.attackType.padEnd(10)} -> ${targets.padEnd(9)} window=${plan.defenseWindowMs}ms ward=${plan.raiseWard ? 'RAISE' : 'no'} effects=[${plan.effects.join(',')}]${ms !== undefined ? ` (${ms}ms)` : ''}\n            taunt: ${plan.taunt ?? '(none)'}`;
}

async function main(): Promise<void> {
  const muse = useFake ? fakeMuse() : realMuse();
  const ai = { muse } as unknown as AiService;
  const planner = createBossPlanner(ai);
  console.log(`Boss sim: ${LIBRARIAN.name}, 6 rounds, deadline ${BOSS_AGENT_DEADLINE_MS}ms, Muse: ${useFake ? 'fake' : `live (${config.muse.sparkModel})`}`);

  let wardRaisedThisPhase = false;
  for (const base of syntheticRounds()) {
    const input = { ...base, wardRaisedThisPhase, wardActive: wardRaisedThisPhase && base.roundIndex < 5 };
    const habits = summarizeHabits(input);
    const habit = habits.habitTarget
      ? `${habits.habitTarget.name} ${habits.habitTarget.streakDirection} x${habits.habitTarget.streak}`
      : 'none';
    console.log(
      `\nRound ${input.roundIndex}: HP ${input.enemyHp}/${input.enemyMaxHp}, hearts ${input.hearts}/${input.maxHearts}, ward ${input.wardActive ? 'up' : 'down'}, habit ${habit}, elements ${JSON.stringify(habits.elementCounts)} overused=${habits.overusedElement ?? 'none'}`,
    );
    const started = Date.now();
    const plan = await planner.planNextRound(input, BOSS_AGENT_DEADLINE_MS);
    console.log(show('planner', plan, Date.now() - started));
    console.log(show('scripted', scriptedPlan(input)));
    if (plan.raiseWard) wardRaisedThisPhase = true;
  }
}

await main();
