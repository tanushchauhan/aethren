import { expect, it } from 'vitest';
import { buildMockGameState } from '../../net/mockState';
it('starts quick practice at the first lesson instead of skipping the sweep tutorial', () => {
  const game = buildMockGameState({ playerName: 'A', role: 'spellbearer', roomCode: 'TEST', phase: 'intro', quickStart: true });
  expect(game.currentRound).toBe(0);
  expect(game.phase).toBe('intro');
});
