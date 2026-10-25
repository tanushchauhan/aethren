/** First-turn enemy fade-in on the combat stage. Keep these in sync with the wolf/boss motion. */
export const ENEMY_INTRO_FADE_DELAY_S = 2.5;
export const ENEMY_INTRO_FADE_STAGGER_S = 0.3;
export const ENEMY_INTRO_FADE_DURATION_S = 2.8;
/** Extra beat after the last enemy is fully visible before the cast UI opens. */
export const CAST_UI_REVEAL_PAD_MS = 2000;

export function enemyIntroFadeEndMs(enemyCount: number, reducedMotion: boolean): number {
  if (reducedMotion || enemyCount < 1) return 0;
  return Math.round((ENEMY_INTRO_FADE_DELAY_S + (enemyCount - 1) * ENEMY_INTRO_FADE_STAGGER_S + ENEMY_INTRO_FADE_DURATION_S) * 1000);
}

/** How long to keep the cast wheel hidden when you act first on turn 1. */
export function castUiRevealDelayMs(enemyCount: number, reducedMotion: boolean, goingFirstOnTurn1: boolean): number {
  if (!goingFirstOnTurn1) return 0;
  const fadeEnd = enemyIntroFadeEndMs(enemyCount, reducedMotion);
  return fadeEnd === 0 ? 0 : fadeEnd + CAST_UI_REVEAL_PAD_MS;
}
