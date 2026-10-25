/**
 * Agent 2A owns the Zustand store at client/src/net/store.ts.
 * UI screens import the game store through this shim so they do not
 * invent a second store while that module is landing.
 */
export { useGameStore } from '../net/store';
