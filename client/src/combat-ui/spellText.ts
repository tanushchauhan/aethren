import type { ElementP0, WorldSchema } from '../net/contract';

export const ELEMENT_LABEL: Record<ElementP0, string> = {
  ember: 'Ember',
  frost: 'Frost',
  bloom: 'Bloom',
};

const FALLBACK_INCANTATION: Record<ElementP0, string> = {
  ember: 'By the fire we kept, burn',
  frost: 'By the winter we shared, still',
  bloom: 'By the garden we grew, rise',
};

export interface SpellPhrase {
  text: string;
  generated: boolean;
}

export function spellPhrase(
  incantations: WorldSchema['incantations'] | undefined,
  element: ElementP0,
): SpellPhrase {
  const raw = incantations?.[element];
  if (typeof raw === 'string' && raw.trim()) return { text: raw.trim(), generated: true };
  return { text: FALLBACK_INCANTATION[element], generated: false };
}
