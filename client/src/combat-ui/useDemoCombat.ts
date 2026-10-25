import { useEffect } from 'react';
import { useGameStore, getServerNow } from '../net/store';
import type { AttackTypeP0, CombatPhase } from '../net/contract';

/** Local practice uses the same pose/dodge/cast events; live rooms always use the server. */
export function useDemoCombat() {
  useEffect(() => {
    let deadline = 0, phaseKey = '', turnStart = 0, castApplied = false, damageApplied = false, wardRaised = false;
    const tick = () => {
      const store = useGameStore.getState();
      let game = store.gameState;
      if (!store.mockMode || !game || !['encounter', 'boss'].includes(game.phase)) return;
      const now = getServerNow();
      const key = `${game.phase}:${game.combatPhase}:${game.currentRound}`;
      const change = (phase: CombatPhase, duration: number) => {
        game = { ...game!, combatPhase: phase };
        deadline = now + duration; phaseKey = `${game.phase}:${phase}:${game.currentRound}`;
        store.applyRoomState(game);
      };
      const startRound = () => {
        const attackType = (['low_sweep', 'high_swing', 'projectile'] as AttackTypeP0[])[game!.currentRound % 3]!;
        const delay = game!.phase === 'boss' ? 2400 : 4000;
        damageApplied = false; castApplied = false;
        store.applyTelegraph({ attackId: crypto.randomUUID(), attackType, targetPlayerIds: [store.localPlayerId!], impactServerMs: now + delay, windowMs: 2000,
          narratorHint: attackType === 'high_swing' ? 'High swing — duck!' : attackType === 'projectile' ? 'Projectile — step aside or parry!' : 'Low sweep — step out of the outline!' });
        change('telegraph', delay);
      };
      if (key !== phaseKey) {
        phaseKey = key;
        if (game.combatPhase === 'idle') { startRound(); return; }
        deadline = now + 1000;
      }
      if (game.combatPhase === 'return' && !damageApplied && now >= deadline - 2400) {
        damageApplied = true;
        const hit = store.lastDodges.find(d => d.attackId === store.latestTelegraph?.attackId && d.playerId === store.localPlayerId);
        const hearts = Math.max(game.phase === 'encounter' ? 1 : 0, game.teamHearts - (hit?.dodged ? 0 : 1));
        game = { ...game, teamHearts: hearts }; store.applyRoomState(game);
        if (!hearts) { store.setPhase('defeat', 'idle'); return; }
      }
      if (game.combatPhase === 'team_turn' && !castApplied) {
        const cast = store.lastCasts.find(c => c.playerId === store.localPlayerId && c.serverTimestampMs >= turnStart);
        if (cast) {
          castApplied = true;
          const foe = game.phase === 'boss' ? game.boss : game.encounter;
          const hp = Math.max(game.phase === 'encounter' && game.currentRound < 2 ? 1 : 0, (foe?.hp ?? 24) - 8);
          const nextFoe = foe ? { ...foe, hp } : foe;
          const ward = game.phase === 'boss' && !wardRaised && hp > 0 && hp <= (foe?.maxHp ?? 24) / 2;
          if (ward) wardRaised = true;
          // The practice partner copies the player's spell; a live partner must cast independently.
          game = { ...game, ...(game.phase === 'boss' ? { boss: nextFoe as typeof game.boss } : { encounter: nextFoe }), twinCastMeter: 2, wardUp: ward,
            teamHearts: cast.element === 'bloom' ? Math.min(game.maxTeamHearts, game.teamHearts + 1) : game.teamHearts,
            narratorCaption: 'Your practice partner matches your spell. Twin Cast!' };
          store.applyRoomState(game); deadline = now + 1000;
        }
      }
      if (now < deadline) return;
      switch (game.combatPhase) {
        case 'telegraph': change('defense', 2000); break;
        case 'defense': change('return', 3000); break;
        case 'return': turnStart = now; castApplied = false; change('team_turn', game.phase === 'encounter' ? 16000 : 10000); break;
        case 'team_turn': change('resolve', 1000); break;
        case 'resolve': {
          const foe = game.phase === 'boss' ? game.boss : game.encounter;
          if ((foe?.hp ?? 1) <= 0) {
            if (game.phase === 'boss') store.setPhase('ending', 'idle');
            else { store.applyRoomState({ ...game, phase: 'boss', combatPhase: 'idle', currentRound: 0, teamHearts: game.maxTeamHearts, wardUp: false, twinCastMeter: 0, narratorCaption: 'The minions fall. The guardian steps into the moonlight.' }); phaseKey = ''; }
          } else { store.applyRoomState({ ...game, combatPhase: 'idle', currentRound: game.currentRound + 1, twinCastMeter: 0 }); phaseKey = ''; }
          break;
        }
        default: startRound();
      }
    };
    const timer = window.setInterval(tick, 80);
    return () => window.clearInterval(timer);
  }, []);
}
