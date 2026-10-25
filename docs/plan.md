# Once in a Memory

## Current scope
An authored fantasy visual novel with a rainy forest title, singleplayer or online room setup, a scripted rift introduction, Stay/Run choices, and a first-person wolf encounter.

After the wolf encounter dialogue, the scene fades into a forest battleground with three wolves and a yellow player HUD. Shared player state exposes Health, Magic Power, and Stance to other modules. Stance controls retaliation readiness. A diagnostic attack button records input requests without damage or resource costs. The story screen no longer runs a turn loop; glove-driven spells and attacks will be defined next. The existing opponent move engine and supplied videos remain available for later integration. See [Combat](combat.md) for player state, opponent definitions, and current scope.

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
