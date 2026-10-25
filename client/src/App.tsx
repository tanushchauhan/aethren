import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { GameViewport } from './ui/GameViewport';
import { LandingScreen } from './ui/LandingScreen';
import { ScriptedIntroduction } from './ui/ScriptedIntroduction';
import { GloveGate } from './glove/GloveGate';
import { GameMusic } from './ui/GameMusic';
import { DevTools } from './ui/DevTools';
import { PauseMenu } from './ui/PauseMenu';
import { DuelArena } from './duel/DuelArena';
import { useDuel } from './duel/duelGame';
import { AfterWolfEncounter } from './ui/AfterWolfEncounter';
import { useStoryStore } from './net/storyStore';
import { isGamePath, isTestLabPath } from './debugRoutes';
import './ui/visual-novel.css';

class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error): void { console.error('Screen failed to render', error); }
  render() { return this.state.failed ? <main role="alert">The story could not load. Reload to try again.</main> : this.props.children; }
}

/** Starts at the Gatekeeper's gate, for testing and demos. */
function BossFightEntry() {
  const [muted, setMuted] = useState(false);
  return <AfterWolfEncounter muted={muted} onToggleSound={() => setMuted(!muted)} initialStage="gather" />;
}

function StoryApp() {
  const started = useStoryStore(s => s.started);
  const startAt = useStoryStore(s => s.startAt);
  const room = useStoryStore(s => s.room);
  const duel = useDuel(s => s.active);
  return <GameViewport>
    <GloveGate>
      {duel ? <DuelArena /> : started ? (startAt === 'boss' ? <BossFightEntry /> : <ScriptedIntroduction />) : <><LandingScreen /><GameMusic /><DevTools /></>}
      {started && <PauseMenu />}
      {started && room && <aside className="room-code">Room {room.code} · {room.players.length}/2 players</aside>}
    </GloveGate>
  </GameViewport>;
}

// Labs and the server dashboard are lazy so the story bundle stays small.
const LabsApp = lazy(() => import('./LabsApp'));
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
  // /debug/*, the legacy lab URLs, and any other unknown path open the labs; only / is the story.
  if (!isGamePath(path)) {
    return <ScreenBoundary><Suspense fallback={<p>Opening the lab…</p>}><LabsApp /></Suspense></ScreenBoundary>;
  }
  return <ScreenBoundary><StoryApp /></ScreenBoundary>;
}
