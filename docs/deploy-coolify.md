# Deployment

Build the root Dockerfile and expose port 3001. The image serves the built client, the story room codes and the combat engine (Socket.IO) from the same origin. Configure the host to forward WebSocket upgrades.

Environment: `PORT=3001`; optionally set `CLIENT_ORIGIN` to the public site origin. No provider credentials or model services are needed. Health check: `GET /health`.

Locally, `pnpm install`, then `pnpm dev` starts the client and the server. `pnpm build`, `pnpm typecheck` and `pnpm test` validate the project.

Room state is temporary and cleared on server restart or when a room has been empty for 30 minutes.
