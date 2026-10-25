import { create } from 'zustand';
import type { MoveId } from './encounter';
import type { DodgeClassification } from '../vision/poseClassifiers';
export type DefenseCue = 'left' | 'right' | 'duck' | 'block';
export type DefenseResult = 'hit' | 'dodged' | 'blocked';
export const DEFENSE_LABELS: Record<DefenseCue, string> = { left: '← Dodge left', right: 'Dodge right →', duck: '↓ Duck', block: 'Raise your right arm · Block' };
export function cueForMove(move: MoveId, roll = Math.random()): DefenseCue | null {
  const options: Partial<Record<MoveId, DefenseCue[]>> = {
    'charge-slash': ['left', 'right', 'duck'], 'jaw-grab': ['left', 'right'],
    'dark-slash': ['left', 'right', 'duck'], 'aura-flash': ['block'], 'scorn-inferno': ['block'],
  };
  const list = options[move];
  return list ? list[Math.min(list.length - 1, Math.floor(Math.max(0, roll) * list.length))] : null;
}
interface DefenseState {
  enabled: boolean;
  actionId: number | null;
  cue: DefenseCue | null;
  windupMs: number;
  progress: number;
  setProgress: (id: number, progress: number) => void;
  blockable: boolean;
  pose: DodgeClassification | null;
  sampleAt: number;
  heldSince: number;
  matching: DefenseResult;
  result: DefenseResult | null;
  setEnabled: (enabled: boolean) => void;
  begin: (id: number, move: MoveId, roll?: number) => void;
  sample: (pose: DodgeClassification | null, now?: number) => void;
  resolve: (id: number, stance: number, now?: number) => DefenseResult;
  clear: () => void;
}
/** Fresh, sustained camera evidence only; damage is resolved by the battle store exactly once. */
export const useDefense = create<DefenseState>((set, get) => ({
  progress: 0, enabled: false, blockable: true, actionId: null, cue: null, windupMs: 300, pose: null, sampleAt: -Infinity, heldSince: 0, matching: 'hit', result: null,
  setProgress(id, progress) { if (get().actionId === id && Number.isFinite(progress)) { const value = Math.max(0, Math.min(1, progress)); if (Math.abs(get().progress - value) > .01 || value === 1 && get().progress !== 1) set({ progress: value }); } },
  setEnabled(enabled) { set({ enabled, pose: null, sampleAt: -Infinity, matching: 'hit' }); },
  begin(actionId, move, roll = Math.random()) {
    set({ progress: 0, actionId, blockable: move !== 'jaw-grab', cue: cueForMove(move, roll), windupMs: 300 + Math.floor(roll * 250), result: null, matching: 'hit', heldSince: 0 });
  },
  sample(pose, now = performance.now()) {
    const state = get();
    const dodge = pose && state.cue && (state.cue === 'left' ? pose.isSideStepLeft : state.cue === 'right' ? pose.isSideStepRight : state.cue === 'duck' ? pose.isDucking : false);
    // Grab attacks require a dodge; callers pass their sidestep cue and disable block below via move policy.
    const matching: DefenseResult = !state.enabled || !pose || pose.confidence < .6 ? 'hit' : dodge ? 'dodged' : state.blockable && pose.isRightArmRaised ? 'blocked' : 'hit';
    set({ pose, sampleAt: now, matching, heldSince: matching !== state.matching || now - state.sampleAt > 250 ? now : state.heldSince });
  },
  resolve(id, stance, now = performance.now()) {
    const s = get();
    if (s.actionId !== id || !s.cue) return 'hit';
    if (s.result) return s.result;
    const result = s.enabled && now - s.sampleAt <= 250 && now - s.heldSince >= 120 && (s.matching !== 'blocked' || stance >= 30) ? s.matching : 'hit';
    set({ result });
    return result;
  },
  clear() { set({ actionId: null, cue: null, result: null, matching: 'hit' }); },
}));
