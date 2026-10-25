/**
 * Small text helpers shared by the chat filter, quote check, incantation matcher and line clamps.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spells 0..9999 in words ("40" -> "forty"), so "40 miles" matches "forty miles". */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${numberToWords(rest)}` : ''}`;
  }
  const rest = n % 1000;
  return `${numberToWords(Math.floor(n / 1000))} thousand${rest ? ` ${numberToWords(rest)}` : ''}`;
}

/**
 * Lowercases, strips accents and punctuation, spells out numbers and collapses whitespace.
 * Apostrophes are removed rather than split ("I'm" -> "im").
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/\d+/g, (d) => ` ${numberToWords(Number.parseInt(d, 10))} `)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  const n = normalizeText(input);
  return n ? n.split(' ') : [];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 1 for identical words, 0 for nothing in common. */
export function wordSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Clips to `max` characters at a word boundary, adding an ellipsis only when it cut. */
export function clipText(input: string, max: number, ellipsis = false): string {
  const s = input.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const room = ellipsis ? max - 1 : max;
  const cut = s.slice(0, room + 1);
  const space = cut.lastIndexOf(' ');
  const base = (space > room * 0.5 ? cut.slice(0, space) : s.slice(0, room)).replace(/[\s,;:-]+$/, '');
  return ellipsis ? `${base}…` : base;
}

/** Clips at the last sentence end that fits, else at a word boundary. */
export function clipSentences(input: string, max: number): string {
  const s = input.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > max * 0.4) return cut.slice(0, end + 1);
  return clipText(s, max, true);
}

export function slugify(input: string, maxWords = 3): string {
  return tokenize(input).slice(0, maxWords).join('-') || 'memory';
}
