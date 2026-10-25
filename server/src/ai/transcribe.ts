/**
 * Speech-to-text chain for incantations:
 * 1. Muse native `POST /v1/asr/transcribe` (WAV). On 404/405, Muse `POST /v1/audio/transcriptions`
 *    once, and remember which route worked.
 * 2. OpenAI `gpt-4o-mini-transcribe` when `OPENAI_API_KEY` is set (accepts WebM too).
 * Resolves `null` when nothing produced a transcript. Never rejects.
 */
import { museAsrTranscribe, openAiCompatTranscribe, ProviderError } from './providers';
import { describeError, OPENAI_BASE_URL, OPENAI_TRANSCRIBE_MODEL, type AiRuntime } from './runtime';
import { looksLikeWav, museWavProblems, parseWavHeader } from './wav';

/** Whole chain budget: leaves time in the 8 s team turn to cast. */
export const TRANSCRIBE_BUDGET_MS = 7000;
export const TRANSCRIBE_ATTEMPT_MS = 6000;

export interface TranscriptResult {
  text: string;
  provider: 'muse-asr' | 'muse-openai-compat' | 'openai';
}

export function filenameFor(mimeType: string, original?: string): string {
  if (original && /\.[a-z0-9]{2,5}$/i.test(original)) return original;
  const m = mimeType.toLowerCase();
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  return 'audio.wav';
}

export function createTranscriber(rt: AiRuntime) {
  let museRoute: 'asr' | 'compat' = 'asr';
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    rt.warn(msg);
  };

  const available = () => (rt.caps.transcribe && Boolean(rt.config.muse.apiKey)) || rt.hasOpenAI;

  async function transcribe(audio: Buffer, mimeType: string, originalName?: string): Promise<TranscriptResult | null> {
    if (audio.length === 0) return null;
    const deadline = Date.now() + TRANSCRIBE_BUDGET_MS;
    const budget = () => Math.min(TRANSCRIBE_ATTEMPT_MS, deadline - Date.now());
    const isWav = looksLikeWav(audio);
    const mime = isWav ? 'audio/wav' : mimeType || 'application/octet-stream';
    const filename = filenameFor(mime, isWav ? 'audio.wav' : originalName);

    const museKey = rt.config.muse.apiKey;
    if (rt.caps.transcribe && museKey) {
      if (!isWav) {
        warnOnce('non-wav', `non-WAV audio (${mime}) sent to Muse ASR; the client should send 16 kHz mono 16-bit WAV`);
      } else {
        const problems = museWavProblems(parseWavHeader(audio), audio.length);
        if (problems.length) warnOnce(`wav:${problems.join(',')}`, `WAV may be rejected by Muse ASR: ${problems.join('; ')}`);
      }
      const call = {
        baseUrl: rt.config.muse.baseUrl,
        apiKey: museKey,
        model: rt.config.muse.transcribeModel,
        audio,
        filename,
        mimeType: mime,
      };
      if (museRoute === 'asr') {
        try {
          return { text: await museAsrTranscribe({ ...call, timeoutMs: budget() }), provider: 'muse-asr' };
        } catch (err) {
          if (err instanceof ProviderError && (err.status === 404 || err.status === 405)) {
            museRoute = 'compat';
            rt.warn(`muse /asr/transcribe answered ${err.status}; switching to /audio/transcriptions`);
          } else {
            rt.warn(`muse asr failed: ${describeError(err)}`);
          }
        }
      }
      if (museRoute === 'compat' && budget() > 1000) {
        try {
          const text = await openAiCompatTranscribe({ ...call, provider: 'muse-openai-compat', timeoutMs: budget() });
          return { text, provider: 'muse-openai-compat' };
        } catch (err) {
          rt.warn(`muse /audio/transcriptions failed: ${describeError(err)}`);
        }
      }
    }

    const openaiKey = rt.config.openai.apiKey;
    if (rt.hasOpenAI && openaiKey && budget() > 1000) {
      try {
        const text = await openAiCompatTranscribe({
          baseUrl: OPENAI_BASE_URL,
          apiKey: openaiKey,
          model: OPENAI_TRANSCRIBE_MODEL,
          audio,
          filename,
          mimeType: mime,
          timeoutMs: budget(),
        });
        return { text, provider: 'openai' };
      } catch (err) {
        rt.warn(`openai transcribe failed: ${describeError(err)}`);
      }
    }
    return null;
  }

  return { transcribe, available };
}
