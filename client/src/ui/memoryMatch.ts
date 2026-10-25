import type { MemoryCard } from '../net/contract';
import { colorFamily, type ColorToken } from './colors';

/**
 * Yellow is the unmatched token: it crowns the first memory that is not
 * already kept and not already the boss, rather than a yellow-colored card.
 */
export function cardForColorToken(
  cards: readonly MemoryCard[],
  token: ColorToken,
  selectedIds: readonly string[],
  bossId?: string,
): MemoryCard | undefined {
  if (cards.length === 0) return undefined;
  if (token === 'yellow') {
    return (
      cards.find((card) => !selectedIds.includes(card.id) && card.id !== bossId) ??
      cards.find((card) => card.id !== bossId) ??
      cards[0]
    );
  }
  return cards.find((card) => colorFamily(card.color) === token);
}

export function canBeginTale(
  selectedMemoryIds: readonly string[],
  bossMemoryId: string | undefined,
): boolean {
  if (!bossMemoryId) return false;
  return selectedMemoryIds.some((id) => id !== bossMemoryId);
}
