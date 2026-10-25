import { useEffect, useRef } from 'react';

export function useBattleMusic(muted: boolean, src = '/audio/final-surge.mp3') {
  const audio = useRef<HTMLAudioElement | null>(null);
  const isMuted = useRef(muted);
  isMuted.current = muted;
  useEffect(() => {
    const track = new Audio(src);
    audio.current = track;
    track.loop = true;
    track.volume = 0;
    track.muted = isMuted.current;
    const start = () => { if (!document.hidden) void track.play().catch(() => {}); };
    const visibility = () => { if (document.hidden) track.pause(); else start(); };
    const fade = window.setInterval(() => { track.volume += (.45 - track.volume) * .04; }, 60);
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
    document.addEventListener('visibilitychange', visibility);
    start();
    return () => {
      clearInterval(fade);
      track.pause(); track.removeAttribute('src'); track.load(); audio.current = null;
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [src]);
  useEffect(() => { if (audio.current) audio.current.muted = muted; }, [muted]);
}
