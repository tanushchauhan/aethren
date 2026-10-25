# Enchanted Glove firmware

Arduino **Uno R4 WiFi** (`arduino:renesas_uno:unor4wifi`) plus a **Grove Base Shield V2**, for the Spellbearer's glove in *Once Upon a Memory*. The sketch streams a `GloveSensorFrame` at 50 Hz and accepts `GloveCommand` lines back. Both shapes match `@once-upon/shared` (`packages/shared/src/types.ts`).

The shield covers the board's 12×8 LED matrix. Feedback comes from the Grove buzzer and the forearm 16x2 RGB LCD.

## Before you power it

1. Unplug USB.
2. On the Grove Base Shield V2, slide the **VCC switch to 5V**. It sits beside the analog sockets and is labeled `3.3V / 5V`. The Uno R4 WiFi is a 5V logic board, and 3.3V undervolts the Grove modules and dims the LCD backlight.
3. Seat the shield on the Uno headers. The matrix will be hidden. That is expected.
4. Plug the Grove cables only after the switch is at 5V, then connect **USB-C to Laptop A**.

## Port map (7 parts)

| Socket | Part | Where it sits | What the frame does |
| --- | --- | --- | --- |
| **D3** | Grove Touch Sensor | Palm, under the thumb | Rising edge and hold → `"parry": true`, chirps |
| **D4** | Grove Button 1 | Side of the index finger | Held → `"btn": 1` (push-to-talk, the LCD shows `>> SPEAKING <<`) |
| **D8** | Grove Button 2 | Side of the middle finger | Press → `"btn2": 1` and locks the element under the dial; held 250 ms → `"fist": true` (1.25× charge) |
| **D5** | Grove Buzzer (passive) | Forearm band | Dial tick, press chirps, `cast` / `fizzle` / `hit` melodies |
| **A0** | Grove Rotary Angle Sensor | Forearm band | `0..1023` (`"rawDial"`) smoothed into spell-wheel slot `"dial"`: `0` Ember, `1` Frost, `2` Bloom |
| **I2C** | Grove 16x2 RGB LCD | Forearm band | Text at `0x3E`, RGB backlight at `0x62` (v4) or `0x30` (v5) |
| **I2C** | Grove 3-Axis Accelerometer | Back of the hand | `"swipe"` and `"accel"` `1.00..1.50` |

The four I2C sockets are the same bus (`Wire` on SDA/SCL), so the LCD and the accelerometer can use any two of them.

Active level on the touch sensor and both buttons is **HIGH**. Do not turn on the internal pull-ups; the modules drive the pin. `"d3"`, `"d4"`, and `"d8"` in the frame are the raw pin levels (not gated by arming), for wiring checks.

There is no arm switch, sound sensor, color sensor, or servo in this kit. The frame keeps `"noise":0` and `"color":"none"` so the shared type stays valid. Arming is the `arm` command, and the `servo` command shows `STORYBOOK OPENS` / `STORYBOOK SHUT` on the LCD.

### Accelerometer

The sketch probes the bus itself, so the Arduino library manager is not required:

| Chip | Addresses | Who-am-I |
| --- | --- | --- |
| LIS3DHTR (preferred Grove module) | `0x19`, then `0x18` | register `0x0F` = `0x33` |
| ADXL345 | `0x53`, then `0x1D` | register `0x00` = `0xE5` |
| MMA7660FC | `0x4C` | mode register reads back as active |

LIS3DH is configured for ±8 g, 400 Hz, high resolution. ADXL345 is full-resolution ±16 g at 400 Hz. MMA7660 is only ±1.5 g, so a hard punch clips, but the direction still classifies. If nothing answers, the frame keeps streaming with `"swipe":"none"` and `"accel":1.00`, and the sketch re-probes every second.

Mount the board flat on the back of the hand, cable toward the wrist. `LATERAL_AXIS` / `LATERAL_SIGN` and `THRUST_AXIS` / `THRUST_SIGN` at the top of `enchanted_glove.ino` remap the chip axes:

- A swipe to the player's right should report `"swipe":"right"`. If it reports left, flip `LATERAL_SIGN` to `-1`.
- A punch toward the laptop should report `"thrust"`. If left/right comes out as thrust, swap the two axis numbers.

`accel` is not raw g. It is the spell-power multiplier: about `1.00` at rest, up to `1.50` on a fast swing (dynamic acceleration from `0.18 g` to `1.40 g` after gravity is removed).

### Forearm LCD

Line 1 shows `WHEEL: EMBER` (or `LOCKED: EMBER *` after a D8 press), with the backlight in the element color. Line 2 shows, in priority order: `DISARMED`, `!! PARRY !!`, `>> SPEAKING <<`, the custom line 2, `SWIPE: LEFT!`, a Wi-Fi or storybook notice, `CHARGED 1.25x`, and then the `D4:TALK  D8:LOCK` hint.

A custom message from the laptop replaces line 1 and the idle part of line 2 for 4 seconds by default. Lines are 16 printable ASCII characters; anything else draws as `?`. The display refreshes at about 10 Hz and only rewrites rows that changed, so the accelerometer keeps the shared bus.

## Protocol

Both links carry the same JSON. On USB, each message is one line. On UDP, each message is one packet (a packet may hold several newline-separated commands).

Outbound, 50 times a second:

```json
{"dial":0,"btn":0,"btn2":0,"fist":false,"swipe":"none","accel":1.00,"parry":false,"armed":true,"noise":0,"color":"none","d3":0,"d4":0,"d8":0,"rawDial":512}
```

After a `wifi` command or a link change, USB serial also gets a status line. A parser that only wants frames can drop lines that have no `"dial"` key:

```json
{"event":"wifi","status":"connected","ssid":"iPhone","ip":"172.20.10.4","port":4210}
```

`status` is one of `off`, `joining`, `connected`, `failed`, `lost`, `no-module`, or `udp-failed`.

Inbound. Key order does not matter, and `ArduinoJson` is not used:

```json
{"cmd":"buzz","p":"tick"}
{"cmd":"buzz","p":"cast"}
{"cmd":"buzz","p":"fizzle"}
{"cmd":"buzz","p":"hit"}
{"cmd":"lcd","l1":"WARD SHATTERED!","l2":"TWIN CAST 2.0x","r":255,"g":215,"b":0}
{"cmd":"lcd","l1":"BOSS INCOMING","l2":"","ms":0}
{"cmd":"lcd"}
{"cmd":"wifi","ssid":"iPhone","pass":"..."}
{"cmd":"wifi"}
{"cmd":"arm","open":false}
{"cmd":"servo","open":true}
{"cmd":"hello"}
```

- `lcd`: `r`, `g`, `b` are optional (`0..255`, all three or none). `ms` is how long the message stays: the default is `4000`, and `0` keeps it until the next `lcd`. `{"cmd":"lcd"}` with no text or color clears it.
- `wifi`: with `ssid`, joins that network in the background. Without it, prints the status line and shows the IP on the LCD.
- `arm`: `false` silences the buzzer and forces `btn`, `btn2`, `fist`, `swipe`, and `parry` off. A button held while disarmed only counts again after it is released. `dial`, `accel`, `armed`, and the raw pins keep streaming.
- `hello`: UDP only. Any packet subscribes its sender to the frame stream; `hello` is just the empty one.

## USB serial

USB-C is always on at `115200` baud. Chrome and Edge on Laptop A can open it directly with Web Serial from `/debug/hardware`. On macOS the port looks like `/dev/cu.usbmodem1051DB2BD6802`. List ports with `arduino-cli board list`.

The baud rate matters on this board: the R4 WiFi's USB-C port is the ESP32-S3 bridging a real UART, not native USB. A reader left at the macOS default of 9600 gets about 5 garbage bytes per frame. macOS also resets the port settings when the last handle closes, so run `stty` while your reader holds the port open (the bridge does this).

```bash
arduino-cli monitor -p /dev/cu.usbmodem1051DB2BD6802 -c baudrate=115200
```

You should see a frame about every 20 ms. Type a command into the monitor's send box, or from a shell when nothing else has the port open:

```bash
printf '%s\n' '{"cmd":"buzz","p":"cast"}' > /dev/cu.usbmodem1051DB2BD6802
printf '%s\n' '{"cmd":"lcd","l1":"HELLO GLOVE","l2":"FROM LAPTOP A","r":0,"g":200,"b":255}' > /dev/cu.usbmodem1051DB2BD6802
```

## Wi-Fi UDP (port 4210)

The glove can stream over Wi-Fi so the USB cable only carries power.

1. **Give it a hotspot.** Either set `WIFI_SSID` / `WIFI_PASS` at the top of `enchanted_glove.ino` before you upload (the sketch currently joins a hotspot named `iPhone`), or send `{"cmd":"wifi","ssid":"...","pass":"..."}` over USB. The **Arduino Wi-Fi hotspot** card on `/debug/hardware` does this for you. Credentials sent over USB live in RAM, so send them again after a power cycle. The Uno R4 WiFi only joins 2.4 GHz networks; on an iPhone, turn on **Maximize Compatibility**.
2. **Read the IP.** Line 2 of the LCD shows it for 8 seconds after joining, and USB serial prints the `{"event":"wifi","status":"connected",...}` line. `{"cmd":"wifi"}` shows it again.
3. **Run the bridge on the same network:**

   ```bash
   node --experimental-strip-types firmware/serial-bridge.ts --udp 172.20.10.4
   ```

   Or, without the IP, let the bridge find the glove by its beacon:

   ```bash
   node --experimental-strip-types firmware/serial-bridge.ts --udp-listen
   ```

4. **Connect the page.** On `/debug/hardware`, choose **WS Bridge** (`ws://localhost:8765`).

How the link works: after joining, the board listens on UDP `4210`. Until a host talks to it, it broadcasts one frame per second to the subnet's broadcast address on port `4210` (that is what `--udp-listen` waits for). The first packet from a host (the bridge's `{"cmd":"hello"}`) makes that host the peer. The board then sends a frame on every change to the dial, buttons, parry, swipe, or power, and at least every 50 ms otherwise. The bridge repeats `hello` every 3 seconds because the board drops a peer after 6 seconds of silence.

Each UDP packet costs several AT round trips to the board's ESP32-S3 radio, so a frame over Wi-Fi takes 15–20 ms of loop time. USB frames still go out every 20 ms either way.

## Serial bridge

`firmware/serial-bridge.ts` copies the same JSON between the glove and `ws://127.0.0.1:8765`. It has no npm dependencies. Node 22+ runs it with type stripping.

```bash
node --experimental-strip-types firmware/serial-bridge.ts --list
node --experimental-strip-types firmware/serial-bridge.ts                      # first USB port, else the simulator
node --experimental-strip-types firmware/serial-bridge.ts --port /dev/cu.usbmodem1051DB2BD6802
node --experimental-strip-types firmware/serial-bridge.ts --udp 172.20.10.4    # Wi-Fi, by IP
node --experimental-strip-types firmware/serial-bridge.ts --udp-listen         # Wi-Fi, by beacon
node --experimental-strip-types firmware/serial-bridge.ts --simulate
node --experimental-strip-types firmware/serial-bridge.ts --self-test
```

- One link per run: `--port` or `--udp` / `--udp-listen`. `GLOVE_PORT` and `GLOVE_UDP_HOST` set the defaults; `--udp-port` changes `4210`.
- Frames from the board are broadcast as WebSocket text messages. Browser messages that are `buzz`, `lcd`, `wifi`, `arm`, `servo`, or `hello` are checked, then written to the board (USB with a newline, or one UDP packet). LCD text is cut to 16 printable characters before it leaves the laptop.
- With no matching port (or `--simulate`), a 50 Hz scripted glove walks the dial, both buttons, the charge, parry, and swipes.
- If the USB cable is pulled, the bridge logs it and falls back to the simulator so the page does not go silent. Over UDP it logs when frames stop and keeps saying `hello` until the glove comes back.
- `EACCES` on `/dev/ttyACM0` (Linux) means the user is not in `dialout`: `sudo usermod -aG dialout $USER`, then log in again.

`firmware/package.json` only exists so `npm install` and `npm run typecheck` work inside `firmware/`. The sketch does not use it. This folder is not in the pnpm workspace.

## Compile and upload

From the repo root, with [arduino-cli](https://arduino.github.io/arduino-cli/). No libraries are needed beyond the Renesas core: the accelerometer and LCD are raw `Wire` registers, and `WiFiS3` ships with the core.

```bash
arduino-cli core install arduino:renesas_uno
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi firmware/enchanted_glove
arduino-cli upload -p /dev/cu.usbmodem1051DB2BD6802 --fqbn arduino:renesas_uno:unor4wifi firmware/enchanted_glove
```

On Apple Silicon without Rosetta, the core's bundled `arm-none-eabi-gcc 7-2017q4` is an x86_64 binary and will not run. Install a native toolchain (`brew install --cask gcc-arm-embedded`, or Arm GNU Toolchain 13.x for `darwin-arm64`) and link its `bin/arm-none-eabi-*` into `~/Library/Arduino15/packages/arduino/tools/arm-none-eabi-gcc/7-2017q4/bin/`. Check with `file .../arm-none-eabi-g++`; it should say `arm64`.

Arduino IDE 2.x works too: open `firmware/enchanted_glove/enchanted_glove.ino`, choose **Arduino Uno R4 WiFi**, and upload.

## How the loop stays non-blocking

`loop()` never calls `delay()`. It polls the touch sensor, both buttons, USB serial, UDP, and the buzzer on every pass, and it publishes one sensor frame every `20 ms` (`GLOVE_POLL_HZ` is 50).

- **Dial.** Exponential moving average (`DIAL_ALPHA`) plus a hysteresis band around the 1/3 and 2/3 points of `0..1023`, so the slot does not chatter on the boundary. A slot change while armed plays `tick` locally; the laptop does not have to round-trip it.
- **Buttons.** 25 ms debounce. A D3 tap reads as parry for at least 80 ms so a 50 Hz reader cannot miss it.
- **Buzzer.** A small state machine steps `tone(D5, freq)` from a note table. `hit` preempts `cast`, which preempts `fizzle`, which preempts the press chirps, which preempt `tick`. Nothing waits out the length of a note.
- **LCD.** About 10 Hz, changed rows only. The one-time HD44780 init takes about 10 ms when the LCD is first detected.
- **Wi-Fi.** `WiFi.begin()` returns right away, and the join is polled every 500 ms with a 20 s timeout. A lost link rejoins on its own.
- **I2C.** Failed probes back off for one second. Eight bad accelerometer reads in a row drop it and re-probe. Twelve bus failures re-init `Wire`. An unplugged LCD is re-probed every 2 seconds.

The Uno R4 ADC is 14-bit unless told otherwise. `setup()` calls `analogReadResolution(10)` so the dial stays in `0..1023`.

## Tuning

All of these are named constants at the top of `enchanted_glove.ino`.

| Constant | If the demo misbehaves |
| --- | --- |
| `DIAL_HYST` | Slot flickers on a boundary: raise it. Slot feels late: lower it. |
| `CHARGE_HOLD_MS` | Charge comes on during a normal lock click: raise it. Charge feels slow: lower it. |
| `GESTURE_ON_G` | Swipes missed: lower toward `0.35`. Swipes at rest: raise toward `0.70`. |
| `LATERAL_SIGN`, `THRUST_AXIS` | Direction is mirrored or a swipe reports as thrust. |
| `LCD_MSG_MS` | Custom LCD messages vanish too soon or linger. |
| `UDP_HEARTBEAT_MS` | Wi-Fi frames feel laggy at rest (lower it) or the radio falls behind (raise it). |
