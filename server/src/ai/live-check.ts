/**
 * Live provider check: one tiny real call per provider, printing PASS/FAIL, HTTP status and
 * latency. Never prints keys. Run where the network allows:
 *
 *   pnpm --filter @once-upon/server exec tsx src/ai/live-check.ts [--skip-image]
 *
 * Muse Image costs about $0.01 per call; `--skip-image` skips it. Exit code 1 if any check fails.
 */
import OpenAI from 'openai';
import { config, hasElevenLabs, hasOpenAI, museCapabilities } from '../config';
import {
  elevenLabsTts,
  museAsrTranscribe,
  museImageGenerate,
  openAiCompatSpeech,
  openAiCompatTranscribe,
  ProviderError,
} from './providers';
import { ELEVENLABS_BASE_URL, ELEVENLABS_BOSS_VOICE_ID, OPENAI_BASE_URL, redact } from './runtime';
import { makeToneWav } from './wav';

type Outcome = { status: number | string; detail: string };
const results: { name: string; ok: boolean | null }[] = [];

function statusOf(err: unknown): number | string {
  if (err instanceof ProviderError) return err.status || 'network';
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : 'error';
}

async function check(name: string, endpoint: string, enabled: boolean, run: () => Promise<Outcome>): Promise<void> {
  const label = name.padEnd(22);
  if (!enabled) {
    console.log(`SKIP ${label} ${endpoint} (not configured)`);
    results.push({ name, ok: null });
    return;
  }
  const started = Date.now();
  try {
    const out = await run();
    console.log(`PASS ${label} ${String(out.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${endpoint}  ${redact(out.detail)}`);
    results.push({ name, ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL ${label} ${String(statusOf(err)).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${endpoint}  ${redact(msg)}`);
    results.push({ name, ok: false });
  }
}

const skipImage = process.argv.includes('--skip-image');
const muse = config.muse;
const sdk = muse.apiKey ? new OpenAI({ apiKey: muse.apiKey, baseURL: muse.baseUrl, maxRetries: 0, timeout: 20_000 }) : null;

console.log(`Live check against ${muse.baseUrl} (spark=${muse.sparkModel}, asr=${muse.transcribeModel}, image=${muse.imageModel})\n`);

await check('spark json_schema', `POST ${muse.baseUrl}/chat/completions`, museCapabilities.spark && !!sdk, async () => {
  const { data, response } = await sdk!.chat.completions
    .create({
      model: muse.sparkModel,
      messages: [{ role: 'user', content: 'Return a JSON object with one magic word for a fairy tale.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'magic_word',
          strict: true,
          schema: {
            type: 'object',
            properties: { word: { type: 'string' } },
            required: ['word'],
            additionalProperties: false,
          },
        },
      },
      reasoning_effort: 'minimal',
      max_tokens: 1024,
    })
    .withResponse();
  const content = data.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(content) as { word?: unknown };
  if (typeof parsed.word !== 'string') throw new Error(`no "word" in ${content.slice(0, 80)}`);
  return { status: response.status, detail: `word=${parsed.word}` };
});

await check('spark tool call', `POST ${muse.baseUrl}/chat/completions`, museCapabilities.spark && !!sdk, async () => {
  const { data, response } = await sdk!.chat.completions
    .create({
      model: muse.sparkModel,
      messages: [{ role: 'user', content: 'The boss wants to taunt the heroes. Call the taunt tool.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'taunt',
            description: 'Say one short villain line',
            parameters: {
              type: 'object',
              properties: { line: { type: 'string' } },
              required: ['line'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: 'auto',
      reasoning_effort: 'minimal',
      max_tokens: 1024,
    })
    .withResponse();
  const call = data.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== 'function' || call.function.name !== 'taunt') throw new Error('no taunt tool call returned');
  JSON.parse(call.function.arguments);
  return { status: response.status, detail: `args=${call.function.arguments.slice(0, 60)}` };
});

const wav = makeToneWav({ seconds: 1, sampleRate: 16_000, frequency: 440 });
await check('muse transcribe (asr)', `POST ${muse.baseUrl}/asr/transcribe`, museCapabilities.transcribe, async () => {
  const call = {
    baseUrl: muse.baseUrl,
    apiKey: muse.apiKey!,
    model: muse.transcribeModel,
    audio: wav,
    filename: 'tone.wav',
    mimeType: 'audio/wav',
    timeoutMs: 20_000,
  };
  try {
    const text = await museAsrTranscribe(call);
    return { status: 200, detail: `transcript="${text.slice(0, 40)}" (a tone may transcribe as empty)` };
  } catch (err) {
    if (!(err instanceof ProviderError) || (err.status !== 404 && err.status !== 405)) throw err;
    const text = await openAiCompatTranscribe({ ...call, provider: 'muse-openai-compat' });
    return { status: 200, detail: `/asr/transcribe gave ${err.status}; /audio/transcriptions worked: "${text.slice(0, 40)}"` };
  }
});

await check('muse image', `POST ${muse.baseUrl}/images/generations`, museCapabilities.image && !skipImage, async () => {
  const img = await museImageGenerate({
    baseUrl: muse.baseUrl,
    apiKey: muse.apiKey!,
    model: muse.imageModel,
    prompt: 'A tiny watercolor acorn wearing a crown, storybook style, no text',
    timeoutMs: 60_000,
  });
  return {
    status: 200,
    detail: img.url ? `url (${img.url.slice(0, 50)}...)` : `b64 ${Math.round((img.b64!.length * 3) / 4 / 1024)} KB ${img.mimeType ?? ''}`,
  };
});

if (muse.ttsModel) {
  await check('muse tts', `POST ${muse.baseUrl}/audio/speech`, museCapabilities.tts, async () => {
    const audio = await openAiCompatSpeech({
      provider: 'muse-tts',
      baseUrl: muse.baseUrl,
      apiKey: muse.apiKey!,
      model: muse.ttsModel!,
      voice: muse.ttsVoice ?? 'default',
      text: 'Once upon a time.',
      timeoutMs: 10_000,
    });
    return { status: 200, detail: `${audio.length} bytes` };
  });
}

for (const [label, voiceId] of [
  ['elevenlabs narrator', config.elevenLabs.voiceId],
  ['elevenlabs boss voice', ELEVENLABS_BOSS_VOICE_ID],
] as const) {
  await check(label, `POST ${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`, hasElevenLabs, async () => {
    const audio = await elevenLabsTts({
      baseUrl: ELEVENLABS_BASE_URL,
      apiKey: config.elevenLabs.apiKey!,
      voiceId,
      modelId: config.elevenLabs.modelId,
      text: 'Once upon a time.',
      timeoutMs: 10_000,
    });
    return { status: 200, detail: `${audio.length} bytes mp3 (model ${config.elevenLabs.modelId})` };
  });
}

await check('openai tts', `POST ${OPENAI_BASE_URL}/audio/speech`, hasOpenAI, async () => {
  const audio = await openAiCompatSpeech({
    provider: 'openai-tts',
    baseUrl: OPENAI_BASE_URL,
    apiKey: config.openai.apiKey!,
    model: config.openai.ttsModel,
    voice: config.openai.ttsVoice,
    text: 'Once upon a time.',
    timeoutMs: 10_000,
  });
  return { status: 200, detail: `${audio.length} bytes` };
});

const failed = results.filter((r) => r.ok === false);
const passed = results.filter((r) => r.ok === true);
console.log(`\n${passed.length} passed, ${failed.length} failed, ${results.length - passed.length - failed.length} skipped`);
process.exit(failed.length > 0 ? 1 : 0);
