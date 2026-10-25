/*
 * Once Upon a Memory — Enchanted Glove & Props
 * Board:  Arduino Uno R4 WiFi  (arduino:renesas_uno:unor4wifi)
 * Shield: Grove Base Shield V2, VCC switch set to 5V.
 * Link:   USB-C Serial, newline-delimited JSON, SERIAL_BAUD 115200, 50 Hz.
 *
 * The shield covers the onboard 12x8 LED matrix. All physical feedback is the
 * Grove buzzer (and the storybook servo). Wire is in the core. Servo.h is the
 * official Arduino Servo library (IDE Library Manager, or
 * `arduino-cli lib install Servo`). The accelerometer and the color sensor are
 * raw Wire register reads, so Grove / Adafruit / ArduinoJson are not required.
 *
 * Grove Base Shield V2 sockets (any of the four I2C sockets share one bus):
 *   A0  Rotary angle   forearm spell wheel, slots 0..2
 *   A1  Light          palm, covered fist charges the spell
 *   A2  Sound          table by Laptop A, room-noise gate
 *   D2  Button         index finger, click to lock / hold to talk
 *   D3  Touch          palm under the thumb, projectile parry
 *   D4  Switch         forearm band, master arm / disarm
 *   D5  Buzzer         forearm band, tick / cast / fizzle / hit
 *   D6  Servo          storybook, 0° closed .. 110° open
 *   I2C Accelerometer  back of the hand (LIS3DHTR, ADXL345, or MMA7660)
 *   I2C Color          token well (TCS3472 / TCS34725)
 *
 * Outbound (GloveSensorFrame), one object per line:
 *   {"dial":1,"btn":1,"fist":true,"swipe":"thrust","accel":1.35,"parry":false,"armed":true,"noise":310,"color":"ember"}
 * Inbound (GloveCommand), one object per line:
 *   {"cmd":"buzz","p":"tick"|"cast"|"fizzle"|"hit"}
 *   {"cmd":"servo","open":true|false}
 *   {"cmd":"calibrate"}
 *
 * loop() never calls delay(). Notes, the servo sweep, and sensor reads each
 * advance from millis() so a melody cannot stall a parry.
 *
 * Accelerometer mount (retune the four AXIS constants if a swipe is mirrored):
 *   flat on the back of the hand, Grove cable toward the wrist.
 *   LATERAL_AXIS spikes on a left/right swipe; positive * LATERAL_SIGN = right.
 *   THRUST_AXIS spikes when the hand punches toward the laptop.
 */

#include <Arduino.h>
#include <Servo.h>
#include <Wire.h>
#include <math.h>
#include <string.h>

// --- Pins (Grove Base Shield V2) --------------------------------------------

const uint8_t PIN_DIAL = A0;
const uint8_t PIN_LIGHT = A1;
const uint8_t PIN_SOUND = A2;
const uint8_t PIN_BUTTON = 2;
const uint8_t PIN_TOUCH = 3;
const uint8_t PIN_SWITCH = 4;
const uint8_t PIN_BUZZER = 5;
const uint8_t PIN_SERVO = 6;

// Grove Button, Touch, and Switch (P) drive SIG HIGH when active.
const int BUTTON_ACTIVE_LEVEL = HIGH;
const int TOUCH_ACTIVE_LEVEL = HIGH;
const int SWITCH_ARMED_LEVEL = HIGH;

// --- Protocol (matches @once-upon/shared) -----------------------------------

const uint32_t SERIAL_BAUD = 115200;
const uint32_t FRAME_INTERVAL_MS = 20;  // GLOVE_POLL_HZ = 50
const int DIAL_SLOT_COUNT = 3;
const float ACCEL_POWER_MIN = 1.0f;
const float ACCEL_POWER_MAX = 1.5f;
const int SERVO_CLOSED_DEG = 0;
const int SERVO_OPEN_DEG = 110;

// --- Tuning -----------------------------------------------------------------

const float DIAL_ALPHA = 0.22f;
const float DIAL_EDGE_01 = 341.0f;
const float DIAL_EDGE_12 = 682.0f;
const float DIAL_HYST = 36.0f;

const float LIGHT_ALPHA = 0.40f;
// Fist when the smoothed palm reading falls below this fraction of ambient.
const float FIST_RATIO = 0.60f;
const float FIST_HYST = 28.0f;
const float LIGHT_BASELINE_MIN = 30.0f;

const uint8_t SOUND_SAMPLES = 50;
const float NOISE_RELEASE = 0.90f;

const uint16_t DEBOUNCE_MS = 25;
const uint16_t PARRY_MIN_MS = 80;

const uint8_t GESTURE_WINDOW = 10;  // 200 ms at 50 Hz
const uint32_t GESTURE_HOLD_MS = 180;
const uint32_t ACCEL_SETTLE_MS = 300;
const float GESTURE_ON_G = 0.50f;
const float GESTURE_OFF_G = 0.25f;
const float GRAV_ALPHA = 0.03f;
// Dynamic g (gravity removed) mapped onto the 1.00..1.50 spell multiplier.
const float DYN_G_FLOOR = 0.18f;
const float DYN_G_CEIL = 1.40f;

// 0 = X, 1 = Y, 2 = Z. Flip the sign if that gesture comes out backwards.
const uint8_t LATERAL_AXIS = 0;
const int8_t LATERAL_SIGN = 1;
const uint8_t THRUST_AXIS = 1;
const int8_t THRUST_SIGN = 1;

const int SERVO_STEP_DEG = 4;
const uint16_t SERVO_STEP_MS = 20;

const uint16_t COLOR_CLEAR_MIN = 40;
const uint16_t COLOR_SUM_MIN = 30;
const uint8_t COLOR_STABLE_FRAMES = 4;
const float COLOR_CHROMA_MIN = 0.12f;
// Gold (boss) needs green/red at least this high; orange stays under it.
const float GOLD_GREEN_TO_RED = 0.72f;

const uint8_t I2C_FAILS_BEFORE_DROP = 8;
const uint32_t I2C_RETRY_MS = 1000;

// LIS3DHTR ±8 g, high-resolution, 12-bit left-justified: 0.25 mg per raw LSB.
const float LIS3DH_G_PER_LSB = 0.00025f;
// ADXL345 full-resolution mode is 3.9 mg/LSB at every range.
const float ADXL345_G_PER_LSB = 0.0039f;
// MMA7660FC is a 6-bit sensor over ±1.5 g.
const float MMA7660_G_PER_COUNT = 0.046875f;

const uint8_t TCS_ADDR = 0x29;
const uint8_t TCS_ENABLE = 0x00;
const uint8_t TCS_ATIME = 0x01;
const uint8_t TCS_CONTROL = 0x0F;
const uint8_t TCS_ID = 0x12;
const uint8_t TCS_CDATAL = 0x14;

// --- Buzzer songs -----------------------------------------------------------

enum BuzzId : uint8_t {
  BUZZ_NONE = 0,
  BUZZ_TICK = 1,
  BUZZ_FIZZLE = 2,
  BUZZ_CAST = 3,
  BUZZ_HIT = 4
};

struct BuzzNote {
  uint16_t hz;  // 0 = rest (noTone)
  uint16_t durMs;
};

// A higher id preempts a lower one. A new tick restarts a tick, but a tick
// never cuts off cast / fizzle / hit.
const BuzzNote SONG_TICK[] = {{1760, 30}};
const BuzzNote SONG_CAST[] = {{523, 80}, {659, 80}, {784, 80}, {1047, 160}};
const BuzzNote SONG_FIZZLE[] = {{466, 100}, {349, 100}, {262, 200}};
const BuzzNote SONG_HIT[] = {{932, 60}, {0, 40}, {932, 60}, {0, 40}, {1245, 120}};

// --- I2C device kinds -------------------------------------------------------

enum AccelKind : uint8_t {
  ACCEL_NONE = 0,
  ACCEL_LIS3DH = 1,
  ACCEL_ADXL345 = 2,
  ACCEL_MMA7660 = 3
};

enum ColorPhase : uint8_t {
  COLOR_NEED_PROBE = 0,
  COLOR_PON_WAIT = 1,
  COLOR_READY = 2,
  COLOR_UNSUPPORTED = 3
};

enum GesturePhase : uint8_t {
  GESTURE_IDLE = 0,
  GESTURE_HOLD = 1,
  GESTURE_QUIET = 2
};

enum ReadResult : uint8_t {
  READ_OK = 0,
  READ_RETRY = 1,
  READ_FAIL = 2
};

struct Debounce {
  bool stable;
  bool lastRaw;
  bool ready;
  uint32_t changedMs;
};

// --- State ------------------------------------------------------------------

Debounce buttonDb = {false, false, false, 0};
Debounce touchDb = {false, false, false, 0};
Debounce switchDb = {false, false, false, 0};

bool armedNow = false;
bool buttonHeld = false;
bool parryEngaged = false;
uint32_t parryPulseUntil = 0;

bool fistEngaged = false;
bool fistPrimed = false;
bool lightReady = false;
float lightSmooth = 0.0f;
float lightBaseline = 512.0f;

bool dialReady = false;
float dialSmooth = 0.0f;
int dialSlot = 0;

float noiseEnv = 0.0f;
int noiseLevel = 0;

Servo storybook;
int servoPos = SERVO_CLOSED_DEG;
int servoTarget = SERVO_CLOSED_DEG;
uint32_t servoStepMs = 0;

BuzzId buzzId = BUZZ_NONE;
const BuzzNote *buzzNotes = nullptr;
uint8_t buzzCount = 0;
uint8_t buzzIndex = 0;
uint32_t buzzNoteMs = 0;

AccelKind accelKind = ACCEL_NONE;
uint8_t accelAddr = 0;
uint8_t accelFails = 0;
uint32_t nextAccelProbeMs = 0;
bool gravReady = false;
float gravX = 0.0f;
float gravY = 0.0f;
float gravZ = 0.0f;
uint32_t accelReadyAt = 0;
float dynPeak = 0.0f;
float accelPower = 1.0f;
float latWindow[GESTURE_WINDOW];
float thrWindow[GESTURE_WINDOW];
uint8_t gestureCount = 0;
uint8_t gestureHead = 0;
GesturePhase gesturePhase = GESTURE_IDLE;
const char *latchedSwipe = "none";
uint32_t gestureHoldUntil = 0;

ColorPhase colorPhase = COLOR_NEED_PROBE;
uint32_t colorPonMs = 0;
uint32_t nextColorProbeMs = 0;
uint8_t colorMisses = 0;
const char *colorLabel = "none";
const char *colorPending = "none";
uint8_t colorPendingCount = 0;

char lineBuf[128];
uint8_t lineLen = 0;
bool lineOverflow = false;

uint32_t lastFrameMs = 0;
uint8_t i2cFailStreak = 0;

// --- Small helpers ----------------------------------------------------------

float clampf(float value, float lo, float hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

int clampi(int value, int lo, int hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

int16_t s16le(const uint8_t *p) {
  return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

float axisOf(float x, float y, float z, uint8_t axis) {
  if (axis == 1) return y;
  if (axis == 2) return z;
  return x;
}

bool debounceUpdate(Debounce *in, bool raw, uint32_t now, uint16_t ms) {
  if (!in->ready) {
    in->ready = true;
    in->stable = raw;
    in->lastRaw = raw;
    in->changedMs = now;
    return false;
  }
  if (raw != in->lastRaw) {
    in->lastRaw = raw;
    in->changedMs = now;
  }
  if ((uint32_t)(now - in->changedMs) >= ms && in->stable != raw) {
    in->stable = raw;
    return true;
  }
  return false;
}

// --- Buzzer state machine ---------------------------------------------------

void silenceBuzzer() {
  noTone(PIN_BUZZER);
}

void stopBuzz() {
  if (buzzId != BUZZ_NONE) silenceBuzzer();
  buzzId = BUZZ_NONE;
  buzzNotes = nullptr;
  buzzCount = 0;
  buzzIndex = 0;
}

void startBuzzNote(uint32_t now) {
  if (buzzNotes == nullptr || buzzIndex >= buzzCount) {
    stopBuzz();
    return;
  }
  buzzNoteMs = now;
  uint16_t hz = buzzNotes[buzzIndex].hz;
  if (hz == 0) silenceBuzzer();
  else tone(PIN_BUZZER, hz);
}

void startBuzz(BuzzId id) {
  // Disarmed suppresses local ticks and inbound melodies during the pitch.
  if (!armedNow || id == BUZZ_NONE) return;
  if (buzzId != BUZZ_NONE && id < buzzId) return;

  const BuzzNote *notes = nullptr;
  uint8_t count = 0;
  if (id == BUZZ_TICK) {
    notes = SONG_TICK;
    count = (uint8_t)(sizeof(SONG_TICK) / sizeof(SONG_TICK[0]));
  } else if (id == BUZZ_CAST) {
    notes = SONG_CAST;
    count = (uint8_t)(sizeof(SONG_CAST) / sizeof(SONG_CAST[0]));
  } else if (id == BUZZ_FIZZLE) {
    notes = SONG_FIZZLE;
    count = (uint8_t)(sizeof(SONG_FIZZLE) / sizeof(SONG_FIZZLE[0]));
  } else if (id == BUZZ_HIT) {
    notes = SONG_HIT;
    count = (uint8_t)(sizeof(SONG_HIT) / sizeof(SONG_HIT[0]));
  }
  if (notes == nullptr || count == 0) return;

  buzzId = id;
  buzzNotes = notes;
  buzzCount = count;
  buzzIndex = 0;
  startBuzzNote(millis());
}

void serviceBuzzer(uint32_t now) {
  if (buzzId == BUZZ_NONE || buzzNotes == nullptr) return;
  if (buzzIndex >= buzzCount) {
    stopBuzz();
    return;
  }
  if ((uint32_t)(now - buzzNoteMs) < buzzNotes[buzzIndex].durMs) return;
  buzzIndex++;
  startBuzzNote(now);
}

// --- Servo sweep ------------------------------------------------------------

void serviceServo(uint32_t now) {
  if (servoPos == servoTarget) return;
  if ((uint32_t)(now - servoStepMs) < SERVO_STEP_MS) return;
  servoStepMs = now;
  if (servoPos < servoTarget) {
    servoPos += SERVO_STEP_DEG;
    if (servoPos > servoTarget) servoPos = servoTarget;
  } else {
    servoPos -= SERVO_STEP_DEG;
    if (servoPos < servoTarget) servoPos = servoTarget;
  }
  storybook.write(servoPos);
}

// --- Inbound JSON (no ArduinoJson) ------------------------------------------

bool findValue(const char *json, const char *key, const char **value) {
  size_t keyLen = strlen(key);
  const char *p = json;
  while (*p) {
    if (*p == '"') {
      if (strncmp(p + 1, key, keyLen) == 0 && p[1 + keyLen] == '"') {
        const char *q = p + keyLen + 2;
        while (*q == ' ' || *q == '\t') q++;
        if (*q != ':') {
          p++;
          continue;
        }
        q++;
        while (*q == ' ' || *q == '\t') q++;
        *value = q;
        return true;
      }
    }
    p++;
  }
  return false;
}

bool extractString(const char *json, const char *key, char *out, size_t outLen) {
  const char *v = nullptr;
  if (!findValue(json, key, &v) || *v != '"') return false;
  v++;
  size_t n = 0;
  while (*v && *v != '"') {
    if (n + 1 >= outLen) return false;
    out[n++] = *v++;
  }
  if (*v != '"') return false;
  out[n] = '\0';
  return n > 0;
}

bool extractBool(const char *json, const char *key, bool *out) {
  const char *v = nullptr;
  if (!findValue(json, key, &v)) return false;
  if (strncmp(v, "true", 4) == 0) {
    *out = true;
    return true;
  }
  if (strncmp(v, "false", 5) == 0) {
    *out = false;
    return true;
  }
  return false;
}

void calibrateLight();

void handleLine(const char *line) {
  char cmd[16];
  if (!extractString(line, "cmd", cmd, sizeof(cmd))) return;
  if (strcmp(cmd, "buzz") == 0) {
    char pattern[12];
    if (!extractString(line, "p", pattern, sizeof(pattern))) return;
    if (strcmp(pattern, "tick") == 0) startBuzz(BUZZ_TICK);
    else if (strcmp(pattern, "cast") == 0) startBuzz(BUZZ_CAST);
    else if (strcmp(pattern, "fizzle") == 0) startBuzz(BUZZ_FIZZLE);
    else if (strcmp(pattern, "hit") == 0) startBuzz(BUZZ_HIT);
    return;
  }
  if (strcmp(cmd, "servo") == 0) {
    bool open = false;
    if (!extractBool(line, "open", &open)) return;
    servoTarget = open ? SERVO_OPEN_DEG : SERVO_CLOSED_DEG;
    return;
  }
  if (strcmp(cmd, "calibrate") == 0) calibrateLight();
}

void pollSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (!lineOverflow && lineLen > 0) {
        lineBuf[lineLen] = '\0';
        handleLine(lineBuf);
      }
      lineLen = 0;
      lineOverflow = false;
      continue;
    }
    if (lineOverflow) continue;
    if (lineLen + 1 >= sizeof(lineBuf)) {
      lineOverflow = true;
      lineLen = 0;
      continue;
    }
    lineBuf[lineLen++] = c;
  }
}

// --- Digital inputs ---------------------------------------------------------

void updateArmed(uint32_t now) {
  bool raw = digitalRead(PIN_SWITCH) == SWITCH_ARMED_LEVEL;
  debounceUpdate(&switchDb, raw, now, DEBOUNCE_MS);
  bool wasArmed = armedNow;
  armedNow = switchDb.stable;
  if (wasArmed && !armedNow) stopBuzz();
}

void updateButton(uint32_t now) {
  bool raw = digitalRead(PIN_BUTTON) == BUTTON_ACTIVE_LEVEL;
  bool changed = debounceUpdate(&buttonDb, raw, now, DEBOUNCE_MS);
  if (!armedNow) {
    // A hold that began while disarmed must be released before it can talk.
    buttonHeld = false;
    return;
  }
  if (changed && buttonDb.stable) buttonHeld = true;
  if (!buttonDb.stable) buttonHeld = false;
}

void updateParry(uint32_t now) {
  bool raw = digitalRead(PIN_TOUCH) == TOUCH_ACTIVE_LEVEL;
  bool changed = debounceUpdate(&touchDb, raw, now, DEBOUNCE_MS);
  bool rising = changed && touchDb.stable;
  if (!touchDb.stable) parryEngaged = false;
  if (!armedNow) {
    parryEngaged = false;
    parryPulseUntil = 0;
    return;
  }
  if (rising) {
    parryEngaged = true;
    parryPulseUntil = now + PARRY_MIN_MS;
  }
}

bool parryActive(uint32_t now) {
  if (!armedNow) return false;
  if (parryEngaged) return true;
  return parryPulseUntil != 0 && (int32_t)(parryPulseUntil - now) > 0;
}

// --- Analog: dial, fist, noise ----------------------------------------------

int slotFromAngle(float angle) {
  if (angle < DIAL_EDGE_01) return 0;
  if (angle < DIAL_EDGE_12) return 1;
  return 2;
}

int nextDialSlot(int slot, float angle) {
  if (slot <= 0) return (angle > DIAL_EDGE_01 + DIAL_HYST) ? 1 : 0;
  if (slot >= 2) return (angle < DIAL_EDGE_12 - DIAL_HYST) ? 1 : 2;
  if (angle < DIAL_EDGE_01 - DIAL_HYST) return 0;
  if (angle > DIAL_EDGE_12 + DIAL_HYST) return 2;
  return 1;
}

void sampleDial() {
  int raw = analogRead(PIN_DIAL);
  raw = clampi(raw, 0, 1023);
  if (!dialReady) {
    dialSmooth = (float)raw;
    dialSlot = slotFromAngle(dialSmooth);
    dialReady = true;
    return;
  }
  dialSmooth += DIAL_ALPHA * ((float)raw - dialSmooth);
  int next = nextDialSlot(dialSlot, dialSmooth);
  if (next == dialSlot) return;
  dialSlot = next;
  if (armedNow) startBuzz(BUZZ_TICK);
}

void calibrateLight() {
  uint32_t sum = 0;
  const int samples = 24;
  for (int i = 0; i < samples; i++) sum += (uint32_t)analogRead(PIN_LIGHT);
  lightBaseline = (float)(sum / (uint32_t)samples);
  if (lightBaseline < LIGHT_BASELINE_MIN) lightBaseline = LIGHT_BASELINE_MIN;
  lightSmooth = lightBaseline;
  lightReady = true;
  fistEngaged = false;
  // Require the palm to read as open after a calibrate before a new fist counts.
  fistPrimed = false;
}

void sampleLight() {
  int raw = clampi(analogRead(PIN_LIGHT), 0, 1023);
  if (!lightReady) {
    lightSmooth = (float)raw;
    lightReady = true;
  } else {
    lightSmooth += LIGHT_ALPHA * ((float)raw - lightSmooth);
  }

  if (!armedNow) {
    fistEngaged = false;
    fistPrimed = false;
    return;
  }

  float onThreshold = lightBaseline * FIST_RATIO;
  float offThreshold = onThreshold + FIST_HYST;
  bool covered = lightSmooth < onThreshold;
  if (lightSmooth > offThreshold) fistPrimed = true;
  if (!fistPrimed) {
    fistEngaged = false;
  } else if (fistEngaged) {
    if (lightSmooth > offThreshold) fistEngaged = false;
  } else if (covered) {
    fistEngaged = true;
  }

  // Track ambient only while the palm is open, so a fist cannot drag the
  // threshold down with it. Rising light is followed faster than falling light.
  if (!fistEngaged && fistPrimed) {
    float err = lightSmooth - lightBaseline;
    float alpha = (err > 0.0f) ? 0.04f : 0.004f;
    lightBaseline = clampf(lightBaseline + alpha * err, LIGHT_BASELINE_MIN, 1023.0f);
  }
}

void sampleNoise() {
  int mn = 1023;
  int mx = 0;
  uint32_t sum = 0;
  for (uint8_t i = 0; i < SOUND_SAMPLES; i++) {
    int v = clampi(analogRead(PIN_SOUND), 0, 1023);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += (uint32_t)v;
  }
  int mean = (int)(sum / SOUND_SAMPLES);
  int p2p = mx - mn;
  // LM386 sound sensors are biased near midscale: loudness is the swing.
  // Envelope / loudness modules sit near 0 V and climb with level: use the peak.
  int amp = (mean > 300 && mean < 750) ? p2p : mx;
  amp = clampi(amp, 0, 1023);
  if ((float)amp >= noiseEnv) noiseEnv = (float)amp;
  else noiseEnv *= NOISE_RELEASE;
  noiseLevel = clampi((int)(noiseEnv + 0.5f), 0, 1023);
}

// --- I2C bus ----------------------------------------------------------------

bool i2cBegun = false;

void resetI2c() {
  if (i2cBegun) Wire.end();
  Wire.begin();
  Wire.setClock(100000);
  i2cBegun = true;
}

void noteI2cFail() {
  if (++i2cFailStreak < 12) return;
  i2cFailStreak = 0;
  resetI2c();
  // Addresses are unchanged; the next failed read drops the device and re-probes.
}

void noteI2cOk() {
  i2cFailStreak = 0;
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
  size_t got = Wire.requestFrom(static_cast<uint8_t>(addr), static_cast<uint8_t>(len));
  if (got != len) {
    while (Wire.available() > 0) Wire.read();
    return false;
  }
  for (uint8_t i = 0; i < len; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}

bool i2cAck(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void forgetAccel() {
  accelKind = ACCEL_NONE;
  accelAddr = 0;
  accelFails = 0;
  gravReady = false;
  dynPeak = 0.0f;
  accelPower = ACCEL_POWER_MIN;
  gestureCount = 0;
  gesturePhase = GESTURE_QUIET;
  latchedSwipe = "none";
}

bool probeLis3dh(uint8_t addr) {
  uint8_t who = 0;
  if (!readRegs(addr, 0x0F, &who, 1)) return false;
  if (who != 0x33) return false;
  // CTRL_REG4: BDU | ±8 g | high resolution. CTRL_REG1: 400 Hz, XYZ enabled.
  if (!writeReg(addr, 0x23, 0xA8)) return false;
  if (!writeReg(addr, 0x20, 0x77)) return false;
  accelAddr = addr;
  accelKind = ACCEL_LIS3DH;
  accelFails = 0;
  gravReady = false;
  gestureCount = 0;
  accelReadyAt = millis();
  return true;
}

bool probeAdxl345(uint8_t addr) {
  uint8_t id = 0;
  if (!readRegs(addr, 0x00, &id, 1)) return false;
  if (id != 0xE5) return false;
  if (!writeReg(addr, 0x2D, 0x00)) return false;  // standby while configuring
  if (!writeReg(addr, 0x31, 0x0B)) return false;  // full-res, ±16 g
  if (!writeReg(addr, 0x2C, 0x0C)) return false;  // 400 Hz
  if (!writeReg(addr, 0x2D, 0x08)) return false;  // measure
  accelAddr = addr;
  accelKind = ACCEL_ADXL345;
  accelFails = 0;
  gravReady = false;
  gestureCount = 0;
  accelReadyAt = millis();
  return true;
}

int8_t mmaDecode(uint8_t v, bool *alert) {
  if ((v & 0x40) != 0) *alert = true;
  uint8_t raw = (uint8_t)(v & 0x3F);
  if ((raw & 0x20) != 0) raw = (uint8_t)(raw | 0xC0);
  return (int8_t)raw;
}

bool probeMma7660(uint8_t addr) {
  if (!i2cAck(addr)) return false;
  // Config registers only accept writes in standby. Then go active at 120 Hz.
  if (!writeReg(addr, 0x07, 0x00)) return false;
  if (!writeReg(addr, 0x08, 0x00)) return false;
  if (!writeReg(addr, 0x07, 0x01)) return false;
  uint8_t mode = 0;
  if (!readRegs(addr, 0x07, &mode, 1)) return false;
  if ((mode & 0x01) == 0) return false;
  accelAddr = addr;
  accelKind = ACCEL_MMA7660;
  accelFails = 0;
  gravReady = false;
  gestureCount = 0;
  accelReadyAt = millis();
  return true;
}

void probeAccel(uint32_t now) {
  if (accelKind != ACCEL_NONE) return;
  if (nextAccelProbeMs != 0 && (int32_t)(now - nextAccelProbeMs) < 0) return;
  nextAccelProbeMs = now + I2C_RETRY_MS;
  if (probeLis3dh(0x19) || probeLis3dh(0x18)) return;
  if (probeAdxl345(0x53) || probeAdxl345(0x1D)) return;
  if (probeMma7660(0x4C)) return;
  noteI2cFail();
}

ReadResult readAccelG(float *x, float *y, float *z) {
  uint8_t buf[6];
  if (accelKind == ACCEL_LIS3DH) {
    // MSB of the sub-address turns on LIS3DH register auto-increment.
    if (!readRegs(accelAddr, (uint8_t)(0x28 | 0x80), buf, 6)) return READ_FAIL;
    *x = (float)s16le(buf) * LIS3DH_G_PER_LSB;
    *y = (float)s16le(buf + 2) * LIS3DH_G_PER_LSB;
    *z = (float)s16le(buf + 4) * LIS3DH_G_PER_LSB;
    return READ_OK;
  }
  if (accelKind == ACCEL_ADXL345) {
    if (!readRegs(accelAddr, 0x32, buf, 6)) return READ_FAIL;
    *x = (float)s16le(buf) * ADXL345_G_PER_LSB;
    *y = (float)s16le(buf + 2) * ADXL345_G_PER_LSB;
    *z = (float)s16le(buf + 4) * ADXL345_G_PER_LSB;
    return READ_OK;
  }
  if (accelKind == ACCEL_MMA7660) {
    if (!readRegs(accelAddr, 0x00, buf, 3)) return READ_FAIL;
    bool alert = false;
    int8_t rx = mmaDecode(buf[0], &alert);
    int8_t ry = mmaDecode(buf[1], &alert);
    int8_t rz = mmaDecode(buf[2], &alert);
    if (alert) return READ_RETRY;
    *x = (float)rx * MMA7660_G_PER_COUNT;
    *y = (float)ry * MMA7660_G_PER_COUNT;
    *z = (float)rz * MMA7660_G_PER_COUNT;
    return READ_OK;
  }
  return READ_FAIL;
}

void pushGesture(float lateral, float thrust) {
  latWindow[gestureHead] = lateral;
  thrWindow[gestureHead] = thrust;
  gestureHead = (uint8_t)((gestureHead + 1) % GESTURE_WINDOW);
  if (gestureCount < GESTURE_WINDOW) gestureCount++;
}

void gesturePeaks(float *latPeak, float *thrPeak) {
  float lp = 0.0f;
  float tp = 0.0f;
  uint8_t start = (uint8_t)((gestureHead + GESTURE_WINDOW - gestureCount) % GESTURE_WINDOW);
  for (uint8_t i = 0; i < gestureCount; i++) {
    uint8_t idx = (uint8_t)((start + i) % GESTURE_WINDOW);
    if (fabsf(latWindow[idx]) >= fabsf(lp)) lp = latWindow[idx];
    if (fabsf(thrWindow[idx]) >= fabsf(tp)) tp = thrWindow[idx];
  }
  *latPeak = lp;
  *thrPeak = tp;
}

float powerFromDyn(float dynG) {
  float span = DYN_G_CEIL - DYN_G_FLOOR;
  float t = (span <= 0.0f) ? 0.0f : (dynG - DYN_G_FLOOR) / span;
  t = clampf(t, 0.0f, 1.0f);
  return ACCEL_POWER_MIN + (ACCEL_POWER_MAX - ACCEL_POWER_MIN) * t;
}

void updateGesture(float lateral, float thrust, uint32_t now) {
  pushGesture(lateral, thrust);
  float latPeak = 0.0f;
  float thrPeak = 0.0f;
  gesturePeaks(&latPeak, &thrPeak);
  bool quiet =
      fabsf(latPeak) < GESTURE_OFF_G && fabsf(thrPeak) < GESTURE_OFF_G;

  if (!armedNow && gesturePhase == GESTURE_HOLD) gesturePhase = GESTURE_QUIET;

  if (gesturePhase == GESTURE_HOLD) {
    if ((int32_t)(now - gestureHoldUntil) >= 0) gesturePhase = GESTURE_QUIET;
    else return;
  }
  if (gesturePhase == GESTURE_QUIET) {
    // Stay quiet while the switch is off so re-arming cannot replay a swipe
    // that started on the bench during the pitch.
    if (quiet && armedNow) gesturePhase = GESTURE_IDLE;
    return;
  }
  if (!armedNow) {
    gesturePhase = GESTURE_QUIET;
    return;
  }
  if (gestureCount < GESTURE_WINDOW) return;
  if ((uint32_t)(now - accelReadyAt) < ACCEL_SETTLE_MS) return;

  float latMag = fabsf(latPeak);
  float thrMag = fabsf(thrPeak);
  if (latMag < GESTURE_ON_G && thrMag < GESTURE_ON_G) return;

  if (thrMag >= latMag) latchedSwipe = "thrust";
  else latchedSwipe = (latPeak >= 0.0f) ? "right" : "left";
  gesturePhase = GESTURE_HOLD;
  gestureHoldUntil = now + GESTURE_HOLD_MS;
}

void updateMotion(float ax, float ay, float az, uint32_t now) {
  if (!gravReady) {
    gravX = ax;
    gravY = ay;
    gravZ = az;
    gravReady = true;
    dynPeak = 0.0f;
    accelPower = ACCEL_POWER_MIN;
    gestureCount = 0;
    gesturePhase = GESTURE_QUIET;
    accelReadyAt = now;
    return;
  }

  gravX += GRAV_ALPHA * (ax - gravX);
  gravY += GRAV_ALPHA * (ay - gravY);
  gravZ += GRAV_ALPHA * (az - gravZ);
  float lx = ax - gravX;
  float ly = ay - gravY;
  float lz = az - gravZ;
  float dyn = sqrtf(lx * lx + ly * ly + lz * lz);

  float lateral = (float)LATERAL_SIGN * axisOf(lx, ly, lz, LATERAL_AXIS);
  float thrust = (float)THRUST_SIGN * axisOf(lx, ly, lz, THRUST_AXIS);
  updateGesture(lateral, thrust, now);

  bool settling = (uint32_t)(now - accelReadyAt) < ACCEL_SETTLE_MS;
  if (settling) {
    dynPeak = 0.0f;
  } else if (dyn > dynPeak) {
    dynPeak = dyn;
  } else if (gesturePhase != GESTURE_HOLD) {
    dynPeak *= 0.85f;
    if (dynPeak < 0.01f) dynPeak = 0.0f;
  }
  accelPower = powerFromDyn(dynPeak);
}

void sampleAccel(uint32_t now) {
  if (accelKind == ACCEL_NONE) {
    probeAccel(now);
    accelPower = ACCEL_POWER_MIN;
    return;
  }
  float ax = 0.0f;
  float ay = 0.0f;
  float az = 0.0f;
  ReadResult result = readAccelG(&ax, &ay, &az);
  if (result == READ_RETRY) return;
  if (result == READ_FAIL) {
    noteI2cFail();
    if (++accelFails >= I2C_FAILS_BEFORE_DROP) {
      forgetAccel();
      nextAccelProbeMs = now + 300;
    }
    return;
  }
  accelFails = 0;
  noteI2cOk();
  updateMotion(ax, ay, az, now);
}

// --- Color ------------------------------------------------------------------

bool tcsWrite(uint8_t reg, uint8_t val) {
  // Command bit 0x80. Single-byte protocol (TYPE = 00).
  return writeReg(TCS_ADDR, (uint8_t)(0x80 | reg), val);
}

bool tcsRead(uint8_t reg, uint8_t *buf, uint8_t len) {
  // Auto-increment (TYPE = 01) when reading the RGBC block.
  uint8_t cmd = (len > 1) ? (uint8_t)(0xA0 | reg) : (uint8_t)(0x80 | reg);
  return readRegs(TCS_ADDR, cmd, buf, len);
}

void resetColorLabel() {
  colorLabel = "none";
  colorPending = "none";
  colorPendingCount = 0;
}

const char *classifyColor(uint16_t clear, uint16_t r, uint16_t g, uint16_t b) {
  if (clear < COLOR_CLEAR_MIN) return "none";
  uint32_t sum = (uint32_t)r + (uint32_t)g + (uint32_t)b;
  if (sum < COLOR_SUM_MIN) return "none";

  float rn = (float)r / (float)sum;
  float gn = (float)g / (float)sum;
  float bn = (float)b / (float)sum;
  float mx = rn;
  if (gn > mx) mx = gn;
  if (bn > mx) mx = bn;
  float mn = rn;
  if (gn < mn) mn = gn;
  if (bn < mn) mn = bn;
  if ((mx - mn) < COLOR_CHROMA_MIN) return "none";

  // Gold / yellow token: red and green together, blue stays weak.
  if (bn < 0.22f && rn > 0.34f && gn > 0.30f && gn > rn * GOLD_GREEN_TO_RED) return "boss";
  // Purple token: red and blue together, green stays weak.
  if (gn < 0.28f && rn > 0.28f && bn > 0.28f) return "boss";
  // Red / orange token.
  if (rn >= gn && rn >= bn && rn > 0.40f && bn < 0.30f) return "ember";
  // Cyan (blue + green, little red) and pure blue.
  if (rn < 0.28f && bn > 0.30f && gn > 0.26f && (bn + gn) > 0.68f) return "frost";
  if (bn >= rn && bn >= gn && bn > 0.36f) return "frost";
  if (gn >= rn && gn >= bn && gn > 0.38f && bn < 0.36f) return "bloom";
  return "none";
}

const char *debounceColor(const char *sample) {
  if (strcmp(sample, colorPending) != 0) {
    colorPending = sample;
    colorPendingCount = 1;
  } else if (colorPendingCount < 255) {
    colorPendingCount++;
  }
  if (colorPendingCount >= COLOR_STABLE_FRAMES) colorLabel = colorPending;
  return colorLabel;
}

void pollColorInit(uint32_t now) {
  if (colorPhase == COLOR_UNSUPPORTED || colorPhase == COLOR_READY) return;

  if (colorPhase == COLOR_NEED_PROBE) {
    if (nextColorProbeMs != 0 && (int32_t)(now - nextColorProbeMs) < 0) return;
    nextColorProbeMs = now + I2C_RETRY_MS;
    if (!i2cAck(TCS_ADDR)) {
      noteI2cFail();
      return;
    }
    uint8_t id = 0;
    if (!tcsRead(TCS_ID, &id, 1)) {
      noteI2cFail();
      return;
    }
    // 0x00 means the register didn't come back (chip still dark, or a different
    // device that NACKed the payload). Retry later and do not write to it.
    if (id == 0x00) {
      noteI2cFail();
      return;
    }
    // 0x44 = TCS34721/TCS34725, 0x4D = TCS34723/TCS34727. Anything else (for
    // example a VL53L0X, which also sits at 0x29) is left alone — no writes.
    if (id != 0x44 && id != 0x4D) {
      colorPhase = COLOR_UNSUPPORTED;
      resetColorLabel();
      return;
    }
    // PON first. AEN waits until the oscillator has started (~2.4 ms).
    if (!tcsWrite(TCS_ENABLE, 0x01)) {
      noteI2cFail();
      return;
    }
    colorPonMs = now;
    colorPhase = COLOR_PON_WAIT;
    return;
  }

  if ((uint32_t)(now - colorPonMs) < 3) return;

  // ~24 ms integration, 16x gain. The chip keeps the latest finished sample.
  if (!tcsWrite(TCS_ATIME, 0xF6) || !tcsWrite(TCS_CONTROL, 0x02) || !tcsWrite(TCS_ENABLE, 0x03)) {
    colorPhase = COLOR_NEED_PROBE;
    nextColorProbeMs = now + I2C_RETRY_MS;
    noteI2cFail();
    return;
  }
  colorPhase = COLOR_READY;
  colorMisses = 0;
  noteI2cOk();
}

void sampleColor(uint32_t now) {
  if (colorPhase != COLOR_READY) {
    pollColorInit(now);
    return;
  }
  uint8_t buf[8];
  if (!tcsRead(TCS_CDATAL, buf, 8)) {
    noteI2cFail();
    if (++colorMisses >= I2C_FAILS_BEFORE_DROP) {
      colorPhase = COLOR_NEED_PROBE;
      nextColorProbeMs = now + 300;
      colorMisses = 0;
      resetColorLabel();
    }
    return;
  }
  colorMisses = 0;
  noteI2cOk();
  uint16_t clear = (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
  uint16_t red = (uint16_t)buf[2] | ((uint16_t)buf[3] << 8);
  uint16_t green = (uint16_t)buf[4] | ((uint16_t)buf[5] << 8);
  uint16_t blue = (uint16_t)buf[6] | ((uint16_t)buf[7] << 8);
  debounceColor(classifyColor(clear, red, green, blue));
}

// --- Outbound frame ---------------------------------------------------------

void printBool(bool value) {
  Serial.print(value ? F("true") : F("false"));
}

const char *publishedSwipe() {
  if (!armedNow || accelKind == ACCEL_NONE) return "none";
  if (gesturePhase != GESTURE_HOLD) return "none";
  return latchedSwipe;
}

void writeFrame(uint32_t now) {
  int btnOut = (armedNow && buttonHeld) ? 1 : 0;
  bool fistOut = armedNow && fistEngaged;
  bool parryOut = parryActive(now);
  float shown = clampf(accelPower, ACCEL_POWER_MIN, ACCEL_POWER_MAX);
  int slot = clampi(dialSlot, 0, DIAL_SLOT_COUNT - 1);

  Serial.print(F("{\"dial\":"));
  Serial.print(slot);
  Serial.print(F(",\"btn\":"));
  Serial.print(btnOut);
  Serial.print(F(",\"fist\":"));
  printBool(fistOut);
  Serial.print(F(",\"swipe\":\""));
  Serial.print(publishedSwipe());
  Serial.print(F("\",\"accel\":"));
  Serial.print(shown, 2);
  Serial.print(F(",\"parry\":"));
  printBool(parryOut);
  Serial.print(F(",\"armed\":"));
  printBool(armedNow);
  Serial.print(F(",\"noise\":"));
  Serial.print(noiseLevel);
  Serial.print(F(",\"color\":\""));
  Serial.print(colorLabel);
  Serial.print(F("\"}\n"));
}

void sampleFrame(uint32_t now) {
  sampleDial();
  sampleLight();
  sampleNoise();
  sampleAccel(now);
  sampleColor(now);
  if (Serial) writeFrame(now);
}

// --- Arduino entry ----------------------------------------------------------

void setup() {
  pinMode(PIN_BUTTON, INPUT);
  pinMode(PIN_TOUCH, INPUT);
  pinMode(PIN_SWITCH, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  // Uno R4 analogRead() is 14-bit (0..16383) unless this is set. The glove
  // contract treats the Grove ADCs as 10-bit, 0..1023.
  analogReadResolution(10);

  storybook.attach(PIN_SERVO);
  storybook.write(SERVO_CLOSED_DEG);
  servoPos = SERVO_CLOSED_DEG;
  servoTarget = SERVO_CLOSED_DEG;

  resetI2c();

  Serial.begin(SERIAL_BAUD);
  uint32_t waitStart = millis();
  while (!Serial && (uint32_t)(millis() - waitStart) < 800) {
    // Setup only. Cap the wait so a board powered without a host still runs.
  }

  calibrateLight();
  lastFrameMs = millis();
}

void loop() {
  uint32_t now = millis();

  updateArmed(now);
  updateButton(now);
  updateParry(now);
  if (!armedNow) stopBuzz();

  pollSerial();
  serviceBuzzer(now);
  serviceServo(now);

  if ((uint32_t)(now - lastFrameMs) >= FRAME_INTERVAL_MS) {
    lastFrameMs += FRAME_INTERVAL_MS;
    if ((uint32_t)(now - lastFrameMs) >= FRAME_INTERVAL_MS) lastFrameMs = now;
    sampleFrame(now);
    // A dial tick started inside sampleFrame should begin on this pass.
    serviceBuzzer(now);
  }
}
