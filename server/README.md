# Server

One Node service (Express + Socket.IO) that serves the built client, the story room codes (`story:*` events) and the authoritative combat engine.

- `src/index.ts`: entrypoint. `pnpm --filter @aethren/server start` runs it.
- `src/storyServer.ts`: story-only entrypoint (room codes, no combat engine).
- `src/engine/`: rooms, seats, the round loop (telegraph, defense, return, team turn, resolve), Twin Cast, hearts, bots and disconnect pause. It speaks the shared contract in `packages/shared`.
- `src/content/demo-world.json`: the bundled encounter and boss. The boss follows a scripted attack cycle (`scriptedPlan`), and narration uses prewritten lines (`engine/narration.ts`).

Casting needs no spoken incantation: a cast is accepted during the team turn, with power from the glove's fist charge and swipe speed.

`PORT` (default 3001) and `CLIENT_ORIGIN` (comma-separated, default any) are the only settings. Health check: `GET /health`.
