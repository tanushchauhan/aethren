/**
 * Muse Spark chat access ({@link MuseChat}) and a JSON helper for structured output.
 */
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { MuseChat, MuseChatRequest } from '../contracts';
import { describeError, type AiRuntime } from './runtime';

export function createMuseChat(rt: AiRuntime): MuseChat {
  const client = rt.chatClient;
  const available = rt.caps.spark && client !== null;
  return {
    available,
    async complete(req: MuseChatRequest) {
      if (!available || !client) return null;
      const timeoutMs = req.timeoutMs ?? rt.config.aiTimeoutMs;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
      if (signal.aborted) return null;
      const body: ChatCompletionCreateParamsNonStreaming = {
        model: rt.config.muse.sparkModel,
        messages: req.messages,
      };
      if (req.tools?.length) body.tools = req.tools;
      if (req.toolChoice) body.tool_choice = req.toolChoice;
      if (req.responseFormat) body.response_format = req.responseFormat;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      const started = Date.now();
      try {
        const res = await client.chat.completions.create(body, { signal, timeout: timeoutMs, maxRetries: 0 });
        return res.choices?.[0]?.message ?? null;
      } catch (err) {
        const why = timeout.aborted
          ? `timeout after ${timeoutMs}ms`
          : req.signal?.aborted
            ? 'aborted by caller'
            : describeError(err);
        rt.warn(`spark call failed after ${Date.now() - started}ms: ${why}`);
        return null;
      }
    },
  };
}

/** Parses model output as JSON, tolerating code fences and prose around one object. */
export function parseJsonContent(content: string | null | undefined): unknown {
  if (!content) return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface SparkJsonRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * One structured-output call (`response_format: json_schema`, strict). If that fails fast
 * (e.g. the API rejects strict schemas), retries once in `json_object` mode with the schema in
 * the prompt, inside whatever is left of the time budget. Resolves `null` on failure.
 */
export async function sparkJson(muse: MuseChat, req: SparkJsonRequest): Promise<unknown> {
  if (!muse.available) return null;
  const deadline = Date.now() + req.timeoutMs;
  const messages = [
    { role: 'system' as const, content: req.system },
    { role: 'user' as const, content: req.user },
  ];
  const first = await muse.complete({
    messages,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: req.schemaName, schema: req.schema, strict: true },
    },
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    timeoutMs: req.timeoutMs,
  });
  const parsed = parseJsonContent(first?.content);
  if (parsed !== null) return parsed;

  const remaining = deadline - Date.now();
  if (remaining < 2500) return null;
  const second = await muse.complete({
    messages: [
      {
        role: 'system',
        content: `${req.system}\n\nReply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(req.schema)}`,
      },
      { role: 'user', content: req.user },
    ],
    responseFormat: { type: 'json_object' },
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    timeoutMs: remaining,
  });
  return parseJsonContent(second?.content);
}
