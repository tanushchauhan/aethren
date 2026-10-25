import { useState, type ReactNode } from 'react';
import { GloveMenuNav } from './GloveMenuNav';
import { GloveSelect } from './GloveSelect';
import { GloveSessionProvider, useGloveSession } from './GloveSession';
import { CONTROL_LABELS, gloveProfile } from './gloveProfile';
import './glove-select.css';

/**
 * TEMPORARY: shows "Continue without a glove" on the glove screen so anyone can play without hardware.
 * Set to false (and delete the bypass) once gloves are reliable enough to require.
 */
export const ALLOW_GLOVE_BYPASS = true;
const BYPASS_KEY = 'once-upon:noglove';

/** `/?noglove` in development, or the temporary bypass button for this browser tab, skips the requirement. */
function glovesWaived(): boolean {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('noglove')) return true;
  try { return ALLOW_GLOVE_BYPASS && sessionStorage.getItem(BYPASS_KEY) === '1'; } catch { return false; }
}

function GateContents({ children, onBypass }: { children: ReactNode; onBypass?: () => void }) {
  const { glove, leave } = useGloveSession();
  if (!glove) return <GloveSelect onBypass={onBypass} />;
  const profile = gloveProfile(glove);
  return <>
    {children}
    <GloveMenuNav />
    <aside className="glove-badge" aria-label="Your glove">
      <span className="glove-badge-id">Glove {glove.id} · {profile.label}</span>
      <span className="glove-badge-keys" aria-label="Glove controls">
        <kbd className="glove-key">{CONTROL_LABELS.touch}</kbd>
        <kbd className="glove-key">{CONTROL_LABELS.button1}</kbd>
        <kbd className="glove-key">{CONTROL_LABELS.button2}</kbd>
        <kbd className="glove-key">{CONTROL_LABELS.dial} ⟳</kbd>
      </span>
      <button type="button" onClick={leave}>Give back</button>
    </aside>
    {!glove.online && <div className="glove-lost" role="alert">
      <p>Glove {glove.id} lost its connection.</p>
      <p>Check that it has power and is on the hotspot. The game continues when it returns.</p>
    </div>}
  </>;
}

/** Nothing inside renders until the player has claimed a glove (or uses the temporary bypass). */
export function GloveGate({ children }: { children: ReactNode }) {
  const [waived, setWaived] = useState(glovesWaived);
  if (waived) return <>{children}</>;
  const bypass = () => {
    try { sessionStorage.setItem(BYPASS_KEY, '1'); } catch { /* still waived for this page */ }
    setWaived(true);
  };
  return <GloveSessionProvider><GateContents onBypass={ALLOW_GLOVE_BYPASS ? bypass : undefined}>{children}</GateContents></GloveSessionProvider>;
}
