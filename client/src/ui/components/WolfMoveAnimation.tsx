import { useEffect, useRef, useState } from 'react';
import type { CombatMove } from '../../combat/encounter';
import { useSpellBattle } from '../../combat/spellBattle';
import { useWolfTutorial } from '../../combat/wolfTutorial';

const NON_ATTACK_MOVES = new Set(['rest', 'roar', 'descent']);

/** Remove only edge-connected near-white background, retaining enclosed eyes/teeth. */
function clearBackdrop(frame: ImageData, visited: Uint8Array, queue: Int32Array) {
  const { width, height, data } = frame;
  visited.fill(0);
  let head = 0, tail = 0;
  const add = (pixel: number) => {
    if (visited[pixel]) return;
    visited[pixel] = 1;
    const offset = pixel * 4;
    const low = Math.min(data[offset], data[offset + 1], data[offset + 2]);
    const high = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    if (low < 214 || high - low > 32) return;
    data[offset + 3] = 0;
    queue[tail++] = pixel;
  };
  for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const pixel = queue[head++], x = pixel % width;
    if (x) add(pixel - 1);
    if (x < width - 1) add(pixel + 1);
    if (pixel >= width) add(pixel - width);
    if (pixel < width * (height - 1)) add(pixel + width);
  }
}

export function WolfMoveAnimation({ move, sprite, muted, reduced, paused = false, onImpact, onComplete, onProgress }: {
  move: CombatMove; sprite: string; muted: boolean; reduced: boolean;
  /** Suspends the animation (frame stays on the canvas) until false again. */
  paused?: boolean;
  onProgress?: (progress: number) => void;
  onImpact: () => void; onComplete: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const effectAudio = useRef<HTMLAudioElement | null>(null);
  const callbacks = useRef({ onImpact, onComplete, onProgress });
  callbacks.current = { onImpact, onComplete, onProgress };
  const mutedRef = useRef(muted); mutedRef.current = muted;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false, impacted = false, raf = 0, elapsed = 0, previous = performance.now(), lastDraw = -1;
    const sound = move.sound ? new Audio(move.sound) : null;
    effectAudio.current = sound;
    if (sound) { sound.volume = .55; sound.muted = mutedRef.current; sound.preload = 'auto'; }
    let sounded = false;
    const playSound = () => { if (sound && !sounded) { sounded = true; if (!document.hidden) void sound.play().catch(() => {}); } };
    const impact = () => { if (!impacted) { callbacks.current.onProgress?.(1); impacted = true; playSound(); callbacks.current.onImpact(); } };
    const finish = () => { if (!done) { done = true; impact(); callbacks.current.onComplete(); } };
    const track = document.createElement('video');
    video.current = track;
    track.playbackRate = 2.4; track.muted = !!move.sound || mutedRef.current; track.volume = .65; track.playsInline = true; track.preload = 'auto';
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: true });
    const width = 768, height = 512;
    const visited = new Uint8Array(width * height), queue = new Int32Array(width * height);
    const isFrozen = () => pausedRef.current || useWolfTutorial.getState().attackFrozen;
    let wasFrozen = false;
    const isAttack = !NON_ATTACK_MOVES.has(move.id);
    // The interactive tutorial suspends the first wolf lunge shortly before it lands.
    const tutorialPause = (progress: number) => {
      if (!isAttack || impacted || progress < .6 || progress >= .92) return false;
      return useWolfTutorial.getState().triggerMidAttackPause(useSpellBattle.getState().encounterId);
    };
    const freeze = () => { wasFrozen = true; if (!track.paused) track.pause(); if (sound && !sound.paused) sound.pause(); };
    const start = () => {
      if (document.hidden || done || reduced || !move.video || isFrozen()) return;
      void track.play().catch(() => {
        // Muted playback is allowed even when the browser blocks audible autoplay.
        track.muted = true; void track.play().catch(finish);
      });
    };
    const visibility = () => { previous = performance.now(); if (document.hidden) { track.pause(); sound?.pause(); } else { start(); if (sounded && sound && !sound.ended) void sound.play().catch(() => {}); } };
    const tick = (now: number) => {
      if (done) return;
      const delta = Math.min(now - previous, 250); previous = now;
      if (!document.hidden && isFrozen()) {
        // Hold the last drawn frame on the canvas; time and impact do not advance.
        freeze();
      } else if (!document.hidden) {
        if (wasFrozen) {
          wasFrozen = false;
          start();
          if (sounded && sound && !sound.ended) void sound.play().catch(() => {});
        }
        elapsed += delta;
        if (reduced || !move.video) {
          const progress = Math.min(1, elapsed / 300);
          callbacks.current.onProgress?.(progress);
          if (tutorialPause(progress)) freeze();
          else {
            if (elapsed >= 300) impact();
            if (elapsed >= 800) finish();
          }
        } else {
          if (track.readyState >= 2 && !track.seeking && track.currentTime >= move.start) {
            if (track.currentTime !== lastDraw && ctx) {
              lastDraw = track.currentTime;
              try {
                ctx.drawImage(track, 0, 0, width, height);
                const pixels = ctx.getImageData(0, 0, width, height);
                clearBackdrop(pixels, visited, queue);
                // Boss clips also contain white matte islands inside the torn cape/axe.
                // Remove these neutral whites while retaining the colored Scorn glow.
                if (move.video?.startsWith('/art/boss/')) {
                  for (let i = 0; i < pixels.data.length; i += 4) {
                    const lo = Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
                    const hi = Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
                    if (lo > 235 && hi - lo < 18) pixels.data[i + 3] = 0;
                  }
                }
                ctx.putImageData(pixels, 0, 0);
                setReady(true);
              } catch { finish(); }
            }
            const progress = Math.min(1, Math.max(0, (track.currentTime - move.start) / Math.max(.01, move.impact - move.start)));
            callbacks.current.onProgress?.(progress);
            if (tutorialPause(progress)) freeze();
            else {
              if (track.currentTime >= move.impact - .25) playSound();
              if (track.currentTime >= move.impact) impact();
              if (track.currentTime >= move.end) finish();
            }
          }
          // Finite, visible-time fallback covers loading errors and stalled media.
          if (elapsed > (move.end - move.start) / 2.4 * 1000 + 6000) finish();
        }
      }
      if (!done) raf = requestAnimationFrame(tick);
    };
    track.onloadedmetadata = () => { if (move.start > 0) track.currentTime = move.start; else start(); };
    track.onseeked = start; track.onended = finish; track.onerror = finish;
    document.addEventListener('visibilitychange', visibility);
    if (move.video && !reduced) track.src = move.video;
    raf = requestAnimationFrame(tick);
    return () => {
      done = true; cancelAnimationFrame(raf); track.onloadedmetadata = null; track.onseeked = null; track.onended = null; track.onerror = null;
      if (sound) { sound.pause(); sound.removeAttribute('src'); sound.load(); } effectAudio.current = null;
      track.pause(); track.removeAttribute('src'); track.load(); video.current = null;
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [move, reduced]);
  useEffect(() => { if (video.current) video.current.muted = !!move.sound || muted; if (effectAudio.current) effectAudio.current.muted = muted; }, [muted, move.sound]);
  return <div className="wolf-move-animation" data-move={move.id}>
    <img className="wolf-sprite" src={sprite} alt="" style={{ opacity: ready ? 0 : 1 }} />
    <canvas ref={canvas} width={768} height={512} aria-label={move.name} role="img" style={{ opacity: ready ? 1 : 0 }} />
  </div>;
}
