import { useState } from 'react';
import type { BuzzPattern } from '@once-upon/shared';
import { GLOVE_LCD_COLS } from '@once-upon/shared';
import { elementForDialSlot, type GloveLcdMessage } from './serialProtocol';
import { SERIAL_BRIDGE_URL, useGloveHardware } from './useGloveHardware';
import { DEBUG_HARDWARE_PATH } from '../debugRoutes';

/** The legacy `/hardware-test` URL redirects here. */
export const HARDWARE_TEST_PATH = DEBUG_HARDWARE_PATH;

const BUZZ: readonly BuzzPattern[] = ['tick', 'cast', 'fizzle', 'hit'];
const DIAL_LABEL = ['Ember', 'Frost', 'Bloom'] as const;
const LCD_COLORS = {
  Orange: [255, 80, 0] as const,
  Blue: [30, 180, 255] as const,
  Green: [40, 255, 110] as const,
};

export function HardwareTestPage() {
  const hardware = useGloveHardware();
  const { frame, mode, status, error } = hardware;
  const connected = status === 'connected';
  const [l1, setL1] = useState('HELLO');
  const [l2, setL2] = useState('GLOVE');
  const [lcdRgb, setLcdRgb] = useState<readonly [number, number, number]>(LCD_COLORS.Orange);

  const statusLabel =
    mode === 'web-serial' && connected
      ? 'Connected: USB Serial'
      : mode === 'ws-bridge' && connected
        ? 'Connected: Bridge'
        : 'Not connected';

  const disconnect = () => {
    if (mode === 'web-serial') void hardware.disconnectSerial();
    else if (mode === 'ws-bridge') hardware.disconnectBridge();
  };

  const sendLcd = () => {
    const msg: GloveLcdMessage = { l1: l1.slice(0, GLOVE_LCD_COLS), l2: l2.slice(0, GLOVE_LCD_COLS), rgb: [...lcdRgb] };
    hardware.sendLcd(msg);
  };

  const dialName = elementForDialSlot(frame.dial);
  const rawDial = frame.rawDial ?? 0;

  return (
    <main className="flex min-h-screen flex-col bg-[#0f0d0b] px-4 py-5 text-[#f6ecd8]">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4">
        {/* 1 — Connect bar */}
        <section className="rounded-2xl border border-[#5a4a32]/50 bg-[#1a1510] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!hardware.webSerialSupported || connected}
              onClick={() => void hardware.connectSerial()}
              className="rounded-xl bg-emerald-700 px-5 py-3 text-base font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              🔌 Connect USB Arduino
            </button>
            <button
              type="button"
              disabled={connected}
              onClick={() => hardware.connectBridge(SERIAL_BRIDGE_URL)}
              className="rounded-xl bg-amber-700 px-5 py-3 text-base font-semibold text-white hover:bg-amber-600 disabled:opacity-40"
            >
              📡 Connect Bridge ({SERIAL_BRIDGE_URL})
            </button>
            {connected ? (
              <button type="button" onClick={disconnect} className="rounded-xl border border-[#8a6a3b]/60 px-4 py-3 text-sm hover:border-[#e6c35c]">
                Disconnect
              </button>
            ) : null}
            <span
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                connected ? 'bg-emerald-900/80 text-emerald-200' : 'bg-[#2a2218] text-[#a89878]'
              }`}
            >
              {statusLabel}
            </span>
          </div>
          {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        </section>

        {/* 2 — Live inputs */}
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <InputBox
            label="D3 Touch"
            active={(frame.d3 ?? 0) !== 0}
            value={(frame.d3 ?? 0) !== 0 ? 'HIGH (TOUCHED)' : 'LOW'}
          />
          <InputBox
            label="D4 Button 1"
            active={(frame.d4 ?? 0) !== 0 || frame.btn !== 0}
            value={(frame.d4 ?? 0) !== 0 || frame.btn !== 0 ? 'HIGH (PRESSED)' : 'LOW'}
          />
          <InputBox
            label="D8 Button 2"
            active={(frame.d8 ?? 0) !== 0 || (frame.btn2 ?? 0) !== 0}
            value={(frame.d8 ?? 0) !== 0 || (frame.btn2 ?? 0) !== 0 ? 'HIGH (PRESSED)' : 'LOW'}
          />
          <InputBox
            label="A0 Rotary Dial"
            active={frame.armed}
            value={`${frame.dial} (${DIAL_LABEL[frame.dial] ?? dialName ?? '?'}) · ${rawDial}`}
          />
          <InputBox
            label="I2C Accelerometer"
            active={frame.swipe !== 'none'}
            value={`swipe: ${frame.swipe} · accel: ${frame.accel.toFixed(2)}x`}
          />
        </section>

        {/* 3 — Outputs */}
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-[#5a4a32]/50 bg-[#1a1510] p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[#e6c35c]/90">Buzzer (D5)</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {BUZZ.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => hardware.playBuzz(p)}
                  className="rounded-lg border border-[#8a6a3b]/50 px-4 py-2 capitalize hover:border-[#e6c35c]"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-[#5a4a32]/50 bg-[#1a1510] p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[#e6c35c]/90">LCD (I2C)</h2>
            <div className="mt-2 flex flex-col gap-2">
              <input
                value={l1}
                maxLength={GLOVE_LCD_COLS}
                onChange={(e) => setL1(e.target.value)}
                placeholder="Line 1"
                className="rounded-lg border border-[#8a6a3b]/50 bg-[#100c09] px-3 py-2 font-mono text-sm outline-none focus:border-[#e6c35c]"
              />
              <input
                value={l2}
                maxLength={GLOVE_LCD_COLS}
                onChange={(e) => setL2(e.target.value)}
                placeholder="Line 2"
                className="rounded-lg border border-[#8a6a3b]/50 bg-[#100c09] px-3 py-2 font-mono text-sm outline-none focus:border-[#e6c35c]"
              />
              <div className="flex flex-wrap gap-2">
                {(Object.keys(LCD_COLORS) as (keyof typeof LCD_COLORS)[]).map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setLcdRgb([...LCD_COLORS[name]])}
                    className={`rounded-lg border px-3 py-1.5 text-sm ${
                      lcdRgb[0] === LCD_COLORS[name][0] && lcdRgb[1] === LCD_COLORS[name][1]
                        ? 'border-[#e6c35c] bg-[#2a2218]'
                        : 'border-[#8a6a3b]/50'
                    }`}
                  >
                    {name}
                  </button>
                ))}
                <button type="button" onClick={sendLcd} className="rounded-lg bg-[#3a2c16] px-4 py-1.5 text-sm font-medium hover:bg-[#4a3820]">
                  Send to LCD
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 4 — Raw JSON */}
        <p className="truncate font-mono text-[11px] text-[#a89878]" title={JSON.stringify(hardware.frame)}>
          {JSON.stringify(hardware.frame)}
        </p>
      </div>
    </main>
  );
}

function InputBox({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div
      className={`rounded-xl border p-3 transition-colors ${
        active ? 'border-emerald-400 bg-emerald-600/35 text-emerald-50 shadow-[0_0_20px_rgba(52,211,153,0.35)]' : 'border-[#5a4a32]/50 bg-[#1a1510] text-[#d9c4a4]'
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 font-mono text-xs leading-snug sm:text-sm">{value}</p>
    </div>
  );
}
