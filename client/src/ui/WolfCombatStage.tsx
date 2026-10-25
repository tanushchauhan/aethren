import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { combatants, isRoused, moves } from '../combat/encounter';
import { useSpellBattle } from '../combat/spellBattle';
import { playerStore, usePlayerState } from '../combat/playerState';
import { lowHealthIntensity } from '../combat/statusEffects';
import { StatusEffectIcon } from './components/StatusEffects';
import { SPELL_TIMING } from '../combat/spellVfx';
import { WolfMoveAnimation } from './components/WolfMoveAnimation';
import { SpellEffect } from './components/SpellEffect';
import { PlayerStatusPanel } from './components/PlayerStatusPanel';
import { RainOverlay } from './components/RainOverlay';
import './wolf-combat-stage.css';
import { useBattleMusic } from './useBattleMusic';

export function WolfCombatStage({ muted, onToggleSound, onContinue }: { muted: boolean; onToggleSound: () => void; onContinue: () => void }) {
  const { opponents, pending, feedback, activeId, turnNumber, enemyTurn, status } = useSpellBattle();
  const hurt = usePlayerState(state => state.hurt);
  const lowHealth = usePlayerState(state => lowHealthIntensity(state.health, state.maxHealth));
  const bleeding = usePlayerState(state => state.statuses.some(effect => effect.id === 'bleeding'));
  const enemyMove = enemyTurn?.action;
  const [leaving, setLeaving] = useState(false);
  const victoryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (status === 'won') victoryButton.current?.focus(); }, [status]);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!pending) return;
    const id = pending.id;
    const impact = window.setTimeout(() => useSpellBattle.getState().resolveCast(id), reduced ? SPELL_TIMING.reducedImpactMs : SPELL_TIMING.impactMs);
    const finish = window.setTimeout(() => useSpellBattle.getState().finishCast(id), reduced ? SPELL_TIMING.reducedFinishMs : SPELL_TIMING.finishMs);
    return () => { clearTimeout(impact); clearTimeout(finish); };
  }, [pending?.id, reduced]);
  useEffect(() => () => useSpellBattle.getState().cancelCast(), []);
  useBattleMusic(muted);
  useEffect(() => {
    if (!enemyTurn || status !== 'active') return;
    if (!enemyMove) {
      const timer = window.setTimeout(() => useSpellBattle.getState().beginEnemy(), reduced ? 400 : 1100);
      return () => clearTimeout(timer);
    }
    if (enemyMove.phase !== 'playing') {
      const type = enemyMove.phase === 'approaching' ? 'play' : 'finish';
      const timer = window.setTimeout(() => useSpellBattle.getState().enemyStep(type, enemyMove.id), reduced ? 150 : 650);
      return () => clearTimeout(timer);
    }
  }, [activeId, enemyMove?.id, enemyMove?.phase, reduced, status]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <motion.main className="wolf-combat-stage" aria-label="Wolf combat stage"
    initial={{ opacity: 0 }} animate={{ opacity: leaving ? 0 : 1 }} transition={{ duration: reduced ? .15 : leaving ? .65 : 1.1 }}
    onAnimationComplete={() => { if (leaving) onContinue(); }}>
    <img className="wolf-combat-backdrop" src="/art/combat/wolf-clearing.png" alt="A moonlit forest clearing surrounded by wet bushes" />
    {turnNumber === 1 && status === 'active' && <motion.header className="wolf-combat-heading" initial={{ opacity: 1 }} animate={{ opacity: 0 }}
      transition={{ delay: 4.5, duration: reduced ? .15 : 1.5 }}>
      <p>Encounter I</p><h1 ref={heading} tabIndex={-1}>The wolves of the vale</h1>
    </motion.header>}
    {status === 'active' && <motion.header key={turnNumber} className="wolf-combat-heading turn-announcement" role="status"
      initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0] }}
      transition={{ delay: turnNumber === 1 ? 6.2 : 0, duration: reduced ? 1.4 : 2.5, times: [0, .12, .75, 1] }}>
      <p>Turn {turnNumber}</p><h2>{activeId === 'player' ? 'Your turn' : `${combatants.find(actor => actor.id === activeId)?.name}’s turn`}</h2>
    </motion.header>}
    <div className="wolf-formation" role="group" aria-label="Three wolf combatants">
      {combatants.filter(actor => actor.side === 'enemy').map((wolf, i) => {
        const stats = opponents[wolf.id];
        const reaction = feedback?.targetId === wolf.id ? feedback : null;
        const acting = enemyMove?.actorId === wolf.id;
        const forward = acting && enemyMove.moveId !== 'rest' && enemyMove.phase !== 'returning';
        return <motion.div key={wolf.id} id={`opponent-${wolf.id}`} className="wolf-slot" style={{ zIndex: acting ? 3 : 1 }} aria-hidden={stats.defeated || undefined}
          initial={reduced ? false : { opacity: 0 }} animate={{ opacity: stats.defeated ? 0 : 1 }}
          transition={{ delay: stats.defeated || reduced ? 0 : 2.5 + i * .3, duration: reduced ? 0 : stats.defeated ? .6 : 2.8 }}>
          <motion.div key={reaction?.id ?? 0} initial={false}
            animate={{ x: forward && !reduced ? `${(1 - i) * 113.043}%` : !reduced && reaction ? reaction.kind === 'dodge' ? [0, i === 2 ? 45 : -45, 0] : [0, -7, 7, -4, 0] : 0, y: forward && !reduced ? 40 : 0, scale: !reduced && forward ? 1.15 : 1 }}
            transition={{ duration: reduced ? .1 : enemyMove ? .55 : reaction?.kind === 'dodge' ? .55 : .3 }} className={`wolf-combatant ${wolf.kind}${activeId === wolf.id ? ' is-active' : ''}${isRoused(stats) ? ' is-roused' : ''}`}>
            <div className="wolf-bars">
              {[{ id: 'health', value: stats.hp, max: wolf.maxHp }, { id: 'energy', value: stats.energy, max: wolf.maxEnergy }].map(stat =>
                <div className={`wolf-stat-bar ${stat.id}`} key={stat.id}>
                  <div className="wolf-stat-track" role="progressbar" aria-label={`${wolf.name} ${stat.id}`}
                    aria-valuemin={0} aria-valuemax={stat.max} aria-valuenow={stat.value}>
                    <span className="wolf-stat-fill" style={{ width: `${stat.value / stat.max * 100}%` }} />
                    <span className="wolf-stat-markers" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ left: `${(index + 1) * 10}%` }} />)}</span>
                  </div>
                  <img className="wolf-stat-icon" src={`/art/resources/${stat.id}.png`} alt="" />
                </div>)}
              <div className="wolf-status-icons">{stats.statuses.map(effect => <StatusEffectIcon key={effect.id} effect={effect} />)}</div>
            </div>
            <div className="wolf-turn-ring" aria-hidden="true" />
            {acting && enemyMove.phase === 'playing' ? <WolfMoveAnimation key={enemyMove.id} move={moves[enemyMove.moveId]} sprite={wolf.sprite} muted={muted} reduced={!!reduced}
              onImpact={() => useSpellBattle.getState().enemyStep('impact', enemyMove.id)} onComplete={() => useSpellBattle.getState().enemyStep('return', enemyMove.id)} /> : <img className={`wolf-sprite${reaction?.kind === 'hurt' ? ' wolf-hurt' : ''}`} src={wolf.sprite} alt={wolf.name} draggable={false} />}
            {acting && <div className={`wolf-move-label${enemyMove.moveId === 'rest' ? ' is-resting' : ''}`} role="status">
              {moves[enemyMove.moveId].name}
              {enemyMove.moveId === 'rest' && enemyMove.resolved && <small>+5 Energy</small>}
            </div>}
            {reaction && <motion.span className={`wolf-hit-feedback ${reaction.kind}`} initial={{ opacity: 1, y: 0 }} animate={{ opacity: 0, y: reduced ? 0 : -24 }} transition={{ duration: 1.4 }}>
              {reaction.kind === 'dodge' ? 'Dodged' : `−${reaction.damage}`}
            </motion.span>}
          </motion.div>
        </motion.div>;
      })}
    </div>
    <RainOverlay />
    {(lowHealth > 0 || bleeding) && <div className="low-health-overlay" aria-hidden="true" style={{
      backdropFilter: `grayscale(${lowHealth})`, WebkitBackdropFilter: `grayscale(${lowHealth})`,
      boxShadow: `inset 0 0 ${35 + lowHealth * 100}px ${8 + lowHealth * 36}px rgba(125, 5, 30, ${Math.min(.85, lowHealth * .75 + (bleeding ? .12 : 0))})`,
    }}>
      {bleeding && <div className="bleeding-edges" style={{ opacity: .15 + lowHealth * .65 }}><i /><i /><i /><i /></div>}
    </div>}
    {hurt && <motion.div key={hurt.id} className={`player-hurt-overlay ${hurt.kind}`} aria-hidden="true"
      initial={{ opacity: reduced ? .35 : 1 }} animate={{ opacity: 0 }} transition={{ duration: .85 }}>
      {!reduced && hurt.kind === 'slash' && <div className="player-slash-marks"><i /><i /><i /></div>}
      <span>−{hurt.damage}{hurt.kind === 'bleed' ? ' · Bleeding' : ''}</span>
    </motion.div>}
    {status === 'lost' && <section className="encounter-victory" role="alert">
      <p>Encounter lost</p><h2>The vale claims another</h2><span>Your health has fallen to zero.</span>
      <button autoFocus onClick={() => { playerStore.getState().reset(); useSpellBattle.getState().reset(); }}>Try again</button>
    </section>}
    {pending && <SpellEffect key={pending.id} cast={pending} reduced={!!reduced} />}
    <aside className="combat-queue" aria-label="Turn order">
      <ol>
        {(enemyTurn?.queue ?? ['player', ...combatants.filter(actor => actor.side === 'enemy' && !opponents[actor.id].defeated).map(actor => actor.id)]).map(id => combatants.find(actor => actor.id === id)!).map((actor, index) => <li key={actor.id}
          className={actor.id === activeId ? 'is-current' : ''} aria-current={index === 0 ? 'step' : undefined}
          aria-label={`${actor.name}, ${index === 0 ? 'ready' : `position ${index + 1}`}`} title={actor.name}>
          <span className={`queue-portrait ${actor.side} ${actor.kind}`}><img src={actor.sprite} alt="" /></span>
        </li>)}
      </ol>
    </aside>
    {status === 'active' && <PlayerStatusPanel />}
    {status === 'won' && <motion.section className="encounter-victory" aria-labelledby="victory-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? .1 : .8 }}>
      <p>Encounter won</p><h2 id="victory-title">The vale falls silent</h2>
      <span>The path beyond the clearing is open.</span>
      <button ref={victoryButton} disabled={leaving} onClick={() => setLeaving(true)}>Continue <span aria-hidden="true">➜</span></button>
    </motion.section>}
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
