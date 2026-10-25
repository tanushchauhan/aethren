import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { ScriptedIntroduction } from './ui/ScriptedIntroduction';
import { GameViewport } from './ui/GameViewport';
import { AppRoutes } from './ui/AppRoutes';
import { useGameStore } from './net/store';
import { GameMusic } from './combat-ui/audio/GameMusic';
import { Narrator } from './combat-ui/Narrator';
import { isGamePath, isTestLabPath } from './debugRoutes';
function StoryPlaceholder() { return <main role="alert">The story could not load. Reload to try again.</main>; }
class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error('Screen failed to render', error);
  }

  render() {
    if (this.state.failed) return <StoryPlaceholder />;
    return this.props.children;
  }
}

function GameApp() {
  const phase = useGameStore(state => state.gameState?.phase);
  useEffect(() => {
    if (phase === 'intro') useGameStore.getState().setPhase('calibrating');
  }, [phase]);
  const rebuildingCombat = phase === 'intro' || phase === 'calibrating' || phase === 'encounter' || phase === 'boss';
  return <ScreenBoundary><GameViewport>{rebuildingCombat
    ? <ScriptedIntroduction />
    : <><AppRoutes />{phase !== 'generating' && phase !== 'opening' && <Narrator />}<GameMusic /></>
  }</GameViewport></ScreenBoundary>;
}

const LabsApp = lazy(() => import('./LabsApp'));
// Server developer dashboard: two simulated laptops against the real server.
const TestLab = lazy(() => import('./test-lab/TestLab'));

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  if (isTestLabPath(path)) {
    return <ScreenBoundary><Suspense fallback={<p>Opening the test lab…</p>}><TestLab /></Suspense></ScreenBoundary>;
  }
  // /debug/*, the legacy lab URLs, and any other unknown path open the labs; only / is the game.
  if (!isGamePath(path)) {
    return <ScreenBoundary><Suspense fallback={<p>Opening the lab…</p>}><LabsApp /></Suspense></ScreenBoundary>;
  }
  return <GameApp />;
}
