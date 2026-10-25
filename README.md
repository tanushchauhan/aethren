<p align="center">
  <img src="docs/readme/hero.jpg" alt="Aethren" width="100%">
</p>

<p align="center">
  <b>A pixel-art fantasy adventure you play with a homemade enchanted glove.</b><br>
  Turn the dial to pick a spell, weave it with button taps, swings and your own body,<br>
  fight a wolf pack and a ruined knight alone or with a friend, or face that friend in a real-time duel.
</p>

<p align="center">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646cff?style=flat-square&logo=vite&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Arduino" src="https://img.shields.io/badge/Arduino-Uno%20R4%20WiFi-00979d?style=flat-square&logo=arduino&logoColor=white">
  <img alt="MediaPipe" src="https://img.shields.io/badge/MediaPipe-Pose-ff6f00?style=flat-square">
  <img alt="Built at HackTX 2026" src="https://img.shields.io/badge/HackTX-2026-d9b45a?style=flat-square">
</p>

---

## Contents

- [The game](#the-game)
- [The enchanted glove](#the-enchanted-glove)
- [Casting a spell](#casting-a-spell)
- [Combat](#combat)
- [Co-op on two screens](#co-op-on-two-screens)
- [Duel mode (PvP)](#duel-mode-pvp)
- [How it fits together](#how-it-fits-together)
- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Debug labs](#debug-labs)

---

## The game

A rift of light splits a rainy forest at night, and a child steps out of it. Two hooded figures watch from the trees. One whispers *run, little shadow*, and the other says *stay*. Whatever you choose, something in the bushes has already found you.

<table>
  <tr>
    <td width="50%"><img src="docs/readme/01-forest-awakening.jpg" alt="Two hooded figures stand over the child in a dark rainy forest"></td>
    <td width="50%"><img src="docs/readme/02-choose-your-path.jpg" alt="The Stay or Run choice"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>The Rift.</b> Authored visual-novel scenes with voices, rain and lightning.</sub></td>
    <td align="center"><sub><b>…Which?</b> Stay (B1) or Run (B2). Each path has its own lead-in.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/readme/03-wolf-emerges.jpg" alt="A wolf emerges from the undergrowth"></td>
    <td width="50%"><img src="docs/readme/07-forest-escape.jpg" alt="The child running through the forest toward a distant castle"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>The wolf emerges.</b> Then the pack attacks.</sub></td>
    <td align="center"><sub><b>The escape.</b> A sprint through the rain toward the castle.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/readme/08-castle-gate.jpg" alt="A deserted gothic castle gate in the rain"></td>
    <td width="50%"><img src="docs/readme/09-ruined-gatekeeper.jpg" alt="The Ruined Gatekeeper, an armored knight with a purple-flamed axe"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>The castle gate.</b> Deserted, until it isn't.</sub></td>
    <td align="center"><sub><b>The Ruined Gatekeeper.</b> "No one enters."</sub></td>
  </tr>
</table>

The whole adventure runs from start to finish:

<p align="center"><img src="docs/readme/journey.svg" alt="Story flow: Title, The Rift, the Stay or Run choice, Glove Training, Wolf Pack battle, Escape, At the Gate, and the Gatekeeper boss" width="100%"></p>

Every scene uses hand-authored dialogue, pixel art, video clips and sound: there is no runtime generation. Each speaker has their own color and pitch, and rain keeps falling underneath. **Hold B2** skips dialogue but still stops at the Stay/Run choice. A *Fast* pace option on the title screen multiplies your spell damage by 4, so each fight ends in a few casts for demos. Reduced-motion mode turns off camera shake and flashes.

---

## The enchanted glove

The controller is a glove we built from an **Arduino Uno R4 WiFi** and a **Grove Base Shield**. It has no game logic. It streams raw sensor readings over Wi-Fi about 40 times a second, and the browser turns them into presses, holds, dial turns and swings.

<p align="center"><img src="docs/readme/glove-controls.svg" alt="Glove controls: rotary dial, buttons B1 and B2, touch pad T, accelerometer, webcam pose, buzzer and RGB LCD" width="100%"></p>

- **Dial (A0).** Turns the 12-slot radial spell wheel and navigates every menu. The reading has hysteresis, so it doesn't flicker when it sits on a slot boundary.
- **B1, B2 and T.** Confirm, change element, switch target, rest and parry. Each is also a possible step in a spell ritual.
- **Accelerometer.** A swing over 1.85 g counts as a gesture. The firmware auto-detects LIS3DHTR, ADXL345 and MMA7660 chips, and the game classifies each swing as a *slash*, *thrust* or *shake*. A harder swing gives a stronger cast, up to ×1.45.
- **Buzzer.** Gives you haptic-style feedback, so you can feel the fight without looking at the screen:
  - `tick` when the dial lands on a new spell
  - a rising `cast` chirp when a spell leaves your hand
  - a falling `fizzle` when a cast is refused
  - two low thuds (`hit`) when an enemy wounds you
- **LCD.** Shows the glove's id, IP address, hub status and live sensor values. On the v2 screen, where the text is unreadable, the backlight color carries the status instead: orange while joining Wi-Fi, green when connected, red on a failure.

Every glove control has a keyboard fallback, so the game is fully playable without the hardware.

| Glove | Keyboard |
| --- | --- |
| Dial | ← → |
| B1 / B2 / T | 1 / 2 / 3 (T also on `T` or `Tab`) |
| Swing | Space |
| Raise arm (pose) | W |
| Cancel ritual | Esc |

---

## Casting a spell

There are **12 spells**, four each in **Fire**, **Frost** and **Storm**. You start the adventure knowing one spell per element. You discover the others by following the hints on the wheel and weaving their rituals correctly.

<p align="center"><img src="docs/readme/casting-loop.svg" alt="Casting loop: turn the dial, tap T to aim, press B1 to open the ritual, hit each timed step, release the spell. Each step has a timing bar with Early, Good, Perfect, Good and Late zones." width="100%"></p>

<table>
  <tr>
    <td width="50%"><img src="docs/readme/05-spell-wheel-battle.jpg" alt="The radial spell wheel in the wolf battle"></td>
    <td width="50%"><img src="docs/readme/06-spell-ritual.jpg" alt="The ritual stage showing Raise Arm, Press B1 and Swing Glove steps with a timing bar"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>The spell wheel.</b> Dial to choose, T to target, B1 to begin.</sub></td>
    <td align="center"><sub><b>The ritual.</b> Ember Bolt: raise your arm, press B1, swing.</sub></td>
  </tr>
</table>

Each spell has its own **ritual**: a sequence of two to five glove inputs and body poses, each with a four-second timing bar. Hitting a step in the gold zone is **Perfect** (×1.45). The grades of all the steps are averaged into the spell's final power.

| Element | Role | Spells |
| --- | --- | --- |
| 🔥 **Fire** | The most damage per Magic Power | Ember Bolt · Fire Lance (ignores armor) · Immolate (Burning) · Meteor (splash) |
| ❄️ **Frost** | Protects you and slows enemies | Frost Shard (Chilled) · Ice Shield · Frost Prison (Frozen) · Frost Nova (hits every enemy) |
| ⚡ **Storm** | Cheap, spreads damage, disrupts turns | Storm Spark · Chain Lightning · Static Shock (Drained) · Overcharge |

Every spell is charged in your hand first, with a pulsing aura, a turning sigil and element motes, before it flies. Fire Lance streaks through its target, Meteor falls from the sky, Frost Nova erupts in a ring of ice spikes, and Chain Lightning visibly jumps from wolf to wolf.

---

## Combat

<p align="center"><img src="docs/readme/04-glove-training.jpg" alt="Glove Training tutorial: Spin the Spell Wheel" width="70%"></p>

The first fight pauses for a **six-step Glove Training** tutorial: spin the wheel, change element, pick a target, weave a ritual, cast, and parry.

**Your turn.** Cast as many spells as your Magic Power allows, then end your turn. Hold B2 to **Rest**, which restores stance and 3 MP. Your HUD tracks:

- **Health**
- **Magic Power**, which regenerates 2 per turn
- **Stance**: *Balanced*, *Shaken*, *Casting*, *Guarding* or *Staggered*. While Staggered you can't cast.

**Their turn.** Enemies telegraph their moves. You defend in one of two ways:

- **With the glove.** Shake it or tap T/B2 to raise a *Glove Ward* parry.
- **With your body.** Turn on the webcam and the game projects a translucent outline of you, with impact rings over the parts of your body that are about to be hit. Dodge left or right, duck, or raise your wrist to block. Pose tracking runs on your machine with MediaPipe, and no camera pixels are shown or uploaded.

A correct dodge avoids the hit completely. A block cuts health damage to 25% and stops bleeding and curses.

### The wolf pack

Two **Stalkers** (40 HP) flank a **Pack Leader** (60 HP, armored). They **Roar** to power up, **Charge and Slash** to make you bleed, use **Jaw and Grab** to break your stance, and **Rest** to recover energy. Each move is a canvas-keyed video clip tied to the moment of impact.

### The Ruined Gatekeeper

<p align="center"><img src="docs/readme/10-gatekeeper-battle.jpg" alt="Battle against the Ruined Gatekeeper at the castle gate" width="100%"></p>

The final boss has **240 HP**, heavy armor and a purple flame aura.

- **Scorn Cleave** curses you with *Scorn*.
- **Eclipse of Scorn** stops your Magic Power regeneration.
- **Scorn Inferno**, his ultimate, sets the battlefield on fire for five turns.

His arrival shakes the camera with stone debris and shockwaves, and each of his axe hits leaves a jagged purple gash across the screen.

---

## Co-op on two screens

Two players, each with their own glove and laptop, can face the Gatekeeper together.

1. Each player plays the story and the wolf fight on their own screen.
2. At the castle gate, the game waits and announces itself on the glove hub. When a second screen does the same, the two pair up. *Fight alone* skips this.
3. The **host** runs the fight and sends numbered snapshots to the guest. The **guest** mirrors the fight and sends casts and parries back as intents.
4. Turns go host, then guest, then the Gatekeeper, who has **360 HP** in co-op. Scorn Cleave targets whoever has hurt him most since his last attack.
5. Each screen stays in first person: your spells leave your hand, and your partner's fly in from the right edge.

There is no extra server: the glove hub both laptops already use relays the co-op fight. If a partner disconnects, their turns are skipped until they come back.

---

## Duel mode (PvP)

Pick **Duel (PvP)** on the title screen to fight another player instead of fighting beside them. Duels are **real time**, with no turns. Each player stands in front of their own webcam, and both bodies appear in the arena as glowing silhouettes.

- **Aim with your hand.** The spell lands wherever your raised hand is when you cast. Its target zone glows on your rival's screen first, as a warning.
- **Dodge by moving.** A spell only hits if its zone touches your head, shoulders or hips when it lands. Step out of the circle before it lands and it misses.
- **Block by raising your right arm.** Your arm has to be up at least 280 ms before the impact, so a last-moment flinch doesn't count. Each block uses 40 of your 100 guard, which refills slowly. A big blast still pushes some damage through.

| Spell | Cost | Damage | Warning | Zone | Damage blocked |
| --- | --- | --- | --- | --- | --- |
| 🔥 Ember | 18 MP | 12 | 1.4 s | small | 70% |
| ⚡ Bolt | 30 MP | 15 | 0.85 s | smallest | 50% |
| ❄️ Frost | 28 MP | 18 | 1.9 s | medium | 60% |
| 🔮 Nova | 45 MP | 26 | 2.3 s | huge | 25% |

A quick, small spell is hard to see coming but easy to step out of. A slow, wide one is easy to read but hard to escape.

Each player has 100 health and 100 Magic Power, which refills at 14 per second. There's a short cooldown between casts.

**Controls.** Turn the dial or tap B2 to change spell, and press B1 or T to cast. On a keyboard, press 1–4 to pick a spell and Space or Enter to cast. Without a camera, the mouse moves your body and aim, and Shift holds your guard.

The duel finds its rival through the same glove hub as co-op, so both screens need to be connected to it. There is no host: each screen keeps track of its own health and decides whether the spells aimed at it hit, so a dodge never waits on the network. The caster's screen is then told the result. Both players calibrate by standing still with their arms down. A three-second countdown starts the fight, and both players have to agree before a rematch begins.

---

## How it fits together

<p align="center"><img src="docs/readme/architecture.svg" alt="Architecture: gloves send UDP to the glove hub, which bridges to the browser game over WebSocket and relays co-op; a story server serves the client and room codes" width="100%"></p>

| Piece | Tech | What it does |
| --- | --- | --- |
| **Firmware** (`firmware/enchanted_glove`) | Arduino C++ | Streams JSON sensor frames over UDP. Plays buzzer patterns without blocking. Shows status on the LCD. |
| **Glove hub** (`firmware/glove-hub.ts`) | Node, built-ins only | Bridges UDP :4211 to WebSocket :8765. Says hello to each glove, lets one player claim each glove, and relays co-op and duel messages. Nagle's algorithm is turned off to keep input latency low. |
| **Client** (`client/`) | React 19 · Vite · zustand · motion · MediaPipe | Runs the story, spell wheel, rituals, combat stores, VFX, audio, webcam defense and the debug labs. |
| **Server** (`server/`) | Express · Socket.IO | Serves the built client and four-letter room codes, and hosts the round-based combat engine used by the labs. |
| **Shared** (`packages/shared`) | TypeScript | The contract types and constants the client and server both use. |

---

## Getting started

**Requirements:** Node 22 or newer and pnpm 10. The glove hardware is optional.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` starts the client at <http://localhost:5173> and the server at port 3001. To play without gloves, use the keyboard controls above.

### With gloves

1. Copy `firmware/enchanted_glove/wifi_secrets.example.h` to `wifi_secrets.h` and fill in your hotspot's name and password.
2. Flash each glove with its own id. For example, `./flash.sh v4` for glove 1 and `./flash.sh v2 2` for glove 2.
3. Put the laptop on the same hotspot and start the hub:

```bash
pnpm --dir firmware hub
```

To try everything without hardware, run the hub with two simulated gloves:

```bash
pnpm --dir firmware hub:simulate
```

A second laptop joins the same hub by opening the game with `?hub=ws://<hub-computer-ip>:8765`. The hub prints the exact address when it starts. See [firmware/README.md](firmware/README.md) for the wiring, LCD states and troubleshooting.

### Build, test and deploy

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm demo
```

`pnpm demo` builds the client and serves it from the Node server. The root `Dockerfile` produces a single image that exposes port 3001, with a health check at `GET /health`. See [docs/deploy-coolify.md](docs/deploy-coolify.md) for deployment.

---

## Repository layout

```
.
├── client/                 React game (Vite)
│   ├── public/art/         Pixel art, enemy move videos, particles
│   ├── public/audio/       Music, ambience and sound effects
│   └── src/
│       ├── combat/         Spells, rituals, battle store, status effects, boss AI
│       ├── duel/           Real-time PvP duel arena and its spells
│       ├── glove/          Glove input tracking, combat and menu controls
│       ├── hardware/       Hub connection, glove simulator, wiring map
│       ├── vision/         MediaPipe pose service and pose classifiers
│       ├── net/            Co-op link, room store, asset prefetch
│       └── ui/             Story scenes, battle stages, HUD, VFX components
├── server/                 Express + Socket.IO, rooms and combat engine
├── packages/shared/        Shared types and constants
├── firmware/               Arduino sketch, flash script and glove hub
└── docs/                   Design notes and the combat reference
```

---

## Debug labs

Everything under `/debug` is a tool for developing and testing the game:

| Route | Lab |
| --- | --- |
| `/debug` | Command center |
| `/debug/hardware` | Live glove readings, a wiring map that shows which socket each part is plugged into, and a glove simulator |
| `/debug/vision` | Webcam pose tracking and classifier tests |
| `/debug/combined` | Glove and vision together |
| `/debug/audio` | Narrator voices and audio effects |
| `/debug/server` | Two simulated laptops playing against the real server |

In battle, the **Enable diagnostics** toggle lets you force spells to hit or miss, refill Magic Power, reset an encounter, or instantly defeat every enemy.

---

<p align="center"><sub>Built in a weekend for HackTX 2026. Spell particles by <a href="https://kenney.nl">Kenney</a>. Pixel fonts: Pixelify Sans, Silkscreen and VT323 (OFL).</sub></p>
