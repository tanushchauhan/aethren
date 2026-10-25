/**
 * Pausing the whole game without every scene having to know about it.
 *
 * The game runs on timers, animation frames, CSS and Web Animations, media elements and Web Audio. `installPauseEngine`
 * wraps the timer and frame APIs once at startup so that `freezeTime` can stop all of them and `thawTime` can carry on
 * with the time each one had left. Audio is handled separately so the menu can silence the game on its own.
 */
type Timer = { fn: (...args: unknown[]) => void; args: unknown[]; delay: number; repeat: boolean; startedAt: number; remaining: number; real: number | null };
type Frame = { cb: FrameRequestCallback; real: number | null };

const timers = new Map<number, Timer>();
const frames = new Map<number, Frame>();
let nextTimerId = 1_000_000;
let nextFrameId = 2_000_000;
let installed = false;
let frozen = false;
let soundOff = false;

const real = {} as {
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
  setInterval: typeof window.setInterval;
  clearInterval: typeof window.clearInterval;
  requestAnimationFrame: typeof window.requestAnimationFrame;
  cancelAnimationFrame: typeof window.cancelAnimationFrame;
};

const contexts = new Set<AudioContext>();
const suspendedContexts = new Set<AudioContext>();
const playingMedia = new Set<HTMLMediaElement>();
const pausedMedia = new Set<HTMLMediaElement>();
const mutedByUs = new WeakMap<HTMLMediaElement, boolean>();
let pausedAnimations: Animation[] = [];

function armTimer(id: number, timer: Timer, ms: number): void {
  timer.startedAt = performance.now();
  timer.remaining = ms;
  timer.real = real.setTimeout(() => fireTimer(id), ms) as unknown as number;
}

function fireTimer(id: number): void {
  const timer = timers.get(id);
  if (!timer) return;
  timer.real = null;
  if (frozen) { timer.remaining = 0; return; }
  if (!timer.repeat) timers.delete(id);
  timer.fn(...timer.args);
  if (timer.repeat && timers.has(id)) {
    if (frozen) timer.remaining = timer.delay; else armTimer(id, timer, timer.delay);
  }
}

function armFrame(id: number, frame: Frame): void {
  frame.real = real.requestAnimationFrame((ts) => {
    frame.real = null;
    if (frozen) return;
    frames.delete(id);
    frame.cb(ts);
  });
}

function applyMute(el: HTMLMediaElement): void {
  if (soundOff) {
    if (!mutedByUs.has(el)) mutedByUs.set(el, el.muted);
    el.muted = true;
  } else if (mutedByUs.has(el)) {
    el.muted = mutedByUs.get(el)!;
    mutedByUs.delete(el);
  }
}

export function installPauseEngine(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  real.setTimeout = window.setTimeout.bind(window);
  real.clearTimeout = window.clearTimeout.bind(window);
  real.setInterval = window.setInterval.bind(window);
  real.clearInterval = window.clearInterval.bind(window);
  real.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  real.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

  const make = (repeat: boolean) => ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (typeof handler !== 'function') return (repeat ? real.setInterval : real.setTimeout)(handler, delay, ...args);
    const id = nextTimerId++;
    const timer: Timer = { fn: handler as (...a: unknown[]) => void, args, delay: Math.max(0, Number(delay) || 0), repeat, startedAt: 0, remaining: 0, real: null };
    timers.set(id, timer);
    if (frozen) timer.remaining = timer.delay; else armTimer(id, timer, timer.delay);
    return id;
  }) as unknown as typeof window.setTimeout;
  const clear = (id?: number) => {
    const timer = id === undefined ? undefined : timers.get(id);
    if (timer) {
      if (timer.real !== null) real.clearTimeout(timer.real);
      timers.delete(id!);
    } else if (id !== undefined) real.clearTimeout(id);
  };
  window.setTimeout = make(false);
  window.setInterval = make(true);
  window.clearTimeout = clear as typeof window.clearTimeout;
  window.clearInterval = clear as typeof window.clearInterval;

  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    const frame: Frame = { cb, real: null };
    frames.set(id, frame);
    if (!frozen) armFrame(id, frame);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    const frame = frames.get(id);
    if (frame) {
      if (frame.real !== null) real.cancelAnimationFrame(frame.real);
      frames.delete(id);
    } else real.cancelAnimationFrame(id);
  }) as typeof window.cancelAnimationFrame;

  const OriginalContext = window.AudioContext;
  if (OriginalContext) {
    window.AudioContext = class extends OriginalContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.add(this);
        if (soundOff || frozen) void this.suspend().then(() => suspendedContexts.add(this)).catch(() => {});
      }
    };
  }

  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    playingMedia.add(this);
    applyMute(this);
    // Anything that starts while the game is frozen waits for the thaw.
    if (frozen) { pausedMedia.add(this); return Promise.resolve(); }
    return originalPlay.call(this);
  };
}

/** Stops every timer, animation frame, CSS and Web Animation, video, sound and voice until `thawTime`. */
export function freezeTime(): void {
  if (frozen) return;
  const now = performance.now();
  frozen = true;
  for (const timer of timers.values()) {
    if (timer.real === null) continue;
    real.clearTimeout(timer.real);
    timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
    timer.real = null;
  }
  for (const frame of frames.values()) {
    if (frame.real === null) continue;
    real.cancelAnimationFrame(frame.real);
    frame.real = null;
  }
  pausedAnimations = document.getAnimations().filter((a) => a.playState === 'running');
  for (const animation of pausedAnimations) animation.pause();
  for (const el of playingMedia) {
    if (!el.isConnected && el.paused) { playingMedia.delete(el); continue; }
    if (!el.paused) { el.pause(); pausedMedia.add(el); }
  }
  for (const ctx of contexts) {
    if (ctx.state === 'running') void ctx.suspend().then(() => suspendedContexts.add(ctx)).catch(() => {});
  }
  window.speechSynthesis?.pause();
}

export function thawTime(): void {
  if (!frozen) return;
  frozen = false;
  for (const [id, timer] of timers) if (timer.real === null) armTimer(id, timer, timer.remaining);
  for (const [id, frame] of frames) if (frame.real === null) armFrame(id, frame);
  for (const animation of pausedAnimations) { try { animation.play(); } catch { /* the animation was removed while paused */ } }
  pausedAnimations = [];
  for (const el of pausedMedia) void HTMLMediaElement.prototype.play.call(el);
  pausedMedia.clear();
  if (!soundOff) {
    for (const ctx of suspendedContexts) void ctx.resume().catch(() => {});
    suspendedContexts.clear();
  }
  window.speechSynthesis?.resume();
}

/** Silences or restores everything the game plays, without pausing it. */
export function setSoundOff(off: boolean): void {
  soundOff = off;
  for (const el of playingMedia) applyMute(el);
  for (const ctx of contexts) {
    if (off) { if (ctx.state === 'running') void ctx.suspend().then(() => suspendedContexts.add(ctx)).catch(() => {}); }
    else if (!frozen && suspendedContexts.has(ctx)) { void ctx.resume().catch(() => {}); suspendedContexts.delete(ctx); }
  }
  if (off) window.speechSynthesis?.cancel();
}

export const isFrozen = () => frozen;
