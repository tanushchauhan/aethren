# Opponent combat — the wolves of the vale

Status: opponent mechanics implemented; initial balance values still need playtesting. Player reactions and damage resolution are deferred.

## Scope and current behavior

This document specifies opponents only. Player health, mana, status effects, defenses, weapons, and other qualities belong in a separate player specification. The values below are starting balance proposals, not a claim that combat is already implemented or balanced through playtesting.

The current game has three wolves, a rotating local turn queue, red ground rings that turn green for the active wolf, portrait initiative order, health and energy bars, and battle music. The player passes manually; wolves then act automatically. Stalkers have 40 HP and the leader has 60 HP. All start with 10 Energy. Per-opponent resources, regeneration, cooldowns, Roused buffs, armor, and defeat-safe queue handling are implemented.

A wolf moves to the center foreground for its action, plays the supplied footage with its white backdrop removed in the canvas, then returns to its original position before initiative advances. Other wolves recede during the action. Reduced motion uses a brief still presentation. Charge and Slash emits a single outgoing attack event; it does not change player HP or trigger a player reaction yet. Defeat handling has no player attack UI wired to it yet.

Keep the existing authored story and manual progression while adding these mechanics one at a time. No runtime AI, hardware inputs, or network combat endpoints are required by this specification. Online combat synchronization remains separate work.

## Opponent roster

| Stat | Left and right wolf: Stalker | Center wolf: Pack leader |
| --- | --- | --- |
| Starting / maximum HP | 40 / 40 | 60 / 60 |
| Starting / maximum Energy | 10 / 10 | 10 / 10 |
| Energy recovery | +3 at start of its own turn | +3 at start of its own turn |
| Base charge-and-slash damage | 8 | 12 |
| Base armor | 0 | 1 |
| Starting status effects | None | None |
| Moves | Roar, Charge and Slash, Wait | Roar, Charge and Slash, Wait |

The leader has greater endurance and damage, not an extra turn. Opponents do not use mana in this encounter. HP does not regenerate. Energy is clamped between zero and its maximum; HP is clamped between zero and maximum HP.

Armor is flat incoming-damage reduction after any future player-side attack calculation. A damaging hit deals at least 1 HP after armor, unless an explicit immunity or full-negation effect says otherwise. Do not add accuracy rolls, critical hits, elemental resistances, or speed-based initiative yet.

## Initiative and action lifecycle

Initial order: **Player → Left wolf → Pack leader → Right wolf**. Each actor takes one action, then moves to the back of the queue. One round ends after every living participant present at the round's start has had a turn or been defeated. Removing a defeated actor must not cause a second turn or an incorrect round count.

On an opponent's turn:

1. Skip it if defeated; otherwise mark its portrait and ground ring active.
2. Recover 3 Energy, capped at 10, and tick existing cooldowns.
3. Select and validate one legal move. Show its intent before resolving it.
4. Commit its cost once; play its animation; resolve its effect once at a designated animation cue.
5. Expire eligible statuses, then advance the queue after the animation ends.

Only one action may be in flight. Repeated input or media events must not spend Energy, apply damage, or advance the queue twice. A missing or failed video must use a fallback completion path rather than stall combat. Playback cues are recorded below. Failed or stalled media resolves the effect once and returns the wolf; hidden tabs pause the video and the media fallback clock.

## Moves

| Move | Energy | Cooldown | Target | Effect |
| --- | --- | --- | --- | --- |
| Roar | 3 | 3 own-turn starts | Self | Gain **Roused**: +25% outgoing damage and +2 armor |
| Charge and Slash | 4 | None | One living player target | One hit for base damage, modified by Roused |
| Wait | 0 | None | Self | Recover an additional 2 Energy, capped at 10; no attack |

### Roar — supplied video 1

Source: `/Users/atharva/Downloads/Untitled (1536 x 1024 px)/1.mp4`.

Game asset: `client/public/art/combat/moves/roar.mp4`. Play 0–4.8 seconds; apply the buff at 1.5 seconds. The full original file is preserved; later footage is not part of the roar action.

The acting wolf roars and strengthens itself. It deals no damage and does not buff other wolves. All three wolves may use the move. This keeps each wolf's state independent and avoids three stacking pack-wide buffs.

**Roused** lasts through the wolf's next two turns after the application turn. The roar turn does not consume duration. Apply +25% to outgoing base damage, rounded down: Stalker 8 → 10; leader 12 → 15. Add 2 to armor: Stalker 0 → 2; leader 1 → 3. Do not increase maximum HP, restore HP, or increase Energy.

Roused cannot stack, and Roar cannot be selected while Roused is active. The bonus is derived from base stats so expiration restores the original values exactly. Show a small roar status icon near the bars with a tooltip explaining the bonuses and remaining duration.

Set Roar's cooldown to 3 when committed. At the next three starts of that wolf's turn it becomes 2, 1, then 0. It becomes available at 0. No other actor's turn reduces this cooldown.

### Charge and Slash — supplied video 2

Source: `/Users/atharva/Downloads/Untitled (1536 x 1024 px)/2.mp4`.

Game asset: `client/public/art/combat/moves/charge-slash.mp4`. Play 4.8–9.95 seconds to skip the blank lead-in; emit the attack at 6.2 seconds of source time. The full original file is preserved.

The wolf charges toward the camera and slashes once. The charge is movement, not a second damage event. Telegraph this as a standard, single-target attack. Apply its damage once at the slash impact cue, then return the wolf to its original battlefield position.

The opponent system emits an attack event with source, target, damage, and attack type. Future player defense rules resolve damage received; this document does not define block, dodge, player armor, or player resource costs. Charge and Slash applies no bleed, stun, or other player status in the first version.

### Wait

Use when no preferred legal move is available. A short idle presentation completes the turn. Opponent Wait restores Energy. The player’s pass action changes no player stats.

## Predictable opponent behavior

Use a deterministic move selector, not random choices or an AI service:

- The leader prefers Roar on its first turn; Stalkers prefer Charge and Slash on theirs.
- On later turns, prefer Roar if its cooldown is zero, Roused is absent, and Energy is at least 3.
- Otherwise use Charge and Slash if Energy is at least 4 and a living target exists.
- Otherwise Wait.

Validate the chosen move again before committing. If the encounter has ended, do not select another action. For the current local prototype, attacks target the local player; multiplayer targeting awaits the synchronization design.

## Opponent data and presentation

Separate immutable definitions from mutable encounter state:

- Definition: stable ID, display name, sprite, base HP, maximum Energy, base damage, base armor, move IDs, and animation references.
- Runtime state: current HP/Energy, move cooldowns, statuses with source and remaining duration, defeated flag, and current action ID.
- Move definition: target type, cost, cooldown, effect, telegraph, animation, and impact cue.

At zero HP, mark the wolf defeated once, remove it from initiative, clear its statuses, and fade out its sprite, bars, and ring. No rewards, victory screen, or next-stage transition are specified here.

Keep portraits compact and image-only, with the active outline and directional ordering. Keep wolves centered. Health is a rounded red bar with a darker outline, ten equal segments, and an overlapping heart icon on the left; each segment represents 10% of that wolf's maximum HP. Energy is a smaller amber ten-segment bar beneath it, with one segment per Energy. Neither bar needs visible numbers; accessible labels expose current and maximum values. Red/green rings describe turn ownership, not buffs or health.

Use `Final Surge` for battle music and preserve the sound toggle and reduced-motion support. Both supplied videos are copied into the game and used for opponent actions.

## Validation and next steps

Automated rules tests cover full rounds, move costs, owner-only cooldowns, buff expiry, no stacking, duplicate inputs/events, media-failure completion, armor, and defeated actors. Browser checks cover actual footage, background removal, foreground placement, automatic enemy turns, and returning control to the player.

Next: specify player reactions and resources before consuming the outgoing attack event. Add player attacks separately to exercise opponent damage and defeat in the game. Balance the first encounter through playtesting before adding further enemy types or progression.
