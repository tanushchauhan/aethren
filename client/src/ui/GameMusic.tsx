import { useEffect, useRef, useState } from 'react';
const track = 'title';
const TRACKS = { title: '/audio/whispers_of_the_enchanted_vale_title_theme.wav' };
export function GameMusic() {
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem('ouam-music') !== 'off'; } catch { return true; } });
  const [unlocked, setUnlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = new Audio(); audio.loop = true; audio.preload = 'none'; audio.volume = .28; player.current = audio;
    return () => { audio.pause(); audio.removeAttribute('src'); audio.load(); player.current = null; };
  }, []);
  useEffect(() => {
    const unlock = (e: Event) => { if ((e.target as HTMLElement)?.closest?.('.music-control')) return; setUnlocked(true); };
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);
  useEffect(() => {
    const audio = player.current!;
    const play = () => { if (enabled && !document.hidden) void audio.play().then(() => setFailed(false)).catch(() => setFailed(true)); else audio.pause(); };
    if (audio.getAttribute('src') !== TRACKS[track]) { audio.src = TRACKS[track]; audio.load(); }
    play(); document.addEventListener('visibilitychange', play);
    return () => { document.removeEventListener('visibilitychange', play); audio.pause(); };
  }, [track, enabled, unlocked]);
  function toggle() {
    const next = failed ? true : !enabled;
    setUnlocked(true); setEnabled(next); setFailed(false);
    try { localStorage.setItem('ouam-music', next ? 'on' : 'off'); } catch { /* Storage can be unavailable in private contexts. */ }
    if (next) void player.current?.play().catch(() => setFailed(true));
  }
  return <button className="music-control" onClick={toggle} aria-label={failed ? 'Enable music' : enabled ? 'Mute music' : 'Enable music'} aria-pressed={enabled && !failed} data-track={track}>{failed ? '♪ Enable music' : enabled ? '♪ Music on' : '♪ Music off'}</button>;
}
