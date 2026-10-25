import { useId, type PointerEvent } from 'react';
import {
  ACCEL_POWER,
  ELEMENT_META,
  FIST_CHARGE_MULTIPLIER,
  NOISE_TOO_LOUD_THRESHOLD,
  P0_ELEMENTS,
  SERVO_ANGLE,
} from '@aethren/shared';
import type { GloveSensorFrame, P0ElementType } from '@aethren/shared';
import { elementForDialSlot, previewGloveLcd, type GloveLcdPreview } from './serialProtocol';
import { useGloveHardware, type GloveHardwareController } from './useGloveHardware';

const TOKEN_COLORS: readonly { id: GloveSensorFrame['color']; label: string; swatch: string }[] = [
  { id: 'none', label: 'None', swatch: '#6d645b' },
  { id: 'ember', label: 'Ember', swatch: ELEMENT_META.ember.color },
  { id: 'frost', label: 'Frost', swatch: ELEMENT_META.frost.color },
  { id: 'bloom', label: 'Bloom', swatch: ELEMENT_META.bloom.color },
  { id: 'boss', label: 'Boss', swatch: '#e6c35c' },
];

export interface GloveSimulatorPanelProps {
  hardware: GloveHardwareController;
  /** `float` docks the panel over the page; `dock` keeps it in document flow. */
  placement?: 'dock' | 'float';
}

function holdHandlers(
  enabled: boolean,
  setDown: (down: boolean) => void,
): {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
} {
  return {
    onPointerDown: (event) => {
      if (!enabled) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDown(true);
    },
    onPointerUp: () => setDown(false),
    onPointerCancel: () => setDown(false),
    onLostPointerCapture: () => setDown(false),
  };
}

function modeLabel(mode: GloveHardwareController['mode']): string {
  if (mode === 'web-serial') return 'Web Serial';
  if (mode === 'ws-bridge') return 'WS Bridge';
  return 'Simulator';
}

/**
 * Compact Enchanted Glove + Grove Base Shield readout.
 * Pass a controller from {@link useGloveHardware}, or mount {@link GloveSimulatorWidget}
 * when this panel is the only glove on the page.
 */
export function GloveSimulatorPanel({ hardware, placement = 'dock' }: GloveSimulatorPanelProps) {
  const noiseId = useId();
  const accelId = useId();
  const frame = hardware.frame;
  const element = elementForDialSlot(frame.dial);
  const tooLoud = frame.armed && frame.noise >= NOISE_TOO_LOUD_THRESHOLD;
  const charge = frame.fist ? FIST_CHARGE_MULTIPLIER : 1;
  const power = frame.accel * charge;
  const live = hardware.simulatorActive;
  const noisePct = Math.min(100, (frame.noise / 1023) * 100);
  const gatePct = (NOISE_TOO_LOUD_THRESHOLD / 1023) * 100;
  const lcd = previewGloveLcd(frame, { custom: hardware.lcdMessage, lockedElement: hardware.lockedElement });
  const btn2Down = (frame.btn2 ?? 0) !== 0;

  const shell =
    placement === 'float'
      ? 'fixed bottom-4 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto'
      : 'w-full';

  return (
    <section
      data-testid="glove-simulator"
      className={`${shell} rounded-3xl border border-[#8a6a3b]/70 bg-[#1b140f]/95 p-4 text-[#f6ecd8] shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-sm`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] text-[#e6c35c]/80">Laptop A · Spellbearer</p>
          <h2 className="font-serif text-2xl leading-tight">Enchanted Glove</h2>
          <p className="text-xs text-[#d9c4a4]/80">Grove Base Shield V2 · Uno R4 WiFi · 7 parts</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[11px] uppercase tracking-wider text-[#e6c35c]">
            {modeLabel(hardware.mode)}
          </p>
          <p className="font-mono text-[11px] text-[#d9c4a4]/80">
            {hardware.status === 'connected' ? 'live' : hardware.status} · {hardware.sampleHz.toFixed(0)} Hz
          </p>
        </div>
      </header>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <button
          type="button"
          className={linkClass(hardware.mode === 'web-serial')}
          onClick={() => {
            if (hardware.mode === 'web-serial') void hardware.disconnectSerial();
            else void hardware.connectSerial();
          }}
          title={
            hardware.webSerialSupported
              ? 'Open the Uno R4 at 115200 baud'
              : 'Web Serial needs Chrome or Edge. Click to see the fallback.'
          }
        >
          {hardware.mode === 'web-serial' ? 'Close serial' : 'Web Serial'}
        </button>
        <button
          type="button"
          className={linkClass(hardware.mode === 'ws-bridge')}
          onClick={() => {
            if (hardware.mode === 'ws-bridge') hardware.disconnectBridge();
            else hardware.connectBridge();
          }}
        >
          {hardware.mode === 'ws-bridge' ? 'Close bridge' : 'WS Bridge'}
        </button>
        <button
          type="button"
          className={linkClass(hardware.mode === 'simulator')}
          onClick={() => hardware.useSimulator()}
        >
          Keys
        </button>
      </div>

      {hardware.error ? (
        <p className="mt-2 rounded-xl border border-[#a33b32]/60 bg-[#3a1412] px-3 py-2 text-xs text-[#ffd0c8]" role="alert">
          {hardware.error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          aria-pressed={frame.armed}
          onClick={() => hardware.toggleArmed()}
          className={`rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] ${
            frame.armed ? 'bg-[#2f6b45] text-[#e7ffe8]' : 'bg-[#5c2430] text-[#ffd5dc]'
          }`}
        >
          {frame.armed ? 'Armed' : 'Disarmed'}
        </button>
        <p className="text-[11px] text-[#d9c4a4]/75">{live ? 'M arms / disarms' : 'Sends {"cmd":"arm"} to the board'}</p>
      </div>

      <div className="mt-3">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[#e6c35c]/80">Forearm 16x2 LCD · I2C</p>
        <GloveLcdScreen preview={lcd} className="mt-2" />
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center" data-testid="pin-readout">
        <MeterChip label="D3" value={pinValue(frame.d3, frame.parry)} hot={(frame.d3 ?? 0) !== 0 || frame.parry} />
        <MeterChip label="D4" value={pinValue(frame.d4, frame.btn !== 0)} hot={(frame.d4 ?? 0) !== 0 || frame.btn !== 0} />
        <MeterChip label="D8" value={pinValue(frame.d8, btn2Down)} hot={(frame.d8 ?? 0) !== 0 || btn2Down} />
        <MeterChip label="A0" value={frame.rawDial !== undefined ? String(frame.rawDial) : `slot ${frame.dial}`} hot={false} />
      </div>

      {!frame.armed ? (
        <p className="mt-2 rounded-xl border border-[#8a6a3b]/50 bg-[#2a2118] px-3 py-2 text-xs text-[#f0ddb4]">
          DISARMED — spell, mic, and parry inputs are gated
        </p>
      ) : null}

      <div className="mt-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[#e6c35c]/80">Spell wheel</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {P0_ELEMENTS.map((id, slot) => (
            <WheelSlot
              key={id}
              id={id}
              slot={slot}
              active={frame.dial === slot}
              locked={hardware.lockedElement === id}
              disabled={!live}
              onSelect={() => hardware.setDial(slot)}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-[#d9c4a4]/85">
          {element ? ELEMENT_META[element].effect : 'Dial out of range'}
          {hardware.lockedElement ? ` · Locked ${ELEMENT_META[hardware.lockedElement].label}` : ' · Unlocked'}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <MeterChip label="Fist" value={frame.fist ? `${FIST_CHARGE_MULTIPLIER}×` : 'Open'} hot={frame.fist} />
        <MeterChip label="Talk" value={hardware.pushToTalk ? 'Live' : 'Idle'} hot={hardware.pushToTalk} />
        <MeterChip label="Parry" value={hardware.parryLit || frame.parry ? 'PARRY' : 'Ready'} hot={hardware.parryLit || frame.parry} />
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <button
          type="button"
          disabled={!live}
          className={sensorClass(frame.btn !== 0)}
          {...holdHandlers(live, hardware.setButton)}
        >
          D4 Talk
          <span className="block font-mono text-[10px] opacity-70">Hold E</span>
        </button>
        <button
          type="button"
          disabled={!live}
          className={sensorClass(btn2Down)}
          {...holdHandlers(live, hardware.setButton2)}
        >
          D8 Lock
          <span className="block font-mono text-[10px] opacity-70">L</span>
        </button>
        <button
          type="button"
          disabled={!live}
          className={sensorClass(frame.fist)}
          {...holdHandlers(live, hardware.setFist)}
        >
          D8 Charge
          <span className="block font-mono text-[10px] opacity-70">Hold F</span>
        </button>
        <button
          type="button"
          disabled={!live}
          className={sensorClass(hardware.parryLit || frame.parry)}
          onClick={() => hardware.tapParry()}
        >
          D3 Parry
          <span className="block font-mono text-[10px] opacity-70">Q</span>
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <button type="button" disabled={!live} className={sensorClass(frame.swipe === 'left')} onClick={() => hardware.releaseSwipe('left')}>
          Swipe left
        </button>
        <button type="button" disabled={!live} className={sensorClass(frame.swipe === 'thrust')} onClick={() => hardware.releaseSwipe('thrust')}>
          Thrust
        </button>
        <button type="button" disabled={!live} className={sensorClass(frame.swipe === 'right')} onClick={() => hardware.releaseSwipe('right')}>
          Swipe right
        </button>
      </div>

      <label htmlFor={accelId} className="mt-4 block text-[10px] uppercase tracking-[0.22em] text-[#e6c35c]/80">
        Accel speed {frame.accel.toFixed(2)}× · power {power.toFixed(2)}×
      </label>
      <input
        id={accelId}
        type="range"
        min={ACCEL_POWER.min}
        max={ACCEL_POWER.max}
        step={0.01}
        value={frame.accel}
        disabled={!live}
        aria-label="Accelerometer speed multiplier"
        onChange={(event) => hardware.setAccel(Number(event.target.value))}
        className="mt-1 w-full accent-[#e6c35c] disabled:opacity-60"
      />
      {hardware.lastRelease ? (
        <p className="mt-1 font-mono text-[11px] text-[#d9c4a4]/80">
          Last release {hardware.lastRelease.direction} · {hardware.lastRelease.power.toFixed(2)}×
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-[#d9c4a4]/60">Arrow keys release a swipe or thrust</p>
      )}

      <label htmlFor={noiseId} className="mt-4 block text-[10px] uppercase tracking-[0.22em] text-[#e6c35c]/80">
        Room noise {frame.noise} / 1023 · simulator only
      </label>
      <div className="relative mt-2 h-3 rounded-full bg-[#100c09]">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${noisePct}%`,
            background: tooLoud ? '#e15a4a' : 'linear-gradient(90deg, #6d8f73, #e6c35c)',
          }}
        />
        <div
          className="absolute -top-1 h-5 w-px bg-[#f6ecd8]"
          style={{ left: `${gatePct}%` }}
          title={`Mic gate at ${NOISE_TOO_LOUD_THRESHOLD}`}
        />
      </div>
      <input
        id={noiseId}
        type="range"
        min={0}
        max={1023}
        step={1}
        value={frame.noise}
        disabled={!live}
        aria-label="Room noise"
        aria-valuemin={0}
        aria-valuemax={1023}
        aria-valuenow={frame.noise}
        onChange={(event) => hardware.setNoise(Number(event.target.value))}
        className="mt-2 w-full accent-[#e6c35c] disabled:opacity-60"
      />
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[#d9c4a4]/60">
        <span>0</span>
        <span>gate {NOISE_TOO_LOUD_THRESHOLD}</span>
        <span>1023</span>
      </div>
      {tooLoud ? (
        <p
          data-testid="noise-warning"
          role="status"
          className="mt-2 rounded-xl bg-[#9b1c1c] px-3 py-2 text-center text-xs font-semibold tracking-wide text-[#fff7ed]"
        >
          TOO LOUD — MIC GATE RAISED
        </p>
      ) : null}

      <div className="mt-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[#e6c35c]/80">Color token well · simulator only</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TOKEN_COLORS.map((token) => {
            const selected = frame.color === token.id;
            return (
              <button
                key={token.id}
                type="button"
                disabled={!live}
                aria-pressed={selected}
                onClick={() => hardware.setColor(token.id)}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] disabled:opacity-60 ${
                  selected ? 'border-[#f6ecd8] bg-[#3a2a1c]' : 'border-[#8a6a3b]/40 bg-transparent'
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: token.swatch }} />
                {token.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-[#d9c4a4]/60">C cycles none, ember, frost, bloom, boss</p>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-[#e6c35c]/80">Storybook ward · LCD notice</p>
          <p className="mt-1 font-serif text-lg">
            {hardware.servoAngle}° {hardware.servoOpen ? 'open' : 'closed'}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={sensorClass(!hardware.servoOpen)} onClick={() => hardware.setServoOpen(false)}>
              {SERVO_ANGLE.closed}° closed
            </button>
            <button type="button" className={sensorClass(hardware.servoOpen)} onClick={() => hardware.setServoOpen(true)}>
              {SERVO_ANGLE.open}° open
            </button>
          </div>
        </div>
        <div className="relative h-16 w-24 shrink-0 [perspective:500px]">
          <div className="absolute inset-y-2 left-0 w-1/2 rounded-l-md bg-[#6b3a1f] shadow-inner" />
          <div
            className="absolute inset-y-2 left-1/2 w-1/2 origin-left rounded-r-md bg-[#f3e0b5] shadow-md transition-transform duration-500"
            style={{ transform: `rotateY(${hardware.servoOpen ? -78 : 0}deg)` }}
          />
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-[#d9c4a4]/70">
        1 2 3 or [ ] dial · Hold E talk · L lock · Hold F charge · Arrows cast · Q parry · C token · M arm
      </p>
    </section>
  );
}

/** Drop-in panel with its own controller. Do not mount this beside another `useGloveHardware` listener. */
export function GloveSimulatorWidget({ placement = 'float' }: { placement?: 'dock' | 'float' }) {
  const hardware = useGloveHardware();
  return <GloveSimulatorPanel hardware={hardware} placement={placement} />;
}

function WheelSlot({
  id,
  slot,
  active,
  locked,
  disabled,
  onSelect,
}: {
  id: P0ElementType;
  slot: number;
  active: boolean;
  locked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const meta = ELEMENT_META[id];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={active}
      title={meta.effect}
      className="rounded-2xl border px-2 py-2 text-left disabled:opacity-60"
      style={{
        borderColor: active ? meta.color : 'rgba(138,106,59,0.45)',
        background: active ? `${meta.color}22` : 'transparent',
        boxShadow: active ? `inset 0 0 0 1px ${meta.color}` : undefined,
      }}
    >
      <span className="block font-mono text-[10px] text-[#d9c4a4]/70">
        {slot + 1}
        {locked ? ' · lock' : ''}
      </span>
      <span className="font-serif text-base" style={{ color: meta.color }}>
        {meta.label}
      </span>
    </button>
  );
}

/** A 16x2 character LCD with an RGB backlight, drawn from {@link previewGloveLcd}. */
export function GloveLcdScreen({ preview, className = '' }: { preview: GloveLcdPreview; className?: string }) {
  const [r, g, b] = preview.rgb;
  return (
    <div
      data-testid="lcd-preview"
      className={`rounded-xl border-4 border-[#2a2a2a] p-2 shadow-[inset_0_0_14px_rgba(0,0,0,0.45)] ${className}`}
      style={{ background: `rgb(${r}, ${g}, ${b})` }}
      aria-label={`LCD: ${preview.lines[0].trim()} / ${preview.lines[1].trim()}`}
    >
      {preview.lines.map((line, row) => (
        <div key={row} className="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-[2px]">
          {Array.from(line).map((ch, col) => (
            <span
              key={col}
              className="flex aspect-[5/8] items-center justify-center bg-black/10 font-mono text-[13px] leading-none text-[#0d0d0d]"
            >
              {ch === ' ' ? '\u00a0' : ch}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function pinValue(raw: number | undefined, fallback: boolean): string {
  if (raw !== undefined) return raw !== 0 ? 'HIGH' : 'LOW';
  return fallback ? 'HIGH' : 'LOW';
}

function MeterChip({ label, value, hot }: { label: string; value: string; hot: boolean }) {
  return (
    <div className={`rounded-2xl border px-2 py-2 ${hot ? 'border-[#e6c35c] bg-[#3a2c16]' : 'border-[#8a6a3b]/40'}`}>
      <p className="text-[10px] uppercase tracking-[0.16em] text-[#d9c4a4]/70">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}

function linkClass(active: boolean): string {
  return `rounded-xl border px-2 py-2 text-[11px] uppercase tracking-wider ${
    active ? 'border-[#e6c35c] bg-[#3a2c16] text-[#f6ecd8]' : 'border-[#8a6a3b]/40 text-[#d9c4a4]'
  } disabled:cursor-not-allowed disabled:opacity-40`;
}

function sensorClass(active: boolean): string {
  return `rounded-xl border px-2 py-2 text-xs ${
    active ? 'border-[#e6c35c] bg-[#3a2c16]' : 'border-[#8a6a3b]/40 bg-[#140f0c]'
  } disabled:cursor-not-allowed disabled:opacity-50`;
}
