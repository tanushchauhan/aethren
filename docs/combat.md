# Combat — player state, spell building, and opponents

## Current direction

The story battleground is input-driven, with the portrait order, encounter title, and diagnostic End Turn control. The player can cast twelve element spells (four each for Fire, Frost and Storm) using diagnostics, and they apply real status effects. Wolves can dodge, take damage, and be defeated. End Turn runs each surviving opponent through its existing move/video lifecycle and then returns control to the player. The separate server engine and debug labs remain intact and independent.

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
  { spellId: 'fire-lance', targetId: 'left' },
  'glove',
);
```

This does not yet subscribe to physical glove events. The battleground must be mounted to render and complete casts. `resolveCast(id)` applies an impact once, `finishCast(id)` ends the animation, and `cancelCast()` clears an interrupted spell presentation. `endTurn()` starts the opponent cycle; `beginEnemy()` and `enemyStep(type, id)` drive the retained move engine from the scene. IDs are monotonic so old callbacks cannot affect a reset encounter. Leaving the scene cancels a pending cast without refunding committed Magic Power.

The stores are client-local, not persisted or synchronized. Starting a new adventure resets them. The old turn engine's placeholder player record is not authoritative for this player HUD.

## Element spells

`spells.ts` defines twelve spells in `SPELLS`, four per element (`SPELLS_BY_ELEMENT`). Each element has its own role rather than sharing generic forms: **Fire** deals the most damage per Magic Power, **Frost** protects you and slows the pack, **Storm** is cheap, spreads damage and disrupts wolf turns. `getSpell(id)` validates external input. A spell is declarative data (damage, `pierce`, `area`, `splash`, `chain`, an applied wolf effect, `drain`, `shield`, `overcharge`); `spellBattle.ts` resolves it.

| Element | Spell | MP | Effect |
| --- | --- | --- | --- |
| Fire | Ember Bolt | 2 | 8 damage. |
| Fire | Fire Lance | 4 | 18 damage that ignores armor. |
| Fire | Immolate | 3 | 5 damage, then **Burning**: 4 damage at the start of its next 3 turns, ignoring armor. |
| Fire | Meteor | 7 | 22 to the target and 10 to every other wolf. 2-second charge. |
| Frost | Frost Shard | 2 | 5 damage and **Chilled** for its next turn. |
| Frost | Ice Shield | 3 | You gain **Ice Shield**: absorbs 18 health damage, lasting 2 of your turn starts. |
| Frost | Frost Prison | 5 | **Frozen**: the wolf skips its next 2 turns. No damage. |
| Frost | Frost Nova | 4 | 5 damage to every wolf and Chills them all. |
| Storm | Storm Spark | 1 | 4 damage. Nearly instant. |
| Storm | Chain Lightning | 4 | 9 to the target, then 6 to the nearest other wolf and 4 to the last. |
| Storm | Static Shock | 3 | 4 damage and **Drained**: energy is emptied, so its next turn is Rest. |
| Storm | Overcharge | 2 | You gain **Overcharged**: your next damaging spell deals 50% more to its primary target; a Storm spell also refunds 1 MP. Lasts this turn and the next. |

Armor reduces every hit to a minimum of 1, except Fire Lance and burn ticks. Single-target spells can be dodged; area, splash and chain spells cannot. A dodged spell applies no effect. Effects refresh rather than stack. Self spells (Ice Shield, Overcharge) need no target and are not consumed by Overcharge. Non-damaging spells do not spend Overcharge.

Balance targets: single-target damage per MP is Fire 4–4.5, Storm 4, Frost 2.5 plus control. Multi-target spells only beat that when several wolves are alive (Meteor ≈ 6/MP against three). The player regains **2 Magic Power at the start of each turn** (`MAGIC_REGEN`), on top of Rest's +3, so the 5–7 MP spells are reachable without debug refills.

### Status effects

| Effect | On | Mechanic | Visual |
| --- | --- | --- | --- |
| Burning | Wolf | At the start of each of its turns, before it acts, takes `amount` damage ignoring armor. Can kill it; a burn kill can win the encounter during the opponents' turn. | Flames at the wolf's feet; “−4 Burning” on each tick. |
| Chilled | Wolf | Its attacks deal 30% less health and stance damage (`CHILL_FACTOR`). | Frosty glow and falling ice motes. |
| Frozen | Wolf | Skips its turns: no energy recovery, cooldowns or move. Its other effects still count down and burn still ticks. | Ice block grows over the sprite; “Frozen” shows on each skipped turn. |
| Drained | Wolf | Energy set to 0 on hit; its next move is always Rest. | Flickering arcs over the wolf. |
| Ice Shield | You | Guarding halves an attack first; the shield then absorbs what it can. A fully absorbed hit deals no health damage, does not cause Bleeding and halves stance damage. | Crystal wall in front of you that flashes per block, cracks below half and shatters when spent. |
| Overcharged | You | See Overcharge. | Crackling violet hand; the boosted spell glows violet. |

Wolf effects applied by spells use `appliedAction: PLAYER_ACTION` and count down at the end of each of that wolf's own turns, so a 1-turn effect covers exactly its next turn. Player effects count down at your turn start, alongside Bleeding. Roar now adds Roused without clearing other effects. All effects use the shared `STATUS_EFFECTS` registry and icons.

A cast validates the turn, a living target for enemy spells, a known spell, Magic Power and stance, then locks further casts and spends Magic Power once. Invalid casts spend nothing; dodged casts still spend Magic Power.

### Diagnostics

Enable **Enable diagnostics** in the bottom toolbar to reveal Element, Spell, Target, Enemy response, the Cast button, Refill magic and Reset encounter. The Spell list shows the chosen element's four spells with their costs; Target is disabled for self spells. The Cast button shows the spell's effect, and notes when Overcharge will boost it. End turn and Rest stay visible without diagnostics.

Enemy response options are explicitly diagnostic:

- Natural: Stalkers dodge 20% of incoming single-target spells; the leader dodges 10%.
- Force hit: always hit, applying armor.
- Force dodge: single-target spells always miss. Area, splash and chain spells still land.

Glove-sourced requests always use Natural; they cannot force the outcome. **Refill magic** restores MP to maximum for testing. **Reset encounter** cancels active effects, restores opponents and player defaults, and clears feedback.

### Spell visuals

Every spell is held in the hand before release: a pulsing aura, a turning sigil and element motes drawn inward (1 second; Meteor 2 seconds, which also glows in the sky). `SPELL_VISUALS` in `spellVfx.ts` sets each spell's projectile, impact, size, charge and flight time; `spellTiming(spell)` derives impact and finish times from it.

- Fire: fireballs with a flame tail; Fire Lance is a stretched flame spear whose impact streaks through the wolf; Meteor falls from the sky and explodes with double fire rings.
- Frost: a spinning icicle that locks onto its target; Frost Prison and Frost Nova use a six-point crystal cluster and erupt in a ring of ground spikes (on every wolf for Nova). Ice Shield sends crystals out to form the wall.
- Storm: a crackling orb along a lightning channel; Chain Lightning arcs visibly from wolf to wolf, 160 ms per jump; Overcharge pulls lightning into the hand.

Each wolf hit gets its own impact: full size for the primary target and Frost Nova, smaller for splash and chain. Hits flash the wolf white, knock it back, shake the stage and show the damage with the effect name beneath. Reduced motion keeps only the soft impact flash and the feedback text, and freezes status animations.

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

1. Map real glove gestures to the `{ spellId, targetId }` input API.
2. Tune spell costs, damage, dodge chances, and discrete stance transitions through playtesting.
3. Decide how physical glove inputs should commit/end turns and eventually resolve incoming attacks against player defenses.
4. Add physical defense reactions and network synchronization when specified.

## Player injury and active status effects

- Charge and Slash and Jaw and Grab damage Health and stance exactly once, including media-error fallback. Roused increases real health damage to 10/15 and still grants +2 armor.
- Each slash refreshes **Bleeding** to two player-turn starts; it does not stack. Bleeding deals 2 Health damage at each start, then expires. The HUD shows a blood-drop icon beneath Health; hover or focus reveals details and duration.
- Each player-turn start restores 35 stance, capped at 100, and derives the visible band again. Shaken can cast/retaliate; Staggered cannot, but can End turn to recover. Casting completion does not reset the numeric stance resource.
- A Guarding state provided by another module halves the next hit's Health and stance damage. After impact, stance returns to its numeric band. There is no automatic guard input yet.
- Hits show a red edge glow, claw marks, and damage text; bleed shows softer red feedback. Reduced motion omits claw marks and reduces feedback intensity. Health bars update immediately.
- Zero Health stops enemy processing and shows Encounter lost with Try again, which resets both stores. No automatic continuation after defeat.
- Wolf clips play at 1.35× speed with impact tied to source timestamps. Approach/return take 0.55 seconds with 0.65-second lifecycle timers, and turn introductions wait 1.1 seconds.

These values are provisional tuning defaults. Spell status effects (Burning, Chilled, Frozen, Drained, Ice Shield, Overcharged) are described under Element spells.

## Status presentation and low-health feedback

`statusEffects.ts` defines a shared `StatusEffectId`, generic `StatusEffect` interface and `STATUS_EFFECTS` metadata registry, used by both player and opponent state. Bleeding uses a red blood-drop icon; Roused uses golden crossed swords. Additional mechanics should register their label, description and icon here.

Player status icons form a horizontal row directly beneath Health. The row can be collapsed entirely, showing its count, and reopened. More than five effects show a +N control; expansion wraps within the health column and can be reduced back to five. Effect descriptions and remaining turns appear on hover or keyboard focus rather than as permanent text.

Below 50% Health, battlefield grayscale and the red inset edge shadow increase continuously toward zero Health. Active Bleeding adds red edge streaks, whose opacity increases with low health. Healing reduces the effect, and resetting clears it. The player HUD remains in color. No flashing, gradients or camera movement are added; reduced-motion mode removes transitions.

## Jaw and Grab, move captions, and Rest

Every active opponent displays its move name beneath its sprite, from preparation through return. Rest stays at the original position, displays Rest and +5 Energy at recovery, and does not lunge toward the player.

The supplied Jaw and Grab video is stored at `client/public/art/combat/moves/jaw-grab.mp4`. It plays source seconds 0–4.95 at 1.35×, with the forward bite landing at source time 1.8 seconds. It costs 8 Energy (versus Slash’s 4 and Roar’s 3), deals the wolf’s normal health damage (including Roused), and removes 55 stance. Guarding halves both damage types. It refreshes the existing Bleeding effect. Impact is idempotent even if video playback fails. Its cooldown ticks on its owner’s turn starts.

Player **Rest** is available alongside End turn, outside diagnostics. It immediately restores 45 stance (the current stamina/balance reserve) and 3 Magic Power, clamped to their maxima, then spends the turn. It neither heals Health nor removes Bleeding. Normal turn-start recovery and bleed ticks still occur. No separate player Energy meter is introduced. Rest is blocked during casts, opponent turns, and completed encounters, including repeated clicks.
