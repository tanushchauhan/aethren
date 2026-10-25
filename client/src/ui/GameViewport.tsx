import { useLayoutEffect, useState, type ReactNode } from 'react';

/** Preserve the stage composition on short displays rather than overflowing the page. */
export function GameViewport({ children }: { children: ReactNode }) {
  const measure = () => ({ width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight });
  const [size, setSize] = useState(measure);
  useLayoutEffect(() => {
    const update = () => setSize(measure());
    window.addEventListener('resize', update); window.visualViewport?.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, []);
  const scale = Math.min(1, size.width / 1100, size.height / 800);
  return <div className="game-viewport"><div className="game-surface" style={{ width: size.width / scale, height: size.height / scale, transform: `scale(${scale})` }}>{children}</div></div>;
}
