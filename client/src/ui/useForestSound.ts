import { useEffect, useRef } from 'react';

export function useForestSound(line: number, frame: number, finished: boolean, muted: boolean) {
  const audio = useRef<{ rain: HTMLAudioElement; swell: HTMLAudioElement; branch: HTMLAudioElement; lightning: HTMLAudioElement } | null>(null);
  const target = useRef(0);
  target.current = muted ? 0 : finished ? .24 : line < 2 ? .1 : line === 6 ? .025 : .12;
  useEffect(() => {
    const tracks = { rain: new Audio('/audio/forest-rain.m4a'), swell: new Audio('/audio/eerie-swell.m4a'), branch: new Audio('/audio/branch-snap.m4a'), lightning: new Audio('/audio/rift-lightning.m4a') };
    tracks.rain.loop = true; tracks.rain.volume = 0;
    tracks.swell.volume = .6; tracks.lightning.volume = .65; tracks.branch.volume = .5;
    audio.current = tracks;
    const start = () => { if (!document.hidden) void tracks.rain.play().catch(() => {}); };
    const visibility = () => { if (document.hidden) Object.values(tracks).forEach(track => track.pause()); else start(); };
    const fade = window.setInterval(() => { tracks.rain.volume += (target.current - tracks.rain.volume) * .06; }, 60);
    window.addEventListener('pointerdown', start); window.addEventListener('keydown', start);
    document.addEventListener('visibilitychange', visibility); start();
    return () => {
      clearInterval(fade); Object.values(tracks).forEach(track => { track.pause(); track.src = ''; }); audio.current = null;
      window.removeEventListener('pointerdown', start); window.removeEventListener('keydown', start); document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => { if (audio.current) Object.values(audio.current).forEach(track => { track.muted = muted; }); }, [muted]);
  useEffect(() => {
    if (frame !== 1 || finished) return;
    const track = audio.current?.swell;
    if (track) { track.currentTime = 18.4; void track.play().catch(() => {}); }
  }, [frame, finished]);
  useEffect(() => {
    if (frame !== 3 || finished || document.hidden) return;
    const track = audio.current?.lightning;
    if (track) { track.currentTime = 0; void track.play().catch(() => {}); }
  }, [frame, finished]);
  useEffect(() => {
    if (line !== 7 || finished) return;
    const track = audio.current?.branch;
    const timer = window.setTimeout(() => { if (track && !document.hidden) { track.currentTime = 0; void track.play().catch(() => {}); } }, 650);
    return () => clearTimeout(timer);
  }, [line, finished]);
  useEffect(() => { if (finished) { audio.current?.swell.pause(); audio.current?.branch.pause(); audio.current?.lightning.pause(); } }, [finished]);
}
