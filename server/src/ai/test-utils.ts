/**
 * Test helpers: a runtime with fake keys and no network, and a mock chat client.
 * Imported by `*.test.ts` only.
 */
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { loadConfig } from '../config';
import type { AiRuntime, ChatClient } from './runtime';

export function testRuntime(over: Partial<AiRuntime> = {}, env: Record<string, string> = {}): AiRuntime {
  const config = loadConfig({
    NODE_ENV: 'test',
    MUSE_API_KEY: 'test-muse-key',
    ELEVENLABS_API_KEY: 'test-eleven-key',
    ...env,
  });
  return {
    config,
    caps: { spark: false, transcribe: false, image: false, tts: false },
    hasElevenLabs: false,
    hasOpenAI: false,
    chatClient: null,
    prewarmTts: false,
    warn: () => {},
    ...over,
  };
}

export function completion(content: string | null, extra: Record<string, unknown> = {}): ChatCompletion {
  return {
    id: 'cmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'muse-spark-test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null, ...extra },
      },
    ],
  } as ChatCompletion;
}

type Handler = (
  body: ChatCompletionCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
) => ChatCompletion | Promise<ChatCompletion>;

/** A chat client whose replies come from `handler`; records every request body. */
export function mockChatClient(handler: Handler): ChatClient & { calls: ChatCompletionCreateParamsNonStreaming[] } {
  const calls: ChatCompletionCreateParamsNonStreaming[] = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (body, options) => {
          calls.push(body);
          return handler(body, options);
        },
      },
    },
  };
}

/** A reply that only settles when the request is aborted (simulates a hung API). */
export function hang(options?: { signal?: AbortSignal }): Promise<ChatCompletion> {
  return new Promise((_, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

export function sparkRuntime(handler: Handler, over: Partial<AiRuntime> = {}) {
  const client = mockChatClient(handler);
  const rt = testRuntime({
    caps: { spark: true, transcribe: false, image: false, tts: false },
    chatClient: client,
    ...over,
  });
  return { rt, client };
}

export function audioResponse(bytes = 256, type = 'audio/mpeg'): Response {
  return new Response(new Uint8Array(bytes).fill(7), { status: 200, headers: { 'Content-Type': type } });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}
