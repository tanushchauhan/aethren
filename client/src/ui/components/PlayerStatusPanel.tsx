import { useState } from 'react';
import { heroStore, playerStore, selectStanceLabel, useLocalHero, usePlayerState } from '../../combat/playerState';
import { SPELLS, SPELLS_BY_ELEMENT, type SpellElement, type SpellId } from '../../combat/spells';
import { useSpellBattle, type DodgeMode } from '../../combat/spellBattle';
import { combatants } from '../../combat/encounter';
import { useStoryStore } from '../../net/storyStore';
import { StatusEffects } from './StatusEffects';
import './player-status-panel.css';

export function PlayerStatusPanel() {
  const me = useLocalHero();
  const player = usePlayerState(state => state);
  const name = useStoryStore(state => state.playerName);
  const battle = useSpellBattle();
  const [diagnostics, setDiagnostics] = useState(false);
  const [element, setElement] = useState<SpellElement>('fire');
  const [chosen, setChosen] = useState<SpellId>('ember-bolt');
  const [targetId, setTargetId] = useState('left');
  const [dodgeMode, setDodgeMode] = useState<DodgeMode>('natural');
  const targets = combatants.filter(actor => actor.side === 'enemy' && battle.opponents[actor.id] && !battle.opponents[actor.id].defeated);
  const target = targets.some(actor => actor.id === targetId) ? targetId : targets[0]?.id ?? '';
  // Switching element keeps the choice only if it belongs to that element.
  const spell = SPELLS[SPELLS_BY_ELEMENT[element].includes(chosen) ? chosen : SPELLS_BY_ELEMENT[element][0]];
  const self = spell.target === 'self';
  const overcharged = player.statuses.some(effect => effect.id === 'overcharged') && spell.damage > 0;
  const canCast = battle.activeId === me && battle.status === 'active' && !battle.pending && player.health > 0 && ['balanced', 'guarding', 'shaken'].includes(player.stance) && player.magicPower >= spell.cost && (self || !!target);
  const hints = { balanced: 'Hands centered', shaken: 'Balance weakened', casting: 'Channel your spell', guarding: 'Hold your guard', staggered: 'Regain your balance' };
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
        {resource.id === 'health' && <StatusEffects effects={player.statuses} />}
      </div>)}
      <div className="player-stance" aria-label="Stance">
        <span className="player-stance-label">Stance</span>
        <strong data-stance={player.stance}>{selectStanceLabel(player)}</strong>
        <small>{player.health > 0 ? hints[player.stance] : 'Recover your health'}</small>
      </div>
    </div>
    {diagnostics && <div id="diagnostic-spells" className="spell-builder" role="group" aria-label="Diagnostic spell builder">
      <label>Element<select aria-label="Element" value={element} onChange={event => setElement(event.target.value as SpellElement)} disabled={!!battle.pending || battle.activeId !== me}>
        <option value="fire">Fire</option><option value="frost">Frost</option><option value="storm">Storm</option>
      </select></label>
      <label>Spell<select aria-label="Spell" value={spell.id} onChange={event => setChosen(event.target.value as SpellId)} disabled={!!battle.pending || battle.activeId !== me}>
        {SPELLS_BY_ELEMENT[element].map(id => <option key={id} value={id}>{SPELLS[id].name} · {SPELLS[id].cost} MP</option>)}
      </select></label>
      <label>Target<select aria-label="Target" value={self ? 'player' : target} onChange={event => setTargetId(event.target.value)} disabled={self || !!battle.pending || battle.activeId !== me || !targets.length}>
        {self ? <option value="player">Yourself</option> : targets.length ? targets.map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>) : <option value="">No opponents</option>}
      </select></label>
      <label>Enemy response<select aria-label="Enemy response" value={dodgeMode} onChange={event => setDodgeMode(event.target.value as DodgeMode)} disabled={!!battle.pending || battle.activeId !== me}>
        <option value="natural">Natural</option><option value="hit">Force hit</option><option value="dodge">Force dodge</option>
      </select></label>
      <button type="button" className="player-diagnostic-attack" disabled={!canCast}
        onClick={() => battle.castSpell(self ? { spellId: spell.id } : { spellId: spell.id, targetId: target }, 'diagnostic', dodgeMode)}>
        Cast {spell.name} <small>{spell.description}{overcharged ? ' Overcharged ×1.5.' : ''}</small>
      </button>
    </div>}
    <footer className="player-panel-footer">
      <button type="button" className="diagnostic-end-turn" disabled={!!battle.pending || battle.activeId !== me || battle.status !== 'active'} onClick={() => battle.endTurn()}>End turn</button>
      <button type="button" className="player-rest" title="Recover 45 stance and 3 Magic Power, then end your turn."
        disabled={!!battle.pending || battle.activeId !== me || battle.status !== 'active'} onClick={() => battle.rest()}>Rest · Hold B2</button>
      {diagnostics && <><p role="status" aria-live="polite">{!targets.length ? 'The clearing is safe.' : player.magicPower < spell.cost && !battle.pending ? 'Not enough Magic Power — rest or end your turn to recover it.' : battle.message}</p>
      <button type="button" disabled={!!battle.pending || battle.activeId !== me} onClick={() => heroStore(me).getState().setMagicPower(player.maxMagicPower)}>Refill magic</button>
      <button type="button" onClick={() => battle.diagnosticKillAll()}>Instant kill all</button>
      <button type="button" onClick={() => battle.discoverAllSpells()}>Unlock all spells</button>
      <button type="button" onClick={() => { battle.reset(); playerStore.getState().reset(); }}>Reset encounter</button></>}
      <label className="diagnostics-toggle"><input type="checkbox" checked={diagnostics} onChange={event => setDiagnostics(event.target.checked)} />Enable diagnostics</label>
    </footer>
  </section>;
}
