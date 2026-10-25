/**
 * Bot seat behavior (pure decisions; the engine schedules them). A bot fills a dropped seat
 * after `DISCONNECT_PAUSE_MS`, or an empty P0 seat when a run starts with one human.
 */
import { P0_ELEMENTS } from '@once-upon/shared';
import type { AttackType, GestureType, P0ElementType, TranscribeResponse } from '@once-upon/shared';

export const BOT_DODGE_CHANCE = 0.7;
/** Of the bot's successful defenses against a projectile, this share are parries (Spellbearer seat only). */
export const BOT_PARRY_SHARE = 0.4;
export const BOT_NAME = 'Wisp';

export type Rng = () => number;

export function botDodge(rng: Rng, attackType: AttackType, canParry: boolean): { dodged: boolean; parried: boolean } {
  if (rng() >= BOT_DODGE_CHANCE) return { dodged: false, parried: false };
  const parried = attackType === 'projectile' && canParry && rng() < BOT_PARRY_SHARE;
  return { dodged: true, parried };
}

export interface BotElementContext {
  hearts: number;
  maxHearts: number;
  /** Element a teammate just opened a Twin Cast with, if the bot should join it. */
  joinElement?: P0ElementType | null;
}

/** A random valid element; joins an open Twin Cast when asked; favors Bloom when hearts are low. */
export function botPickElement(rng: Rng, ctx: BotElementContext): P0ElementType {
  if (ctx.joinElement) return ctx.joinElement;
  if (ctx.hearts <= 2 && ctx.hearts < ctx.maxHearts && rng() < 0.5) return 'bloom';
  return P0_ELEMENTS[Math.floor(rng() * P0_ELEMENTS.length) % P0_ELEMENTS.length]!;
}

export function botGesture(rng: Rng): GestureType {
  return rng() < 0.5 ? 'swipe' : 'thrust';
}

/** Gesture power in the glove's usual range (about 0.9..1.2). */
export function botPower(rng: Rng): number {
  return Math.round((0.9 + rng() * 0.3) * 100) / 100;
}

/** A believable passed incantation: the world's phrase, spoken correctly. */
export function botIncantation(phrase: string): TranscribeResponse {
  return {
    transcript: phrase,
    expected: phrase,
    matchRatio: 1,
    passed: true,
    mercy: false,
    attempt: 1,
    power: 1,
  };
}

/** Delay (unscaled ms) before a bot casts in a team turn. */
export function botCastDelayMs(rng: Rng, teamTurnMs: number): number {
  return Math.round(teamTurnMs * (0.2 + rng() * 0.3));
}
