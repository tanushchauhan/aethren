import type { MemoryCard, WorldSchema } from '../net/contract';

/** Original demo stand-ins used when gameState has no cards or world yet. */
export const MOCK_MEMORY_CARDS: readonly MemoryCard[] = [
  {
    id: 'mem-porch-light',
    quote: "don't leave yet, the porch light is still on for you",
    date: 'March 3, 2024',
    people: ['Ava', 'Dev'],
    mood: 'warm',
    color: 'ember',
  },
  {
    id: 'mem-glass-lake',
    quote: 'the lake is glass. if you are coming, come before the sun',
    date: 'January 18, 2024',
    people: ['Dev', 'Sam'],
    mood: 'hushed',
    color: 'frost',
  },
  {
    id: 'mem-corner-seat',
    quote: 'i saved you the corner seat and the last slice of cake',
    date: 'June 9, 2024',
    people: ['Ava', 'Maya', 'Dev'],
    mood: 'tender',
    color: 'bloom',
  },
  {
    id: 'mem-missed-train',
    quote: 'we missed the train and laughed the whole way home',
    date: 'August 21, 2024',
    people: ['Maya', 'Dev'],
    mood: 'bright',
    color: 'gold',
  },
  {
    id: 'mem-stay',
    quote: 'tell me the story again. i want the version where we stay',
    date: 'October 11, 2024',
    people: ['Ava', 'Dev'],
    mood: 'fierce',
    color: 'rose',
  },
];

export const MOCK_WORLD: WorldSchema = {
  title: 'The Wood of Kept Messages',
  intro:
    'Once upon a time, a chat between friends glowed like a lantern in the wood. The messages you kept became a path, a creature, and a crown. Speak the words you already said to each other, and the dark will have to make room.',
  incantations: {
    ember: 'the porch light is still on',
    frost: 'come before the sun',
    bloom: 'i saved you a seat',
  },
  encounters: [
    {
      memory: 'the lake is glass. if you are coming, come before the sun',
      name: 'Glass-Lake Warden',
      template: 'charger',
      attacks: ['low_sweep', 'high_swing', 'projectile'],
      weakness: 'frost',
      tier: 2,
      lines: [
        'The ice remembers who arrived late.',
        'Step wide. The lake takes the straight path.',
      ],
      art_prompt:
        'A storybook lake spirit shaped like a frost-covered horse, lantern eye, ink and watercolor, no text',
    },
  ],
  boss: {
    memory: 'tell me the story again. i want the version where we stay',
    name: 'The Unsent Crown',
    template: 'guardian',
    attacks: ['high_swing', 'projectile', 'low_sweep'],
    weakness: 'ember',
    tier: 3,
    lines: [
      'You kept the message. Now keep each other.',
      'A single voice cannot break this ward.',
    ],
    art_prompt:
      'A crowned figure made of folded letters and gold leaf, fairy-tale boss, ink and watercolor, no text',
    ward: 'twin_cast',
  },
  ending:
    'The wood folded its pages. What you kept, you kept together. Happily ever after.',
};

export function cardsOrFixtures(cards: readonly MemoryCard[] | undefined): readonly MemoryCard[] {
  return cards && cards.length > 0 ? cards : MOCK_MEMORY_CARDS;
}
