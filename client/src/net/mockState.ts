import {
  MAX_TEAM_HEARTS,
  type Boss,
  type Encounter,
  type GameState,
  type MemoryCard,
  type PlayerPublic,
  type PlayerRole,
  type RoomPhase,
  type WorldSchema,
} from './contract';

export const MOCK_PLAYER_IDS: Record<PlayerRole, string> = {
  spellbearer: 'player-spellbearer',
  partner: 'player-partner',
};

export function mockPlayerId(role: PlayerRole): string {
  return MOCK_PLAYER_IDS[role];
}

const MEMORY_CARDS: readonly MemoryCard[] = [
  {
    id: 'card-ember',
    quote: 'The Corolla would not start, so we walked home laughing.',
    date: '2023-06-12',
    people: ['Ava', 'Dev'],
    mood: 'warm',
    color: '#e85d04',
  },
  {
    id: 'card-frost',
    quote: 'We hid under the bleachers until the rain finally stopped.',
    date: '2022-11-03',
    people: ['Sam', 'Dev'],
    mood: 'quiet',
    color: '#4cc9f0',
  },
  {
    id: 'card-bloom',
    quote: 'You brought sunflowers to the study room at midnight.',
    date: '2024-03-18',
    people: ['Ava', 'Sam'],
    mood: 'bright',
    color: '#80b918',
  },
  {
    id: 'card-road',
    quote: 'The group chat still calls it the legendary road trip.',
    date: '2021-08-09',
    people: ['Ava', 'Dev', 'Sam'],
    mood: 'wild',
    color: '#c47b2b',
  },
];

function cloneCards(): MemoryCard[] {
  return MEMORY_CARDS.map((card) => ({ ...card, people: [...card.people] }));
}

function buildEncounter(): Encounter {
  return {
    memory: 'card-road',
    name: 'The Stalled Corolla',
    template: 'charger',
    attacks: ['low_sweep', 'projectile'],
    weakness: 'ember',
    tier: 1,
    lines: ['The engine coughs. The story lunges.'],
    art_prompt: 'A lantern-glass carriage charging down a parchment road',
    hp: 12,
    maxHp: 12,
  };
}

function buildBoss(): Boss {
  return {
    memory: 'card-bloom',
    name: 'The Midnight Sunflower',
    template: 'guardian',
    attacks: ['high_swing', 'low_sweep', 'projectile'],
    weakness: 'frost',
    tier: 3,
    lines: ['Petals close. The ward hums.'],
    art_prompt: 'A towering sunflower knight holding a glass ward',
    hp: 24,
    maxHp: 24,
    ward: 'twin_cast',
    wardUp: true,
  };
}

export function buildMockWorld(): WorldSchema {
  const boss = buildBoss();
  return {
    title: 'The Lantern That Remembered',
    intro: 'Two friends step into a tale stitched from their own group chat.',
    incantations: {
      ember: 'By the Corolla that would not start, burn!',
      frost: 'Under the bleachers, hold still the rain.',
      bloom: 'Sunflowers at midnight, open the path.',
    },
    encounters: [buildEncounter()],
    boss,
    ending: 'The book closes. The chat is still there, glowing.',
  };
}

function makePlayer(name: string, role: PlayerRole): PlayerPublic {
  return {
    id: mockPlayerId(role),
    name,
    role,
    inZone: true,
    connected: true,
    selectedElement: role === 'spellbearer' ? 'ember' : 'frost',
    elementLocked: false,
    fistCharged: false,
  };
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function buildMockGameState(input: {
  playerName: string;
  role: PlayerRole;
  roomCode?: string;
  phase?: RoomPhase;
  quickStart?: boolean;
}): GameState {
  const world = buildMockWorld();
  const encounter = world.encounters[0];
  const playerName = input.playerName.trim() || 'Dev';
  const quickStart = input.quickStart ?? false;
  const phase = input.phase ?? (quickStart ? 'calibrating' : 'lobby');
  const cards = cloneCards();

  return {
    roomCode: input.roomCode ?? makeRoomCode(),
    phase,
    combatPhase: 'idle',
    teamHearts: MAX_TEAM_HEARTS,
    maxTeamHearts: MAX_TEAM_HEARTS,
    players: [
      makePlayer(input.role === 'spellbearer' ? playerName : 'Spellbearer', 'spellbearer'),
      makePlayer(input.role === 'partner' ? playerName : 'Partner', 'partner'),
    ],
    encounter,
    boss: world.boss,
    wardUp: true,
    twinCastMeter: 0,
    currentRound: phase === 'lobby' || phase === 'upload' ? 0 : 1,
    narratorCaption: quickStart ? world.intro : '',
    tooLoud: false,
    selectedMemoryIds: quickStart ? cards.slice(0, 2).map((card) => card.id) : [],
    bossMemoryId: quickStart ? world.boss.memory : undefined,
    world,
    memoryCards: cards,
    quickStart,
  };
}
