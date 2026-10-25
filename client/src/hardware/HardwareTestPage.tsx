import { useId, useState } from 'react';
import {
  ELEMENT_META,
  GLOVE_LCD_COLS,
  GLOVE_POLL_HZ,
  GLOVE_UDP_PORT,
  NOISE_TOO_LOUD_THRESHOLD,
  P0_ELEMENTS,
  SERIAL_BAUD,
  SERVO_ANGLE,
} from '@once-upon/shared';
import type { BuzzPattern } from '@once-upon/shared';
import { GloveLcdScreen, GloveSimulatorPanel } from './GloveSimulatorPanel';
import { buildLcdCommand, buildWifiCommand, fitLcdLine, previewGloveLcd, type GloveLcdMessage } from './serialProtocol';
import { SERIAL_BRIDGE_URL, SIMULATOR_HOTKEYS, useGloveHardware, type GloveHardwareController } from './useGloveHardware';
import { DEBUG_HARDWARE_PATH } from '../debugRoutes';

/** The legacy `/hardware-test` URL redirects here. */
export const HARDWARE_TEST_PATH = DEBUG_HARDWARE_PATH;

const BUZZ_PATTERNS: readonly BuzzPattern[] = ['tick', 'cast', 'fizzle', 'hit'];

type PortId = 'D3' | 'D4' | 'D8' | 'D5' | 'A0' | 'I2C LCD' | 'I2C Accel';

const PORTS: readonly {
  id: PortId;
  bus: 'Analog' | 'Digital' | 'I2C';
  part: string;
  role: string;
}[] = [
  { id: 'D3', bus: 'Digital', part: 'Grove Touch Sensor', role: 'Palm, under the thumb. Parries an incoming projectile (chirps).' },
  { id: 'D4', bus: 'Digital', part: 'Grove Button 1', role: 'Hold for push-to-talk. The LCD shows SPEAKING.' },
  { id: 'D8', bus: 'Digital', part: 'Grove Button 2', role: 'Click locks the element under the dial; hold 250 ms charges the spell (fist).' },
  { id: 'D5', bus: 'Digital', part: 'Grove Buzzer', role: 'Dial tick, press chirps, and the cast / fizzle / hit melodies.' },
  { id: 'A0', bus: 'Analog', part: 'Grove Rotary Angle Sensor', role: 'Spell wheel. 10-bit angle mapped to slot 0 Ember, 1 Frost, 2 Bloom.' },
  { id: 'I2C LCD', bus: 'I2C', part: 'Grove 16x2 RGB LCD', role: 'Forearm. Text at 0x3E, RGB backlight at 0x62 (v4) or 0x30 (v5).' },
  { id: 'I2C Accel', bus: 'I2C', part: 'Grove 3-Axis Accelerometer', role: 'Back of the hand. LIS3DHTR, ADXL345, or MMA7660: swipe, thrust, and power.' },
];

const LCD_PRESETS: readonly { label: string; rgb: readonly [number, number, number] }[] = [
  { label: 'Ember', rgb: [255, 80, 0] },
  { label: 'Frost', rgb: [30, 180, 255] },
  { label: 'Bloom', rgb: [40, 255, 110] },
  { label: 'Gold', rgb: [255, 215, 0] },
  { label: 'Danger', rgb: [255, 0, 40] },
  { label: 'White', rgb: [255, 255, 255] },
];

/**
 * Diagnostic bench for the Enchanted Glove.
 * Mount at {@link HARDWARE_TEST_PATH}. Keyboard, on-screen sensors, Web Serial, and the local bridge share one controller.
 */
export function HardwareTestPage() {
  const hardware = useGloveHardware();
  const bridgeId = useId();

  return (
    <main
      className="min-h-screen text-[#f6ecd8]"
      style={{ background: 'radial-gradient(ellipse at top, #3c2616 0%, #100c09 58%)' }}
    >
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <header className="max-w-3xl">
          <p className="text-[11px] uppercase tracking-[0.32em] text-[#e6c35c]/80">Once Upon a Memory · {HARDWARE_TEST_PATH}</p>
          <h1 className="mt-2 font-serif text-4xl sm:text-5xl">Enchanted Glove bench</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#f0ddb4]/85">
            Arduino Uno R4 WiFi under a Grove Base Shield V2, VCC at 5V, with seven parts: D3 touch, D4 and D8 buttons,
            D5 buzzer, A0 rotary dial, and an I2C accelerometer and 16x2 RGB LCD. Frames leave the board at {GLOVE_POLL_HZ} Hz
            over USB-C at {SERIAL_BAUD} baud, or over Wi-Fi UDP port {GLOVE_UDP_PORT} through the bridge.
          </p>
        </header>

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
          <GloveSimulatorPanel hardware={hardware} placement="dock" />

          <div className="space-y-6">
            <section className={cardClass} data-testid="port-map">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="font-serif text-2xl">Grove port map</h2>
                  <p className="text-xs text-[#d9c4a4]/75">
                    D3 · D4 · D8 · D5 · A0 · two of the four parallel I2C sockets on Wire. Live cells follow the current frame.
                  </p>
                </div>
                <p className="font-mono text-[11px] text-[#e6c35c]">
                  {P0_ELEMENTS.map((id) => ELEMENT_META[id].label).join(' · ')}
                </p>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {PORTS.map((port) => (
                  <article
                    key={port.id}
                    className={`rounded-2xl border px-3 py-3 ${
                      portHot(port.id, hardware) ? 'border-[#e6c35c] bg-[#3a2c16]' : 'border-[#8a6a3b]/35 bg-[#140f0c]/60'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-mono text-sm text-[#e6c35c]">{port.id}</h3>
                      <span className="text-[10px] uppercase tracking-[0.16em] text-[#d9c4a4]/60">{port.bus}</span>
                    </div>
                    <p className="mt-1 text-sm">{port.part}</p>
                    <p className="mt-1 text-xs leading-relaxed text-[#d9c4a4]/75">{port.role}</p>
                    <p className="mt-2 font-mono text-[11px] text-[#f6ecd8]/90">{portReadout(port.id, hardware)}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className={cardClass}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-serif text-2xl">50 Hz stream</h2>
                  <p className="text-xs text-[#d9c4a4]/75">
                    Newline-delimited JSON in, and the hardware event the server receives. Gate at {NOISE_TOO_LOUD_THRESHOLD}.
                  </p>
                </div>
                <p className="font-mono text-sm text-[#e6c35c]" data-testid="sample-rate">
                  {hardware.sampleHz.toFixed(1)} Hz · {hardware.frameCount} frames
                </p>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[#e6c35c]/80">Latest wire frame</p>
                  <pre className="mt-2 overflow-x-auto rounded-2xl bg-[#100c09] p-3 font-mono text-[11px] leading-relaxed text-[#f3e6c8]">
                    {JSON.stringify(hardware.frame, null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[#e6c35c]/80">hardware:event</p>
                  <pre className="mt-2 overflow-x-auto rounded-2xl bg-[#100c09] p-3 font-mono text-[11px] leading-relaxed text-[#f3e6c8]">
                    {JSON.stringify(hardware.event, null, 2)}
                  </pre>
                </div>
              </div>
              <p className="mt-3 text-[10px] uppercase tracking-[0.18em] text-[#e6c35c]/80">Serial monitor</p>
              <pre
                data-testid="serial-stream"
                className="mt-2 max-h-40 overflow-auto rounded-2xl bg-[#100c09] p-3 font-mono text-[11px] leading-relaxed text-[#c8f7c5]"
              >
                {hardware.recentLines.length > 0 ? hardware.recentLines.join('\n') : 'Waiting for the first frame…'}
              </pre>
            </section>

            <LcdComposer hardware={hardware} />

            <WifiSetup hardware={hardware} />

            <section className={cardClass}>
              <h2 className="font-serif text-2xl">Buzzer and storybook</h2>
              <p className="mt-1 text-xs text-[#d9c4a4]/75">
                Commands go to the board when a link is open, and the laptop synthesizer plays them either way. No servo is
                wired in the 7-part kit, so the storybook command shows a notice on the LCD.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {BUZZ_PATTERNS.map((pattern) => (
                  <button key={pattern} type="button" className={commandClass} onClick={() => hardware.playBuzz(pattern)}>
                    Buzz {pattern}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={commandClass} onClick={() => hardware.setServoOpen(false)}>
                  Servo closed {SERVO_ANGLE.closed}°
                </button>
                <button type="button" className={commandClass} onClick={() => hardware.setServoOpen(true)}>
                  Servo open {SERVO_ANGLE.open}°
                </button>
              </div>
              <p className="mt-3 font-mono text-[11px] text-[#d9c4a4]/80">
                Last command {hardware.lastCommand ?? '—'}
              </p>
            </section>

            <section className={cardClass}>
              <h2 className="font-serif text-2xl">Link</h2>
              <p className="mt-1 text-xs leading-relaxed text-[#d9c4a4]/75">
                Chrome and Edge talk to the Uno directly. Other browsers, and a glove on Wi-Fi, use the local bridge at{' '}
                {SERIAL_BRIDGE_URL} (run it with <code className="font-mono">--udp &lt;arduino-ip&gt;</code> for wireless).
                With no board attached, the keyboard is the glove.
              </p>
              <label htmlFor={bridgeId} className="mt-3 block text-[10px] uppercase tracking-[0.18em] text-[#e6c35c]/80">
                Bridge URL
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  id={bridgeId}
                  value={hardware.bridgeUrl}
                  onChange={(event) => hardware.setBridgeUrl(event.target.value)}
                  spellCheck={false}
                  className="w-full rounded-xl border border-[#8a6a3b]/50 bg-[#100c09] px-3 py-2 font-mono text-sm text-[#f6ecd8] outline-none focus:border-[#e6c35c]"
                />
                <button type="button" className={commandClass} onClick={() => hardware.connectBridge(hardware.bridgeUrl)}>
                  Connect bridge
                </button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-[#f0ddb4]">
                <input
                  type="checkbox"
                  checked={hardware.keyboardEnabled}
                  onChange={(event) => hardware.setKeyboardEnabled(event.target.checked)}
                  className="accent-[#e6c35c]"
                />
                Keyboard hotkeys in simulator mode
              </label>
            </section>

            <section className={cardClass} data-testid="shortcut-guide">
              <h2 className="font-serif text-2xl">Keyboard</h2>
              <p className="mt-1 text-xs text-[#d9c4a4]/75">Click away from a slider or the bridge field, then play the Spellbearer.</p>
              <dl className="mt-3 space-y-2">
                {SIMULATOR_HOTKEYS.map((binding) => (
                  <div key={binding.keys} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
                    <dt>
                      <kbd className="inline-block rounded-lg border border-[#8a6a3b]/60 bg-[#100c09] px-2 py-1 font-mono text-[11px] text-[#f6ecd8]">
                        {binding.keys}
                      </kbd>
                    </dt>
                    <dd className="text-sm text-[#f0ddb4]/90">{binding.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

const cardClass = 'rounded-3xl border border-[#8a6a3b]/45 bg-[#1b140f]/88 p-4 shadow-[inset_0_1px_0_rgba(255,220,160,0.06)] sm:p-5';
const commandClass =
  'rounded-xl border border-[#8a6a3b]/50 bg-[#140f0c] px-3 py-2 text-sm text-[#f6ecd8] hover:border-[#e6c35c]';

const inputClass =
  'w-full rounded-xl border border-[#8a6a3b]/50 bg-[#100c09] px-3 py-2 font-mono text-sm text-[#f6ecd8] outline-none focus:border-[#e6c35c]';
const labelClass = 'block text-[10px] uppercase tracking-[0.18em] text-[#e6c35c]/80';

const LCD_HOLD_OPTIONS: readonly { label: string; ms: number }[] = [
  { label: '4 s', ms: 4000 },
  { label: '10 s', ms: 10000 },
  { label: 'Until replaced', ms: 0 },
];

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function fromHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1] ?? '0', 16), parseInt(match[2] ?? '0', 16), parseInt(match[3] ?? '0', 16)];
}

function LcdComposer({ hardware }: { hardware: GloveHardwareController }) {
  const l1Id = useId();
  const l2Id = useId();
  const colorId = useId();
  const [l1, setL1] = useState('WARD SHATTERED!');
  const [l2, setL2] = useState('TWIN CAST 2.0x');
  const [rgb, setRgb] = useState<[number, number, number]>([255, 80, 0]);
  const [useRgb, setUseRgb] = useState(true);
  const [holdMs, setHoldMs] = useState(4000);

  const draft: GloveLcdMessage = { l1, l2, rgb: useRgb ? rgb : undefined, ms: holdMs };
  const preview = previewGloveLcd(hardware.frame, { custom: draft, lockedElement: hardware.lockedElement });
  const wire = JSON.stringify(buildLcdCommand(draft));
  const setChannel = (index: 0 | 1 | 2, value: number) => {
    const next: [number, number, number] = [...rgb];
    next[index] = Math.round(Math.min(255, Math.max(0, Number.isFinite(value) ? value : 0)));
    setRgb(next);
  };

  return (
    <section className={cardClass} data-testid="lcd-composer">
      <h2 className="font-serif text-2xl">Forearm 16x2 LCD</h2>
      <p className="mt-1 text-xs leading-relaxed text-[#d9c4a4]/75">
        Custom text and RGB backlight. The preview follows the live frame: PARRY, SPEAKING, and DISARMED still take line 2
        on the board, just as they do here. Printable ASCII only, {GLOVE_LCD_COLS} characters per line.
      </p>

      <GloveLcdScreen preview={preview} className="mt-4" />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={l1Id} className={labelClass}>
            Line 1 · {fitLcdLine(l1).length}/{GLOVE_LCD_COLS}
          </label>
          <input
            id={l1Id}
            value={l1}
            maxLength={GLOVE_LCD_COLS}
            spellCheck={false}
            onChange={(event) => setL1(event.target.value)}
            className={`mt-2 ${inputClass}`}
          />
        </div>
        <div>
          <label htmlFor={l2Id} className={labelClass}>
            Line 2 · {fitLcdLine(l2).length}/{GLOVE_LCD_COLS}
          </label>
          <input
            id={l2Id}
            value={l2}
            maxLength={GLOVE_LCD_COLS}
            spellCheck={false}
            onChange={(event) => setL2(event.target.value)}
            className={`mt-2 ${inputClass}`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm text-[#f0ddb4]">
          <input type="checkbox" checked={useRgb} onChange={(event) => setUseRgb(event.target.checked)} className="accent-[#e6c35c]" />
          Custom backlight
        </label>
        <div>
          <label htmlFor={colorId} className={labelClass}>
            Color
          </label>
          <input
            id={colorId}
            type="color"
            value={toHex(rgb)}
            disabled={!useRgb}
            onChange={(event) => {
              const next = fromHex(event.target.value);
              if (next) setRgb(next);
            }}
            className="mt-2 h-9 w-14 cursor-pointer rounded-lg border border-[#8a6a3b]/50 bg-[#100c09] disabled:opacity-40"
          />
        </div>
        {(['R', 'G', 'B'] as const).map((channel, index) => (
          <label key={channel} className="w-16">
            <span className={labelClass}>{channel}</span>
            <input
              type="number"
              min={0}
              max={255}
              value={rgb[index]}
              disabled={!useRgb}
              onChange={(event) => setChannel(index as 0 | 1 | 2, Number(event.target.value))}
              className={`mt-2 ${inputClass} px-2 disabled:opacity-40`}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {LCD_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            disabled={!useRgb}
            onClick={() => setRgb([...preset.rgb])}
            className="flex items-center gap-1.5 rounded-full border border-[#8a6a3b]/40 px-2 py-1 text-[11px] disabled:opacity-40"
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: toHex(preset.rgb) }} />
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={labelClass}>Hold</span>
        {LCD_HOLD_OPTIONS.map((option) => (
          <button
            key={option.ms}
            type="button"
            aria-pressed={holdMs === option.ms}
            onClick={() => setHoldMs(option.ms)}
            className={`rounded-full border px-2 py-1 text-[11px] ${
              holdMs === option.ms ? 'border-[#f6ecd8] bg-[#3a2a1c]' : 'border-[#8a6a3b]/40'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={commandClass} onClick={() => hardware.sendLcd(draft)}>
          Send to LCD
        </button>
        <button type="button" className={commandClass} onClick={() => hardware.clearLcd()}>
          Clear LCD
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-[11px] text-[#d9c4a4]/80">{wire}</p>
    </section>
  );
}

function WifiSetup({ hardware }: { hardware: GloveHardwareController }) {
  const ssidId = useId();
  const passId = useId();
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const status = hardware.wifiStatus;
  const linked = hardware.mode !== 'simulator' && hardware.status === 'connected';
  const masked = JSON.stringify(buildWifiCommand(ssid, pass ? '•'.repeat(Math.min(pass.length, 63)) : ''));

  return (
    <section className={cardClass} data-testid="wifi-setup">
      <h2 className="font-serif text-2xl">Arduino Wi-Fi hotspot</h2>
      <p className="mt-1 text-xs leading-relaxed text-[#d9c4a4]/75">
        Sends the hotspot credentials over the open USB link. The board joins in the background, shows its IP on the LCD,
        and listens on UDP {GLOVE_UDP_PORT}. Credentials live in RAM only, so send them again after a power cycle.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={ssidId} className={labelClass}>
            SSID
          </label>
          <input
            id={ssidId}
            value={ssid}
            maxLength={32}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setSsid(event.target.value)}
            className={`mt-2 ${inputClass}`}
          />
        </div>
        <div>
          <label htmlFor={passId} className={labelClass}>
            Password
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id={passId}
              type={showPass ? 'text' : 'password'}
              value={pass}
              maxLength={63}
              autoComplete="off"
              onChange={(event) => setPass(event.target.value)}
              className={inputClass}
            />
            <button type="button" className={commandClass} onClick={() => setShowPass(!showPass)}>
              {showPass ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${commandClass} disabled:opacity-40`}
          disabled={!ssid.trim()}
          onClick={() => hardware.configureWifi(ssid, pass)}
        >
          Join hotspot
        </button>
        <button type="button" className={commandClass} onClick={() => hardware.requestWifiStatus()}>
          Ask Wi-Fi status
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-[11px] text-[#d9c4a4]/80">{masked}</p>
      {!linked ? (
        <p className="mt-2 text-xs text-[#f0ddb4]/80">Open Web Serial or the bridge on the USB port first.</p>
      ) : null}
      <p className="mt-3 font-mono text-sm" data-testid="wifi-status">
        {status
          ? `${status.status}${status.ssid ? ` · ${status.ssid}` : ''}${
              status.status === 'connected' ? ` · ${status.ip}:${status.port}` : ''
            }`
          : 'No report yet'}
      </p>
      {status?.status === 'connected' ? (
        <pre className="mt-2 overflow-x-auto rounded-2xl bg-[#100c09] p-3 font-mono text-[11px] text-[#c8f7c5]">
          {`node --experimental-strip-types firmware/serial-bridge.ts --udp ${status.ip}`}
        </pre>
      ) : null}
    </section>
  );
}

function portHot(id: PortId, hardware: GloveHardwareController): boolean {
  const frame = hardware.frame;
  switch (id) {
    case 'D3':
      return (frame.d3 ?? 0) !== 0 || frame.parry || hardware.parryLit;
    case 'D4':
      return (frame.d4 ?? 0) !== 0 || frame.btn !== 0 || hardware.pushToTalk;
    case 'D8':
      return (frame.d8 ?? 0) !== 0 || (frame.btn2 ?? 0) !== 0 || frame.fist;
    case 'D5':
      return hardware.lastCommand?.includes('"cmd":"buzz"') ?? false;
    case 'A0':
      return frame.armed;
    case 'I2C LCD':
      return hardware.lcdMessage !== null;
    case 'I2C Accel':
      return frame.swipe !== 'none';
  }
}

function portReadout(id: PortId, hardware: GloveHardwareController): string {
  const frame = hardware.frame;
  const level = (raw: number | undefined) => (raw === undefined ? '' : raw !== 0 ? 'HIGH · ' : 'LOW · ');
  switch (id) {
    case 'D3':
      return `${level(frame.d3)}${frame.parry ? 'parry' : 'clear'}`;
    case 'D4':
      return `${level(frame.d4)}${hardware.pushToTalk ? 'talking' : frame.btn !== 0 ? 'down' : 'up'}`;
    case 'D8':
      return `${level(frame.d8)}${frame.fist ? 'charged' : (frame.btn2 ?? 0) !== 0 ? 'locked' : 'up'}`;
    case 'D5':
      return hardware.lastCommand?.includes('"cmd":"buzz"') ? (hardware.lastCommand ?? 'quiet') : 'quiet';
    case 'A0':
      return frame.rawDial !== undefined ? `${frame.rawDial} → slot ${frame.dial}` : `slot ${frame.dial}`;
    case 'I2C LCD': {
      const lines = previewGloveLcd(frame, { custom: hardware.lcdMessage, lockedElement: hardware.lockedElement }).lines;
      return `${lines[0].trimEnd()} | ${lines[1].trimEnd()}`;
    }
    case 'I2C Accel':
      return `${frame.swipe} · ${frame.accel.toFixed(2)}×`;
  }
}
