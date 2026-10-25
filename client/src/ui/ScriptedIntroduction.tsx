import { RainOverlay } from './components/RainOverlay';
import { useForestSound } from './useForestSound';
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useStoryStore } from '../net/storyStore';
import { VisualNovelDialogue, type DialogueLine } from './components/VisualNovelDialogue';
import { WolfEncounter } from './WolfEncounter';
import './scripted-introduction.css';

const ART = ['/art/intro/rift-dark.png', '/art/intro/rift-crack.png', '/art/intro/rift-open.png', '/art/intro/shadow-voices.png'];

export function ScriptedIntroduction() {
  const multiplayer = useStoryStore(s => s.adventureMode === 'online');
  const [line, setLine] = useState(0);
  const [frame, setFrame] = useState(0);
  const [riftFinished, setRiftFinished] = useState(false);
  const [finished, setFinished] = useState(false);
  const [muted, setMuted] = useState(false);
  useForestSound(line, frame, finished, muted);
  const sound = useRef<HTMLAudioElement | null>(null);
  const reduced = useReducedMotion();
  const rift = line === 2 && !riftFinished && !finished;
  const lines: DialogueLine[] = [
    { speaker: 'Anonymous One', voicePitch: 0.75, voiceVolume: 0.44, color: '#bdcdeb', text: 'Listen.' },
    { speaker: 'Anonymous Two', voicePitch: 0.9, voiceVolume: 0.42, color: '#c5b5df', text: 'The forest holds its breath.' },
    { speaker: 'The forest', voicePitch: 0.7, voiceVolume: 0.32, color: '#a9bbb6', text: '*Light—not day, not moon—splits the trees.*' },
    { speaker: 'Child', voicePitch: 1.35, voiceVolume: 0.4, color: '#e3d4aa', text: '…Cold.' },
    { speaker: 'Anonymous One', voicePitch: 0.75, voiceVolume: 0.44, color: '#bdcdeb', text: 'It speaks..' },
    { speaker: multiplayer ? 'Children · in unison' : 'Child', voicePitch: 1.25, voiceVolume: .44, color: '#e3d4aa', text: 'Did it close?' },
    { speaker: 'Anonymous', voicePitch: 0.65, voiceVolume: 0.46, color: '#b0c8c4', text: 'Behind you. **Forever.**' },
    { speaker: 'The forest', voicePitch: 0.7, voiceVolume: 0.32, color: '#a9bbb6', text: '*Wind. A branch snaps. Far off, the slow crack does not return—yet.*' },
    { speaker: 'Voice A', voicePitch: 0.8, voiceVolume: 0.48, color: '#e2aaa0', text: `Run, little ${multiplayer ? 'shadows' : 'shadow'}.` },
    { speaker: 'Voice B', voicePitch: 1.1, voiceVolume: 0.44, color: '#99cbbd', text: `Stay, little ${multiplayer ? 'shadows' : 'shadow'}.` },
    { speaker: 'Child', voicePitch: 1.35, voiceVolume: 0.4, color: '#e3d4aa', text: '…Which?' },
  ];
  useEffect(() => {
    [...ART, '/art/forest-base.png', '/art/intro/wolf-emerges.png'].forEach(src => { const image = new Image(); image.src = src; });
    const audio = new Audio('/audio/rift-fracture.mp3');
    audio.volume = .55; audio.preload = 'auto'; sound.current = audio;
    return () => { audio.pause(); audio.src = ''; sound.current = null; };
  }, []);
  useEffect(() => { if (sound.current) sound.current.muted = muted; }, [muted]);
  useEffect(() => {
    if (!rift) return;
    const crack = window.setTimeout(() => {
      setFrame(1);
      void sound.current?.play().catch(() => { /* Visual sequence works when autoplay is blocked. */ });
    }, 1400);
    const open = window.setTimeout(() => {
      setFrame(2);
      if (sound.current && !document.hidden) { sound.current.currentTime = 0; sound.current.volume = .65; void sound.current.play().catch(() => {}); }
    }, 3200);
    const finalCrack = window.setTimeout(() => {
      setFrame(3);
      if (sound.current && !document.hidden) { sound.current.currentTime = 0; sound.current.volume = .45; void sound.current.play().catch(() => {}); }
    }, 4500);
    const end = window.setTimeout(() => setRiftFinished(true), 5500);
    return () => { clearTimeout(crack); clearTimeout(open); clearTimeout(finalCrack); clearTimeout(end); sound.current?.pause(); };
  }, [rift]);
  function finish() { sound.current?.pause(); setFinished(true); }
  if (finished) return <WolfEncounter muted={muted} onToggleSound={() => setMuted(!muted)} />;
  const image = line >= 3 ? ART[3] : line === 2 ? ART[Math.min(frame, 2)] : ART[0];
  return <main className="scripted-intro" aria-label="Introduction">
    <motion.div className="intro-camera" initial={reduced ? false : { scale: 1, x: 0 }}
      animate={{ scale: reduced ? 1 : 1.055, x: reduced ? 0 : '-.6%' }}
      transition={{ duration: 36, ease: 'linear' }}>
    {ART.map(src => <motion.img className="intro-scene" key={src} src={src} alt="" initial={false}
      animate={{ opacity: src === image ? 1 : 0 }} transition={{ duration: reduced ? 0 : 1.1 }} />)}
    {line >= 3 && <div className={`intro-children ${multiplayer ? 'multiple' : ''}`} aria-label={multiplayer ? 'Two lost children' : 'A lost child'}>
      <img src="/art/spellbearer-male.png" alt="A small shadow in the forest" />
      {multiplayer && <img src="/art/spellbearer-female.png" alt="Another small shadow beside them" />}
    </div>}
    </motion.div>
    {(line >= 3 || frame > 0) && <RainOverlay />}
    <div className="intro-dialogue-wrap" hidden={rift}>
      <VisualNovelDialogue advanceTo={riftFinished ? 3 : undefined} muted={muted} active={!rift} lines={lines} onLineChange={setLine} onComplete={finish} />
    </div>
    {rift && frame === 3 && <motion.div className="rift-flash" aria-hidden="true"
      initial={{ opacity: reduced ? .12 : .9, backgroundColor: '#ffffff' }}
      animate={{ opacity: 0, backgroundColor: '#a46bde' }}
      transition={{ duration: 1, ease: 'easeOut' }} />}
    {rift && <button className="intro-skip" data-glove-hold-b2 onClick={finish}>Skip introduction » <kbd className="glove-key">Hold B2</kbd></button>}
    <button className="intro-sound" aria-pressed={muted} onClick={() => setMuted(!muted)}>{muted ? 'Sound off' : 'Sound on'}</button>
  </main>;
}
