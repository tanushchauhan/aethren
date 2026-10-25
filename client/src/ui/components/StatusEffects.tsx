import { useId, useState } from 'react';
import { Moon, Skull, ChevronDown, ChevronUp, Droplet, Flame, Shield, Snowflake, Swords, ThermometerSnowflake, Zap, ZapOff } from 'lucide-react';
import { STATUS_EFFECTS, type StatusEffect } from '../../combat/statusEffects';
import './status-effects.css';

const icons = { skull: Skull, moon: Moon, droplet: Droplet, swords: Swords, flame: Flame, 'thermometer-snowflake': ThermometerSnowflake, snowflake: Snowflake, 'zap-off': ZapOff, shield: Shield, zap: Zap };
export function StatusEffectIcon({ effect }: { effect: StatusEffect }) {
  const definition = STATUS_EFFECTS[effect.id], Icon = icons[definition.icon];
  const strength = effect.id === 'shielded' ? ` ${effect.amount} points left.` : effect.id === 'burning' ? ` ${effect.amount} damage per turn.` : '';
  const description = `${definition.label}: ${definition.description}${strength} ${effect.remaining} turn${effect.remaining === 1 ? '' : 's'} remaining.`;
  return <span className="status-effect-icon" tabIndex={0} role="img" aria-label={description} style={{ color: definition.color }}>
    <Icon size={20} aria-hidden="true" />
    {effect.id === 'shielded' && <span className="status-effect-amount" aria-hidden="true">{effect.amount}</span>}
    <span className="status-effect-tooltip" aria-hidden="true">{description}</span>
  </span>;
}
export function StatusEffects({ effects }: { effects: readonly StatusEffect[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!effects.length) return null;
  const visible = expanded ? effects : effects.slice(0, 5);
  return <div className="status-effects">
    <button type="button" className="status-effects-toggle" aria-label={collapsed ? 'Show status effects' : 'Hide status effects'}
      aria-expanded={!collapsed} aria-controls={id} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      {collapsed && <span>{effects.length}</span>}
    </button>
    <div id={id} hidden={collapsed}>
      <ul className="status-effects-list" aria-label="Active status effects">
        {visible.map((effect, index) => <li key={`${effect.id}-${index}`}><StatusEffectIcon effect={effect} /></li>)}
        {effects.length > 5 && <li><button type="button" className="status-effects-more" aria-expanded={expanded}
          aria-label={expanded ? 'Show fewer status effects' : `Show ${effects.length - 5} more status effects`}
          onClick={() => setExpanded(!expanded)}>{expanded ? '−' : `+${effects.length - 5}`}</button></li>}
      </ul>
    </div>
  </div>;
}
