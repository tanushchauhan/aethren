import { useLayoutEffect, useRef, type RefObject } from 'react';
import { getServerNow } from '../net/clock';
import { ROUND_TIMINGS, type AttackTypeP0, type PlayerPublic } from '../net/contract';
import { useGameStore } from '../net/store';
import styles from './combat.module.css';

const NO_PLAYERS: readonly PlayerPublic[] = [];

function targetLabel(id: string, players: readonly PlayerPublic[], localId: string | null): string {
  const player = players.find((entry) => entry.id === id);
  const name = player?.name.trim() ?? '';
  const you = localId !== null && id === localId;
  if (you && name) return `${name} · YOU`;
  if (you) return 'YOU';
  if (name) return name;
  return 'A hero';
}

function describeTargets(ids: readonly string[], players: readonly PlayerPublic[], localId: string | null): string {
  if (ids.length === 0) return 'Everyone';
  return ids.map((id) => targetLabel(id, players, localId)).join('  ·  ');
}

function attackCopy(type: AttackTypeP0): { kicker: string; command: string } {
  switch (type) {
    case 'low_sweep':
      return { kicker: 'LOW SWEEP', command: 'STEP OUT' };
    case 'high_swing':
      return { kicker: 'HIGH SWING', command: 'DUCK' };
    case 'projectile':
      return { kicker: 'PROJECTILE', command: 'PARRY or STEP' };
    default: {
      const unexpected: never = type;
      void unexpected;
      return { kicker: 'INCOMING', command: 'MOVE' };
    }
  }
}

function SweepArrow({ direction }: { direction: 'left' | 'right' }) {
  const points = direction === 'left' ? '188,18 28,110 188,202 150,110' : '12,18 172,110 12,202 50,110';
  return (
    <svg
      viewBox="0 0 200 220"
      className={direction === 'left' ? styles.arrowLeft : styles.arrowRight}
      aria-hidden="true"
    >
      <polygon points={points} />
    </svg>
  );
}

export function TelegraphOverlay() {
  const telegraph = useGameStore((state) => state.latestTelegraph);
  const combatPhase = useGameStore((state) => state.gameState?.combatPhase ?? 'idle');
  const players = useGameStore((state) => state.gameState?.players ?? NO_PLAYERS);
  const localPlayerId = useGameStore((state) => state.localPlayerId);
  const rootRef = useRef<HTMLDivElement>(null);
  const secondsRef = useRef<HTMLSpanElement>(null);
  const millisRef = useRef<HTMLSpanElement>(null);

  const visible = telegraph !== null && (combatPhase === 'telegraph' || combatPhase === 'defense');
  const attackId = telegraph?.attackId ?? '';
  const impactServerMs = telegraph?.impactServerMs ?? 0;
  const windowMs = telegraph && telegraph.windowMs > 0 ? telegraph.windowMs : ROUND_TIMINGS.telegraphMs;

  useLayoutEffect(() => {
    if (!visible) return undefined;
    const root = rootRef.current;
    const seconds = secondsRef.current;
    const millis = millisRef.current;
    let frame = 0;
    const tick = () => {
      const remain = Math.max(0, impactServerMs - getServerNow());
      const lead = Math.max(windowMs, 1);
      const progress = Math.min(1, Math.max(0, (lead - remain) / lead));
      if (seconds) seconds.textContent = `${(remain / 1000).toFixed(1)}s`;
      if (millis) millis.textContent = `${Math.ceil(remain)} ms`;
      if (root) {
        root.style.setProperty('--p', progress.toFixed(4));
        root.dataset.hot = progress > 0.84 ? 'true' : 'false';
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible, attackId, impactServerMs, windowMs]);

  if (!telegraph || !visible) return null;
  const copy = attackCopy(telegraph.attackType);
  const names = describeTargets(telegraph.targetPlayerIds, players, localPlayerId);

  return (
    <div
      ref={rootRef}
      className={styles.overlay}
      data-attack={telegraph.attackType}
      data-testid="telegraph-overlay"
    >
      {telegraph.attackType === 'low_sweep' ? (
        <div className={styles.sweep}>
          <SweepArrow direction="left" />
          <Callout kicker={copy.kicker} command={copy.command} names={names} hint={telegraph.narratorHint} secondsRef={secondsRef} millisRef={millisRef} />
          <SweepArrow direction="right" />
        </div>
      ) : null}
      {telegraph.attackType === 'high_swing' ? (
        <div className={styles.duck}>
          <svg className={styles.chevron} viewBox="0 0 220 130" aria-hidden="true">
            <polyline points="16,20 110,112 204,20" fill="none" stroke="currentColor" strokeWidth="26" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points="40,20 110,86 180,20" fill="none" stroke="currentColor" strokeWidth="14" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
          </svg>
          <Callout kicker={copy.kicker} command={copy.command} names={names} hint={telegraph.narratorHint} secondsRef={secondsRef} millisRef={millisRef} />
        </div>
      ) : null}
      {telegraph.attackType === 'projectile' ? (
        <div className={styles.shot}>
          <div className={styles.orbWrap}>
            <div className={styles.orb} />
          </div>
          <Callout kicker={copy.kicker} command={copy.command} names={names} hint={telegraph.narratorHint} secondsRef={secondsRef} millisRef={millisRef} />
        </div>
      ) : null}
    </div>
  );
}

function Callout({
  kicker,
  command,
  names,
  hint,
  secondsRef,
  millisRef,
}: {
  kicker: string;
  command: string;
  names: string;
  hint: string;
  secondsRef: React.RefObject<HTMLSpanElement | null>;
  millisRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className={styles.call}>
      <div role="alert">
        <p className={styles.kicker}>{kicker}</p>
        <strong className={styles.command}>{command}</strong>
        <p className={styles.targets}>{names}</p>
        {hint ? <p className={styles.teleHint}>{hint}</p> : null}
      </div>
      <span ref={secondsRef} className={styles.countdown} aria-hidden="true">
        —
      </span>
      <span ref={millisRef} className={styles.millis} aria-hidden="true">
        — ms
      </span>
    </div>
  );
}
