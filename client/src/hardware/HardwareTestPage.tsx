import { useEffect, useState } from 'react';
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
  const { frame, mode, status, error, sampleHz, frameCount } = hardware;
  const connected = status === 'connected';
  const [l1, setL1] = useState('HELLO');
  const [l2, setL2] = useState('GLOVE');
  const [lcdRgb, setLcdRgb] = useState<readonly [number, number, number]>(LCD_COLORS.Orange);

  // Counters + last-triggered timestamps so even a 10ms tap is impossible to miss!
  const [counts, setCounts] = useState({ d2: 0, d3: 0, d4: 0, d6: 0, d7: 0, d8: 0, swipe: 0 });
  const [lastHit, setLastHit] = useState<string>('None yet — touch D3 or press D4 / D8');

  const d2On = (frame.d2 ?? 0) !== 0;
  const d3On = (frame.d7 ?? 0) !== 0 || (frame.d3 ?? 0) !== 0 || frame.parry;
  const d4On = (frame.d4 ?? 0) !== 0 || frame.btn !== 0;
  const d6On = (frame.d6 ?? 0) !== 0;
  const d7On = (frame.d7 ?? 0) !== 0;
  const d8On = (frame.d8 ?? 0) !== 0 || (frame.btn2 ?? 0) !== 0 || frame.fist;

  useEffect(() => {
    if (d2On) {
      setCounts((c) => ({ ...c, d2: c.d2 + 1 }));
      setLastHit(`D2 HIGH at ${new Date().toLocaleTimeString()}`);
    }
  }, [d2On]);

  useEffect(() => {
    if (d3On) {
      setCounts((c) => ({ ...c, d3: c.d3 + 1 }));
      setLastHit(`D3 TOUCH / PARRY HIGH at ${new Date().toLocaleTimeString()}`);
    }
  }, [d3On]);

  useEffect(() => {
    if (d4On) {
      setCounts((c) => ({ ...c, d4: c.d4 + 1 }));
      setLastHit(`D4 BUTTON 1 HIGH at ${new Date().toLocaleTimeString()}`);
    }
  }, [d4On]);

  useEffect(() => {
    if (d6On) {
      setCounts((c) => ({ ...c, d6: c.d6 + 1 }));
      setLastHit(`D6 HIGH at ${new Date().toLocaleTimeString()}`);
    }
  }, [d6On]);

  useEffect(() => {
    if (d7On) {
      setCounts((c) => ({ ...c, d7: c.d7 + 1 }));
      setLastHit(`D7 HIGH at ${new Date().toLocaleTimeString()}`);
    }
  }, [d7On]);

  useEffect(() => {
    if (d8On) {
      setCounts((c) => ({ ...c, d8: c.d8 + 1 }));
      setLastHit(`D8 BUTTON 2 HIGH at ${new Date().toLocaleTimeString()}`);
    }
  }, [d8On]);

  useEffect(() => {
    if (frame.swipe !== 'none') {
      setCounts((c) => ({ ...c, swipe: c.swipe + 1 }));
      setLastHit(`ACCEL SWIPE: ${frame.swipe.toUpperCase()} (${frame.accel.toFixed(2)}x) at ${new Date().toLocaleTimeString()}`);
    }
  }, [frame.swipe, frame.accel]);

  const statusLabel =
    mode === 'web-serial' && connected
      ? `🟢 Connected: USB Serial (${sampleHz} Hz · ${frameCount} frames)`
      : mode === 'ws-bridge' && connected
        ? `🟢 Connected: Bridge (${sampleHz} Hz · ${frameCount} frames)`
        : '🟡 Not connected to Arduino (Simulator mode)';

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
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
        {/* 1 — Connect bar */}
        <section className="rounded-2xl border border-[#5a4a32]/50 bg-[#1a1510] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!hardware.webSerialSupported || connected}
                onClick={() => void hardware.connectSerial()}
                className="rounded-xl bg-emerald-600 px-5 py-3 text-base font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                🔌 Connect USB Arduino
              </button>
              <button
                type="button"
                disabled={connected}
                onClick={() => hardware.connectBridge(SERIAL_BRIDGE_URL)}
                className="rounded-xl bg-amber-700 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-40"
              >
                📡 Connect Bridge ({SERIAL_BRIDGE_URL})
              </button>
              {connected ? (
                <button
                  type="button"
                  onClick={disconnect}
                  className="rounded-xl border border-rose-400/60 bg-rose-950/50 px-4 py-3 text-sm font-semibold text-rose-100 hover:bg-rose-900/60"
                >
                  Disconnect (Click before flashing!)
                </button>
              ) : null}
            </div>
            <span
              className={`rounded-full px-3 py-1.5 text-xs font-semibold sm:text-sm ${
                connected ? 'bg-emerald-900/80 text-emerald-200' : 'bg-[#2a2218] text-amber-200'
              }`}
            >
              {statusLabel}
            </span>
          </div>
          {error ? <p className="mt-2 text-sm font-medium text-red-400">{error}</p> : null}
          <div className="mt-3 flex items-center justify-between rounded-xl bg-black/40 px-3 py-2 font-mono text-xs text-amber-200">
            <span>LAST EVENT: {lastHit}</span>
            <button
              type="button"
              onClick={() => {
                setCounts({ d2: 0, d3: 0, d4: 0, d6: 0, d7: 0, d8: 0, swipe: 0 });
                setLastHit('Reset');
              }}
              className="rounded border border-white/20 px-2 py-0.5 text-[11px] text-amber-100 hover:bg-white/10"
            >
              Reset Counts
            </button>
          </div>
        </section>

        {/* 2 — Main 5 Expected Inputs */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <InputBox
            label="D7 · Touch Sensor"
            active={d3On}
            value={d3On ? '⚡ HIGH (TOUCHED!)' : 'LOW (0)'}
            sub={`raw d7=${frame.d7 ?? 0} · parry=${String(frame.parry)} · hits: ${counts.d3}`}
            onSimDown={() => hardware.setParry(true)}
            onSimUp={() => hardware.setParry(false)}
          />
          <InputBox
            label="D4 · Button 1 (Talk)"
            active={d4On}
            value={d4On ? '🎙️ HIGH (PRESSED!)' : 'LOW (0)'}
            sub={`raw d4=${frame.d4 ?? 0} · btn=${frame.btn} · hits: ${counts.d4}`}
            onSimDown={() => hardware.setButton(true)}
            onSimUp={() => hardware.setButton(false)}
          />
          <InputBox
            label="D8 · Button 2 (Lock)"
            active={d8On}
            value={d8On ? '🔒 HIGH (PRESSED!)' : 'LOW (0)'}
            sub={`raw d8=${frame.d8 ?? 0} · fist=${String(frame.fist)} · hits: ${counts.d8}`}
            onSimDown={() => hardware.setButton2(true)}
            onSimUp={() => hardware.setButton2(false)}
          />
          <InputBox
            label="A0 · Rotary Dial"
            active={true}
            value={`Slot ${frame.dial}: ${DIAL_LABEL[frame.dial] ?? dialName ?? '?'}`}
            sub={`raw A0 = ${rawDial} / 1023`}
          />
          <InputBox
            label="I2C · Accelerometer"
            active={frame.swipe !== 'none'}
            value={frame.swipe === 'none' ? 'Idle' : `💥 ${frame.swipe.toUpperCase()}!`}
            sub={`power: ${frame.accel.toFixed(2)}x · swipes: ${counts.swipe}`}
          />
        </section>

        {/* 3 — ALL Grove Digital & Analog Ports Scanner (in case Touch is plugged into D2/D6/D7 or A1/A2/A3!) */}
        <section className="rounded-2xl border border-[#5a4a32]/50 bg-[#1a1510] p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#e6c35c]/90">
              All Grove Shield Ports Live Scanner (Check if Touch Sensor is on another port!)
            </h2>
            <span className="font-mono text-xs text-[#a89878]">
              {frame.d2 === undefined ? '⚠️ Flash latest firmware to see D2/D6/D7/A1-A3' : 'Live 50 Hz pin scan active'}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-9">
            <MiniPin label="D2" high={d2On} raw={frame.d2} count={counts.d2} />
            <MiniPin label="D3 (Touch)" high={d3On} raw={frame.d3} count={counts.d3} />
            <MiniPin label="D4 (Btn1)" high={d4On} raw={frame.d4} count={counts.d4} />
            <MiniPin label="D6" high={d6On} raw={frame.d6} count={counts.d6} />
            <MiniPin label="D7" high={d7On} raw={frame.d7} count={counts.d7} />
            <MiniPin label="D8 (Btn2)" high={d8On} raw={frame.d8} count={counts.d8} />
            <MiniAnalog label="A0 (Dial)" val={frame.rawDial} />
            <MiniAnalog label="A1" val={frame.a1} />
            <MiniAnalog label="A2" val={frame.a2} />
          </div>
        </section>

        {/* 4 — Outputs (Buzzer & LCD) */}
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
                  🔊 {p}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-[#5a4a32]/50 bg-[#1a1510] p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[#e6c35c]/90">LCD (I2C)</h2>
            <div className="mt-2 flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
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
              </div>
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
                <button
                  type="button"
                  onClick={sendLcd}
                  className="rounded-lg bg-[#3a2c16] px-4 py-1.5 text-sm font-medium hover:bg-[#4a3820]"
                >
                  Send to LCD
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 5 — Raw JSON */}
        <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/50 px-3 py-2 font-mono text-xs text-emerald-300">
          {JSON.stringify(frame)}
        </pre>
      </div>
    </main>
  );
}

function InputBox({
  label,
  value,
  sub,
  active,
  onSimDown,
  onSimUp,
}: {
  label: string;
  value: string;
  sub: string;
  active: boolean;
  onSimDown?: () => void;
  onSimUp?: () => void;
}) {
  return (
    <div
      onMouseDown={onSimDown}
      onMouseUp={onSimUp}
      onMouseLeave={onSimUp}
      className={`rounded-xl border p-3 transition-colors select-none ${
        active
          ? 'border-emerald-400 bg-emerald-600/40 text-emerald-50 shadow-[0_0_24px_rgba(52,211,153,0.45)]'
          : 'border-[#5a4a32]/50 bg-[#1a1510] text-[#d9c4a4]'
      }`}
    >
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-85">{label}</p>
      <p className="mt-1 font-mono text-sm font-bold leading-snug sm:text-base">{value}</p>
      <p className="mt-1 font-mono text-[11px] opacity-75">{sub}</p>
    </div>
  );
}

function MiniPin({ label, high, raw, count }: { label: string; high: boolean; raw: number | undefined; count: number }) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 text-center font-mono text-xs ${
        high ? 'border-emerald-400 bg-emerald-500/40 font-bold text-white' : 'border-white/10 bg-black/30 text-[#a89878]'
      }`}
    >
      <div>{label}</div>
      <div className="mt-0.5 text-sm">{raw === undefined ? '?' : raw ? 'HIGH (1)' : 'LOW (0)'}</div>
      <div className="text-[10px] opacity-70">hits: {count}</div>
    </div>
  );
}

function MiniAnalog({ label, val }: { label: string; val: number | undefined }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-center font-mono text-xs text-[#d9c4a4]">
      <div>{label}</div>
      <div className="mt-0.5 text-sm font-bold text-amber-200">{val ?? '?'}</div>
      <div className="text-[10px] opacity-70">0..1023</div>
    </div>
  );
}
