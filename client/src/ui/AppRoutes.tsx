import type { ReactElement } from 'react';
import type { RoomPhase } from '../net/contract';
import { ChatUploadScreen } from './ChatUploadScreen';
import { DefeatScreen } from './DefeatScreen';
import { HappilyEverAfter } from './HappilyEverAfter';
import { LandingScreen } from './CombatLandingScreen';
import { MemoryCarousel } from './MemoryCarousel';
import { StorybookIntro } from './StorybookIntro';
import './storybook.css';
import './visual-novel.css';
import { useUiStore } from './storeBindings';

/**
 * Phase map:
 * (none) | lobby -> LandingScreen
 * upload -> ChatUploadScreen
 * opening -> MemoryCarousel
 * generating | intro -> StorybookIntro
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
      return <ChatUploadScreen />;
    case 'opening':
      return <MemoryCarousel />;
    case 'generating':
    case 'intro':
      return <StorybookIntro />;
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
