/**
 * AI latency benchmarks.
 *
 *   pnpm --filter @once-upon/server bench:ai                 offline: local processing only, free
 *   pnpm --filter @once-upon/server bench:ai --live          prints the live plan and exits (no calls)
 *   pnpm --filter @once-upon/server bench:ai --live --yes    runs the live plan (uses credits)
 *
 * Options: --runs=N (offline default 200, live default 1), --only=a,b (pick benchmarks),
 * --json=path (write results). Live `tts` and `image` cost the most, so they run only when
 * named in --only. Synthetic fixtures only; nothing personal is sent.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { AiService, MuseChat, WorldGenInput } from '../contracts';
import { makeBossInput } from '../agents/boss-fixtures';
import { buildBossSystemPrompt, buildBossTools, buildBossUserMessage, createBossPlanner } from '../agents/boss-agent';
import { extractMemoryCards, validateCards } from './cards';
import { buildImagePrompts, createImageService } from './images';
import { matchIncantation } from './incantation';
import { parseInstagramExport } from './instagram';
import { narrate } from './narrate';
import { createDefaultRuntime } from './runtime';
import { CACHED_WORLD, FIXTURE_CARDS } from './service';
import { createMuseChat } from './spark';
import { aiTimings, summarize, type TimingOutcome } from './timings';
import { createTranscriber } from './transcribe';
import { createTts } from './tts';
import { parseWavHeader } from './wav';
import { clampWorld, generateWorldDetailed } from './world';

// ---------------------------------------------------------------------------
// Args and fixtures
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const live = flag('live');
const confirmed = flag('yes');
const runs = Math.max(1, Number(option('runs') ?? (live ? 1 : 200)) || 1);
const only = option('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const jsonPath = option('json');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const exportJson: unknown = JSON.parse(fixture('sample-instagram-export.json').toString('utf8'));
const chat = parseInstagramExport(exportJson);
const wav = fixture('spoken-incantation.wav');
const offlineMuse: MuseChat = { available: false, complete: async () => null };
const worldInput: WorldGenInput = {
  cards: FIXTURE_CARDS,
  encounterCard: FIXTURE_CARDS[0] ?? null,
  bossCard: FIXTURE_CARDS[1] ?? null,
  playerNames: ['Maya', 'Dev'],
  difficulty: 'normal',
};

interface Result {
  name: string;
  runs: number;
  outcomes: Partial<Record<TimingOutcome, number>>;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
  note?: string;
}

async function measure(name: string, n: number, fn: () => Promise<TimingOutcome> | TimingOutcome, note?: string): Promise<Result> {
  const samples: number[] = [];
  const outcomes: Result['outcomes'] = {};
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    let outcome: TimingOutcome;
    try {
      outcome = await fn();
    } catch {
      outcome = 'error';
    }
    samples.push(performance.now() - started);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { name, runs: n, outcomes, ...summarize(samples), note };
}

function selected(name: string, defaultOn = true): boolean {
  return only ? only.includes(name) : defaultOn;
}

function printTable(title: string, results: Result[]): void {
  console.log(`\n${title}`);
  const rows = results.map((r) => ({
    benchmark: r.name,
    runs: r.runs,
    outcome: Object.entries(r.outcomes).map(([k, v]) => `${k} ${v}`).join(', '),
    'min ms': r.minMs,
    'p50 ms': r.p50Ms,
    'p95 ms': r.p95Ms,
    'max ms': r.maxMs,
    note: r.note ?? '',
  }));
  console.table(rows);
}

// ---------------------------------------------------------------------------
// Offline: the local processing around every AI call (no network, free)
// ---------------------------------------------------------------------------

async function offline(): Promise<Result[]> {
  const out: Result[] = [];
  const boss = createBossPlanner({ muse: offlineMuse } as AiService);
  const bossInput = makeBossInput();
  const rawCards = { cards: FIXTURE_CARDS.map((c) => ({ quote: c.quote, date: c.date, people: c.people, mood: c.mood, color: c.color })) };
  const bench: [string, () => Promise<TimingOutcome> | TimingOutcome][] = [
    ['instagram.parse', () => (parseInstagramExport(exportJson).messages.length ? 'ok' : 'error')],
    ['cards.validate', () => (validateCards(rawCards, chat), 'ok')],
    ['cards.heuristic', async () => ((await extractMemoryCards(offlineMuse, chat, 1000)).cards.length ? 'fallback' : 'error')],
    ['world.clamp', () => (clampWorld(CACHED_WORLD, { cached: CACHED_WORLD, encounterCard: null, bossCard: null }) ? 'ok' : 'error')],
    ['world.cached_fallback', async () =>
      (await generateWorldDetailed(offlineMuse, worldInput, { cached: CACHED_WORLD, useCachedWorld: false, timeoutMs: 1000 })).source === 'cached' ? 'fallback' : 'ok'],
    ['image.prompts', () => (Object.keys(buildImagePrompts(CACHED_WORLD)).length === 3 ? 'ok' : 'error')],
    ['incantation.match', () => (matchIncantation('forty miles from anything', CACHED_WORLD.incantations.ember).matchRatio >= 0 ? 'ok' : 'error')],
    ['wav.parse', () => (parseWavHeader(wav) ? 'ok' : 'error')],
    ['boss.prompt_build', () => (buildBossSystemPrompt(bossInput), buildBossUserMessage(bossInput), buildBossTools(bossInput), 'ok')],
    ['boss.scripted_plan', async () => ((await boss.planNextRound(bossInput, 1000)).source === 'scripted' ? 'fallback' : 'ok')],
    ['narrate.fallback', async () => ((await narrate(offlineMuse, { kind: 'dodge', context: { playerName: 'Maya' } })) ? 'fallback' : 'error')],
  ];
  for (const [name, fn] of bench) if (selected(name)) out.push(await measure(name, runs, fn));
  return out;
}

// ---------------------------------------------------------------------------
// Live: real provider round trips (uses credits; needs --yes)
// ---------------------------------------------------------------------------

interface LiveBench {
  name: string;
  defaultOn: boolean;
  calls: string;
  needs: 'muse' | 'asr' | 'tts' | 'image';
  run: () => Promise<TimingOutcome>;
  note?: string;
}

async function liveBenchmarks(): Promise<Result[]> {
  const rt = createDefaultRuntime();
  const muse = createMuseChat(rt);
  const transcriber = createTranscriber(rt);
  // Empty cache folders, so TTS and images really hit the provider instead of saved files.
  const emptyDir = mkdtempSync(join(tmpdir(), 'storybook-bench-'));
  const emptyUrl = pathToFileURL(emptyDir + '/');
  const tts = createTts(rt, emptyUrl);
  const images = createImageService(rt, '', emptyUrl);
  const planner = createBossPlanner({ muse } as AiService);
  let ttsRun = 0;
  const has = {
    muse: muse.available,
    asr: transcriber.available(),
    tts: tts.anyProvider(),
    image: rt.caps.image && Boolean(rt.config.muse.apiKey),
  };

  const benches: LiveBench[] = [
    {
      name: 'muse.chat (tiny)', defaultOn: true, calls: '1 Muse Spark', needs: 'muse',
      note: 'base round trip',
      run: async () => ((await muse.complete({ messages: [{ role: 'user', content: 'Reply with the word ok.' }], maxTokens: 5, timeoutMs: 20_000 })) ? 'ok' : 'error'),
    },
    {
      name: 'narrate', defaultOn: true, calls: '1 Muse Spark', needs: 'muse',
      note: 'game cuts off at 1.5 s',
      run: async () => {
        const before = aiTimings.snapshot().operations.narrate?.ok ?? 0;
        await narrate(muse, { kind: 'dodge', context: { playerName: 'Maya', enemyName: 'the Steed' } }, 20_000);
        return (aiTimings.snapshot().operations.narrate?.ok ?? 0) > before ? 'ok' : 'fallback';
      },
    },
    {
      name: 'boss.plan', defaultOn: true, calls: '1 Muse Spark', needs: 'muse',
      note: 'game deadline applies in play',
      run: async () => ((await planner.planNextRound(makeBossInput(), 20_000)).source === 'agent' ? 'ok' : 'fallback'),
    },
    {
      name: 'cards.extract', defaultOn: true, calls: '1-2 Muse Spark', needs: 'muse',
      run: async () => ((await extractMemoryCards(muse, chat, 45_000)).source === 'muse' ? 'ok' : 'fallback'),
    },
    {
      name: 'world.generate', defaultOn: true, calls: '1-2 Muse Spark', needs: 'muse',
      note: 'game caps at 25 s',
      run: async () => ((await generateWorldDetailed(muse, worldInput, { cached: CACHED_WORLD, useCachedWorld: false, timeoutMs: 60_000 })).source === 'muse' ? 'ok' : 'fallback'),
    },
    {
      name: 'asr.transcribe', defaultOn: true, calls: '1 Muse ASR', needs: 'asr',
      note: 'synthetic spoken WAV',
      run: async () => ((await transcriber.transcribe(wav, 'audio/wav', 'incantation.wav'))?.text ? 'ok' : 'error'),
    },
    {
      name: 'tts.synthesize', defaultOn: false, calls: '1 ElevenLabs (~45 chars)', needs: 'tts',
      run: async () => ((await tts.synthesize(`The lantern flickers, and the story goes on ${++ttsRun}.`, 'narrator')) ? 'ok' : 'error'),
    },
    {
      name: 'image.generate', defaultOn: false, calls: '1 Muse Image', needs: 'image',
      run: async () => ((await images.generateOne(`${buildImagePrompts(CACHED_WORLD).cover} (bench ${Date.now()})`)) ? 'ok' : 'error'),
    },
  ];

  const plan = benches.filter((b) => selected(b.name.split(' ')[0]!, b.defaultOn) || selected(b.name, b.defaultOn));
  console.log(`\nLive plan (${runs} run${runs === 1 ? '' : 's'} each):`);
  for (const b of plan) {
    console.log(`  ${has[b.needs] ? '•' : '-'} ${b.name.padEnd(18)} ${runs} x ${b.calls}${has[b.needs] ? '' : '  (skipped: provider not configured)'}`);
  }
  if (!only) console.log('  (tts.synthesize and image.generate run only when named, e.g. --only=tts.synthesize,image.generate)');
  if (!confirmed) {
    console.log('\nNothing was called. Re-run with --yes to make these paid requests.');
    rmSync(emptyDir, { recursive: true, force: true });
    return [];
  }

  aiTimings.reset();
  const out: Result[] = [];
  try {
    for (const b of plan) {
      if (!has[b.needs]) continue;
      process.stdout.write(`  running ${b.name}…\n`);
      out.push(await measure(b.name, runs, b.run, b.note));
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
  const raw = aiTimings.snapshot().operations['muse.chat'];
  if (raw) {
    out.push({
      name: 'muse.chat (all raw calls)', runs: raw.count, outcomes: { ok: raw.ok, error: raw.error },
      minMs: raw.minMs, p50Ms: raw.p50Ms, p95Ms: raw.p95Ms, maxMs: raw.maxMs, avgMs: raw.avgMs,
      note: 'every Muse Spark request above',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

const results = live ? await liveBenchmarks() : await offline();
if (results.length) printTable(live ? 'Live AI latency (real providers)' : `Offline processing latency (${runs} runs each, no network)`, results);
if (jsonPath && results.length) {
  writeFileSync(jsonPath, JSON.stringify({ mode: live ? 'live' : 'offline', at: new Date().toISOString(), runs, results }, null, 2) + '\n');
  console.log(`\nWrote ${jsonPath}`);
}
if (!live) console.log('\nFor real provider latency: add --live to see the plan, then --live --yes to run it (uses credits).');
