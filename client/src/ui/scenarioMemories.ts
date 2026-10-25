import type { MemoryCard } from '../net/contract';

/** Stable across both laptops; prefer a concrete shared moment with people and a mood. */
export function chooseScenarioMemories(cards: readonly MemoryCard[]) {
  const unique = [...new Map(cards.filter(c => c.quote.trim()).map(c => [c.id, c])).values()];
  const score = (c: MemoryCard) => Math.min(c.quote.trim().split(/\s+/).length, 30) + c.people.length * 3 + (c.mood ? 4 : 0);
  unique.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const encounter = unique[0];
  if (!encounter) return null;
  const boss = unique.find(c => c.id !== encounter.id && c.mood !== encounter.mood) ?? unique[1];
  return boss ? { encounter, boss } : null;
}
