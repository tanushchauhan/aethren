import { useState, type CSSProperties } from 'react';
import {
  ELEMENT_COLORS,
  MAX_TEAM_HEARTS,
  TWIN_CAST_WINDOW_MS,
  type ElementP0,
  type Encounter,
} from '../net/contract';
import { useGameStore } from '../net/store';
import styles from './combat.module.css';
import { findLocalPlayer } from './localPlayer';
import { ELEMENT_LABEL } from './spellText';

const STEPS = [
  { id: 'telegraph', label: 'TELEGRAPH' },
  { id: 'defense', label: 'DODGE' },
  { id: 'return', label: 'RETURN' },
  { id: 'team_turn', label: 'CAST' },
  { id: 'resolve', label: 'RESOLVE' },
] as const;

function positive(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 64 58" className={filled ? styles.heartOn : styles.heartOff} aria-hidden="true">
      <path d="M32 54 6.5 30.2C1 24.2 1.6 14.6 8.4 10.2 14.2 6.4 21 8.6 25.2 14.2L32 22.4l6.8-8.2C43 8.6 49.8 6.4 55.6 10.2c6.8 4.4 7.4 14 1.9 20L32 54z" />
    </svg>
  );
}

function MonsterArt() {
  return (
    <svg className={styles.art} viewBox="0 0 320 400" aria-hidden="true">
      <rect width="320" height="400" fill="#100c16" />
      <ellipse cx="160" cy="360" rx="120" ry="18" fill="#2a140c" />
      <path d="M40 250c20-70 50-90 90-80 10 30 20 70 10 110" fill="#3a2214" />
      <path d="M280 250c-20-70-50-90-90-80-10 30-20 70-10 110" fill="#3a2214" />
      <ellipse cx="160" cy="250" rx="108" ry="72" fill="#5a2e16" />
      <ellipse cx="230" cy="190" rx="52" ry="42" fill="#6b3416" />
      <path d="M200 150l-20-70 28 40 10-48 22 52 18-36 8 62z" fill="#e85d04" />
      <path d="M250 148l18-54 8 48 20-40 4 58z" fill="#ffb703" />
      <circle cx="214" cy="186" r="8" fill="#ffe08a" />
      <circle cx="246" cy="180" r="8" fill="#ffe08a" />
      <path d="M214 210c16 14 34 12 48-2" fill="none" stroke="#1a0c08" strokeWidth="4" />
      <path d="M70 300l-20 70M120 320l-8 62M200 320l8 62M250 300l18 68" stroke="#2a160e" strokeWidth="14" strokeLinecap="round" />
    </svg>
  );
}

function BossArt() {
  return (
    <svg className={styles.art} viewBox="0 0 320 400" aria-hidden="true">
      <rect width="320" height="400" fill="#070814" />
      <circle cx="160" cy="78" r="46" fill="#1c2438" />
      <path d="M118 70l14-40 12 28 16-36 16 36 12-28 14 40z" fill="#d7ffe8" />
      <path d="M96 150c8-40 28-62 64-62s56 22 64 62l28 190H68z" fill="#142033" />
      <path d="M132 188h56l8 28-36 48-36-48z" fill="#8ee7ff" stroke="#f0d78c" strokeWidth="3" />
      <path d="M160 198v54M142 220h36" stroke="#073044" strokeWidth="2" />
      <circle cx="146" cy="126" r="5" fill="#f0d78c" />
      <circle cx="174" cy="126" r="5" fill="#f0d78c" />
      <path d="M70 340h180" stroke="#f0d78c" strokeWidth="3" opacity="0.7" />
    </svg>
  );
}

function Crystal({ shattered }: { shattered: boolean }) {
  return (
    <svg className={styles.crystal} viewBox="0 0 48 64" aria-hidden="true">
      <polygon points="24,2 44,20 36,62 12,62 4,20" fill={shattered ? '#8d8d8d' : '#9eecff'} stroke="#f0d78c" strokeWidth="2" />
      {shattered ? <path d="M8 18l30 36M40 16L14 60" stroke="#1a120c" strokeWidth="2" /> : null}
    </svg>
  );
}

function FoePortrait({ url, kind }: { url?: string; kind: 'monster' | 'boss' }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return <img className={styles.portrait} src={url} alt="" onError={() => setFailed(true)} />;
  }
  return kind === 'boss' ? <BossArt /> : <MonsterArt />;
}

export function BattleStage() {
  const gameState = useGameStore((state) => state.gameState);
  const localPlayerId = useGameStore((state) => state.localPlayerId);
  const localRole = useGameStore((state) => state.localRole);
  const artUrl = useGameStore((state) => {
    if (state.gameState?.phase === 'boss') return state.gameState.boss?.artUrl ?? state.gameState.encounter?.artUrl;
    return state.gameState?.encounter?.artUrl;
  });
  const [artKey, setArtKey] = useState(artUrl ?? '');
  if ((artUrl ?? '') !== artKey) setArtKey(artUrl ?? '');

  if (!gameState) return null;

  const kind = gameState.phase === 'boss' ? 'boss' : 'monster';
  const foe: Encounter | undefined = gameState.phase === 'boss' ? (gameState.boss ?? gameState.encounter) : gameState.encounter;
  const defaults = kind === 'boss' ? 80 : 40;
  const maxHp = positive(foe?.maxHp, defaults);
  const hp = foe?.hp == null ? maxHp : Math.min(maxHp, Math.max(0, foe.hp));
  const pct = maxHp > 0 ? (hp / maxHp) * 100 : 0;
  const name = foe?.name.trim() || (kind === 'boss' ? 'The Wardkeeper' : 'The Stalker');
  const weakness: ElementP0 | undefined = foe?.weakness;
  const maxHearts = gameState.maxTeamHearts > 0 ? gameState.maxTeamHearts : MAX_TEAM_HEARTS;
  const hearts = Math.max(0, Math.min(maxHearts, gameState.teamHearts));
  const meter = gameState.twinCastMeter >= 2 ? 2 : gameState.twinCastMeter >= 1 ? 1 : 0;
  const seconds = Math.round(TWIN_CAST_WINDOW_MS / 1000);
  const meterStatus =
    meter === 0 ? 'No casts yet' : meter === 1 ? 'Waiting for your partner' : 'Full — shattered';
  const local = findLocalPlayer(gameState.players, localPlayerId, localRole);
  const outOfPosition = gameState.combatPhase === 'team_turn' && local !== null && local.inZone === false;
  const wardUp = Boolean(gameState.wardUp || gameState.boss?.wardUp);
  const fillStyle = {
    width: `${pct}%`,
    background: weakness ? ELEMENT_COLORS[weakness] : '#f0d78c',
  } as CSSProperties;

  return (
    <>
      <header className={styles.ribbon}>
        <p className={styles.round}>Round {gameState.currentRound}</p>
        <ol className={styles.phases}>
          {STEPS.map((step) => (
            <li key={step.id} data-active={gameState.combatPhase === step.id ? 'true' : 'false'}>
              {step.label}
            </li>
          ))}
        </ol>
        {gameState.phase === 'calibrating' ? <p className={styles.calib}>CALIBRATING</p> : <span />}
      </header>
      <div className={styles.hearts}>
        <div className={styles.heartRow} aria-label={`Team hearts ${hearts} of ${maxHearts}`}>
          {Array.from({ length: maxHearts }, (_, index) => (
            <Heart key={index} filled={index < hearts} />
          ))}
        </div>
        <p className={styles.heartCount}>
          {hearts}/{maxHearts}
        </p>
      </div>
      <section className={styles.foe} aria-label="Enemy">
        <div className={styles.portraitFrame}>
          <FoePortrait key={artKey} url={artUrl} kind={kind} />
        </div>
        <h2 className={styles.foeName}>{name}</h2>
        <div className={styles.hpRow}>
          <div
            className={styles.hpTrack}
            role="meter"
            aria-label={`${name} health`}
            aria-valuemin={0}
            aria-valuemax={Math.round(maxHp)}
            aria-valuenow={Math.round(hp)}
          >
            <div className={styles.hpFill} style={fillStyle} />
          </div>
          <p className={styles.hpText}>
            {Math.round(hp)} / {Math.round(maxHp)}
          </p>
        </div>
        {weakness ? (
          <p className={styles.weak}>
            Weak to <strong style={{ color: ELEMENT_COLORS[weakness] }}>{ELEMENT_LABEL[weakness]}</strong>
          </p>
        ) : null}
        {gameState.phase === 'boss' ? (
          <div className={wardUp ? styles.ward : styles.wardBroken}>
            <Crystal shattered={!wardUp} />
            <p className={styles.wardCopy}>{wardUp ? 'WARD RAISED' : 'WARD SHATTERED'}</p>
          </div>
        ) : null}
        <div className={styles.meterBlock}>
          <p className={styles.meterTitle}>Twin Cast</p>
          <div className={styles.meter} data-level={meter} aria-label={`Twin cast meter ${meter} of 2`}>
            <span className={meter >= 1 ? styles.shardOn : styles.shard} />
            <span className={meter >= 2 ? styles.shardOn : styles.shard} />
          </div>
          <p className={styles.meterStatus}>{meterStatus}</p>
          <p className={styles.meterWindow}>Same element within {seconds} seconds</p>
        </div>
      </section>
      {outOfPosition ? (
        <div className={styles.oop} role="alert">
          <p className={styles.oopTitle}>OUT OF POSITION</p>
          <p className={styles.oopBody}>Step back into the outline to cast</p>
        </div>
      ) : null}
    </>
  );
}
