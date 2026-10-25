import type { GloveSample } from '../hardware/useGloveHub';

/** The three pressable controls, named as they will be labelled on the glove. */
export type GloveButton = 'T' | 'B1' | 'B2';

export type GloveInputEvent =
  | { type: 'down' | 'up' | 'hold'; button: GloveButton }
  | { type: 'dial'; value: number };

/** How long a button stays down before it counts as a hold. */
export const HOLD_MS = 600;
/** Dial readings are 0-1023 and jitter by a few counts; smaller moves are ignored. */
export const DIAL_NOISE = 8;

/**
 * Which of `count` equal bands of the dial the value falls in. Once in a band the dial has to
 * move clearly past the edge to leave it, so a value sitting on a boundary does not flicker.
 */
export function dialSlot(value: number, count: number, previous: number | null = null): number {
  const width = 1024 / count;
  const raw = Math.max(0, Math.min(count - 1, Math.floor(value / width)));
  if (previous === null || previous === raw || previous >= count) return raw;
  const margin = width * 0.15;
  return value >= previous * width - margin && value < (previous + 1) * width + margin ? previous : raw;
}

/** Turns one glove's raw frames into presses, releases, holds and dial moves. */
export class GloveInputTracker {
  private pressed = new Map<GloveButton, { since: number; held: boolean }>();
  private lastDial: number | null = null;

  feed(sample: GloveSample, touchPin: number | null): GloveInputEvent[] {
    const events: GloveInputEvent[] = [];
    const levels: Record<GloveButton, boolean> = {
      T: Boolean(touchPin === 3 ? sample.d3 : sample.d7),
      B1: Boolean(sample.d4),
      B2: Boolean(sample.d8),
    };
    for (const button of ['T', 'B1', 'B2'] as const) {
      const state = this.pressed.get(button);
      if (levels[button] && !state) {
        this.pressed.set(button, { since: sample.t, held: false });
        events.push({ type: 'down', button });
      } else if (levels[button] && state && !state.held && sample.t - state.since >= HOLD_MS) {
        state.held = true;
        events.push({ type: 'hold', button });
      } else if (!levels[button] && state) {
        this.pressed.delete(button);
        events.push({ type: 'up', button });
      }
    }
    if (this.lastDial === null || Math.abs(sample.dial - this.lastDial) >= DIAL_NOISE) {
      if (this.lastDial !== null) events.push({ type: 'dial', value: sample.dial });
      this.lastDial = sample.dial;
    }
    return events;
  }

  /** True while the button is physically down and has not yet been reported as a hold. */
  isHeld(button: GloveButton): boolean {
    return this.pressed.get(button)?.held ?? false;
  }
}
