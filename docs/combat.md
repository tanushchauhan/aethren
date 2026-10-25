# Combat — player state, spell building, and opponents

## Current direction

The story battleground is input-driven, with the portrait order, encounter title, and diagnostic End Turn control. The player can build and cast simple spells using diagnostics. Wolves can dodge, take damage, and be defeated. End Turn runs each surviving opponent through its existing move/video lifecycle and then returns control to the player. The separate server engine and debug labs remain intact and independent.

## Shared player state

Health starts at **100/100** and Magic Power at **6/12**. Both clamp to their valid range and ignore non-finite input. Stance has a clamped internal `stanceValue` of 0–100 (initially 100). The UI exposes only named states: Balanced at 60–100, Shaken at 30–59, and Staggered below 30. Casting and Guarding are temporary action states:

| State | UI guidance | Can begin a spell? | Can retaliate? |
| --- | --- | --- | --- |
| `balanced` | Hands centered | Yes | Yes |
| `shaken` | Balance weakened | Yes | Yes |
| `casting` | Channel your spell | No; one cast at a time | No |
| `guarding` | Hold your guard | Yes | Yes |
| `staggered` | Regain your balance | No | No |

Zero Health overrides eligibility and displays Incapacitated. Default Stance is Balanced. A valid cast switches to Casting and returns to the current numeric stance band when finished (or preserves Guarding). If another module changes Stance during the cast, completion preserves that new state. No counter window or automatic player defense has been implemented.

The player panel displays Health and Magic Power bars and a named Stance badge with short guidance. There is no Stance bar, value, or “Ready to retaliate” footer. The panel uses a white, translucent glass surface, backdrop blur, pale highlights, and square corners without gradients.

### Public API

`client/src/combat/playerState.ts` is the shared player state:

- React: `usePlayerState(selector)`.
- Other modules: `playerStore.getState()` and `playerStore.subscribe(listener)`.
- Mutations: `setHealth(value)`, `setMagicPower(value)`, `setStance(enumValue)`, `setStanceValue(value)`, `receiveAttack(damage, stanceDamage)`, `startTurn()`, and `reset()`.
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

Enable **Enable diagnostics** in the bottom toolbar to reveal Element, Form, Target, Enemy response, Diagnostic attack, Refill magic, and Reset encounter. Diagnostics are off by default; End turn and Rest remain visible. Choose the inputs, then press **Diagnostic attack**. The button displays the built spell's name. A successful request records its source, recipe input, resource snapshot, and retaliation eligibility.

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

The player may cast multiple spells while resources allow, then select **End turn**. It is disabled during a cast, opponent turns, or after victory. Living wolves act in left → leader → right order, skipping defeated opponents, and return control to the player. Opponent slashes now damage player health and stance at the video impact cue. Automatic dodge/counter inputs remain deferred.

Every change of active actor increments a global turn counter: Turn 1 is the player, Turn 2 the left wolf, and so on. An encounter-style announcement displays “Turn #” and whose turn it is. The initial encounter title precedes the first turn announcement. The portrait queue rotates and the active opponent’s ground ring turns green. Enemy movement starts after a short announcement pause.

The existing Roar/Charge and Slash/Jaw and Grab/Rest selection, energy recovery, cooldowns, status duration, front-position animation, and video fallback rules run during this cycle. Each wolf returns to position before the next turn. End Turn cannot be submitted twice, player spells cannot be cast during an opponent turn, and stale media callbacks do not advance a newer turn.

## Opponent definitions

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
| Charge and Slash | 4 | One standard outgoing attack event: 8 damage for Stalkers, 12 for the leader; 10/15 while Roused. Also deals 22 stance damage for Stalkers / 30 for the leader and refreshes Bleeding. |
| Jaw and Grab | 8 | Normal health damage plus 55 stance damage; refreshes Bleeding. Three-own-turn-start cooldown. |
| Rest | 0 | Restore 5 Energy, capped at maximum, without attacking. |

The retained turn-based engine recovers 3 Energy at the start of an opponent turn, ticks cooldowns only for that opponent, gives Roar a three-own-turn-start cooldown, and expires Roused after the next two own turns (not the application turn). Its deterministic selector opens with Charge and Slash for Stalkers and Roar for the leader, then rests below 4 Energy, uses Jaw and Grab when Roused and affordable/off cooldown, otherwise prefers legal Roar, legal Charge and Slash, or Rest.

**These timing rules run during diagnostic opponent turns.** They remain owner-turn based, not real-time seconds. The player state store remains authoritative for the player HUD; the retained engine’s placeholder player actor is used only to delimit the opponent cycle.

### Video assets and action infrastructure

- Roar: `client/public/art/combat/moves/roar.mp4`, copied from supplied `1.mp4`. Playback segment 0–4.8 seconds, buff cue at 1.5 seconds.
- Charge and Slash: `client/public/art/combat/moves/charge-slash.mp4`, copied from supplied `2.mp4`. Playback segment 4.8–9.95 seconds skips its blank lead-in, with attack cue at source time 6.2 seconds.

The full source files are preserved. `WolfMoveAnimation` removes edge-connected white background in a canvas, supports mute/reduced motion, pauses video in hidden tabs, and has a finite media-failure fallback. The retained resolver prevents duplicate costs/effects and supports approaching, playing, and returning phases. Ending the player’s diagnostic turn triggers these opponent attacks; casting a spell alone does not. Dodge reactions are a separate response to incoming player spells.

## Next steps

1. Map real glove gestures to the existing element/form/target input API.
2. Tune spell costs, damage, dodge chances, and discrete stance transitions through playtesting.
3. Decide how physical glove inputs should commit/end turns and eventually resolve incoming attacks against player defenses.
4. Add physical defense reactions, additional spell forms/status effects, and network synchronization when specified.

## Player injury and active status effects

- Charge and Slash and Jaw and Grab damage Health and stance exactly once, including media-error fallback. Roused increases real health damage to 10/15 and still grants +2 armor.
- Each slash refreshes **Bleeding** to two player-turn starts; it does not stack. Bleeding deals 2 Health damage at each start, then expires. The HUD shows a blood-drop icon beneath Health; hover or focus reveals details and duration.
- Each player-turn start restores 35 stance, capped at 100, and derives the visible band again. Shaken can cast/retaliate; Staggered cannot, but can End turn to recover. Casting completion does not reset the numeric stance resource.
- A Guarding state provided by another module halves the next hit's Health and stance damage. After impact, stance returns to its numeric band. There is no automatic guard input yet.
- Hits show a red edge glow, claw marks, and damage text; bleed shows softer red feedback. Reduced motion omits claw marks and reduces feedback intensity. Health bars update immediately.
- Zero Health stops enemy processing and shows Encounter lost with Try again, which resets both stores. No automatic continuation after defeat.
- Wolf clips play at 1.35× speed with impact tied to source timestamps. Approach/return take 0.55 seconds with 0.65-second lifecycle timers, and turn introductions wait 1.1 seconds.

These values are provisional tuning defaults. Fire/Frost/Storm remain direct-damage spells; Roused and Bleeding are the currently implemented status effects.

## Status presentation and low-health feedback

`statusEffects.ts` defines a shared `StatusEffectId`, generic `StatusEffect` interface and `STATUS_EFFECTS` metadata registry, used by both player and opponent state. Bleeding uses a red blood-drop icon; Roused uses golden crossed swords. Additional mechanics should register their label, description and icon here.

Player status icons form a horizontal row directly beneath Health. The row can be collapsed entirely, showing its count, and reopened. More than five effects show a +N control; expansion wraps within the health column and can be reduced back to five. Effect descriptions and remaining turns appear on hover or keyboard focus rather than as permanent text.

Below 50% Health, battlefield grayscale and the red inset edge shadow increase continuously toward zero Health. Active Bleeding adds red edge streaks, whose opacity increases with low health. Healing reduces the effect, and resetting clears it. The player HUD remains in color. No flashing, gradients or camera movement are added; reduced-motion mode removes transitions.

## Jaw and Grab, move captions, and Rest

Every active opponent displays its move name beneath its sprite, from preparation through return. Rest stays at the original position, displays Rest and +5 Energy at recovery, and does not lunge toward the player.

The supplied Jaw and Grab video is stored at `client/public/art/combat/moves/jaw-grab.mp4`. It plays source seconds 0–4.95 at 1.35×, with the forward bite landing at source time 1.8 seconds. It costs 8 Energy (versus Slash’s 4 and Roar’s 3), deals the wolf’s normal health damage (including Roused), and removes 55 stance. Guarding halves both damage types. It refreshes the existing Bleeding effect. Impact is idempotent even if video playback fails. Its cooldown ticks on its owner’s turn starts.

Player **Rest** is available alongside End turn, outside diagnostics. It immediately restores 45 stance (the current stamina/balance reserve) and 3 Magic Power, clamped to their maxima, then spends the turn. It neither heals Health nor removes Bleeding. Normal turn-start recovery and bleed ticks still occur. No separate player Energy meter is introduced. Rest is blocked during casts, opponent turns, and completed encounters, including repeated clicks.
