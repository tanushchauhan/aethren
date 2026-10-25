import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useLandingSound } from './useLandingSound';
import { ScornFlames } from './components/ScornFlames';
import { BossAtmosphere, GroundSmash } from './components/BossAtmosphere';
import { RainOverlay } from './components/RainOverlay';
import { VisualNovelDialogue } from './components/VisualNovelDialogue';
import { WolfMoveAnimation } from './components/WolfMoveAnimation';
import { WolfCombatStage } from './WolfCombatStage';
import { CoopGather } from './components/CoopGather';
import { moves, knight } from '../combat/encounter';
import { resetHeroes, playerStore } from '../combat/playerState';
import { leaveCoop, startCoopBattle } from '../net/coopLink';
import { useSpellBattle } from '../combat/spellBattle';
import './boss-journey.css';

type Stage = 'escape' | 'castle' | 'descent' | 'warning' | 'gather' | 'battle' | 'ending';
export function AfterWolfEncounter({ muted, onToggleSound, initialStage = 'escape' }: { muted: boolean; onToggleSound: () => void; initialStage?: Stage }) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [landed, setLanded] = useState(false);
  const reduced = useReducedMotion();
  const landingPlayed = useRef(false);
  const impactSound = useLandingSound(muted, stage === 'castle' || stage === 'descent' || stage === 'warning');
  const land = () => {
    if (landingPlayed.current) return;
    landingPlayed.current = true; setLanded(true); impactSound.play();
  };
  const beginBattle = () => {
    leaveCoop();
    resetHeroes();
    playerStore.getState().setMagicPower(12);
    useSpellBattle.getState().reset('knight', false);
    setStage('battle');
  };
  // Both screens meet at the gate; the fight starts once a partner is found, or alone on request.
  const beginCoopBattle = () => { startCoopBattle(); setStage('battle'); };
  useEffect(() => () => leaveCoop(), []);
  if (stage === 'battle') return <WolfCombatStage key="knight" muted={muted} onToggleSound={onToggleSound} onFightAlone={beginBattle}
    onContinue={() => { leaveCoop(); setStage('ending'); }} />;
  const escape = stage === 'escape';
  return <motion.main className="wolf-combat-stage boss-journey" aria-label={escape ? 'Escape through the forest' : stage === 'ending' ? 'Demo complete' : 'The deserted castle'}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? .1 : .8 }}>
    <motion.div className="boss-journey-world" animate={landed && !reduced ? { x: [0,-98,86,-72,60,-44,30,-18,8,0], y: [0,74,-68,52,-42,30,-20,12,-5,0], rotate: [0,-2.2,1.9,-1.6,1.2,-.9,.6,-.3,.1,0], scale: [1,1.28,1.26,1.23,1.2,1.18,1.13,1.09,1.04,1] } : { x: 0, y: 0, rotate: 0, scale: 1 }} transition={{ duration: 1.2, ease: 'easeOut' }}>
    <motion.img key={escape ? 'forest' : 'castle'} className="wolf-combat-backdrop" src={escape ? '/art/boss/forest-escape.png' : '/art/boss/castle-gate.png'}
      alt={escape ? 'A small child in silhouette sprints through the moonlit forest' : 'An empty rain-soaked courtyard before the dark kingdom gate'}
      initial={{ opacity: 0, scale: 1 }} animate={{ opacity: 1, scale: reduced ? 1 : escape ? 1.16 : 1.04, x: reduced ? 0 : escape ? '-3%' : 0 }}
      transition={{ opacity: { duration: .6 }, scale: { duration: escape ? 3.5 : 10, ease: 'easeOut' }, x: { duration: 3.5 } }} />
    <RainOverlay />
    {escape && <VisualNovelDialogue key="escape" muted={muted} onComplete={() => setStage('castle')} lines={[
      { speaker: 'The forest', color: '#b9cdca', text: 'The last wolf falls. You **run**. Branches lash at your silhouette; your footsteps tear through the rain. You do not look back.' },
    ]} />}
    {stage === 'castle' && <VisualNovelDialogue key="castle" muted={muted} onComplete={() => { impactSound.prepare(); setStage('descent'); }} lines={[
      { speaker: 'Child', color: '#e8d9a6', text: 'A castle… Is anyone there?' },
      { speaker: 'The silence', color: '#b9cdca', text: 'No footsteps. No watchmen. Not even a bird. Only an immense gate, sealed against the dark. You catch your breath. For one moment, your strength returns.' },
      { speaker: 'Child', color: '#e8d9a6', text: 'There is nothing here…' },
    ]} />}
    {stage === 'descent' && <>
      <motion.div className="boss-descent" initial={reduced ? { opacity: 0 } : { y: '-90vh', scale: .7 }} animate={reduced ? { opacity: 1 } : { y: 0, scale: 1 }} transition={{ duration: reduced ? .15 : .42, ease: 'easeIn' }} onAnimationComplete={land}>
        <WolfMoveAnimation move={moves.descent} sprite={knight.sprite} muted={muted} reduced={!!reduced} onImpact={() => {}} onComplete={() => setStage('warning')} />
      </motion.div>
      {landed && !reduced && <GroundSmash />}
      <button className="boss-skip" data-glove-hold-b2 onClick={() => setStage('warning')}>Skip arrival <kbd className="glove-key">Hold B2</kbd></button>
    </>}
    {stage === 'warning' && <>
      <div className="boss-waiting"><ScornFlames reduced={!!reduced} /><img style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'contain' }} src={knight.sprite} alt="The huge ruined knight bars the gate with his corrupted axe" /></div>
      <VisualNovelDialogue key="warning" muted={muted} onComplete={() => setStage('gather')} lines={[
        { speaker: 'The Ruined Gatekeeper', color: '#bd91e8', voicePitch: .6, text: '**No one enters.**' },
        { speaker: 'The Scorn', color: '#bd91e8', text: 'Rust groans. The axe drinks the moonlight. His armor will endure—but even this guardian must rest. Your health, stance, and Magic Power are restored. Prepare yourself.' },
      ]} />
    </>}
    {stage === 'gather' && <>
      <div className="boss-waiting"><ScornFlames reduced={!!reduced} /><img style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'contain' }} src={knight.sprite} alt="The ruined knight waits at the gate" /></div>
      <CoopGather onPaired={beginCoopBattle} onAlone={beginBattle} />
    </>}
    {stage === 'ending' && <section className="encounter-victory" aria-labelledby="demo-end-title">
      <p>Demo complete</p><h2 id="demo-end-title">Beyond the ruined gate</h2><span>The axe falls silent. For the first time, the kingdom lets you pass.</span>
      <button data-glove-b1="Title" onClick={() => window.location.reload()}>Return to title <kbd className="glove-key">B1</kbd></button>
    </section>}
    {!escape && stage !== 'castle' && <BossAtmosphere />}
    </motion.div>
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
