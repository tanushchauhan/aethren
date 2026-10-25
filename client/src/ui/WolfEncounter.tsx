import { WolfCombatStage } from './WolfCombatStage';
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { VisualNovelDialogue } from './components/VisualNovelDialogue';
import { RainOverlay } from './components/RainOverlay';

export function WolfEncounter({ muted, onToggleSound }: { muted: boolean; onToggleSound: () => void }) {
  const [choice, setChoice] = useState<'stay' | 'run' | null>(null);
  const reduced = useReducedMotion();
  const [stage, setStage] = useState<'story' | 'transition' | 'combat'>('story');
  useEffect(() => {
    ['/art/combat/wolf-clearing.png', '/art/combat/wolf-stalker.png', '/art/combat/wolf-leader.png'].forEach(src => { const image = new Image(); image.src = src; });
  }, []);
  const firstChoice = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstChoice.current?.focus(); }, []);
  if (stage === 'combat') return <WolfCombatStage muted={muted} onToggleSound={onToggleSound} />;
  return <motion.main initial={false} animate={{ opacity: stage === 'transition' ? 0 : 1 }}
    transition={{ duration: reduced ? .15 : .7 }}
    onAnimationComplete={() => { if (stage === 'transition') setStage('combat'); }}
    className="scripted-intro" aria-label={choice ? 'Wolf encounter' : 'Choose your path'}>
    <img className="story-arrival" src="/art/intro/shadow-voices.png" alt="Two shadowed figures wait in the forest" />
    {choice && <motion.img key={choice} className="wolf-arrival" src="/art/intro/wolf-emerges.png"
      alt="A wolf emerges from wet bushes, baring its teeth and advancing directly toward you"
      initial={reduced ? false : { opacity: 0, scale: 1, y: 12 }}
      animate={{ opacity: 1, scale: reduced ? 1 : 1.08, y: 0 }}
      transition={{ opacity: { duration: 1.5 }, scale: { duration: 7, ease: 'easeOut' }, y: { duration: 3 } }} />}
    <RainOverlay />
    {!choice ? <section className="novel-dialogue path-choice" aria-labelledby="path-choice-title">
      <div className="novel-speaker">Child</div>
      <h2 id="path-choice-title">…Which?</h2>
      <p>The voices fall silent. The next step is yours.</p>
      <div className="path-options">
        <button ref={firstChoice} onClick={() => setChoice('stay')}><span aria-hidden="true">◆</span> Stay <small>Stand your ground.</small></button>
        <button onClick={() => setChoice('run')}><span aria-hidden="true">◆</span> Run <small>Follow the path into the dark.</small></button>
      </div>
    </section> : <VisualNovelDialogue key={choice} muted={muted} onComplete={() => setStage('transition')} lines={[
      { speaker: 'The forest', color: '#b9cdca', voicePitch: .7, voiceVolume: .36,
        text: choice === 'stay' ? 'You stay. The bushes ahead tremble. Something has been waiting for you to stop moving.' : 'You run. Wet branches claw at the path. A shape bursts from the bushes, cutting off your escape.' },
      { speaker: 'The forest', color: '#d9c5a5', voicePitch: .7, voiceVolume: .36,
        text: 'A **wolf** steps into the clearing. Its eyes find yours. It lowers its head—and comes for you.' },
    ]} />}
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
