import { MockToolbar } from './net';
import { useGameStore } from './net/store';
import { AppRoutes } from './ui/AppRoutes';
import { CombatLayer } from './combat-ui/CombatLayer';
import { GameMusic } from './combat-ui/audio/GameMusic';
import { Narrator } from './combat-ui/Narrator';

/** The original room-based combat game (glove, webcam, shared hearts). Mounted at /combat until it is stitched into the story. */
export default function CombatApp() {
  const phase = useGameStore(s => s.gameState?.phase);
  return <><AppRoutes /><CombatLayer /><Narrator /><GameMusic />{import.meta.env.DEV && phase && phase !== 'lobby' && <MockToolbar />}</>;
}
