import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ChatParseError,
  fixMojibake,
  formatLine,
  isSystemMessage,
  parseInstagramExport,
  selectWithinBudget,
  type ChatMessage,
} from './instagram';

const sample = JSON.parse(
  readFileSync(new URL('./fixtures/sample-instagram-export.json', import.meta.url), 'utf8'),
) as unknown;

describe('fixMojibake', () => {
  it('decodes Instagram latin1-escaped UTF-8', () => {
    expect(fixMojibake('cafÃ©')).toBe('café');
    expect(fixMojibake('ð\u009f\u0098\u0082')).toBe('😂');
    expect(fixMojibake('â\u0098\u0095 at 7')).toBe('☕ at 7');
  });

  it('leaves plain ASCII and real Unicode alone', () => {
    expect(fixMojibake('plain text')).toBe('plain text');
    expect(fixMojibake('already café 😂')).toBe('already café 😂');
  });

  it('keeps a real latin1 string that is not valid UTF-8 bytes', () => {
    expect(fixMojibake('naïve')).toBe('naïve');
  });
});

describe('parseInstagramExport', () => {
  const chat = parseInstagramExport(sample);
  const texts = chat.messages.map((m) => m.text);

  it('reads the participants', () => {
    expect(chat.participants).toEqual(['Maya', 'Dev', 'Priya']);
  });

  it('keeps text messages from participants, oldest first, with mojibake fixed', () => {
    expect(texts[0]).toBe('ok who packed the snacks because it was not me');
    expect(texts).toContain('the car is making the noise again and we are 40 miles from anything');
    expect(texts).toContain('go to bed both of you, the café opens at 7 ☕');
    expect(texts).toContain('the noise is just the car singing to us 🎶');
    const times = chat.messages.map((m) => m.timestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('keeps messages that merely have reactions', () => {
    expect(texts).toContain('the goat was the waterfall all along');
  });

  it('drops media, shares, calls, stickers, system lines and non-participants', () => {
    const joined = texts.join('\n');
    for (const gone of [
      'sent an attachment',
      'Reacted',
      'Liked a message',
      'unsent a message',
      'started a video chat',
      'named the group',
      'changed the group photo',
      'missed an audio call',
      'You sent a sticker',
      'is this the karaoke group',
      'best-road-trip-playlists',
    ]) {
      expect(joined).not.toContain(gone);
    }
    expect(chat.dropped).toBeGreaterThanOrEqual(12);
  });

  it('strips URLs but keeps the words around them', () => {
    expect(texts).toContain('for next time lol');
    expect(texts.join(' ')).not.toMatch(/https?:/);
  });

  it('merges several message_N.json files of one thread without duplicates', () => {
    const twice = parseInstagramExport([sample, sample]);
    expect(twice.messages.length).toBe(chat.messages.length);
  });

  it('rejects anything that is not a message export', () => {
    expect(() => parseInstagramExport({ hello: 'world' })).toThrow(ChatParseError);
    expect(() => parseInstagramExport(null)).toThrow(ChatParseError);
  });

  it('treats a missing participants list as "everyone who wrote"', () => {
    const parsed = parseInstagramExport({
      messages: [{ sender_name: 'Ana', timestamp_ms: 1, content: 'hello there friend' }],
    });
    expect(parsed.participants).toEqual(['Ana']);
    expect(parsed.messages).toHaveLength(1);
  });
});

describe('isSystemMessage', () => {
  it.each([
    'Maya reacted ❤️ to your message',
    'Liked a message',
    'Dev sent an attachment.',
    'You unsent a message',
    'Priya started a video chat',
    'The video chat ended.',
    'Maya set the nickname for Dev to Captain.',
    'Dev added Priya to the group.',
    'Priya left the group.',
  ])('flags %s', (line) => {
    expect(isSystemMessage(line)).toBe(true);
  });

  it('does not flag ordinary chat', () => {
    expect(isSystemMessage('i reacted badly to the essay deadline')).toBe(false);
    expect(isSystemMessage('the car is making the noise again')).toBe(false);
  });
});

describe('selectWithinBudget', () => {
  const many: ChatMessage[] = Array.from({ length: 500 }, (_, i) => ({
    sender: i % 2 ? 'Maya' : 'Dev',
    timestampMs: 1_700_000_000_000 + i * 60_000,
    text: `message number ${i} with a little bit of padding text`,
  }));

  it('returns everything when it fits', () => {
    expect(selectWithinBudget(many.slice(0, 5), 10_000)).toHaveLength(5);
  });

  it('stays within budget, keeps the newest, samples the old, in order', () => {
    const budget = 4000;
    const picked = selectWithinBudget(many, budget);
    const size = picked.reduce((n, m) => n + formatLine(m).length + 1, 0);
    expect(size).toBeLessThanOrEqual(budget);
    expect(picked.at(-1)).toBe(many.at(-1));
    expect(picked[0]!.timestampMs).toBeLessThan(many[250]!.timestampMs);
    const times = picked.map((m) => m.timestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
