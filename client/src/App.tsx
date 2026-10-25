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

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  if (path.replace(/\/+$/, '') !== '') {
    return <ScreenBoundary><Suspense fallback={<p>Opening the lab…</p>}><LabsApp /></Suspense></ScreenBoundary>;
  }
  return <GameApp />;
}
