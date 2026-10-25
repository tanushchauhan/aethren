import { Component, type ReactNode } from 'react';
import { MockToolbar } from './net';
import { useGameStore } from './net/store';
import { AppRoutes } from './ui/AppRoutes';
import { CombatLayer } from './combat-ui/CombatLayer';
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

export default function App() {
  const phase = useGameStore(s => s.gameState?.phase);
  return <ScreenBoundary><AppRoutes /><CombatLayer /><Narrator />{import.meta.env.DEV && phase && phase !== 'lobby' && <MockToolbar />}</ScreenBoundary>;
}
