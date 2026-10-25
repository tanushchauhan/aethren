# Teammate 1 server handoff

The P0 server owns rooms, clock sync, opening picks, calibration and timed combat;
shared hearts, dodges/parries, elemental effects and Twin Cast; disconnect pause,
bot takeover and endings; chat extraction, world generation, ASR, images and voice;
the tool-calling boss and four authenticated MCP Quest Master tools.

## Local setup

Use Node 22 or newer and the pinned pnpm 10.33.4. From the repository root:

```powershell
npx pnpm@10.33.4 install --frozen-lockfile
# Only if server/.env does not already exist:
Copy-Item server/.env.example server/.env
npx pnpm@10.33.4 dev:server
```

Run `npx pnpm@10.33.4 dev` in a second terminal. The client is at
http://localhost:5173; server health is at http://localhost:3001/health.
This branch's client is a scaffold until Teammates 2 and 3 merge their work.
Vite proxies API and Socket.IO requests to port 3001. All secrets belong in
`server/.env`, which is ignored by Git. Restart the server after env changes.
Health flags indicate configured providers, not successful live requests.

## Verification

Run these from the repository root:

```powershell
npx pnpm@10.33.4 typecheck
npx pnpm@10.33.4 test
npx pnpm@10.33.4 build
npx pnpm@10.33.4 --filter @once-upon/server sim --offline
npx pnpm@10.33.4 --filter @once-upon/server check:live
npx pnpm@10.33.4 --filter @once-upon/server check:pipeline
npx pnpm@10.33.4 --filter @once-upon/server sim:boss
```

`sim --offline` starts its own ephemeral server with providers disabled for that
process, connects two synthetic laptops, plays through the boss, breaks the ward,
and reports the ending. It does not edit your env file.
The live checks use credits. `check:live --skip-image` omits image generation.
`check:pipeline` uses the synthetic Instagram fixture and a synthetic spoken WAV
to verify real memory extraction, live Quest Master calls, the HTTP transcription
route and phrase matching, and authenticated MCP discovery/status.
The WAV says "forty miles from anything", synthesized locally using Windows
System.Speech at 16 kHz mono PCM16; it contains no person's recording.
`sim:boss --fake` tests the planner's fallback without API calls.

### AI latency

Every AI step the server runs (Muse requests, world generation, card extraction, images,
speech-to-text, voice, narration, boss plans, Quest Master) is timed in memory. Read the
stats at `GET /api/metrics/ai` (counts and durations only, no content), clear them with
`POST /api/metrics/ai/reset` (dev, or bearer token in production), or watch the
**AI timings** panel in `/test-lab` → Providers & tools.

For repeatable numbers, run the benchmark from the repository root:

```powershell
npx pnpm@10.33.4 --filter @once-upon/server bench:ai                      # offline, free
npx pnpm@10.33.4 --filter @once-upon/server bench:ai --live               # prints the plan only
npx pnpm@10.33.4 --filter @once-upon/server bench:ai --live --yes         # real calls, uses credits
```

Options: `--runs=N`, `--only=world.generate,asr.transcribe`, `--json=bench.json`.
Live voice and image benchmarks run only when named, e.g.
`--live --yes --only=tts.synthesize,image.generate`.

The provider smoke check passed all six configured capabilities: structured JSON,
tool calling, ASR, Image, ElevenLabs narrator and boss. OpenAI is optional and was
not configured. A full live generated world passed strict schema validation.

## Client integration contract

- **Storybook client (`client/src/net`).** The merged game client speaks its own socket
  contract, and the server accepts it alongside the shared one. A socket that sends
  `room:create`, `room:join` (`code` or `roomCode`) or `room:quick_start` without an ack
  is a storybook socket: it gets `room:joined { playerId }`, then storybook-shaped
  `room:state` (`phase` per screen, `combatPhase`, `teamHearts`, `wardUp`, ...) on its own
  channel. `room:advance` maps onto `game:start` (lobby -> opening, opening -> generation)
  or calibration; `opening:select_card` / `opening:lock_boss` pick the encounter and boss
  cards; standing in the zone (`player:pose` with `inZone`) counts as calibrated. Every
  storybook player shows as a spellbearer. The translation lives in
  `src/engine/storybook.ts`; the engine stays authoritative.

- Send `player:cast.power` as fist charge multiplied by accelerometer power only.
  The server multiplies in the accepted incantation's power. Do not apply it twice.
- Upload push-to-talk audio to `/api/transcribe` as multipart `audio`, with
  `roomCode`, `playerId`, and `element`. For Muse, record or encode **WAV PCM16,
  mono, 16 kHz** (24 kHz also supported). Browser MediaRecorder WebM is not WAV;
  do not just rename its extension. The server has no transcoder. WebM requires
  the optional OpenAI fallback or conversion on the client.
- `transcriptOverride` is for development/simulation; production accepts it only
  with the MCP bearer token. Never give that token to browser clients.
- Drive countdowns from `phaseEndsServerMs` and attacks from
  `combat:telegraph.impactServerMs`, using clock sync to estimate server time.
- Render `narrator:line` for both `narrator` and `boss`, and update art on
  `world:image`. `/api/tts` returns MP3 or JSON requesting browser speech synthesis.
- `PlayerState.noiseLevel`, `PlayerState.gloveArmed`,
  `TranscribeRequestFields.transcriptOverride`, and `QuestChatRequest.hostName`
  are optional shared fields, compatible with older clients.
- The bot waits behind a ward and immediately copies a human's valid element,
  including casts at the end of a turn. After two unbroken ward rounds, a caption
  explains matching elements and the three-second Twin Cast window.

## Cached demo and provider details

The existing cached story now ships with three Muse-generated WebP images and
23 narration entries (20 unique ElevenLabs MP3 clips). They load at startup with
no network. Uncached speech falls back through providers to browser speech.
Refresh assets for the existing story with:

```powershell
npx pnpm@10.33.4 --filter @once-upon/server cache:demo
```

Muse supports only `tool_choice: "auto"`. The shared adapter uses minimal
reasoning and reserves 1024 additional output tokens because reasoning counts
toward the token limit. ASR uses multipart JSON `request` and WAV `audio` parts,
per https://dev.meta.ai/docs/api-reference/voice/transcribe.

## Deployment and remaining team integration

The root Dockerfile builds one Node service with the static client, API,
Socket.IO and `/mcp`. In Coolify, use the Dockerfile build, port 3001, `/health`,
a public HTTPS domain, and server environment variables. Set `PUBLIC_BASE_URL`
to that domain, `CLIENT_ORIGIN` to the frontend origin, and a strong
`MCP_BEARER_TOKEN`. Never bake `.env` into the image.

After deployment, use `/mcp` with Streamable HTTP and
`Authorization: Bearer <token>` in Muse; see `src/agents/README.md`.
Local authenticated MCP has been tested. This checkout has not been deployed
to Coolify or connected to the user's phone Muse account. Those checks require
the deployment destination and account access. Camera/glove/browser gameplay
and the final two-laptop rehearsal need the other teammates' client work.
