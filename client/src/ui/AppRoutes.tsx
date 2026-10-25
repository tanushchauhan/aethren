import { useEffect, useRef, type ReactElement } from 'react';
import type { RoomPhase } from '../net/contract';
import { advancePhase } from './taleActions';
import { DefeatScreen } from './DefeatScreen';
import { HappilyEverAfter } from './HappilyEverAfter';
import { LandingScreen } from './LandingScreen';
import { MemoryCarousel } from './MemoryCarousel';
import './storybook.css';
import './visual-novel.css';
import { useUiStore } from './storeBindings';

/**
 * Phase map:
 * (none) | lobby -> LandingScreen
 * upload -> automatically continue with built-in story memories
 * opening -> MemoryCarousel
 * generating -> loading; intro -> visual novel scene in GameApp
 * calibrating | encounter | boss -> null (CombatLayer)
 * ending -> HappilyEverAfter
 * defeat -> DefeatScreen
 */
export function AppRoutes(): ReactElement | null {
  const phase = useUiStore((state) => state.gameState?.phase ?? null);
  return screenForPhase(phase);
}

function screenForPhase(phase: RoomPhase | null): ReactElement | null {
  switch (phase) {
    case null:
    case 'lobby':
      return <LandingScreen />;
    case 'upload':
      return <StartStory />;
    case 'opening':
      return <MemoryCarousel />;
    case 'generating':
      return <main className="title-screen" aria-live="polite"><p>Opening your adventure…</p></main>;
    case 'intro':
      return null;
    case 'calibrating':
    case 'encounter':
    case 'boss':
      return null;
    case 'ending':
      return <HappilyEverAfter />;
    case 'defeat':
      return <DefeatScreen />;
    default: {
      const unexpected: never = phase;
      void unexpected;
      return <LandingScreen />;
    }
  }
}

/** Chat import is deferred; continue with the room's built-in story memories. */
function StartStory() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    advancePhase('opening');
  }, []);
  return <main className="title-screen" aria-live="polite"><p>Opening your adventure…</p></main>;
}
