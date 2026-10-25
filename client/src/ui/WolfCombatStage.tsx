import { CombatCamera } from './components/CombatCamera';
import { useDefense } from '../combat/defense';
import { useEffect, useRef, useState } from 'react';
import { motion, useAnimate, useReducedMotion } from 'motion/react';
import { combatants, isRoused, moves, previewIntent } from '../combat/encounter';
import { useSpellBattle } from '../combat/spellBattle';
import { isHero, playerStore, resetHeroes, useLocalHero, usePlayerState, type HeroId } from '../combat/playerState';
import { CoopPartnerCard } from './components/CoopGather';
import { useCoop } from '../net/coopLink';
import { lowHealthIntensity } from '../combat/statusEffects';
import { StatusEffectIcon } from './components/StatusEffects';
import { playCastSound, playImpactSound } from '../combat/spellSound';
import { buildSpellVfx, HAND, HIT_TIMING, PARTNER_HAND, spellTiming } from '../combat/spellVfx';
import { SPELLS } from '../combat/spells';
import { PlayerWards, WolfStatusAura } from './components/StatusAuras';
import { WolfMoveAnimation } from './components/WolfMoveAnimation';
import { SpellEffect } from './components/SpellEffect';
import { PlayerStatusPanel } from './components/PlayerStatusPanel';
import { ScornFlames } from './components/ScornFlames';
import { useFieldFlamesSound } from './useFieldFlamesSound';
import { BossAtmosphere } from './components/BossAtmosphere';
import { CombatTutorialOverlay } from './components/CombatTutorialOverlay';
import { useWolfTutorial } from '../combat/wolfTutorial';
import { GloveCombatControl, useWheelSelection } from '../glove/GloveCombatControl';
import { RainOverlay } from './components/RainOverlay';
import './wolf-combat-stage.css';
import { useBattleMusic } from './useBattleMusic';
import { ENEMY_INTRO_FADE_DELAY_S, ENEMY_INTRO_FADE_DURATION_S, ENEMY_INTRO_FADE_STAGGER_S, castUiRevealDelayMs } from './combatIntro';

/** Turn-order portraits for the heroes, who are not in the roster the way the opponents are. */
const HERO_SPRITES: Record<HeroId, string> = { player: '/art/spellbearer-male.png', ally: '/art/spellbearer-female.png' };

export function WolfCombatStage({ muted, onToggleSound, onContinue, onFightAlone }: { muted: boolean; onToggleSound: () => void; onContinue: () => void; onFightAlone?: () => void }) {
  const me = useLocalHero();
  const coop = useSpellBattle(state => state.coop);
  const allyAway = useSpellBattle(state => state.allyAway);
  const heroNames = useSpellBattle(state => state.heroNames);
  const coopLink = useCoop();
  const partner: HeroId = me === 'player' ? 'ally' : 'player';
  const partnerHealth = usePlayerState(state => state.health, partner);
  const partnerMaxHealth = usePlayerState(state => state.maxHealth, partner);
  const partnerMagic = usePlayerState(state => state.magicPower, partner);
  const partnerMaxMagic = usePlayerState(state => state.maxMagicPower, partner);
  const guest = coop && coopLink.role === 'guest';
  const { opponents, pending, feedback, activeId, turnNumber, enemyTurn, status, encounterId, fieldTurns, message } = useSpellBattle();
  useFieldFlamesSound(fieldTurns > 0 && status === 'active', muted);
  const boss = encounterId === 'knight';
  const targetedId = useWheelSelection(state => state.targetId);
  // The battle only reports a dodge or parry through its message, so catch it there and flash a banner.
  const [defended, setDefended] = useState<{ id: number; kind: 'dodged' | 'parried' } | null>(null);
  const defendedCount = useRef(0);
  useEffect(() => {
    const kind = message.startsWith('Dodged!') ? 'dodged' : message.startsWith('Parried with') ? 'parried' : null;
    if (kind) setDefended({ id: ++defendedCount.current, kind });
  }, [message]);
  const hurt = usePlayerState(state => state.hurt);
  const lowHealth = usePlayerState(state => lowHealthIntensity(state.health, state.maxHealth));
  const bleeding = usePlayerState(state => state.statuses.some(effect => effect.id === 'bleeding'));
  const enemyMove = enemyTurn?.action;
  const [leaving, setLeaving] = useState(false);
  const victoryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (status === 'won') victoryButton.current?.focus(); }, [status]);
  const reduced = useReducedMotion();
  const [world, animateWorld] = useAnimate<HTMLDivElement>();
  useEffect(() => {
    if (!pending) return;
    const id = pending.id;
    const timing = spellTiming(pending.spell, !!reduced);
    if (!muted && !reduced) playCastSound(pending.spell, timing.chargeMs / 1000, timing.travelMs / 1000);
    const impact = window.setTimeout(() => useSpellBattle.getState().resolveCast(id), timing.impactMs);
    const finish = window.setTimeout(() => useSpellBattle.getState().finishCast(id), timing.finishMs);
    return () => { clearTimeout(impact); clearTimeout(finish); };
  }, [pending?.id, reduced]);
  const castHits = pending ? feedback.filter(entry => entry.castId === pending.id) : [];
  useEffect(() => {
    if (!pending?.resolved) return;
    const landed = pending.spell.target === 'self' || castHits.some(entry => entry.kind !== 'dodge');
    if (!muted) playImpactSound(pending.spell, landed);
    if (reduced || !castHits.some(entry => entry.kind === 'hurt')) return;
    const a = buildSpellVfx(pending.spell).shake;
    void animateWorld(world.current, { x: [0, -a, a * .8, -a * .5, a * .25, 0], y: [0, a * .6, -a * .5, a * .3, -a * .1, 0] }, { duration: .42, ease: 'easeOut' });
  }, [pending?.id, pending?.resolved]);
  // Start-of-turn burns land with a softer thump of their own.
  const tick = feedback.find(entry => entry.castId === null && entry.kind === 'hurt');
  useEffect(() => { if (tick && !muted) playImpactSound(SPELLS['ember-bolt'], true); }, [tick?.id]);
  useEffect(() => () => useSpellBattle.getState().cancelCast(), []);
  useBattleMusic(muted, boss ? '/audio/the-final-lurch.mp3' : '/audio/final-surge.mp3');
  useEffect(() => {
    if (!enemyTurn || status !== 'active') return;
    if (!enemyMove) {
      const timer = window.setTimeout(() => useSpellBattle.getState().beginEnemy(), reduced ? 400 : 650);
      return () => clearTimeout(timer);
    }
    if (enemyMove.phase !== 'playing') {
      const type = enemyMove.phase === 'approaching' ? 'play' : 'finish';
      const timer = window.setTimeout(() => useSpellBattle.getState().enemyStep(type, enemyMove.id), enemyMove.phase === 'approaching' && useDefense.getState().enabled && useDefense.getState().cue ? useDefense.getState().windupMs : reduced ? 150 : 350);
      return () => clearTimeout(timer);
    }
  }, [activeId, enemyMove?.id, enemyMove?.phase, reduced, status]);
  // In co-op the engine's single `player` slot stands for both heroes, whoever acts first leading.
  const turnOrder = (queue: string[]) => queue.flatMap(id => id !== 'player' || !coop ? [id] : activeId === 'ally' ? ['ally'] : ['player', 'ally'])
    .concat(coop && activeId === 'ally' ? ['player'] : [])
    .map(id => isHero(id) ? { id, name: coop ? heroNames[id] : 'You', side: 'player', kind: 'player', sprite: HERO_SPRITES[id] } : combatants.find(actor => actor.id === id)!);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (status !== 'active' || activeId !== 'player' || pending) return;
    const enemies = combatants.filter(actor => actor.side === 'enemy' && opponents[actor.id]).length;
    const delay = castUiRevealDelayMs(enemies, !!reduced, turnNumber === 1);
    const timer = window.setTimeout(() => useWolfTutorial.getState().startTurnTutorial(encounterId, turnNumber), delay);
    return () => clearTimeout(timer);
  }, [status, activeId, pending, encounterId, turnNumber, reduced, opponents]);
  const defenseMatching = useDefense(s => s.matching);
  useEffect(() => {
    if (defenseMatching === 'dodged' || defenseMatching === 'blocked') {
      useWolfTutorial.getState().notifyAction('parry');
    }
  }, [defenseMatching]);
  return <motion.main className={`wolf-combat-stage${boss ? ' boss-combat-stage' : ''}`} aria-label={boss ? 'Gatekeeper combat stage' : 'Wolf combat stage'}
    initial={{ opacity: 0 }} animate={{ opacity: leaving ? 0 : 1 }} transition={{ duration: reduced ? .15 : leaving ? .65 : 1.1 }}
    onAnimationComplete={() => { if (leaving) onContinue(); }}>
    <div ref={world} className="combat-world">
    <img className="wolf-combat-backdrop" src={boss ? '/art/boss/castle-gate.png' : '/art/combat/wolf-clearing.png'} alt={boss ? 'The deserted kingdom gate' : 'A moonlit forest clearing surrounded by wet bushes'} />
    {turnNumber === 1 && status === 'active' && <motion.header className="wolf-combat-heading" initial={{ opacity: 1 }} animate={{ opacity: 0 }}
      transition={{ delay: 4.5, duration: reduced ? .15 : 1.5 }}>
      <p>{boss ? 'Final encounter' : 'Encounter I'}</p><h1 ref={heading} tabIndex={-1}>{boss ? 'The Ruined Gatekeeper' : 'The wolves of the vale'}</h1>
    </motion.header>}
    {status === 'active' && <motion.header key={turnNumber} className="wolf-combat-heading turn-announcement" role="status"
      initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0] }}
      transition={{ delay: turnNumber === 1 ? 6.2 : 0, duration: reduced ? 1.4 : 2.5, times: [0, .12, .75, 1] }}>
      <p>Turn {turnNumber}</p><h2>{activeId === me ? 'Your turn' : isHero(activeId) ? `${heroNames[activeId]}’s turn` : `${combatants.find(actor => actor.id === activeId)?.name}’s turn`}</h2>
    </motion.header>}
    <div className="wolf-formation" role="group" aria-label={boss ? 'The Ruined Gatekeeper' : 'Three wolf combatants'}>
      {combatants.filter(actor => actor.side === 'enemy' && opponents[actor.id]).map((wolf, i) => {
        const stats = opponents[wolf.id];
        const reaction = feedback.find(entry => entry.targetId === wolf.id) ?? null;
        const acting = enemyMove?.actorId === wolf.id;
        const forward = acting && enemyMove.moveId !== 'rest' && enemyMove.phase !== 'returning';
        const struck = !reduced && !forward && reaction?.kind === 'hurt';
        // Hit-stop: hold still for the flash frame, then get knocked back away from the caster.
        const knock = i === 0 ? -1 : 1, stop = HIT_TIMING.hitStop / HIT_TIMING.react;
        return <motion.div key={wolf.id} id={`opponent-${wolf.id}`} className="wolf-slot" style={{ zIndex: acting ? 3 : 1 }} aria-hidden={stats.defeated || undefined}
          initial={reduced ? false : { opacity: 0 }} animate={{ opacity: stats.defeated ? 0 : 1 }}
          transition={{ delay: reduced ? 0 : stats.defeated ? HIT_TIMING.react * .8 : ENEMY_INTRO_FADE_DELAY_S + i * ENEMY_INTRO_FADE_STAGGER_S, duration: reduced ? 0 : stats.defeated ? .6 : ENEMY_INTRO_FADE_DURATION_S }}>
          <motion.div key={reaction?.id ?? 0} initial={false}
            animate={struck ? { x: [0, 0, 20 * knock, -7 * knock, 2 * knock, 0], y: [0, 0, -16, 5, 0, 0], scale: [1, 1.07, .9, 1.03, 1, 1] }
              : { x: forward && !reduced ? `${boss ? 0 : (1 - i) * 113.043}%` : !reduced && reaction ? [0, i === 2 ? 45 : -45, 0] : 0, y: forward && !reduced ? 40 : 0, scale: !reduced && forward ? 1.15 : 1 }}
            transition={struck ? { duration: HIT_TIMING.react, times: [0, stop, stop + .18, stop + .42, stop + .64, 1], ease: 'easeOut' }
              : { duration: reduced ? .1 : .28 }} className={`wolf-combatant ${wolf.kind}${activeId === wolf.id ? ' is-active' : ''}${isRoused(stats) ? ' is-roused' : ''}`}>
            {boss && !stats.defeated && <ScornFlames reduced={!!reduced} />}
            <div className="wolf-bars">
              {[{ id: 'health', value: stats.hp, max: stats.maxHp ?? wolf.maxHp }, { id: 'energy', value: stats.energy, max: wolf.maxEnergy }].map(stat =>
                <div className={`wolf-stat-bar ${stat.id}`} key={stat.id}>
                  <div className="wolf-stat-track" role="progressbar" aria-label={`${wolf.name} ${stat.id}`}
                    aria-valuemin={0} aria-valuemax={stat.max} aria-valuenow={stat.value}>
                    <span className="wolf-stat-fill" style={{ width: `${stat.value / stat.max * 100}%` }} />
                    <span className="wolf-stat-markers" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ left: `${(index + 1) * 10}%` }} />)}</span>
                  </div>
                  <img className="wolf-stat-icon" src={`/art/resources/${stat.id}.png`} alt="" />
                </div>)}
              <div className="wolf-status-icons">{stats.statuses.map(effect => <StatusEffectIcon key={effect.id} effect={effect} />)}</div>
              {activeId === me && !stats.defeated && (() => {
                const intent = previewIntent(wolf.id, stats);
                return intent ? <div className={`wolf-intent-tag ${intent.moveId}`} title={intent.counterTip}>
                  <span>Next: <b>{intent.moveName}</b></span>
                  {targetedId === wolf.id && <small>{intent.counterTip}</small>}
                </div> : null;
              })()}
            </div>
            <div className="wolf-turn-ring" aria-hidden="true" />
            {targetedId === wolf.id && !stats.defeated && status === 'active' && <span className="wolf-target-badge" role="status">◆ Targeted · T switch</span>}
            {acting && enemyMove.phase === 'playing' ? <WolfMoveAnimation key={enemyMove.id} move={moves[enemyMove.moveId]} sprite={wolf.sprite} muted={muted} reduced={!!reduced}
              onProgress={progress => useDefense.getState().setProgress(enemyMove.id, progress)}
              onImpact={() => useSpellBattle.getState().enemyStep('impact', enemyMove.id)} onComplete={() => useSpellBattle.getState().enemyStep('return', enemyMove.id)} /> : <img className={`wolf-sprite${reaction?.kind === 'hurt' ? ' wolf-hurt' : ''}`} src={wolf.sprite} alt={wolf.name} draggable={false} />}
            <WolfStatusAura statuses={stats.statuses} reduced={!!reduced} />
            {acting && <div className={`wolf-move-label${enemyMove.moveId === 'rest' ? ' is-resting' : ''}`} role="status">
              {moves[enemyMove.moveId].name}
              {enemyMove.moveId === 'rest' && enemyMove.resolved && <small>+5 Energy</small>}
            </div>}
            {reaction && <motion.span className={`wolf-hit-feedback ${reaction.kind}${reaction.damage >= 14 ? ' is-heavy' : ''}`} initial={{ x: '-50%', opacity: 0, scale: reduced ? 1 : .3 }}
              animate={reduced ? { opacity: [1, 1, 0] } : { opacity: [0, 1, 1, 0], scale: [.3, 1.6, 1, .95], y: [0, -14, -30, -52] }}
              transition={reduced ? { duration: 1.4 } : { duration: 1.3, times: [0, .1, .25, 1], ease: 'easeOut' }}>
              {reaction.kind === 'dodge' ? 'Dodged' : reaction.kind === 'effect' ? reaction.label : `−${reaction.damage}`}
              {reaction.kind === 'hurt' && reaction.label && <small>{reaction.label}</small>}
            </motion.span>}
          </motion.div>
        </motion.div>;
      })}
    </div>
    <RainOverlay />
    {pending && <SpellEffect key={pending.id} cast={pending} hits={castHits} reduced={!!reduced} own={pending.casterId === me} hand={pending.casterId === me ? HAND : PARTNER_HAND} />}
    <PlayerWards reduced={!!reduced} />
    {boss && <BossAtmosphere />}
    {boss && enemyMove?.moveId === 'scorn-inferno' && <div className="scorn-ultimate-charge" aria-hidden="true" />}
    {fieldTurns > 0 && status === 'active' && <ScornFlames field reduced={!!reduced} />}
    </div>
    {(lowHealth > 0 || bleeding) && <div className="low-health-overlay" aria-hidden="true" style={{
      backdropFilter: `grayscale(${lowHealth})`, WebkitBackdropFilter: `grayscale(${lowHealth})`,
      boxShadow: `inset 0 0 ${35 + lowHealth * 100}px ${8 + lowHealth * 36}px rgba(125, 5, 30, ${Math.min(.85, lowHealth * .75 + (bleeding ? .12 : 0))})`,
    }}>
      {bleeding && <div className="bleeding-edges" style={{ opacity: .15 + lowHealth * .65 }}><i /><i /><i /><i /></div>}
    </div>}
    {hurt && <motion.div key={hurt.id} className={`player-hurt-overlay ${hurt.kind}`} aria-hidden="true"
      initial={{ opacity: reduced ? .35 : 1 }} animate={{ opacity: 0 }} transition={{ duration: .85 }}>
      {!reduced && hurt.impact === 'axe' && <div className="player-axe-gash"><i className="gash-glow" /><i className="gash-wound" /><i className="gash-edge" /><i className="gash-splinter" /></div>}
      {!reduced && hurt.kind === 'slash' && <div className="player-slash-marks"><i /><i /><i /></div>}
      <span>{hurt.guarded ? `Blocked · −${hurt.damage}` : hurt.kind === 'blocked' ? `Shield blocked ${hurt.absorbed}` : `−${hurt.damage}${hurt.kind === 'bleed' ? ' · Bleeding' : hurt.kind === 'curse' ? ' · Scorn' : ''}${hurt.absorbed ? ` · ${hurt.absorbed} blocked` : ''}`}</span>
    </motion.div>}
    {defended && <motion.div key={defended.id} className={`defense-result ${defended.kind}`} role="status"
      initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0], ...(reduced ? {} : { scale: [.6, 1.2, 1, 1], y: [10, 0, -6, -22] }) }}
      transition={{ duration: reduced ? .9 : 1.5, times: [0, .12, .7, 1], ease: 'easeOut' }}
      onAnimationComplete={() => setDefended(current => current?.id === defended.id ? null : current)}>
      {defended.kind === 'dodged' ? 'DODGED!' : 'PARRIED!'}
    </motion.div>}
    {status === 'lost' && <section className="encounter-victory" role="alert">
      <p>Encounter lost</p><h2>{boss ? 'The gate remains sealed' : 'The vale claims another'}</h2><span>{coop ? 'Both heroes have fallen.' : 'Your health has fallen to zero.'}</span>
      {guest ? <span>Waiting for {heroNames.player} to try again…</span>
        : <button autoFocus data-glove-b1="Retry" onClick={() => { if (coop) resetHeroes(); else playerStore.getState().reset(); useSpellBattle.getState().reset(); }}>Try again · B1</button>}
    </section>}
    {fieldTurns > 0 && status === 'active' && <div className="scorn-field-label" role="status">Scorn Inferno · {fieldTurns} turns</div>}
    <aside className="combat-queue" aria-label="Turn order">
      <ol>
        {turnOrder(enemyTurn?.queue ?? ['player', ...combatants.filter(actor => actor.side === 'enemy' && opponents[actor.id] && !opponents[actor.id].defeated).map(actor => actor.id)]).map((actor, index) => <li key={actor.id}
          className={actor.id === activeId ? 'is-current' : ''} aria-current={index === 0 ? 'step' : undefined}
          aria-label={`${actor.name}, ${index === 0 ? 'ready' : `position ${index + 1}`}`} title={actor.name}>
          <span className={`queue-portrait ${actor.side} ${actor.kind}`}><img src={actor.sprite} alt="" /></span>
        </li>)}
      </ol>
    </aside>
    {status === 'active' && <PlayerStatusPanel />}
    {coop && status === 'active' && <CoopPartnerCard name={heroNames[partner]} health={partnerHealth} maxHealth={partnerMaxHealth} magic={partnerMagic} maxMagic={partnerMaxMagic}
      active={activeId === partner} away={partner === 'ally' ? allyAway : coopLink.status === 'partner-left'} />}
    {guest && coopLink.status === 'partner-left' && status === 'active' && <section className="encounter-victory" role="alert">
      <p>Co-op</p><h2>{heroNames.player} disconnected</h2><span>Their screen was running this fight, so it cannot go on without them.</span>
      <button autoFocus data-glove-b1="Alone" onClick={onFightAlone}>Fight alone · B1</button>
    </section>}
    <GloveCombatControl />
    {status === 'active' && <CombatCamera />}
    {status === 'active' && !boss && <CombatTutorialOverlay />}
    {status === 'won' && <motion.section className="encounter-victory" aria-labelledby="victory-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? .1 : .8 }}>
      <p>Encounter won</p><h2 id="victory-title">{boss ? 'The Scorn is broken' : 'The vale falls silent'}</h2>
      <span>{boss ? 'The kingdom awaits beyond the gate.' : 'The path beyond the clearing is open.'}</span>
      <button ref={victoryButton} data-glove-b1="Continue" disabled={leaving} onClick={() => setLeaving(true)}>Continue · B1 <span aria-hidden="true">➜</span></button>
    </motion.section>}
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
