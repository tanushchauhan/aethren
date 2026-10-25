import { useEffect, useRef } from 'react';
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Three independently rendered layers: forest, moon/light, rotating clouds. */
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
    const pointer = (e: PointerEvent) => { if (motion.matches) return; targetX = clamp(e.clientX / width * 2 - 1, -1, 1); targetY = clamp(e.clientY / height * 2 - 1, -1, 1); };
    const reset = () => { targetX = 0; targetY = 0; };
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
      ctx!.save(); ctx!.globalCompositeOperation = 'screen';
      // Bloom is emitted from the moon in scene coordinates, not a CSS overlay.
      for (const blur of [65, 30, 12]) {
        ctx!.shadowColor = '#9cd9f5'; ctx!.shadowBlur = blur * ratio;
        ctx!.fillStyle = `rgba(171,221,245,${.15 * breath})`;
        ctx!.beginPath(); ctx!.arc(moonX, moonY, moonRadius, 0, Math.PI * 2); ctx!.fill();
      }
      ctx!.shadowBlur = 0;
      // Layered soft shafts with brighter cores, fading into the forest mist.
      // Segment opacity supplies depth without adding gradients to the interface.
      for (let i = 0; i < 7; i++) {
        const drift = Math.sin(elapsed * .10 + i * 1.7) * 12;
        const endX = moonX - width * (.05 + i * .055) + drift - cameraX * 20;
        const endY = height * (.78 + (i % 3) * .08);
        const startX = moonX;
        const startY = moonY;
        const strength = (.26 + .08 * Math.sin(elapsed * .15 + i) ** 2) * breath;
        for (const core of [false, true]) {
          ctx!.filter = core ? 'blur(2px)' : 'blur(8px)';
          const spread = (core ? 5 : 22) * clamp(width / 1100, .65, 1.4);
          for (let step = 0; step < 18; step++) {
            const t0 = step / 18, t1 = (step + 1) / 18;
            const x0 = startX + (endX - startX) * t0;
            const y0 = startY + (endY - startY) * t0;
            const x1 = startX + (endX - startX) * t1;
            const y1 = startY + (endY - startY) * t1;
            const w0 = t0 * spread, w1 = t1 * spread;
            const fade = (1 - t0) ** 1.1;
            ctx!.fillStyle = `rgba(179,226,248,${strength * fade * (core ? .65 : 1)})`;
            ctx!.beginPath(); ctx!.moveTo(x0 - w0, y0); ctx!.lineTo(x1 - w1, y1 + 1); ctx!.lineTo(x1 + w1, y1 + 1); ctx!.lineTo(x0 + w0, y0); ctx!.closePath(); ctx!.fill();
          }
        }
      }
      // Let the surrounding blue atmosphere show through the lunar surface.
      ctx!.filter = 'blur(0.45px)'; ctx!.globalCompositeOperation = 'source-over';
      ctx!.shadowColor = '#89bdce80'; ctx!.shadowBlur = 25 * ratio;
      if (moonReady) {
        const diameter = moonRadius * 2.22;
        ctx!.globalAlpha = .88;
        ctx!.drawImage(moonSurface, moonX - diameter / 2, moonY - diameter / 2, diameter, diameter);
        // A low-opacity, defocused light pass blends the rim into the cloud haze.
        ctx!.shadowBlur = 0; ctx!.globalCompositeOperation = 'screen';
        ctx!.globalAlpha = .10 * breath; ctx!.filter = 'blur(3px)';
        ctx!.drawImage(moonSurface, moonX - diameter / 2, moonY - diameter / 2, diameter, diameter);
      }
      ctx!.restore();
      if (!motion.matches) {
        ctx!.strokeStyle = '#bad9e633'; ctx!.lineWidth = .8;
        ctx!.beginPath();
        for (let i = 0; i < 90; i++) {
          const y = ((i * 173 + elapsed * (420 + i % 4 * 90)) % (height + 80)) - 40;
          const x = ((i * 139 - elapsed * 70) % (width + 100) + width + 100) % (width + 100) - 50;
          ctx!.moveTo(x, y); ctx!.lineTo(x - 9, y + 26 + i % 5 * 3);
        }
        ctx!.stroke();
        frame = requestAnimationFrame(render);
      }
    }
    const redraw = () => { cancelAnimationFrame(frame); previous = 0; frame = requestAnimationFrame(render); };
    const resize = () => { width = canvas.clientWidth; height = canvas.clientHeight; ratio = Math.min(devicePixelRatio || 1, 1.5); canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); redraw(); };
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
      moonReady = true; redraw();
    };
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden) redraw(); };
    window.addEventListener('pointermove', pointer); window.addEventListener('blur', reset); document.documentElement.addEventListener('pointerleave', reset);
    document.addEventListener('visibilitychange', visibility); motion.addEventListener('change', redraw);
    resize();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); forest.onload = null; clouds.onload = null; moon.onload = null; window.removeEventListener('pointermove', pointer); window.removeEventListener('blur', reset); document.documentElement.removeEventListener('pointerleave', reset); document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', redraw); };
  }, []);
  return <canvas ref={ref} className="forest-canvas" aria-hidden="true" />;
}
