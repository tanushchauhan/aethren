# Team plan

The current shared scope is the authored story through the first wolf encounter. See [plan.md](plan.md) for the playable flow.

- Presentation: title forest, scene transitions, dialogue, choices, sound mixing, accessibility, responsive viewport.
- Story and assets: maintain checked-in dialogue, character colors/pitches, forest scenes, wolf artwork, and recordings.
- Online rooms: maintain two-player room creation/joining and presence. Story advancement is currently local to each player.
- Combat and glove: the room-based combat game, glove firmware/serial bridge and vision code are restored (design in [combat-design.md](combat-design.md)). The glove is the main controller. Combat runs at `/combat` and the debug labs at `/debug/*` until it is stitched into the story flow.

The Meta Muse track is dropped: chat memories and Muse world building are no longer part of the plan, though their code still sits dormant in `server/src/ai` and `server/src/agents`. Removed experiments remain recoverable in commit `af40c2e`.
