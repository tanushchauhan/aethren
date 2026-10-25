/**
 * Web Audio effects for TTS clips on /debug/audio. Browser speechSynthesis cannot be routed through Web Audio,
 * so for that engine the same presets are approximated with utterance pitch and rate instead.
 */

export type FxPreset = 'clean' | 'hall' | 'boss' | 'whisper';

export interface FxMeta {
  id: FxPreset;
  label: string;
  blurb: string;
  playbackRate: number;
}

export const FX_PRESETS: readonly FxMeta[] = [
  { id: 'clean', label: 'None (Clean)', blurb: 'The raw clip.', playbackRate: 1 },
  {
    id: 'hall',
    label: 'Enchanted Hall Reverb',
    blurb: 'Pre-delayed convolution tail with a warm low-pass, like a stone storybook hall.',
    playbackRate: 1,
  },
  {
    id: 'boss',
    label: 'Boss Monster Voice',
    blurb: '0.86x playback, low-shelf bass boost, and a subtle ring-mod growl.',
    playbackRate: 0.86,
  },
  {
    id: 'whisper',
    label: 'Fairy Whisper',
    blurb: '1.06x playback, high-shelf shimmer, and a light airy tail.',
    playbackRate: 1.06,
  },
];

export function fxMeta(id: FxPreset): FxMeta {
  return FX_PRESETS.find((preset) => preset.id === id)!;
}

/** Utterance pitch and rate that stand in for a preset when the clip is browser speech. */
export function speechTuningFor(fx: FxPreset, pitch: number, rate: number): { pitch: number; rate: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (fx === 'boss') return { pitch: clamp(pitch * 0.55, 0, 2), rate: clamp(rate * 0.86, 0.1, 10) };
  if (fx === 'whisper') return { pitch: clamp(pitch * 1.35, 0, 2), rate: clamp(rate * 1.06, 0.1, 10) };
  return { pitch, rate };
}

export interface FxPlayback {
  /** Resolves when the clip finishes or is stopped. */
  ended: Promise<void>;
  stop(): void;
}

const impulses = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

/** Exponentially decaying stereo noise: a cheap, convincing room without shipping an impulse file. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  let byLength = impulses.get(ctx);
  if (!byLength) {
    byLength = new Map();
    impulses.set(ctx, byLength);
  }
  const cached = byLength.get(seconds);
  if (cached) return cached;
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 3.2);
    }
  }
  byLength.set(seconds, buffer);
  return buffer;
}

function reverbSend(ctx: BaseAudioContext, input: AudioNode, output: AudioNode, seconds: number, wet: number): void {
  const preDelay = ctx.createDelay(0.2);
  preDelay.delayTime.value = 0.028;
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse(ctx, seconds);
  const warmth = ctx.createBiquadFilter();
  warmth.type = 'lowpass';
  warmth.frequency.value = 3600;
  const gain = ctx.createGain();
  gain.gain.value = wet;
  input.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(warmth);
  warmth.connect(gain);
  gain.connect(output);
}

/**
 * Wires the preset between a source and the destination. Returns extra sources (the ring-mod oscillator)
 * that have to start and stop with the clip.
 */
export function buildFxChain(
  ctx: BaseAudioContext,
  source: AudioBufferSourceNode,
  destination: AudioNode,
  fx: FxPreset,
): AudioScheduledSourceNode[] {
  source.playbackRate.value = fxMeta(fx).playbackRate;
  if (fx === 'clean') {
    source.connect(destination);
    return [];
  }

  if (fx === 'hall') {
    const dry = ctx.createGain();
    dry.gain.value = 0.78;
    source.connect(dry);
    dry.connect(destination);
    reverbSend(ctx, source, destination, 2.6, 0.5);
    return [];
  }

  if (fx === 'boss') {
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 220;
    bass.gain.value = 9;
    const mud = ctx.createBiquadFilter();
    mud.type = 'peaking';
    mud.frequency.value = 2600;
    mud.Q.value = 0.8;
    mud.gain.value = -3;
    source.connect(bass);
    bass.connect(mud);

    const dry = ctx.createGain();
    dry.gain.value = 0.86;
    mud.connect(dry);
    dry.connect(destination);

    // Ring modulation: a 38 Hz carrier drives the gain of a copy of the voice, mixed in low for growl.
    const ring = ctx.createGain();
    ring.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = 38;
    carrier.connect(ring.gain);
    const ringMix = ctx.createGain();
    ringMix.gain.value = 0.32;
    mud.connect(ring);
    ring.connect(ringMix);
    ringMix.connect(destination);

    reverbSend(ctx, mud, destination, 1.4, 0.18);
    return [carrier];
  }

  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 5200;
  air.gain.value = 8;
  const thin = ctx.createBiquadFilter();
  thin.type = 'highpass';
  thin.frequency.value = 180;
  source.connect(thin);
  thin.connect(air);
  air.connect(destination);
  reverbSend(ctx, air, destination, 1.8, 0.24);
  return [];
}

/** Decodes a clip and plays it through the preset. `onStart` fires as the first sample is scheduled. */
export async function playWithFx(
  ctx: AudioContext,
  data: ArrayBuffer,
  fx: FxPreset,
  onStart?: () => void,
): Promise<FxPlayback> {
  if (ctx.state === 'suspended') await ctx.resume();
  const buffer = await ctx.decodeAudioData(data.slice(0));
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const extras = buildFxChain(ctx, source, ctx.destination, fx);
  let stopped = false;
  const ended = new Promise<void>((resolve) => {
    source.onended = () => {
      for (const extra of extras) {
        try {
          extra.stop();
        } catch {
          /* Already stopped. */
        }
      }
      resolve();
    };
  });
  const startAt = ctx.currentTime;
  for (const extra of extras) extra.start(startAt);
  source.start(startAt);
  onStart?.();
  return {
    ended,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        /* Already stopped. */
      }
    },
  };
}
