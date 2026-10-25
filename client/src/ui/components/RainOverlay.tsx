import { useEffect, useRef } from 'react';
import { drawRain } from '../rain';

export function RainOverlay() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    function render(now: number) {
      ctx!.clearRect(0, 0, canvas.width, canvas.height);
      if (reduced.matches || document.hidden) return;
      drawRain(ctx!, canvas.width, canvas.height, now / 1000);
      frame = requestAnimationFrame(render);
    }
    function restart() { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }
    const observer = new ResizeObserver(() => {
      canvas.width = Math.round(canvas.clientWidth); canvas.height = Math.round(canvas.clientHeight); restart();
    });
    observer.observe(canvas);
    reduced.addEventListener('change', restart);
    document.addEventListener('visibilitychange', restart);
    restart();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); reduced.removeEventListener('change', restart); document.removeEventListener('visibilitychange', restart); };
  }, []);
  return <canvas ref={ref} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}
