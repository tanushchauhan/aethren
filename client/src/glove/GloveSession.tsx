import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useGloveHub, type GloveHub, type GloveSummary } from '../hardware/useGloveHub';
import { pressPins } from './gloveProfile';

const SAVED_GLOVE_KEY = 'memory.glove';

function savedGlove(): number | null {
  try {
    const value = Number(window.sessionStorage.getItem(SAVED_GLOVE_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveGlove(id: number | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(SAVED_GLOVE_KEY);
    else window.sessionStorage.setItem(SAVED_GLOVE_KEY, String(id));
  } catch {
    /* storage can be unavailable; the player just picks again after a reload */
  }
}

export type PressListener = (gloveId: number) => void;

export interface GloveSession {
  hub: GloveHub;
  /** The glove this player has claimed, or null while they still need to pick one. */
  glove: GloveSummary | null;
  /** Claims a glove for this player. False when someone else is using it or it is offline. */
  choose: (id: number) => Promise<boolean>;
  /** Gives the glove back so another player can use it. */
  leave: () => void;
  /** Fires when a glove's touch sensor or either button goes down. Returns an unsubscribe function. */
  onPress: (listener: PressListener) => () => void;
}

const GloveSessionContext = createContext<GloveSession | null>(null);

export function GloveSessionProvider({ children }: { children: ReactNode }) {
  const hub = useGloveHub();
  const { gloves, clientId, claim, release, edges, tick, send, status } = hub;
  const glove = useMemo(
    () => (clientId ? gloves.find((g) => g.claimedBy === clientId) ?? null : null),
    [gloves, clientId],
  );

  const choose = useCallback(async (id: number) => {
    const ok = await claim(id);
    if (ok) {
      saveGlove(id);
      send(id, { cmd: 'ident' });
    }
    return ok;
  }, [claim, send]);

  const leave = useCallback(() => {
    if (glove) release(glove.id);
    saveGlove(null);
  }, [glove, release]);

  // After a page reload the connection is new, so quietly take back the glove this tab was using.
  const reclaimed = useRef(false);
  useEffect(() => {
    if (status !== 'open') reclaimed.current = false;
  }, [status]);
  useEffect(() => {
    if (!clientId || glove || reclaimed.current) return;
    const id = savedGlove();
    if (id === null) return;
    const saved = gloves.find((g) => g.id === id);
    if (!saved) return;
    reclaimed.current = true;
    if (saved.online && !saved.claimedBy) void claim(id);
  }, [clientId, glove, gloves, claim]);

  const listeners = useRef(new Set<PressListener>());
  const onPress = useCallback((listener: PressListener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  // Edge counters only go up, so comparing totals between ticks never misses a quick tap.
  const totals = useRef(new Map<number, number>());
  useEffect(() => {
    for (const g of gloves) {
      const counts = edges.current.get(g.id);
      if (!counts) continue;
      const total = pressPins(g).reduce((sum, pin) => sum + counts.hits[pin], 0);
      const before = totals.current.get(g.id);
      totals.current.set(g.id, total);
      if (before !== undefined && total > before) for (const listener of listeners.current) listener(g.id);
    }
  }, [tick, gloves, edges]);

  const session = useMemo<GloveSession>(
    () => ({ hub, glove, choose, leave, onPress }),
    [hub, glove, choose, leave, onPress],
  );
  return <GloveSessionContext.Provider value={session}>{children}</GloveSessionContext.Provider>;
}

export function useGloveSession(): GloveSession {
  const session = useContext(GloveSessionContext);
  if (!session) throw new Error('useGloveSession must be used inside GloveSessionProvider');
  return session;
}
