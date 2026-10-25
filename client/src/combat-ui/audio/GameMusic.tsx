import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../../net/store';
import { onNarrationActive } from './tts';
const TRACKS = {
  title: '/audio/whispers_of_the_enchanted_vale_title_theme.wav',
  combat: '/audio/arcane_initiative.wav',
  boss: '/audio/eclipse_of_the_archmage_boss_theme.wav',
};
export function GameMusic() {
  const phase = useGameStore(s => s.gameState?.phase);
  const track = phase === 'boss' ? 'boss' : phase === 'encounter' || phase === 'calibrating' ? 'combat' : 'title';
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem('ouam-music') !== 'off'; } catch { return true; } });
  const [unlocked, setUnlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const speaking = useRef(false); const recording = useRef(false);
  useEffect(() => {
    const audio = new Audio(); audio.loop = true; audio.preload = 'none'; audio.volume = .28; player.current = audio;
    const volume = () => { audio.volume = recording.current ? .025 : speaking.current ? .07 : .28; };
    const off = onNarrationActive(active => { speaking.current = active; volume(); });
    const mic = (e: Event) => { recording.current = (e as CustomEvent<boolean>).detail; volume(); };
    window.addEventListener('ouam:recording', mic);
    return () => { off(); window.removeEventListener('ouam:recording', mic); audio.pause(); audio.removeAttribute('src'); audio.load(); player.current = null; };
  }, []);
  useEffect(() => {
    const unlock = (e: Event) => { if ((e.target as HTMLElement)?.closest?.('.music-control')) return; setUnlocked(true); };
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);
  useEffect(() => {
    const audio = player.current!;
    const play = () => { if (enabled && unlocked && !document.hidden) void audio.play().then(() => setFailed(false)).catch(() => setFailed(true)); else audio.pause(); };
    if (audio.getAttribute('src') !== TRACKS[track]) { audio.src = TRACKS[track]; audio.load(); }
    play(); document.addEventListener('visibilitychange', play);
    return () => { document.removeEventListener('visibilitychange', play); audio.pause(); };
  }, [track, enabled, unlocked]);
  function toggle() {
    const next = !unlocked || failed ? true : !enabled;
    setUnlocked(true); setEnabled(next); setFailed(false);
    try { localStorage.setItem('ouam-music', next ? 'on' : 'off'); } catch { /* Storage can be unavailable in private contexts. */ }
    if (next) void player.current?.play().catch(() => setFailed(true));
  }
  return <button className="music-control" onClick={toggle} aria-label={!unlocked || failed ? 'Enable music' : enabled ? 'Mute music' : 'Enable music'} aria-pressed={enabled && unlocked && !failed} data-track={track}>{!unlocked || failed ? '♪ Enable music' : enabled ? '♪ Music on' : '♪ Music off'}</button>;
}
