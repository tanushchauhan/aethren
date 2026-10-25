import { useCallback, useEffect, useRef, useState } from 'react';
import { GloveSoundSynthesizer } from '../hardware/soundSynthesizer';
import { playSilhouetteChime } from '../vision/VisionCanvas';
import { playNarration, stopNarration } from '../combat-ui/audio/tts';
import { FX_PRESETS, fxMeta, playWithFx, speechTuningFor, type FxPlayback, type FxPreset } from './audioFx';
import { DEBUG_AUDIO_PATH } from '../debugRoutes';
import {
  COMBAT_DEADLINE_MS,
  DEBUG_TTS_ENDPOINT,
  ENGINES,
  MAX_TTS_TEXT_LENGTH,
  SCRIPT_PRESETS,
  readActiveNarrator,
  voiceKey,
  voicesFor,
  writeActiveNarrator,
  type EngineColumn,
  type EngineMeta,
  type VoiceOption,
} from './voiceCatalog';

type CardPhase = 'idle' | 'loading' | 'playing' | 'error';

interface CardState {
  phase: CardPhase;
  /** Request start to the first scheduled sample (play) or to a decoded clip (benchmark). */
  ttfaMs: number | null;
  serverMs: number | null;
  cached: boolean | null;
  via: string | null;
  error: string | null;
  benchmark: boolean;
}

interface KokoroStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  progress: number;
  loadMs: number | null;
  error: string | null;
}

interface ServerStatus {
  kokoro: KokoroStatus;
  macosSay: boolean;
  cacheSize: number;
}

type MiddlewareState = { kind: 'checking' } | { kind: 'online'; status: ServerStatus } | { kind: 'offline' };

const IDLE_CARD: CardState = {
  phase: 'idle',
  ttfaMs: null,
  serverMs: null,
  cached: null,
  via: null,
  error: null,
  benchmark: false,
};

const MUSIC_TRACKS = [
  { id: 'title', label: 'Whispers of the Enchanted Vale', note: 'Title theme', src: '/audio/whispers_of_the_enchanted_vale_title_theme.wav' },
  { id: 'combat', label: 'Arcane Initiative', note: 'Encounter and calibration', src: '/audio/arcane_initiative.wav' },
  { id: 'boss', label: 'Eclipse of the Archmage', note: 'Boss theme', src: '/audio/eclipse_of_the_archmage_boss_theme.wav' },
] as const;

type SfxId = 'tick' | 'cast' | 'fizzle' | 'hit' | 'servo-open' | 'servo-close' | 'chime';

const SFX: readonly { id: SfxId; label: string; note: string }[] = [
  { id: 'tick', label: 'Tick', note: 'Spell wheel detent' },
  { id: 'cast', label: 'Cast', note: 'Spell released' },
  { id: 'fizzle', label: 'Fizzle', note: 'Incantation failed' },
  { id: 'hit', label: 'Hit', note: 'Boss lands a blow' },
  { id: 'servo-open', label: 'Servo open', note: 'Storybook opens' },
  { id: 'servo-close', label: 'Servo close', note: 'Storybook shuts' },
  { id: 'chime', label: 'Silhouette return', note: 'Back in the outline' },
];

const COLUMNS: readonly { id: EngineColumn; title: string; blurb: string }[] = [
  { id: 'local', title: '💻 Local M4 Pro Engines', blurb: '100% offline once warmed. 0 credits.' },
  { id: 'online', title: '🌐 Online No-API-Key Engines', blurb: 'Free cloud voices. Needs the network.' },
];

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.AudioContext === 'function') return window.AudioContext;
  const legacy = (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return typeof legacy === 'function' ? legacy : null;
}

function pickBrowserVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => voice.lang.replace('_', '-') === lang && voice.localService) ??
    voices.find((voice) => voice.lang.replace('_', '-') === lang) ??
    voices.find((voice) => voice.lang.startsWith('en')) ??
    null
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* Not JSON. */
  }
  return `HTTP ${response.status}`;
}

export function AudioTestPage() {
  const [text, setText] = useState<string>(SCRIPT_PRESETS[0]!.text);
  const [presetId, setPresetId] = useState<string | null>(SCRIPT_PRESETS[0]!.id);
  const [fx, setFx] = useState<FxPreset>('clean');
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [active, setActive] = useState<VoiceOption | null>(() => readActiveNarrator());
  const [middleware, setMiddleware] = useState<MiddlewareState>({ kind: 'checking' });
  const [benchingColumn, setBenchingColumn] = useState<EngineColumn | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const playbackRef = useRef<FxPlayback | null>(null);
  const runRef = useRef(0);

  const patchCard = useCallback((key: string, patch: Partial<CardState>) => {
    setCards((previous) => ({ ...previous, [key]: { ...(previous[key] ?? IDLE_CARD), ...patch } }));
  }, []);

  const refreshStatus = useCallback(async (): Promise<ServerStatus | null> => {
    try {
      const response = await fetch(`${DEBUG_TTS_ENDPOINT}/status`, { cache: 'no-store' });
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) throw new Error('offline');
      const status = (await response.json()) as ServerStatus;
      setMiddleware({ kind: 'online', status });
      return status;
    } catch {
      setMiddleware({ kind: 'offline' });
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const kokoroLoading = middleware.kind === 'online' && middleware.status.kokoro.state === 'loading';
  const kokoroBusy = Object.entries(cards).some(([key, card]) => key.startsWith('kokoro-local:') && card.phase === 'loading');
  useEffect(() => {
    if (!kokoroLoading && !kokoroBusy) return;
    const timer = window.setInterval(() => void refreshStatus(), 700);
    return () => window.clearInterval(timer);
  }, [kokoroLoading, kokoroBusy, refreshStatus]);

  useEffect(
    () => () => {
      playbackRef.current?.stop();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx && ctx.state !== 'closed') void ctx.close();
    },
    [],
  );

  function audioContext(): AudioContext {
    if (ctxRef.current && ctxRef.current.state !== 'closed') return ctxRef.current;
    const Ctor = audioContextCtor();
    if (!Ctor) throw new Error('Web Audio is not available in this browser');
    ctxRef.current = new Ctor();
    return ctxRef.current;
  }

  function stopAll(): void {
    runRef.current += 1;
    playbackRef.current?.stop();
    playbackRef.current = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    stopNarration();
    setCards((previous) => {
      const next: Record<string, CardState> = {};
      for (const [key, card] of Object.entries(previous)) {
        next[key] = card.phase === 'playing' || card.phase === 'loading' ? { ...card, phase: 'idle' } : card;
      }
      return next;
    });
  }

  function speakBrowser(option: VoiceOption, line: string, benchmark: boolean, run: number): Promise<void> {
    const key = voiceKey(option);
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        patchCard(key, { phase: 'error', error: 'speechSynthesis is not available here' });
        resolve();
        return;
      }
      const tuning = speechTuningFor(fx, Number(option.pitch ?? 1), Number(option.rate ?? 1));
      const utterance = new SpeechSynthesisUtterance(line);
      utterance.lang = option.voice;
      utterance.voice = pickBrowserVoice(option.voice);
      utterance.pitch = tuning.pitch;
      utterance.rate = tuning.rate;
      if (benchmark) utterance.volume = 0;
      const started = performance.now();
      utterance.onstart = () => {
        if (run !== runRef.current) return;
        patchCard(key, {
          phase: benchmark ? 'idle' : 'playing',
          ttfaMs: performance.now() - started,
          serverMs: null,
          cached: null,
          via: utterance.voice?.name ?? null,
          benchmark,
        });
        if (benchmark) {
          window.speechSynthesis.cancel();
          resolve();
        }
      };
      utterance.onend = () => {
        if (run === runRef.current) patchCard(key, { phase: 'idle' });
        resolve();
      };
      utterance.onerror = (event) => {
        if (run === runRef.current && event.error !== 'canceled' && event.error !== 'interrupted') {
          patchCard(key, { phase: 'error', error: `speechSynthesis: ${event.error}` });
        }
        resolve();
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  async function runVoice(option: VoiceOption, benchmark: boolean, sequential = false): Promise<void> {
    const line = text.trim();
    if (!line) return;
    if (!sequential) stopAll();
    const run = runRef.current;
    const key = voiceKey(option);
    patchCard(key, { phase: 'loading', error: null, benchmark });

    if (option.engine === 'browser-web-speech') {
      await speakBrowser(option, line, benchmark, run);
      return;
    }

    try {
      const ctx = audioContext();
      if (ctx.state === 'suspended') void ctx.resume();
      const started = performance.now();
      const response = await fetch(DEBUG_TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/*,application/json' },
        body: JSON.stringify({ text: line, engine: option.engine, voice: option.voice, nocache: benchmark }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const type = response.headers.get('content-type') ?? '';
      if (!type.startsWith('audio/')) throw new Error(await readError(response));
      const meta = {
        serverMs: Number(response.headers.get('X-TTS-Latency-Ms') ?? NaN),
        cached: response.headers.get('X-TTS-Cached') === 'hit',
        via: response.headers.get('X-TTS-Engine'),
      };
      const data = await response.arrayBuffer();
      if (run !== runRef.current) return;

      if (benchmark) {
        await ctx.decodeAudioData(data.slice(0));
        patchCard(key, { ...meta, phase: 'idle', ttfaMs: performance.now() - started, benchmark: true });
        return;
      }

      const playback = await playWithFx(ctx, data, fx, () => {
        patchCard(key, { ...meta, phase: 'playing', ttfaMs: performance.now() - started, benchmark: false });
      });
      if (run !== runRef.current) {
        playback.stop();
        return;
      }
      playbackRef.current = playback;
      await playback.ended;
      if (run === runRef.current) patchCard(key, { phase: 'idle' });
    } catch (error) {
      if (run !== runRef.current) return;
      patchCard(key, { phase: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (option.engine === 'kokoro-local') void refreshStatus();
    }
  }

  async function benchmarkColumn(column: EngineColumn): Promise<void> {
    stopAll();
    setBenchingColumn(column);
    const run = runRef.current;
    for (const engine of ENGINES.filter((item) => item.column === column)) {
      for (const option of voicesFor(engine.id)) {
        if (run !== runRef.current) break;
        await runVoice(option, true, true);
      }
    }
    setBenchingColumn(null);
  }

  function chooseNarrator(option: VoiceOption | null): void {
    writeActiveNarrator(option);
    setActive(option);
  }

  function warmKokoro(): void {
    void fetch(`${DEBUG_TTS_ENDPOINT}/warmup`, { method: 'POST' }).then(() => refreshStatus());
  }

  function clearCache(): void {
    void fetch(`${DEBUG_TTS_ENDPOINT}/cache`, { method: 'DELETE' }).then(() => refreshStatus());
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6" data-testid="audio-test-page">
      <p className="text-xs uppercase tracking-[0.32em] text-amber-200/70">Aethren · {DEBUG_AUDIO_PATH}</p>
      <h1 className="mt-2 font-serif text-4xl sm:text-5xl">Narrator &amp; Sound Modes</h1>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-amber-100/80">
        Compare local M4 Pro speech against free online neural voices on the lines the storybook actually speaks.
        Combat telegraphs must start within {COMBAT_DEADLINE_MS} ms or the game falls back to browser speech.
      </p>

      <StatusStrip
        middleware={middleware}
        active={active}
        onClearNarrator={() => chooseNarrator(null)}
        onWarmKokoro={warmKokoro}
        onClearCache={clearCache}
        onStop={stopAll}
        onTestInGame={() => {
          stopAll();
          playNarration({ text: text.trim() });
        }}
        canTestInGame={text.trim().length > 0}
      />

      <section className="mt-8" aria-labelledby="audio-script-heading">
        <SectionHeading id="audio-script-heading" letter="A" title="Fairy-tale script" />
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Script presets">
          {SCRIPT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`script-${preset.id}`}
              aria-pressed={presetId === preset.id}
              onClick={() => {
                setPresetId(preset.id);
                setText(preset.text);
              }}
              className={chipClass(presetId === preset.id)}
            >
              <span aria-hidden="true">{preset.icon}</span> {preset.title}
            </button>
          ))}
        </div>
        <label className="mt-3 block">
          <span className="sr-only">Line to speak</span>
          <textarea
            value={text}
            maxLength={MAX_TTS_TEXT_LENGTH}
            rows={3}
            onChange={(event) => {
              setText(event.target.value);
              setPresetId(SCRIPT_PRESETS.find((preset) => preset.text === event.target.value)?.id ?? null);
            }}
            className="w-full rounded-2xl border border-amber-100/15 bg-black/30 px-4 py-3 font-serif text-lg leading-relaxed text-amber-50 placeholder:text-amber-100/40 focus:border-amber-200/50 focus:outline-none"
            placeholder="Type any line for the narrator…"
          />
        </label>
        <p className="mt-1 text-right font-mono text-[11px] text-amber-100/50">
          {text.length} / {MAX_TTS_TEXT_LENGTH}
        </p>
      </section>

      <section className="mt-6" aria-labelledby="audio-fx-heading">
        <SectionHeading id="audio-fx-heading" letter="C" title="Theme audio FX rack" />
        <div className="mt-3 grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Voice effect">
          {FX_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={fx === preset.id}
              data-testid={`fx-${preset.id}`}
              onClick={() => setFx(preset.id)}
              className={
                fx === preset.id
                  ? 'rounded-2xl border border-emerald-200/50 bg-emerald-300/15 p-3 text-left'
                  : 'rounded-2xl border border-amber-100/15 bg-white/5 p-3 text-left hover:bg-white/10'
              }
            >
              <p className="text-sm font-medium">{preset.label}</p>
              <p className="mt-1 text-xs leading-snug text-amber-100/70">{preset.blurb}</p>
            </button>
          ))}
        </div>
        {fx !== 'clean' ? (
          <p className="mt-2 text-xs text-amber-100/60">
            {fxMeta(fx).label} runs through Web Audio on every server clip. Browser speech cannot be routed through Web
            Audio, so it gets the matching pitch and rate instead.
          </p>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="audio-grid-heading">
        <SectionHeading id="audio-grid-heading" letter="B" title="Engine and voice comparison" />
        <div className="mt-3 grid items-start gap-6 lg:grid-cols-2">
          {COLUMNS.map((column) => (
            <div key={column.id} className="space-y-4" data-testid={`column-${column.id}`}>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h3 className="font-serif text-2xl">{column.title}</h3>
                  <p className="text-xs text-amber-100/60">{column.blurb}</p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-amber-100/20 px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-40"
                  disabled={benchingColumn !== null || !text.trim()}
                  onClick={() => void benchmarkColumn(column.id)}
                >
                  {benchingColumn === column.id ? 'Benchmarking…' : '⚡ Benchmark all'}
                </button>
              </div>
              {ENGINES.filter((engine) => engine.column === column.id).map((engine) => (
                <EngineGroup
                  key={engine.id}
                  engine={engine}
                  middleware={middleware}
                  cards={cards}
                  active={active}
                  disabled={!text.trim()}
                  onPlay={(option) => void runVoice(option, false)}
                  onBenchmark={(option) => void runVoice(option, true)}
                  onActivate={chooseNarrator}
                />
              ))}
            </div>
          ))}
        </div>
      </section>

      <Soundboard />
    </main>
  );
}

function SectionHeading({ id, letter, title }: { id: string; letter: string; title: string }) {
  return (
    <h2 id={id} className="flex items-center gap-3 font-serif text-2xl">
      <span className="grid h-7 w-7 place-items-center rounded-full bg-amber-200 font-mono text-xs text-stone-950">
        {letter}
      </span>
      {title}
    </h2>
  );
}

function StatusStrip({
  middleware,
  active,
  onClearNarrator,
  onWarmKokoro,
  onClearCache,
  onStop,
  onTestInGame,
  canTestInGame,
}: {
  middleware: MiddlewareState;
  active: VoiceOption | null;
  onClearNarrator: () => void;
  onWarmKokoro: () => void;
  onClearCache: () => void;
  onStop: () => void;
  onTestInGame: () => void;
  canTestInGame: boolean;
}) {
  const kokoro = middleware.kind === 'online' ? middleware.status.kokoro : null;
  return (
    <div className="mt-6 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-3xl border border-amber-200/25 bg-amber-300/10 p-4" data-testid="active-narrator">
        <p className="text-[11px] uppercase tracking-[0.22em] text-amber-200/80">⭐ Active game narrator</p>
        <p className="mt-1 font-serif text-xl">
          {active ? `${active.label} · ${active.persona}` : 'Game server voice (default)'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-amber-100/70">
          {active
            ? `In-game narration asks this dev server's /api/tts for ${active.engine}. Uncached lines slower than ${COMBAT_DEADLINE_MS} ms fall back to browser speech.`
            : 'Narration uses the game server, then this dev server, then browser speech. Pick a voice below to override it.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full bg-amber-200 px-3 py-1.5 text-sm font-medium text-stone-950 disabled:opacity-40"
            onClick={onTestInGame}
            disabled={!canTestInGame}
          >
            ▶ Test through game narrator
          </button>
          {active ? (
            <button type="button" className={chipClass(false)} onClick={onClearNarrator}>
              Use game server voice
            </button>
          ) : null}
          <button type="button" className={chipClass(false)} onClick={onStop}>
            ■ Stop all
          </button>
        </div>
      </div>
      <div className="rounded-3xl border border-amber-100/15 bg-white/5 p-4 text-sm" data-testid="tts-middleware-status">
        <p className="text-[11px] uppercase tracking-[0.22em] text-amber-200/70">Dev TTS middleware</p>
        {middleware.kind === 'checking' ? <p className="mt-1">Checking {DEBUG_TTS_ENDPOINT}…</p> : null}
        {middleware.kind === 'offline' ? (
          <p className="mt-1 text-amber-100" role="status">
            {DEBUG_TTS_ENDPOINT} is not answering. Run the client with <span className="font-mono">pnpm dev</span>; only
            browser speech works without it.
          </p>
        ) : null}
        {middleware.kind === 'online' ? (
          <ul className="mt-1 space-y-1">
            <li>
              Kokoro-82M: <KokoroLabel status={middleware.status.kokoro} />
            </li>
            <li>macOS say: {middleware.status.macosSay ? 'available' : 'not on this machine'}</li>
            <li>Cached clips: {middleware.status.cacheSize}</li>
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={chipClass(false)}
            onClick={onWarmKokoro}
            disabled={middleware.kind !== 'online' || kokoro?.state === 'loading' || kokoro?.state === 'ready'}
          >
            Warm up Kokoro
          </button>
          <button type="button" className={chipClass(false)} onClick={onClearCache} disabled={middleware.kind !== 'online'}>
            Clear cache
          </button>
        </div>
      </div>
    </div>
  );
}

function KokoroLabel({ status }: { status: KokoroStatus }) {
  if (status.state === 'ready') return <span className="text-emerald-200">ready (loaded in {status.loadMs} ms)</span>;
  if (status.state === 'loading') {
    return <span className="text-amber-200">downloading / warming {Math.round(status.progress * 100)}%</span>;
  }
  if (status.state === 'error') return <span className="text-rose-200">failed: {status.error}</span>;
  return <span>not loaded (first request downloads about 90 MB)</span>;
}

function EngineGroup({
  engine,
  middleware,
  cards,
  active,
  disabled,
  onPlay,
  onBenchmark,
  onActivate,
}: {
  engine: EngineMeta;
  middleware: MiddlewareState;
  cards: Record<string, CardState>;
  active: VoiceOption | null;
  disabled: boolean;
  onPlay: (option: VoiceOption) => void;
  onBenchmark: (option: VoiceOption) => void;
  onActivate: (option: VoiceOption) => void;
}) {
  const needsServer = engine.id !== 'browser-web-speech';
  const serverDown = needsServer && middleware.kind === 'offline';
  const sayMissing = engine.id === 'macos-say' && middleware.kind === 'online' && !middleware.status.macosSay;
  return (
    <section className="rounded-3xl border border-amber-100/15 bg-white/[0.03] p-4" data-testid={`engine-${engine.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-serif text-lg">{engine.title}</h4>
        <span className="font-mono text-[11px] text-amber-200/60">{engine.id}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-amber-100/65">{engine.blurb}</p>
      {engine.id === 'kokoro-local' && middleware.kind === 'online' ? (
        <p className="mt-1 text-xs text-amber-100/80">
          Model: <KokoroLabel status={middleware.status.kokoro} />
        </p>
      ) : null}
      {sayMissing ? <p className="mt-1 text-xs text-rose-200">This machine has no /usr/bin/say.</p> : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {voicesFor(engine.id).map((option) => (
          <VoiceCard
            key={voiceKey(option)}
            option={option}
            card={cards[voiceKey(option)] ?? IDLE_CARD}
            isActive={active !== null && voiceKey(active) === voiceKey(option)}
            disabled={disabled || serverDown || sayMissing}
            onPlay={() => onPlay(option)}
            onBenchmark={() => onBenchmark(option)}
            onActivate={() => onActivate(option)}
          />
        ))}
      </div>
    </section>
  );
}

function VoiceCard({
  option,
  card,
  isActive,
  disabled,
  onPlay,
  onBenchmark,
  onActivate,
}: {
  option: VoiceOption;
  card: CardState;
  isActive: boolean;
  disabled: boolean;
  onPlay: () => void;
  onBenchmark: () => void;
  onActivate: () => void;
}) {
  const busy = card.phase === 'loading';
  return (
    <article
      className={
        isActive
          ? 'rounded-2xl border border-amber-200/60 bg-amber-300/10 p-3'
          : 'rounded-2xl border border-amber-100/10 bg-black/20 p-3'
      }
      data-testid={`voice-${voiceKey(option)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{option.label}</p>
          <p className="truncate text-xs text-amber-100/65">{option.persona}</p>
        </div>
        {isActive ? <span className="text-xs text-amber-200">⭐ Active</span> : null}
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-amber-100/45">
        {option.voice}
        {option.pitch && option.engine === 'edge-neural' ? ` · ${option.pitch} ${option.rate ?? ''}` : ''}
      </p>
      <LatencyBadge card={card} />
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-medium text-stone-950 disabled:opacity-40"
          onClick={onPlay}
          disabled={disabled || busy}
        >
          {busy && !card.benchmark ? 'Summoning…' : card.phase === 'playing' ? '▶ Replay' : '▶ Play Line'}
        </button>
        <button
          type="button"
          className="rounded-full border border-amber-100/20 px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-40"
          onClick={onBenchmark}
          disabled={disabled || busy}
          title="Synthesize uncached and time it without playing"
        >
          {busy && card.benchmark ? 'Timing…' : '⚡ Benchmark'}
        </button>
        <button
          type="button"
          className="rounded-full border border-amber-100/20 px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-40"
          onClick={onActivate}
          disabled={isActive}
        >
          ⭐ Set as narrator
        </button>
      </div>
    </article>
  );
}

function LatencyBadge({ card }: { card: CardState }) {
  if (card.phase === 'error') {
    return (
      <p className="mt-2 rounded-lg bg-rose-500/15 px-2 py-1 text-[11px] leading-snug text-rose-100" role="status">
        {card.error}
      </p>
    );
  }
  if (card.ttfaMs === null) {
    return <p className="mt-2 text-[11px] text-amber-100/40">{card.phase === 'loading' ? 'Generating…' : 'Not timed yet'}</p>;
  }
  const ms = Math.round(card.ttfaMs);
  const fast = ms <= COMBAT_DEADLINE_MS;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span
        className={
          fast
            ? 'rounded-full bg-emerald-400/20 px-2 py-0.5 font-mono text-emerald-100'
            : 'rounded-full bg-rose-400/20 px-2 py-0.5 font-mono text-rose-100'
        }
        title="Time to first audio"
      >
        ⚡ {ms} ms {fast ? `✓ <${COMBAT_DEADLINE_MS}` : `✗ >${COMBAT_DEADLINE_MS}`}
      </span>
      {card.serverMs !== null && Number.isFinite(card.serverMs) ? (
        <span className="font-mono text-amber-100/55">synth {Math.round(card.serverMs)} ms</span>
      ) : null}
      {card.cached !== null ? (
        <span className={card.cached ? 'text-sky-200' : 'text-amber-100/55'}>{card.cached ? '● cached' : '○ fresh'}</span>
      ) : null}
      {card.benchmark ? <span className="text-amber-100/55">benchmark</span> : null}
      {card.via && card.via.includes('(') ? <span className="text-amber-100/55">{card.via}</span> : null}
    </div>
  );
}

function Soundboard() {
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const sfxRef = useRef<GloveSoundSynthesizer | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.5);
  const [musicError, setMusicError] = useState<string | null>(null);

  useEffect(
    () => () => {
      const audio = musicRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      musicRef.current = null;
      sfxRef.current?.dispose();
      sfxRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (musicRef.current) musicRef.current.volume = volume;
  }, [volume]);

  function toggleTrack(id: string, src: string): void {
    if (!musicRef.current) {
      musicRef.current = new Audio();
      musicRef.current.loop = true;
    }
    const audio = musicRef.current;
    audio.volume = volume;
    if (track === id) {
      audio.pause();
      setTrack(null);
      return;
    }
    audio.src = src;
    setMusicError(null);
    void audio.play().then(
      () => setTrack(id),
      (error: unknown) => {
        setTrack(null);
        setMusicError(error instanceof Error ? error.message : 'Playback was blocked');
      },
    );
  }

  function playSfx(id: SfxId): void {
    if (id === 'chime') {
      playSilhouetteChime();
      return;
    }
    if (!sfxRef.current) sfxRef.current = new GloveSoundSynthesizer();
    const synth = sfxRef.current;
    void synth.resume();
    if (id === 'servo-open') synth.playServo(true);
    else if (id === 'servo-close') synth.playServo(false);
    else synth.playBuzz(id);
  }

  return (
    <section className="mt-10" aria-labelledby="audio-soundboard-heading">
      <SectionHeading id="audio-soundboard-heading" letter="D" title="Game music & hardware SFX soundboard" />
      <div className="mt-3 grid gap-6 lg:grid-cols-2">
        <div className="rounded-3xl border border-amber-100/15 bg-white/[0.03] p-4" data-testid="music-board">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-serif text-lg">Music tracks</h3>
            <label className="flex items-center gap-2 text-xs text-amber-100/70">
              Volume
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
                className="accent-amber-200"
              />
            </label>
          </div>
          <ul className="mt-3 space-y-2">
            {MUSIC_TRACKS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={track === item.id}
                  onClick={() => toggleTrack(item.id, item.src)}
                  className={
                    track === item.id
                      ? 'flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-200/50 bg-emerald-300/20 px-3 py-2 text-left text-emerald-50'
                      : 'flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-100/20 bg-white/5 px-3 py-2 text-left text-amber-50 hover:bg-white/10'
                  }
                >
                  <span>
                    <span className="block text-sm">{item.label}</span>
                    <span className="block font-mono text-[10px] text-amber-100/50">
                      {item.note} · {item.src.split('/').pop()}
                    </span>
                  </span>
                  <span aria-hidden="true">{track === item.id ? '■' : '▶'}</span>
                </button>
              </li>
            ))}
          </ul>
          {musicError ? <p className="mt-2 text-xs text-rose-200">{musicError}</p> : null}
        </div>
        <div className="rounded-3xl border border-amber-100/15 bg-white/[0.03] p-4" data-testid="sfx-board">
          <h3 className="font-serif text-lg">Enchanted Glove synth cues</h3>
          <p className="mt-1 text-xs text-amber-100/60">The same Web Audio stand-ins the glove simulator plays.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SFX.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`sfx-${item.id}`}
                onClick={() => playSfx(item.id)}
                className="rounded-2xl border border-amber-100/15 bg-black/20 p-3 text-left hover:border-amber-200/40 hover:bg-white/5"
              >
                <span className="block text-sm">{item.label}</span>
                <span className="block text-[11px] text-amber-100/55">{item.note}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function chipClass(active: boolean): string {
  return active
    ? 'rounded-full border border-emerald-200/50 bg-emerald-300/20 px-3 py-2 text-sm text-emerald-50 disabled:opacity-40'
    : 'rounded-full border border-amber-100/20 bg-white/5 px-3 py-2 text-sm text-amber-50 hover:bg-white/10 disabled:opacity-40';
}
