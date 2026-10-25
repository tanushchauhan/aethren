# Enchanted glove firmware (Wi-Fi sensor bring-up)

Arduino **Uno R4 WiFi** plus a **Grove Base Shield V2** (VCC switch at **5V**). The sketch is a plain sensor streamer: no game logic. Every glove joins the phone hotspot and sends its raw sensors over UDP to the **hub** on the laptop, and the laptop shows them at `/debug/hardware`.

## Setup

1. Copy `enchanted_glove/wifi_secrets.example.h` to `enchanted_glove/wifi_secrets.h` and fill in the hotspot name and password. The real file is gitignored.
2. Install the Arduino library **Grove - LCD RGB Backlight** (`rgb_lcd`) and the `arduino:renesas_uno` core.
3. Flash each glove with the script, one build per LCD:

```sh
./flash.sh v4          # glove 1, Grove LCD v4: readable text, green-only backlight
./flash.sh v2          # glove 2, Grove LCD v2: backlight colors, unreadable text
./flash.sh v4 3        # same build with another glove id
./flash.sh v2 2 compile  # build without flashing
```

Both builds are the same code. `GLOVE_ID` and `LCD_VARIANT` are compile flags (defaults at the top of the `.ino` if you flash from the Arduino IDE instead). Give every glove a different id.

4. On the laptop, join the same hotspot, then run the hub and the client:

```sh
pnpm --dir firmware hub          # receives the gloves (UDP :4211) and serves ws://localhost:8765
pnpm dev                          # then open http://localhost:5173/debug/hardware
pnpm --dir firmware hub:simulate  # two fake gloves, to try the page without hardware
```

## Port map

| Socket | Part | Reported as |
| --- | --- | --- |
| D3, D7 | Grove Touch Sensor (either socket) | `d3`, `d7` (1 = touched) |
| D4 | Button 1 | `d4` |
| D8 | Button 2 | `d8` |
| D5 | Buzzer | `beep` and `ident` commands |
| A0 | Rotary angle sensor | `dial`, 0 to 1023 |
| I2C | 3-axis accelerometer (LIS3DHTR, ADXL345 or MMA7660, auto-detected) | `ax`, `ay`, `az` in milli-g |
| I2C | 16x2 RGB LCD | status display |
| D2, D6, D9, A1 to A3 | Nothing (reported anyway) | `d2`, `d6`, `d9`, `a1`, `a2`, `a3`: a part that lights up here is plugged into the wrong socket |

## Finding where a part is plugged in

Open the **Wiring map** tab on `/debug/hardware`. It lists every Grove digital and analog socket with the part the firmware expects there, its live level, press count and time of last change, plus the I2C devices by name and the Wi-Fi, UDP and USB links. Press a button or touch a sensor and the header shows which pin changed (`Last input: D7 ...`). A part on an unused pin is highlighted, and a dial that only reaches about 700 of 1023 is flagged as a probable 3.3V shield supply.

## The display

Status shows in text on both builds. The v4 backlight is always green (its red and blue outputs are dead), so the text carries the state. On the v2 the text is unreadable, so the backlight color is the state:

| Backlight (v2) | Meaning |
| --- | --- |
| Orange | Joining Wi-Fi, or joined and waiting for the hub |
| Green | Wi-Fi up and the hub is receiving |
| Red | Wi-Fi failed or lost, or the accelerometer is missing |

While joining, line 1 reads `G<id> WIFI JOINING`. After a failure it shows the Wi-Fi status code and a retry countdown. Once connected it cycles every 3 s (or press button D4 to step to the next page):

1. IP address, glove id and LCD version, `HUB OK` or `NO HUB`
2. Hotspot name and RSSI
3. Accelerometer chip and X, Y, Z in centi-g
4. Raw input levels (`T` touch D3/D7, `B` button D4/D8), dial value and send rate

## Protocol

Frames are one JSON object per UDP packet, all integers, about 40 per second:

```
{"t":"f","id":1,"seq":42,"ms":12345,"ax":12,"ay":-20,"az":998,"d3":0,"d7":0,"d4":0,"d8":0,"dial":512,"rssi":-48,"d2":0,"d6":0,"d9":0,"a1":3,"a2":9,"a3":4}
```

Once a second an info packet carries the glove id, LCD version, firmware tag, IP, SSID, accelerometer chip, whether it sees the hub, uptime, send rate and the I2C address list.

Until a hub says hello, gloves broadcast to the subnet on port 4211. The hub replies `{"cmd":"hello"}` to each glove (port 4210) every 2 seconds, and the glove then sends straight to the hub. Commands, over UDP or USB serial at 115200 baud:

| Command | Effect |
| --- | --- |
| `{"cmd":"ident"}` | Beep and show `I AM GLOVE n` for 4 s |
| `{"cmd":"beep"}` | Short beep |
| `{"cmd":"lcd","l1":"..","l2":"..","r":255,"g":0,"b":0,"ms":4000}` | Custom message |
| `{"cmd":"i2c"}` | Rescan the I2C bus |

## Troubleshooting

- **Glove never appears:** the laptop must be on the same hotspot. A second glove with the same id shows a warning on the page.
- **Red or `WIFI FAILED`:** check the SSID and password in `wifi_secrets.h`, and that the hotspot is on compatible with 2.4 GHz (turn on "Maximize Compatibility" in the iPhone hotspot settings).
- **`NO HUB`:** the hub is not running, or the laptop firewall blocks UDP 4211.
