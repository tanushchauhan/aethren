import { describe, expect, it, vi } from 'vitest';
import { createMuseChat, parseJsonContent } from './spark';
import { completion, hang, sparkRuntime, testRuntime } from './test-utils';

describe('MuseChat', () => {
  it('is unavailable without Spark and resolves null at once', async () => {
    const muse = createMuseChat(testRuntime());
    expect(muse.available).toBe(false);
    expect(await muse.complete({ messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
  });

  it('passes tools, tool choice and limits through to the chat API', async () => {
    const { rt, client } = sparkRuntime(() =>
      completion(null, {
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'taunt', arguments: '{"line":"Shhh"}' } }],
      }),
    );
    const muse = createMuseChat(rt);
    const msg = await muse.complete({
      messages: [{ role: 'user', content: 'plan' }],
      tools: [{ type: 'function', function: { name: 'taunt', parameters: { type: 'object', properties: {} } } }],
      toolChoice: 'required',
      temperature: 0.2,
      maxTokens: 50,
    });
    expect(msg?.tool_calls?.[0]).toMatchObject({ function: { name: 'taunt' } });
    expect(client.calls[0]).toMatchObject({ model: 'muse-spark-1.3', tool_choice: 'auto', temperature: 0.2, max_tokens: 1074, reasoning_effort: 'minimal' });
  });

  it('resolves null on errors and logs one line without the key', async () => {
    const warn = vi.fn();
    const { rt } = sparkRuntime(
      () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      { warn },
    );
    expect(await createMuseChat(rt).complete({ messages: [{ role: 'user', content: 'x' }] })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('status=400');
  });

  it('resolves null on timeout and on caller abort', async () => {
    const { rt } = sparkRuntime((_b, o) => hang(o));
    const muse = createMuseChat(rt);
    expect(await muse.complete({ messages: [{ role: 'user', content: 'x' }], timeoutMs: 50 })).toBeNull();
    const ctl = new AbortController();
    const p = muse.complete({ messages: [{ role: 'user', content: 'x' }], signal: ctl.signal });
    ctl.abort();
    expect(await p).toBeNull();
  });
});

describe('parseJsonContent', () => {
  it('handles fences and surrounding prose', () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(parseJsonContent('nope')).toBeNull();
    expect(parseJsonContent(null)).toBeNull();
  });
});
