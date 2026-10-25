import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { MockToolbar } from './net';
import { useGameStore } from './net/store';
import { AppRoutes } from './ui/AppRoutes';
import { CombatLayer } from './combat-ui/CombatLayer';
import { GameMusic } from './combat-ui/audio/GameMusic';
import { Narrator } from './combat-ui/Narrator';
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
  const phase = useGameStore(s => s.gameState?.phase);
  return <ScreenBoundary><AppRoutes /><CombatLayer /><Narrator /><GameMusic />{import.meta.env.DEV && phase && phase !== 'lobby' && <MockToolbar />}</ScreenBoundary>;
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
  const route = path.replace(/\/+$/, '');
  if (route === '/test-lab') {
    return <ScreenBoundary><Suspense fallback={<p>Opening the test lab…</p>}><TestLab /></Suspense></ScreenBoundary>;
  }
  if (route !== '') {
    return <ScreenBoundary><Suspense fallback={<p>Opening the lab…</p>}><LabsApp /></Suspense></ScreenBoundary>;
  }
  return <GameApp />;
}
