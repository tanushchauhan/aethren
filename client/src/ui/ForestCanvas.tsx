import { drawRain } from './rain';
import { useEffect, useRef } from 'react';
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Light-shaft layers render at a fraction of the screen; upscaling them is the blur. */
const SHAFT_GLOW_SCALE = 1 / 6;
const SHAFT_CORE_SCALE = 1 / 2;
/** The title is painted art behind a menu: one canvas pixel per CSS pixel is plenty. */
const MAX_RATIO = 1;

function offscreen(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return [canvas, canvas.getContext('2d')];
}

/**
 * Three independently rendered layers: forest, moon/light, rotating clouds.
 *
 * Performance: everything blurred is cached. Canvas `filter`/`shadowBlur` re-blur a full layer
 * per draw call, so the moon glow and disc are pre-rendered sprites (rebuilt on resize) and the
 * shafts are drawn unfiltered into small offscreen canvases that the GPU upscales.
 */
export function ForestCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const forest = new Image(); const clouds = new Image(); const moon = new Image();
    forest.src = '/art/forest-base.png'; clouds.src = '/art/storm-clouds.png'; moon.src = '/art/lunar-texture-v2.png';
    // Cache a scene-toned copy; keep the source artwork intact.
    const moonSurface = document.createElement('canvas');
    moonSurface.width = 384; moonSurface.height = 384;
    const surface = moonSurface.getContext('2d');
    let moonReady = false;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 1, height = 1, ratio = 1, frame = 0, disposed = false;
    let targetX = 0, targetY = 0, cameraX = 0, cameraY = 0, elapsed = 0, previous = 0;
    let glow: [HTMLCanvasElement, CanvasRenderingContext2D | null] = offscreen(1, 1);
    let core: [HTMLCanvasElement, CanvasRenderingContext2D | null] = offscreen(1, 1);
    let bloomSprite: HTMLCanvasElement | null = null;
    let discSprite: HTMLCanvasElement | null = null;
    let spriteRadius = 0;

    const pointer = (e: PointerEvent) => { if (motion.matches) return; targetX = clamp(e.clientX / width * 2 - 1, -1, 1); targetY = clamp(e.clientY / height * 2 - 1, -1, 1); };
    const reset = () => { targetX = 0; targetY = 0; };

    /** Moon bloom (three soft halos) and the toned disc with its rim light, blurred once. */
    function buildMoonSprites(moonRadius: number): void {
      spriteRadius = moonRadius;
      const pad = 90;
      const size = (moonRadius + pad) * 2;
      const [bloom, b] = offscreen(size, size);
      if (b) {
        b.globalCompositeOperation = 'screen';
        for (const blur of [65, 30, 12]) {
          b.shadowColor = '#9cd9f5'; b.shadowBlur = blur;
          b.fillStyle = 'rgba(171,221,245,.15)';
          b.beginPath(); b.arc(size / 2, size / 2, moonRadius, 0, Math.PI * 2); b.fill();
        }
      }
      bloomSprite = bloom;
      discSprite = null;
      if (!moonReady) return;
      const diameter = moonRadius * 2.22;
      const discPad = 40;
      const discSize = diameter + discPad * 2;
      const [disc, d] = offscreen(discSize, discSize);
      if (d) {
        const at = discPad;
        d.filter = 'blur(0.45px)';
        d.shadowColor = '#89bdce80'; d.shadowBlur = 25;
        d.globalAlpha = .88;
        d.drawImage(moonSurface, at, at, diameter, diameter);
        d.shadowBlur = 0; d.globalCompositeOperation = 'screen';
        d.globalAlpha = .087; d.filter = 'blur(3px)';
        d.drawImage(moonSurface, at, at, diameter, diameter);
      }
      discSprite = disc;
    }

    /** Draws the seven shafts, unfiltered, into one low-resolution layer. */
    function drawShafts(target: CanvasRenderingContext2D, scale: number, isCore: boolean, moonX: number, moonY: number, breath: number): void {
      target.setTransform(scale, 0, 0, scale, 0, 0);
      target.clearRect(0, 0, width, height);
      const spread = (isCore ? 5 : 22) * clamp(width / 1100, .65, 1.4);
      for (let i = 0; i < 7; i++) {
        const drift = Math.sin(elapsed * .10 + i * 1.7) * 12;
        const endX = moonX - width * (.05 + i * .055) + drift - cameraX * 20;
        const endY = height * (.78 + (i % 3) * .08);
        const strength = (.26 + .08 * Math.sin(elapsed * .15 + i) ** 2) * breath;
        for (let step = 0; step < 18; step++) {
          const t0 = step / 18, t1 = (step + 1) / 18;
          const x0 = moonX + (endX - moonX) * t0;
          const y0 = moonY + (endY - moonY) * t0;
          const x1 = moonX + (endX - moonX) * t1;
          const y1 = moonY + (endY - moonY) * t1;
          const w0 = t0 * spread, w1 = t1 * spread;
          const fade = (1 - t0) ** 1.1;
          target.fillStyle = `rgba(179,226,248,${strength * fade * (isCore ? .65 : 1)})`;
          target.beginPath(); target.moveTo(x0 - w0, y0); target.lineTo(x1 - w1, y1 + 1); target.lineTo(x1 + w1, y1 + 1); target.lineTo(x0 + w0, y0); target.closePath(); target.fill();
        }
      }
    }

    function render(now: number) {
      frame = 0;
      if (disposed || document.hidden) return;
      if (now - previous < 32 && !motion.matches) { frame = requestAnimationFrame(render); return; }
      const dt = previous ? Math.min((now - previous) / 1000, .08) : 0; previous = now;
      if (!motion.matches) elapsed += dt;
      cameraX += (targetX - cameraX) * .055; cameraY += (targetY - cameraY) * .055;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx!.globalCompositeOperation = 'source-over'; ctx!.globalAlpha = 1;
      ctx!.fillStyle = '#071015'; ctx!.fillRect(0, 0, width, height);
      if (forest.complete && forest.naturalWidth) {
        const scale = Math.max(width / forest.naturalWidth, height / forest.naturalHeight) * 1.10;
        const dw = forest.naturalWidth * scale, dh = forest.naturalHeight * scale;
        // Overscan and hard clamps prevent exposing any unpainted image border.
        const x = clamp((width - dw) / 2 - cameraX * 30, width - dw, 0);
        const y = clamp((height - dh) / 2 - cameraY * 20, height - dh, 0);
        ctx!.drawImage(forest, x, y, dw, dh);
        canvas.dataset.cameraX = x.toFixed(1); canvas.dataset.cameraY = y.toFixed(1);
        canvas.dataset.covered = String(x <= 0 && y <= 0 && x + dw >= width && y + dh >= height);
      }
      const moonX = width * .78 - cameraX * 12;
      const moonY = height * .19 - cameraY * 8;
      const moonRadius = clamp(width * .026, 19, 42);
      const cloudSize = clamp(width * .57, 310, 850);
      if (clouds.complete && clouds.naturalWidth) {
        ctx!.save(); ctx!.translate(moonX, moonY); ctx!.rotate(elapsed * .018);
        ctx!.globalAlpha = .72; ctx!.drawImage(clouds, -cloudSize / 2, -cloudSize / 2, cloudSize, cloudSize);
        ctx!.rotate(-elapsed * .03); ctx!.globalAlpha = .21;
        ctx!.drawImage(clouds, -cloudSize * .63, -cloudSize * .63, cloudSize * 1.26, cloudSize * 1.26); ctx!.restore();
      }
      const breath = .87 + Math.sin(elapsed * .22) * .10;
      if (!bloomSprite || spriteRadius !== moonRadius || (moonReady && !discSprite)) buildMoonSprites(moonRadius);
      ctx!.save(); ctx!.globalCompositeOperation = 'screen';
      // Bloom is emitted from the moon in scene coordinates, not a CSS overlay.
      if (bloomSprite) {
        ctx!.globalAlpha = breath;
        ctx!.drawImage(bloomSprite, moonX - bloomSprite.width / 2, moonY - bloomSprite.height / 2);
      }
      // Layered soft shafts with brighter cores, fading into the forest mist.
      ctx!.globalAlpha = 1;
      const [glowCanvas, glowCtx] = glow;
      const [coreCanvas, coreCtx] = core;
      if (glowCtx) {
        drawShafts(glowCtx, SHAFT_GLOW_SCALE, false, moonX, moonY, breath);
        ctx!.drawImage(glowCanvas, 0, 0, width, height);
      }
      if (coreCtx) {
        drawShafts(coreCtx, SHAFT_CORE_SCALE, true, moonX, moonY, breath);
        ctx!.drawImage(coreCanvas, 0, 0, width, height);
      }
      ctx!.globalCompositeOperation = 'source-over';
      // Let the surrounding blue atmosphere show through the lunar surface.
      if (discSprite) ctx!.drawImage(discSprite, moonX - discSprite.width / 2, moonY - discSprite.height / 2);
      ctx!.restore();
      if (!motion.matches) {
        drawRain(ctx!, width, height, elapsed);
        frame = requestAnimationFrame(render);
      }
    }
    const redraw = () => { cancelAnimationFrame(frame); previous = 0; frame = requestAnimationFrame(render); };
    const resize = () => {
      width = canvas.clientWidth; height = canvas.clientHeight;
      ratio = Math.min(devicePixelRatio || 1, MAX_RATIO);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      glow = offscreen(width * SHAFT_GLOW_SCALE, height * SHAFT_GLOW_SCALE);
      core = offscreen(width * SHAFT_CORE_SCALE, height * SHAFT_CORE_SCALE);
      bloomSprite = null;
      redraw();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    forest.onload = redraw; clouds.onload = redraw;
    moon.onload = () => {
      if (disposed || !surface) return;
      surface.clearRect(0, 0, 384, 384);
      surface.filter = 'contrast(0.72) brightness(0.94)';
      surface.drawImage(moon, 0, 0, 384, 384);
      surface.filter = 'none';
      surface.globalCompositeOperation = 'source-atop';
      surface.fillStyle = 'rgba(91,153,179,0.28)';
      surface.fillRect(0, 0, 384, 384);
      surface.globalCompositeOperation = 'source-over';
      moonReady = true; bloomSprite = null; redraw();
    };
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden) redraw(); };
    window.addEventListener('pointermove', pointer); window.addEventListener('blur', reset); document.documentElement.addEventListener('pointerleave', reset);
    document.addEventListener('visibilitychange', visibility); motion.addEventListener('change', redraw);
    resize();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); forest.onload = null; clouds.onload = null; moon.onload = null; window.removeEventListener('pointermove', pointer); window.removeEventListener('blur', reset); document.documentElement.removeEventListener('pointerleave', reset); document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', redraw); };
  }, []);
  return <canvas ref={ref} className="forest-canvas" aria-hidden="true" />;
}
