# Once in a Memory

## Current scope
An authored fantasy visual novel with a rainy forest title, singleplayer or online room setup, a scripted rift introduction, Stay/Run choices, and a first-person wolf encounter.

After the wolf encounter dialogue, the scene fades into a forest battleground with three wolves, a brief encounter title, portrait order, and a white translucent player HUD. Shared player state exposes Health, Magic Power, and discrete Stance (Balanced, Shaken, Casting, Guarding, Staggered). The diagnostic spell selector offers four spells per Fire/Frost/Storm element, targets opponents or self, and spends Magic Power. Opponents can dodge, show hurt feedback, and be defeated. Diagnostic End Turn cycles through the surviving wolves with numbered turn announcements before returning to the player; the same spell input API is available for a future glove adapter. Winning shows an encounter-complete overlay and Continue leads through a silhouette forest escape, deserted castle, and video descent into the final Ruined Gatekeeper boss fight. The boss has 240 HP, heavy armor, two Scorn-inflicting axe moves and Rest; defeating him completes the demo. The existing opponent move engine and supplied videos power the diagnostic enemy turns. See [Combat](combat.md) for APIs, stats, and rules.

The main story and wolf encounter use checked-in dialogue, artwork, video, and sound; they do not depend on runtime generation, chat imports, camera tracking, or glove controls. Main’s separate debug labs retain their audio, vision, and hardware tools, and the server combat engine remains available alongside story rooms.

## Flow
1. New Adventure chooses Singleplayer or Play Online; Join Adventure accepts a four-letter room code.
2. Singleplayer runs locally without a server. Online rooms hold two players and display a shareable room code. Each client advances its own story and choice; synchronized combat is outside the current scope.
3. Anonymous voices introduce the rift. Three graphics, repeated fractures, a shortened swell, lightning, and a white-to-purple flash lead to the silhouettes.
4. Distinct speaker pitches/colors accompany the authored dialogue. Rain continues underneath.
5. After “…Which?”, Stay and Run have separate lead-ins to the same wolf encounter. The player remains off-screen.

## Design
Dark teal, charcoal, muted gold, pixel fonts, translucent dialogue panels, slow camera movement, and sparse sound. Motion reduction disables camera movement and softens the flash. Next reveals or advances text; Skip bypasses dialogue while retaining the Stay/Run decision. Sound controls affect all story audio.

## Recovery
Commit `af40c2e` preserves the complete project before cleanup, including retired integrations and combat experiments. Historical implementations can be recovered from Git. Main has since restored the server combat engine, glove controls, and debug labs described below; the story’s wolf encounter uses the local opponent implementation above.


## Combat and glove (in progress)
The round-based combat (telegraph, dodge, parry, team turn, Twin Cast, shared hearts), the glove controller and the debug labs are restored and being adapted to this story. See [combat-design.md](combat-design.md). The server engine runs the rounds (cast needs no spoken incantation) and the labs at `/debug` drive it. The combat UI will be rebuilt inside the story.
