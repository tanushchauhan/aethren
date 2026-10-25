import { useId } from 'react';
import {
  ELEMENT_META,
  GLOVE_POLL_HZ,
  NOISE_TOO_LOUD_THRESHOLD,
  P0_ELEMENTS,
  SERIAL_BAUD,
  SERVO_ANGLE,
} from '@once-upon/shared';
import type { BuzzPattern } from '@once-upon/shared';
import { GloveSimulatorPanel } from './GloveSimulatorPanel';
import { SERIAL_BRIDGE_URL, SIMULATOR_HOTKEYS, useGloveHardware, type GloveHardwareController } from './useGloveHardware';
import { DEBUG_HARDWARE_PATH } from '../debugRoutes';

/** The legacy `/hardware-test` URL redirects here. */
export const HARDWARE_TEST_PATH = DEBUG_HARDWARE_PATH;

const BUZZ_PATTERNS: readonly BuzzPattern[] = ['tick', 'cast', 'fizzle', 'hit'];

const PORTS: readonly {
  id: string;
  bus: 'Analog' | 'Digital' | 'I2C';
  part: string;
  role: string;
}[] = [
  { id: 'A0', bus: 'Analog', part: 'Grove Rotary Angle Sensor', role: 'Forearm band. 10-bit angle mapped to spell-wheel slot 0–2.' },
  { id: 'A1', bus: 'Analog', part: 'Grove Light Sensor', role: 'Palm. A closed fist covers it and charges the spell.' },
  { id: 'A2', bus: 'Analog', part: 'Grove Sound Sensor', role: 'Table by Laptop A. Raises the mic gate when the room is too loud.' },
  { id: 'D2', bus: 'Digital', part: 'Grove Button', role: 'Side of the index finger. Click locks an element; hold opens push-to-talk.' },
  { id: 'D3', bus: 'Digital', part: 'Grove Touch Sensor', role: 'Palm, under the thumb. Parries a projectile.' },
  { id: 'D4', bus: 'Digital', part: 'Grove Switch', role: 'Forearm band. Arms and disarms the glove, camera, and mic.' },
  { id: 'D5', bus: 'Digital', part: 'Grove Buzzer', role: 'Forearm band. Tick, cast, fizzle, and hit.' },
  { id: 'D6', bus: 'Digital', part: 'Grove Servo', role: 'Table prop. Opens the storybook when the boss ward breaks.' },
  { id: 'I2C 1', bus: 'I2C', part: 'Grove 3-Axis Accelerometer', role: 'Back of the hand. Confirms swipe or thrust and scales power.' },
  { id: 'I2C 2', bus: 'I2C', part: 'Grove I2C Color Sensor', role: 'Token well. The memory card held here becomes the boss.' },
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
            Arduino Uno R4 WiFi under a Grove Base Shield V2, VCC at 5V. The shield covers the onboard LED matrix,
            so every cue goes through the Grove buzzer and the storybook servo. Frames leave the board at {GLOVE_POLL_HZ} Hz
            over USB-C at {SERIAL_BAUD} baud.
          </p>
        </header>

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
          <GloveSimulatorPanel hardware={hardware} placement="dock" />

          <div className="space-y-6">
            <section className={cardClass} data-testid="port-map">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="font-serif text-2xl">Grove port map</h2>
                  <p className="text-xs text-[#d9c4a4]/75">A0–A2 · D2–D6 · four parallel I2C sockets on Wire. Live cells follow the current frame.</p>
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

            <section className={cardClass}>
              <h2 className="font-serif text-2xl">Buzzer and servo</h2>
              <p className="mt-1 text-xs text-[#d9c4a4]/75">
                Commands go to the board when a link is open, and the laptop synthesizer plays them either way.
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
                Chrome and Edge talk to the Uno directly. Other browsers use the local serial bridge at {SERIAL_BRIDGE_URL}.
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

function portHot(id: string, hardware: GloveHardwareController): boolean {
  const frame = hardware.frame;
  switch (id) {
    case 'A0':
      return frame.armed;
    case 'A1':
      return frame.fist;
    case 'A2':
      return frame.noise >= NOISE_TOO_LOUD_THRESHOLD;
    case 'D2':
      return frame.btn !== 0 || hardware.pushToTalk;
    case 'D3':
      return frame.parry || hardware.parryLit;
    case 'D4':
      return frame.armed;
    case 'D5':
      return hardware.lastCommand?.includes('"cmd":"buzz"') ?? false;
    case 'D6':
      return hardware.servoOpen;
    case 'I2C 1':
      return frame.swipe !== 'none';
    case 'I2C 2':
      return frame.color !== 'none';
    default:
      return false;
  }
}

function portReadout(id: string, hardware: GloveHardwareController): string {
  const frame = hardware.frame;
  switch (id) {
    case 'A0':
      return `slot ${frame.dial}`;
    case 'A1':
      return frame.fist ? 'covered' : 'lit';
    case 'A2':
      return String(frame.noise);
    case 'D2':
      return frame.btn !== 0 ? 'down' : 'up';
    case 'D3':
      return frame.parry ? 'touch' : 'clear';
    case 'D4':
      return frame.armed ? 'armed' : 'safe';
    case 'D5':
      return hardware.lastCommand?.includes('"cmd":"buzz"') ? (hardware.lastCommand ?? 'quiet') : 'quiet';
    case 'D6':
      return `${hardware.servoAngle}°`;
    case 'I2C 1':
      return `${frame.swipe} · ${frame.accel.toFixed(2)}×`;
    case 'I2C 2':
      return frame.color;
    default:
      return '';
  }
}
