/*
 * Enchanted Glove: Wi-Fi sensor bring-up firmware (no game logic).
 * Board:  Arduino Uno R4 WiFi (arduino:renesas_uno:unor4wifi)
 * Shield: Grove Base Shield V2, VCC switch at 5V.
 *
 * Builds (same code, two variants; see firmware/flash.sh):
 *   GLOVE_ID     1, 2, ...  shown on the LCD and in every packet so the hub can tell gloves apart
 *   LCD_VARIANT  4          Grove LCD RGB v4: text readable, only the green backlight works.
 *                           Backlight stays green; the text carries the status.
 *   LCD_VARIANT  2          Grove LCD RGB v2: backlight colors work, text is not readable.
 *                           ORANGE = joining Wi-Fi or waiting for the hub
 *                           GREEN  = Wi-Fi up and the hub is receiving
 *                           RED    = Wi-Fi failed or lost, or the accelerometer is missing
 *
 * Grove wiring:
 *   D3, D7  Touch sensor (either socket)
 *   D4      Button 1
 *   D8      Button 2
 *   D5      Buzzer
 *   A0      Rotary angle sensor
 *   I2C     3-axis accelerometer (LIS3DHTR, ADXL345 or MMA7660, auto-detected)
 *   I2C     16x2 RGB LCD (text 0x3E, backlight 0x62)
 *
 * Wi-Fi: joins WIFI_SSID from wifi_secrets.h (copy wifi_secrets.example.h). Frames go out as
 * UDP to the hub on HUB_PORT. Until a hub says hello they are broadcast to the subnet; after a
 * hello they go straight to the hub. Commands arrive on CMD_PORT (UDP) or USB serial.
 *
 * Outbound (one JSON object per packet, every number is an integer):
 *   frame  {"t":"f","id":1,"seq":42,"ms":12345,"ax":12,"ay":-20,"az":998,
 *           "d3":0,"d7":0,"d4":0,"d8":0,"dial":512,"rssi":-48}      ax/ay/az in milli-g
 *   info   {"t":"i","id":1,"v":4,"fw":"wifi-diag-1","ip":"172.20.10.5","ssid":"iPhone","rssi":-48,
 *           "acc":"MMA7660","hub":1,"up":123,"fps":33,"i2c":[62,76,98]}      once a second
 * Inbound (one JSON object per packet or per serial line):
 *   {"cmd":"hello"}                         hub announces itself; frames switch to unicast
 *   {"cmd":"beep"}                          short beep
 *   {"cmd":"ident"}                         beep and show "I AM GLOVE n" for 4 s
 *   {"cmd":"lcd","l1":"..","l2":"..","r":255,"g":0,"b":0,"ms":4000}   custom message
 *   {"cmd":"i2c"}                           rescan the I2C buses (result appears in the next info)
 *
 * loop() never calls delay(): everything advances from millis().
 */

#include <Arduino.h>
#include <Wire.h>
#include <rgb_lcd.h>
#include <WiFiS3.h>
#include <WiFiUdp.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef GLOVE_ID
#define GLOVE_ID 1
#endif
#ifndef LCD_VARIANT
#define LCD_VARIANT 4
#endif

#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#else
#error "Copy wifi_secrets.example.h to wifi_secrets.h in this folder and fill in WIFI_SSID and WIFI_PASS."
#endif

// --- Config -----------------------------------------------------------------

const char FIRMWARE_TAG[] = "wifi-diag-1";
const uint16_t CMD_PORT = 4210;  // the glove listens here
const uint16_t HUB_PORT = 4211;  // the hub listens here
const uint32_t SERIAL_BAUD = 115200;

const uint8_t touchPin = 3;
const uint8_t touchAltPin = 7;
const uint8_t button1Pin = 4;
const uint8_t button2Pin = 8;
const uint8_t buzzerPin = 5;
const uint8_t dialPin = A0;

const uint32_t FRAME_MS = 25;            // 40 Hz target; a UDP packet costs ~15 ms on the R4 WiFi
const uint32_t INFO_MS = 1000;
const uint32_t HUB_TIMEOUT_MS = 6000;    // no hello for this long: back to broadcast
const uint32_t WIFI_JOIN_TIMEOUT_MS = 20000;
const uint32_t WIFI_RETRY_MS = 4000;
const uint32_t LCD_REFRESH_MS = 200;
const uint32_t LCD_PAGE_MS = 3000;
const uint8_t LCD_PAGES = 4;
const uint32_t SERIAL_FRAME_EVERY = 8;   // print every Nth frame on USB

const float LIS3DH_G_PER_LSB = 0.00025f;  // +-8 g, high resolution
const float ADXL345_G_PER_LSB = 0.0039f;  // full resolution
const float MMA7660_G_PER_COUNT = 0.046875f;
const uint8_t I2C_FAILS_BEFORE_DROP = 8;
const uint32_t I2C_RETRY_MS = 1000;
const uint8_t I2C_SCAN_MAX = 16;

// --- State ------------------------------------------------------------------

enum NetPhase : uint8_t { NET_NO_MODULE, NET_JOINING, NET_UP, NET_FAILED, NET_LOST };
enum AccelKind : uint8_t { ACCEL_NONE, ACCEL_LIS3DH, ACCEL_ADXL345, ACCEL_MMA7660 };

rgb_lcd lcd;
WiFiUDP udp;

NetPhase net = NET_JOINING;
uint32_t netPhaseMs = 0;
uint32_t nextWifiPollMs = 0;
uint32_t nextWifiRetryMs = 0;
int wifiStatusCode = 0;
bool udpOpen = false;
IPAddress localIp;
IPAddress broadcastIp;
IPAddress hubIp;
uint32_t hubSeenMs = 0;
bool hubKnown = false;
int32_t rssi = 0;

AccelKind accelKind = ACCEL_NONE;
uint8_t accelAddr = 0;
uint8_t accelFails = 0;
uint32_t nextAccelProbeMs = 0;
uint8_t i2cFailStreak = 0;
int16_t axMg = 0, ayMg = 0, azMg = 0;
bool accelEverSeen = false;

int16_t dialRaw = 0;
uint8_t pinTouch = 0, pinTouchAlt = 0, pinBtn1 = 0, pinBtn2 = 0;
bool lastBtn1 = false;

uint8_t i2cList[I2C_SCAN_MAX];
uint8_t i2cCount = 0;
bool rescanI2c = true;

uint32_t seq = 0;
uint32_t lastFrameMs = 0;
uint32_t lastInfoMs = 0;
uint32_t framesThisSecond = 0;
uint32_t fps = 0;
uint32_t serialFrameCount = 0;

bool lcdReady = false;
uint32_t lastLcdMs = 0;
uint32_t pageStartMs = 0;
uint8_t lcdPage = 0;
char lcdShown[2][17];
int16_t rgbShown[3] = {-1, -1, -1};

char customL1[17] = "";
char customL2[17] = "";
int16_t customRgb[3] = {-1, -1, -1};
uint32_t customUntil = 0;
bool customActive = false;
bool customSticky = false;
char identText[17] = "";
uint32_t identUntil = 0;

char cmdBuf[256];
char serialLine[256];
uint8_t serialLen = 0;

// --- Small helpers ----------------------------------------------------------

bool before(uint32_t now, uint32_t deadline) { return (int32_t)(deadline - now) > 0; }
int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
int16_t s16le(const uint8_t *p) { return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8)); }

const char *accelName() {
  switch (accelKind) {
    case ACCEL_LIS3DH: return "LIS3DH";
    case ACCEL_ADXL345: return "ADXL345";
    case ACCEL_MMA7660: return "MMA7660";
    default: return "NONE";
  }
}

// --- Tiny JSON field extraction ----------------------------------------------

bool findValue(const char *json, const char *key, const char **out) {
  char needle[24];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *p = strstr(json, needle);
  if (!p) return false;
  p += strlen(needle);
  while (*p == ' ' || *p == ':') p++;
  *out = p;
  return true;
}

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

bool extractLong(const char *json, const char *key, long *out) {
  const char *v = nullptr;
  if (!findValue(json, key, &v)) return false;
  char *end = nullptr;
  *out = strtol(v, &end, 10);
  return end != v;
}

// --- I2C --------------------------------------------------------------------

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

void scanI2c() {
  i2cCount = 0;
  for (uint8_t addr = 0x08; addr < 0x78 && i2cCount < I2C_SCAN_MAX; addr++) {
    if (i2cAck(addr)) i2cList[i2cCount++] = addr;
  }
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
  accelEverSeen = true;
}

bool probeLis3dh(uint8_t addr) {
  uint8_t who = 0;
  if (!readRegs(addr, 0x0F, &who, 1) || who != 0x33) return false;
  if (!writeReg(addr, 0x23, 0xA8) || !writeReg(addr, 0x20, 0x77)) return false;  // BDU +-8 g HR, 400 Hz XYZ
  useAccel(ACCEL_LIS3DH, addr);
  return true;
}

bool probeAdxl345(uint8_t addr) {
  uint8_t id = 0;
  if (!readRegs(addr, 0x00, &id, 1) || id != 0xE5) return false;
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

void sampleAccel(uint32_t now) {
  if (accelKind == ACCEL_NONE) {
    axMg = ayMg = azMg = 0;
    if (before(now, nextAccelProbeMs)) return;
    nextAccelProbeMs = now + I2C_RETRY_MS;
    if (probeLis3dh(0x19) || probeLis3dh(0x18) || probeAdxl345(0x53) || probeAdxl345(0x1D) || probeMma7660(0x4C)) return;
    noteI2cFail();
    return;
  }
  float x, y, z;
  int result = readAccelG(&x, &y, &z);
  if (result == 0) return;
  if (result < 0) {
    noteI2cFail();
    if (++accelFails >= I2C_FAILS_BEFORE_DROP) {
      accelKind = ACCEL_NONE;
      nextAccelProbeMs = now + 300;
    }
    return;
  }
  accelFails = 0;
  i2cFailStreak = 0;
  axMg = (int16_t)lroundf(x * 1000.0f);
  ayMg = (int16_t)lroundf(y * 1000.0f);
  azMg = (int16_t)lroundf(z * 1000.0f);
}

// --- Inputs -----------------------------------------------------------------

void readInputs() {
  pinTouch = digitalRead(touchPin) == HIGH;
  pinTouchAlt = digitalRead(touchAltPin) == HIGH;
  pinBtn1 = digitalRead(button1Pin) == HIGH;
  pinBtn2 = digitalRead(button2Pin) == HIGH;
  dialRaw = (int16_t)clampi(analogRead(dialPin), 0, 1023);
}

// --- Wi-Fi ------------------------------------------------------------------

void beginWifi(uint32_t now) {
  if (udpOpen) udp.stop();
  udpOpen = false;
  hubKnown = false;
  if (WiFi.status() == WL_NO_MODULE) {
    net = NET_NO_MODULE;
    return;
  }
  WiFi.disconnect();
  WiFi.setTimeout(0);  // begin() returns right after the join request; serviceWifi() polls
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  net = NET_JOINING;
  netPhaseMs = now;
  nextWifiPollMs = now + 500;
}

void serviceWifi(uint32_t now) {
  if (net == NET_NO_MODULE || before(now, nextWifiPollMs)) return;
  nextWifiPollMs = now + (net == NET_UP ? 1500 : 500);

  if (net == NET_FAILED || net == NET_LOST) {
    if (!before(now, nextWifiRetryMs)) beginWifi(now);
    return;
  }

  wifiStatusCode = (int)WiFi.status();
  bool linked = wifiStatusCode == WL_CONNECTED;

  if (net == NET_JOINING) {
    IPAddress ip = WiFi.localIP();
    if (linked && ip != IPAddress(0, 0, 0, 0)) {
      localIp = ip;
      IPAddress mask = WiFi.subnetMask();
      broadcastIp = IPAddress(ip[0] | (uint8_t)~mask[0], ip[1] | (uint8_t)~mask[1], ip[2] | (uint8_t)~mask[2],
                              ip[3] | (uint8_t)~mask[3]);
      udpOpen = udp.begin(CMD_PORT) == 1;
      rssi = WiFi.RSSI();
      net = NET_UP;
      netPhaseMs = now;
      lastInfoMs = 0;
    } else if ((uint32_t)(now - netPhaseMs) > WIFI_JOIN_TIMEOUT_MS) {
      net = NET_FAILED;
      nextWifiRetryMs = now + WIFI_RETRY_MS;
    }
    return;
  }

  if (net == NET_UP) {
    if (!linked) {
      net = NET_LOST;
      nextWifiRetryMs = now + WIFI_RETRY_MS;
      hubKnown = false;
    } else {
      rssi = WiFi.RSSI();
    }
  }
}

bool hubFresh(uint32_t now) { return hubKnown && (uint32_t)(now - hubSeenMs) <= HUB_TIMEOUT_MS; }

// --- Commands ---------------------------------------------------------------

void setCustomLcd(const char *line, uint32_t now) {
  bool h1 = extractString(line, "l1", customL1, sizeof(customL1));
  bool h2 = extractString(line, "l2", customL2, sizeof(customL2));
  if (!h1) customL1[0] = '\0';
  if (!h2) customL2[0] = '\0';
  long r, g, b, ms;
  bool hasRgb = extractLong(line, "r", &r) && extractLong(line, "g", &g) && extractLong(line, "b", &b);
  customRgb[0] = hasRgb ? clampi((int)r, 0, 255) : -1;
  customRgb[1] = hasRgb ? clampi((int)g, 0, 255) : -1;
  customRgb[2] = hasRgb ? clampi((int)b, 0, 255) : -1;
  if (!extractLong(line, "ms", &ms)) ms = 4000;
  customSticky = ms <= 0;
  customUntil = now + (uint32_t)(ms > 0 ? ms : 0);
  customActive = customL1[0] || customL2[0] || hasRgb;
  lastLcdMs = 0;
}

void beep(uint16_t hz, uint16_t ms) { tone(buzzerPin, hz, ms); }

void handleLine(const char *line, uint32_t now) {
  char cmd[10];
  if (!extractString(line, "cmd", cmd, sizeof(cmd))) return;
  if (strcmp(cmd, "beep") == 0) {
    beep(880, 120);
  } else if (strcmp(cmd, "ident") == 0) {
    snprintf(identText, sizeof(identText), "I AM GLOVE %d", GLOVE_ID);
    identUntil = now + 4000;
    beep(1320, 150);
    lastLcdMs = 0;
  } else if (strcmp(cmd, "lcd") == 0) {
    setCustomLcd(line, now);
  } else if (strcmp(cmd, "i2c") == 0) {
    rescanI2c = true;
  }
  // "hello" needs no action here: receiving the packet is the announcement (see pollUdp).
}

void pollUdp(uint32_t now) {
  static uint32_t nextPollMs = 0;
  if (!udpOpen || before(now, nextPollMs)) return;
  nextPollMs = now + 40;
  int size = udp.parsePacket();
  if (size <= 0) return;
  hubIp = udp.remoteIP();
  hubSeenMs = now;
  hubKnown = true;
  int n = udp.read((uint8_t *)cmdBuf, sizeof(cmdBuf) - 1);
  if (n <= 0) return;
  cmdBuf[n] = '\0';
  for (char *line = strtok(cmdBuf, "\r\n"); line; line = strtok(nullptr, "\r\n")) handleLine(line, now);
}

void pollSerial(uint32_t now) {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialLen > 0) {
        serialLine[serialLen] = '\0';
        handleLine(serialLine, now);
      }
      serialLen = 0;
    } else if (serialLen + 1 < sizeof(serialLine)) {
      serialLine[serialLen++] = c;
    }
  }
}

// --- Outbound packets -------------------------------------------------------

void sendPacket(const char *buf, size_t len, uint32_t now) {
  if (net != NET_UP || !udpOpen) return;
  IPAddress dest = hubFresh(now) ? hubIp : broadcastIp;
  if (udp.beginPacket(dest, HUB_PORT) == 1) {
    udp.write((const uint8_t *)buf, len);
    udp.endPacket();
  }
}

void sendFrame(uint32_t now) {
  char buf[200];
  int n = snprintf(buf, sizeof(buf),
                   "{\"t\":\"f\",\"id\":%d,\"seq\":%lu,\"ms\":%lu,\"ax\":%d,\"ay\":%d,\"az\":%d,"
                   "\"d3\":%u,\"d7\":%u,\"d4\":%u,\"d8\":%u,\"dial\":%d,\"rssi\":%ld}",
                   GLOVE_ID, (unsigned long)seq, (unsigned long)now, axMg, ayMg, azMg, pinTouch, pinTouchAlt, pinBtn1,
                   pinBtn2, dialRaw, (long)rssi);
  if (n <= 0) return;
  sendPacket(buf, (size_t)n, now);
  if (Serial && ++serialFrameCount % SERIAL_FRAME_EVERY == 0) Serial.println(buf);
  framesThisSecond++;
  seq++;
}

void sendInfo(uint32_t now) {
  char buf[300];
  char ip[16] = "0.0.0.0";
  if (net == NET_UP) snprintf(ip, sizeof(ip), "%u.%u.%u.%u", localIp[0], localIp[1], localIp[2], localIp[3]);
  int n = snprintf(buf, sizeof(buf),
                   "{\"t\":\"i\",\"id\":%d,\"v\":%d,\"fw\":\"%s\",\"ip\":\"%s\",\"ssid\":\"%s\",\"rssi\":%ld,"
                   "\"acc\":\"%s\",\"hub\":%d,\"up\":%lu,\"fps\":%lu,\"wifi\":%d,\"i2c\":[",
                   GLOVE_ID, LCD_VARIANT, FIRMWARE_TAG, ip, WIFI_SSID, (long)rssi, accelName(), hubFresh(now) ? 1 : 0,
                   (unsigned long)(now / 1000), (unsigned long)fps, wifiStatusCode);
  for (uint8_t i = 0; i < i2cCount && n > 0 && n < (int)sizeof(buf) - 8; i++) {
    n += snprintf(buf + n, sizeof(buf) - n, "%s%u", i ? "," : "", i2cList[i]);
  }
  if (n > 0 && n < (int)sizeof(buf) - 3) n += snprintf(buf + n, sizeof(buf) - n, "]}");
  if (n <= 0) return;
  sendPacket(buf, (size_t)n, now);
  if (Serial) Serial.println(buf);
}

// --- LCD --------------------------------------------------------------------

void pad16(char *dst, const char *src) {
  size_t i = 0;
  for (; i < 16 && src[i]; i++) {
    char c = src[i];
    dst[i] = (c >= 32 && c <= 126) ? c : '?';
  }
  for (; i < 16; i++) dst[i] = ' ';
  dst[16] = '\0';
}

// What the backlight means. v4 only has a working green channel, so it stays green.
void statusColor(uint32_t now, uint8_t *rgb) {
#if LCD_VARIANT == 2
  bool bad = net == NET_FAILED || net == NET_LOST || net == NET_NO_MODULE ||
             (accelKind == ACCEL_NONE && now > 4000);
  if (bad) {
    rgb[0] = 255; rgb[1] = 0; rgb[2] = 0;       // red: error or not connected
  } else if (net == NET_UP && hubFresh(now)) {
    rgb[0] = 0; rgb[1] = 255; rgb[2] = 0;       // green: all good
  } else {
    rgb[0] = 255; rgb[1] = 90; rgb[2] = 0;      // orange: connecting or waiting for the hub
  }
#else
  (void)now;
  rgb[0] = 0; rgb[1] = 255; rgb[2] = 0;
#endif
}

void composeLcd(uint32_t now, char *l1, char *l2, uint8_t *rgb) {
  statusColor(now, rgb);
  char a[40], b[40];
  a[0] = b[0] = '\0';

  if (before(now, identUntil)) {
    snprintf(a, sizeof(a), "%s", identText);
    snprintf(b, sizeof(b), "V%d %s", LCD_VARIANT, FIRMWARE_TAG);
  } else if (customActive && (customSticky || before(now, customUntil))) {
    snprintf(a, sizeof(a), "%s", customL1);
    snprintf(b, sizeof(b), "%s", customL2);
    if (customRgb[0] >= 0) {
      rgb[0] = (uint8_t)customRgb[0];
      rgb[1] = (uint8_t)customRgb[1];
      rgb[2] = (uint8_t)customRgb[2];
    }
  } else if (net == NET_NO_MODULE) {
    snprintf(a, sizeof(a), "G%d NO WIFI CHIP", GLOVE_ID);
    snprintf(b, sizeof(b), "check board");
  } else if (net == NET_JOINING) {
    snprintf(a, sizeof(a), "G%d WIFI JOINING", GLOVE_ID);
    snprintf(b, sizeof(b), "%s %lus", WIFI_SSID, (unsigned long)((now - netPhaseMs) / 1000));
  } else if (net == NET_FAILED || net == NET_LOST) {
    snprintf(a, sizeof(a), "G%d WIFI %s", GLOVE_ID, net == NET_FAILED ? "FAILED" : "LOST");
    int wait = (int)((int32_t)(nextWifiRetryMs - now) / 1000);
    snprintf(b, sizeof(b), "st=%d retry %ds", wifiStatusCode, wait < 0 ? 0 : wait);
  } else {
    switch (lcdPage) {
      case 0:
        snprintf(a, sizeof(a), "%u.%u.%u.%u", localIp[0], localIp[1], localIp[2], localIp[3]);
        snprintf(b, sizeof(b), "G%d V%d %s", GLOVE_ID, LCD_VARIANT, hubFresh(now) ? "HUB OK" : "NO HUB");
        break;
      case 1:
        snprintf(a, sizeof(a), "%s", WIFI_SSID);
        snprintf(b, sizeof(b), "RSSI %ld dBm", (long)rssi);
        break;
      case 2:
        snprintf(a, sizeof(a), "ACC %s", accelName());
        snprintf(b, sizeof(b), "X%+03d Y%+03d Z%+03d", axMg / 10, ayMg / 10, azMg / 10);
        break;
      default:
        snprintf(a, sizeof(a), "T%u%u B%u%u", pinTouch, pinTouchAlt, pinBtn1, pinBtn2);
        snprintf(b, sizeof(b), "DIAL %d %luHz", dialRaw, (unsigned long)fps);
        break;
    }
  }
  pad16(l1, a);
  pad16(l2, b);
}

void pushLcd(uint32_t now) {
  char lines[2][17];
  uint8_t rgb[3];
  composeLcd(now, lines[0], lines[1], rgb);
  for (uint8_t row = 0; row < 2; row++) {
    if (strcmp(lines[row], lcdShown[row]) == 0) continue;
    lcd.setCursor(0, row);
    lcd.print(lines[row]);
    memcpy(lcdShown[row], lines[row], 17);
  }
  if (rgb[0] != rgbShown[0] || rgb[1] != rgbShown[1] || rgb[2] != rgbShown[2]) {
    lcd.setRGB(rgb[0], rgb[1], rgb[2]);
    rgbShown[0] = rgb[0];
    rgbShown[1] = rgb[1];
    rgbShown[2] = rgb[2];
  }
}

void serviceLcd(uint32_t now) {
  if (!lcdReady) return;
  if (!before(now, pageStartMs + LCD_PAGE_MS)) {
    pageStartMs = now;
    lcdPage = (lcdPage + 1) % LCD_PAGES;
  }
  // Button 1 steps to the next page right away.
  bool b1 = pinBtn1 != 0;
  if (b1 && !lastBtn1) {
    pageStartMs = now;
    lcdPage = (lcdPage + 1) % LCD_PAGES;
    lastLcdMs = 0;
  }
  lastBtn1 = b1;
  if ((uint32_t)(now - lastLcdMs) < LCD_REFRESH_MS) return;
  lastLcdMs = now;
  pushLcd(now);
}

// --- Arduino entry points ---------------------------------------------------

void setup() {
  pinMode(touchPin, INPUT);
  pinMode(touchAltPin, INPUT);
  pinMode(button1Pin, INPUT);
  pinMode(button2Pin, INPUT);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);
  analogReadResolution(10);

  Wire.begin();
  Wire.setClock(100000);
  Serial.begin(SERIAL_BAUD);  // no wait: output is dropped when no host is attached

  lcd.begin(16, 2, LCD_5x8DOTS, Wire);
  lcdReady = true;
  memset(lcdShown, 0, sizeof(lcdShown));
  uint8_t rgb[3];
  statusColor(millis(), rgb);
  lcd.setRGB(rgb[0], rgb[1], rgb[2]);
  char l1[17], l2[17];
  pad16(l1, "");
  snprintf(cmdBuf, sizeof(cmdBuf), "G%d V%d BOOT", GLOVE_ID, LCD_VARIANT);
  pad16(l1, cmdBuf);
  pad16(l2, FIRMWARE_TAG);
  lcd.setCursor(0, 0);
  lcd.print(l1);
  lcd.setCursor(0, 1);
  lcd.print(l2);

  scanI2c();
  rescanI2c = false;
  beginWifi(millis());
  lastFrameMs = millis();
  pageStartMs = millis();
}

void loop() {
  uint32_t now = millis();
  serviceWifi(now);
  pollUdp(now);
  pollSerial(now);

  if (rescanI2c) {
    rescanI2c = false;
    scanI2c();
  }

  if ((uint32_t)(now - lastFrameMs) >= FRAME_MS) {
    lastFrameMs = now;
    readInputs();
    sampleAccel(now);
    sendFrame(now);
  }

  if ((uint32_t)(now - lastInfoMs) >= INFO_MS) {
    lastInfoMs = now;
    fps = framesThisSecond;
    framesThisSecond = 0;
    sendInfo(now);
  }

  serviceLcd(now);
}
