# Story room server

Express and Socket.IO provide online room creation, joining, and presence. Rooms contain at most two players and exist in memory until their last player disconnects. Story dialogue advances locally in each browser. There is no combat engine or content-generation service.

Run `pnpm dev:server` from the repository root. `PORT` defaults to 3001; `CLIENT_ORIGIN` optionally limits allowed origins. The server reads process environment variables; it does not require keys or a local environment file.

Events: `story:create` accepts `{ name }`; `story:join` accepts `{ code, name }`. Success returns `story:joined`; presence updates use `story:room`; failures use `story:error`.

`GET /health` returns `{ ok: true }`. A production build is served from `client/dist`. Run `pnpm --filter @once-upon/server test` to test rooms and invalid requests.
