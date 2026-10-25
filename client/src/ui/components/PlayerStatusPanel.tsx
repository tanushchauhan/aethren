import { useState } from 'react';
import { playerStore, selectStanceLabel, usePlayerState } from '../../combat/playerState';
import { buildSpell, type SpellElement, type SpellForm } from '../../combat/spells';
import { useSpellBattle, type DodgeMode } from '../../combat/spellBattle';
import { combatants } from '../../combat/encounter';
import { useStoryStore } from '../../net/storyStore';
import './player-status-panel.css';

export function PlayerStatusPanel() {
  const player = usePlayerState(state => state);
  const name = useStoryStore(state => state.playerName);
  const battle = useSpellBattle();
  const [element, setElement] = useState<SpellElement>('fire');
  const [form, setForm] = useState<SpellForm>('bolt');
  const [targetId, setTargetId] = useState('left');
  const [dodgeMode, setDodgeMode] = useState<DodgeMode>('natural');
  const targets = combatants.filter(actor => actor.side === 'enemy' && !battle.opponents[actor.id].defeated);
  const target = targets.some(actor => actor.id === targetId) ? targetId : targets[0]?.id ?? '';
  const spell = buildSpell({ element, form })!;
  const canCast = battle.activeId === 'player' && battle.status === 'active' && !battle.pending && player.health > 0 && ['balanced', 'guarding'].includes(player.stance) && player.magicPower >= spell.cost && !!target;
  const hints = { balanced: 'Hands centered', casting: 'Channel your spell', guarding: 'Hold your guard', staggered: 'Regain your balance' };
  const resources = [
    { id: 'health', label: 'Health', current: player.health, max: player.maxHealth, icon: '/art/resources/health.png' },
    { id: 'magic', label: 'Magic Power', current: player.magicPower, max: player.maxMagicPower, icon: '/art/resources/mana.png' },
  ];
  return <section className="player-status-panel" aria-label="Player status">
    <h2 className="player-nameplate">{name || 'Spellbearer'}</h2>
    <div className="player-resource-grid">
      {resources.map(resource => <div className={`player-resource ${resource.id}`} key={resource.id}>
        <div className="player-resource-heading">
          <img src={resource.icon} alt="" /><span id={`player-${resource.id}-label`}>{resource.label}</span>
          <span className="player-resource-numbers">{resource.current}<small> / {resource.max}</small></span>
        </div>
        <div className="player-resource-track" role="progressbar" aria-labelledby={`player-${resource.id}-label`}
          aria-valuemin={0} aria-valuemax={resource.max} aria-valuenow={resource.current}>
          <span style={{ width: `${resource.current / resource.max * 100}%` }} />
        </div>
      </div>)}
      <div className="player-stance" aria-label="Stance">
        <span className="player-stance-label">Stance</span>
        <strong data-stance={player.stance}>{selectStanceLabel(player)}</strong>
        <small>{player.health > 0 ? hints[player.stance] : 'Recover your health'}</small>
      </div>
    </div>
    <div className="spell-builder" role="group" aria-label="Diagnostic spell builder">
      <label>Element<select aria-label="Element" value={element} onChange={event => setElement(event.target.value as SpellElement)} disabled={!!battle.pending || battle.activeId !== 'player'}>
        <option value="fire">Fire</option><option value="frost">Frost</option><option value="storm">Storm</option>
      </select></label>
      <label>Form<select aria-label="Form" value={form} onChange={event => setForm(event.target.value as SpellForm)} disabled={!!battle.pending || battle.activeId !== 'player'}>
        <option value="bolt">Bolt · 2 MP</option><option value="burst">Burst · 4 MP</option>
      </select></label>
      <label>Target<select aria-label="Target" value={target} onChange={event => setTargetId(event.target.value)} disabled={!!battle.pending || battle.activeId !== 'player' || !targets.length}>
        {targets.length ? targets.map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>) : <option value="">No opponents</option>}
      </select></label>
      <label>Enemy response<select aria-label="Enemy response" value={dodgeMode} onChange={event => setDodgeMode(event.target.value as DodgeMode)} disabled={!!battle.pending || battle.activeId !== 'player'}>
        <option value="natural">Natural</option><option value="hit">Force hit</option><option value="dodge">Force dodge</option>
      </select></label>
      <button type="button" className="player-diagnostic-attack" disabled={!canCast}
        onClick={() => battle.castSpell({ element, form, targetId: target }, 'diagnostic', dodgeMode)}>
        Diagnostic attack <small>{spell.name}</small>
      </button>
    </div>
    <footer className="player-panel-footer">
      <button type="button" className="diagnostic-end-turn" disabled={!!battle.pending || battle.activeId !== 'player' || battle.status !== 'active'} onClick={() => battle.endTurn()}>End turn</button>
      <p role="status" aria-live="polite">{!targets.length ? 'The clearing is safe.' : player.magicPower < spell.cost && !battle.pending ? 'Not enough Magic Power — refill to continue testing.' : battle.message}</p>
      <button type="button" disabled={!!battle.pending || battle.activeId !== 'player'} onClick={() => playerStore.getState().setMagicPower(player.maxMagicPower)}>Refill magic</button>
      <button type="button" onClick={() => { battle.reset(); playerStore.getState().reset(); }}>Reset encounter</button>
    </footer>
  </section>;
}
