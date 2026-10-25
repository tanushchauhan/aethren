import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useGloveHub, type GloveHub, type GloveSummary } from '../hardware/useGloveHub';
import { GloveInputTracker, type GloveInputEvent } from './gloveInput';

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

export type InputListener = (event: GloveInputEvent, gloveId: number) => void;

export interface GloveSession {
  hub: GloveHub;
  /** The glove this player has claimed, or null while they still need to pick one. */
  glove: GloveSummary | null;
  /** Claims a glove for this player. False when someone else is using it or it is offline. */
  choose: (id: number, force?: boolean) => Promise<boolean>;
  /** Gives the glove back so another player can use it. */
  leave: () => void;
  /** Every press, release, hold and dial move from every glove. Returns an unsubscribe function. */
  onInput: (listener: InputListener) => () => void;
}

const GloveSessionContext = createContext<GloveSession | null>(null);

export function GloveSessionProvider({ children }: { children: ReactNode }) {
  const hub = useGloveHub();
  const { gloves, clientId, claim, release, send, status, subscribeFrames } = hub;
  const glove = useMemo(
    () => (clientId ? gloves.find((g) => g.claimedBy === clientId) ?? null : null),
    [gloves, clientId],
  );

  const choose = useCallback(async (id: number, force = false) => {
    const ok = await claim(id, force);
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

  const listeners = useRef(new Set<InputListener>());
  const onInput = useCallback((listener: InputListener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  const trackers = useRef(new Map<number, GloveInputTracker>());
  const glovesRef = useRef(gloves);
  glovesRef.current = gloves;
  useEffect(() => subscribeFrames((id, sample) => {
    let tracker = trackers.current.get(id);
    if (!tracker) trackers.current.set(id, tracker = new GloveInputTracker());
    const touchPin = glovesRef.current.find((g) => g.id === id)?.touchPin ?? null;
    for (const event of tracker.feed(sample, touchPin)) for (const listener of listeners.current) listener(event, id);
  }), [subscribeFrames]);

  const session = useMemo<GloveSession>(
    () => ({ hub, glove, choose, leave, onInput }),
    [hub, glove, choose, leave, onInput],
  );
  return <GloveSessionContext.Provider value={session}>{children}</GloveSessionContext.Provider>;
}

/** Null when the glove requirement is waived (`/?noglove`) and there is no session. */
export function useOptionalGloveSession(): GloveSession | null {
  return useContext(GloveSessionContext);
}

export function useGloveSession(): GloveSession {
  const session = useContext(GloveSessionContext);
  if (!session) throw new Error('useGloveSession must be used inside GloveSessionProvider');
  return session;
}

/** Runs the handler for input from the glove this player claimed. */
export function useGloveInput(handler: (event: GloveInputEvent) => void): void {
  const { glove, onInput } = useGloveSession();
  const latest = useRef(handler);
  latest.current = handler;
  const id = glove?.id ?? null;
  useEffect(() => onInput((event, gloveId) => { if (gloveId === id) latest.current(event); }), [onInput, id]);
}

/** The dial's current 0-1023 reading, or null before any frame has arrived. */
export function readDial(hub: GloveHub, gloveId: number): number | null {
  return hub.samples.current.get(gloveId)?.at(-1)?.dial ?? null;
}
