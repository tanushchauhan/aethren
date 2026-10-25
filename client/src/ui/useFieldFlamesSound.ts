import { useEffect, useRef } from 'react';
export function useFieldFlamesSound(active: boolean, muted: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(muted); mutedRef.current = muted;
  useEffect(() => {
    if (!active) return;
    const track = new Audio('/audio/scorn-flames.wav'); audio.current = track;
    track.loop = true; track.volume = .2; track.muted = mutedRef.current;
    const start = () => { if (!document.hidden) void track.play().catch(() => {}); };
    const visibility = () => document.hidden ? track.pause() : start();
    document.addEventListener('visibilitychange',visibility); window.addEventListener('pointerdown',start); start();
    return () => { track.pause(); track.removeAttribute('src'); track.load(); audio.current = null; document.removeEventListener('visibilitychange',visibility); window.removeEventListener('pointerdown',start); };
  },[active]);
  useEffect(() => { if (audio.current) audio.current.muted = muted; },[muted]);
}
