import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MemoryCard } from '@once-upon/shared';
import { extractMemoryCards, findQuoteSource, heuristicCards, QUOTE_MAX_CHARS, validateCards } from './cards';
import { parseInstagramExport } from './instagram';
import { MOOD_COLORS, normalizeMood, weaknessForMood } from './moods';
import { createAiServiceWith } from './service';
import { createMuseChat } from './spark';
import { completion, sparkRuntime, testRuntime } from './test-utils';

const sample = JSON.parse(readFileSync(new URL('./fixtures/sample-instagram-export.json', import.meta.url), 'utf8'));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/memory-cards.json', import.meta.url), 'utf8')) as MemoryCard[];
const chat = parseInstagramExport(sample);

describe('findQuoteSource', () => {
  it('accepts an exact quote, ignoring case and punctuation', () => {
    const m = findQuoteSource('The library is closing, and nobody has started', chat.messages);
    expect(m?.message.sender).toBe('Dev');
    expect(m?.quote).toBe('The library is closing, and nobody has started');
  });

  it('matches "40" against "forty"', () => {
    expect(findQuoteSource('we are forty miles from anything', chat.messages)?.message.sender).toBe('Maya');
  });

  it('accepts a lightly garbled quote and shows the real words', () => {
    const m = findQuoteSource('the tomatoe plant survivd the week', chat.messages);
    expect(m?.quote.startsWith('the tomato plant survived the week')).toBe(true);
  });

  it('rejects quotes that are not in the chat', () => {
    expect(findQuoteSource('we should adopt a dragon named steve', chat.messages)).toBeNull();
    expect(findQuoteSource('', chat.messages)).toBeNull();
  });
});

describe('validateCards', () => {
  it('drops invented quotes, clamps fields and fills defaults', () => {
    const cards = validateCards(
      {
        cards: [
          { quote: 'the car is making the noise again', date: '1999-01-01', people: ['maya', 'Gus', 'Dev'], mood: 'CHAOS', color: 'red' },
          { quote: 'a totally made up line about wizards', date: '2025-01-01', people: ['Maya'], mood: 'silly', color: '#123456' },
          { quote: 'my voice is gone. i sound like a haunted kettle', people: [], mood: 'mystery', color: '#abc' },
          { quote: 'the car is making the noise again and we are 40 miles', mood: 'chaotic' },
          { nope: true },
        ],
      },
      chat,
    );
    expect(cards).toHaveLength(2);
    const [road, kettle] = cards as [MemoryCard, MemoryCard];
    expect(road.date).toBe('2025-07-12');
    expect(road.people).toEqual(['Maya', 'Dev']);
    expect(road.mood).toBe('chaotic');
    expect(road.color).toBe(MOOD_COLORS.chaotic);
    expect(road.id).toMatch(/^card-/);
    expect(kettle.people).toEqual(['Priya']);
    expect(kettle.mood).toBe('nostalgic');
    expect(kettle.color).toBe('#ABC');
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
  });

  it('keeps quotes within 140 characters', () => {
    const long = { participants: ['A'], dropped: 0, messages: [{ sender: 'A', timestampMs: 0, text: 'word '.repeat(60).trim() }] };
    const [card] = validateCards({ cards: [{ quote: 'word '.repeat(60).trim(), mood: 'silly' }] }, long);
    expect(card!.quote.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS);
  });

  it('caps at five cards', () => {
    const quotes = chat.messages.slice(0, 9).map((m) => ({ quote: m.text, mood: 'silly' }));
    expect(validateCards({ cards: quotes }, chat)).toHaveLength(5);
  });
});

describe('moods', () => {
  it('maps moods (and synonyms) to a P0 weakness', () => {
    expect(weaknessForMood('chaotic')).toBe('frost');
    expect(weaknessForMood('dread')).toBe('ember');
    expect(weaknessForMood('proud')).toBe('bloom');
    expect(weaknessForMood('Anxious')).toBe('ember');
    expect(normalizeMood(42)).toBe('nostalgic');
  });
});

describe('extractMemoryCards', () => {
  it('uses one structured-output Spark call and validates the result', async () => {
    const { rt, client } = sparkRuntime(() =>
      completion(
        JSON.stringify({
          cards: [
            { quote: 'the car is making the noise again and we are 40 miles from anything', date: '2025-07-12', people: ['Maya'], mood: 'chaotic', color: '#E85D04' },
            { quote: 'it is 3am, the library is closing and nobody has started the essay', date: '2025-12-09', people: ['Dev'], mood: 'dread', color: '#4CC9F0' },
            { quote: 'the tomato plant survived the week, i am a gardener now', date: '2026-04-20', people: ['Maya'], mood: 'proud', color: '#52B788' },
          ],
        }),
      ),
    );
    const out = await extractMemoryCards(createMuseChat(rt), chat, 5000);
    expect(out.source).toBe('muse');
    expect(out.cards.map((c) => c.mood)).toEqual(['chaotic', 'dread', 'proud']);
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.response_format).toMatchObject({ type: 'json_schema' });
    const prompt = JSON.stringify(call.messages);
    expect(prompt).toContain('Participants: Maya, Dev, Priya');
    expect(prompt).not.toContain('sent an attachment');
  });

  it('tops up with real messages when Muse returns too few cards', async () => {
    const { rt } = sparkRuntime(() =>
      completion(JSON.stringify({ cards: [{ quote: 'the goat was the waterfall all along', date: '', people: [], mood: 'silly', color: '' }] })),
    );
    const out = await extractMemoryCards(createMuseChat(rt), chat, 5000);
    expect(out.source).toBe('mixed');
    expect(out.cards.length).toBe(3);
  });

  it('falls back to the local extractor when Spark is unavailable', async () => {
    const out = await extractMemoryCards(createMuseChat(testRuntime()), chat, 5000);
    expect(out.source).toBe('heuristic');
    expect(out.cards).toHaveLength(3);
    for (const card of out.cards) {
      expect(findQuoteSource(card.quote, chat.messages)).not.toBeNull();
      expect(chat.participants).toEqual(expect.arrayContaining(card.people));
    }
  });

  it('heuristic returns nothing for an empty chat', () => {
    expect(heuristicCards({ participants: [], messages: [], dropped: 0 })).toEqual([]);
  });
});

describe('fixtures', () => {
  it('every fixture card quote appears in the sample export', () => {
    for (const card of fixtures) {
      expect(findQuoteSource(card.quote, chat.messages), card.id).not.toBeNull();
    }
  });

  it('cached picks refer to fixture card ids, and listMemoryCards serves fixtures before an upload', () => {
    const ai = createAiServiceWith(testRuntime());
    const ids = ai.listMemoryCards().map((c) => c.id);
    expect(ids).toEqual(fixtures.map((c) => c.id));
    const picks = ai.getCachedPicks();
    expect(ids).toContain(picks.encounterCardId);
    expect(ids).toContain(picks.bossCardId);
    const world = ai.getCachedWorld();
    expect(world.encounters[0]!.memory).toBe(picks.encounterCardId);
    expect(world.boss.memory).toBe(picks.bossCardId);
  });
});
