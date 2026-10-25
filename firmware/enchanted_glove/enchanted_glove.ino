/*
 * Once Upon a Memory: Enchanted Glove
 * Board:  Arduino Uno R4 WiFi (arduino:renesas_uno:unor4wifi)
 * Shield: Grove Base Shield V2, VCC switch at 5V.
 *
 * Grove wiring (7 parts):
 *   D3   Touch sensor     palm / thumb: parry an incoming projectile (chirps)
 *   D4   Button 1         hold for push-to-talk (chirps, LCD shows SPEAKING)
 *   D8   Button 2         click locks the element, hold charges the spell (fist)
 *   D5   Buzzer           dial tick, press chirps, cast / fizzle / hit melodies
 *   A0   Rotary angle     spell wheel: 0 EMBER, 1 FROST, 2 BLOOM
 *   I2C  3-axis accel     LIS3DHTR, ADXL345, or MMA7660 (auto-detected)
 *   I2C  16x2 LCD         text at 0x3E, RGB backlight at 0x62 (v4) or 0x30 (v5)
 *
 * Links: USB-C Serial at 115200 baud (always on), plus optional Wi-Fi UDP.
 * Outbound, one JSON line per frame (GloveSensorFrame in @once-upon/shared,
 * plus the raw pin states for debugging):
 *   {"dial":0,"btn":0,"btn2":0,"fist":false,"swipe":"none","accel":1.00,"parry":false,
 *    "armed":true,"noise":0,"color":"none","d3":0,"d4":0,"d8":0,"rawDial":512}
 * Inbound, one JSON object per line (Serial) or per packet (UDP):
 *   {"cmd":"buzz","p":"tick"|"cast"|"fizzle"|"hit"}
 *   {"cmd":"lcd","l1":"WARD SHATTERED!","l2":"TWIN CAST 2.0x","r":255,"g":215,"b":0}
 *       optional "ms": how long the message stays (default 4000, 0 = until replaced)
 *   {"cmd":"wifi","ssid":"...","pass":"..."}   without "ssid": report status, show IP
 *   {"cmd":"arm","open":true|false}
 *   {"cmd":"servo","open":true|false}          no servo is wired: shown on the LCD
 *   {"cmd":"hello"}                            UDP: subscribe this sender to frames
 *
 * No external libraries: the accelerometer and the LCD are raw Wire registers.
 * loop() never calls delay(); notes, the LCD, and Wi-Fi all advance from millis().
 *
 * Accelerometer mount: flat on the back of the hand, Grove cable toward the wrist.
 * If a swipe comes out mirrored, flip LATERAL_SIGN; if left/right reads as
 * thrust, swap LATERAL_AXIS and THRUST_AXIS.
 */

#include <Arduino.h>
#include <Wire.h>
#include <WiFiS3.h>
#include <WiFiUdp.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// --- Wi-Fi config -----------------------------------------------------------

const char WIFI_SSID[] = "iPhone";     // Hotspot SSID (can also be overridden via Serial {"cmd":"wifi","ssid":"...","pass":"..."})
const char WIFI_PASS[] = "zzzzzzzz";   // Hotspot password
const uint16_t UDP_PORT = 4210;  // Listens for commands on UDP 4210 and streams sensor JSON back to the sender

// --- Pins (Grove Base Shield V2) --------------------------------------------

const uint8_t touchPin = 3;
const uint8_t button1Pin = 4;
const uint8_t button2Pin = 8;
const uint8_t buzzerPin = 5;
const uint8_t dialPin = A0;

// --- Protocol (matches @once-upon/shared) -----------------------------------

const uint32_t SERIAL_BAUD = 115200;
const uint32_t FRAME_MS = 20;  // GLOVE_POLL_HZ = 50
const float ACCEL_POWER_MIN = 1.0f;
const float ACCEL_POWER_MAX = 1.5f;
const char *const ELEMENT_NAMES[3] = {"EMBER", "FROST", "BLOOM"};
const uint8_t ELEMENT_RGB[3][3] = {{255, 70, 0}, {30, 180, 255}, {40, 255, 110}};

// --- Tuning -----------------------------------------------------------------

const float DIAL_ALPHA = 0.22f;
const float DIAL_EDGE_01 = 341.0f;
const float DIAL_EDGE_12 = 682.0f;
const float DIAL_HYST = 36.0f;

const uint16_t DEBOUNCE_MS = 25;
const uint16_t PARRY_MIN_MS = 80;     // a tap still reads as parry for at least this long
const uint16_t CHARGE_HOLD_MS = 250;  // D8 held this long becomes "fist" (matches BUTTON_CLICK_MAX_MS)

const uint8_t GESTURE_WINDOW = 10;  // 200 ms at 50 Hz
const uint32_t GESTURE_HOLD_MS = 180;
const uint32_t ACCEL_SETTLE_MS = 300;
const float GESTURE_ON_G = 0.50f;
const float GESTURE_OFF_G = 0.25f;
const float GRAV_ALPHA = 0.03f;
const float DYN_G_FLOOR = 0.18f;  // dynamic g (gravity removed) mapped onto 1.00..1.50
const float DYN_G_CEIL = 1.40f;
const uint8_t LATERAL_AXIS = 0;  // 0 = X, 1 = Y, 2 = Z
const int8_t LATERAL_SIGN = 1;
const uint8_t THRUST_AXIS = 1;
const int8_t THRUST_SIGN = 1;

const uint8_t LCD_ADDR = 0x3E;
const uint8_t RGB_ADDR_V4 = 0x62;  // PCA9633
const uint8_t RGB_ADDR_V5 = 0x30;
const uint32_t LCD_REFRESH_MS = 100;  // ~10 Hz keeps the shared I2C bus free for the accelerometer
const uint32_t LCD_MSG_MS = 4000;
const uint32_t SWIPE_FLASH_MS = 600;
const uint32_t NOTICE_MS = 8000;  // Wi-Fi IP and storybook notices on line 2

// Every UDP packet is several AT round trips to the ESP32-S3 over a 115200 baud
// UART, so a full frame costs ~15-20 ms. Frames go out on every semantic change
// (button, parry, swipe, dial) and at least every UDP_HEARTBEAT_MS otherwise.
const uint32_t UDP_HEARTBEAT_MS = 50;
const uint32_t UDP_MIN_GAP_MS = 20;
const uint32_t UDP_POLL_MS = 20;
const uint32_t UDP_BEACON_MS = 1000;  // broadcast a frame until a host says hello
const uint32_t UDP_PEER_TIMEOUT_MS = 6000;
const uint32_t WIFI_JOIN_TIMEOUT_MS = 20000;

const uint8_t I2C_FAILS_BEFORE_DROP = 8;
const uint32_t I2C_RETRY_MS = 1000;
const float LIS3DH_G_PER_LSB = 0.00025f;  // ±8 g, high resolution
const float ADXL345_G_PER_LSB = 0.0039f;  // full resolution
const float MMA7660_G_PER_COUNT = 0.046875f;

// --- Buzzer songs -----------------------------------------------------------

struct Note {
  uint16_t hz;  // 0 = rest
  uint16_t ms;
};
struct Song {
  const Note *notes;
  uint8_t count;
  uint8_t prio;  // a song never cuts off one with a higher priority
};

const Note NOTES_TICK[] = {{1760, 30}};
const Note NOTES_TOUCH[] = {{1500, 70}};
const Note NOTES_TALK[] = {{1175, 45}};
const Note NOTES_LOCK[] = {{1568, 40}, {2093, 70}};
const Note NOTES_FIZZLE[] = {{466, 100}, {349, 100}, {262, 200}};
const Note NOTES_CAST[] = {{523, 80}, {659, 80}, {784, 80}, {1047, 160}};
const Note NOTES_HIT[] = {{932, 60}, {0, 40}, {932, 60}, {0, 40}, {1245, 120}};

#define SONG(notes, prio) {notes, (uint8_t)(sizeof(notes) / sizeof(notes[0])), prio}
enum SongId : uint8_t { SONG_TICK, SONG_TOUCH, SONG_TALK, SONG_LOCK, SONG_FIZZLE, SONG_CAST, SONG_HIT };
const Song SONGS[] = {SONG(NOTES_TICK, 1),   SONG(NOTES_TOUCH, 2), SONG(NOTES_TALK, 2), SONG(NOTES_LOCK, 2),
                      SONG(NOTES_FIZZLE, 3), SONG(NOTES_CAST, 4),  SONG(NOTES_HIT, 5)};

// --- State ------------------------------------------------------------------

enum AccelKind : uint8_t { ACCEL_NONE, ACCEL_LIS3DH, ACCEL_ADXL345, ACCEL_MMA7660 };
enum GesturePhase : uint8_t { GESTURE_IDLE, GESTURE_HOLD, GESTURE_QUIET };
enum WifiPhase : uint8_t { WIFI_OFF, WIFI_JOINING, WIFI_UP };

struct Debounce {
  bool stable;
  bool lastRaw;
  uint32_t changedMs;
};

bool armed = true;
Debounce touchDb = {false, false, 0};
Debounce talkDb = {false, false, 0};
Debounce lockDb = {false, false, 0};
uint8_t rawD3 = 0, rawD4 = 0, rawD8 = 0;
bool parryHeld = false;
uint32_t parryUntil = 0;
bool talkHeld = false;
bool lockHeld = false;
uint32_t lockDownMs = 0;
int lockedSlot = -1;

bool dialReady = false;
float dialSmooth = 0.0f;
int dialSlot = 0;
int rawDial = 0;

const Song *playing = nullptr;
uint8_t noteIndex = 0;
uint32_t noteStartMs = 0;

AccelKind accelKind = ACCEL_NONE;
uint8_t accelAddr = 0;
uint8_t accelFails = 0;
uint8_t i2cFailStreak = 0;
uint32_t nextAccelProbeMs = 0;
bool gravReady = false;
float gravX = 0.0f, gravY = 0.0f, gravZ = 0.0f;
uint32_t accelReadyAt = 0;
float dynPeak = 0.0f;
float accelPower = ACCEL_POWER_MIN;
float latWindow[GESTURE_WINDOW];
float thrWindow[GESTURE_WINDOW];
uint8_t gestureCount = 0, gestureHead = 0;
GesturePhase gesturePhase = GESTURE_QUIET;
const char *latchedSwipe = "none";
uint32_t gestureHoldUntil = 0;
uint32_t swipeFlashUntil = 0;

bool lcdReady = false;
uint8_t rgbAddr = 0;
uint32_t nextLcdProbeMs = 100;  // the LCD controller needs ~50 ms after power-up
uint32_t lastLcdMs = 0;
char lcdShown[2][17];
int16_t rgbShown[3] = {-1, -1, -1};
bool customActive = false;
bool customSticky = false;
uint32_t customUntil = 0;
char customL1[17] = "";
char customL2[17] = "";
int16_t customRgb[3] = {-1, -1, -1};
char notice[17] = "";
uint32_t noticeUntil = 0;

WifiPhase wifiPhase = WIFI_OFF;
char wifiSsid[33] = "";
char wifiPass[64] = "";
uint32_t wifiPhaseMs = 0;
uint32_t nextWifiPollMs = 0;
WiFiUDP udp;
bool udpOpen = false;
IPAddress broadcastIp;
IPAddress peerIp;
uint16_t peerPort = 0;
uint32_t peerSeenMs = 0;
uint32_t lastUdpSendMs = 0;
uint32_t lastUdpSig = 0xFFFFFFFF;
uint32_t nextUdpPollMs = 0;
uint32_t nextBeaconMs = 0;

char serialLine[192];
uint8_t serialLen = 0;
bool serialOverflow = false;
char udpBuf[256];
char frameBuf[224];
uint32_t lastFrameMs = 0;

// --- Small helpers ----------------------------------------------------------

float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
bool before(uint32_t now, uint32_t deadline) { return (int32_t)(deadline - now) > 0; }
int16_t s16le(const uint8_t *p) { return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8)); }
float axisOf(float x, float y, float z, uint8_t axis) { return axis == 1 ? y : (axis == 2 ? z : x); }

// Returns true on the debounced rising edge.
bool debounceRise(Debounce *in, bool raw, uint32_t now) {
  if (raw != in->lastRaw) {
    in->lastRaw = raw;
    in->changedMs = now;
  }
  if ((uint32_t)(now - in->changedMs) < DEBOUNCE_MS || in->stable == raw) return false;
  in->stable = raw;
  return raw;
}

// Copy up to 16 printable ASCII characters and pad with spaces for the LCD.
void fitLine(char *out, const char *in) {
  uint8_t n = 0;
  while (in && in[n] && n < 16) {
    char c = in[n];
    out[n++] = (c >= 32 && c <= 126) ? c : '?';
  }
  while (n < 16) out[n++] = ' ';
  out[16] = '\0';
}

void showNotice(const char *text, uint32_t now) {
  fitLine(notice, text);
  noticeUntil = now + NOTICE_MS;
}

// --- Buzzer -----------------------------------------------------------------

void stopSong() {
  if (playing) noTone(buzzerPin);
  playing = nullptr;
}

void startNote(uint32_t now) {
  if (!playing || noteIndex >= playing->count) {
    stopSong();
    return;
  }
  noteStartMs = now;
  uint16_t hz = playing->notes[noteIndex].hz;
  if (hz == 0) noTone(buzzerPin);
  else tone(buzzerPin, hz);
}

void playSong(SongId id) {
  if (!armed) return;
  const Song *song = &SONGS[id];
  if (playing && song->prio < playing->prio) return;
  playing = song;
  noteIndex = 0;
  startNote(millis());
}

void serviceBuzzer(uint32_t now) {
  if (!playing || (uint32_t)(now - noteStartMs) < playing->notes[noteIndex].ms) return;
  noteIndex++;
  startNote(now);
}

// --- Buttons, touch, dial ---------------------------------------------------

void setArmed(bool on) {
  armed = on;
  if (on) return;
  stopSong();
  parryHeld = talkHeld = lockHeld = false;
  parryUntil = 0;
  lockedSlot = -1;
}

void updateButtons(uint32_t now) {
  rawD3 = digitalRead(touchPin) == HIGH;
  rawD4 = digitalRead(button1Pin) == HIGH;
  rawD8 = digitalRead(button2Pin) == HIGH;
  bool touchRise = debounceRise(&touchDb, rawD3, now);
  bool talkRise = debounceRise(&talkDb, rawD4, now);
  bool lockRise = debounceRise(&lockDb, rawD8, now);
  if (!armed) return;  // a press that began while disarmed only counts after release

  if (touchRise) {
    parryHeld = true;
    parryUntil = now + PARRY_MIN_MS;
    playSong(SONG_TOUCH);
  }
  if (talkRise) {
    talkHeld = true;
    playSong(SONG_TALK);
  }
  if (lockRise) {
    lockHeld = true;
    lockDownMs = now;
    lockedSlot = dialSlot;
    playSong(SONG_LOCK);
  }
  if (!touchDb.stable) parryHeld = false;
  if (!talkDb.stable) talkHeld = false;
  if (!lockDb.stable) lockHeld = false;
}

bool parryActive(uint32_t now) { return armed && (parryHeld || before(now, parryUntil)); }
bool fistActive(uint32_t now) { return armed && lockHeld && (uint32_t)(now - lockDownMs) >= CHARGE_HOLD_MS; }

int nextDialSlot(int slot, float angle) {
  if (slot <= 0) return angle > DIAL_EDGE_01 + DIAL_HYST ? 1 : 0;
  if (slot >= 2) return angle < DIAL_EDGE_12 - DIAL_HYST ? 1 : 2;
  if (angle < DIAL_EDGE_01 - DIAL_HYST) return 0;
  if (angle > DIAL_EDGE_12 + DIAL_HYST) return 2;
  return 1;
}

void sampleDial() {
  rawDial = clampi(analogRead(dialPin), 0, 1023);
  if (!dialReady) {
    dialSmooth = (float)rawDial;
    dialSlot = rawDial < DIAL_EDGE_01 ? 0 : (rawDial < DIAL_EDGE_12 ? 1 : 2);
    dialReady = true;
    return;
  }
  dialSmooth += DIAL_ALPHA * ((float)rawDial - dialSmooth);
  int next = nextDialSlot(dialSlot, dialSmooth);
  if (next == dialSlot) return;
  dialSlot = next;
  playSong(SONG_TICK);
}

// --- I2C helpers ------------------------------------------------------------

void resetI2c() {
  Wire.end();
  Wire.begin();
  Wire.setClock(100000);
}

void noteI2cFail() {
  if (++i2cFailStreak < 12) return;
  i2cFailStreak = 0;
  resetI2c();
}

bool i2cAck(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool readRegs(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, len) != len) {
    while (Wire.available() > 0) Wire.read();
    return false;
  }
  for (uint8_t i = 0; i < len; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}

// --- Accelerometer ----------------------------------------------------------

void useAccel(AccelKind kind, uint8_t addr) {
  accelKind = kind;
  accelAddr = addr;
  accelFails = 0;
  gravReady = false;
  gestureCount = 0;
  gestureHead = 0;
  accelReadyAt = millis();
}

bool probeLis3dh(uint8_t addr) {
  uint8_t who = 0;
  if (!readRegs(addr, 0x0F, &who, 1) || who != 0x33) return false;
  // CTRL_REG4: BDU | ±8 g | high resolution. CTRL_REG1: 400 Hz, XYZ on.
  if (!writeReg(addr, 0x23, 0xA8) || !writeReg(addr, 0x20, 0x77)) return false;
  useAccel(ACCEL_LIS3DH, addr);
  return true;
}

bool probeAdxl345(uint8_t addr) {
  uint8_t id = 0;
  if (!readRegs(addr, 0x00, &id, 1) || id != 0xE5) return false;
  // Standby, full-res ±16 g, 400 Hz, measure.
  if (!writeReg(addr, 0x2D, 0x00) || !writeReg(addr, 0x31, 0x0B) || !writeReg(addr, 0x2C, 0x0C) ||
      !writeReg(addr, 0x2D, 0x08)) {
    return false;
  }
  useAccel(ACCEL_ADXL345, addr);
  return true;
}

bool probeMma7660(uint8_t addr) {
  uint8_t mode = 0;
  if (!i2cAck(addr)) return false;
  // Config registers only accept writes in standby; then go active at 120 Hz.
  if (!writeReg(addr, 0x07, 0x00) || !writeReg(addr, 0x08, 0x00) || !writeReg(addr, 0x07, 0x01)) return false;
  if (!readRegs(addr, 0x07, &mode, 1) || (mode & 0x01) == 0) return false;
  useAccel(ACCEL_MMA7660, addr);
  return true;
}

int8_t mmaDecode(uint8_t v, bool *alert) {
  if (v & 0x40) *alert = true;
  uint8_t raw = v & 0x3F;
  if (raw & 0x20) raw |= 0xC0;
  return (int8_t)raw;
}

// Returns 1 on a good sample, 0 to skip this frame, -1 on a bus failure.
int readAccelG(float *x, float *y, float *z) {
  uint8_t b[6];
  if (accelKind == ACCEL_LIS3DH || accelKind == ACCEL_ADXL345) {
    // 0x80 on the LIS3DH sub-address turns on register auto-increment.
    bool lis = accelKind == ACCEL_LIS3DH;
    if (!readRegs(accelAddr, lis ? (0x28 | 0x80) : 0x32, b, 6)) return -1;
    float k = lis ? LIS3DH_G_PER_LSB : ADXL345_G_PER_LSB;
    *x = s16le(b) * k;
    *y = s16le(b + 2) * k;
    *z = s16le(b + 4) * k;
    return 1;
  }
  if (!readRegs(accelAddr, 0x00, b, 3)) return -1;
  bool alert = false;
  *x = mmaDecode(b[0], &alert) * MMA7660_G_PER_COUNT;
  *y = mmaDecode(b[1], &alert) * MMA7660_G_PER_COUNT;
  *z = mmaDecode(b[2], &alert) * MMA7660_G_PER_COUNT;
  return alert ? 0 : 1;
}

void updateGesture(float lateral, float thrust, uint32_t now) {
  latWindow[gestureHead] = lateral;
  thrWindow[gestureHead] = thrust;
  gestureHead = (gestureHead + 1) % GESTURE_WINDOW;
  if (gestureCount < GESTURE_WINDOW) gestureCount++;

  float latPeak = 0.0f, thrPeak = 0.0f;
  for (uint8_t i = 0; i < gestureCount; i++) {
    if (fabsf(latWindow[i]) >= fabsf(latPeak)) latPeak = latWindow[i];
    if (fabsf(thrWindow[i]) >= fabsf(thrPeak)) thrPeak = thrWindow[i];
  }
  bool quiet = fabsf(latPeak) < GESTURE_OFF_G && fabsf(thrPeak) < GESTURE_OFF_G;

  if (gesturePhase == GESTURE_HOLD) {
    if (armed && before(now, gestureHoldUntil)) return;
    gesturePhase = GESTURE_QUIET;
  }
  if (gesturePhase == GESTURE_QUIET) {
    // Wait for the hand to settle (and the glove to be armed) before the next swipe.
    if (quiet && armed) gesturePhase = GESTURE_IDLE;
    return;
  }
  if (!armed) {
    gesturePhase = GESTURE_QUIET;
    return;
  }
  if (gestureCount < GESTURE_WINDOW || (uint32_t)(now - accelReadyAt) < ACCEL_SETTLE_MS) return;
  float latMag = fabsf(latPeak), thrMag = fabsf(thrPeak);
  if (latMag < GESTURE_ON_G && thrMag < GESTURE_ON_G) return;

  latchedSwipe = thrMag >= latMag ? "thrust" : (latPeak >= 0.0f ? "right" : "left");
  gesturePhase = GESTURE_HOLD;
  gestureHoldUntil = now + GESTURE_HOLD_MS;
  swipeFlashUntil = now + SWIPE_FLASH_MS;
}

void updateMotion(float ax, float ay, float az, uint32_t now) {
  if (!gravReady) {
    gravX = ax;
    gravY = ay;
    gravZ = az;
    gravReady = true;
    dynPeak = 0.0f;
    gesturePhase = GESTURE_QUIET;
    accelReadyAt = now;
    return;
  }
  gravX += GRAV_ALPHA * (ax - gravX);
  gravY += GRAV_ALPHA * (ay - gravY);
  gravZ += GRAV_ALPHA * (az - gravZ);
  float lx = ax - gravX, ly = ay - gravY, lz = az - gravZ;
  float dyn = sqrtf(lx * lx + ly * ly + lz * lz);
  updateGesture(LATERAL_SIGN * axisOf(lx, ly, lz, LATERAL_AXIS), THRUST_SIGN * axisOf(lx, ly, lz, THRUST_AXIS), now);

  if ((uint32_t)(now - accelReadyAt) < ACCEL_SETTLE_MS) dynPeak = 0.0f;
  else if (dyn > dynPeak) dynPeak = dyn;
  else if (gesturePhase != GESTURE_HOLD) dynPeak = dynPeak < 0.01f ? 0.0f : dynPeak * 0.85f;
  float t = clampf((dynPeak - DYN_G_FLOOR) / (DYN_G_CEIL - DYN_G_FLOOR), 0.0f, 1.0f);
  accelPower = ACCEL_POWER_MIN + (ACCEL_POWER_MAX - ACCEL_POWER_MIN) * t;
}

void sampleAccel(uint32_t now) {
  if (accelKind == ACCEL_NONE) {
    accelPower = ACCEL_POWER_MIN;
    if (before(now, nextAccelProbeMs)) return;
    nextAccelProbeMs = now + I2C_RETRY_MS;
    if (probeLis3dh(0x19) || probeLis3dh(0x18) || probeAdxl345(0x53) || probeAdxl345(0x1D) || probeMma7660(0x4C)) return;
    noteI2cFail();
    return;
  }
  float ax, ay, az;
  int result = readAccelG(&ax, &ay, &az);
  if (result == 0) return;
  if (result < 0) {
    noteI2cFail();
    if (++accelFails >= I2C_FAILS_BEFORE_DROP) {
      accelKind = ACCEL_NONE;
      gesturePhase = GESTURE_QUIET;
      nextAccelProbeMs = now + 300;
    }
    return;
  }
  accelFails = 0;
  i2cFailStreak = 0;
  updateMotion(ax, ay, az, now);
}

const char *publishedSwipe() {
  if (!armed || accelKind == ACCEL_NONE || gesturePhase != GESTURE_HOLD) return "none";
  return latchedSwipe;
}

const char *swipeLabel() {
  if (latchedSwipe[0] == 't') return "THRUST";
  return latchedSwipe[0] == 'l' ? "LEFT" : "RIGHT";
}

// --- 16x2 LCD (AIP31068L text + PCA9633 / v5 RGB) ---------------------------

bool lcdCommand(uint8_t cmd) {
  Wire.beginTransmission(LCD_ADDR);
  Wire.write(0x80);  // control byte: command
  Wire.write(cmd);
  return Wire.endTransmission() == 0;
}

bool lcdWriteRow(uint8_t row, const char *text) {
  if (!lcdCommand(row == 0 ? 0x80 : 0xC0)) return false;  // DDRAM address 0x00 / 0x40
  Wire.beginTransmission(LCD_ADDR);
  Wire.write(0x40);  // control byte: the rest of the transfer is character data
  Wire.write((const uint8_t *)text, 16);
  return Wire.endTransmission() == 0;
}

bool lcdSetRgb(uint8_t r, uint8_t g, uint8_t b) {
  if (rgbAddr == RGB_ADDR_V5) return writeReg(rgbAddr, 0x06, r) && writeReg(rgbAddr, 0x07, g) && writeReg(rgbAddr, 0x08, b);
  return writeReg(rgbAddr, 0x04, r) && writeReg(rgbAddr, 0x03, g) && writeReg(rgbAddr, 0x02, b);
}

void probeLcd(uint32_t now) {
  if (before(now, nextLcdProbeMs)) return;
  nextLcdProbeMs = now + 2000;
  if (!i2cAck(LCD_ADDR)) return;
  // HD44780 init: function set 2-line x3 with settle time (about 10 ms, once per
  // detection), then display on, clear, and left-to-right entry.
  for (uint8_t i = 0; i < 3; i++) {
    if (!lcdCommand(0x28)) return;
    delayMicroseconds(i == 0 ? 4500 : 150);
  }
  if (!lcdCommand(0x28) || !lcdCommand(0x0C) || !lcdCommand(0x01)) return;
  delayMicroseconds(2000);
  if (!lcdCommand(0x06)) return;

  rgbAddr = 0;
  if (i2cAck(RGB_ADDR_V4)) {
    // MODE1 normal, LEDOUT = PWM + group control, MODE2 = group blink (always on).
    if (writeReg(RGB_ADDR_V4, 0x00, 0x00) && writeReg(RGB_ADDR_V4, 0x08, 0xFF) && writeReg(RGB_ADDR_V4, 0x01, 0x20)) {
      rgbAddr = RGB_ADDR_V4;
    }
  } else if (i2cAck(RGB_ADDR_V5)) {
    writeReg(RGB_ADDR_V5, 0x00, 0x07);  // reset
    delayMicroseconds(200);
    if (writeReg(RGB_ADDR_V5, 0x04, 0x15)) rgbAddr = RGB_ADDR_V5;  // all channels always on
  }
  memset(lcdShown, 0, sizeof(lcdShown));
  rgbShown[0] = rgbShown[1] = rgbShown[2] = -1;
  lcdReady = true;
}

void composeLcd(uint32_t now, char *l1, char *l2, uint8_t *rgb) {
  if (customActive && !customSticky && !before(now, customUntil)) customActive = false;
  char text[17];
  const char *name = ELEMENT_NAMES[dialSlot];

  if (customActive && customL1[0]) snprintf(text, sizeof(text), "%s", customL1);
  else if (armed && lockedSlot == dialSlot) snprintf(text, sizeof(text), "LOCKED: %s *", name);
  else snprintf(text, sizeof(text), "WHEEL: %s", name);
  fitLine(l1, text);

  if (!armed) snprintf(text, sizeof(text), "DISARMED");
  else if (parryActive(now)) snprintf(text, sizeof(text), "!! PARRY !!");
  else if (talkHeld) snprintf(text, sizeof(text), ">> SPEAKING <<");
  else if (customActive && customL2[0]) snprintf(text, sizeof(text), "%s", customL2);
  else if (before(now, swipeFlashUntil)) snprintf(text, sizeof(text), "SWIPE: %s!", swipeLabel());
  else if (notice[0] && before(now, noticeUntil)) snprintf(text, sizeof(text), "%s", notice);
  else if (fistActive(now)) snprintf(text, sizeof(text), "CHARGED 1.25x");
  else snprintf(text, sizeof(text), "D4:TALK  D8:LOCK");
  fitLine(l2, text);

  for (uint8_t i = 0; i < 3; i++) {
    if (customActive && customRgb[0] >= 0) rgb[i] = (uint8_t)customRgb[i];
    else if (!armed) rgb[i] = 40;
    else rgb[i] = ELEMENT_RGB[dialSlot][i];
  }
}

void serviceLcd(uint32_t now) {
  if (!lcdReady) {
    probeLcd(now);
    return;
  }
  if ((uint32_t)(now - lastLcdMs) < LCD_REFRESH_MS) return;
  lastLcdMs = now;
  char lines[2][17];
  uint8_t rgb[3];
  composeLcd(now, lines[0], lines[1], rgb);
  bool ok = true;
  for (uint8_t row = 0; row < 2 && ok; row++) {
    if (strcmp(lines[row], lcdShown[row]) == 0) continue;
    ok = lcdWriteRow(row, lines[row]);
    if (ok) memcpy(lcdShown[row], lines[row], 17);
  }
  if (ok && rgbAddr && (rgb[0] != rgbShown[0] || rgb[1] != rgbShown[1] || rgb[2] != rgbShown[2])) {
    ok = lcdSetRgb(rgb[0], rgb[1], rgb[2]);
    for (uint8_t i = 0; ok && i < 3; i++) rgbShown[i] = rgb[i];
  }
  if (!ok) lcdReady = false;  // unplugged: re-probe every 2 s
}

// --- Inbound JSON (no ArduinoJson) ------------------------------------------

bool findValue(const char *json, const char *key, const char **value) {
  size_t keyLen = strlen(key);
  for (const char *p = json; *p; p++) {
    if (*p != '"' || strncmp(p + 1, key, keyLen) != 0 || p[1 + keyLen] != '"') continue;
    const char *q = p + keyLen + 2;
    while (*q == ' ' || *q == '\t') q++;
    if (*q != ':') continue;
    q++;
    while (*q == ' ' || *q == '\t') q++;
    *value = q;
    return true;
  }
  return false;
}

// Over-long values are truncated to fit. Escapes keep the escaped character.
bool extractString(const char *json, const char *key, char *out, size_t cap) {
  const char *v = nullptr;
  if (!findValue(json, key, &v) || *v != '"') return false;
  size_t n = 0;
  for (v++; *v && *v != '"'; v++) {
    if (*v == '\\' && v[1]) v++;
    if (n + 1 < cap) out[n++] = *v;
  }
  out[n] = '\0';
  return *v == '"';
}

bool extractBool(const char *json, const char *key, bool *out) {
  const char *v = nullptr;
  if (!findValue(json, key, &v)) return false;
  if (strncmp(v, "true", 4) == 0) *out = true;
  else if (strncmp(v, "false", 5) == 0) *out = false;
  else return false;
  return true;
}

bool extractLong(const char *json, const char *key, long *out) {
  const char *v = nullptr;
  if (!findValue(json, key, &v)) return false;
  char *end = nullptr;
  *out = strtol(v, &end, 10);
  return end != v;
}

void reportWifi(const char *status) {
  if (!Serial) return;
  char line[112];
  IPAddress ip = wifiPhase == WIFI_UP ? WiFi.localIP() : IPAddress(0, 0, 0, 0);
  snprintf(line, sizeof(line), "{\"event\":\"wifi\",\"status\":\"%s\",\"ssid\":\"%s\",\"ip\":\"%u.%u.%u.%u\",\"port\":%u}\n",
           status, wifiSsid, ip[0], ip[1], ip[2], ip[3], UDP_PORT);
  Serial.print(line);
}

void startWifi(const char *ssid, const char *pass, uint32_t now) {
  if (udpOpen) udp.stop();
  udpOpen = false;
  peerPort = 0;
  snprintf(wifiSsid, sizeof(wifiSsid), "%s", ssid);
  snprintf(wifiPass, sizeof(wifiPass), "%s", pass);
  if (WiFi.status() == WL_NO_MODULE) {
    wifiPhase = WIFI_OFF;
    showNotice("WIFI: NO MODULE", now);
    reportWifi("no-module");
    return;
  }
  // With a zero timeout begin() returns right after the join request; serviceWifi() polls.
  WiFi.setTimeout(0);
  if (wifiPass[0]) WiFi.begin(wifiSsid, wifiPass);
  else WiFi.begin(wifiSsid);
  wifiPhase = WIFI_JOINING;
  wifiPhaseMs = now;
  nextWifiPollMs = now + 500;
  showNotice("WIFI: JOINING..", now);
  reportWifi("joining");
}

void handleLcdCommand(const char *line, uint32_t now) {
  bool h1 = extractString(line, "l1", customL1, sizeof(customL1));
  bool h2 = extractString(line, "l2", customL2, sizeof(customL2));
  if (!h1) customL1[0] = '\0';
  if (!h2) customL2[0] = '\0';
  long r, g, b, ms;
  bool hasRgb = extractLong(line, "r", &r) && extractLong(line, "g", &g) && extractLong(line, "b", &b);
  customRgb[0] = hasRgb ? clampi((int)r, 0, 255) : -1;
  customRgb[1] = hasRgb ? clampi((int)g, 0, 255) : -1;
  customRgb[2] = hasRgb ? clampi((int)b, 0, 255) : -1;
  if (!extractLong(line, "ms", &ms)) ms = (long)LCD_MSG_MS;
  customSticky = ms <= 0;
  customUntil = now + (uint32_t)(ms > 0 ? ms : 0);
  // {"cmd":"lcd"} with no text or color clears the message.
  customActive = customL1[0] || customL2[0] || hasRgb;
  lastLcdMs = 0;  // redraw on the next pass
}

void handleLine(const char *line) {
  uint32_t now = millis();
  char cmd[12];
  if (!extractString(line, "cmd", cmd, sizeof(cmd))) return;
  bool open = false;
  if (strcmp(cmd, "buzz") == 0) {
    char p[10];
    if (!extractString(line, "p", p, sizeof(p))) return;
    if (strcmp(p, "tick") == 0) playSong(SONG_TICK);
    else if (strcmp(p, "cast") == 0) playSong(SONG_CAST);
    else if (strcmp(p, "fizzle") == 0) playSong(SONG_FIZZLE);
    else if (strcmp(p, "hit") == 0) playSong(SONG_HIT);
  } else if (strcmp(cmd, "lcd") == 0) {
    handleLcdCommand(line, now);
  } else if (strcmp(cmd, "wifi") == 0) {
    char ssid[33], pass[64];
    if (extractString(line, "ssid", ssid, sizeof(ssid)) && ssid[0]) {
      if (!extractString(line, "pass", pass, sizeof(pass))) pass[0] = '\0';
      startWifi(ssid, pass, now);
      return;
    }
    char text[17];
    IPAddress ip = WiFi.localIP();
    if (wifiPhase == WIFI_UP) snprintf(text, sizeof(text), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
    showNotice(wifiPhase == WIFI_UP ? text : (wifiPhase == WIFI_JOINING ? "WIFI: JOINING.." : "WIFI: OFF"), now);
    reportWifi(wifiPhase == WIFI_UP ? "connected" : (wifiPhase == WIFI_JOINING ? "joining" : "off"));
  } else if (strcmp(cmd, "arm") == 0) {
    if (extractBool(line, "open", &open)) setArmed(open);
  } else if (strcmp(cmd, "servo") == 0) {
    if (extractBool(line, "open", &open)) showNotice(open ? "STORYBOOK OPENS" : "STORYBOOK SHUT", now);
  }
  // "hello" needs no work: any UDP packet subscribes its sender.
}

void pollSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (!serialOverflow && serialLen > 0) {
        serialLine[serialLen] = '\0';
        handleLine(serialLine);
      }
      serialLen = 0;
      serialOverflow = false;
    } else if (!serialOverflow) {
      if (serialLen + 1 >= sizeof(serialLine)) serialOverflow = true;
      else serialLine[serialLen++] = c;
    }
  }
}

// --- Wi-Fi UDP --------------------------------------------------------------

void serviceWifi(uint32_t now) {
  if (wifiPhase == WIFI_OFF || before(now, nextWifiPollMs)) return;
  nextWifiPollMs = now + (wifiPhase == WIFI_UP ? 2000 : 500);
  bool linked = WiFi.status() == WL_CONNECTED;

  if (wifiPhase == WIFI_JOINING) {
    IPAddress ip = WiFi.localIP();
    if (linked && ip != IPAddress(0, 0, 0, 0)) {
      IPAddress mask = WiFi.subnetMask();
      broadcastIp = IPAddress(ip[0] | (uint8_t)~mask[0], ip[1] | (uint8_t)~mask[1], ip[2] | (uint8_t)~mask[2],
                              ip[3] | (uint8_t)~mask[3]);
      udpOpen = udp.begin(UDP_PORT) == 1;
      wifiPhase = WIFI_UP;
      nextBeaconMs = now;
      char text[17];
      snprintf(text, sizeof(text), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
      showNotice(text, now);
      reportWifi(udpOpen ? "connected" : "udp-failed");
    } else if ((uint32_t)(now - wifiPhaseMs) > WIFI_JOIN_TIMEOUT_MS) {
      wifiPhase = WIFI_OFF;
      showNotice("WIFI: FAILED", now);
      reportWifi("failed");
    }
    return;
  }
  if (!linked) {
    reportWifi("lost");
    startWifi(wifiSsid, wifiPass, now);
  }
}

void pollUdp(uint32_t now) {
  if (!udpOpen) return;
  if (peerPort && (uint32_t)(now - peerSeenMs) > UDP_PEER_TIMEOUT_MS) peerPort = 0;
  if (before(now, nextUdpPollMs)) return;
  nextUdpPollMs = now + UDP_POLL_MS;
  if (udp.parsePacket() <= 0) return;
  peerIp = udp.remoteIP();
  peerPort = udp.remotePort();
  peerSeenMs = now;
  int n = udp.read((uint8_t *)udpBuf, sizeof(udpBuf) - 1);
  if (n <= 0) return;
  udpBuf[n] = '\0';
  // One packet may carry several newline-separated commands.
  for (char *line = strtok(udpBuf, "\r\n"); line; line = strtok(nullptr, "\r\n")) handleLine(line);
}

void sendUdpFrame(uint32_t now, const char *frame, int len, uint32_t sig) {
  if (!udpOpen || len <= 0) return;
  uint32_t since = now - lastUdpSendMs;
  if (peerPort) {
    if (!(sig != lastUdpSig && since >= UDP_MIN_GAP_MS) && since < UDP_HEARTBEAT_MS) return;
    udp.beginPacket(peerIp, peerPort);
  } else {
    if (before(now, nextBeaconMs)) return;
    nextBeaconMs = now + UDP_BEACON_MS;
    udp.beginPacket(broadcastIp, UDP_PORT);
  }
  udp.write((const uint8_t *)frame, (size_t)len);
  udp.endPacket();
  lastUdpSendMs = now;
  lastUdpSig = sig;
}

// --- Outbound frame ---------------------------------------------------------

void publishFrame(uint32_t now) {
  int btn = armed && talkHeld ? 1 : 0;
  int btn2 = armed && lockHeld ? 1 : 0;
  bool fist = fistActive(now);
  bool parry = parryActive(now);
  const char *swipe = publishedSwipe();
  int power = (int)(clampf(accelPower, ACCEL_POWER_MIN, ACCEL_POWER_MAX) * 100.0f + 0.5f);

  int len = snprintf(frameBuf, sizeof(frameBuf),
                     "{\"dial\":%d,\"btn\":%d,\"btn2\":%d,\"fist\":%s,\"swipe\":\"%s\",\"accel\":%d.%02d,"
                     "\"parry\":%s,\"armed\":%s,\"noise\":0,\"color\":\"none\",\"d3\":%u,\"d4\":%u,\"d8\":%u,"
                     "\"rawDial\":%d}\n",
                     dialSlot, btn, btn2, fist ? "true" : "false", swipe, power / 100, power % 100,
                     parry ? "true" : "false", armed ? "true" : "false", rawD3, rawD4, rawD8, rawDial);
  if (len <= 0 || len >= (int)sizeof(frameBuf)) return;
  if (Serial) Serial.write((const uint8_t *)frameBuf, (size_t)len);

  // Everything the game reacts to, so a change goes out over UDP right away.
  uint32_t sig = (uint32_t)dialSlot | btn << 2 | btn2 << 3 | fist << 4 | parry << 5 | armed << 6 |
                 (uint32_t)(swipe[0]) << 8 | (uint32_t)(power / 5) << 16;
  sendUdpFrame(now, frameBuf, len, sig);
}

// --- Arduino entry ----------------------------------------------------------

void setup() {
  pinMode(touchPin, INPUT);
  pinMode(button1Pin, INPUT);
  pinMode(button2Pin, INPUT);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);
  analogReadResolution(10);  // the R4 defaults to 14-bit; the protocol is 0..1023

  Wire.begin();
  Wire.setClock(100000);
  Serial.begin(SERIAL_BAUD);  // no wait: frames are only written while a host is attached

  if (WIFI_SSID[0]) startWifi(WIFI_SSID, WIFI_PASS, millis());
  lastFrameMs = millis();
}

void loop() {
  uint32_t now = millis();
  updateButtons(now);
  pollSerial();
  pollUdp(now);
  serviceBuzzer(now);

  if ((uint32_t)(now - lastFrameMs) >= FRAME_MS) {
    lastFrameMs += FRAME_MS;
    if ((uint32_t)(now - lastFrameMs) >= FRAME_MS) lastFrameMs = now;  // fell behind: resync
    sampleDial();
    sampleAccel(now);
    publishFrame(now);
  }

  serviceLcd(now);
  serviceWifi(now);
}
