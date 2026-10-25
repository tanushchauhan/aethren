/**
 * One room's authoritative game: seats, opening flow, combat round loop, Twin Cast,
 * disconnect pause and bot fallback. `index.ts` owns the room map and socket wiring.
 *
 * Phase timeline (unscaled ms; every duration is multiplied by `timeScale`):
 *   lobby      -> host `game:start` (no auto-advance; the room waits for its players)
 *   opening    -> both picks + 2.5 s confirm, host `game:start`, or 60 s timeout (auto-picks)
 *   (generation, still `opening`) -> `ai.generateWorld`, capped at 25 s (then the cached world)
 *   intro      -> 300 ms per intro word + 1.5 s, clamped 5..20 s
 *   calibration-> every connected human sends `calibration:done` (+1 s), or 15 s
 *   round      -> telegraph (2 s / attack speed) -> defense (1..2 s, +0.5 s after Frost)
 *                 -> return 3 s -> team_turn 8 s (ends 0.7 s after everyone cast) -> resolve 1.5 s
 *   intro      -> 5 s entrance before every enemy after the first (the boss)
 *   ending     -> terminal
 */
import { randomUUID } from 'node:crypto';
import {
  BOSS_AGENT_DEADLINE_MS,
  COMBAT,
  DISCONNECT_PAUSE_MS,
  MERCY_POWER,
  NOISE_TOO_LOUD_THRESHOLD,
  P0_ELEMENTS,
  P0_PLAYER_COUNT,
  ROUND_TIMINGS_MS,
  TAUNT_MAX_CHARS,
  TEAM_HEARTS_P0,
  TWIN_CAST_WINDOW_MS,
  WARD_HP_RATIO,
} from '@once-upon/shared';
import type {
  AttackType,
  BossPlan,
  CastPayload,
  DodgeResultPayload,
  GamePhase,
  GameState,
  GestureType,
  HardwareCommand,
  HardwareEvent,
  JoinableRole,
  MemoryCard,
  NarratorLine,
  OpeningSlot,
  P0ElementType,
  PoseFrame,
  QuestDifficulty,
  QuestStatus,
  RoundResolution,
  ServerToClientEvents,
  TranscribeResponse,
  TwinCastProgress,
  WorldImage,
  WorldSchema,
} from '@once-upon/shared';
import type { AiService, BossPlanner, BossPlannerInput, GameServer, NarrationEvent } from '../contracts';
import { BOT_NAME, botCastDelayMs, botDodge, botGesture, botPickElement, botPower, type Rng } from './bot';
import { PhaseTimer, TimerGroup, type Clock } from './clock';
import {
  FROST_WINDOW_BONUS_MS,
  clampDefenseWindow,
  clampPower,
  dodgeDirection,
  enemyAttacks,
  enemyMaxHp,
  isP0Element,
  sanitizePlan,
  scriptedPlan,
  spellEffect,
  telegraphHint,
  telegraphMs,
  truncate,
  wardEligible,
  type Enemy,
  type PlanContext,
} from './combat';
import { NARRATE_TIMEOUT_MS, fallbackLine } from './narration';
import {
  MAX_SEATS,
  claimSeat,
  cleanName,
  makeBot,
  newSeat,
  roleForNewSeat,
  seatHuman,
  type ClaimResult,
  type Seat,
} from './rooms';
import { storybookRoom, toStorybookState } from './storybook';
import { TwinCastTracker } from './twin-cast';

/** Engine timings that `ROUND_TIMINGS_MS` does not cover. Unscaled ms. */
export const ENGINE_TIMINGS_MS = {
  openingTimeout: 60_000,
  picksConfirm: 2_500,
  openingRetry: 5_000,
  generationTimeout: 25_000,
  introBase: 1_500,
  introPerWord: 300,
  introMin: 5_000,
  introMax: 20_000,
  /** Storybook rooms: the story intro waits for its narration to finish (or Continue), up to this long. */
  introNarrationHold: 90_000,
  calibrationTimeout: 15_000,
  calibrationAllDone: 1_000,
  enemyEntrance: 5_000,
  /** Latency grace after the defense window before missing dodge reports count as misses. */
  dodgeGrace: 500,
  /** Team turn ends this long after the last eligible player casts. */
  turnEndGrace: 700,
  /** Pause before resolve when the enemy falls or the hearts run out mid-round. */
  defeatedGrace: 800,
  /** Team turn with nobody able to cast. */
  emptyTeamTurn: 1_500,
  twinExpiryGrace: 300,
  minResume: 1_500,
  minResumeTeamTurn: 3_000,
} as const;

/** A passed incantation can be cast within this long (server time, not scaled). */
export const INCANTATION_FRESH_MS = 15_000;
/** Client server-time stamps further than this from the server clock are replaced (not scaled). */
export const TIMESTAMP_TOLERANCE_MS = 3_000;
export const DODGE_HISTORY_LENGTH = 6;
export const RECENT_ELEMENTS_LENGTH = 8;

const GESTURES: readonly GestureType[] = ['swipe_left', 'swipe_right', 'swipe', 'thrust'];
const IMAGE_KINDS: readonly WorldImage['kind'][] = ['cover', 'monster', 'boss'];

export interface EngineRuntime {
  io: GameServer;
  ai: AiService;
  boss: BossPlanner;
  clock: Clock;
  rng: Rng;
  timeScale: number;
  log: (msg: string) => void;
}

export interface GameRoomInit {
  roomCode: string;
  hostName: string;
  hostRole: JoinableRole;
  difficulty: QuestDifficulty;
  encounterCardId?: string;
  playerNames?: string[];
  quickStart?: boolean;
}

interface PendingPlan {
  roundIndex: number;
  enemyIndex: number;
  /** Enemy HP the planner saw, to tell a stale "no ward" from a deliberate one. */
  inputHp: number;
  value: BossPlan | null | undefined;
}

interface ActiveAttack {
  attackId: string;
  attackType: AttackType;
  targets: string[];
  startedAt: number;
  impactMs: number;
  windowMs: number;
  reports: Map<string, DodgeResultPayload>;
  collected: boolean;
}

interface AcceptedCast {
  payload: CastPayload;
  appliedDamage: number;
  appliedHeal: number;
}

interface TurnState {
  casts: Map<string, AcceptedCast>;
  fizzled: Set<string>;
  tracker: TwinCastTracker;
  sittingOut: string[];
  ending: boolean;
}

export type CastOutcome = 'accepted' | 'fizzled' | 'dropped';

function newResolution(roundIndex: number, now: number): RoundResolution {
  return {
    roundIndex,
    damageDealt: 0,
    heartsLost: 0,
    heartsHealed: 0,
    parries: 0,
    twinCast: false,
    wardShattered: false,
    fizzles: [],
    sittingOut: [],
    enemyDefeated: false,
    serverTimestampMs: now,
  };
}

function isWorld(value: unknown): value is WorldSchema {
  const w = value as WorldSchema | null;
  return Boolean(
    w &&
      typeof w === 'object' &&
      w.incantations &&
      typeof w.incantations === 'object' &&
      Array.isArray(w.encounters) &&
      w.boss &&
      typeof w.boss === 'object',
  );
}

export class GameRoom {
  readonly state: GameState;
  readonly seats: Seat[] = [];
  readonly hostPlayerId: string;
  readonly difficulty: QuestDifficulty;
  /** Server time the last human left (or creation), or null while someone is connected. */
  emptySince: number | null;

  private readonly phaseTimer: PhaseTimer;
  /** Round-scoped timers (bot actions, dodge collection, Twin Cast expiry). Cleared on pause. */
  private readonly timers: TimerGroup;
  /** Background timers (narration and planner guards, bot takeover). Cleared on dispose. */
  private readonly bg: TimerGroup;
  private stash: { resume: (() => void) | null; after: (() => void)[] } | null = null;
  private disposed = false;
  private generating = false;
  /** Storybook clients: last narrator caption and Twin Cast progress (not in `GameState`). */
  private lastCaption = '';
  private twinCastCount = 0;
  readonly quickStart: boolean;
  /** Set when a storybook client sits down: it reports when the intro narration has finished. */
  holdIntroForNarration = false;
  /** Storybook: every card a player kept, newest last. The client keeps several; the engine uses one. */
  private keptCards: string[] = [];
  private genFallback: (() => void) | null = null;
  private imagesStarted = false;
  private servoOpened = false;
  private openingDeadline = 0;
  private enemyIndex = -1;
  private wardRaisedThisPhase = false;
  private wardRounds = 0;
  private frostBonusNext = false;
  private roundWindowMs: number = ROUND_TIMINGS_MS.defense;
  private recentElements: P0ElementType[] = [];
  private nextRound = 0;
  private plan: PendingPlan | null = null;
  private currentPlan: BossPlan | null = null;
  private attack: ActiveAttack | null = null;
  private turn: TurnState | null = null;
  private res: RoundResolution | null = null;

  constructor(
    private readonly rt: EngineRuntime,
    init: GameRoomInit,
  ) {
    this.phaseTimer = new PhaseTimer(rt.clock);
    this.timers = new TimerGroup(rt.clock);
    this.bg = new TimerGroup(rt.clock);
    this.difficulty = init.difficulty;

    const host = newSeat(cleanName(init.hostName), init.hostRole);
    this.seats.push(host);
    this.hostPlayerId = host.player.id;
    const otherRole: JoinableRole = init.hostRole === 'spellbearer' ? 'partner' : 'spellbearer';
    (init.playerNames ?? []).forEach((name, i) => {
      if (this.seats.length >= MAX_SEATS) return;
      const clean = cleanName(name);
      if (this.seats.some((s) => s.humanName.toLowerCase() === clean.toLowerCase())) return;
      this.seats.push(newSeat(clean, i === 0 ? otherRole : 'partner'));
    });

    const cards = this.safeCards();
    this.quickStart = Boolean(init.quickStart);
    const world = init.quickStart ? rt.ai.getCachedWorld() : null;
    const picks = init.quickStart
      ? { ...rt.ai.getCachedPicks() }
      : {
          encounterCardId:
            init.encounterCardId && (cards.length === 0 || cards.some((c) => c.id === init.encounterCardId))
              ? init.encounterCardId
              : null,
          bossCardId: null,
        };

    this.state = {
      roomCode: init.roomCode,
      phase: 'lobby',
      hearts: TEAM_HEARTS_P0,
      maxHearts: TEAM_HEARTS_P0,
      wardActive: false,
      wardSpell: null,
      players: this.seats.map((s) => s.player),
      world,
      currentEncounter: world?.encounters[0] ?? world?.boss ?? null,
      fightingBoss: false,
      enemyHp: 0,
      enemyMaxHp: 0,
      roundIndex: 0,
      serverTimestampMs: rt.clock.now(),
      memoryCards: cards,
      picks,
      images: {},
      paused: false,
      lastResolution: null,
    };
    this.emptySince = rt.clock.now();
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private now(): number {
    return this.rt.clock.now();
  }

  private scale(ms: number): number {
    return Math.max(1, Math.round(ms * this.rt.timeScale));
  }

  private emit<E extends keyof ServerToClientEvents>(event: E, payload: Parameters<ServerToClientEvents[E]>[0]): void {
    if (this.disposed) return;
    type Target = { emit: (ev: string, data: unknown) => boolean };
    (this.rt.io.to(this.state.roomCode) as unknown as Target).emit(event, payload);
    // Storybook clients get the same events, with room state in their own shape.
    if (event === 'narrator:line') this.lastCaption = (payload as NarratorLine).text;
    if (event === 'combat:twin_cast_progress') this.twinCastCount = (payload as TwinCastProgress).castByPlayerIds.length;
    const storybookTarget = this.rt.io.to(storybookRoom(this.state.roomCode)) as unknown as Target;
    storybookTarget.emit(event, event === 'room:state' ? this.storybookSnapshot() : payload);
    // The caption lives in storybook room state, so a new line refreshes it.
    if (event === 'narrator:line') storybookTarget.emit('room:state', this.storybookSnapshot());
  }

  /** True while world generation runs (the room is still in `opening`). */
  get isGenerating(): boolean {
    return this.generating;
  }

  storybookSnapshot() {
    return toStorybookState(this.snapshot(), {
      generating: this.generating,
      quickStart: this.quickStart,
      caption: this.lastCaption,
      twinCastCount: this.twinCastCount,
      keptCardIds: this.keptCards,
    });
  }

  snapshot(): GameState {
    this.state.players = this.seats.map((s) => s.player);
    this.state.serverTimestampMs = this.now();
    return this.state;
  }

  broadcast(): void {
    if (this.disposed) return;
    this.emit('room:state', this.snapshot());
  }

  private setPhase(phase: GamePhase, durationMs: number | null, next?: () => void): void {
    this.state.phase = phase;
    if (phase === 'team_turn') this.twinCastCount = 0;
    this.state.phaseEndsServerMs = durationMs === null ? undefined : this.now() + durationMs;
    if (durationMs !== null && next) this.phaseTimer.set(durationMs, () => this.guard(next));
    else this.phaseTimer.clear();
  }

  /** Reschedules the end of the current phase without changing the phase. */
  private reschedule(durationMs: number, next: () => void): void {
    this.state.phaseEndsServerMs = this.now() + durationMs;
    this.phaseTimer.set(durationMs, () => this.guard(next));
  }

  /** Runs a callback unless the room is gone, logging instead of crashing the server. */
  private safe(fn: () => void): void {
    if (this.disposed) return;
    try {
      fn();
    } catch (err) {
      this.rt.log(`[engine ${this.state.roomCode}] ${(err as Error).stack ?? String(err)}`);
    }
  }

  /** Like {@link safe}, but also skipped while the room is paused. */
  private guard(fn: () => void): void {
    if (this.stash) return;
    this.safe(fn);
  }

  /** A round-scoped timer (cleared on pause and phase jumps). */
  private after(ms: number, fn: () => void): void {
    this.timers.after(ms, () => this.guard(fn));
  }

  private seat(playerId: string | undefined): Seat | undefined {
    return playerId ? this.seats.find((s) => s.player.id === playerId) : undefined;
  }

  private safeCards(): MemoryCard[] {
    try {
      const cards = this.rt.ai.listMemoryCards();
      return Array.isArray(cards) ? cards : [];
    } catch {
      return [];
    }
  }

  private sanitizeTs(ts: unknown): number {
    const now = this.now();
    return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts - now) <= TIMESTAMP_TOLERANCE_MS ? ts : now;
  }

  private say(text: string, speaker: 'narrator' | 'boss' = 'narrator'): void {
    this.emit('narrator:line', { id: randomUUID(), speaker, text });
  }

  /** Asks `ai.narrate` for a line, falling back to an engine line after `NARRATE_TIMEOUT_MS`. */
  private narrate(kind: NarrationEvent['kind'], context: Record<string, unknown> = {}): void {
    const fallback = fallbackLine(kind, context);
    let done = false;
    const finish = (text: string | null) => {
      if (done || this.disposed) return;
      done = true;
      this.bg.cancel(timeout);
      this.say(text && text.trim() !== '' ? text.trim() : fallback);
    };
    const timeout = this.bg.after(this.scale(NARRATE_TIMEOUT_MS), () => finish(null));
    try {
      Promise.resolve(this.rt.ai.narrate({ kind, context })).then(
        (t) => finish(typeof t === 'string' ? t : null),
        () => finish(null),
      );
    } catch {
      finish(null);
    }
  }

  private hardware(command: HardwareCommand): void {
    if (command.type === 'servo') this.servoOpened = Boolean(command.servoOpen);
    this.emit('hardware:command', command);
  }

  private enemyName(): string {
    return this.state.currentEncounter?.name ?? 'the creature';
  }

  private nameOf(playerId: string): string {
    return this.seat(playerId)?.player.name ?? 'someone';
  }

  // -------------------------------------------------------------------------
  // Seats, connections, pause and bots
  // -------------------------------------------------------------------------

  claim(name: string, role: JoinableRole): ClaimResult {
    return claimSeat(this.seats, name, role);
  }

  /** Seats a socket. Returns the socket ID that held the seat before, if any (a stale tab). */
  attach(seat: Seat, socketId: string): string | null {
    const previous = seat.socketId && seat.socketId !== socketId ? seat.socketId : null;
    const wasBot = seat.isBot;
    this.bg.cancel(seat.disconnectTimer);
    seat.disconnectTimer = null;
    seatHuman(seat, socketId);
    this.emptySince = null;
    if (wasBot) this.rt.log(`[engine ${this.state.roomCode}] ${seat.player.name} reclaimed their seat from the bot`);
    this.updatePause();
    return previous;
  }

  detach(playerId: string, socketId: string): void {
    const seat = this.seat(playerId);
    if (!seat || seat.socketId !== socketId) return;
    seat.socketId = null;
    if (!seat.isBot) seat.player.connected = false;
    if (!this.seats.some((s) => !s.isBot && s.player.connected)) this.emptySince = this.now();
    this.updatePause();
    this.broadcast();
  }

  hasConnectedHumans(): boolean {
    return this.seats.some((s) => !s.isBot && s.player.connected);
  }

  private isPausablePhase(): boolean {
    return this.state.phase !== 'lobby' && this.state.phase !== 'ending';
  }

  private updatePause(): void {
    if (this.disposed) return;
    if (!this.isPausablePhase()) {
      if (this.stash || this.state.paused) this.resume();
      return;
    }
    const humans = this.seats.filter((s) => !s.isBot);
    if (!humans.some((s) => s.player.connected)) {
      // Room is empty: stop every timer, bots included, until someone comes back.
      this.bg.clear();
      for (const s of this.seats) s.disconnectTimer = null;
      this.pause('Waiting for players to reconnect');
      return;
    }
    if (this.state.phase === 'opening') {
      // Picks need no full table; empty seats become bots when the story starts.
      if (this.stash) this.resume();
      return;
    }
    const waiting = humans.filter((s) => s.everClaimed && !s.player.connected);
    for (const s of waiting) {
      if (s.disconnectTimer) continue;
      s.disconnectTimer = this.bg.after(this.scale(DISCONNECT_PAUSE_MS), () =>
        this.safe(() => {
          s.disconnectTimer = null;
          if (!s.player.connected && !s.isBot) {
            makeBot(s);
            this.rt.log(`[engine ${this.state.roomCode}] bot took ${s.player.name}'s seat`);
          }
          this.updatePause();
          this.broadcast();
        }),
      );
    }
    if (waiting.length > 0) this.pause(`${waiting.map((s) => s.player.name).join(' and ')} disconnected`);
    else if (this.stash || this.state.paused) this.resume();
  }

  private pause(reason: string): void {
    this.state.paused = true;
    this.state.pausedReason = reason;
    if (this.stash) {
      this.broadcast();
      return;
    }
    const taken = this.phaseTimer.take();
    this.timers.clear();
    const phase = this.state.phase;
    let resume: (() => void) | null = null;
    if (
      phase === 'telegraph' ||
      phase === 'defense' ||
      (phase === 'return' && this.attack !== null && !this.attack.collected)
    ) {
      // The attack in flight is cancelled; the same round replays on resume.
      const plan = this.currentPlan;
      resume = () => this.startRound(plan ?? undefined);
    } else if (phase === 'team_turn' && taken) {
      resume = () => this.resumeTeamTurn(Math.max(taken.remainingMs, this.scale(ENGINE_TIMINGS_MS.minResumeTeamTurn)), taken.fn);
    } else if (taken) {
      resume = () => this.reschedule(Math.max(taken.remainingMs, this.scale(ENGINE_TIMINGS_MS.minResume)), taken.fn);
    }
    this.stash = { resume, after: [] };
    this.state.phaseEndsServerMs = undefined;
    this.rt.log(`[engine ${this.state.roomCode}] paused in ${phase}: ${reason}`);
    this.broadcast();
  }

  private resume(): void {
    const stash = this.stash;
    this.stash = null;
    this.state.paused = false;
    this.state.pausedReason = undefined;
    if (stash) {
      this.rt.log(`[engine ${this.state.roomCode}] resumed in ${this.state.phase}`);
      if (this.genFallback) this.bg.after(this.scale(ENGINE_TIMINGS_MS.generationTimeout), this.genFallback);
      try {
        stash.resume?.();
        for (const fn of stash.after) fn();
      } catch (err) {
        this.rt.log(`[engine ${this.state.roomCode}] ${(err as Error).stack ?? String(err)}`);
      }
    }
    this.broadcast();
  }

  /** Runs `fn` now, or when the room resumes. */
  private whenActive(fn: () => void): void {
    if (this.stash) this.stash.after.push(fn);
    else this.guard(fn);
  }

  private resumeTeamTurn(ms: number, fn: () => void): void {
    if (this.turn) for (const p of this.turn.tracker.flush()) this.emit('combat:twin_cast_progress', p);
    this.reschedule(ms, fn);
    if (!this.turn?.ending) this.scheduleBotCasts(ms);
  }

  /** Any seat nobody is sitting in becomes a bot, and a solo run gets a bot partner. */
  private fillEmptySeatsWithBots(): void {
    for (const s of this.seats) {
      if (s.isBot || s.player.connected) continue;
      this.bg.cancel(s.disconnectTimer);
      s.disconnectTimer = null;
      makeBot(s);
    }
    while (this.seats.length < Math.min(P0_PLAYER_COUNT, MAX_SEATS)) {
      const seat = newSeat(BOT_NAME, roleForNewSeat(this.seats, 'spellbearer'));
      makeBot(seat);
      this.seats.push(seat);
    }
  }

  // -------------------------------------------------------------------------
  // Client inputs
  // -------------------------------------------------------------------------

  isHost(playerId: string | undefined): boolean {
    if (!playerId) return false;
    if (playerId === this.hostPlayerId) return true;
    // If the host's seat is empty or a bot, any seated human may start so the demo never stalls.
    const host = this.seat(this.hostPlayerId);
    const caller = this.seat(playerId);
    return Boolean(caller && !caller.isBot && (!host || host.isBot || !host.player.connected));
  }

  start(playerId: string | undefined): void {
    if (!this.isHost(playerId) || this.stash) return;
    if (this.state.phase === 'lobby') {
      if (this.state.world) this.beginIntro(this.state.world);
      else this.enterOpening();
    } else if (this.state.phase === 'opening' && this.picksComplete() && !this.generating) {
      this.startGeneration();
    }
  }

  /** Storybook keep: remembers the card and makes it the encounter, unless it is the crowned boss. */
  storybookKeep(cardId: unknown): void {
    if (typeof cardId !== 'string') return;
    this.keptCards = [...this.keptCards.filter((id) => id !== cardId), cardId];
    if (this.state.picks?.bossCardId === cardId) this.broadcast();
    else this.pickCard(cardId, 'encounter');
  }

  /** Storybook crown: sets the boss; if that was the encounter, the newest other kept card takes over. */
  storybookCrown(cardId: unknown): void {
    this.pickCard(cardId, 'boss');
    const picks = this.state.picks;
    if (!picks || picks.encounterCardId) return;
    const fallback = [...this.keptCards].reverse().find((id) => id !== picks.bossCardId);
    if (fallback) this.pickCard(fallback, 'encounter');
  }

  pickCard(cardId: unknown, slot: unknown): void {
    if (this.state.phase !== 'lobby' && this.state.phase !== 'opening') return;
    if (this.generating || typeof cardId !== 'string' || (slot !== 'encounter' && slot !== 'boss')) return;
    const cards = this.state.memoryCards ?? [];
    if (cards.length > 0 && !cards.some((c) => c.id === cardId)) return;
    const picks = this.state.picks ?? { encounterCardId: null, bossCardId: null };
    const s = slot as OpeningSlot;
    if (s === 'encounter') {
      if (picks.bossCardId === cardId) picks.bossCardId = null;
      picks.encounterCardId = cardId;
    } else {
      if (picks.encounterCardId === cardId) picks.encounterCardId = null;
      picks.bossCardId = cardId;
    }
    this.state.picks = picks;
    if (this.state.phase === 'opening' && !this.stash) {
      if (this.picksComplete()) {
        this.reschedule(this.scale(ENGINE_TIMINGS_MS.picksConfirm), () => this.startGeneration());
      } else {
        const left = Math.max(this.openingDeadline - this.now(), this.scale(ENGINE_TIMINGS_MS.openingRetry));
        this.reschedule(left, () => this.autoPickAndGenerate());
      }
    }
    this.broadcast();
  }

  calibrationDone(playerId: string | undefined): void {
    const seat = this.seat(playerId);
    if (!seat) return;
    seat.calibrated = true;
    if (this.state.phase === 'calibration' && !this.stash && this.allCalibrated()) {
      this.reschedule(this.scale(ENGINE_TIMINGS_MS.calibrationAllDone), () => this.startCombat());
      this.broadcast();
    }
  }

  pose(playerId: string | undefined, frame: PoseFrame): void {
    const seat = this.seat(playerId);
    if (!seat || !frame || typeof frame !== 'object') return;
    if (typeof frame.inZone === 'boolean') {
      seat.lastPoseInZone = frame.inZone;
      seat.player.inZone = frame.inZone;
    }
    const direction = dodgeDirection(frame.activeAction);
    if (direction) seat.lastDodgeAction = { direction, at: this.now() };
  }

  hardwareEvent(playerId: string | undefined, ev: HardwareEvent): void {
    const seat = this.seat(playerId);
    if (!seat || !ev || typeof ev !== 'object') return;
    const p = seat.player;
    let changed = false;
    if (typeof ev.fistCharged === 'boolean' && ev.fistCharged !== p.fistCharged) {
      p.fistCharged = ev.fistCharged;
      changed = true;
    }
    if (Number.isInteger(ev.dialSlot)) {
      const el = P0_ELEMENTS[ev.dialSlot];
      if (el && el !== p.selectedElement) {
        p.selectedElement = el;
        changed = true;
      }
    }
    if (typeof ev.armed === 'boolean' && ev.armed !== p.gloveArmed) {
      p.gloveArmed = ev.armed;
      changed = true;
    }
    if (typeof ev.noiseLevel === 'number' && Number.isFinite(ev.noiseLevel)) {
      const wasLoud = (p.noiseLevel ?? 0) >= NOISE_TOO_LOUD_THRESHOLD;
      p.noiseLevel = ev.noiseLevel;
      if (wasLoud !== ev.noiseLevel >= NOISE_TOO_LOUD_THRESHOLD) changed = true;
    }
    if (ev.parryTriggered) seat.lastParryAt = this.now();
    if (changed) this.broadcast();
  }

  recordIncantation(playerId: string, element: P0ElementType, result: TranscribeResponse): void {
    const seat = this.seat(playerId);
    if (!seat || !isP0Element(element) || !result || typeof result !== 'object') return;
    if (!result.passed && !result.mercy) return;
    const power =
      typeof result.power === 'number' && Number.isFinite(result.power)
        ? clampPower(result.power)
        : result.mercy
          ? MERCY_POWER
          : 1;
    seat.incantations.set(element, {
      power,
      transcript: typeof result.transcript === 'string' ? result.transcript : '',
      mercy: Boolean(result.mercy),
      at: this.now(),
    });
  }

  /** A `player:dodge_result` for the attack in flight. Returns true when accepted. */
  dodgeReport(playerId: string | undefined, payload: Partial<DodgeResultPayload>): boolean {
    const a = this.attack;
    if (!a || a.collected || !playerId || this.stash) return false;
    if (!payload || payload.attackId !== a.attackId || !a.targets.includes(playerId) || a.reports.has(playerId)) {
      return false;
    }
    const report: DodgeResultPayload = {
      playerId,
      attackId: a.attackId,
      dodged: Boolean(payload.dodged),
      parried: Boolean(payload.parried),
      serverTimestampMs: this.sanitizeTs(payload.serverTimestampMs),
    };
    a.reports.set(playerId, report);
    this.emit('player:dodge_result', report);
    return true;
  }

  /** A `player:cast`. Only the team turn accepts casts, and only after a passed incantation. */
  cast(playerId: string | undefined, payload: Partial<CastPayload>): CastOutcome {
    const turn = this.turn;
    const seat = this.seat(playerId);
    if (this.state.phase !== 'team_turn' || !turn || turn.ending || this.stash || !seat || !payload) return 'dropped';
    const id = seat.player.id;
    if (!seat.player.canCast || turn.casts.has(id) || !isP0Element(payload.element)) return 'dropped';
    const element = payload.element;
    const now = this.now();

    const rec = seat.incantations.get(element);
    if (!rec || now - rec.at > INCANTATION_FRESH_MS) {
      if (!turn.fizzled.has(id)) {
        turn.fizzled.add(id);
        if (seat.humanRole === 'spellbearer' && !seat.isBot) this.hardware({ type: 'buzz', pattern: 'fizzle' });
        this.narrate('fizzle', { playerName: seat.player.name, element, enemyName: this.enemyName() });
        this.broadcast();
      }
      return 'fizzled';
    }
    seat.incantations.delete(element);

    const power = Math.round(clampPower(clampPower(payload.power) * rec.power) * 100) / 100;
    const accepted: CastPayload = {
      playerId: id,
      element,
      gesture: payload.gesture && GESTURES.includes(payload.gesture) ? payload.gesture : 'swipe',
      transcript: rec.transcript || (typeof payload.transcript === 'string' ? payload.transcript : ''),
      power,
      serverTimestampMs: this.sanitizeTs(payload.serverTimestampMs),
    };
    const entry: AcceptedCast = { payload: accepted, appliedDamage: 0, appliedHeal: 0 };
    turn.casts.set(id, entry);
    turn.fizzled.delete(id);
    seat.player.selectedElement = element;
    this.recentElements = [...this.recentElements, element].slice(-RECENT_ELEMENTS_LENGTH);
    if (element === 'frost' && power > 0) this.frostBonusNext = true;
    this.emit('player:cast', accepted);
    if (seat.humanRole === 'spellbearer' && !seat.isBot) this.hardware({ type: 'buzz', pattern: 'cast' });

    const weakness = this.state.currentEncounter?.weakness;
    const update = turn.tracker.add({ playerId: id, element, serverTimestampMs: accepted.serverTimestampMs });
    this.emit('combat:twin_cast_progress', update.progress);

    if (update.kind === 'completed') {
      const res = this.res!;
      res.twinCast = true;
      const otherId = update.pair.find((e) => e.playerId !== id)!.playerId;
      const other = turn.casts.get(otherId);
      if (this.state.wardActive) {
        this.state.wardActive = false;
        this.state.wardSpell = null;
        res.wardShattered = true;
        this.hardware({ type: 'servo', servoOpen: true });
        this.narrate('ward_shattered', { enemyName: this.enemyName(), element });
      } else {
        this.narrate('twin_cast', { element, enemyName: this.enemyName() });
      }
      // The whole pair now lands at double strength; top up what the first cast already did.
      for (const c of [other, entry]) {
        if (!c) continue;
        const twin = spellEffect(c.payload.element, c.payload.power, weakness, { twin: true });
        c.appliedDamage += this.damageEnemy(twin.damage - c.appliedDamage);
        c.appliedHeal += this.healTeam(twin.heal - c.appliedHeal);
      }
    } else {
      const single = spellEffect(element, power, weakness);
      const blocked = this.state.wardActive && this.state.fightingBoss;
      entry.appliedDamage = blocked ? 0 : this.damageEnemy(single.damage);
      entry.appliedHeal = this.healTeam(single.heal);
      if (this.state.wardActive) this.botsJoinTwinCast(element, id);
      const expiresIn = update.progress.expiresServerMs + this.scale(ENGINE_TIMINGS_MS.twinExpiryGrace) - now;
      this.after(Math.max(0, expiresIn), () => {
        if (this.turn !== turn) return;
        for (const p of turn.tracker.expire(this.now())) this.emit('combat:twin_cast_progress', p);
      });
    }

    this.broadcast();
    if (this.state.enemyHp <= 0) this.endTurnSoon(this.scale(ENGINE_TIMINGS_MS.defeatedGrace));
    else this.maybeEndTurnEarly();
    return 'accepted';
  }

  // -------------------------------------------------------------------------
  // Opening, generation, intro, calibration
  // -------------------------------------------------------------------------

  private picksComplete(): boolean {
    const p = this.state.picks;
    return Boolean(p?.encounterCardId && p.bossCardId);
  }

  private enterOpening(): void {
    const cards = this.safeCards();
    if (cards.length > 0) this.state.memoryCards = cards;
    this.state.picks = this.state.picks ?? { encounterCardId: null, bossCardId: null };
    const timeout = this.scale(ENGINE_TIMINGS_MS.openingTimeout);
    this.openingDeadline = this.now() + timeout;
    this.setPhase('opening', timeout, () => this.autoPickAndGenerate());
    if (this.picksComplete()) this.reschedule(this.scale(ENGINE_TIMINGS_MS.picksConfirm), () => this.startGeneration());
    this.emit('memory:cards', this.state.memoryCards ?? []);
    this.updatePause();
    this.broadcast();
  }

  private autoPickAndGenerate(): void {
    const cards = this.state.memoryCards ?? [];
    const picks = this.state.picks ?? { encounterCardId: null, bossCardId: null };
    const free = () => cards.find((c) => c.id !== picks.encounterCardId && c.id !== picks.bossCardId)?.id ?? null;
    if (!picks.encounterCardId) picks.encounterCardId = free();
    if (!picks.bossCardId) picks.bossCardId = free();
    this.state.picks = picks;
    this.startGeneration();
  }

  private startGeneration(): void {
    if (this.generating || this.state.phase !== 'opening') return;
    this.generating = true;
    this.phaseTimer.clear();
    this.state.phaseEndsServerMs = undefined;
    const cards = this.state.memoryCards ?? [];
    const picks = this.state.picks;
    const find = (id: string | null | undefined) => cards.find((c) => c.id === id) ?? null;
    const input = {
      cards,
      encounterCard: find(picks?.encounterCardId),
      bossCard: find(picks?.bossCardId),
      playerNames: this.seats.map((s) => s.humanName),
      difficulty: this.difficulty,
    };
    this.rt.log(`[engine ${this.state.roomCode}] generating world`);
    let done = false;
    const finish = (world: unknown) => {
      if (done || this.disposed) return;
      done = true;
      this.genFallback = null;
      const valid = isWorld(world) ? world : this.rt.ai.getCachedWorld();
      this.whenActive(() => this.beginIntro(valid));
    };
    this.genFallback = () => finish(null);
    this.bg.after(this.scale(ENGINE_TIMINGS_MS.generationTimeout), () => finish(null));
    try {
      Promise.resolve(this.rt.ai.generateWorld(input)).then(finish, () => finish(null));
    } catch {
      finish(null);
    }
    this.broadcast();
  }

  private startImages(world: WorldSchema): void {
    if (this.imagesStarted) return;
    this.imagesStarted = true;
    const onImage = (img: WorldImage) => {
      if (this.disposed || !img || typeof img.url !== 'string' || !IMAGE_KINDS.includes(img.kind)) return;
      this.state.images = { ...(this.state.images ?? {}), [img.kind]: img.url };
      this.emit('world:image', { kind: img.kind, url: img.url });
      this.broadcast();
    };
    try {
      Promise.resolve(this.rt.ai.generateImages(world, onImage)).catch(() => undefined);
    } catch {
      // Images are decoration; the run continues with placeholder art.
    }
  }

  private beginIntro(world: WorldSchema): void {
    this.generating = false;
    this.state.world = world;
    this.fillEmptySeatsWithBots();
    this.startImages(world);
    this.prepareEnemy(0);
    const words = (world.intro ?? '').split(/\s+/).filter(Boolean).length;
    const ms = this.holdIntroForNarration
      ? ENGINE_TIMINGS_MS.introNarrationHold
      : Math.min(
          ENGINE_TIMINGS_MS.introMax,
          Math.max(ENGINE_TIMINGS_MS.introMin, ENGINE_TIMINGS_MS.introBase + words * ENGINE_TIMINGS_MS.introPerWord),
        );
    this.setPhase('intro', this.scale(ms), () => this.enterCalibration());
    this.hardware({ type: 'servo', servoOpen: false });
    this.updatePause();
    this.broadcast();
    if (world.intro && world.intro.trim() !== '') this.say(world.intro.trim());
    else this.narrate('intro', { title: world.title, playerNames: this.seats.map((s) => s.player.name) });
  }

  private allCalibrated(): boolean {
    const humans = this.seats.filter((s) => !s.isBot && s.player.connected);
    return humans.length > 0 && humans.every((s) => s.calibrated);
  }

  /** Ends the story intro early (narration finished, or a player pressed Continue). Not the boss entrance. */
  continueIntro(): void {
    if (this.state.phase !== 'intro' || this.enemyIndex !== 0 || this.stash) return;
    this.enterCalibration();
  }

  private enterCalibration(): void {
    this.setPhase('calibration', this.scale(ENGINE_TIMINGS_MS.calibrationTimeout), () => this.startCombat());
    if (this.allCalibrated()) this.reschedule(this.scale(ENGINE_TIMINGS_MS.calibrationAllDone), () => this.startCombat());
    this.broadcast();
  }

  private startCombat(): void {
    this.fillEmptySeatsWithBots();
    this.startRound();
  }

  // -------------------------------------------------------------------------
  // Enemies and boss planning
  // -------------------------------------------------------------------------

  private enemyAt(index: number): { enemy: Enemy; isBoss: boolean } | null {
    const world = this.state.world;
    if (!world) return null;
    const encounters = Array.isArray(world.encounters) ? world.encounters : [];
    if (index < encounters.length) return { enemy: encounters[index]!, isBoss: false };
    if (index === encounters.length) return { enemy: world.boss, isBoss: true };
    return null;
  }

  private prepareEnemy(index: number): boolean {
    const next = this.enemyAt(index);
    if (!next) return false;
    this.enemyIndex = index;
    const max = enemyMaxHp(next.enemy, next.isBoss, this.difficulty);
    Object.assign(this.state, {
      currentEncounter: next.enemy,
      fightingBoss: next.isBoss,
      enemyHp: max,
      enemyMaxHp: max,
      wardActive: false,
      wardSpell: null,
    });
    this.wardRaisedThisPhase = false;
    this.wardRounds = 0;
    this.frostBonusNext = false;
    this.requestPlan(this.nextRound);
    return true;
  }

  private beginEnemyWithEntrance(index: number): void {
    if (!this.prepareEnemy(index)) {
      this.enterEnding(true);
      return;
    }
    this.setPhase('intro', this.scale(ENGINE_TIMINGS_MS.enemyEntrance), () => this.startRound());
    this.broadcast();
    // The entrance uses the world's own words: a scene line, then the enemy's first line.
    const enemy = this.state.currentEncounter!;
    this.say(fallbackLine('boss_entrance', { enemyName: enemy.name }));
    const line = enemy.lines?.find((l) => typeof l === 'string' && l.trim() !== '');
    if (line) this.say(truncate(line.trim(), TAUNT_MAX_CHARS));
  }

  private planContext(roundIndex: number): PlanContext {
    return {
      enemy: this.state.currentEncounter!,
      isBoss: this.state.fightingBoss,
      enemyHp: this.state.enemyHp,
      enemyMaxHp: this.state.enemyMaxHp,
      wardActive: this.state.wardActive,
      wardRaisedThisPhase: this.wardRaisedThisPhase,
      playerIds: this.seats.map((s) => s.player.id),
      roundIndex,
    };
  }

  /** Builds the planner input from tracked history. Exposed for tests. */
  plannerInput(roundIndex: number): BossPlannerInput | null {
    const enemy = this.state.currentEncounter;
    if (!enemy) return null;
    return {
      roomCode: this.state.roomCode,
      enemy: { ...enemy, attacks: enemyAttacks(enemy) },
      isBoss: this.state.fightingBoss,
      enemyHp: this.state.enemyHp,
      enemyMaxHp: this.state.enemyMaxHp,
      wardActive: this.state.wardActive,
      wardRaisedThisPhase: this.wardRaisedThisPhase,
      hearts: this.state.hearts,
      maxHearts: this.state.maxHearts,
      difficulty: this.difficulty,
      players: this.seats.map((s) => ({ id: s.player.id, name: s.player.name, role: s.player.role })),
      dodgeHistory: Object.fromEntries(this.seats.map((s) => [s.player.id, [...s.dodgeHistory]])),
      recentElements: [...this.recentElements],
      roundIndex,
    };
  }

  /** Starts planning a round early so the plan is ready by its telegraph. */
  private requestPlan(roundIndex: number): void {
    const input = this.plannerInput(roundIndex);
    if (!input) return;
    const entry: PendingPlan = { roundIndex, enemyIndex: this.enemyIndex, inputHp: input.enemyHp, value: undefined };
    this.plan = entry;
    const deadline = this.scale(BOSS_AGENT_DEADLINE_MS);
    let planned: Promise<BossPlan | null>;
    try {
      planned = Promise.resolve(this.rt.boss.planNextRound(input, deadline)).catch(() => null);
    } catch {
      planned = Promise.resolve(null);
    }
    const guard = new Promise<null>((resolve) => this.bg.after(deadline + this.scale(250), () => resolve(null)));
    void Promise.race([planned, guard]).then((plan) => {
      if (this.plan === entry) entry.value = plan;
    });
  }

  private takePlan(roundIndex: number): BossPlan {
    const ctx = this.planContext(roundIndex);
    const entry = this.plan;
    this.plan = null;
    if (entry && entry.roundIndex === roundIndex && entry.enemyIndex === this.enemyIndex && entry.value) {
      const plan = sanitizePlan(entry.value, ctx);
      // The planner saw HP before this round's casts; raise a ward it could not know was due.
      const stale = entry.inputHp > ctx.enemyMaxHp * WARD_HP_RATIO;
      if (!plan.raiseWard && stale && wardEligible(ctx)) plan.raiseWard = true;
      return plan;
    }
    if (entry && entry.value === undefined) {
      this.rt.log(`[engine ${this.state.roomCode}] boss plan for round ${roundIndex} not ready; scripted fallback`);
    }
    return scriptedPlan(ctx);
  }

  // -------------------------------------------------------------------------
  // Combat round
  // -------------------------------------------------------------------------

  /** Starts a round, or replays the interrupted one with `replay` after a pause. */
  private startRound(replay?: BossPlan): void {
    const enemy = this.state.currentEncounter;
    if (!enemy) return;
    this.timers.clear();
    if (!replay) this.state.roundIndex = this.nextRound++;
    const roundIndex = this.state.roundIndex;
    const plan = replay ?? this.takePlan(roundIndex);
    this.currentPlan = plan;
    this.res = newResolution(roundIndex, this.now());
    this.turn = null;
    for (const s of this.seats) s.player.canCast = true;

    if (!replay) {
      if (this.state.wardActive && ++this.wardRounds === 2) {
        const botHint = this.seats.some((s) => s.isBot) ? ' Your bot partner will copy your spell.' : '';
        this.say(`The ward blocks every solo strike! Both choose the same element, speak its incantation, then cast within three seconds.${botHint}`, 'narrator');
      }
      if (plan.raiseWard && wardEligible(this.planContext(roundIndex))) {
        this.state.wardActive = true;
        this.state.wardSpell = this.state.world?.boss.ward ?? 'twin_cast';
        this.wardRaisedThisPhase = true;
        this.wardRounds = 0;
        this.narrate('ward_raised', { enemyName: enemy.name });
      }
      if (plan.taunt) this.say(truncate(plan.taunt, TAUNT_MAX_CHARS), 'boss');
      for (const effect of plan.effects) {
        this.hardware(effect === 'servo_open' ? { type: 'servo', servoOpen: true } : { type: 'buzz', pattern: effect });
      }
      this.roundWindowMs =
        clampDefenseWindow(plan.defenseWindowMs) + (this.frostBonusNext ? FROST_WINDOW_BONUS_MS : 0);
      this.frostBonusNext = false;
    }

    const valid = new Set(this.seats.map((s) => s.player.id));
    let targets = plan.targetPlayerIds.filter((id) => valid.has(id));
    if (targets.length === 0 && this.seats.length > 0) {
      targets = [this.seats[roundIndex % this.seats.length]!.player.id];
    }
    const tele = this.scale(telegraphMs(enemy, this.state.fightingBoss));
    const windowMs = this.scale(this.roundWindowMs);
    const now = this.now();
    this.attack = {
      attackId: randomUUID(),
      attackType: plan.attackType,
      targets,
      startedAt: now,
      impactMs: now + tele,
      windowMs,
      reports: new Map(),
      collected: false,
    };
    this.state.defenseWindowMs = windowMs;
    this.setPhase('telegraph', tele, () => this.enterDefense());
    this.broadcast();
    this.emit('combat:telegraph', {
      attackId: this.attack.attackId,
      attackType: plan.attackType,
      targetPlayerIds: targets,
      impactServerMs: this.attack.impactMs,
      windowMs,
      narratorHint: telegraphHint(plan.attackType, targets.map((id) => this.nameOf(id))),
    });
    this.rt.log(
      `[engine ${this.state.roomCode}] round ${roundIndex} ${plan.attackType} -> ${targets.map((t) => this.nameOf(t)).join(',')} (${plan.source}${replay ? ', replay' : ''})`,
    );
    this.scheduleBotDodges();
  }

  private scheduleBotDodges(): void {
    const a = this.attack;
    if (!a) return;
    for (const id of a.targets) {
      const seat = this.seat(id);
      if (!seat?.isBot) continue;
      const delay = a.impactMs - this.now() + this.rt.rng() * a.windowMs * 0.5;
      this.after(delay, () => {
        if (this.attack !== a || !seat.isBot) return;
        const outcome = botDodge(this.rt.rng, a.attackType, seat.humanRole === 'spellbearer');
        if (outcome.dodged) {
          seat.lastDodgeAction = {
            direction: a.attackType === 'high_swing' ? 'down' : this.rt.rng() < 0.5 ? 'left' : 'right',
            at: this.now(),
          };
        }
        this.dodgeReport(id, { attackId: a.attackId, ...outcome, serverTimestampMs: this.now() });
      });
    }
  }

  private enterDefense(): void {
    const a = this.attack;
    if (!a) return;
    this.setPhase('defense', a.windowMs, () => this.enterReturn());
    const grace = Math.min(this.scale(ENGINE_TIMINGS_MS.dodgeGrace), Math.floor(this.scale(ROUND_TIMINGS_MS.return) / 2));
    this.after(a.windowMs + grace, () => this.collectDodges());
    this.broadcast();
  }

  private enterReturn(): void {
    this.setPhase('return', this.scale(ROUND_TIMINGS_MS.return), () => this.enterTeamTurn());
    this.broadcast();
  }

  /** Closes the dodge window: missing reports are misses, parries hit back. */
  private collectDodges(): void {
    const a = this.attack;
    const res = this.res;
    if (!a || a.collected || !res) return;
    a.collected = true;
    let hitName: string | null = null;
    let parryName: string | null = null;
    let lost = 0;
    for (const id of a.targets) {
      const seat = this.seat(id);
      if (!seat) continue;
      const report = a.reports.get(id);
      const canParry = a.attackType === 'projectile' && seat.humanRole === 'spellbearer';
      const parried = canParry && (Boolean(report?.parried) || seat.lastParryAt >= a.startedAt);
      const dodged = parried || Boolean(report?.dodged) || Boolean(report?.parried);
      if (parried) {
        res.parries += 1;
        parryName ??= seat.player.name;
        if (!(this.state.wardActive && this.state.fightingBoss)) this.damageEnemy(COMBAT.parryDamage);
      }
      if (!dodged) {
        const loss = Math.min(this.state.hearts, COMBAT.heartLossOnHit);
        this.state.hearts -= loss;
        res.heartsLost += loss;
        lost += loss;
        hitName ??= seat.player.name;
      }
      const recent = seat.lastDodgeAction && seat.lastDodgeAction.at >= a.startedAt ? seat.lastDodgeAction.direction : null;
      seat.dodgeHistory = [
        ...seat.dodgeHistory,
        { roundIndex: res.roundIndex, attackType: a.attackType, dodged, parried, direction: dodged ? recent : null },
      ].slice(-DODGE_HISTORY_LENGTH);
    }
    if (lost > 0) this.hardware({ type: 'buzz', pattern: 'hit' });
    const facts = { enemyName: this.enemyName(), attackType: a.attackType };
    if (hitName) this.narrate('hit', { ...facts, playerName: hitName, hearts: this.state.hearts });
    else if (parryName) this.narrate('parry', { ...facts, playerName: parryName });
    else if (a.targets.length > 0) this.narrate('dodge', { ...facts, playerName: this.nameOf(a.targets[0]!) });
    this.broadcast();
    if (this.state.hearts <= 0 || this.state.enemyHp <= 0) this.endTurnSoon(this.scale(ENGINE_TIMINGS_MS.defeatedGrace));
  }

  private enterTeamTurn(): void {
    this.collectDodges();
    if (this.state.hearts <= 0 || this.state.enemyHp <= 0) return; // collectDodges ended the round early
    const sittingOut = this.seats.filter((s) => !s.isBot && s.lastPoseInZone === false).map((s) => s.player.id);
    for (const s of this.seats) s.player.canCast = !sittingOut.includes(s.player.id);
    this.turn = {
      casts: new Map(),
      fizzled: new Set(),
      tracker: new TwinCastTracker(TWIN_CAST_WINDOW_MS),
      sittingOut,
      ending: false,
    };
    if (this.res) this.res.sittingOut = sittingOut;
    const duration = this.scale(ROUND_TIMINGS_MS.teamTurn);
    this.setPhase('team_turn', duration, () => this.enterResolve());
    this.requestPlan(this.nextRound);
    this.broadcast();
    if (!this.seats.some((s) => s.player.canCast && (s.isBot || s.player.connected))) {
      this.reschedule(this.scale(ENGINE_TIMINGS_MS.emptyTeamTurn), () => this.enterResolve());
      return;
    }
    this.scheduleBotCasts(duration);
  }

  private scheduleBotCasts(turnMs: number): void {
    const turn = this.turn;
    if (!turn) return;
    for (const seat of this.seats) {
      if (!seat.isBot || !seat.player.canCast || turn.casts.has(seat.player.id)) continue;
      // Never spend the bot's only cast before a human behind the ward. Even a
      // last-moment human cast must have a matching partner available.
      if (this.state.wardActive && this.seats.some((s) => !s.isBot && s.player.connected)) continue;
      const delay = this.state.wardActive
        ? Math.round(turnMs * 0.7)
        : Math.min(Math.round(turnMs * 0.8), this.scale(botCastDelayMs(this.rt.rng, ROUND_TIMINGS_MS.teamTurn)));
      this.after(delay, () => this.botCast(seat, null));
    }
  }

  private botsJoinTwinCast(element: P0ElementType, openerId: string): void {
    const turn = this.turn;
    if (!turn) return;
    for (const seat of this.seats) {
      if (!seat.isBot || seat.player.id === openerId || !seat.player.canCast || turn.casts.has(seat.player.id)) continue;
      this.botCast(seat, element);
    }
  }

  private botCast(seat: Seat, element: P0ElementType | null): void {
    const turn = this.turn;
    if (this.state.phase !== 'team_turn' || !turn || !seat.isBot || turn.casts.has(seat.player.id)) return;
    const el = element ?? botPickElement(this.rt.rng, { hearts: this.state.hearts, maxHearts: this.state.maxHearts });
    const phrase = this.state.world?.incantations[el] ?? el;
    const now = this.now();
    seat.incantations.set(el, { power: 1, transcript: phrase, mercy: false, at: now });
    this.cast(seat.player.id, {
      playerId: seat.player.id,
      element: el,
      gesture: botGesture(this.rt.rng),
      transcript: phrase,
      power: botPower(this.rt.rng),
      serverTimestampMs: now,
    });
  }

  private damageEnemy(amount: number): number {
    const dealt = Math.max(0, Math.min(this.state.enemyHp, Math.round(amount)));
    this.state.enemyHp -= dealt;
    if (this.res) this.res.damageDealt += dealt;
    return dealt;
  }

  private healTeam(amount: number): number {
    const healed = Math.max(0, Math.min(this.state.maxHearts - this.state.hearts, amount));
    this.state.hearts += healed;
    if (this.res) this.res.heartsHealed += healed;
    return healed;
  }

  private maybeEndTurnEarly(): void {
    const turn = this.turn;
    if (!turn || turn.ending) return;
    const eligible = this.seats.filter((s) => s.player.canCast && (s.isBot || s.player.connected));
    if (eligible.length > 0 && eligible.every((s) => turn.casts.has(s.player.id))) {
      this.endTurnSoon(this.scale(ENGINE_TIMINGS_MS.turnEndGrace));
    }
  }

  /** Ends the round early (everyone cast, enemy down, or hearts gone) after `ms`. */
  private endTurnSoon(ms: number): void {
    if (this.turn) this.turn.ending = true;
    this.timers.clear();
    this.reschedule(ms, () => this.enterResolve());
  }

  private enterResolve(): void {
    const res = this.res;
    if (!res) return;
    this.timers.clear();
    const turn = this.turn;
    if (turn) {
      for (const p of turn.tracker.flush()) this.emit('combat:twin_cast_progress', p);
      res.fizzles = [...turn.fizzled];
      res.sittingOut = turn.sittingOut;
    }
    res.enemyDefeated = this.state.enemyHp <= 0;
    res.serverTimestampMs = this.now();
    this.state.lastResolution = res;
    this.turn = null;
    this.attack = null;
    this.setPhase('resolve', this.scale(ROUND_TIMINGS_MS.resolve), () => this.afterResolve());
    this.emit('combat:resolve', res);
    this.broadcast();
    if (res.enemyDefeated) this.narrate('enemy_defeated', { enemyName: this.enemyName(), isBoss: this.state.fightingBoss });
  }

  private afterResolve(): void {
    if (this.state.hearts <= 0) {
      this.enterEnding(false);
    } else if (this.state.enemyHp <= 0) {
      if (this.state.fightingBoss) this.enterEnding(true);
      else this.beginEnemyWithEntrance(this.enemyIndex + 1);
    } else {
      this.startRound();
    }
  }

  private enterEnding(victory: boolean): void {
    this.timers.clear();
    this.phaseTimer.clear();
    this.attack = null;
    this.turn = null;
    this.plan = null;
    this.state.wardActive = false;
    this.state.wardSpell = null;
    for (const s of this.seats) {
      this.bg.cancel(s.disconnectTimer);
      s.disconnectTimer = null;
    }
    this.stash = null;
    this.state.paused = false;
    this.state.pausedReason = undefined;
    this.setPhase('ending', null);
    if (victory && !this.servoOpened) this.hardware({ type: 'servo', servoOpen: true });
    this.rt.log(`[engine ${this.state.roomCode}] ending (${victory ? 'victory' : 'defeat'})`);
    this.broadcast();
    this.narrate(victory ? 'victory' : 'defeat', {
      title: this.state.world?.title,
      playerNames: this.seats.map((s) => s.player.name),
      hearts: this.state.hearts,
    });
  }

  // -------------------------------------------------------------------------
  // Read models
  // -------------------------------------------------------------------------

  questStatus(): QuestStatus {
    const s = this.state;
    return {
      roomCode: s.roomCode,
      phase: s.phase,
      hearts: s.hearts,
      maxHearts: s.maxHearts,
      enemyName: s.currentEncounter?.name ?? null,
      enemyHp: s.enemyHp,
      enemyMaxHp: s.enemyMaxHp,
      wardActive: s.wardActive,
    };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.phaseTimer.clear();
    this.timers.clear();
    this.bg.clear();
    for (const s of this.seats) s.disconnectTimer = null;
    this.stash = null;
  }
}
