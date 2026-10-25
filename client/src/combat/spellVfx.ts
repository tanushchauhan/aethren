import type { Spell } from './spells';
export const SPELL_TIMING = { impactMs: 900, finishMs: 1800, reducedImpactMs: 150, reducedFinishMs: 500 };
export type SpellVfxProfile = {
  core: string; accent: string; trail: string; residue: string;
  color: string; highlight: string; trailCount: number; orbitCount: number;
  shardCount: number; ringCount: number; spread: number; coreScale: number;
};
const art = (name: string) => `/art/particles/${name}.png`;
const elements: Record<Spell['element'], Pick<SpellVfxProfile, 'core' | 'accent' | 'trail' | 'residue' | 'highlight'>> = {
  fire: { core: art('fire_01'), accent: art('spark_03'), trail: art('fire_01'), residue: art('smoke_01'), highlight: '#ffe7ae' },
  frost: { core: art('star_04'), accent: art('star_04'), trail: art('star_04'), residue: art('circle_01'), highlight: '#efffff' },
  storm: { core: art('spark_03'), accent: art('trace_01'), trail: art('spark_03'), residue: art('smoke_01'), highlight: '#f1e6ff' },
};
/** Tune layers independently or override them for a new spell, without rewriting the renderer. */
export function buildSpellVfx(spell: Spell, overrides: Partial<SpellVfxProfile> = {}): SpellVfxProfile {
  const burst = spell.form === 'burst';
  return { ...elements[spell.element], color: spell.color, trailCount: burst ? 12 : 8,
    orbitCount: burst ? 5 : 3, shardCount: burst ? 24 : 14, ringCount: burst ? 3 : 2,
    spread: burst ? 150 : 90, coreScale: burst ? 1.6 : 1, ...overrides };
}
