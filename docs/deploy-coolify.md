# Deployment

Build the root Dockerfile and expose port 3001. The image serves the built client and Socket.IO from the same origin. Configure the host to forward WebSocket upgrades.

Environment: `PORT=3001`; optionally set `CLIENT_ORIGIN` to the public site origin. No provider credentials or model services are needed. Health check: `GET /health`.

Locally, `pnpm install`, then `pnpm dev` starts client and room server. Singleplayer works without the room server. `pnpm build`, `pnpm typecheck`, and `pnpm test` validate the project.

Online room state is temporary and cleared on server restart or when its last player disconnects. Players advance the authored story independently. Combat is not included yet.
