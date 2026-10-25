import { expect, it } from 'vitest';
import { chooseScenarioMemories } from '../scenarioMemories';
const cards = [
  { id: 'a', quote: 'The car broke down and we all walked home laughing', people: ['A', 'B'], mood: 'warm', date: '', color: '' },
  { id: 'b', quote: 'Rain under the bleachers', people: ['A'], mood: 'quiet', date: '', color: '' },
  { id: 'c', quote: 'hello', people: [], mood: 'warm', date: '', color: '' },
];
it('chooses the same meaningful scenario and a distinct boss on either laptop', () => {
  const chosen = chooseScenarioMemories(cards)!;
  expect(chosen.encounter.id).toBe('a'); expect(chosen.boss.id).toBe('b');
  expect(chooseScenarioMemories([...cards].reverse())).toEqual(chosen);
});
it('waits for enough distinct memories instead of inventing conversation content', () => {
  expect(chooseScenarioMemories([])).toBeNull();
  expect(chooseScenarioMemories([cards[0]!, cards[0]!])).toBeNull();
});
