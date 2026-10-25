# Combat — player state, spell building, and opponents

## Current direction

The story battleground is input-driven, with the portrait order, encounter title, and diagnostic End Turn control. The player can build and cast simple spells using diagnostics. Wolves can dodge, take damage, and be defeated. End Turn runs each surviving opponent through its existing move/video lifecycle and then returns control to the player. The separate server engine and debug labs remain intact and independent.

## Shared player state

Health starts at **100/100** and Magic Power at **6/12**. Both clamp to their valid range and ignore non-finite input. Stance is a discrete string union (`PlayerStance`), not a numeric resource:

| State | UI guidance | Can begin a spell? | Can retaliate? |
| --- | --- | --- | --- |
| `balanced` | Hands centered | Yes | Yes |
| `casting` | Channel your spell | No; one cast at a time | No |
| `guarding` | Hold your guard | Yes | Yes |
| `staggered` | Regain your balance | No | No |

Zero Health overrides eligibility and displays Incapacitated. Default Stance is Balanced. A valid cast switches to Casting and returns to the previous stance when finished. If another module changes Stance during the cast, completion preserves that new state. No counter window or automatic player defense has been implemented.

The player panel displays Health and Magic Power bars and a named Stance badge with short guidance. There is no Stance bar, value, or “Ready to retaliate” footer. The panel uses a white, translucent glass surface, backdrop blur, pale highlights, and square corners without gradients.

### Public API

`client/src/combat/playerState.ts` is the shared player state:

- React: `usePlayerState(selector)`.
- Other modules: `playerStore.getState()` and `playerStore.subscribe(listener)`.
- Mutations: `setHealth(value)`, `setMagicPower(value)`, `setStance(enumValue)`, and `reset()`.
- Queries: `selectCanRetaliate(state)` and `selectStanceLabel(state)`.
- `requestAttack(source, input)` records a snapshot of an accepted input. Use the battle API below to validate and execute spells rather than calling this low-level logger directly.

`client/src/combat/spellBattle.ts` exposes the observable `useSpellBattle` store. Non-React adapters use `useSpellBattle.getState()` / `.subscribe()` too. `castSpell(input, source)` is the common entry point for diagnostics and a future glove adapter:

```ts
import { useSpellBattle } from './combat/spellBattle';
import { playerStore, selectCanRetaliate } from './combat/playerState';

const canCounter = selectCanRetaliate(playerStore.getState());
playerStore.getState().setStance('guarding');

useSpellBattle.getState().castSpell(
  { element: 'fire', form: 'bolt', targetId: 'left' },
  'glove',
);
```

This does not yet subscribe to physical glove events. The battleground must be mounted to render and complete casts. `resolveCast(id)` applies an impact once, `finishCast(id)` ends the animation, and `cancelCast()` clears an interrupted spell presentation. `endTurn()` starts the opponent cycle; `beginEnemy()` and `enemyStep(type, id)` drive the retained move engine from the scene. IDs are monotonic so old callbacks cannot affect a reset encounter. Leaving the scene cancels a pending cast without refunding committed Magic Power.

The stores are client-local, not persisted or synchronized. Starting a new adventure resets them. The old turn engine's placeholder player record is not authoritative for this player HUD.

## Small spell builder

`buildSpell({ element, form })` in `spells.ts` constructs a recipe. Independent input fields let future adapters combine different gesture/sensor inputs without duplicating spell logic. The initial forms are **Bolt** and **Burst**. Both affect one selected opponent; Burst is a stronger impact, not an area attack yet.

| Element | Bolt · 2 MP | Damage | Burst · 4 MP | Damage |
| --- | --- | --- | --- | --- |
| Fire | Ember Bolt | 8 | Fireburst | 20 |
| Frost | Frost Shard | 5 | Frost Nova | 14 |
| Storm | Storm Spark | 6 | Storm Pulse | 16 |

Damage is reduced by the opponent's armor, with a minimum of 1 for a hit. These are provisional balance values. Frost and Storm currently differ visually and in damage; they do not apply slow, stun, or resistance effects.

A cast validates that it is the player’s turn, a living target, a known recipe, available Magic Power, and a valid stance, then locks further casts and spends Magic Power once. Impact resolves after 900 ms and presentation finishes after 1800 ms (150/500 ms with reduced motion). Missing particle images do not block gameplay because resolution does not depend on image load events. Invalid casts spend nothing. Dodged casts still spend Magic Power. There is no passive regeneration yet.

### Diagnostics

Choose Element, Form, Target, and Enemy response, then press **Diagnostic attack**. The button displays the built spell's name. A successful request records its source, recipe input, resource snapshot, and retaliation eligibility.

Enemy response options are explicitly diagnostic:

- Natural: Stalkers dodge 20% of incoming spells; the leader dodges 10%.
- Force hit: always hit, applying armor.
- Force dodge: always evade without losing HP.

Glove-sourced requests always use Natural; they cannot force the outcome. **Refill magic** restores MP to maximum for testing. **Reset encounter** cancels active effects, restores opponents and player defaults, and clears feedback.

### Particle effects and opponent reactions

Use selected transparent Kenney Particle Pack textures in `client/public/art/particles/` for tinted projectiles, impact rings, and fragments. Fire uses flame texture, Frost a star-shaped shard, and Storm a spark. Burst increases the impact spread. The supplied CC0 license is copied alongside the files. No runtime generation is used.

A dodge briefly moves the wolf aside and displays “Dodged.” A hit shakes and flashes the wolf, displays damage, and updates its health bar. Reduced motion suppresses the projectile flight, shake, dodge displacement, and flash while retaining feedback text and a soft impact. A defeated wolf fades away and is removed from target selection and portrait order. After the last wolf is defeated and the final spell presentation finishes, a victory overlay says “Encounter won / The vale falls silent.” Combat controls are removed. Continue fades out the battlefield and opens the authored “Beyond the clearing” scene; it does not start another battle.

The battleground stays above the square-cornered glass HUD. Keep the title introduction, portrait indicator, forest rain, slow entrance fades, and `Final Surge` music. Ground rings and particle shockwaves remain circles; rectangular UI controls and bars have no corner radius.

### Reusable VFX layers

`spellVfx.ts` provides `buildSpellVfx(spell, overrides)` and shared `SPELL_TIMING`. Profiles separate core/accent/trail/residue textures, highlight colors, trail count, orbit count, shard count, ring count, spread, and core scale. New recipes can tune those fields without duplicating the renderer. Fire uses flame/embers/smoke, Frost shards and rings, and Storm sparks with trace accents. Burst raises layer counts and spread.

The renderer combines a casting sigil, travelling outer/inner cores, orbiting accents, a trailing particle stream, staggered impact rings, radial fragments, and lingering residue. Reduced motion retains only a soft impact ring. Gameplay timing is independent of texture loading.

## Diagnostic turn cycle

The player may cast multiple spells while resources allow, then select **End turn**. It is disabled during a cast, opponent turns, or after victory. Living wolves act in left → leader → right order, skipping defeated opponents, and return control to the player. Opponent actions still do not damage the player; player reactions remain deferred.

Every change of active actor increments a global turn counter: Turn 1 is the player, Turn 2 the left wolf, and so on. An encounter-style announcement displays “Turn #” and whose turn it is. The initial encounter title precedes the first turn announcement. The portrait queue rotates and the active opponent’s ground ring turns green. Enemy movement starts after a short announcement pause.

The existing Roar/Charge and Slash/Wait selection, energy recovery, cooldowns, status duration, front-position animation, and video fallback rules run during this cycle. Each wolf returns to position before the next turn. End Turn cannot be submitted twice, player spells cannot be cast during an opponent turn, and stale media callbacks do not advance a newer turn.

## Opponent definitions retained for later integration

| Stat | Left/right Stalker | Center Pack leader |
| --- | --- | --- |
| Maximum / starting HP | 40 / 40 | 60 / 60 |
| Maximum / starting Energy | 10 / 10 | 10 / 10 |
| Base charge-and-slash damage | 8 | 12 |
| Base armor | 0 | 1 |
| Starting statuses | None | None |

Opponents do not use mana. Armor is flat incoming damage reduction, with a minimum of 1 damage for a positive hit unless a future immunity explicitly negates it. Defeated actors are removed from the retained engine's queue and have statuses cleared. Diagnostic spells now apply damage to these opponents through the separate spell battle store.

### Prepared moves

| Move | Energy cost | Effect |
| --- | --- | --- |
| Roar | 3 | Self-only Roused: +25% damage, rounded down, and +2 armor. No stacking or healing. |
| Charge and Slash | 4 | One standard outgoing attack event: 8 damage for Stalkers, 12 for the leader; 10/15 while Roused. No player HP resolution. |
| Wait | 0 | Restore 2 Energy, capped at maximum. |

The retained turn-based engine recovers 3 Energy at the start of an opponent turn, ticks cooldowns only for that opponent, gives Roar a three-own-turn-start cooldown, and expires Roused after the next two own turns (not the application turn). Its deterministic selector opens with Charge and Slash for Stalkers and Roar for the leader, then prefers legal Roar, legal Charge and Slash, or Wait.

**These timing rules run during diagnostic opponent turns.** They remain owner-turn based, not real-time seconds. The player state store remains authoritative for the player HUD; the retained engine’s placeholder player actor is used only to delimit the opponent cycle.

### Video assets and action infrastructure

- Roar: `client/public/art/combat/moves/roar.mp4`, copied from supplied `1.mp4`. Playback segment 0–4.8 seconds, buff cue at 1.5 seconds.
- Charge and Slash: `client/public/art/combat/moves/charge-slash.mp4`, copied from supplied `2.mp4`. Playback segment 4.8–9.95 seconds skips its blank lead-in, with attack cue at source time 6.2 seconds.

The full source files are preserved. `WolfMoveAnimation` removes edge-connected white background in a canvas, supports mute/reduced motion, pauses video in hidden tabs, and has a finite media-failure fallback. The retained resolver prevents duplicate costs/effects and supports approaching, playing, and returning phases. Ending the player’s diagnostic turn triggers these opponent attacks; casting a spell alone does not. Dodge reactions are a separate response to incoming player spells.

## Next steps

1. Map real glove gestures to the existing element/form/target input API.
2. Tune spell costs, damage, dodge chances, and discrete stance transitions through playtesting.
3. Decide how physical glove inputs should commit/end turns and eventually resolve incoming attacks against player defenses.
4. Add player reactions, additional spell forms, status effects, and network synchronization when specified.
