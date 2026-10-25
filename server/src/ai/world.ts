/**
 * World generation: one Muse Spark structured-output call, then a zod clamp that forces every
 * field into what the game's code allows. Anything missing comes from the cached world, so the
 * result is always playable. `generateWorld` never rejects.
 */
import { z } from 'zod';
import { ENEMY_TEMPLATES, P0_ELEMENTS, TAUNT_MAX_CHARS } from '@once-upon/shared';
import type {
  AttackType,
  BossSchema,
  ElementType,
  EncounterSchema,
  EncounterTemplate,
  IncantationMap,
  MemoryCard,
  P0ElementType,
  WorldSchema,
} from '@once-upon/shared';
import type { MuseChat, WorldGenInput } from '../contracts';
import { weaknessForMood } from './moods';
import { sparkJson } from './spark';
import { clipSentences, clipText, normalizeText } from './text';

export const ALL_ELEMENTS: ElementType[] = ['ember', 'frost', 'bloom', 'storm', 'moon', 'starlight'];
export const TEMPLATES: EncounterTemplate[] = ['charger', 'caster', 'swarm', 'guardian'];
export const P0_ATTACKS: AttackType[] = ['low_sweep', 'high_swing', 'projectile'];
/** The names the cached world is written with; swapped for the real players on fallback. */
export const CACHED_PLAYER_NAMES = ['Maya', 'Dev'] as const;

const INCANTATION_MIN_WORDS = 3;
const INCANTATION_MAX_WORDS = 7;
const MAX_LINES = 6;

function enemyJsonSchema(isBoss: boolean) {
  const properties: Record<string, unknown> = {
    memory: { type: 'string', description: 'The id of the memory card this enemy came from' },
    name: { type: 'string' },
    template: { type: 'string', enum: TEMPLATES },
    attacks: { type: 'array', items: { type: 'string', enum: P0_ATTACKS } },
    weakness: { type: 'string', enum: [...P0_ELEMENTS] },
    tier: { type: 'integer', enum: isBoss ? [3] : [1, 2, 3] },
    lines: { type: 'array', items: { type: 'string' } },
    art_prompt: { type: 'string' },
  };
  if (isBoss) properties.ward = { type: 'string', enum: ['twin_cast'] };
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** `WorldSchema` in snake_case for Muse structured output (strict mode). */
export const WORLD_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    intro: { type: 'string' },
    incantations: {
      type: 'object',
      properties: Object.fromEntries(ALL_ELEMENTS.map((e) => [e, { type: 'string' }])),
      required: ALL_ELEMENTS,
      additionalProperties: false,
    },
    encounters: { type: 'array', items: enemyJsonSchema(false) },
    boss: enemyJsonSchema(true),
  },
  required: ['title', 'intro', 'incantations', 'encounters', 'boss'],
  additionalProperties: false,
} as const;

export const WORLD_SYSTEM_PROMPT = `You are the Narrator of a fairy-tale picture book, and you build one short adventure from a group of friends' real shared memories.
Write warm, whimsical, slightly mischievous storybook prose, like a bedtime story read aloud. Keep it kind: tease the memory, never the people.

Return JSON with:
- title: the name of the enchanted place, 3 to 6 words.
- intro: 2 to 4 sentences read aloud at the start, naming the players and hinting at both memories. Under 450 characters.
- incantations: one magic phrase per element (ember, frost, bloom, storm, moon, starlight). Each is 3 to 7 plain, speakable words lifted from real phrases in the memory quotes, so inside jokes become magic words. Every phrase must sound clearly different from the others (different first words and rhythms) so a speech recognizer can tell them apart. No names, no numbers as digits, no emoji, no punctuation.
- encounters: exactly ONE encounter, built from the encounter memory.
- boss: built from the boss memory, always tier 3, ward "twin_cast".
For each enemy:
- memory: the id of the memory card it came from.
- name: an original fairy-tale creature name that winks at the memory (for example, a road-trip breakdown might become "The Rusted Iron Steed").
- template: charger (rushes in), caster (throws things), swarm (many small pests) or guardian (big, slow, tough). Pick what fits.
- attacks: two or three of low_sweep (players side-step), high_swing (players duck), projectile (players parry).
- weakness: the element given for that memory.
- tier: 1 for the encounter, 3 for the boss.
- lines: 4 or 5 taunts and attack hints in storybook voice, each under 110 characters, echoing the memory.
- art_prompt: one vivid sentence for an illustrator: the creature, the setting and the mood, in a whimsical ink-and-watercolor picture-book style. No text in the image.
Everything must be original: no existing characters, brands, franchises or celebrities.`;

function cardBlock(label: string, card: MemoryCard | null): string {
  if (!card) return `${label}: (none chosen, invent one from the other memories)`;
  return `${label}: id=${card.id}, quote="${card.quote}", date=${card.date}, people=${card.people.join(' & ')}, mood=${card.mood}, weakness=${weaknessForMood(card.mood)}`;
}

export function buildWorldUserPrompt(input: WorldGenInput): string {
  const others = input.cards
    .filter((c) => c.id !== input.encounterCard?.id && c.id !== input.bossCard?.id)
    .map((c) => `- "${c.quote}" (${c.mood})`)
    .join('\n');
  return [
    `Players: ${input.playerNames.join(' and ') || 'two friends'}`,
    `Difficulty: ${input.difficulty}`,
    cardBlock('Encounter memory', input.encounterCard),
    cardBlock('Boss memory', input.bossCard),
    others ? `Other memories from the same chat (good sources for incantation words):\n${others}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Strict schema (the cached world must pass it) and the clamp
// ---------------------------------------------------------------------------

const lineZ = z.string().min(1).max(TAUNT_MAX_CHARS);
const incantationZ = z
  .string()
  .refine((s) => {
    const n = s.trim().split(/\s+/).length;
    return n >= INCANTATION_MIN_WORDS && n <= INCANTATION_MAX_WORDS;
  }, 'incantation must be 3 to 7 words');
const encounterZ = z.object({
  memory: z.string().min(1),
  name: z.string().min(1).max(60),
  template: z.enum(['charger', 'caster', 'swarm', 'guardian']),
  attacks: z.array(z.enum(['low_sweep', 'high_swing', 'projectile'])).min(1),
  weakness: z.enum(P0_ELEMENTS),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  lines: z.array(lineZ).min(1).max(MAX_LINES),
  artPrompt: z.string().min(1).max(600),
});

/** Exactly the P0 world shape the game accepts. `cached-demo-world.json` must pass it. */
export const StrictWorldSchema = z.object({
  title: z.string().min(1).max(80),
  intro: z.string().min(1).max(600),
  incantations: z.object({
    ember: incantationZ,
    frost: incantationZ,
    bloom: incantationZ,
    storm: incantationZ,
    moon: incantationZ,
    starlight: incantationZ,
  }),
  encounters: z.array(encounterZ).length(1),
  boss: encounterZ.extend({ tier: z.literal(3), ward: z.literal('twin_cast') }),
});

const looseString = z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional());
const looseArray = z.preprocess((v) => (Array.isArray(v) ? v : undefined), z.array(z.unknown()).optional());

const RawEnemy = z
  .object({
    memory: looseString,
    name: looseString,
    template: looseString,
    attacks: looseArray,
    weakness: looseString,
    tier: z.unknown().optional(),
    lines: looseArray,
    art_prompt: looseString,
    artPrompt: looseString,
    ward: looseString,
  })
  .passthrough();

const RawWorld = z
  .object({
    title: looseString,
    intro: looseString,
    incantations: z.preprocess(
      (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined),
      z.record(z.unknown()).optional(),
    ),
    encounters: looseArray,
    boss: z.unknown().optional(),
  })
  .passthrough();

export interface ClampContext {
  cached: WorldSchema;
  encounterCard: MemoryCard | null;
  bossCard: MemoryCard | null;
}

export function clampIncantation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const words = raw
    .replace(/[^\p{L}\p{N}'\s-]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter(Boolean);
  if (words.length < INCANTATION_MIN_WORDS) return null;
  return words.slice(0, INCANTATION_MAX_WORDS).join(' ').toLowerCase();
}

function clampIncantations(raw: Record<string, unknown> | undefined, cached: IncantationMap): IncantationMap {
  const out = {} as IncantationMap;
  const seen = new Set<string>();
  for (const el of ALL_ELEMENTS) {
    let phrase = clampIncantation(raw?.[el]);
    if (phrase && seen.has(normalizeText(phrase))) phrase = null;
    if (!phrase) phrase = cached[el];
    seen.add(normalizeText(phrase));
    out[el] = phrase;
  }
  return out;
}

function clampLines(raw: unknown[] | undefined, fallback: string[]): string[] {
  const lines = (raw ?? [])
    .filter((l): l is string => typeof l === 'string')
    .map((l) => clipText(l, TAUNT_MAX_CHARS, true))
    .filter((l) => l.length > 0)
    .slice(0, MAX_LINES);
  return lines.length > 0 ? lines : fallback.slice();
}

function clampAttacks(raw: unknown[] | undefined, template: EncounterTemplate): AttackType[] {
  const picked = [
    ...new Set((raw ?? []).filter((a): a is AttackType => P0_ATTACKS.includes(a as AttackType))),
  ];
  if (picked.length >= 2) return picked;
  const defaults = ENEMY_TEMPLATES[template].defaultAttacks.filter((a) => P0_ATTACKS.includes(a));
  return [...new Set([...picked, ...defaults])].slice(0, 3);
}

function clampTier(raw: unknown): 1 | 2 | 3 {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, Math.round(n))) as 1 | 2 | 3;
}

function clampEnemy(raw: unknown, fallback: EncounterSchema, card: MemoryCard | null, isBoss: boolean): EncounterSchema | null {
  const parsed = RawEnemy.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const name = e.name ? clipText(e.name, 60) : '';
  if (!name) return null;
  const template = TEMPLATES.includes(e.template as EncounterTemplate)
    ? (e.template as EncounterTemplate)
    : isBoss
      ? 'guardian'
      : 'charger';
  const weakness: P0ElementType = card
    ? weaknessForMood(card.mood)
    : P0_ELEMENTS.includes(e.weakness as P0ElementType)
      ? (e.weakness as P0ElementType)
      : (fallback.weakness as P0ElementType);
  const art = e.art_prompt ?? e.artPrompt;
  return {
    memory: card?.id ?? (e.memory ? clipText(e.memory, 80) : fallback.memory),
    name,
    template,
    attacks: clampAttacks(e.attacks, template),
    weakness,
    tier: isBoss ? 3 : clampTier(e.tier),
    lines: clampLines(e.lines, fallback.lines),
    artPrompt: art && art.trim() ? clipText(art, 600) : `A whimsical ink-and-watercolor storybook illustration of ${name}`,
  };
}

/**
 * Forces Muse's raw world JSON into a valid {@link WorldSchema}. Returns `null` when it is
 * not usable at all (not an object, or neither an encounter nor a boss survived).
 */
export function clampWorld(raw: unknown, ctx: ClampContext): WorldSchema | null {
  const parsed = RawWorld.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== 'object') return null;
  const w = parsed.data;
  const cachedEncounter = ctx.cached.encounters[0]!;

  const encounter = clampEnemy(w.encounters?.[0], cachedEncounter, ctx.encounterCard, false);
  const bossBase = clampEnemy(w.boss, ctx.cached.boss, ctx.bossCard, true);
  if (!encounter && !bossBase) return null;

  const boss: BossSchema = { ...(bossBase ?? ctx.cached.boss), tier: 3, ward: 'twin_cast' };
  return {
    title: w.title && w.title.trim() ? clipText(w.title, 80) : ctx.cached.title,
    intro: w.intro && w.intro.trim() ? clipSentences(w.intro, 600) : ctx.cached.intro,
    incantations: clampIncantations(w.incantations, ctx.cached.incantations),
    encounters: [encounter ?? structuredClone(cachedEncounter)],
    boss,
  };
}

/** Swaps the cached world's sample names (Maya, Dev) for the real players' names. */
export function withPlayerNames(world: WorldSchema, playerNames: string[]): WorldSchema {
  const map = new Map<string, string>();
  CACHED_PLAYER_NAMES.forEach((from, i) => {
    const to = playerNames[i]?.trim();
    if (to && to !== from) map.set(from, to);
  });
  const copy = structuredClone(world);
  if (map.size === 0) return copy;
  const re = new RegExp(`\\b(${[...map.keys()].join('|')})\\b`, 'g');
  const swap = (s: string) => s.replace(re, (m) => map.get(m) ?? m);
  copy.title = swap(copy.title);
  copy.intro = swap(copy.intro);
  for (const e of [...copy.encounters, copy.boss]) {
    e.name = swap(e.name);
    e.lines = e.lines.map(swap);
  }
  return copy;
}

export interface WorldResult {
  world: WorldSchema;
  source: 'muse' | 'cached';
  reason?: string;
}

export async function generateWorldDetailed(
  muse: MuseChat,
  input: WorldGenInput,
  opts: { cached: WorldSchema; useCachedWorld: boolean; timeoutMs: number },
): Promise<WorldResult> {
  const fallback = (reason: string): WorldResult => ({
    world: withPlayerNames(opts.cached, input.playerNames),
    source: 'cached',
    reason,
  });
  try {
    if (opts.useCachedWorld) return fallback('USE_CACHED_WORLD is set');
    if (!muse.available) return fallback('Muse Spark unavailable');
    const raw = await sparkJson(muse, {
      system: WORLD_SYSTEM_PROMPT,
      user: buildWorldUserPrompt(input),
      schemaName: 'storybook_world',
      schema: WORLD_JSON_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs: opts.timeoutMs,
      temperature: 0.8,
      maxTokens: 2000,
    });
    if (raw === null) return fallback('no JSON from Muse Spark (error or timeout)');
    const world = clampWorld(raw, {
      cached: opts.cached,
      encounterCard: input.encounterCard,
      bossCard: input.bossCard,
    });
    return world ? { world, source: 'muse' } : fallback('Muse Spark JSON was not a usable world');
  } catch (err) {
    return fallback(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
