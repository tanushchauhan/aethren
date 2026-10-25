import type { CSSProperties } from 'react';
import './boss-atmosphere.css';
export function BossAtmosphere() {
  return <div className="boss-atmosphere" aria-hidden="true">
    <div className="boss-purple-haze" />
    <div className="boss-ground-smoke">{Array.from({ length: 7 }, (_, i) => <img key={i} src="/art/particles/smoke_01.png" alt=""
      style={{ '--smoke-index': i, left: `${i * 17 - 14}%`, animationDelay: `${-i * 2.1}s` } as CSSProperties} />)}</div>
  </div>;
}
export function GroundSmash() {
  return <div className="ground-smash" aria-hidden="true">
    <div className="ground-smash-ring" /><div className="ground-smash-ring second" />
    {Array.from({length: 14}, (_, i) => <i className="ground-debris" key={i} style={{ '--dx': `${(i - 6.5) * 35}px`, '--dy': `${-45 - (i % 4) * 27}px`, '--spin': `${i * 53}deg` } as CSSProperties} />)}
    {Array.from({length: 6}, (_, i) => <img className="impact-dust" src="/art/particles/smoke_01.png" alt="" key={`dust-${i}`} style={{ '--dx': `${(i - 2.5) * 100}px`, '--dy': `${-20 - (i % 3) * 20}px` } as CSSProperties} />)}
  </div>;
}
