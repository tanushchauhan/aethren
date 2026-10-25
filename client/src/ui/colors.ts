import { ELEMENT_COLORS } from '../net/contract';

export type ElementToken = 'ember' | 'frost' | 'bloom';
export type ColorToken = ElementToken | 'yellow';

const EMBER_HINTS = [ELEMENT_COLORS.ember, 'ember', 'red', 'orange', 'fire', 'scarlet'] as const;
const FROST_HINTS = [ELEMENT_COLORS.frost, 'frost', 'blue', 'cyan', 'ice', 'azure'] as const;
const BLOOM_HINTS = [ELEMENT_COLORS.bloom, 'bloom', 'green', 'leaf', 'verdant'] as const;

function matches(color: string, hints: readonly string[]): boolean {
  return hints.some((hint) => {
    if (hint.startsWith('#')) return color === hint || color.includes(hint);
    return (
      color === hint ||
      color.startsWith(`${hint}-`) ||
      color.startsWith(`${hint} `) ||
      color.endsWith(` ${hint}`) ||
      color.includes(` ${hint} `)
    );
  });
}

export function colorFamily(color: string): ElementToken | 'other' {
  const key = color.trim().toLowerCase();
  if (matches(key, EMBER_HINTS)) return 'ember';
  if (matches(key, FROST_HINTS)) return 'frost';
  if (matches(key, BLOOM_HINTS)) return 'bloom';
  return 'other';
}

export function isColorToken(value: unknown): value is ColorToken {
  return value === 'ember' || value === 'frost' || value === 'bloom' || value === 'yellow';
}

export function colorSwatch(color: string): string {
  const family = colorFamily(color);
  if (family === 'ember') return ELEMENT_COLORS.ember;
  if (family === 'frost') return ELEMENT_COLORS.frost;
  if (family === 'bloom') return ELEMENT_COLORS.bloom;
  const key = color.trim().toLowerCase();
  if (key === 'gold' || key === 'yellow' || key === 'amber') return '#e0b341';
  if (key === 'rose' || key === 'pink') return '#c45c74';
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color.trim())) return color.trim();
  return '#8d6a2f';
}

export function colorLabel(color: string): string {
  const family = colorFamily(color);
  if (family === 'ember') return 'Ember';
  if (family === 'frost') return 'Frost';
  if (family === 'bloom') return 'Bloom';
  const key = color.trim().toLowerCase();
  if (key === 'gold' || key === 'yellow' || key === 'amber') return 'Gold';
  if (key === 'rose' || key === 'pink') return 'Rose';
  if (!key || key.startsWith('#')) return 'Color';
  return key.charAt(0).toUpperCase() + key.slice(1);
}
