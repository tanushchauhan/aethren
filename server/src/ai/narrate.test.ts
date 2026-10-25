import { describe, expect, it } from 'vitest';
import { TAUNT_MAX_CHARS } from '@once-upon/shared';
import { fallbackLine, fillTemplate, LINE_BANK, lineContext } from './lines';
import { cleanNarration, narrate } from './narrate';
import { createMuseChat } from './spark';
import { completion, hang, sparkRuntime, testRuntime } from './test-utils';

describe('narrate', () => {
  it('falls back immediately when Spark is unavailable', async () => {
    const started = Date.now();
    const line = await narrate(createMuseChat(testRuntime()), {
      kind: 'telegraph',
      context: { enemyName: 'The Night Librarian', attackType: 'high_swing' },
    });
    expect(Date.now() - started).toBeLessThan(50);
    expect(line).toMatch(/Duck|low/);
  });

  it('uses a short Spark line, cleaned and clamped', async () => {
    const { rt, client } = sparkRuntime(() => completion(`"Narrator: ${'The steed stumbles '.repeat(12)}"\nsecond line`));
    const line = await narrate(createMuseChat(rt), { kind: 'dodge', context: { playerName: 'Maya', secret: { a: 1 } } });
    expect(line.startsWith('The steed stumbles')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(TAUNT_MAX_CHARS);
    expect(client.calls[0]!.max_tokens).toBe(60);
    expect(JSON.stringify(client.calls[0]!.messages)).not.toContain('secret');
  });

  it('falls back when Spark is slower than the narrate timeout', async () => {
    const { rt } = sparkRuntime((_b, o) => hang(o));
    const started = Date.now();
    const line = await narrate(createMuseChat(rt), { kind: 'parry', context: { playerName: 'Dev' } }, 100);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(line.length).toBeGreaterThan(0);
  });

  it('falls back on an empty reply', async () => {
    const { rt } = sparkRuntime(() => completion(''));
    const line = await narrate(createMuseChat(rt), { kind: 'victory', context: {} });
    expect(LINE_BANK.victory!.some((t) => t === line || fillTemplate(t, {}) === line)).toBe(true);
  });
});

describe('line bank', () => {
  it('every kind has a line that needs no context', () => {
    for (const [kind, lines] of Object.entries(LINE_BANK)) {
      expect(lines.some((l) => fillTemplate(l, {}) !== null), kind).toBe(true);
    }
  });

  it('fills templates from context and never leaves a placeholder', () => {
    for (let i = 0; i < 6; i++) {
      const line = fallbackLine({ kind: 'cast', context: { playerName: 'Maya', element: 'ember' } });
      expect(line).not.toMatch(/[{}]/);
    }
    expect(fallbackLine({ kind: 'cast', context: {} })).not.toMatch(/[{}]/);
    expect(fallbackLine({ kind: 'some_new_kind', context: {} })).toMatch(/^The /);
  });

  it('reads names from playerNames and element labels', () => {
    expect(lineContext({ playerNames: ['Maya', 'Dev'], element: 'frost' })).toMatchObject({
      player: 'Maya and Dev',
      element: 'Frost',
    });
  });

  it('cleanNarration rejects junk', () => {
    expect(cleanNarration(null)).toBeNull();
    expect(cleanNarration('  \n ')).toBeNull();
    expect(cleanNarration('"**Hello there.**"')).toBe('Hello there.');
    expect(cleanNarration('"ok"')).toBeNull();
  });
});
