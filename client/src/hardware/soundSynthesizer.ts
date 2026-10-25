/**
 * Laptop-side stand-in for the Grove buzzer and the storybook servo.
 * Plays in simulator mode, and alongside the physical parts when they are connected.
 */

import type { BuzzPattern, GloveCommand, HardwareCommand } from '@aethren/shared';
import { normalizeGloveCommand } from './serialProtocol';

interface Voice {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  delay: number;
}

const VOICES: Record<BuzzPattern, readonly Voice[]> = {
  tick: [{ type: 'square', from: 988, to: 988, duration: 0.045, gain: 0.07, delay: 0 }],
  cast: [
    { type: 'triangle', from: 523.25, to: 783.99, duration: 0.18, gain: 0.08, delay: 0 },
    { type: 'sine', from: 783.99, to: 1174.66, duration: 0.22, gain: 0.06, delay: 0.09 },
  ],
  fizzle: [
    { type: 'sawtooth', from: 360, to: 70, duration: 0.32, gain: 0.045, delay: 0 },
    { type: 'square', from: 190, to: 42, duration: 0.3, gain: 0.028, delay: 0.02 },
  ],
  hit: [
    { type: 'square', from: 156, to: 48, duration: 0.2, gain: 0.09, delay: 0 },
    { type: 'triangle', from: 92, to: 40, duration: 0.24, gain: 0.07, delay: 0 },
  ],
};

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.AudioContext === 'function') return window.AudioContext;
  const legacy = (window as Window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  return typeof legacy === 'function' ? legacy : null;
}

/**
 * Short synthesized cues: wheel tick, cast, fizzle, hit, and a mechanical servo sweep.
 * Construction does not touch the audio device; the context opens on the first cue.
 */
export class GloveSoundSynthesizer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  playBuzz(pattern: BuzzPattern): void {
    const ctx = this.ensure();
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime;
    for (const voice of VOICES[pattern]) {
      this.playVoice(ctx, master, voice, start + voice.delay);
    }
    if (pattern === 'hit') this.playNoise(ctx, master, start, 0.12, 180, 80, 0.08);
    if (pattern === 'fizzle') this.playNoise(ctx, master, start, 0.28, 1400, 240, 0.035);
  }

  /** Pitch glide plus a band-passed grit, opening upward or closing downward. */
  playServo(open: boolean): void {
    const ctx = this.ensure();
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const from = open ? 70 : 168;
    const to = open ? 156 : 58;
    this.playVoice(
      ctx,
      master,
      { type: 'triangle', from, to, duration: 0.46, gain: 0.06, delay: 0 },
      now,
    );
    this.playNoise(ctx, master, now, 0.44, open ? 280 : 720, open ? 1400 : 220, 0.05);
  }

  playCommand(cmd: GloveCommand | HardwareCommand): void {
    const glove = normalizeGloveCommand(cmd);
    if (glove.cmd === 'buzz') this.playBuzz(glove.p);
    else if (glove.cmd === 'servo') this.playServo(glove.open);
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
  }

  private ensure(): AudioContext | null {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.noiseBuffer = null;
      return ctx;
    } catch {
      return null;
    }
  }

  private playVoice(ctx: AudioContext, master: GainNode, voice: Voice, start: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = voice.type;
    osc.frequency.setValueAtTime(voice.from, start);
    osc.frequency.linearRampToValueAtTime(voice.to, start + voice.duration);
    const attack = Math.min(0.012, voice.duration * 0.35);
    const peak = Math.max(voice.gain, 0.0002);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + voice.duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  private playNoise(
    ctx: AudioContext,
    master: GainNode,
    start: number,
    duration: number,
    fromHz: number,
    toHz: number,
    gainValue: number,
  ): void {
    const buffer = this.ensureNoise(ctx);
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(fromHz, start);
    filter.frequency.linearRampToValueAtTime(toHz, start + duration);
    gain.gain.setValueAtTime(Math.max(gainValue, 0.0002), start);
    gain.gain.linearRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(start + duration);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  private ensureNoise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }
}
