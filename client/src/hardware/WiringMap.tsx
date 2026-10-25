import {
  DIGITAL_PINS,
  emptyEdges,
  type DigitalPin,
  type GloveHub,
  type GloveSample,
  type GloveSummary,
} from './useGloveHub';

interface PinInfo {
  socket: string;
  role: string;
  /** Pins the firmware expects a part on. Anything else lighting up means a part is in the wrong socket. */
  expected: boolean;
}

const DIGITAL_INFO: Record<DigitalPin, PinInfo> = {
  d2: { socket: 'D2', role: 'Not used by the firmware', expected: false },
  d3: { socket: 'D3', role: 'Touch sensor (D3 or D7, depending on the build)', expected: true },
  d4: { socket: 'D4', role: 'Button 1', expected: true },
  d6: { socket: 'D6', role: 'Not used by the firmware', expected: false },
  d7: { socket: 'D7', role: 'Touch sensor (D3 or D7, depending on the build)', expected: true },
  d8: { socket: 'D8', role: 'Button 2', expected: true },
  d9: { socket: 'D8 (second signal pin)', role: 'Not used by the firmware', expected: false },
};

const ANALOG_INFO = [
  { key: 'dial', pin: 'A0', socket: 'A0', role: 'Rotary angle sensor (dial)', expected: true },
  { key: 'a1', pin: 'A1', socket: 'A0 (second signal pin) / A1', role: 'Not used by the firmware', expected: false },
  { key: 'a2', pin: 'A2', socket: 'A2', role: 'Not used by the firmware', expected: false },
  { key: 'a3', pin: 'A3', socket: 'A2 (second signal pin) / A3', role: 'Not used by the firmware', expected: false },
] as const;

const I2C_NAMES: Record<number, { name: string; role: string }> = {
  0x3e: { name: 'LCD text controller', role: 'Display text (Grove 16x2 LCD)' },
  0x62: { name: 'LCD backlight chip (PCA9632/9633)', role: 'Backlight color, LCD v2 and v4' },
  0x30: { name: 'LCD backlight chip (SGM31323)', role: 'Backlight color, LCD v5' },
  0x70: { name: 'PCA963x all-call address', role: 'Backlight chip alias (the LCD library turns it off)' },
  0x4c: { name: 'MMA7660 accelerometer', role: '3-axis accelerometer (+-1.5 g)' },
  0x19: { name: 'LIS3DHTR accelerometer', role: '3-axis accelerometer (+-8 g)' },
  0x18: { name: 'LIS3DHTR accelerometer (alt)', role: '3-axis accelerometer' },
  0x53: { name: 'ADXL345 accelerometer', role: '3-axis accelerometer' },
  0x1d: { name: 'ADXL345 accelerometer (alt)', role: '3-axis accelerometer' },
};

const ACCEL_ADDRESSES = [0x4c, 0x19, 0x18, 0x53, 0x1d];

function ago(now: number, then: number | undefined): string {
  if (then === undefined) return 'never';
  const s = (now - then) / 1000;
  return s < 1 ? 'just now' : `${s.toFixed(s < 10 ? 1 : 0)} s ago`;
}

function Level({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-stone-500">not reported</span>;
  return (
    <span
      className={`inline-block min-w-12 rounded px-2 py-0.5 text-center text-xs ${
        value ? 'bg-amber-400/25 text-amber-200' : 'bg-stone-800 text-stone-400'
      }`}
    >
      {value ? 'HIGH' : 'low'}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-stone-500">{children}</th>;
}

/** Pin roles for one glove: the touch sensor is on D3 or D7 depending on the build. */
function pinInfo(pin: DigitalPin, touchPin: number | null): PinInfo {
  const base = DIGITAL_INFO[pin];
  if (touchPin === null || (pin !== 'd3' && pin !== 'd7')) return base;
  const isTouch = pin === `d${touchPin}`;
  return isTouch
    ? { ...base, role: 'Touch sensor', expected: true }
    : { ...base, role: `Not used (this glove's touch sensor is on D${touchPin})`, expected: false };
}

function GloveWiring({ glove, hub }: { glove: GloveSummary; hub: GloveHub }) {
  const now = performance.now();
  const list = hub.samples.current.get(glove.id) ?? [];
  const last: GloveSample | undefined = list[list.length - 1];
  const edges = hub.edges.current.get(glove.id) ?? emptyEdges();
  const reportsExtras = last !== undefined && last.d2 !== undefined;

  // Which pin changed most recently: pressing a part shows where it is really plugged in.
  let recent: { pin: DigitalPin; at: number } | null = null;
  for (const pin of DIGITAL_PINS) {
    const at = edges.changedAt[pin];
    if (at !== undefined && (!recent || at > recent.at)) recent = { pin, at };
  }

  const dials = list.map((s) => s.dial);
  const dialMin = dials.length ? Math.min(...dials) : 0;
  const dialMax = dials.length ? Math.max(...dials) : 0;
  const lowSupply = dials.length > 20 && dialMax - dialMin > 350 && dialMax < 900;

  const present = new Set(glove.i2c);
  const hasBacklight = present.has(0x62) || present.has(0x30);
  const hasAccel = ACCEL_ADDRESSES.some((a) => present.has(a));

  return (
    <section className="rounded-lg border border-stone-700 bg-stone-900/80 p-4" data-testid={`wiring-${glove.id}`}>
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-stone-100">Glove {glove.id}</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            glove.online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
          }`}
        >
          {glove.online ? 'online' : 'offline'}
        </span>
        <span className="rounded bg-stone-800 px-2 py-0.5 text-xs text-stone-300">
          {glove.fw || 'firmware ?'} · LCD v{glove.variant ?? '?'}
        </span>
        <span className="ml-auto text-xs text-stone-300">
          Last input:{' '}
          {recent ? (
            <b className="text-amber-200">
              {recent.pin.toUpperCase()} ({pinInfo(recent.pin, glove.touchPin).role}) {ago(now, recent.at)}
            </b>
          ) : (
            <span className="text-stone-500">press a button or touch a sensor</span>
          )}
        </span>
      </header>

      {!reportsExtras && last ? (
        <p role="note" className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          This glove runs older firmware that reports only D3, D4, D7, D8 and A0. Reflash it
          (<code>./flash.sh v{glove.variant ?? 4} {glove.id}</code>) to see D2, D6, D9 and A1 to A3.
        </p>
      ) : null}

      <h3 className="mt-4 text-sm font-semibold text-stone-200">Digital pins (Grove digital sockets)</h3>
      <p className="mb-1 text-xs text-stone-500">
        Socket Dn reads on Arduino pin Dn (its first signal wire). Active level is HIGH.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Pin</Th>
            <Th>Socket</Th>
            <Th>Firmware expects</Th>
            <Th>Now</Th>
            <Th>Presses</Th>
            <Th>Last change</Th>
            <Th>Check</Th>
          </tr>
        </thead>
        <tbody>
          {DIGITAL_PINS.map((pin) => {
            const info = pinInfo(pin, glove.touchPin);
            const level = last?.[pin];
            const hits = edges.hits[pin];
            const unexpectedActivity = !info.expected && (hits > 0 || level === 1);
            return (
              <tr key={pin} className={`border-t border-stone-800 ${unexpectedActivity ? 'bg-amber-500/10' : ''}`}>
                <td className="px-2 py-1 font-mono text-stone-100">{pin.toUpperCase()}</td>
                <td className="px-2 py-1 text-stone-300">{info.socket}</td>
                <td className="px-2 py-1 text-stone-300">{info.role}</td>
                <td className="px-2 py-1">
                  <Level value={level} />
                </td>
                <td className="px-2 py-1 text-stone-300">{hits}</td>
                <td className="px-2 py-1 text-stone-400">{ago(now, edges.changedAt[pin])}</td>
                <td className="px-2 py-1 text-xs">
                  {unexpectedActivity ? (
                    <span className="text-amber-300">activity on an unused pin: a part is plugged in here</span>
                  ) : info.expected && hits === 0 ? (
                    <span className="text-stone-500">no press seen yet</span>
                  ) : (
                    <span className="text-emerald-300">ok</span>
                  )}
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-stone-800">
            <td className="px-2 py-1 font-mono text-stone-100">D5</td>
            <td className="px-2 py-1 text-stone-300">D5</td>
            <td className="px-2 py-1 text-stone-300">Buzzer (output: use Beep or Identify)</td>
            <td className="px-2 py-1 text-stone-500" colSpan={4}>
              not read
            </td>
          </tr>
        </tbody>
      </table>

      <h3 className="mt-4 text-sm font-semibold text-stone-200">Analog pins (Grove analog sockets)</h3>
      <p className="mb-1 text-xs text-stone-500">Unplugged analog pins float, so small noisy numbers are normal there.</p>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Pin</Th>
            <Th>Socket</Th>
            <Th>Firmware expects</Th>
            <Th>Value</Th>
            <Th>Level</Th>
            <Th>Check</Th>
          </tr>
        </thead>
        <tbody>
          {ANALOG_INFO.map((row) => {
            const value = row.key === 'dial' ? last?.dial : last?.[row.key];
            const busy = !row.expected && value !== undefined && value > 120;
            return (
              <tr key={row.key} className={`border-t border-stone-800 ${busy ? 'bg-amber-500/10' : ''}`}>
                <td className="px-2 py-1 font-mono text-stone-100">{row.pin}</td>
                <td className="px-2 py-1 text-stone-300">{row.socket}</td>
                <td className="px-2 py-1 text-stone-300">{row.role}</td>
                <td className="px-2 py-1 text-stone-200">{value ?? 'not reported'}</td>
                <td className="px-2 py-1">
                  <div className="h-2 w-32 overflow-hidden rounded bg-stone-800">
                    <div className="h-full bg-amber-400" style={{ width: `${((value ?? 0) / 1023) * 100}%` }} />
                  </div>
                </td>
                <td className="px-2 py-1 text-xs">
                  {row.key === 'dial' ? (
                    lowSupply ? (
                      <span className="text-amber-300">
                        dial only reaches {dialMax} of 1023: the shield VCC switch is probably on 3.3V, move it to 5V
                      </span>
                    ) : (
                      <span className="text-stone-400">
                        range seen {dialMin} to {dialMax}
                      </span>
                    )
                  ) : busy ? (
                    <span className="text-amber-300">signal here: a sensor may be plugged into this socket</span>
                  ) : (
                    <span className="text-stone-500">idle</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 className="mt-4 text-sm font-semibold text-stone-200">I2C bus (any Grove I2C socket, SDA/SCL on A4/A5)</h3>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Address</Th>
            <Th>Device</Th>
            <Th>Role</Th>
            <Th>Check</Th>
          </tr>
        </thead>
        <tbody>
          {glove.i2c.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-2 py-2 text-red-300">
                nothing answers on the bus (the info packet is sent once a second)
              </td>
            </tr>
          ) : null}
          {glove.i2c.map((address) => {
            const known = I2C_NAMES[address];
            return (
              <tr key={address} className="border-t border-stone-800">
                <td className="px-2 py-1 font-mono text-stone-100">0x{address.toString(16).toUpperCase()}</td>
                <td className="px-2 py-1 text-stone-300">{known?.name ?? 'unknown device'}</td>
                <td className="px-2 py-1 text-stone-400">{known?.role ?? 'not used by the firmware'}</td>
                <td className="px-2 py-1 text-xs text-emerald-300">present</td>
              </tr>
            );
          })}
          {!present.has(0x3e) ? (
            <tr className="border-t border-stone-800">
              <td className="px-2 py-1 font-mono text-stone-100">0x3E</td>
              <td className="px-2 py-1 text-stone-300">LCD text controller</td>
              <td className="px-2 py-1 text-stone-400">Display text</td>
              <td className="px-2 py-1 text-xs text-red-300">missing</td>
            </tr>
          ) : null}
          {!hasBacklight ? (
            <tr className="border-t border-stone-800">
              <td className="px-2 py-1 font-mono text-stone-100">0x62</td>
              <td className="px-2 py-1 text-stone-300">LCD backlight chip</td>
              <td className="px-2 py-1 text-stone-400">Backlight color</td>
              <td className="px-2 py-1 text-xs text-red-300">missing</td>
            </tr>
          ) : null}
          {!hasAccel ? (
            <tr className="border-t border-stone-800">
              <td className="px-2 py-1 font-mono text-stone-100">0x4C</td>
              <td className="px-2 py-1 text-stone-300">Accelerometer</td>
              <td className="px-2 py-1 text-stone-400">3-axis accelerometer</td>
              <td className="px-2 py-1 text-xs text-red-300">missing</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-stone-500">
        The accelerometer is currently read as: <b className="text-stone-300">{glove.acc || 'unknown'}</b>. The I2C list is
        scanned at boot and on request, so a module that comes up late may show here a moment after power-up.
      </p>

      <h3 className="mt-4 text-sm font-semibold text-stone-200">Links</h3>
      <table className="w-full text-sm">
        <tbody>
          <tr className="border-t border-stone-800">
            <td className="px-2 py-1 text-stone-300">Wi-Fi</td>
            <td className="px-2 py-1 text-stone-400">
              {glove.ssid || '?'} · {glove.ip} · {glove.rssi} dBm
            </td>
          </tr>
          <tr className="border-t border-stone-800">
            <td className="px-2 py-1 text-stone-300">UDP</td>
            <td className="px-2 py-1 text-stone-400">
              glove to hub on :4211 ({glove.rxRate} Hz received, {glove.dropped} dropped). Hub to glove on :4210 (
              {glove.hubSeen ? 'glove sees the hub' : 'glove has not heard the hub'})
            </td>
          </tr>
          <tr className="border-t border-stone-800">
            <td className="px-2 py-1 text-stone-300">USB serial</td>
            <td className="px-2 py-1 text-stone-400">115200 baud: JSON lines and commands (flashing, debugging)</td>
          </tr>
          <tr className="border-t border-stone-800">
            <td className="px-2 py-1 text-stone-300">Grove UART socket (D0/D1)</td>
            <td className="px-2 py-1 text-stone-500">not used</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function WiringMap({ hub }: { hub: GloveHub }) {
  if (hub.gloves.length === 0) {
    return (
      <div className="rounded border border-stone-700 bg-stone-900 p-3 text-sm text-stone-300">
        No glove has reported yet. The wiring map fills in as soon as one connects to the hub.
      </div>
    );
  }
  return (
    <>
      {hub.gloves.map((glove) => (
        <GloveWiring key={glove.id} glove={glove} hub={hub} />
      ))}
    </>
  );
}
