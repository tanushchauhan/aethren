import { useEffect, useRef, useReducer } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { combatants, createEncounter, encounterReducer, definition, moves, isRoused } from '../combat/encounter';
import { WolfMoveAnimation } from './components/WolfMoveAnimation';
import { RainOverlay } from './components/RainOverlay';
import './wolf-combat-stage.css';
import { useBattleMusic } from './useBattleMusic';

export function WolfCombatStage({ muted, onToggleSound }: { muted: boolean; onToggleSound: () => void }) {
  const [encounter, dispatch] = useReducer(encounterReducer, undefined, createEncounter);
  const active = definition(encounter.queue[0]);
  const pending = encounter.action;
  const reduced = useReducedMotion();
  useBattleMusic(muted);
  useEffect(() => {
    if (!pending && active?.side === 'enemy') {
      const timer = window.setTimeout(() => dispatch({ type: 'begin', actorId: active.id, turn: encounter.serial }), 450);
      return () => clearTimeout(timer);
    }
    if (pending && pending.phase !== 'playing') {
      const type = pending.phase === 'approaching' ? 'play' : 'finish';
      const timer = window.setTimeout(() => dispatch({ type, actionId: pending.id }), reduced ? 150 : 950);
      return () => clearTimeout(timer);
    }
  }, [active?.id, active?.side, encounter.serial, pending?.id, pending?.phase, reduced]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <motion.main className="wolf-combat-stage" aria-label="Wolf combat stage"
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? .15 : 1.1 }}>
    <img className="wolf-combat-backdrop" src="/art/combat/wolf-clearing.png" alt="A moonlit forest clearing surrounded by wet bushes" />
    <motion.header className="wolf-combat-heading" initial={{ opacity: 1 }} animate={{ opacity: 0 }}
      transition={{ delay: 3, duration: reduced ? 0 : 1.5 }}>
      <p>Encounter I</p><h1 ref={heading} tabIndex={-1}>The wolves of the vale</h1>
    </motion.header>
    <div className="wolf-formation" role="group" aria-label="Three wolf combatants">
      {combatants.filter(actor => actor.side === 'enemy').map((wolf, i) => {
        const stats = encounter.actors[wolf.id];
        const acting = pending?.actorId === wolf.id;
        const forward = acting && pending.phase !== 'returning';
        return <motion.div key={wolf.id} className="wolf-slot" aria-hidden={stats.defeated || undefined}
          style={{ zIndex: acting ? 3 : 1 }}
          initial={reduced ? false : { opacity: 0 }} animate={{ opacity: stats.defeated ? 0 : 1 }}
          transition={{ delay: stats.defeated || reduced ? 0 : .5 + i * .3, duration: reduced ? 0 : stats.defeated ? .6 : 2.8 }}>
          <motion.div className={`wolf-combatant ${wolf.kind}${active?.id === wolf.id ? ' is-active' : ''}${isRoused(stats) ? ' is-roused' : ''}`}
            animate={{ x: forward && !reduced ? `${(1 - i) * 113.043}%` : '0%', y: reduced ? 0 : forward ? 65 : pending && !acting ? -20 : 0,
              scale: reduced ? 1 : forward ? 1.2 : pending && !acting ? .9 : 1, opacity: pending && !acting ? .55 : 1 }}
            transition={{ duration: reduced ? .1 : .85, ease: 'easeInOut' }}>
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
              {stats.statuses.map(status => <span key={status.id} className="wolf-buff" role="img"
                aria-label={`Roused: damage +25%, armor +2, ${status.remaining} turns remaining`}
                title={`Roused: damage +25%, armor +2 · ${status.remaining} turns`}><span aria-hidden="true">↟</span></span>)}
            </div>
            <div className="wolf-turn-ring" aria-hidden="true" />
            {acting && pending.phase === 'playing' ? <WolfMoveAnimation key={pending.id} move={moves[pending.moveId]} sprite={wolf.sprite}
              muted={muted} reduced={!!reduced} onImpact={() => dispatch({ type: 'impact', actionId: pending.id })}
              onComplete={() => dispatch({ type: 'return', actionId: pending.id })} /> : <img className="wolf-sprite" src={wolf.sprite} alt={wolf.name} draggable={false} />}
            {acting && <span className="wolf-move-intent">{moves[pending.moveId].name}</span>}
          </motion.div>
        </motion.div>;
      })}
    </div>
    <RainOverlay />
    <aside className="combat-queue" aria-label="Turn order">
      <ol>
        {encounter.queue.map((id, index) => {
          const actor = combatants.find(candidate => candidate.id === id)!;
          return <li key={id} className={index === 0 ? 'is-current' : ''} aria-current={index === 0 ? 'step' : undefined} aria-label={`${actor.name}, ${index === 0 ? 'current turn' : `position ${index + 1}`}`} title={actor.name}>
            <span className={`queue-portrait ${actor.side} ${actor.kind}`}><img src={actor.sprite} alt="" /></span>
          </li>;
        })}
      </ol>
      <p className="combat-sr-only" role="status" aria-live="polite">{encounter.lastMove} {active?.id === 'player' ? 'Your turn.' : `${active?.name ?? ''}’s turn.`}</p>
      <button className="combat-pass" aria-label="Pass turn" title="Pass turn" disabled={active?.side !== 'player' || !!pending || encounter.queue.length < 2} onClick={() => dispatch({ type: 'pass', turn: encounter.serial })}><span aria-hidden="true">➜</span></button>
    </aside>
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
