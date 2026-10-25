import { Component, type ReactNode } from 'react';
import { GameViewport } from './ui/GameViewport';
import { LandingScreen } from './ui/LandingScreen';
import { ScriptedIntroduction } from './ui/ScriptedIntroduction';
import { GameMusic } from './ui/GameMusic';
import { useStoryStore } from './net/storyStore';
import './ui/visual-novel.css';
class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main role="alert">The story could not load. Reload to try again.</main> : this.props.children; }
}
export default function App() {
  const started = useStoryStore(s => s.started);
  const room = useStoryStore(s => s.room);
  return <ScreenBoundary><GameViewport>
    {started ? <ScriptedIntroduction /> : <><LandingScreen /><GameMusic /></>}
    {started && room && <aside className="room-code">Room {room.code} · {room.players.length}/2 players</aside>}
  </GameViewport></ScreenBoundary>;
}
