/**
 * Prewritten Narrator lines, so combat never waits on a live call. Templates use
 * `{player}`, `{enemy}`, `{element}` and `{attack}`; a template is only used when every
 * placeholder it needs is known, and every kind has at least one line with none.
 */
import { ELEMENT_META, TAUNT_MAX_CHARS } from '@once-upon/shared';
import type { ElementType } from '@once-upon/shared';
import type { NarrationEvent } from '../contracts';
import { clipText } from './text';

export const LINE_BANK: Record<string, string[]> = {
  intro: [
    'Once upon a time, in a wood that remembers everything, {player} took a deep breath and stepped inside.',
    'The pages turn by themselves, and the story begins.',
    'Gather close. This tale was written by your own words.',
  ],
  telegraph: [
    '{enemy} gathers itself. Watch closely!',
    '{enemy} draws a slow, crooked breath. Something is coming!',
    'The trees go quiet. The enemy is winding up!',
    'Something stirs in the dark. Get ready!',
  ],
  telegraph_low_sweep: [
    '{enemy} sweeps low across the ground. Step aside!',
    'A low sweep is coming. Hop out of its path!',
  ],
  telegraph_high_swing: [
    '{enemy} winds up high. Duck!',
    'A great swing comes from above. Get low!',
  ],
  telegraph_projectile: [
    '{enemy} hurls something your way. Raise your glove and parry!',
    'Something flies through the air. Bat it back!',
  ],
  dodge: [
    'Nimble as a fox in the brambles, {player} slips away!',
    'Not even close! {enemy} catches only air.',
    'A perfect dodge, light as thistledown.',
  ],
  hit: [
    'Oof! The blow lands, and {player} staggers.',
    '{enemy} lands a blow. The team loses a heart!',
    'Ouch. The wood winces with you.',
  ],
  parry: [
    '{player} sends it right back where it came from!',
    'Parried! {enemy} gets a taste of its own magic.',
    'Bonk! Straight back to sender.',
  ],
  cast: [
    '{player} speaks the words, and {element} answers the call!',
    'A burst of {element} magic blooms from {player}\'s glove!',
    'The old words work. Magic crackles through the air!',
  ],
  fizzle: [
    '{player}\'s words tangle, and the spell fizzles into sparks.',
    'Pfft. The magic sputters. Say it like you mean it!',
    'The spell fizzles. Even magic needs the right words.',
  ],
  twin_cast: [
    '{player}, two voices, one spell! The air itself sings!',
    'Twin Cast! Two friends, one perfect spell!',
    'Two voices together. The magic doubles!',
  ],
  ward_raised: [
    '{enemy} raises a shimmering ward. Only two voices together can break it.',
    'A ward of glass and moonlight rises. Cast together to shatter it!',
  ],
  ward_shattered: [
    'The ward shatters like spun sugar!',
    'Crack! {enemy}\'s ward falls to pieces!',
  ],
  enemy_defeated: [
    '{enemy} crumbles into leaves and moonlight.',
    'With a last sigh, {enemy} fades into the pages.',
    'The creature crumbles into leaves and moonlight.',
  ],
  boss_learned: [
    '{enemy} narrows its eyes. It has learned your habits.',
    'The boss has been watching. It knows which way you dodge.',
  ],
  victory: [
    'And {player} lived happily ever after, until the next group chat.',
    'The wood falls quiet, the book closes, and they lived happily ever after.',
  ],
  defeat: [
    'The candle gutters, and the tale ends early. For now.',
    'And so the story pauses, waiting for braver pages.',
  ],
  default: ['The wood holds its breath.', 'The story goes on.'],
};

export interface LineContext {
  player?: string;
  enemy?: string;
  element?: string;
  attack?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Pulls the template values out of an event's free-form context. */
export function lineContext(context: Record<string, unknown>): LineContext {
  const names = Array.isArray(context.playerNames)
    ? context.playerNames.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : [];
  const element = str(context.element);
  const label = element && element in ELEMENT_META ? ELEMENT_META[element as ElementType].label : element;
  return {
    player: str(context.playerName) ?? str(context.player) ?? (names.length ? names.join(' and ') : undefined),
    enemy: str(context.enemyName) ?? str(context.enemy) ?? str(context.bossName),
    element: label,
    attack: str(context.attackType) ?? str(context.attack),
  };
}

const PLACEHOLDER = /\{(player|enemy|element|attack)\}/g;

export function fillTemplate(template: string, ctx: LineContext): string | null {
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_, key: keyof LineContext) => {
    const v = ctx[key];
    if (!v) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

const rotation = new Map<string, number>();

/** A prewritten line for the event, rotating through the bank so lines rarely repeat. */
export function fallbackLine(event: NarrationEvent): string {
  const ctx = lineContext(event.context ?? {});
  const kinds = [];
  if (event.kind === 'telegraph' && ctx.attack) kinds.push(`telegraph_${ctx.attack}`);
  kinds.push(event.kind, 'default');
  for (const kind of kinds) {
    const bank = LINE_BANK[kind];
    if (!bank) continue;
    const filled = bank.map((t) => fillTemplate(t, ctx)).filter((l): l is string => l !== null);
    if (filled.length === 0) continue;
    const i = rotation.get(kind) ?? 0;
    rotation.set(kind, i + 1);
    return clipText(filled[i % filled.length]!, TAUNT_MAX_CHARS, true);
  }
  return LINE_BANK.default![0]!;
}

/** Every line the bank could produce for these contexts (used to pre-warm TTS). */
export function allLinesFor(kinds: string[], ctx: LineContext): string[] {
  return kinds.flatMap((k) =>
    (LINE_BANK[k] ?? []).map((t) => fillTemplate(t, ctx)).filter((l): l is string => l !== null),
  );
}
