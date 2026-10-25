import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { combatants, createEncounter, isRoused } from '../combat/encounter';
import { PlayerStatusPanel } from './components/PlayerStatusPanel';
import { RainOverlay } from './components/RainOverlay';
import './wolf-combat-stage.css';
import { useBattleMusic } from './useBattleMusic';

export function WolfCombatStage({ muted, onToggleSound }: { muted: boolean; onToggleSound: () => void }) {
  // Retain opponent visuals and prepared move infrastructure without running a turn loop.
  const [opponents] = useState(() => Object.fromEntries(
    Object.entries(createEncounter().actors).filter(([id]) => id !== 'player')));
  const reduced = useReducedMotion();
  useBattleMusic(muted);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <motion.main className="wolf-combat-stage" aria-label="Wolf combat stage"
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? .15 : 1.1 }}>
    <img className="wolf-combat-backdrop" src="/art/combat/wolf-clearing.png" alt="A moonlit forest clearing surrounded by wet bushes" />
    <motion.header className="wolf-combat-heading" initial={{ opacity: 1 }} animate={{ opacity: 0 }}
      transition={{ delay: 4.5, duration: reduced ? .15 : 1.5 }}>
      <p>Encounter I</p><h1 ref={heading} tabIndex={-1}>The wolves of the vale</h1>
    </motion.header>
    <div className="wolf-formation" role="group" aria-label="Three wolf combatants">
      {combatants.filter(actor => actor.side === 'enemy').map((wolf, i) => {
        const stats = opponents[wolf.id];
        return <motion.div key={wolf.id} className="wolf-slot" aria-hidden={stats.defeated || undefined}
          initial={reduced ? false : { opacity: 0 }} animate={{ opacity: stats.defeated ? 0 : 1 }}
          transition={{ delay: stats.defeated || reduced ? 0 : 2.5 + i * .3, duration: reduced ? 0 : stats.defeated ? .6 : 2.8 }}>
          <div className={`wolf-combatant ${wolf.kind}${isRoused(stats) ? ' is-roused' : ''}`}>
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
            <img className="wolf-sprite" src={wolf.sprite} alt={wolf.name} draggable={false} />
          </div>
        </motion.div>;
      })}
    </div>
    <RainOverlay />
    <aside className="combat-queue" aria-label="Turn order">
      <ol>
        {combatants.map((actor, index) => <li key={actor.id}
          className={index === 0 ? 'is-current' : ''} aria-current={index === 0 ? 'step' : undefined}
          aria-label={`${actor.name}, ${index === 0 ? 'ready' : `position ${index + 1}`}`} title={actor.name}>
          <span className={`queue-portrait ${actor.side} ${actor.kind}`}><img src={actor.sprite} alt="" /></span>
        </li>)}
      </ol>
    </aside>
    <PlayerStatusPanel />
    <button className="intro-sound" aria-pressed={muted} onClick={onToggleSound}>{muted ? 'Sound off' : 'Sound on'}</button>
  </motion.main>;
}
