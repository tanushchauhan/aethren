import { useEffect, useRef } from 'react';
import './scorn-flames.css';

/** Tinted flame/smoke textures with rising, curling wisps. Simulation is presentation-only. */
export function ScornFlames({ field = false, reduced = false }: { field?: boolean; reduced?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d'); if (!ctx) return;
    let raf = 0, stopped = false, previous = performance.now();
    const width = field ? 1280 : 640, height = field ? 720 : 480;
    element.width = width; element.height = height;
    const particles = Array.from({length: field ? 130 : 65}, (_, i) => ({ age: (i * .37) % 3, life: 1.7 + (i % 7) * .23, seed: i }));
    const sources = ['fire_01', 'smoke_01'].map(name => {
      const img = new Image(); img.src = `/art/particles/${name}.png`; return img;
    });
    const tinted: HTMLCanvasElement[] = [];
    const draw = (now: number) => {
      if (stopped) return;
      const dt = document.hidden || reduced ? 0 : Math.min((now - previous) / 1000, .05); previous = now;
      ctx.clearRect(0, 0, width, height); ctx.globalCompositeOperation = 'screen';
      for (const p of particles) {
        p.age = (p.age + dt) % p.life;
        const t = p.age / p.life, phase = p.seed * 2.399;
        const x0 = field ? (p.seed % 3 === 0 ? (p.seed % 2 ? width * .03 : width * .97) : (p.seed * 83 % width)) : width * (.5 + Math.cos(phase) * .33);
        const y0 = field ? (p.seed % 3 === 0 ? height * (.35 + (p.seed % 8) * .07) : height * (.72 + (p.seed % 4) * .07)) : height * (.83 + Math.sin(phase) * .08);
        const x = x0 + Math.sin(t * 5 + phase) * (field ? 22 : 14), y = y0 - t * (field ? 170 : 230);
        const size = (field ? 65 : 48) * (1 - t * .6);
        const fade = Math.sin(Math.PI * t) * (field ? .48 : .6);
        const texture = tinted[p.seed % 5 === 0 ? 1 : 0];
        ctx.globalAlpha = fade;
        if (texture) ctx.drawImage(texture, x - size / 2, y - size, size, size * (p.seed % 5 === 0 ? 1 : 1.7));
        // Thin tapered wisps drift above the flame tongues.
        if (p.seed % 3 === 0) {
          ctx.strokeStyle = '#c48bfa'; ctx.lineWidth = Math.max(.5, 2 * (1 - t));
          ctx.beginPath(); ctx.moveTo(x,y); ctx.bezierCurveTo(x+18,y-16,x-17,y-38,x+Math.sin(phase+t*6)*24,y-65); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    let loaded = 0;
    sources.forEach((img, index) => {
      const ready = () => {
        if (stopped) return;
        const sprite = document.createElement('canvas'); sprite.width = sprite.height = 128;
        const c = sprite.getContext('2d')!;
        if (img.naturalWidth) { c.drawImage(img,0,0,128,128); c.globalCompositeOperation = 'source-in'; c.fillStyle = index ? '#8861ae' : '#b366ff'; c.fillRect(0,0,128,128); }
        tinted[index] = sprite;
        if (++loaded === sources.length) draw(performance.now());
      };
      if (img.complete) ready(); else { img.onload = ready; img.onerror = ready; }
    });
    return () => { stopped = true; cancelAnimationFrame(raf); sources.forEach(img => { img.onload = null; img.onerror = null; }); };
  }, [field, reduced]);
  return <canvas ref={canvas} className={field ? 'scorn-field-flames' : 'scorn-knight-aura'} aria-hidden="true" />;
}
