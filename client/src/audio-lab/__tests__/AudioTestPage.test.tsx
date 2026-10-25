import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioTestPage } from '../AudioTestPage';
import { FX_PRESETS, buildFxChain, fxMeta, speechTuningFor } from '../audioFx';
import {
  ACTIVE_NARRATOR_STORAGE_KEY,
  DEFAULT_NARRATOR,
  ENGINES,
  SCRIPT_PRESETS,
  VOICES,
  findVoice,
  readActiveNarrator,
  voiceKey,
  writeActiveNarrator,
} from '../voiceCatalog';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voice catalog', () => {
  it('lists every requested voice on its engine', () => {
    const expected: [string, string][] = [
      ['edge-neural', 'en-GB-RyanNeural'],
      ['edge-neural', 'en-GB-SoniaNeural'],
      ['edge-neural', 'en-US-GuyNeural'],
      ['edge-neural', 'en-AU-WilliamNeural'],
      ['edge-neural', 'en-IE-ConnorNeural'],
      ['kokoro-local', 'bm_fable'],
      ['kokoro-local', 'bm_george'],
      ['kokoro-local', 'bf_emma'],
      ['kokoro-local', 'am_adam'],
      ['macos-say', 'Daniel'],
      ['macos-say', 'Samantha'],
      ['macos-say', 'Bad News'],
      ['google-translate-tts', 'en-GB'],
      ['google-translate-tts', 'en-IE'],
      ['streamelements-polly', 'Brian'],
      ['streamelements-polly', 'Amy'],
      ['streamelements-polly', 'Matthew'],
    ];
    for (const [engine, voice] of expected) expect(findVoice(engine, voice), `${engine}:${voice}`).not.toBeNull();
  });

  it('pitches the Rusted Iron Boss down on Edge', () => {
    const boss = findVoice('edge-neural', 'en-US-GuyNeural');
    expect(boss?.pitch).toBe('-12Hz');
    expect(boss?.rate).toBe('-8%');
  });

  it('only accepts catalogued engine and voice pairs', () => {
    expect(findVoice('macos-say', 'Fred')).toBeNull();
    expect(findVoice('edge-neural', 'Daniel')).toBeNull();
    expect(findVoice('rm -rf', 'Daniel')).toBeNull();
    expect(findVoice('kokoro-local', 42)).toBeNull();
  });

  it('gives every voice a unique key and a known engine', () => {
    const keys = VOICES.map(voiceKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const voice of VOICES) expect(ENGINES.some((engine) => engine.id === voice.engine)).toBe(true);
  });

  it('round-trips the active narrator through localStorage', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(readActiveNarrator()).toBeNull();
    const fable = findVoice('kokoro-local', 'bm_fable')!;
    writeActiveNarrator(fable);
    expect(readActiveNarrator()).toEqual(fable);
    writeActiveNarrator(null);
    expect(readActiveNarrator()).toBeNull();
  });

  it('ignores a stored narrator that is no longer in the catalog', () => {
    const storage = memoryStorage();
    storage.setItem(ACTIVE_NARRATOR_STORAGE_KEY, JSON.stringify({ engine: 'macos-say', voice: 'Whisper' }));
    vi.stubGlobal('localStorage', storage);
    expect(readActiveNarrator()).toBeNull();
    storage.setItem(ACTIVE_NARRATOR_STORAGE_KEY, '{not json');
    expect(readActiveNarrator()).toBeNull();
  });
});

describe('audio FX rack', () => {
  it('uses the requested playback rates', () => {
    expect(fxMeta('clean').playbackRate).toBe(1);
    expect(fxMeta('boss').playbackRate).toBe(0.86);
    expect(fxMeta('whisper').playbackRate).toBe(1.06);
  });

  it('approximates presets with speech pitch and rate inside the Web Speech limits', () => {
    expect(speechTuningFor('clean', 0.92, 1)).toEqual({ pitch: 0.92, rate: 1 });
    const boss = speechTuningFor('boss', 0.92, 1);
    expect(boss.pitch).toBeLessThan(0.92);
    expect(boss.rate).toBeCloseTo(0.86);
    expect(speechTuningFor('whisper', 1.9, 1).pitch).toBeLessThanOrEqual(2);
  });

  it('builds a ring-mod carrier and a bass shelf for the boss voice', () => {
    const created: string[] = [];
    const node = (kind: string) => {
      created.push(kind);
      return {
        connect: vi.fn(),
        gain: { value: 1 },
        frequency: { value: 0 },
        Q: { value: 0 },
        delayTime: { value: 0 },
        type: '',
        buffer: null,
      };
    };
    const ctx = {
      sampleRate: 8000,
      createGain: () => node('gain'),
      createBiquadFilter: () => node('biquad'),
      createOscillator: () => node('oscillator'),
      createDelay: () => node('delay'),
      createConvolver: () => node('convolver'),
      createBuffer: (channels: number, length: number) => ({
        getChannelData: () => new Float32Array(length),
        numberOfChannels: channels,
      }),
    } as unknown as BaseAudioContext;
    const source = { connect: vi.fn(), playbackRate: { value: 1 } } as unknown as AudioBufferSourceNode;
    const destination = {} as AudioNode;

    const extras = buildFxChain(ctx, source, destination, 'boss');
    expect(source.playbackRate.value).toBe(0.86);
    expect(extras).toHaveLength(1);
    expect(created).toContain('oscillator');
    expect(created).toContain('convolver');

    created.length = 0;
    expect(buildFxChain(ctx, source, destination, 'clean')).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(source.playbackRate.value).toBe(1);
  });
});

describe('AudioTestPage', () => {
  it('renders the script presets, both engine columns, the FX rack, and the soundboard', () => {
    const html = renderToStaticMarkup(createElement(AudioTestPage));
    expect(html).toContain('/debug/audio');
    for (const preset of SCRIPT_PRESETS) expect(html).toContain(`data-testid="script-${preset.id}"`);
    expect(html).toContain('Local M4 Pro Engines');
    expect(html).toContain('Online No-API-Key Engines');
    for (const engine of ENGINES) expect(html).toContain(`data-testid="engine-${engine.id}"`);
    for (const voice of VOICES) expect(html).toContain(`data-testid="voice-${voiceKey(voice).replaceAll('&', '&amp;')}"`);
    for (const preset of FX_PRESETS) expect(html).toContain(`data-testid="fx-${preset.id}"`);
    expect(html).toContain('▶ Play Line');
    expect(html).toContain('⚡ Benchmark');
    expect(html).toContain('⭐ Set as narrator');
    expect(html).toContain('whispers_of_the_enchanted_vale_title_theme.wav');
    expect(html).toContain('arcane_initiative.wav');
    expect(html).toContain('eclipse_of_the_archmage_boss_theme.wav');
    for (const sfx of ['tick', 'cast', 'fizzle', 'hit', 'servo-open', 'chime']) expect(html).toContain(`data-testid="sfx-${sfx}"`);
  });

  it('starts on the storybook intro line', () => {
    const html = renderToStaticMarkup(createElement(AudioTestPage));
    expect(html).toContain('Once upon a time, in a wood woven from your midnight group chat');
  });

  it('shows the stored narrator as active', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeActiveNarrator(findVoice('kokoro-local', 'am_adam'));
    const html = renderToStaticMarkup(createElement(AudioTestPage));
    expect(html).toContain('Kokoro Adam · Deep Boss');
    expect(html).toContain('⭐ Active');
  });

  it('defaults the game narrator to the server voice and the dev fallback to the Royal Bard', () => {
    const html = renderToStaticMarkup(createElement(AudioTestPage));
    expect(html).toContain('Game server voice (default)');
    expect(DEFAULT_NARRATOR.voice).toBe('en-GB-RyanNeural');
  });
});
