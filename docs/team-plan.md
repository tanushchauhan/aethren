# Tech Stack & 3-Teammate Parallel Agent Plan

This document proposes the tech stack for **Once Upon a Memory** and divides the P0 implementation across **3 teammates**, structured so each teammate can run **3 parallel coding agents** on isolated task streams without merge conflicts.

---

## 1. Recommended Tech Stack

For an 18-hour build combining real-time multiplayer, browser computer vision, Arduino hardware over serial, an MCP server, and three Meta Muse models, **a single TypeScript monorepo (`pnpm` workspaces)** is the highest-leverage choice. Sharing one `shared/types.ts` contract across client and server allows parallel coding agents to build against identical types without integration drift.

### Core Stack

| Layer | Recommended Choice | Why It Fits P0 Best | Easy Swap / Alternative |
| --- | --- | --- | --- |
| **Monorepo & Language** | **TypeScript + `pnpm` workspaces** (`shared`, `server`, `client`, `firmware`) | Single language across frontend, backend, and MCP server; strict shared types prevent integration bugs across parallel agents. | `npm` workspaces |
| **Frontend (`client/`)** | **Vite + React 19 + TypeScript + Tailwind CSS** | Instant HMR, zero SSR friction with browser-only APIs (`navigator.mediaDevices`, `navigator.serial`, `AudioContext`, `HTMLCanvasElement`). | Next.js (SPA mode) |
| **State & Rendering** | **Zustand + HTML5 2D Canvas** | Zustand handles high-frequency socket updates cleanly outside React render loops; 2D Canvas renders mirrored webcam + glowing silhouettes + 15 fps teammate outlines at 60 fps. | PixiJS / Three.js (heavier than needed for 2D outlines) |
| **Computer Vision** | **`@mediapipe/tasks-vision` (`PoseLandmarker`)** | Runs locally in the browser on WebGL/WASM at 30 fps (lite/full model), outputs 33 normalized 3D landmarks, sends zero video over the network. | `@tensorflow-models/pose-detection` |
| **Audio & Voice Input** | **`MediaRecorder` (WebM/WAV) + Web Audio API (`AnalyserNode`)** | Push-to-talk captures clean audio clips for Muse Voice Transcribe in P0; `AnalyserNode` computes RMS loudness and autocorrelation pitch for P1 tone checks. | RecordRTC |
| **Hardware Bridge (Laptop A)** | **Web Serial API (`navigator.serial`) over USB-C + Optional Wi-Fi UDP/WebSocket (`WiFiS3`)** | Arduino Uno R4 WiFi connects over USB-C (`115200` baud) directly to Chrome/Edge via Web Serial for zero-latency demo reliability, while `WiFiS3` can optionally stream untethered over local hotspot/Wi-Fi. | Node `serialport` bridge or `WiFiS3` WebSocket client |
| **Hardware Firmware (`firmware/`)** | **Arduino Uno R4 WiFi (`arduino:renesas_uno:unor4wifi`) + Grove Base Shield V2 + Grove Libraries** | All 8 Grove sensors, buzzer, and servo plug directly into the Grove Base Shield V2 ports (`A0–A2`, `D2–D6`, and the 4 `I2C` ports on `Wire`), polling at 50 Hz in a non-blocking `millis()` loop. | Arduino CLI / PlatformIO / Arduino IDE 2.x |
| **Backend (`server/`)** | **Node.js + Express + Socket.IO + `tsx` + Zod** | Authoritative room state, sub-10ms clock sync (`ping`/`pong`), scheduled telegraphs, 15 Hz landmark relay, and REST endpoints (`/api/upload-chat`, `/api/transcribe`) on one port. | Fastify + native `ws` |
| **AI Integration** | **`openai` Node SDK (pointed at Meta Muse API base URL) + Zod Structured Outputs** | Meta's Model API supports OpenAI-compatible chat/completions, structured JSON schemas, tool calling (**Muse Spark**), audio transcription (**Muse Voice Transcribe**), and image generation (**Muse Image**). | Direct `fetch` REST wrapper |
| **Muse Connector (MCP)** | **`@modelcontextprotocol/sdk` (Streamable HTTP / SSE at `/mcp`)** | Exposes `list_memory_cards`, `create_quest`, `invite_player`, and `get_quest_status` on the same Express server with Bearer token auth so Muse on a phone can set up the quest. | FastMCP |
| **Narrator Voice (TTS)** | **Web Speech API (`speechSynthesis`) / Server TTS Audio routed to Google Home Mini** | Laptop A pairs with Google Home Mini as a Bluetooth speaker; Narrator lines play aloud while synced captions display on both laptops. | ElevenLabs / OpenAI TTS |
| **Hosting & Deployment** | **Render or Railway** (single Node service serving API + Socket.IO + static Vite build + `/mcp`) | Gives a public `https://` URL immediately for both laptops (bypassing venue client-isolation Wi-Fi) and for Meta's cloud Muse MCP connector. | Fly.io or local server + `cloudflared` tunnel |

---

## 2. Monorepo Layout & File Ownership (Zero Merge Conflicts)

Every teammate (and each of their parallel agents) owns dedicated folders. Only `packages/shared/src/types.ts` is shared, and it is locked first before spawning stream agents.

```text
once-upon-a-memory/
├── package.json
├── pnpm-workspace.yaml
├── packages/
│   └── shared/                      # Locked in Phase 0 (15 mins)
│       └── src/
│           ├── types.ts             # GameState, WorldSchema, SocketEvents, GloveFrame, PoseFrame
│           └── constants.ts         # Round timings, element rules, attack templates
├── server/                          # OWNED BY TEAMMATE 1
│   └── src/
│       ├── index.ts                 # Express + Socket.IO + MCP entrypoint
│       ├── engine/                  # [Agent 1A] Room state machine, clock sync, combat, Twin Cast, bot
│       ├── ai/                      # [Agent 1B] Chat filter, Muse Spark worldgen, Transcribe, Image, cache
│       └── agents/                  # [Agent 1C] Boss tool-calling agent + /mcp Quest Master server
├── client/                          # OWNED BY TEAMMATES 2 & 3
│   └── src/
│       ├── net/                     # [Agent 2A] Socket client, NTP clock sync, Zustand game store
│       ├── ui/                      # [Agent 2B] Lobby, Chat Upload, Memory Cards, Storybook Intro/Ending
│       ├── combat-ui/               # [Agent 2C] Battle HUD, Spell Wheel, Telegraphs, Push-to-Talk, Narrator
│       ├── vision/                  # [Agent 3A] MediaPipe Pose, silhouette calibration, dodge & gesture rules
│       └── hardware/                # [Agent 3C] Web Serial API manager + on-screen Glove Simulator
└── firmware/                        # OWNED BY TEAMMATE 3
    └── enchanted_glove/             # [Agent 3B] Arduino .ino sketch for 8 sensors + buzzer + servo
```

---

## 3. Phase 0: Lock the Shared Contract First (All 3 Teammates — 15 Mins)

Before launching parallel agents, initialize the workspace and commit `packages/shared/src/types.ts` with these core interfaces so every agent codes against the exact same contract:

- **`ServerToClientEvents` & `ClientToServerEvents`**:
  - `clock:ping` / `clock:pong` (`clientSendMs`, `serverRecvMs`)
  - `room:state` (`GameState` snapshot: phase, hearts, ward, players, current encounter/boss)
  - `combat:telegraph` (`attackType: 'low_sweep' | 'high_swing' | 'projectile'`, `targetPlayerIds`, `impactServerMs`, `windowMs`, `narratorHint`)
  - `player:pose` (`playerId`, `landmarks: NormalizedLandmark[]`, `inZone: boolean`)
  - `player:dodge_result` (`playerId`, `attackId`, `dodged: boolean`, `parried: boolean`, `serverTimestampMs`)
  - `player:cast` (`playerId`, `element: 'ember' | 'frost' | 'bloom'`, `gesture: 'swipe' | 'thrust'`, `transcript`, `power: number`, `serverTimestampMs`)
  - `hardware:event` (`dialSlot`, `buttonPressed`, `fistCharged`, `parryTriggered`, `colorToken`, `noiseLevel`, `armed`)
  - `hardware:command` (`type: 'buzz' | 'servo'`, `pattern?: 'tick' | 'cast' | 'fizzle' | 'hit'`, `servoOpen?: boolean`)

---

## 4. Work Division Across 3 Teammates & Parallel Agent Streams

Each teammate acts as an orchestrator running **3 parallel coding agents** on isolated directories.

---

### Teammate 1: Multiplayer Backend, Muse AI Pipeline & Agentic MCP
**Directory Ownership:** `server/` and `packages/shared/`

#### Agent 1A — Authoritative Multiplayer & Combat State Machine (`server/src/engine/`)
- **Scope:**
  - Room lifecycle (`createRoom`, 4-letter room codes, player join, quick-start mode).
  - Clock sync handler (`clock:ping` -> `clock:pong`) so clients compute `serverTimeOffsetMs`.
  - Combat round loop (`telegraph` [2s] -> `defense` [1.5s] -> `return` [3s] -> `team_turn` [8s] -> `resolve` [1.5s]).
  - Local dodge resolution collector + parry reflection damage.
  - Collaborative **Twin Cast** detector: checks if both players cast the same element within a `3000ms` server-timestamp window to shatter the boss's ward and deal 2x damage.
  - 5 shared team hearts (P0) and 10-second disconnect pause -> automated bot fallback for dropped laptop.
- **Testable independently via:** Vitest unit tests + a mock socket client script simulating 2 laptops.

#### Agent 1B — Muse AI Pipeline, Chat Filter & Cached World (`server/src/ai/`)
- **Scope:**
  - Instagram export parser (`POST /api/chat-upload`): strips media/links/system messages, keeps text messages from consented members, deletes raw upload immediately after extracting cards.
  - **Muse Spark** memory extractor: returns 3–5 `MemoryCard` objects (`id`, `quote`, `date`, `people`, `mood`, `color`).
  - **Muse Spark** world generator: takes chosen cards + player names and returns structured `WorldSchema` JSON (`title`, `intro`, `incantations`, `encounters`, `boss`) with Zod clamping/defaults.
  - **Muse Image** generator: fires 3 parallel calls (`cover`, `monster`, `boss`), streaming image URLs to the room as they resolve.
  - **Muse Voice Transcribe** (`POST /api/transcribe`): transcribes push-to-talk audio blob, performs 60% fuzzy word match against the active element's incantation phrase, and enforces the 3-attempt mercy rule (3rd try auto-passes at 0.5x power).
  - **Cached Demo World**: writes and loads `server/src/ai/cached-demo-world.json` (plus static fallback images) so a single flag or API timeout instantly serves a complete world.
- **Testable independently via:** CLI test runner hitting `/api/chat-upload` and `/api/transcribe` with sample JSON/audio fixtures.

#### Agent 1C — Boss Agent (Tool Calling) & Muse MCP Connector (`server/src/agents/`)
- **Scope:**
  - **Boss Agent**: runs asynchronously during each round, sending player dodge history, element usage, team hearts, and ward status to Muse Spark with 5 tools:
    - `choose_attack(pattern, targets)`
    - `adjust_timing(ms)` (clamped to `1000..2000`)
    - `raise_ward()` (boss only, once below 50% HP)
    - `taunt(line)` (max 120 chars)
    - `trigger_effect(name)` (`buzz` or `servo`)
  - Includes a strict deadline guard: if Muse Spark doesn't respond before the next round's telegraph, falls back to the enemy template's scripted attack cycle.
  - **MCP Server (`/mcp`)**: uses `@modelcontextprotocol/sdk` with Bearer token auth to expose:
    - `list_memory_cards`
    - `create_quest`
    - `invite_player`
    - `get_quest_status`
  - **In-App Quest Box Fallback (`POST /api/quest-chat`)**: takes a natural-language prompt ("Set up a quest for me and Dev, make it hard") and runs Muse Spark against those same 4 tools in case phone Muse connector access fails on venue Wi-Fi.
- **Testable independently via:** MCP Inspector (`npx @modelcontextprotocol/inspector`) and a standalone Boss Agent simulation script.

---

### Teammate 2: Storybook Frontend, Combat Stage HUD & Audio/Voice
**Directory Ownership:** `client/src/net/`, `client/src/ui/`, `client/src/combat-ui/`

#### Agent 2A — Network Client, Clock Sync & Game Store (`client/src/net/`)
- **Scope:**
  - Socket.IO client wrapper + Zustand store (`useGameStore`) holding synchronized `GameState`, teammate pose landmarks, and hardware status.
  - NTP-style clock sync loop (pings on join and every 10s, maintains rolling median `serverTimeOffsetMs`, exposes `getServerNow()`).
  - **Dev Mock Toolbar**: a floating debug panel allowing Teammate 2 and Teammate 3 to trigger fake `combat:telegraph`, `room:state`, and phase transitions locally before the server is wired up.
- **Testable independently via:** Opening two browser tabs and verifying synchronized countdown timers within <20ms.

#### Agent 2B — Opening, Memory Cards & Storybook Screens (`client/src/ui/`)
- **Scope:**
  - Fairy-tale themed landing screen: Create Room, Join Room (4-letter code), Role selector (`Spellbearer (Laptop A)` vs `Partner (Laptop B)`), and **Quick-Start Demo Button** (skips card selection to save 30s).
  - Instagram JSON upload dropzone + In-App Quest Master prompt box.
  - **Opening Memory Card Carousel**: displays 3–5 extracted memory cards with quote, date, mood, and color badge. Responds to Rotary Dial ticks (Spellbearer), Right-Arm Raise (Partner), and Color Sensor token well picks (sets the Boss memory).
  - **Storybook Intro & Happily Ever After Screens**: animated parchment book layout displaying Muse Image cover/boss art and synchronized Narrator captions.
- **Testable independently via:** Mock `MemoryCard[]` and `WorldSchema` fixtures in Storybook/Vite dev mode.

#### Agent 2C — Combat Stage HUD, Spell Wheel & Push-to-Talk Audio (`client/src/combat-ui/`)
- **Scope:**
  - **Shared Battle Stage**: renders enemy portrait (from Muse Image or placeholder), enemy HP bar, Boss Ward status & **Twin Cast Sync Meter** (fills when Player 1 casts, shatters when Player 2 casts within 3s), and 5 shared team hearts.
  - **Scheduled Telegraph Overlay**: huge directional sweep/duck/projectile warning arrows timed precisely against `getServerNow()` and `impactServerMs`.
  - **3-Element Spell Wheel (`Ember`, `Frost`, `Bloom`)**: rotates smoothly with rotary dial or arm-raise, displays the generated group-chat incantation phrase for the selected element, and shows fist-charge / out-of-position status.
  - **Push-to-Talk & Narrator Audio Engine**:
    - Captures mic audio ONLY while finger button (Laptop A) or `Spacebar` (Laptop B) is held; uploads blob to `/api/transcribe`.
    - Plays Narrator TTS lines (via Web Speech API / audio stream on Laptop A routed to Google Home Mini) and renders high-contrast captions on every screen.
    - Displays "Room Too Loud — Mic Gate Raised" banner when the Arduino sound sensor crosses threshold.
- **Testable independently via:** Dev Mock Toolbar triggering telegraphs, wheel rotations, and push-to-talk recordings.

---

### Teammate 3: Computer Vision (MediaPipe) & Enchanted Glove Hardware
**Directory Ownership:** `client/src/vision/`, `client/src/hardware/`, `firmware/`

#### Agent 3A — MediaPipe Pose Tracker, Silhouette Calibration & Gestures (`client/src/vision/`)
- **Scope:**
  - Webcam manager + `@mediapipe/tasks-vision` `PoseLandmarker` running at 30 fps (single-person mode, ignores small background bystanders).
  - **Mirrored Canvas Renderer**: draws the player's mirrored webcam feed, the central calibration zone box, the pulsing return-to-zone silhouette outline, and glowing 2D skeleton outlines of teammates (from 15 fps streamed landmarks).
  - **3-Second Calibration**: measures baseline standing shoulder height (`baselineShoulderY`) and shoulder width (`baselineShoulderWidth`).
  - **P0 Pose & Gesture Classifiers**:
    - `Side Step`: shoulders & hips exit the zone box horizontally -> dodges `low_sweep` / `projectile`.
    - `Duck`: shoulder midpoint drops below `baselineShoulderY + 0.18` -> dodges `high_swing`.
    - `In-Zone Check`: verifies player has returned inside the silhouette before `team_turn` starts (plays chime on snap-in).
    - `Arm Raise (Partner)`: right wrist above nose for 1s locks next spell wheel slot.
    - `Swipe / Thrust`: tracks wrist velocity over a 200ms rolling window to trigger spell release.
- **Testable independently via:** Dedicated `/vision-test` route in Vite showing live webcam, landmark overlay, zone box, and real-time classifier badges.

#### Agent 3B — Arduino Uno R4 WiFi + Grove Base Shield Firmware (`firmware/enchanted_glove/`)
- **Board & Shield Target:** **Arduino Uno R4 WiFi** (`arduino:renesas_uno:unor4wifi`) stacked with a **Grove Base Shield V2** (set the shield's VCC switch to **5V** to match the Uno R4 WiFi logic level; note that the shield covers the onboard 12x8 LED matrix, so all physical feedback goes through the Grove Buzzer and Servo).
- **Grove Base Shield V2 Port Map (Plug-and-Play 4-Pin Grove Cables):**
  - **Analog Ports:**
    - `A0`: **Grove Rotary Angle Sensor** (forearm band -> 10-bit `0..1023` mapped to spell wheel slot `0..2`)
    - `A1`: **Grove Light Sensor** (palm -> covered by closed fist while speaking = spell charge)
    - `A2`: **Grove Sound Sensor** (table by Laptop A -> room noise envelope for mic gate & warning)
  - **Digital Ports:**
    - `D2`: **Grove Button** (side of index finger -> click to lock element, hold with thumb for push-to-talk)
    - `D3`: **Grove Touch Sensor** (palm under thumb -> projectile parry)
    - `D4`: **Grove Switch (Slide/Toggle)** (forearm band -> master arm/disarm for glove, camera, and mic)
    - `D5`: **Grove Buzzer** (forearm band -> non-blocking tone patterns for `tick`, `cast`, `fizzle`, `hit`)
    - `D6`: **Grove Servo** (table prop storybook -> standard `Servo.h` sweeps from `0°` closed to `110°` open when boss ward shatters)
  - **I2C Ports (Grove Base Shield has 4 parallel `I2C` ports on `Wire`, all with distinct addresses):**
    - `I2C Port 1`: **Grove 3-Axis Digital Accelerometer** (back of hand -> confirms swipe/thrust & speed power multiplier `1.0..1.5`)
    - `I2C Port 2`: **Grove I2C Color Sensor** (table token well -> classifies Red/Blue/Green/Yellow token to pick Boss memory card)
- **Bi-Directional Newline-Delimited JSON Serial Protocol (`115200` baud over USB-C):**
  - Outbound (50 Hz): `{"dial":1,"btn":1,"fist":true,"swipe":"thrust","accel":1.35,"parry":false,"armed":true,"noise":310,"color":"ember"}`
  - Inbound: `{"cmd":"buzz","p":"cast"}` or `{"cmd":"servo","open":true}`
- **Testable independently via:** `arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi` and Arduino Serial Monitor at 115200 baud sending test JSON commands and verifying sensor readouts.

#### Agent 3C — Web Serial Bridge & Keyboard/UI Glove Simulator (`client/src/hardware/`)
- **Scope:**
  - **Web Serial Manager (`useGloveSerial`)**: connects to the Arduino directly from Chrome/Edge via `navigator.serial`, parses newline JSON frames, debounces rotary ticks, triggers push-to-talk on button hold, and dispatches `buzz` / `servo` commands when combat events fire.
  - **Fallback Local Serial-to-WS Script (`firmware/serial-bridge.ts`)**: 50-line Node script in case a browser doesn't support Web Serial.
  - **On-Screen & Keyboard Glove Simulator**:
    - Lets any developer or laptop test all Spellbearer hardware mechanics without the physical Arduino:
      - `1 / 2 / 3` or `[ / ]`: turn rotary dial & tick buzzer
      - `Hold E`: finger button push-to-talk
      - `Hold F`: cover palm light sensor (fist charge)
      - `Arrow Left / Right / Up`: accelerometer swipe / thrust with power slider
      - `Q`: thumb touch sensor parry
      - `C`: place color token in token well
      - `M`: toggle hardware arm/disarm switch
- **Testable independently via:** `/hardware-test` route in Vite testing both simulated keys and live Web Serial Arduino connection.

---

## 5. Execution Timeline & Integration Checkpoints (18-Hour Schedule)

| Milestone | Target Time | Integration Goal Across All 3 Teammates |
| --- | --- | --- |
| **M0: Repo & Shared Types** | **Next 15 mins** | Scaffold monorepo (`shared`, `server`, `client`, `firmware`), commit `shared/types.ts`, each teammate launches their 3 parallel agents. |
| **M1: Vertical Slices Live** | **By 9:00 PM Sat** | **T1:** Room creation, clock sync, 1 Spark JSON call, 1 Transcribe call, and `/mcp` test endpoint working.<br>**T2:** Two browsers join a room and render the same scheduled telegraph at the exact same server timestamp.<br>**T3:** Arduino streams dial/button/accel/touch/light JSON over Web Serial; MediaPipe tracks 1 player + zone dodge on Laptop A. |
| **M2: One Full Combat Round** | **By 1:00 AM Sun** | Connect T1 + T2 + T3: Telegraph -> Side-step / Duck / Parry -> Return to silhouette -> Spell wheel (dial on Laptop A, arm raise on Laptop B) -> Push-to-talk incantation check -> Swipe/Thrust release -> Damage resolves on both screens. |
| **M3: Full P0 Story Loop & Agents** | **By 5:00 AM Sun** | Instagram chat upload -> Memory card pick + Color sensor boss token -> World generation -> Boss tool-calling agent + Ward + Twin Cast shatter -> Servo opens prop book -> Muse phone MCP quest setup -> Google Home narration + captions. |
| **M4: Polish, Cache & Fallback** | **By 8:00 AM Sun** | Muse Image art integrated, `cached-demo-world.json` saved for offline/rate-limit safety, 10s disconnect bot takeover verified, full 2-laptop run under 4 minutes. |
| **M5: Rehearsal & Video** | **By 10:30 AM Sun** | Rehearse live run twice in the actual 2m x 2m demo spot, record the 2–3 minute demo video, submit to Devpost by 11:30 AM CST. |
