# Once in a Memory

## Current scope
An authored fantasy visual novel with a rainy forest title, singleplayer or online room setup, a scripted rift introduction, Stay/Run choices, and a first-person wolf encounter.

After the wolf encounter dialogue, the scene fades into a forest combat stage with three wolves. The stage has a local turn queue for the player and each wolf, portrait turn order, active-turn rings, health and energy bars, and battle music. Players can pass; wolves automatically use Roar, Charge and Slash, or Wait with energy costs, recovery, cooldowns, and self buffs. Each wolf moves to the foreground for its supplied action video and returns afterward. Player reactions, player damage resolution, dice, and boss progression are not implemented. See [Opponent combat](opponent-combat.md) for stats, rules, and video cues.

All dialogue, artwork, and sound are checked-in assets. Nothing is generated at runtime. There are no model providers, speech synthesis/transcription services, chat imports, camera tracking, or glove controls.

## Flow
1. New Adventure chooses Singleplayer or Play Online; Join Adventure accepts a four-letter room code.
2. Singleplayer runs locally without a server. Online rooms hold two players and display a shareable room code. Each client advances its own story and choice; synchronized combat is outside the current scope.
3. Anonymous voices introduce the rift. Three graphics, repeated fractures, a shortened swell, lightning, and a white-to-purple flash lead to the silhouettes.
4. Distinct speaker pitches/colors accompany the authored dialogue. Rain continues underneath.
5. After “…Which?”, Stay and Run have separate lead-ins to the same wolf encounter. The player remains off-screen.

## Design
Dark teal, charcoal, muted gold, pixel fonts, translucent dialogue panels, slow camera movement, and sparse sound. Motion reduction disables camera movement and softens the flash. Next reveals or advances text; Skip bypasses dialogue while retaining the Stay/Run decision. Sound controls affect all story audio.

## Recovery
Commit `af40c2e` preserves the complete project before cleanup, including retired integrations and combat experiments. Historical implementations can be recovered from Git; they are not part of the active game.
