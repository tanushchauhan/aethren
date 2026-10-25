# Combat — player state and the wolves of the vale

## Current direction

The story battleground is an input-driven scene, with a compact portrait turn-order indicator but no active turn loop, pass button, or automatic opponent attacks. The player portrait is highlighted as ready while attack definitions are pending. The future remote glove will provide spell and attack inputs. For now, the **Diagnostic attack** button records an attack request only. No attack types, damage, target selection, resource costs, or player reactions are defined by that button.

The existing opponent move engine, video playback component, and tests remain available for reuse. Their earlier turn-based behavior is not mounted in the current story scene. The separate server engine and debug/hardware labs restored from main remain intact; they are not connected to this local player state yet. See [combat-design.md](combat-design.md) for that separate system.

## Player state

| Stat | Initial / maximum | Meaning |
| --- | --- | --- |
| Health | 100 / 100 | At zero the player cannot retaliate or submit attack requests. |
| Magic Power | 6 / 12 | Available magical resource; no costs or regeneration yet. |
| Stance | 100 / 100 | Retaliation readiness; zero means stance is broken. |

These are initial tuning values. Health and Magic Power follow the earlier resource proposal; Stance starts full as a provisional default. Retaliation eligibility is **Health > 0 and Stance > 0**. This is a readiness check, not a counter timing window or an implemented retaliatory attack. A partial positive stance remains ready until more detailed stance rules are specified.

All updates clamp to the stat's valid range. Non-finite inputs are ignored. There is no automatic recovery or turn-based ticking. New singleplayer adventures and newly joined online rooms reset player state; HUD re-renders do not. State is held in client memory and is not persisted across reloads or synchronized over the network.

Status effects, spell definitions, individual attack requirements, and glove bindings will be specified separately. Do not invent them when integrating this state.

### Shared API

`client/src/combat/playerState.ts` owns the single source of player state for this story scene.

- React: `usePlayerState(selector)` subscribes the UI to values.
- Other modules: `playerStore.getState()` reads the current snapshot and actions.
- External consumers: `playerStore.subscribe(listener)` observes updates; call the returned unsubscribe function when done.
- Actions: `setHealth(value)`, `setMagicPower(value)`, `setStance(value)`, `requestAttack(source)`, and `reset()`.
- Derived selectors: `selectCanRetaliate(state)` and `selectStanceLabel(state)`.

```ts
import { playerStore, selectCanRetaliate } from './combat/playerState';

const eligible = selectCanRetaliate(playerStore.getState());
playerStore.getState().setStance(0);

const unsubscribe = playerStore.subscribe((state, previous) => {
  if (state.lastAttackRequest !== previous.lastAttackRequest) {
    // A future attack resolver can consume the new request here.
  }
});
// Call unsubscribe() when the consumer is disposed.
```

An attack request contains an incrementing ID, source (`diagnostic` or `glove`), timestamp, resource snapshot, and retaliation eligibility at submission. Only the latest request and count are stored; subscribers receive each update. A future glove adapter can call the same API, but no hardware input is wired in this change. Read state through the public actions/selectors rather than mutating stored objects.

Diagnostic requests do not automatically require positive Stance: ordinary attacks and retaliation are distinct, and ordinary attack rules have not been specified. The request includes `canRetaliate` for the future resolver. Zero Health prevents request submission.

## Battleground and player HUD

Move the centered wolves higher to leave space beneath them. Use a broad, translucent yellow/ochre player panel with a raised nameplate, borrowing the visual novel dialogue layout but using its own palette and styles. Show Health, Magic Power, and Stance as labeled bars with current/max values. Display “Ready to retaliate,” “Stance broken,” or “Incapacitated” from the shared state. The diagnostic button confirms each request visibly without applying gameplay effects.

Opponent health and energy bars remain above the wolves, with segmented fills and overlapping icons. Their red rings are idle indicators in this version. The portrait order remains visible with the player highlighted; it does not advance automatically while the turn loop is disconnected. The encounter title appears before the wolves fade in and then fades away. Preserve the entrance fade, forest rain, `Final Surge` music, sound toggle, and reduced-motion support.

## Opponent definitions retained for later integration

| Stat | Left/right Stalker | Center Pack leader |
| --- | --- | --- |
| Maximum / starting HP | 40 / 40 | 60 / 60 |
| Maximum / starting Energy | 10 / 10 | 10 / 10 |
| Base charge-and-slash damage | 8 | 12 |
| Base armor | 0 | 1 |
| Starting statuses | None | None |

Opponents do not use mana. Armor is flat incoming damage reduction, with a minimum of 1 damage for a positive hit unless a future immunity explicitly negates it. Defeated actors are removed from the retained engine's queue and have statuses cleared. There is no player attack input connected to opponent damage yet.

### Prepared moves

| Move | Energy cost | Effect |
| --- | --- | --- |
| Roar | 3 | Self-only Roused: +25% damage, rounded down, and +2 armor. No stacking or healing. |
| Charge and Slash | 4 | One standard outgoing attack event: 8 damage for Stalkers, 12 for the leader; 10/15 while Roused. No player HP resolution. |
| Wait | 0 | Restore 2 Energy, capped at maximum. |

The retained turn-based engine recovers 3 Energy at the start of an opponent turn, ticks cooldowns only for that opponent, gives Roar a three-own-turn-start cooldown, and expires Roused after the next two own turns (not the application turn). Its deterministic selector opens with Charge and Slash for Stalkers and Roar for the leader, then prefers legal Roar, legal Charge and Slash, or Wait.

**Those timing rules are inactive in the story battleground now.** Before reconnecting opponent actions to the glove-driven flow, define action scheduling and recovery/status durations explicitly; do not silently reinterpret turns as seconds. The old engine is retained for reuse and regression coverage, not used to advance the new player HUD.

### Video assets and action infrastructure

- Roar: `client/public/art/combat/moves/roar.mp4`, copied from supplied `1.mp4`. Playback segment 0–4.8 seconds, buff cue at 1.5 seconds.
- Charge and Slash: `client/public/art/combat/moves/charge-slash.mp4`, copied from supplied `2.mp4`. Playback segment 4.8–9.95 seconds skips its blank lead-in, with attack cue at source time 6.2 seconds.

The full source files are preserved. `WolfMoveAnimation` removes edge-connected white background in a canvas, supports mute/reduced motion, pauses video in hidden tabs, and has a finite media-failure fallback. The retained resolver prevents duplicate costs/effects and supports approaching, playing, and returning phases. None of these moves is automatically triggered by the new diagnostic button.

## Next steps

1. Define the player's attack and spell inputs, costs, targets, and outcomes.
2. Connect diagnostic requests to those definitions, then connect the remote glove to the same input API.
3. Define stance depletion/recovery and retaliation windows.
4. Define non-turn-based opponent scheduling and status/cooldown timing before reconnecting their moves.
5. Add player status effects and server synchronization when their rules are specified.
