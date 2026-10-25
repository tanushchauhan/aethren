import { useEffect, useRef, useState } from 'react';
import { DEBUG_HARDWARE_PATH } from '../debugRoutes';
import { WiringMap } from './WiringMap';
import {
  GLOVE_HUB_URL,
  SAMPLE_WINDOW_MS,
  useGloveHub,
  type GloveHub,
  type GloveSample,
  type GloveSummary,
  emptyEdges,
} from './useGloveHub';

/** The legacy `/hardware-test` URL redirects here. */
export const HARDWARE_TEST_PATH = DEBUG_HARDWARE_PATH;

const AXES = [
  { key: 'ax', label: 'X', color: '#f87171' },
  { key: 'ay', label: 'Y', color: '#4ade80' },
  { key: 'az', label: 'Z', color: '#60a5fa' },
] as const;

const WINDOW_OPTIONS = [4, 8, 12] as const;

function AccelChart({
  gloveId,
  samples,
  paused,
  range,
  windowS,
}: {
  gloveId: number;
  samples: React.MutableRefObject<Map<number, GloveSample[]>>;
  paused: boolean;
  range: number;
  windowS: number;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const frozen = useRef<GloveSample[] | null>(null);
  const latest = useRef({ gloveId, paused, range, windowS });
  latest.current = { gloveId, paused, range, windowS };

  useEffect(() => {
    let raf = 0;
    const render = () => {
      const el = canvas.current;
      if (el) {
        const ratio = window.devicePixelRatio || 1;
        const width = el.clientWidth;
        const height = el.clientHeight;
        if (el.width !== Math.round(width * ratio) || el.height !== Math.round(height * ratio)) {
          el.width = Math.round(width * ratio);
          el.height = Math.round(height * ratio);
        }
        const ctx = el.getContext('2d');
        if (ctx) {
          ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
          const cur = latest.current;
          const live = samples.current.get(cur.gloveId) ?? [];
          if (cur.paused && !frozen.current) frozen.current = [...live];
          if (!cur.paused) frozen.current = null;
          drawAccel(ctx, width, height, cur.paused ? (frozen.current ?? live) : live, cur.range, cur.windowS * 1000, cur.paused);
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [samples]);

  return <canvas ref={canvas} className="h-48 w-full rounded bg-stone-950" />;
}

function drawAccel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: GloveSample[],
  range: number,
  windowMs: number,
  paused: boolean,
) {
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  const scale = (height / 2 - 6) / range;
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let g = -Math.floor(range / 500); g <= Math.floor(range / 500); g++) {
    const y = mid - g * 500 * scale;
    ctx.strokeStyle = g === 0 ? '#57534e' : '#292524';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = '#78716c';
    ctx.fillText(`${(g * 0.5).toFixed(1)}g`, 4, y - 2);
  }
  if (data.length < 2) {
    ctx.fillStyle = '#78716c';
    ctx.fillText('waiting for accelerometer frames…', width / 2 - 80, mid - 8);
    return;
  }
  const end = paused ? data[data.length - 1]!.t : performance.now();
  const x = (t: number) => width - ((end - t) / windowMs) * width;
  const trace = (color: string, pick: (s: GloveSample) => number, dash: number[] = []) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.lineWidth = dash.length ? 1 : 1.5;
    ctx.beginPath();
    let started = false;
    for (const s of data) {
      if (end - s.t > windowMs) continue;
      const px = x(s.t);
      const py = mid - Math.max(-range, Math.min(range, pick(s))) * scale;
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  for (const axis of AXES) trace(axis.color, (s) => s[axis.key]);
  trace('#fbbf24', (s) => Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az), [4, 3]);
}

function Chip({ label, on, count }: { label: string; on: boolean; count: number }) {
  return (
    <div
      className={`flex flex-col items-center rounded border px-3 py-1.5 text-xs ${
        on ? 'border-amber-400 bg-amber-400/20 text-amber-200' : 'border-stone-700 bg-stone-900 text-stone-400'
      }`}
    >
      <span className="font-semibold">{label}</span>
      <span>{on ? 'HIGH' : 'low'}</span>
      <span className="text-[10px] text-stone-500">{count} hits</span>
    </div>
  );
}

function GloveCard({ glove, hub }: { glove: GloveSummary; hub: GloveHub }) {
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState(2000);
  const [windowS, setWindowS] = useState<number>(8);
  const list = hub.samples.current.get(glove.id);
  const last = list?.[list.length - 1];
  const counts = hub.edges.current.get(glove.id) ?? emptyEdges();
  const mag = last ? Math.sqrt(last.ax ** 2 + last.ay ** 2 + last.az ** 2) : 0;
  let peak = 0;
  if (list) {
    const now = performance.now();
    for (const s of list) {
      if (now - s.t > 2000) continue;
      const dev = Math.abs(Math.sqrt(s.ax ** 2 + s.ay ** 2 + s.az ** 2) - 1000);
      if (dev > peak) peak = dev;
    }
  }
  const lcdNote =
    glove.variant === 4 ? 'LCD v4 · green backlight, text' : glove.variant === 2 ? 'LCD v2 · color backlight' : 'LCD ?';
  return (
    <section className="rounded-lg border border-stone-700 bg-stone-900/80 p-4" data-testid={`glove-${glove.id}`}>
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-stone-100">Glove {glove.id}</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            glove.online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
          }`}
        >
          {glove.online ? 'online' : `offline ${(glove.ageMs / 1000).toFixed(0)}s`}
        </span>
        <span className="rounded bg-stone-800 px-2 py-0.5 text-xs text-stone-300">{lcdNote}</span>
        {glove.conflict ? (
          <span className="rounded bg-red-500/30 px-2 py-0.5 text-xs text-red-200">
            two boards share this id, flash them with different ids
          </span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="rounded border border-stone-600 px-2 py-1 text-xs text-stone-200 hover:bg-stone-800"
            onClick={() => hub.send(glove.id, { cmd: 'ident' })}
          >
            Identify (beep + LCD)
          </button>
          <button
            type="button"
            className="rounded border border-stone-600 px-2 py-1 text-xs text-stone-200 hover:bg-stone-800"
            onClick={() => hub.send(glove.id, { cmd: 'beep' })}
          >
            Beep
          </button>
        </div>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-stone-400 sm:grid-cols-4">
        <div>
          <dt className="text-stone-500">Address</dt>
          <dd className="text-stone-200">{glove.ip}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Wi-Fi</dt>
          <dd className="text-stone-200">
            {glove.ssid || '?'} · {glove.rssi} dBm
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Rate</dt>
          <dd className="text-stone-200">
            {glove.rxRate} Hz in · {glove.gloveFps} Hz sent · {glove.dropped} dropped
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Accelerometer</dt>
          <dd className={glove.acc === 'NONE' || !glove.acc ? 'text-red-300' : 'text-stone-200'}>
            {glove.acc || '?'} · I2C {glove.i2c.map((a) => `0x${a.toString(16)}`).join(' ') || 'none'}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Firmware</dt>
          <dd className="text-stone-200">
            {glove.fw || '?'} · up {glove.uptimeS}s
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Hub link</dt>
          <dd className={glove.hubSeen ? 'text-emerald-300' : 'text-amber-300'}>
            {glove.hubSeen ? 'glove sees the hub' : 'glove is still broadcasting'}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {glove.touchPin === 3 || glove.touchPin === 7 ? (
          <Chip
            label={`D${glove.touchPin} touch`}
            on={!!last?.[glove.touchPin === 3 ? 'd3' : 'd7']}
            count={counts.hits[glove.touchPin === 3 ? 'd3' : 'd7']}
          />
        ) : (
          <>
            <Chip label="D3 touch" on={!!last?.d3} count={counts.hits.d3} />
            <Chip label="D7 touch" on={!!last?.d7} count={counts.hits.d7} />
          </>
        )}
        <Chip label="D4 button" on={!!last?.d4} count={counts.hits.d4} />
        <Chip label="D8 button" on={!!last?.d8} count={counts.hits.d8} />
        <div className="min-w-48 flex-1">
          <div className="flex justify-between text-xs text-stone-400">
            <span>A0 dial</span>
            <span className="text-stone-200">{last?.dial ?? 0} / 1023</span>
          </div>
          <div className="mt-1 h-3 overflow-hidden rounded bg-stone-800">
            <div className="h-full bg-amber-400" style={{ width: `${((last?.dial ?? 0) / 1023) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex flex-wrap items-center gap-3 text-xs">
          {AXES.map((axis) => (
            <span key={axis.key} style={{ color: axis.color }}>
              {axis.label} {last ? (last[axis.key] / 1000).toFixed(3) : '0.000'} g
            </span>
          ))}
          <span className="text-amber-300">|a| {(mag / 1000).toFixed(3)} g (dashed)</span>
          <span className="text-stone-400">motion peak 2s: {(peak / 1000).toFixed(2)} g</span>
          <span className="ml-auto flex items-center gap-2 text-stone-300">
            <label>
              Range{' '}
              <select
                className="rounded border border-stone-700 bg-stone-900 px-1"
                value={range}
                onChange={(e) => setRange(Number(e.target.value))}
              >
                <option value={1500}>±1.5 g</option>
                <option value={2000}>±2 g</option>
                <option value={4000}>±4 g</option>
                <option value={8000}>±8 g</option>
              </select>
            </label>
            <label>
              Window{' '}
              <select
                className="rounded border border-stone-700 bg-stone-900 px-1"
                value={windowS}
                onChange={(e) => setWindowS(Number(e.target.value))}
              >
                {WINDOW_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s} s
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="rounded border border-stone-600 px-2 py-0.5 hover:bg-stone-800"
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="rounded border border-stone-600 px-2 py-0.5 hover:bg-stone-800"
              onClick={() => hub.clear(glove.id)}
            >
              Reset
            </button>
          </span>
        </div>
        <AccelChart
          gloveId={glove.id}
          samples={hub.samples}
          paused={paused}
          range={range}
          windowS={Math.min(windowS, SAMPLE_WINDOW_MS / 1000)}
        />
      </div>
    </section>
  );
}

export function HardwareTestPage() {
  const hub = useGloveHub();
  const [tab, setTab] = useState<'signals' | 'wiring'>('signals');
  const statusText =
    hub.status === 'open' ? 'Hub connected' : hub.status === 'connecting' ? 'Connecting to hub…' : 'Hub not running';
  return (
    <main className="flex min-h-screen flex-col gap-4 bg-stone-950 p-6 text-stone-200" data-testid="glove-monitor">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-stone-100">Glove monitor</h1>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            hub.status === 'open' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
          }`}
        >
          {statusText}
        </span>
        <span className="text-xs text-stone-500">{GLOVE_HUB_URL}</span>
        <button
          type="button"
          className="ml-auto rounded border border-stone-600 px-2 py-1 text-xs hover:bg-stone-800"
          onClick={() => hub.clear()}
        >
          Reset all charts
        </button>
      </header>

      {hub.status !== 'open' ? (
        <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          Start the hub in a terminal: <code className="rounded bg-stone-900 px-1">pnpm --dir firmware hub</code> (or{' '}
          <code className="rounded bg-stone-900 px-1">pnpm --dir firmware hub:simulate</code> to try this page without
          gloves). Your laptop must be on the same hotspot as the gloves.
        </div>
      ) : hub.gloves.length === 0 ? (
        <div className="rounded border border-stone-700 bg-stone-900 p-3 text-sm text-stone-300">
          Hub is up but no glove has reported yet. Power a glove: its LCD shows the Wi-Fi status, and it appears here a
          second after it joins the hotspot.
        </div>
      ) : null}

      <nav className="flex gap-2" role="tablist">
        {(
          [
            ['signals', 'Signals'],
            ['wiring', 'Wiring map'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`rounded border px-3 py-1 text-sm ${
              tab === id ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-stone-700 text-stone-300 hover:bg-stone-800'
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'wiring' ? (
        <WiringMap hub={hub} />
      ) : (
        hub.gloves.map((glove) => <GloveCard key={glove.id} glove={glove} hub={hub} />)
      )}
    </main>
  );
}
