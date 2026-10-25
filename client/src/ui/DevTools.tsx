import { useStoryStore } from '../net/storyStore';
import { resetGameData } from '../net/resetGameData';
import './dev-tools.css';

/** Corner tools on the home page for testing and demos. */
export function DevTools() {
  return <div className="dev-tools" role="group" aria-label="Diagnostic tools">
    <button type="button" onClick={() => useStoryStore.getState().startBossFight()}>Boss fight</button>
    <button type="button" title="Forget settings, tutorial progress and saved choices, then reload" onClick={resetGameData}>Reset data</button>
  </div>;
}
