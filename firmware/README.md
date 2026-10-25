# Enchanted Glove firmware

Arduino **Uno R4 WiFi** (`arduino:renesas_uno:unor4wifi`) plus a **Grove Base Shield V2**, for the Spellbearer's glove and the table props in *Once Upon a Memory*. The sketch streams a `GloveSensorFrame` at 50 Hz and accepts `GloveCommand` lines back. Both shapes match `@once-upon/shared`.

The shield covers the board's 12×8 LED matrix. Wheel ticks, casts, fizzles, and hits come from the Grove buzzer. The storybook servo is the other output.

### Hackathon pinout (7 parts)

| Pin / bus | Part |
| --- | --- |
| **D3** | Touch sensor (parry) |
| **D4** | Button 1 (push-to-talk) |
| **D8** | Button 2 (lock / charge) |
| **D5** | Buzzer |
| **A0** | Rotary dial |
| **I2C** | 16×2 RGB LCD |
| **I2C** | 3-axis accelerometer (swipe / power) |

Wi-Fi joins **`WIFI_SSID = "iPhone"`** (password in the sketch). After upload, read the LCD or serial `wifi` line for the board IP, then on Laptop A:

```bash
node --experimental-strip-types firmware/serial-bridge.ts --udp <arduino-ip>
```

(or set `GLOVE_UDP_HOST`). The bridge sends `{"cmd":"hello"}` every 3s on UDP **4210**, rebroadcasts 50 Hz frames to `ws://127.0.0.1:8765`, and forwards browser commands back over UDP.

## Before you power it

1. Unplug USB.
2. On the Grove Base Shield V2, slide the **VCC switch to 5V**. It sits beside the analog sockets and is labeled `3.3V / 5V`. The Uno R4 WiFi is a 5V logic board. 3.3V undervolts every Grove module and the servo.
3. Seat the shield on the Uno headers. The matrix will be hidden. That is expected.
4. Plug Grove cables only after the switch is at 5V, then connect **USB-C to Laptop A**.

A small hobby servo can brown out the board if the storybook binds. If the port disconnects when the book moves, power the servo's 5V from a separate supply and tie the grounds together. Signal stays on D6.

## Port map

Any of the four I2C sockets are the same bus (`Wire` on A4/SDA and A5/SCL). The accelerometer and the color sensor can use any two of them.

| Socket | GPIO | Part | Where it sits | What the frame does |
| --- | --- | --- | --- | --- |
| A0 | A0 | Grove Rotary Angle Sensor | Forearm band | `0..1023` smoothed into spell-wheel slot `dial` `0`, `1`, or `2` |
| A1 | A1 | Grove Light Sensor | Palm | Covered by a closed fist → `"fist": true` |
| A2 | A2 | Grove Sound Sensor | Table by Laptop A | Peak-to-peak / envelope → `"noise": 0..1023` |
| D2 | D2 | Grove Button | Side of the index finger | Debounced `"btn": 0` or `1` (click to lock, hold to talk) |
| D3 | D3 | Grove Touch Sensor | Palm, under the thumb | Rising edge and hold → `"parry": true` or `false` |
| D4 | D4 | Grove Switch (slide) | Forearm band | `"armed": true` or `false` |
| D5 | D5 | Grove Buzzer (passive) | Forearm band | `tick`, `cast`, `fizzle`, `hit` |
| D6 | D6 | Grove Servo | Storybook on the table | `0°` closed, `110°` open |
| I2C | A4/A5 | Grove 3-axis accelerometer | Back of the hand | `"swipe"` and `"accel"` `1.00..1.50` |
| I2C | A4/A5 | Grove I2C Color Sensor (TCS34725) | Token well on the table | `"color"` token |

Active level on the Grove button, touch sensor, and switch is **HIGH**. Do not turn on the internal pull-ups; the modules drive the pin.

### Accelerometer

The sketch probes the bus itself, so the Arduino library manager is not required:

| Chip | Addresses | Who-am-I |
| --- | --- | --- |
| LIS3DHTR (preferred Grove module) | `0x19`, then `0x18` | register `0x0F` = `0x33` |
| ADXL345 | `0x53`, then `0x1D` | register `0x00` = `0xE5` |
| MMA7660FC | `0x4C` | mode register reads back as active |

LIS3DH is configured for ±8 g, 400 Hz, high resolution. ADXL345 is full-resolution ±16 g at 400 Hz. MMA7660 is only ±1.5 g, so a hard punch clips, but the direction still classifies. If nothing answers, the frame keeps streaming with `"swipe":"none"` and `"accel":1.00`.

Mount the board flat on the back of the hand, cable toward the wrist. `LATERAL_AXIS` / `LATERAL_SIGN` and `THRUST_AXIS` / `THRUST_SIGN` at the top of `enchanted_glove.ino` remap the chip axes:

- A swipe to the player's right should report `"swipe":"right"`. If it reports left, flip `LATERAL_SIGN` to `-1`.
- A punch toward the laptop should report `"thrust"`. If left/right comes out as thrust, swap the two axis numbers.

`accel` is not raw g. It is the spell-power multiplier: about `1.00` at rest, up to `1.50` on a fast swing (dynamic acceleration from `0.18 g` to `1.40 g` after gravity is removed).

### Color tokens

The color sensor is a TCS34721/TCS34725 (`ID 0x44`) or TCS34723/TCS34727 (`ID 0x4D`) at `0x29`. A different chip at that address (a VL53L0X, for example) is detected and then left alone.

| Token | `color` |
| --- | --- |
| Nothing in the well, or white/gray | `none` |
| Red or orange | `ember` |
| Blue or cyan | `frost` |
| Green | `bloom` |
| Purple or gold | `boss` |

Hold the token a few millimetres above the sensor. The label has to agree for four frames (~80 ms) before the field changes. If a gold token reads as ember, raise `GOLD_GREEN_TO_RED` slightly; if orange reads as boss, lower it.

### Arm / disarm

Slide the forearm switch off while talking to judges. The sketch silences the buzzer (local ticks and inbound melodies), and it forces `btn` to `0`, `fist` to `false`, `swipe` to `"none"`, and `parry` to `false`. A button or fist that was already held does not become active again until it is released and pressed after the switch is armed.

`dial`, `accel`, `noise`, `color`, and `armed` keep streaming so Laptop A can still show that the glove is alive. `{"cmd":"calibrate"}` and `{"cmd":"servo",...}` still run. Servo motion is an explicit command, not a finger accident.

## How the loop stays non-blocking

`loop()` never calls `delay()`. It polls the switch, button, touch, serial port, buzzer, and servo on every pass, and it publishes one sensor frame every `20 ms` (`SERIAL_BAUD` is `115200`, `GLOVE_POLL_HZ` is 50).

- **Dial.** Exponential moving average (`DIAL_ALPHA`) plus a hysteresis band around the 1/3 and 2/3 points of `0..1023`, so the slot does not chatter on the boundary. A slot change while armed starts the `tick` melody locally; the laptop does not have to round-trip it.
- **Fist.** Ambient light is sampled by `{"cmd":"calibrate"}` (and once at boot). A fist is a drop below 60% of that baseline, with a release margin. The baseline follows the room slowly, and only while the palm is open, so covering the sensor cannot drag the threshold down.
- **Noise.** Each frame burst-reads A2 fifty times. A midscale signal (the LM386 Grove Sound Sensor) reports peak-to-peak. A signal sitting near 0 V (a loudness/envelope module) reports the peak. An envelope follower attacks immediately and releases with `NOISE_RELEASE`. The laptop treats `450` and above as too loud (`NOISE_TOO_LOUD_THRESHOLD` in shared constants).
- **Buzzer.** A tiny state machine steps `tone(D5, freq)` from a note table. `hit` preempts `cast`, which preempts `fizzle`, which preempts `tick`. Rests are `noTone` steps. Nothing waits out the length of a note.
- **Servo.** Each 20 ms the horn moves at most 4° toward 0° or 110°. A full open is about half a second.
- **I2C.** Failed probes back off for one second. Eight bad reads in a row drop that device and the other fields keep publishing. Twelve bus failures re-init `Wire`.

The Uno R4 ADC is 14-bit unless told otherwise. `setup()` calls `analogReadResolution(10)` so the Grove readings stay in `0..1023`.

## Protocol

Outbound, one JSON object per line, 50 times a second:

```json
{"dial":1,"btn":1,"fist":true,"swipe":"thrust","accel":1.35,"parry":false,"armed":true,"noise":310,"color":"ember"}
```

Inbound, one JSON object per line. Key order does not matter. `ArduinoJson` is not used.

```json
{"cmd":"buzz","p":"tick"}
{"cmd":"buzz","p":"cast"}
{"cmd":"buzz","p":"fizzle"}
{"cmd":"buzz","p":"hit"}
{"cmd":"servo","open":true}
{"cmd":"servo","open":false}
{"cmd":"calibrate"}
```

`calibrate` re-samples the palm light with the hand **open** under demo lighting. Do that once when the glove is on, before the first fight.

There is no boot banner. Every line from the board is a frame, so a `JSON.parse` loop can drop anything that does not start with `{`.

## Compile and upload

From the repo root, with [arduino-cli](https://arduino.github.io/arduino-cli/). The Renesas core does not bundle `Servo.h`; install the official Arduino Servo library once (Arduino IDE 2.x: Library Manager → "Servo"). No Grove, Adafruit, or ArduinoJson libraries are used — the accelerometer and color sensor are raw `Wire` register reads.

```bash
arduino-cli core install arduino:renesas_uno
arduino-cli lib install Servo
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi firmware/enchanted_glove
arduino-cli upload -p /dev/ttyACM0 --fqbn arduino:renesas_uno:unor4wifi firmware/enchanted_glove
```

On macOS the port looks like `/dev/cu.usbmodem1101`. List ports with `arduino-cli board list`.

Arduino IDE 2.x works too: open `firmware/enchanted_glove/enchanted_glove.ino`, choose **Arduino Uno R4 WiFi**, install **Servo** if the IDE does not already list it, and upload.

### Serial monitor

```bash
arduino-cli monitor -p /dev/ttyACM0 -c baudrate=115200
```

You should see a frame about every 20 ms. With the monitor's send box (or any serial client; opening the port resets the board) send:

```text
{"cmd":"buzz","p":"cast"}
{"cmd":"servo","open":true}
{"cmd":"servo","open":false}
{"cmd":"calibrate"}
```

A cast arpeggio plays only while the forearm switch is armed. The storybook horn moves to 110° and back to 0° whether or not it is armed.

From a shell, if nothing else has the port open:

```bash
printf '%s\n' '{"cmd":"buzz","p":"tick"}' > /dev/ttyACM0
printf '%s\n' '{"cmd":"calibrate"}' > /dev/ttyACM0
```

## Serial bridge

Chrome and Edge on Laptop A should use the Web Serial API directly. `firmware/serial-bridge.ts` is the fallback for a browser that cannot: it copies the same JSON lines between the USB port and `ws://127.0.0.1:8765`. It has no npm dependencies. Node 22 runs it with type stripping.

```bash
node --experimental-strip-types firmware/serial-bridge.ts --list
node --experimental-strip-types firmware/serial-bridge.ts
node --experimental-strip-types firmware/serial-bridge.ts --port /dev/ttyACM0
node --experimental-strip-types firmware/serial-bridge.ts --simulate
node --experimental-strip-types firmware/serial-bridge.ts --udp 172.20.10.4
node --experimental-strip-types firmware/serial-bridge.ts --self-test
```

- No matching port (or `--simulate`): a 50 Hz scripted glove walks the dial, button, fist, parry, swipes, and all five color tokens. The simulated glove stays armed.
- **`--udp <ip>`** (or `GLOVE_UDP_HOST`): subscribe on UDP 4210 with periodic `hello`, stream frames to the WebSocket, send commands back over UDP.
- A real port: frames from the board are broadcast as WebSocket text messages. Text messages from the browser that are `buzz`, `servo`, or `calibrate` are written to the board with a newline.
- If the cable is pulled, the bridge logs it and falls back to the simulator so the page does not go silent.
- `EACCES` on `/dev/ttyACM0` means the user is not in `dialout`: `sudo usermod -aG dialout $USER`, then log in again.

`firmware/package.json` only exists so `npm install` and `npm run typecheck` work inside `firmware/`. The sketch does not use it. This folder is not in the pnpm workspace.

## Tuning

All of these are named constants at the top of `enchanted_glove.ino`.

| Constant | If the demo misbehaves |
| --- | --- |
| `DIAL_HYST` | Slot flickers on a boundary: raise it. Slot feels late: lower it. |
| `FIST_RATIO` | Fist never engages: raise it (for example `0.70`). Fist sticks on: lower it, then calibrate with the palm open. |
| `GESTURE_ON_G` | Swipes missed: lower toward `0.35`. Swipes at rest: raise toward `0.70`. |
| `LATERAL_SIGN`, `THRUST_AXIS` | Direction is mirrored or a swipe reports as thrust. |
| `GOLD_GREEN_TO_RED` | Gold and orange trade places. |
| `COLOR_CLEAR_MIN` | Empty well reports a color: raise it. A token reports `none`: lower it. |
| `SERVO_OPEN_DEG` | The book does not open far enough, or the horn stalls past the hinge. |
