# Team plan

The current shared scope is the authored story through the first wolf encounter. See [plan.md](plan.md) for the playable flow.

- Presentation: title forest, scene transitions, dialogue, choices, sound mixing, accessibility, responsive viewport.
- Story and assets: maintain checked-in dialogue, character colors/pitches, forest scenes, wolf artwork, and recordings.
- Online rooms: maintain two-player room creation/joining and presence. Story advancement is currently local to each player.
- Combat and glove: the room-based combat game, glove firmware/serial bridge and vision code are restored (design in [combat-design.md](combat-design.md)). The glove is the main controller. The debug labs live at `/debug/*`; the combat UI will be rebuilt inside the story.

The Meta Muse track is dropped and its code is removed (chat memories, world generation, boss agent, transcription). The old `/combat` client and storybook protocol are gone too. Everything removed is recoverable from commit `04f97d7`; the full pre-cleanup project is in `af40c2e`.
