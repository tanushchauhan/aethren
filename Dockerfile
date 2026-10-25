# Aethren: one service (Express + Socket.IO + /mcp) that also serves the built client.
# Build:  docker build -t once-upon .
# Run:    docker run --rm -p 3001:3001 --env-file server/.env once-upon

# ---------------------------------------------------------------------------
# base: Node 22 + pnpm (version pinned by the root package.json "packageManager")
# ---------------------------------------------------------------------------
FROM node:22-slim AS base
# COREPACK_HOME is shared and owned by the runtime user, so `pnpm` also works for `node`
# (e.g. from the Coolify terminal) without downloading pnpm again.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate && chown -R node:node "$COREPACK_HOME"
WORKDIR /app

# Manifests only, so dependency layers are cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY client/package.json client/
COPY server/package.json server/

# ---------------------------------------------------------------------------
# build: full workspace install, then build the Vite client into client/dist
# ---------------------------------------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY client client
RUN pnpm --filter @once-upon/client build

# ---------------------------------------------------------------------------
# runtime: server deps only (incl. tsx, a server devDependency), TS source, built client
# ---------------------------------------------------------------------------
FROM base AS runtime
# curl for Coolify's UI health check, which probes from inside the container with curl/wget
# (node:22-slim ships neither). The image's own HEALTHCHECK below needs only node.
ARG INSTALL_CURL=true
RUN if [ "$INSTALL_CURL" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*; \
    fi
# Server + its workspace deps only; skips client-only packages (vite, mediapipe, tailwind).
# Runs before NODE_ENV=production is set, since that would make pnpm skip devDependencies (tsx).
RUN pnpm install --frozen-lockfile --filter "@once-upon/server..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY server server
# server/src/index.ts serves ../../client/dist, which resolves to /app/client/dist.
COPY --from=build /app/client/dist client/dist
# /app stays root-owned and read-only for the app user; tsx caches its transforms in /tmp.

ENV NODE_ENV=production \
    PORT=3001
USER node
WORKDIR /app/server
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Same as `pnpm --filter @once-upon/server start` (tsx src/index.ts), but runs tsx in-process
# so node is PID 1 and receives SIGTERM directly for a clean shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]
