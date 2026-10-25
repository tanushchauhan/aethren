import { useEffect } from 'react';
import { useStoryStore } from '../net/storyStore';
import { resetGameData } from '../net/resetGameData';
import { usePrefetch } from '../net/prefetch';
import { PrefetchScreen } from './PrefetchScreen';
import './dev-tools.css';

/** Corner tools on the home page for testing and demos. */
export function DevTools() {
  const ready = usePrefetch(s => s.ready);
  const running = usePrefetch(s => s.status === 'running');
  useEffect(() => { void usePrefetch.getState().checkReady(); }, []);
  return <>
    <div className="dev-tools" role="group" aria-label="Diagnostic tools">
      <button type="button" data-ready={ready} title="Download all art, audio and video now so nothing loads during play" onClick={() => void usePrefetch.getState().start()}>
        {running ? 'Preloading…' : ready ? 'Preloaded ✓' : 'Preload game'}
      </button>
      <button type="button" onClick={() => useStoryStore.getState().startBossFight()}>Boss fight</button>
      <button type="button" title="Forget settings, tutorial progress and saved choices, then reload" onClick={resetGameData}>Reset data</button>
    </div>
    <PrefetchScreen />
  </>;
}
