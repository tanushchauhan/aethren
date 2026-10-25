import type { GloveSample } from '../hardware/useGloveHub';

/** The three pressable controls, named as they will be labelled on the glove. */
export type GloveButton = 'T' | 'B1' | 'B2';

export type GloveGesture = 'slash' | 'thrust' | 'shake';

export type GloveInputEvent =
  | { type: 'down' | 'up' | 'hold'; button: GloveButton }
  | { type: 'dial'; value: number }
  | { type: 'gesture'; gesture: GloveGesture; power: number; accelG: number };

/** How long a button stays down before it counts as a hold. */
export const HOLD_MS = 600;
/** Dial readings are 0-1023 and jitter by a few counts; smaller moves are ignored. */
export const DIAL_NOISE = 8;
/** Total acceleration (in g, gravity included) at which a swing of the glove registers. */
export const GESTURE_ACCEL_G = 1.85;
/** The acceleration that earns the maximum power multiplier. */
export const GESTURE_MAX_ACCEL_G = 3.2;
export const GESTURE_MIN_POWER = 1.15;
export const GESTURE_MAX_POWER = 1.45;
/** One swing lasts several frames; further swings are ignored this long after one fires. */
export const GESTURE_COOLDOWN_MS = 450;
/** How recently a swing counts as "just swung" for powering up a cast. */
export const GESTURE_WINDOW_MS = 700;
/** Hysteresis for the spell wheel, as a fraction of one slot's width. */
export const WHEEL_MARGIN = 0.12;

function slotWithMargin(value: number, count: number, previous: number | null, marginFraction: number): number {
  const width = 1024 / count;
  const raw = Math.max(0, Math.min(count - 1, Math.floor(value / width)));
  if (previous === null || previous === raw || previous < 0 || previous >= count) return raw;
  const margin = width * marginFraction;
  return value >= previous * width - margin && value < (previous + 1) * width + margin ? previous : raw;
}

/**
 * Which of `count` equal bands of the dial the value falls in. Once in a band the dial has to
 * move clearly past the edge to leave it, so a value sitting on a boundary does not flicker.
 */
export function dialSlot(value: number, count: number, previous: number | null = null): number {
  return slotWithMargin(value, count, previous, 0.15);
}

/** The radial spell wheel: slots 0..count-1 (12 by default) with a slightly tighter hysteresis margin. */
export function wheelSlot(value: number, count = 12, previous: number | null = null): number {
  return slotWithMargin(value, count, previous, WHEEL_MARGIN);
}

/** Maps total acceleration in g onto the 1.15..1.45 power multiplier. */
export function gesturePower(accelG: number): number {
  const t = Math.max(0, Math.min(1, (accelG - GESTURE_ACCEL_G) / (GESTURE_MAX_ACCEL_G - GESTURE_ACCEL_G)));
  return GESTURE_MIN_POWER + t * (GESTURE_MAX_POWER - GESTURE_MIN_POWER);
}

const finite = (value: number | undefined) => (Number.isFinite(value) ? (value as number) : 0);

/** Turns one glove's raw frames into presses, releases, holds, dial moves and swing gestures. */
export class GloveInputTracker {
  private pressed = new Map<GloveButton, { since: number; held: boolean }>();
  private lastDial: number | null = null;
  private accelG = 0;
  private lastGestureAt = -Infinity;
  private lastGesturePower = 1;

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
    const gesture = this.readGesture(sample);
    if (gesture) events.push(gesture);
    return events;
  }

  private readGesture(sample: GloveSample): GloveInputEvent | null {
    const ax = finite(sample.ax), ay = finite(sample.ay), az = finite(sample.az);
    const accelG = Math.hypot(ax, ay, az) / 1000;
    this.accelG = accelG;
    if (accelG < GESTURE_ACCEL_G || sample.t - this.lastGestureAt < GESTURE_COOLDOWN_MS) return null;
    const x = Math.abs(ax), forward = Math.max(Math.abs(ay), Math.abs(az));
    const total = x + Math.abs(ay) + Math.abs(az);
    // A swing with no clearly leading axis reads as a shake; otherwise lateral is a slash, forward/vertical a thrust.
    const gesture: GloveGesture = Math.max(x, forward) < total * 0.5 ? 'shake' : x > forward ? 'slash' : 'thrust';
    const power = gesturePower(accelG);
    this.lastGestureAt = sample.t;
    this.lastGesturePower = power;
    return { type: 'gesture', gesture, power, accelG };
  }

  /** True while the button is physically down and has not yet been reported as a hold. */
  isHeld(button: GloveButton): boolean {
    return this.pressed.get(button)?.held ?? false;
  }

  /** Latest instantaneous total acceleration in g (about 1 at rest). */
  getAccelG(): number {
    return this.accelG;
  }

  /** The power multiplier of the last swing if it was within `windowMs` of `now`, else 1. */
  getRecentPeakPower(windowMs = GESTURE_WINDOW_MS, now: number = typeof performance !== 'undefined' ? performance.now() : Date.now()): number {
    return now - this.lastGestureAt <= windowMs ? this.lastGesturePower : 1;
  }
}
