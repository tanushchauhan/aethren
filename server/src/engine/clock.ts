/**
 * Injectable clock and timer bookkeeping for the engine.
 *
 * The default {@link systemClock} calls the global `Date.now` / `setTimeout` lazily, so vitest
 * fake timers (`vi.useFakeTimers()`) drive it without any extra wiring.
 */

export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A set of timers that can be cancelled together (phase changes, pause, dispose). */
export class TimerGroup {
  private readonly handles = new Set<TimerHandle>();

  constructor(private readonly clock: Clock) {}

  after(ms: number, fn: () => void): TimerHandle {
    const handle = this.clock.setTimeout(() => {
      this.handles.delete(handle);
      fn();
    }, Math.max(0, ms));
    this.handles.add(handle);
    return handle;
  }

  cancel(handle: TimerHandle | null | undefined): void {
    if (handle === null || handle === undefined || !this.handles.has(handle)) return;
    this.clock.clearTimeout(handle);
    this.handles.delete(handle);
  }

  clear(): void {
    for (const handle of this.handles) this.clock.clearTimeout(handle);
    this.handles.clear();
  }

  get size(): number {
    return this.handles.size;
  }
}

/**
 * The one "main" timer that ends the current phase. Remembers its callback and due time so a
 * pause can resume it with the time that was left.
 */
export class PhaseTimer {
  private handle: TimerHandle | null = null;
  private fn: (() => void) | null = null;
  private dueAt = 0;

  constructor(private readonly clock: Clock) {}

  set(ms: number, fn: () => void): void {
    this.clear();
    this.fn = fn;
    this.dueAt = this.clock.now() + Math.max(0, ms);
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.fn = null;
      fn();
    }, Math.max(0, ms));
  }

  clear(): void {
    if (this.handle !== null) this.clock.clearTimeout(this.handle);
    this.handle = null;
    this.fn = null;
  }

  /** Stops the timer and returns what it would have run and how long was left. */
  take(): { fn: () => void; remainingMs: number } | null {
    if (this.handle === null || !this.fn) return null;
    const taken = { fn: this.fn, remainingMs: Math.max(0, this.dueAt - this.clock.now()) };
    this.clear();
    return taken;
  }

  get active(): boolean {
    return this.handle !== null;
  }
}
