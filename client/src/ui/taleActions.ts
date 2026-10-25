import type { RoomPhase } from '../net/contract';
import { getUiStore } from './storeBindings';

export const BEGIN_TALE_EVENT = 'ouam:begin-tale';
export const INTRO_CONTINUE_EVENT = 'ouam:intro-continue';

export interface BeginTaleDetail {
  selectedMemoryIds: string[];
  bossMemoryId?: string;
  roomCode?: string;
}

export function advancePhase(phase: RoomPhase): boolean {
  const setPhase = getUiStore().setPhase;
  if (typeof setPhase !== 'function') return false;
  setPhase(phase);
  return true;
}

/** Hands the kept cards to the store. quickStart is not used here; it skips this opening. */
export function beginTale(detail: BeginTaleDetail): boolean {
  const store = getUiStore();
  for (const id of detail.selectedMemoryIds) {
    if (id !== detail.bossMemoryId) store.selectCard(id);
  }
  if (detail.bossMemoryId) store.lockBoss(detail.bossMemoryId);
  window.dispatchEvent(new CustomEvent<BeginTaleDetail>(BEGIN_TALE_EVENT, { detail }));
  return advancePhase('intro');
}

export function continueIntro(): boolean {
  window.dispatchEvent(new CustomEvent(INTRO_CONTINUE_EVENT));
  return advancePhase('calibrating');
}

export async function playAgain(): Promise<void> {
  const store = getUiStore();
  if (typeof store.resetToLobby === 'function') {
    store.resetToLobby();
    return;
  }
  const named = store.gameState?.players.find((player) => player.name.trim().length > 0);
  const name = store.playerName.trim() || named?.name || 'Friend';
  const role = store.localRole ?? store.gameState?.players[0]?.role ?? 'spellbearer';
  await store.createRoom(name, role);
}
