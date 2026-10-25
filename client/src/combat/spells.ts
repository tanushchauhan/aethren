export type SpellElement = 'fire' | 'frost' | 'storm';
export type SpellForm = 'bolt' | 'burst';
export type SpellInput = { element: SpellElement; form: SpellForm; targetId: string };
export type Spell = { id: string; name: string; element: SpellElement; form: SpellForm; damage: number; cost: number; color: string; particle: string };
const elements = {
  fire: { bolt: 'Ember Bolt', burst: 'Fireburst', damage: [8, 20], color: '#ff9653', particle: 'fire_01.png' },
  frost: { bolt: 'Frost Shard', burst: 'Frost Nova', damage: [5, 14], color: '#98e8ff', particle: 'star_04.png' },
  storm: { bolt: 'Storm Spark', burst: 'Storm Pulse', damage: [6, 16], color: '#cfacff', particle: 'spark_03.png' },
} as const;
/** Small composable recipe API: input adapters choose an element, a form, and a target. */
export function buildSpell(input: Pick<SpellInput, 'element' | 'form'>): Spell | null {
  if (!Object.hasOwn(elements, input.element) || !['bolt', 'burst'].includes(input.form)) return null;
  const recipe = elements[input.element];
  return { id: `${input.element}-${input.form}`, name: recipe[input.form], element: input.element, form: input.form,
    damage: recipe.damage[input.form === 'bolt' ? 0 : 1], cost: input.form === 'bolt' ? 2 : 4,
    color: recipe.color, particle: `/art/particles/${recipe.particle}` };
}
