import type { Spell } from './spells';
import { SPELL_VISUALS } from './spellVfx';

/** Synthesized cast whoosh and impact thump, so hits have a sound without shipping SFX files. */
let context: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

function noise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer?.sampleRate === ctx.sampleRate) return noiseBuffer;
  // Long enough for the longest charge plus the random start offset.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2.5, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

/** A gain node that rises fast to `peak` and decays exponentially over `length` seconds. */
function envelope(ctx: AudioContext, start: number, peak: number, length: number, attack = .004): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(.0001, start + length);
  gain.connect(ctx.destination);
  return gain;
}

function burstOfNoise(ctx: AudioContext, start: number, length: number, filter: BiquadFilterNode, out: AudioNode) {
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  source.connect(filter).connect(out);
  source.start(start, Math.random() * .5, length);
}

function tone(ctx: AudioContext, type: OscillatorType, from: number, to: number, start: number, length: number, out: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(to, start + length);
  osc.connect(out);
  osc.start(start); osc.stop(start + length);
}

const crackBand: Record<Spell['element'], number> = { fire: 900, frost: 3200, storm: 2200 };

/** A gain node that swells from silence to `peak` over `length` seconds, then cuts off sharply. */
function swell(ctx: AudioContext, start: number, peak: number, length: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + length);
  gain.gain.exponentialRampToValueAtTime(.0001, start + length + .06);
  gain.connect(ctx.destination);
  return gain;
}

/** The charge builds while the spell is held, then a whoosh as it is thrown. */
export function playCastSound(spell: Spell, chargeSeconds: number, travelSeconds: number) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime, release = now + chargeSeconds;
  const sweep = ctx.createBiquadFilter();
  sweep.type = 'bandpass'; sweep.Q.value = 3;
  sweep.frequency.setValueAtTime(220, now);
  sweep.frequency.exponentialRampToValueAtTime(crackBand[spell.element] * 1.3, release);
  burstOfNoise(ctx, now, chargeSeconds, sweep, swell(ctx, now, .2, chargeSeconds));
  if (spell.element === 'fire') {
    const roar = ctx.createBiquadFilter();
    roar.type = 'lowpass'; roar.frequency.value = 500;
    burstOfNoise(ctx, now, chargeSeconds, roar, swell(ctx, now, .35, chargeSeconds));
  }
  if (spell.element === 'frost') tone(ctx, 'triangle', 900, 2600, now, chargeSeconds, swell(ctx, now, .06, chargeSeconds));
  if (spell.element === 'storm') tone(ctx, 'sawtooth', 50, 140, now, chargeSeconds, swell(ctx, now, .07, chargeSeconds));
  const whoosh = ctx.createBiquadFilter();
  whoosh.type = 'highpass'; whoosh.frequency.value = 700;
  burstOfNoise(ctx, release, travelSeconds + .2, whoosh, envelope(ctx, release, .35, travelSeconds + .2, .01));
  if (spell.element === 'storm') burstOfNoise(ctx, release, .12, whoosh, envelope(ctx, release, .5, .12, .002));
}

export function playImpactSound(spell: Spell, hit: boolean) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime, heavy = Math.max(1, SPELL_VISUALS[spell.id].size * .9);
  const crack = ctx.createBiquadFilter();
  crack.type = 'bandpass'; crack.frequency.value = crackBand[spell.element]; crack.Q.value = .8;
  if (!hit) {
    // A dodge whiffs past: airy, quiet and no low end.
    burstOfNoise(ctx, now, .25, crack, envelope(ctx, now, .12, .25, .03));
    return;
  }
  tone(ctx, 'sine', 160 * heavy, 38, now, .32 * heavy, envelope(ctx, now, .9, .34 * heavy));
  burstOfNoise(ctx, now, .3 * heavy, crack, envelope(ctx, now, .7, .28 * heavy));
  if (spell.element === 'frost') tone(ctx, 'triangle', 2100, 1500, now, .45, envelope(ctx, now, .14, .45));
  if (spell.element === 'storm') tone(ctx, 'square', 110, 55, now, .18, envelope(ctx, now, .12, .2));
  if (spell.element === 'fire') tone(ctx, 'sawtooth', 90, 40, now, .25 * heavy, envelope(ctx, now, .16, .26 * heavy));
}
