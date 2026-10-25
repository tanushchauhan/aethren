import type { ReactNode } from 'react';
import { GloveSelect } from './GloveSelect';
import { GloveSessionProvider, useGloveSession } from './GloveSession';
import { CONTROL_LABELS, gloveProfile } from './gloveProfile';
import './glove-select.css';

/** Development only: `/?noglove` skips the requirement so story work does not need hardware. */
function glovesWaived(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).has('noglove');
}

function GateContents({ children }: { children: ReactNode }) {
  const { glove, leave } = useGloveSession();
  if (!glove) return <GloveSelect />;
  const profile = gloveProfile(glove);
  return <>
    {children}
    <aside className="glove-badge" aria-label="Your glove">
      <span>Glove {glove.id}</span>
      <span>{profile.label}</span>
      <span>{CONTROL_LABELS.touch} · {CONTROL_LABELS.button1} · {CONTROL_LABELS.button2} · {CONTROL_LABELS.dial}</span>
      <button type="button" onClick={leave}>Give back</button>
    </aside>
    {!glove.online && <div className="glove-lost" role="alert">
      <p>Glove {glove.id} lost its connection.</p>
      <p>Check that it has power and is on the hotspot. The game continues when it returns.</p>
    </div>}
  </>;
}

/** Nothing inside renders until the player has claimed a glove. */
export function GloveGate({ children }: { children: ReactNode }) {
  if (glovesWaived()) return <>{children}</>;
  return <GloveSessionProvider><GateContents>{children}</GateContents></GloveSessionProvider>;
}
