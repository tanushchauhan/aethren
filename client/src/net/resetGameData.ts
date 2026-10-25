/** Keys that describe how this browser reaches the glove hub, not game progress; clearing them would break the setup. */
const KEEP_SESSION = ['hub'];

/**
 * Forgets everything the game has stored (settings, glove choice, tutorial state) and reloads, which also resets
 * every in-memory store. The hub address survives so the gloves keep working.
 */
export function resetGameData(): void {
  try {
    window.localStorage.clear();
  } catch { /* storage can be unavailable; the reload still resets the in-memory state */ }
  try {
    const keep = KEEP_SESSION.map((key) => [key, window.sessionStorage.getItem(key)] as const);
    window.sessionStorage.clear();
    for (const [key, value] of keep) if (value !== null) window.sessionStorage.setItem(key, value);
  } catch { /* same */ }
  window.location.reload();
}
