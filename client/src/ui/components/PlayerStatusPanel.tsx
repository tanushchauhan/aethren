import { playerStore, selectCanRetaliate, selectStanceLabel, usePlayerState } from '../../combat/playerState';
import { useStoryStore } from '../../net/storyStore';
import './player-status-panel.css';

export function PlayerStatusPanel() {
  const player = usePlayerState(state => state);
  const name = useStoryStore(state => state.playerName);
  const canRetaliate = selectCanRetaliate(player);
  const resources = [
    { id: 'health', label: 'Health', current: player.health, max: player.maxHealth, icon: '/art/resources/health.png' },
    { id: 'magic', label: 'Magic Power', current: player.magicPower, max: player.maxMagicPower, icon: '/art/resources/mana.png' },
    { id: 'stance', label: 'Stance', current: player.stance, max: player.maxStance, icon: null },
  ];
  return <section className="player-status-panel" aria-label="Player status">
    <h2 className="player-nameplate">{name || 'Spellbearer'}</h2>
    <div className="player-resource-grid">
      {resources.map(resource => <div className={`player-resource ${resource.id}`} key={resource.id}>
        <div className="player-resource-heading">
          {resource.icon ? <img src={resource.icon} alt="" /> : <span className="stance-icon" aria-hidden="true">◆</span>}
          <label id={`player-${resource.id}-label`}>{resource.label}</label>
          <span className="player-resource-numbers">{resource.current}<small> / {resource.max}</small></span>
        </div>
        <div className="player-resource-track" role="progressbar" aria-labelledby={`player-${resource.id}-label`}
          aria-valuemin={0} aria-valuemax={resource.max} aria-valuenow={resource.current}>
          <span style={{ width: `${resource.current / resource.max * 100}%` }} />
        </div>
      </div>)}
    </div>
    <footer className="player-panel-footer">
      <p className={`player-retaliation ${canRetaliate ? 'ready' : 'broken'}`} role="status"><span aria-hidden="true">◆</span> {selectStanceLabel(player)}</p>
      <p className="player-diagnostic-result" role="status" aria-live="polite">
        {player.lastAttackRequest ? `Attack request ${player.lastAttackRequest.id} recorded` : 'Awaiting your action'}
      </p>
      <button type="button" className="player-diagnostic-attack" disabled={player.health <= 0}
        onClick={() => playerStore.getState().requestAttack('diagnostic')}>Diagnostic attack <span aria-hidden="true">➜</span></button>
    </footer>
  </section>;
}
