import type { ReactElement } from 'react';
import type { RoomPhase } from '../net/contract';
import { useGameStore } from '../net/store';
import { BattleStage } from './BattleStage';
import styles from './combat.module.css';
import { NarratorDock } from './NarratorDock';
import { PushToTalk } from './PushToTalk';
import { SpellWheel } from './SpellWheel';
import { TelegraphOverlay } from './TelegraphOverlay';
import { TooLoudBanner } from './TooLoudBanner';

const COMBAT_PHASES = new Set<RoomPhase>(['calibrating', 'encounter', 'boss']);

function Silhouette() {
  return (
    <svg className={styles.silhouette} viewBox="0 0 160 280" aria-hidden="true">
      <circle cx="80" cy="36" r="22" />
      <path d="M80 60v78" />
      <path d="M80 84 36 128" />
      <path d="M80 84l44 44" />
      <path d="M80 138 50 236" />
      <path d="M80 138l30 98" />
    </svg>
  );
}

export function CombatLayer(): ReactElement | null {
  const phase = useGameStore((state) => state.gameState?.phase ?? null);
  if (phase === null || !COMBAT_PHASES.has(phase)) return null;

  return (
    <div className={styles.root}>
      <BattleStage />
      <div className={styles.vision} data-slot="vision-canvas">
        {phase === 'calibrating' ? (
          <div className={`${styles.calibration} ${styles.standIn}`}>
            <Silhouette />
            <p className={styles.calibText}>Stand in the outline for 3 seconds</p>
          </div>
        ) : null}
      </div>
      <aside className={styles.rail}>
        <SpellWheel />
        <PushToTalk />
      </aside>
      <TelegraphOverlay />
      <NarratorDock />
      <TooLoudBanner />
    </div>
  );
}
