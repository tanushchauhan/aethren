import { describe, expect, it } from 'vitest';
import { TAUNT_MAX_CHARS } from '@once-upon/shared';
import type { MemoryCard } from '@once-upon/shared';
import type { WorldGenInput } from '../contracts';
import { CACHED_WORLD, createAiServiceWith } from './service';
import { createMuseChat } from './spark';
import { completion, hang, sparkRuntime, testRuntime } from './test-utils';
import {
  clampIncantation,
  clampWorld,
  generateWorldDetailed,
  StrictWorldSchema,
  WORLD_JSON_SCHEMA,
  withPlayerNames,
} from './world';

const roadCard: MemoryCard = {
  id: 'card-road',
  quote: 'the car is making the noise again',
  date: '2025-07-12',
  people: ['Ana', 'Ben'],
  mood: 'chaotic',
  color: '#E85D04',
};
const examCard: MemoryCard = { ...roadCard, id: 'card-exam', quote: 'nobody has started the essay', mood: 'dread' };

const input: WorldGenInput = {
  cards: [roadCard, examCard],
  encounterCard: roadCard,
  bossCard: examCard,
  playerNames: ['Ana', 'Ben'],
  difficulty: 'normal',
};

const ctx = { cached: CACHED_WORLD, encounterCard: roadCard, bossCard: examCard };

function museWorld(): Record<string, unknown> {
  return {
    title: 'The Clattering Hollow',
    intro: 'Once upon a time, Ana and Ben broke down in a wood that listens.',
    incantations: {
      ember: 'the noise again burn bright',
      frost: 'nobody has started yet',
      bloom: 'forty miles of flowers here',
      storm: 'making the noise louder now',
      moon: 'essay by the moonlight please',
      starlight: 'again and again we shine',
    },
    encounters: [
      {
        memory: 'whatever',
        name: 'The Clanking Carriage',
        template: 'charger',
        attacks: ['low_sweep', 'high_swing'],
        weakness: 'bloom',
        tier: 1,
        lines: ['It rattles toward you!'],
        art_prompt: 'A rattling carriage beast in a moonlit wood',
      },
    ],
    boss: {
      memory: 'x',
      name: 'The Blank Page Witch',
      template: 'caster',
      attacks: ['projectile', 'high_swing', 'low_sweep'],
      weakness: 'frost',
      tier: 3,
      ward: 'twin_cast',
      lines: ['Not one word written!'],
      art_prompt: 'A witch made of empty paper',
    },
  };
}

describe('cached demo world', () => {
  it('passes the strict schema and has all six incantations', () => {
    expect(StrictWorldSchema.safeParse(CACHED_WORLD).success).toBe(true);
    expect(Object.keys(CACHED_WORLD.incantations).sort()).toEqual(
      ['bloom', 'ember', 'frost', 'moon', 'starlight', 'storm'],
    );
  });

  it('getCachedWorld returns a copy callers can mutate', () => {
    const ai = createAiServiceWith(testRuntime());
    const a = ai.getCachedWorld();
    a.title = 'changed';
    expect(ai.getCachedWorld().title).toBe(CACHED_WORLD.title);
  });

  it('swaps the sample names for the real players', () => {
    const w = withPlayerNames(CACHED_WORLD, ['Dev', 'Zoe']);
    expect(w.intro).toContain('Dev and Zoe');
    expect(w.boss.lines.join(' ')).toContain('Dev, Zoe,');
    expect(w.incantations).toEqual(CACHED_WORLD.incantations);
  });
});

describe('WORLD_JSON_SCHEMA', () => {
  it('is snake_case and strict-mode friendly', () => {
    const enemy = WORLD_JSON_SCHEMA.properties.boss;
    expect(enemy.required).toContain('art_prompt');
    expect(enemy.required).toContain('ward');
    expect(enemy.additionalProperties).toBe(false);
  });
});

describe('clampWorld', () => {
  it('maps art_prompt, sets weakness from the card mood and the memory to the card id', () => {
    const w = clampWorld(museWorld(), ctx)!;
    expect(StrictWorldSchema.safeParse(w).success).toBe(true);
    expect(w.encounters[0]!.artPrompt).toBe('A rattling carriage beast in a moonlit wood');
    expect(w.encounters[0]!.weakness).toBe('frost');
    expect(w.boss.weakness).toBe('ember');
    expect(w.encounters[0]!.memory).toBe('card-road');
    expect(w.boss.memory).toBe('card-exam');
  });

  it('clamps bad values and fills gaps from the cached world', () => {
    const raw = museWorld();
    const enc = (raw.encounters as Record<string, unknown>[])[0]!;
    enc.template = 'dragon';
    enc.attacks = ['stare', 'ground_wave', 'teleport'];
    enc.tier = 9;
    enc.lines = ['x'.repeat(300), 42, ''];
    const boss = raw.boss as Record<string, unknown>;
    boss.tier = 1;
    boss.ward = 'nope';
    boss.attacks = ['projectile', 'projectile'];
    raw.incantations = { ember: 'burn', frost: 'nobody has started yet', bloom: 'NOBODY has started yet!' };
    const w = clampWorld(raw, ctx)!;
    expect(StrictWorldSchema.safeParse(w).success).toBe(true);
    expect(w.encounters[0]!.template).toBe('charger');
    expect(w.encounters[0]!.attacks.every((a) => ['low_sweep', 'high_swing', 'projectile'].includes(a))).toBe(true);
    expect(w.encounters[0]!.attacks.length).toBeGreaterThanOrEqual(2);
    expect(w.encounters[0]!.tier).toBe(3);
    expect(w.encounters[0]!.lines).toHaveLength(1);
    expect(w.encounters[0]!.lines[0]!.length).toBeLessThanOrEqual(TAUNT_MAX_CHARS);
    expect(w.boss.tier).toBe(3);
    expect(w.boss.ward).toBe('twin_cast');
    expect(w.boss.attacks).toContain('projectile');
    expect(w.boss.attacks.length).toBeGreaterThanOrEqual(2);
    expect(w.incantations.ember).toBe(CACHED_WORLD.incantations.ember);
    expect(w.incantations.frost).toBe('nobody has started yet');
    expect(w.incantations.bloom).toBe(CACHED_WORLD.incantations.bloom);
    expect(w.incantations.starlight).toBe(CACHED_WORLD.incantations.starlight);
  });

  it('keeps only one encounter in P0', () => {
    const raw = museWorld();
    raw.encounters = [...(raw.encounters as unknown[]), ...(raw.encounters as unknown[])];
    expect(clampWorld(raw, ctx)!.encounters).toHaveLength(1);
  });

  it('rejects things that are not a world', () => {
    expect(clampWorld('nope', ctx)).toBeNull();
    expect(clampWorld({ title: 'x', encounters: [], boss: null }, ctx)).toBeNull();
  });

  it('clamps incantations to 3..7 speakable words', () => {
    expect(clampIncantation('By the Corolla that would not start, burn!')).toBe('by the corolla that would not start');
    expect(clampIncantation('too short')).toBeNull();
    expect(clampIncantation(7)).toBeNull();
  });
});

describe('generateWorldDetailed', () => {
  const opts = { cached: CACHED_WORLD, useCachedWorld: false, timeoutMs: 3000 };

  it('returns the clamped Muse world', async () => {
    const { rt, client } = sparkRuntime(() => completion(JSON.stringify(museWorld())));
    const res = await generateWorldDetailed(createMuseChat(rt), input, opts);
    expect(res.source).toBe('muse');
    expect(res.world.title).toBe('The Clattering Hollow');
    const call = client.calls[0]!;
    expect(call.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'storybook_world', strict: true } });
    expect(JSON.stringify(call.messages)).toContain('weakness=frost');
  });

  it('serves the cached world (with names swapped) when USE_CACHED_WORLD is set', async () => {
    const { rt, client } = sparkRuntime(() => completion(JSON.stringify(museWorld())));
    const res = await generateWorldDetailed(createMuseChat(rt), input, { ...opts, useCachedWorld: true });
    expect(res.source).toBe('cached');
    expect(res.world.intro).toContain('Ana and Ben');
    expect(client.calls).toHaveLength(0);
  });

  it('falls back when Spark is unavailable', async () => {
    const res = await generateWorldDetailed(createMuseChat(testRuntime()), input, opts);
    expect(res.source).toBe('cached');
  });

  it('falls back on invalid JSON (after one json_object retry)', async () => {
    const { rt, client } = sparkRuntime(() => completion('I am not JSON, sorry'));
    const res = await generateWorldDetailed(createMuseChat(rt), input, opts);
    expect(res.source).toBe('cached');
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.response_format).toEqual({ type: 'json_object' });
  });

  it('falls back on a timeout without rejecting', async () => {
    const { rt } = sparkRuntime((_b, o) => hang(o));
    const started = Date.now();
    const res = await generateWorldDetailed(createMuseChat(rt), input, { ...opts, timeoutMs: 150 });
    expect(res.source).toBe('cached');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('falls back when the client throws', async () => {
    const { rt } = sparkRuntime(() => {
      throw Object.assign(new Error('boom'), { status: 500 });
    });
    const ai = createAiServiceWith(rt);
    const world = await ai.generateWorld(input);
    expect(world.title).toBe(CACHED_WORLD.title);
  });
});
