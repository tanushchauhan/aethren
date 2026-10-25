import type { GloveSummary } from '../hardware/useGloveHub';

/** What a physical glove can do, derived from the Grove LCD it was built with. */
export interface GloveProfile {
  label: string;
  /** The LCD backlight can show any colour, so it can signal game state (the v4 only lights green). */
  colorLcd: boolean;
  /** The LCD text is readable, so it can show spell names, hearts and prompts. */
  textLcd: boolean;
  note: string;
}

const V4: GloveProfile = {
  label: 'Glove v4',
  colorLcd: false,
  textLcd: true,
  note: 'Readable text screen, green backlight only.',
};

const V2: GloveProfile = {
  label: 'Glove v2',
  colorLcd: true,
  textLcd: false,
  note: 'Full colour backlight, text is hard to read.',
};

export function gloveProfile(glove: Pick<GloveSummary, 'variant'>): GloveProfile {
  return glove.variant === 2 ? V2 : V4;
}

/** Digital pins that count as a deliberate press: the touch sensor and both buttons. */
export function pressPins(glove: Pick<GloveSummary, 'touchPin'>): ('d3' | 'd7' | 'd4' | 'd8')[] {
  return [glove.touchPin === 3 ? 'd3' : 'd7', 'd4', 'd8'];
}

/** The names printed on the glove, used in every on-screen prompt so players learn them once. */
export const CONTROL_LABELS = { touch: 'T', button1: 'B1', button2: 'B2', dial: 'Dial' } as const;
