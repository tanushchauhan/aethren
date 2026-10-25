import { NOISE_LOUD_THRESHOLD } from '../net/contract';
import { useGameStore } from '../net/store';
import styles from './combat.module.css';

export function TooLoudBanner() {
  const tooLoud = useGameStore((state) => state.gameState?.tooLoud === true);
  const noiseLevel = useGameStore((state) => state.hardware?.noiseLevel ?? 0);
  if (!tooLoud && noiseLevel < NOISE_LOUD_THRESHOLD) return null;

  return (
    <p className={styles.loud} role="status">
      Room Too Loud — Mic Gate Raised
    </p>
  );
}
