/**
 * Storybook client compatibility (`client/src/net/contract.ts`).
 *
 * The storybook client keeps its own state shape: one coarse `phase` per screen plus a
 * `combatPhase`, `teamHearts`, `wardUp`, and so on. Sockets that speak it join a second
 * Socket.IO room, `storybookRoom(code)`, and receive {@link toStorybookState} instead of the
 * shared `GameState`. Every other event is shape-compatible and is relayed unchanged.
 * The engine stays authoritative; this file only translates.
 */
import { NOISE_TOO_LOUD_THRESHOLD } from '@once-upon/shared';
import type { BossSchema, EncounterSchema, GamePhase, GameState, P0ElementType, WorldSchema } from '@once-upon/shared';

export const STORYBOOK_ROOM_SUFFIX = '#storybook';

export function storybookRoom(roomCode: string): string {
  return `${roomCode}${STORYBOOK_ROOM_SUFFIX}`;
}

export type StorybookRoomPhase =
  | 'lobby'
  | 'upload'
  | 'opening'
  | 'generating'
  | 'intro'
  | 'calibrating'
  | 'encounter'
  | 'boss'
  | 'ending'
  | 'defeat';

export type StorybookCombatPhase = 'idle' | 'telegraph' | 'defense' | 'return' | 'team_turn' | 'resolve';

interface StorybookEncounter {
  memory: string;
  name: string;
  template: EncounterSchema['template'];
  attacks: EncounterSchema['attacks'];
  weakness: P0ElementType;
  tier: EncounterSchema['tier'];
  lines: string[];
  art_prompt: string;
  artUrl?: string;
  hp?: number;
  maxHp?: number;
}

interface StorybookBoss extends StorybookEncounter {
  ward: 'twin_cast';
  wardUp?: boolean;
}

export interface StorybookGameState {
  roomCode: string;
  phase: StorybookRoomPhase;
  combatPhase: StorybookCombatPhase;
  teamHearts: number;
  maxTeamHearts: number;
  players: {
    id: string;
    name: string;
    role: 'spellbearer';
    inZone: boolean;
    connected: boolean;
    selectedElement: P0ElementType;
    elementLocked: boolean;
    fistCharged: boolean;
  }[];
  encounter?: StorybookEncounter;
  boss?: StorybookBoss;
  wardUp: boolean;
  twinCastMeter: number;
  currentRound: number;
  narratorCaption: string;
  tooLoud: boolean;
  selectedMemoryIds: string[];
  bossMemoryId?: string;
  world?: {
    title: string;
    intro: string;
    incantations: WorldSchema['incantations'];
    encounters: StorybookEncounter[];
    boss: StorybookBoss;
    coverArtUrl?: string;
  };
  memoryCards: NonNullable<GameState['memoryCards']>;
  quickStart: boolean;
  // Extra fields the storybook client ignores but that help debugging and countdowns.
  paused?: boolean;
  phaseEndsServerMs?: number;
}

/** Room facts the shared `GameState` does not carry. */
export interface StorybookExtras {
  generating: boolean;
  quickStart: boolean;
  caption: string;
  /** Players who have cast the same element this team turn (0-2). */
  twinCastCount: number;
  /** Cards a storybook player kept (the engine's encounter pick is one of them). */
  keptCardIds?: readonly string[];
}

const COMBAT_PHASES: Partial<Record<GamePhase, StorybookCombatPhase>> = {
  telegraph: 'telegraph',
  defense: 'defense',
  return: 'return',
  team_turn: 'team_turn',
  resolve: 'resolve',
};

export function toStorybookPhase(state: GameState, generating: boolean): StorybookRoomPhase {
  switch (state.phase) {
    case 'lobby':
      // The storybook client shows its landing screen for `lobby`, so a seated player sees
      // the chat-upload page while the room waits.
      return 'upload';
    case 'opening':
      return generating ? 'generating' : 'opening';
    case 'intro':
      // The first intro is the storybook page; later ones are the boss entrance mid-fight.
      return state.fightingBoss && state.roundIndex > 0 ? 'boss' : 'intro';
    case 'calibration':
      return 'calibrating';
    case 'ending':
      return state.hearts <= 0 ? 'defeat' : 'ending';
    default:
      return state.fightingBoss ? 'boss' : 'encounter';
  }
}

function toEncounter(e: EncounterSchema, artUrl?: string): StorybookEncounter {
  const weakness = (['ember', 'frost', 'bloom'] as const).includes(e.weakness as P0ElementType)
    ? (e.weakness as P0ElementType)
    : 'ember';
  return {
    memory: e.memory,
    name: e.name,
    template: e.template,
    attacks: e.attacks,
    weakness,
    tier: e.tier,
    lines: e.lines,
    art_prompt: e.artPrompt,
    ...(artUrl ? { artUrl } : {}),
  };
}

function toBoss(b: BossSchema, artUrl?: string): StorybookBoss {
  return { ...toEncounter(b, artUrl), ward: 'twin_cast' };
}

export function toStorybookState(state: GameState, extras: StorybookExtras): StorybookGameState {
  const images = state.images ?? {};
  const current = state.currentEncounter;
  const inCombat = Boolean(COMBAT_PHASES[state.phase]);
  const hp = current ? { hp: state.enemyHp, maxHp: state.enemyMaxHp } : {};
  const world = state.world;
  const boss = state.fightingBoss && current
    ? { ...toBoss(current as BossSchema, images.boss), ...hp, wardUp: state.wardActive }
    : world
      ? { ...toBoss(world.boss, images.boss), wardUp: false }
      : undefined;
  const picks = state.picks;

  return {
    roomCode: state.roomCode,
    phase: toStorybookPhase(state, extras.generating),
    combatPhase: COMBAT_PHASES[state.phase] ?? 'idle',
    teamHearts: state.hearts,
    maxTeamHearts: state.maxHearts,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      // Every storybook player is a spellbearer; bots keep the seat's look.
      role: 'spellbearer',
      // The client only lets a player speak while `inZone`. Without a camera there are no
      // pose frames, so report the server's own cast eligibility as well.
      inZone: p.inZone || p.canCast,
      connected: p.connected,
      selectedElement: p.selectedElement ?? 'ember',
      elementLocked: false,
      fistCharged: p.fistCharged,
    })),
    ...(current && !state.fightingBoss ? { encounter: { ...toEncounter(current, images.monster), ...hp } } : {}),
    ...(boss ? { boss } : {}),
    wardUp: state.wardActive,
    twinCastMeter: inCombat ? extras.twinCastCount : 0,
    currentRound: state.roundIndex,
    narratorCaption: extras.caption,
    tooLoud: state.players.some((p) => (p.noiseLevel ?? 0) >= NOISE_TOO_LOUD_THRESHOLD),
    selectedMemoryIds: [...new Set([...(extras.keptCardIds ?? []), picks?.encounterCardId, picks?.bossCardId])].filter(
      (id): id is string => Boolean(id) && (state.memoryCards ?? []).some((c) => c.id === id),
    ),
    ...(picks?.bossCardId ? { bossMemoryId: picks.bossCardId } : {}),
    ...(world
      ? {
          world: {
            title: world.title,
            intro: world.intro,
            incantations: world.incantations,
            encounters: world.encounters.map((e) => toEncounter(e, images.monster)),
            boss: toBoss(world.boss, images.boss),
            ...(images.cover ? { coverArtUrl: images.cover } : {}),
          },
        }
      : {}),
    memoryCards: state.memoryCards ?? [],
    quickStart: extras.quickStart,
    ...(state.paused ? { paused: true } : {}),
    ...(state.phaseEndsServerMs ? { phaseEndsServerMs: state.phaseEndsServerMs } : {}),
  };
}
