/**
 * The fixed mood list for memory cards. Each mood sets the enemy's weakness (a P0 element)
 * and a default card color.
 *
 * Fire beats dread and gloom, frost cools chaos and heat, bloom humbles pride and nostalgia.
 */
import type { P0ElementType } from '@once-upon/shared';

export const MOODS = [
  'chaotic',
  'frantic',
  'heated',
  'cozy',
  'dread',
  'gloomy',
  'spooky',
  'proud',
  'nostalgic',
  'silly',
] as const;

export type Mood = (typeof MOODS)[number];

export const MOOD_WEAKNESS: Record<Mood, P0ElementType> = {
  chaotic: 'frost',
  frantic: 'frost',
  heated: 'frost',
  cozy: 'frost',
  dread: 'ember',
  gloomy: 'ember',
  spooky: 'ember',
  proud: 'bloom',
  nostalgic: 'bloom',
  silly: 'bloom',
};

export const MOOD_COLORS: Record<Mood, string> = {
  chaotic: '#E85D04',
  frantic: '#F48C06',
  heated: '#D00000',
  cozy: '#BC6C25',
  dread: '#4CC9F0',
  gloomy: '#5A189A',
  spooky: '#3A0CA3',
  proud: '#52B788',
  nostalgic: '#CDB4DB',
  silly: '#FFB703',
};

const SYNONYMS: Record<string, Mood> = {
  chaos: 'chaotic',
  wild: 'chaotic',
  hectic: 'chaotic',
  panic: 'frantic',
  panicked: 'frantic',
  stressed: 'frantic',
  rushed: 'frantic',
  angry: 'heated',
  mad: 'heated',
  furious: 'heated',
  dramatic: 'heated',
  warm: 'cozy',
  wholesome: 'cozy',
  comfy: 'cozy',
  scared: 'dread',
  anxious: 'dread',
  doom: 'dread',
  sad: 'gloomy',
  melancholy: 'gloomy',
  lonely: 'gloomy',
  tired: 'gloomy',
  creepy: 'spooky',
  eerie: 'spooky',
  haunted: 'spooky',
  triumphant: 'proud',
  victorious: 'proud',
  smug: 'proud',
  accomplished: 'proud',
  sentimental: 'nostalgic',
  bittersweet: 'nostalgic',
  wistful: 'nostalgic',
  funny: 'silly',
  goofy: 'silly',
  playful: 'silly',
  absurd: 'silly',
  hilarious: 'silly',
};

export function normalizeMood(input: unknown): Mood {
  if (typeof input !== 'string') return 'nostalgic';
  const m = input.trim().toLowerCase();
  if ((MOODS as readonly string[]).includes(m)) return m as Mood;
  return SYNONYMS[m] ?? 'nostalgic';
}

export function weaknessForMood(mood: unknown): P0ElementType {
  return MOOD_WEAKNESS[normalizeMood(mood)];
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeColor(input: unknown, mood: Mood): string {
  return typeof input === 'string' && HEX_COLOR.test(input.trim()) ? input.trim().toUpperCase() : MOOD_COLORS[mood];
}
