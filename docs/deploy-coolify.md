# Deploy on Coolify

One service runs everything: Express, Socket.IO, the MCP Quest Master at `/mcp`, and the built
client. It builds from the root `Dockerfile`, listens on port **3001**, and reports health at
**`/health`**.

## 1. Create the app

1. In Coolify, go to **+ New → Resource**, choose **Private Repository (with GitHub App)** (or
   **Public Repository**), and pick this repo and the branch to deploy.
2. Set **Build Pack** to **Dockerfile**. Base directory `/`, Dockerfile location `/Dockerfile`.
3. Set **Ports Exposes** to `3001`.
4. Under **Domains**, enter the domain with the scheme, for example `https://story.example.com`.
   Coolify's Traefik gets a Let's Encrypt certificate for it automatically. The domain's DNS A
   record must already point at the Coolify server.
5. Keep **one replica** (no scaling or rolling multi-instance deploys). Room state lives in
   memory, so two instances would split players across separate games.

WebSockets (Socket.IO) work through Coolify's Traefik proxy by default, with no extra labels.

## 2. Environment variables

Add these under **Environment Variables**, as runtime variables. Secrets don't need to be
available at build time, because the build only compiles the client. They mirror
`server/.env.example`.

**Required**

| Variable | Value |
| --- | --- |
| `MUSE_API_KEY` | Meta Model API key from dev.meta.ai |
| `MCP_BEARER_TOKEN` | A long random token (see below). The Muse connector sends it to `/mcp`. |
| `PUBLIC_BASE_URL` | The https domain, e.g. `https://story.example.com` (no trailing slash) |

**Optional** (blank or unset uses the defaults in `server/src/config.ts`)

| Variable | Default / effect |
| --- | --- |
| `CLIENT_ORIGIN` | Blank allows any origin. Set it to the domain to lock CORS down. |
| `PORT` | `3001` (set in the image). If you change it, change **Ports Exposes** to match. |
| `MUSE_BASE_URL` | `https://api.meta.ai/v1` |
| `MUSE_SPARK_MODEL` | `muse-spark-1.3` |
| `MUSE_TRANSCRIBE_MODEL` | `muse-voice-transcribe-1.0` |
| `MUSE_IMAGE_MODEL` | `muse-image-1.0` |
| `MUSE_TTS_MODEL`, `MUSE_TTS_VOICE` | Unset, so Muse TTS is off |
| `ELEVENLABS_API_KEY` | Unset skips ElevenLabs TTS |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` |
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` |
| `OPENAI_API_KEY` | Unset skips OpenAI TTS |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` |
| `OPENAI_TTS_VOICE` | `marin` |
| `USE_CACHED_WORLD` | `false`. `true` serves the cached demo world instead of calling Muse. |
| `AI_TIMEOUT_MS` | `12000` |

`NODE_ENV=production` is set in the image. After you change variables, **Redeploy** (or
**Restart**) so the container picks them up.

### Generate `MCP_BEARER_TOKEN`

Windows (PowerShell):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })
```

macOS / Linux: `openssl rand -hex 32`

## 3. Health check

Under **Healthcheck**, set path `/health`, port `3001`, scheme `http`. The image also has its own
Docker `HEALTHCHECK` on the same path, and includes `curl` for Coolify's probe.

## 4. Deploy and smoke test

Click **Deploy** and watch the build log. Then:

```bash
curl https://<domain>/health
```

The response should contain `"ok":true`, `"muse":true` once `MUSE_API_KEY` is set, and
`"mcpAuth":true` once `MCP_BEARER_TOKEN` is set. Open `https://<domain>/` to load the game.

## 5. Connect the Muse MCP connector

- URL: `https://<domain>/mcp`
- Header: `Authorization: Bearer <MCP_BEARER_TOKEN>`

## 6. Verify the live AI keys from the container

Open the app's **Terminal** tab in Coolify (it opens a shell inside the running container as the
`node` user), then run:

```bash
cd /app && pnpm --filter @once-upon/server exec tsx src/ai/live-check.ts
```

This calls the configured providers with the container's real environment and reports which keys
work. The script (`server/src/ai/live-check.ts`) has to be in the deployed commit.

## Local check with Docker

```bash
docker build -t once-upon .
docker run --rm -p 3001:3001 --env-file server/.env once-upon
curl http://localhost:3001/health
```
