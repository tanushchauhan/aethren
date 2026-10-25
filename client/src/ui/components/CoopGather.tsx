import { useEffect } from 'react';
import { seekPartner, useCoop } from '../../net/coopLink';
import { useStoryStore } from '../../net/storyStore';
import './coop.css';

/** At the gate: wait for a second screen on the same glove hub, or face the knight alone. */
export function CoopGather({ onPaired, onAlone }: { onPaired: () => void; onAlone: () => void }) {
  const name = useStoryStore(state => state.playerName);
  const { status, role, partnerName } = useCoop();
  useEffect(() => { seekPartner(name); }, [name]);
  // A short beat so both players read who joined before the fight opens.
  useEffect(() => {
    if (status !== 'paired') return;
    const timer = window.setTimeout(onPaired, 1600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const paired = status === 'paired';
  return <section className="coop-gather" aria-labelledby="coop-gather-title" role="status">
    <p>Co-op</p>
    <h2 id="coop-gather-title">{paired ? `${partnerName} stands beside you` : 'Waiting at the gate'}</h2>
    <span>{paired ? (role === 'host' ? 'You act first, then your partner. The Gatekeeper grows stronger for two.' : 'Your partner acts first, then you. The Gatekeeper grows stronger for two.')
      : status === 'unavailable' ? 'The glove hub cannot be reached, so no partner can join. Start the hub, or fight alone.'
      : 'A second player on another screen joins when they reach the gate on the same glove hub.'}</span>
    {!paired && <i className="coop-gather-pulse" aria-hidden="true" />}
    {!paired && <button type="button" data-glove-b1="Alone" onClick={onAlone}>Fight alone <kbd className="glove-key">B1</kbd></button>}
  </section>;
}

/** On a co-op screen: the partner's card, and what happens when their screen drops out. */
export function CoopPartnerCard({ name, health, maxHealth, magic, maxMagic, active, away }: {
  name: string; health: number; maxHealth: number; magic: number; maxMagic: number; active: boolean; away: boolean;
}) {
  return <aside className="coop-partner" data-active={active} data-away={away} aria-label={`Partner ${name}`}>
    <strong>{name}</strong>
    <span className="coop-partner-state">{away ? 'Disconnected' : health <= 0 ? 'Fallen' : active ? 'Their turn' : 'Partner'}</span>
    <div className="coop-partner-bar health" role="progressbar" aria-label={`${name} health`} aria-valuemin={0} aria-valuemax={maxHealth} aria-valuenow={health}>
      <span style={{ width: `${health / maxHealth * 100}%` }} /><b>{health}</b>
    </div>
    <div className="coop-partner-bar magic" role="progressbar" aria-label={`${name} Magic Power`} aria-valuemin={0} aria-valuemax={maxMagic} aria-valuenow={magic}>
      <span style={{ width: `${magic / maxMagic * 100}%` }} /><b>{magic}</b>
    </div>
  </aside>;
}
