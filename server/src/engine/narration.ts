/**
 * Engine-side fallback lines, used when `ai.narrate` is slow, empty or fails, so the
 * Narrator never goes silent mid-demo.
 */
import type { NarrationEvent } from '../contracts';

/** How long the engine waits on `ai.narrate` before using its own line. */
export const NARRATE_TIMEOUT_MS = 1500;

type Facts = Record<string, unknown>;

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v : fallback);

export function fallbackLine(kind: NarrationEvent['kind'], facts: Facts = {}): string {
  const enemy = str(facts.enemyName, 'the creature');
  const player = str(facts.playerName, 'our hero');
  switch (kind) {
    case 'dodge':
      return 'Nimble as a fox in the brambles!';
    case 'hit':
      return `Oof! ${enemy} lands a blow.`;
    case 'parry':
      return `${player} sends it right back at ${enemy}!`;
    case 'fizzle':
      return `${player}'s words tangle, and the spell fizzles out.`;
    case 'twin_cast':
      return 'Two voices, one spell!';
    case 'ward_raised':
      return `${enemy} raises a shimmering ward. Only two voices together can break it!`;
    case 'ward_shattered':
      return 'The ward shatters like spun sugar!';
    case 'enemy_defeated':
      return `${enemy} crumbles into leaves and moonlight.`;
    case 'boss_entrance':
      return `The path darkens. ${enemy} awaits.`;
    case 'victory':
      return 'And they lived happily ever after.';
    case 'defeat':
      return 'And so the tale ends early, for now.';
    default:
      return 'The wood holds its breath.';
  }
}
