import { create } from 'zustand';

export type TutorialStep = 'dial' | 'element' | 'target' | 'cast' | 'parry';

const TUTORIAL_ENCOUNTER = 'wolves';
const STEP_ORDER: TutorialStep[] = ['dial', 'element', 'target', 'cast'];

interface WolfTutorialState {
  enabled: boolean;
  /** Full-screen lesson currently shown, or null while play flows normally. */
  activeStep: TutorialStep | null;
  /** Each lesson is taught once. */
  completed: Partial<Record<TutorialStep, boolean>>;
  /** True while the wolf attack is suspended mid-lunge for the parry lesson. */
  attackFrozen: boolean;
  startTurnTutorial: (encounterId: string, turnNumber: number) => void;
  notifyAction: (action: TutorialStep) => void;
  triggerMidAttackPause: (encounterId: string) => boolean;
  skipStep: () => void;
  skipAll: () => void;
  resetTutorial: () => void;
}

/** Next lesson in the turn-1 sequence after `step`, skipping lessons already taught. */
function nextStep(step: TutorialStep, completed: Partial<Record<TutorialStep, boolean>>): TutorialStep | null {
  const index = STEP_ORDER.indexOf(step);
  if (index < 0) return null;
  return STEP_ORDER.slice(index + 1).find(next => !completed[next]) ?? null;
}

export const useWolfTutorial = create<WolfTutorialState>((set, get) => {
  /** Mark `step` taught and move the active lesson along. */
  const complete = (step: TutorialStep) => {
    const { activeStep, completed } = get();
    const done = { ...completed, [step]: true };
    if (step === 'parry') {
      set({ completed: done, attackFrozen: false, activeStep: activeStep === 'parry' ? null : activeStep });
    } else if (activeStep === step) {
      set({ completed: done, activeStep: nextStep(step, done) });
    } else if (step === 'cast' && activeStep !== 'parry') {
      // Casting early (e.g. keyboard shortcut) ends the turn, so earlier lessons no longer apply.
      set({ completed: done, activeStep: null });
    } else {
      set({ completed: done });
    }
  };

  return {
    enabled: true,
    activeStep: null,
    completed: {},
    attackFrozen: false,

    startTurnTutorial(encounterId, _turnNumber) {
      const { enabled, completed } = get();
      if (!enabled || encounterId !== TUTORIAL_ENCOUNTER || completed.dial) return;
      set({ activeStep: 'dial' });
    },

    notifyAction: complete,

    triggerMidAttackPause(encounterId) {
      const { enabled, completed, activeStep } = get();
      if (!enabled || encounterId !== TUTORIAL_ENCOUNTER || completed.parry || activeStep === 'parry') return false;
      set({ activeStep: 'parry', attackFrozen: true });
      return true;
    },

    skipStep() {
      const { activeStep } = get();
      if (activeStep) complete(activeStep);
    },

    skipAll() {
      set({
        enabled: false,
        activeStep: null,
        attackFrozen: false,
        completed: { dial: true, element: true, target: true, cast: true, parry: true },
      });
    },

    resetTutorial() {
      set({ completed: {}, activeStep: null, attackFrozen: false, enabled: true });
    },
  };
});
