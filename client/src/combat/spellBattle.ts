import { useDefense } from './defense';
import { create } from 'zustand';
import { combatants, createEncounter, armorValue, encounterReducer, PLAYER_ACTION, type AttackEvent, type EncounterId, type EncounterState, type ActorState } from './encounter';
import { HEROES, heroStore, isHero, localHeroStore, stanceFromValue, type HeroId, type PlayerStance } from './playerState';
import { hasStatus, STATUS_EFFECTS, withStatus } from './statusEffects';
import { scaleDamage } from './gameMode';
import { getSpell, SPELLS, STARTER_SPELLS, type Spell, type SpellId, type SpellInput } from './spells';
export type DodgeMode = 'natural' | 'hit' | 'dodge';
export type DefenseMode = 'dodge' | 'parry' | 'brace';
/** An active defensive pose or glove move, valid until `untilMs` (Date.now clock). */
export type PlayerDefense = { mode: 'none' | DefenseMode; label: string; untilMs: number };
export const DEFENSE_MS: Record<DefenseMode, number> = { dodge: 2000, parry: 2400, brace: 2400 };
/** Damage a successful parry bounces back at the attacker. */
export const PARRY_REFLECT_DAMAGE = 6;
/** The Gatekeeper's health when two heroes face him. */
export const COOP_KNIGHT_HP = 360;
export type CastOptions = { powerBoost?: number; autoEndTurn?: boolean };
/** `power` is the Overcharge multiplier locked in when the cast began. Self spells target their caster. */
export type Cast = { id: number; spell: Spell; casterId: HeroId; targetId: string; dodgeMode: DodgeMode; previousStance: PlayerStance; resolved: boolean; power: number; autoEndTurn?: boolean };
/** One wolf's reaction. `castId` is null for start-of-turn effects such as a burn tick. */
export type HitFeedback = { id: number; castId: number | null; targetId: string; kind: 'hurt' | 'dodge' | 'effect'; damage: number; label?: string };
/** What the co-op guest's screen asks the host to do for the ally. */
export type BattleIntent =
  | { type: 'cast'; input: SpellInput; source: 'diagnostic' | 'glove'; options?: CastOptions }
  | { type: 'rest' } | { type: 'end' }
  | { type: 'defend'; mode: DefenseMode; label?: string; ms?: number };
interface SpellBattle {
  encounterId: EncounterId;
  /** Two heroes share this fight: the host's `player` acts first, then the guest's `ally`. */
  coop: boolean;
  /** The ally's screen has gone quiet; their turns are skipped and the knight ignores them. */
  allyAway: boolean;
  heroNames: Record<HeroId, string>;
  /** Damage each hero dealt the knight since his last attack; his single-target swings go to the larger. */
  threat: Record<HeroId, number>;
  fieldTurns: number;
  opponents: Record<string, ActorState>;
  enemyTurn: EncounterState | null;
  activeId: string;
  turnNumber: number;
  status: 'active' | 'won' | 'lost';
  /** Spells unlocked so far. A fight starts with the three starter spells. */
  discoveredSpells: SpellId[];
  hintedSpellId: SpellId | null;
  lastDiscovered: SpellId | null;
  discoverSpell: (spellId: SpellId) => boolean;
  discoverAllSpells: () => void;
  cycleHint: (element?: Spell['element']) => SpellId | null;
  endTurn: () => void;
  rest: () => void;
  beginEnemy: () => void;
  enemyStep: (type: 'play' | 'impact' | 'return' | 'finish', actionId: number) => void;
  pending: Cast | null;
  feedback: HitFeedback[];
  message: string;
  /** The dodge, parry or brace the player is currently performing; consumed by the next wolf attack. */
  playerDefense: PlayerDefense | null;
  allyDefense: PlayerDefense | null;
  triggerDefense: (mode: DefenseMode, label?: string, durationMs?: number, heroId?: HeroId) => void;
  /** `powerBoost` (1..1.45, e.g. from a glove swing) multiplies spell power; `autoEndTurn` defaults to true for glove casts. */
  castSpell: (input: SpellInput, source?: 'diagnostic' | 'glove', dodgeMode?: DodgeMode, options?: CastOptions) => boolean;
  resolveCast: (id: number, roll?: number) => void;
  finishCast: (id: number) => void;
  cancelCast: () => void;
  diagnosticKillAll: () => void;
  setAllyAway: (away: boolean) => void;
  reset: (encounterId?: EncounterId, coop?: boolean) => void;
}
const initialOpponents = (id: EncounterId = 'wolves', coop = false) => Object.fromEntries(Object.entries(createEncounter(id).actors).filter(([id]) => id !== 'player')
  .map(([actorId, actor]) => [actorId, coop && actorId === 'knight' ? { ...actor, hp: COOP_KNIGHT_HP, maxHp: COOP_KNIGHT_HP } : actor]));
const opponentsOf = (engine: EncounterState) => Object.fromEntries(Object.entries(engine.actors).filter(([id]) => id !== 'player'));
const nameOf = (id: string) => combatants.find(actor => actor.id === id)!.name;
const enemyOrder = combatants.filter(actor => actor.side === 'enemy').map(actor => actor.id);
const NO_THREAT: Record<HeroId, number> = { player: 0, ally: 0 };
const allSpellIds = Object.keys(SPELLS) as SpellId[];
const nextUndiscovered = (discovered: readonly SpellId[], current?: SpellId | null, element?: Spell['element']): SpellId | null => {
  const locked = allSpellIds.filter(id => !discovered.includes(id) && (!element || SPELLS[id].element === element));
  if (!locked.length) return allSpellIds.find(id => !discovered.includes(id)) ?? null;
  const idx = current ? locked.indexOf(current) : -1;
  return locked[(idx + 1) % locked.length]!;
};
let nextCastId = 0;
let nextTurnSession = 0;
let nextFeedbackId = 0;
/**
 * Set on the co-op guest's screen: the host runs the fight, so this store becomes a mirror of the host's snapshots
 * and the guest's own moves are sent there instead of being played here.
 */
let remote: ((intent: BattleIntent) => void) | null = null;
export function setBattleRemote(send: ((intent: BattleIntent) => void) | null) { remote = send; }
export const isBattleMirror = () => remote !== null;
const dodges = (targetId: string, dodgeMode: DodgeMode, roll: number) => dodgeMode === 'dodge' || (dodgeMode === 'natural' && roll < (targetId === 'knight' ? 0 : targetId === 'center' ? .1 : .2));
/** Armor reduces each hit to a minimum of 1, unless the spell pierces. Zero-damage spells stay at zero. */
export function spellDamage(spell: Spell, base: number, targetId: string, target: ActorState) {
  if (base <= 0) return 0;
  return spell.pierce ? base : Math.max(1, base - armorValue(targetId, target));
}
export function resolveSpellHit(spell: Spell, targetId: string, target: ActorState, dodgeMode: DodgeMode, roll: number, power = 1) {
  const dodged = canBeDodged(spell) && dodges(targetId, dodgeMode, roll);
  return { dodged, damage: dodged ? 0 : spellDamage(spell, Math.floor(spell.damage * power), targetId, target) };
}
/** Area, splash and chain spells fill the space a wolf would dodge into. */
export const canBeDodged = (spell: Spell) => spell.target === 'enemy' && !spell.area && !spell.splash && !spell.chain;
/** Who a spell lands on and for how much, before armor: the primary target first. */
export function spellHits(spell: Spell, primaryId: string, living: string[], power = 1) {
  const primary = { targetId: primaryId, base: Math.floor(spell.damage * power) };
  const others = living.filter(id => id !== primaryId);
  if (spell.area) return [primary, ...others.map(targetId => ({ targetId, base: Math.floor(spell.damage * power) }))];
  if (spell.splash) return [primary, ...others.map(targetId => ({ targetId, base: Math.floor(spell.splash! * power) }))];
  if (spell.chain) {
    // The bolt jumps to the nearest wolf in the formation, then onward.
    const index = enemyOrder.indexOf(primaryId);
    const order = [...others].sort((a, b) => Math.abs(enemyOrder.indexOf(a) - index) - Math.abs(enemyOrder.indexOf(b) - index) || enemyOrder.indexOf(a) - enemyOrder.indexOf(b));
    return [primary, ...order.slice(0, spell.chain.length).map((targetId, i) => ({ targetId, base: Math.floor(spell.chain![i] * power) }))];
  }
  return [primary];
}
const restoreStance = (pending: Cast) => {
  const hero = heroStore(pending.casterId);
  if (hero.getState().stance === 'casting') hero.setState({ stance: pending.previousStance === 'guarding' ? 'guarding' : stanceFromValue(hero.getState().stanceValue) });
};
/** Which heroes an attack lands on: wide attacks hit everyone standing, a swing goes to whoever hurt the knight most (the weaker on a tie). */
export function attackTargets(attack: AttackEvent, standing: HeroId[], threat: Record<HeroId, number>): HeroId[] {
  if (standing.length < 2) return standing;
  if (attack.type === 'eclipse' || attack.type === 'inferno') return standing;
  const [first, second] = standing as [HeroId, HeroId];
  if (threat[first] !== threat[second]) return [threat[first] > threat[second] ? first : second];
  return [heroStore(second).getState().health < heroStore(first).getState().health ? second : first];
}
export const useSpellBattle = create<SpellBattle>((set, get) => {
  /** A hero who is in this fight and still standing. The ally only exists in co-op, and not while their screen is away. */
  const standing = (id: HeroId) => (id === 'player' || (get().coop && !get().allyAway)) && heroStore(id).getState().health > 0;
  const who = (id: HeroId) => get().coop ? get().heroNames[id] : 'You';
  const turnMessage = (id: HeroId) => get().coop ? `${who(id)}’s turn.` : 'Your turn. Choose a spell or end your turn.';
  /** Starts a hero's own turn (field flames, bleeding, regeneration); false when that knocks them out. */
  function beginHeroTurn(id: HeroId, fieldTurns: number) {
    if (fieldTurns > 0) heroStore(id).getState().receiveFieldDamage(4);
    heroStore(id).getState().startTurn();
    return heroStore(id).getState().health > 0;
  }
  /** Applies one step of the opponents' engine: their attacks, burn ticks, skipped turns, and the hand-back to you. */
  function applyEngine(engine: EncounterState, next: EncounterState) {
    const state = get();
    const fieldTurns = next.lastAttack !== engine.lastAttack && next.lastAttack?.type === 'inferno' ? 5 : state.fieldTurns;
    let defenseMessage: string | null = null, clearDefense = false, threat = state.threat, targetNote = '';
    if (next.lastAttack && next.lastAttack !== engine.lastAttack) {
      const attack = next.lastAttack;
      const curse = attack.type === 'inferno' ? 'scorn' : attack.type === 'scorn' || attack.type === 'eclipse' ? attack.type : undefined;
      const targets = attackTargets(attack, HEROES.filter(standing), state.threat);
      if (state.coop && targets.length === 1) targetNote = ` on ${who(targets[0]!)}`;
      threat = NO_THREAT;
      for (const heroId of targets) {
        const hero = heroStore(heroId), player = hero.getState();
        // The camera watches the host's own player only; the partner defends with their glove.
        const cameraDefense = heroId === 'player' ? useDefense.getState().resolve(attack.actionId, player.stanceValue) : 'hit';
        const held = heroId === 'player' ? state.playerDefense : state.allyDefense;
        const defense = held && held.mode !== 'none' && Date.now() <= held.untilMs ? held : null;
        if (held) clearDefense = true;
        const by = state.coop ? `${who(heroId)} ` : '';
        if (cameraDefense === 'dodged' || defense?.mode === 'dodge') {
          // A clean evasion: no damage, no stance loss, no bleeding.
          defenseMessage = cameraDefense === 'dodged' ? `${by}Dodged with movement tracking!` : `${by}Dodged! (${defense!.label})`;
          if (heroId === 'player') useDefense.setState({ result: 'dodged' });
        } else if (defense?.mode === 'parry' || defense?.mode === 'brace') {
          // Both guard for this hit, halving damage and stance loss; a parry also bounces damage back (never lethal, so the wolf's action finishes cleanly).
          const wasGuarding = player.stance === 'guarding';
          player.setStance('guarding');
          player.receiveAttack(attack.damage, attack.stanceDamage, curse, cameraDefense === 'blocked');
          if (heroId === 'player') useDefense.setState({ result: 'blocked' });
          if (!wasGuarding && hero.getState().stance === 'guarding') hero.setState({ stance: stanceFromValue(hero.getState().stanceValue) });
          if (defense.mode === 'parry') {
            const source = next.actors[attack.source];
            if (source && !source.defeated) next = { ...next, actors: { ...next.actors, [attack.source]: { ...source, hp: Math.max(1, source.hp - PARRY_REFLECT_DAMAGE) } } };
            defenseMessage = `${by}Parried with ${defense.label}!`;
          } else defenseMessage = `${by}Braced with ${defense.label}!`;
        } else player.receiveAttack(attack.damage, attack.stanceDamage, curse, cameraDefense === 'blocked');
      }
    }
    const feedback: HitFeedback[] = [];
    const tick = next.lastTick !== engine.lastTick ? next.lastTick : null;
    const skippedId = !next.action && !engine.action && next.queue[0] !== engine.queue[0] ? engine.queue[0] : null;
    const frozen = skippedId && !next.actors[skippedId].defeated ? 'Frozen' : null;
    if (tick) feedback.push({ id: ++nextFeedbackId, castId: null, targetId: tick.actorId, kind: 'hurt', damage: tick.damage, label: frozen ? 'Burning · Frozen' : 'Burning' });
    else if (frozen) feedback.push({ id: ++nextFeedbackId, castId: null, targetId: skippedId!, kind: 'effect', damage: 0, label: frozen });
    const opponents = opponentsOf(next);
    // The engine hands back to `player` for the heroes' whole round; the first hero still standing after their turn-start effects goes.
    const heroesUp = next.queue[0] === 'player';
    let heroTurn: HeroId | null = null;
    if (heroesUp && !isHero(state.activeId)) heroTurn = HEROES.find(id => standing(id) && beginHeroTurn(id, fieldTurns)) ?? null;
    if (!HEROES.some(standing)) {
      set({ fieldTurns: 0, enemyTurn: null, status: 'lost', opponents, threat, message: state.coop ? 'Both heroes have fallen. Try the encounter again.' : 'You have fallen. Try the encounter again.' });
      return;
    }
    const won = Object.values(opponents).every(actor => actor.defeated);
    const activeId = won ? 'player' : heroTurn ?? (heroesUp ? state.activeId : next.queue[0]);
    set({ fieldTurns: won ? 0 : fieldTurns, enemyTurn: heroesUp || won ? null : next, activeId, opponents, status: won ? 'won' : 'active', threat,
      turnNumber: state.turnNumber + (activeId !== state.activeId && !won ? 1 : 0),
      ...(feedback.length ? { feedback } : {}),
      ...(clearDefense ? { playerDefense: null, allyDefense: null } : {}),
      message: heroTurn ? turnMessage(heroTurn) : defenseMessage ?? (targetNote ? next.lastMove.replace(/\.$/, `${targetNote}.`) : next.lastMove) });
  }
  return {
    encounterId: 'wolves', coop: false, allyAway: false, heroNames: { player: 'You', ally: 'Your partner' }, threat: NO_THREAT,
    fieldTurns: 0, opponents: initialOpponents(), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active',
    discoveredSpells: [...STARTER_SPELLS], hintedSpellId: 'fire-lance', lastDiscovered: null,
    pending: null, feedback: [], message: 'Choose a spell and weave its ritual.', playerDefense: null, allyDefense: null,
    discoverSpell(spellId) {
      const state = get();
      if (state.discoveredSpells.includes(spellId)) return false;
      const discoveredSpells = [...state.discoveredSpells, spellId];
      const hintedSpellId = state.hintedSpellId === spellId ? nextUndiscovered(discoveredSpells, spellId) : state.hintedSpellId;
      set({ discoveredSpells, hintedSpellId, lastDiscovered: spellId, message: `New spell discovered: ${SPELLS[spellId].name}!` });
      return true;
    },
    discoverAllSpells() { set({ discoveredSpells: [...allSpellIds], hintedSpellId: null }); },
    cycleHint(element) {
      const state = get();
      const next = nextUndiscovered(state.discoveredSpells, state.hintedSpellId, element);
      set({ hintedSpellId: next, ...(next ? { message: `Grimoire hint (${SPELLS[next].element.toUpperCase()}): ${SPELLS[next].hint}` } : {}) });
      return next;
    },
    triggerDefense(mode, label, durationMs, heroId = localHeroStore.getState().hero) {
      const state = get();
      if (state.status !== 'active') return;
      const ms = Number.isFinite(durationMs) && durationMs! > 0 ? durationMs! : DEFENSE_MS[mode];
      const defense = { mode, label: label ?? mode[0].toUpperCase() + mode.slice(1), untilMs: Date.now() + ms };
      set(heroId === 'ally' ? { allyDefense: defense } : { playerDefense: defense });
      if (remote) { remote({ type: 'defend', mode, label, ms }); return; }
    },
    castSpell(input, source = 'diagnostic', dodgeMode = 'natural', options) {
      const battle = get(), caster = isHero(battle.activeId) ? battle.activeId : null, spell = getSpell(input?.spellId);
      const fail = (message: string) => { set({ message }); return false; };
      if (battle.pending || !caster || battle.status !== 'active') return false;
      if (remote && caster !== localHeroStore.getState().hero) return false;
      const player = heroStore(caster).getState();
      if (!spell) return fail('Choose a known spell.');
      const targetId = spell.target === 'self' ? caster : input.targetId ?? '';
      if (spell.target === 'enemy' && (!battle.opponents[targetId] || battle.opponents[targetId].defeated)) return fail('Choose a living opponent.');
      if (player.health <= 0 || !['balanced', 'guarding', 'shaken'].includes(player.stance)) return fail('Staggered — end your turn to recover your stance.');
      if (player.magicPower < spell.cost) return fail('Not enough Magic Power. Rest or end your turn to recover it.');
      // The host checks again and plays it; a refusal comes back to the guest's screen.
      if (remote) { remote({ type: 'cast', input, source, options }); return true; }
      // Overcharge is spent by the next spell that deals damage, and pays back 1 MP on a Storm spell.
      const overcharged = spell.damage > 0 && player.statuses.some(status => status.id === 'overcharged');
      const id = ++nextCastId;
      const boost = Number.isFinite(options?.powerBoost) && options!.powerBoost! > 0 ? options!.powerBoost! : 1;
      const by = battle.coop ? `${who(caster)}: ` : '';
      const newlyDiscovered = !battle.discoveredSpells.includes(spell.id);
      const discoveredSpells = newlyDiscovered ? [...battle.discoveredSpells, spell.id] : battle.discoveredSpells;
      const hintedSpellId = newlyDiscovered && battle.hintedSpellId === spell.id ? nextUndiscovered(discoveredSpells, spell.id, spell.element) : battle.hintedSpellId;
      // Lock the action before notifying external subscribers, preventing duplicate casts.
      set({ discoveredSpells, hintedSpellId, ...(newlyDiscovered ? { lastDiscovered: spell.id } : {}),
        pending: { id, spell, casterId: caster, targetId, dodgeMode: source === 'diagnostic' ? dodgeMode : 'natural', previousStance: player.stance, resolved: false,
        power: (overcharged ? SPELLS.overcharge.overcharge!.multiplier : 1) * boost, autoEndTurn: options?.autoEndTurn ?? source === 'glove' }, feedback: [],
        message: `${newlyDiscovered ? `✦ Discovered ${spell.name}! ` : ''}${by}${spell.target === 'self' ? `${spell.name}…` : `${spell.name} → ${nameOf(targetId)}${overcharged ? ' (overcharged)' : ''}`}` });
      player.setMagicPower(player.magicPower - spell.cost + (overcharged && spell.element === 'storm' ? 1 : 0));
      if (overcharged) player.removeStatus('overcharged');
      player.requestAttack(source, input);
      player.setStance('casting');
      return true;
    },
    resolveCast(id, roll = Math.random()) {
      const { pending, opponents, threat } = get();
      if (remote || !pending || pending.id !== id || pending.resolved) return;
      const spell = pending.spell;
      if (spell.target === 'self') {
        const player = heroStore(pending.casterId).getState();
        const shieldAmount = spell.shield ? scaleDamage(Math.max(1, Math.round(spell.shield.amount * pending.power))) : 0;
        if (spell.shield) player.addStatus({ id: 'shielded', remaining: spell.shield.turns, amount: shieldAmount });
        if (spell.overcharge) player.addStatus({ id: 'overcharged', remaining: spell.overcharge.turns });
        set({ pending: { ...pending, resolved: true }, feedback: [],
          message: spell.shield ? `Ice Shield raised: absorbs ${shieldAmount} damage.` : 'Overcharged: your next damaging spell hits 50% harder.' });
        return;
      }
      const living = enemyOrder.filter(enemyId => opponents[enemyId] && !opponents[enemyId].defeated);
      const next = { ...opponents }, feedback: HitFeedback[] = [], parts: string[] = [];
      let dealt = 0, refundedMp = 0;
      spellHits(spell, pending.targetId, living, pending.power).forEach(({ targetId, base }, index) => {
        const target = next[targetId];
        if (index === 0 && canBeDodged(spell) && dodges(targetId, pending.dodgeMode, roll)) {
          feedback.push({ id: ++nextFeedbackId, castId: id, targetId, kind: 'dodge', damage: 0 });
          parts.push(`${nameOf(targetId)} dodged`);
          return;
        }
        const isFrozen = hasStatus(target.statuses, 'frozen');
        const isChilled = hasStatus(target.statuses, 'chilled');
        const isBurning = hasStatus(target.statuses, 'burning');
        const isRousedTarget = hasStatus(target.statuses, 'roused');
        const shatter = spell.element === 'fire' && base > 0 && (isChilled || isFrozen);
        const conductive = spell.element === 'storm' && base > 0 && (isBurning || isChilled);
        const stripsRoused = isRousedTarget && (spell.id === 'static-shock' || spell.id === 'frost-prison');
        const rousedBonus = stripsRoused && spell.id === 'static-shock' ? 5 : 0;
        let statuses = target.statuses;
        if (stripsRoused) statuses = statuses.filter(status => status.id !== 'roused');
        if (shatter) statuses = statuses.filter(status => status.id !== 'chilled' && status.id !== 'frozen');
        const boostedBase = (shatter ? Math.floor(base * 1.5) : base) + (conductive ? 4 : 0) + rousedBonus;
        const damage = scaleDamage(spellDamage(spell, boostedBase, targetId, { ...target, statuses })), hp = Math.max(0, target.hp - damage), defeated = hp === 0;
        dealt += target.hp - hp;
        let energy = target.energy;
        if (!defeated && spell.applies) statuses = withStatus(statuses, { id: spell.applies.id, remaining: targetId === 'knight' && spell.applies.id === 'frozen' ? 1 : spell.applies.turns, amount: spell.applies.amount === undefined ? undefined : scaleDamage(spell.applies.amount), source: 'player', appliedAction: PLAYER_ACTION });
        if (!defeated && spell.drain) energy = 0;
        if (conductive && refundedMp === 0) refundedMp = 1;
        next[targetId] = { ...target, hp, energy, defeated, statuses: defeated ? [] : statuses };
        const statusLabel = !defeated && spell.applies ? STATUS_EFFECTS[spell.applies.id].label : undefined;
        const counterTag = shatter ? 'Shatter!' : conductive && stripsRoused ? 'Conductive · Roused Broken!' : conductive ? 'Conductive!' : stripsRoused ? 'Roused Broken!' : undefined;
        const label = [counterTag, statusLabel].filter(Boolean).join(' · ') || undefined;
        feedback.push({ id: ++nextFeedbackId, castId: id, targetId, kind: damage ? 'hurt' : 'effect', damage, label });
        parts.push(defeated ? `${nameOf(targetId)} defeated` : damage ? `${nameOf(targetId)} took ${damage}${counterTag ? ` (${counterTag})` : ''}` : `${nameOf(targetId)} is ${statusLabel?.toLowerCase()}`);
      });
      if (refundedMp > 0) {
        const caster = heroStore(pending.casterId).getState();
        caster.setMagicPower(caster.magicPower + refundedMp);
      }
      set({ opponents: next, pending: { ...pending, resolved: true }, feedback, threat: { ...threat, [pending.casterId]: threat[pending.casterId] + dealt },
        message: `${spell.name}: ${parts.join(', ')}.` });
    },
    finishCast(id) {
      const { pending } = get();
      if (remote || !pending || pending.id !== id || !pending.resolved) return;
      restoreStance(pending);
      const won = Object.values(get().opponents).every(actor => actor.defeated);
      set({ pending: null, fieldTurns: won ? 0 : get().fieldTurns, status: won ? 'won' : 'active' });
      // Casting hands the turn on once the spell has played out, and an ally who left mid-cast hands it on too.
      if (!won && (pending.autoEndTurn || (pending.casterId === 'ally' && get().allyAway))) get().endTurn();
    },
    rest() {
      const state = get(), hero = isHero(state.activeId) ? state.activeId : null;
      if (state.pending || state.enemyTurn || !hero || state.status !== 'active' || heroStore(hero).getState().health <= 0) return;
      if (remote) { if (hero === localHeroStore.getState().hero) remote({ type: 'rest' }); return; }
      const player = heroStore(hero).getState();
      // Advance first to lock the action against repeat clicks/subscriber requests.
      get().endTurn();
      if (get().activeId === hero) return;
      player.setStanceValue(player.stanceValue + 45);
      player.setMagicPower(player.magicPower + 3);
      const nextHint = nextUndiscovered(state.discoveredSpells, state.hintedSpellId);
      const rested = state.coop ? `${who(hero)} rests, recovering stance and Magic Power.` : 'You rest, recovering stance and Magic Power.';
      set({ hintedSpellId: nextHint, message: nextHint ? `${rested} Hint: ${SPELLS[nextHint].hint}` : rested });
    },
    endTurn() {
      const state = get();
      if (state.pending || state.enemyTurn || state.status !== 'active') return;
      if (remote) { if (state.activeId === localHeroStore.getState().hero) remote({ type: 'end' }); return; }
      // In co-op the host's player hands to the partner before the opponents act.
      if (state.activeId === 'player' && standing('ally') && beginHeroTurn('ally', state.fieldTurns)) {
        set({ activeId: 'ally', turnNumber: state.turnNumber + 1, feedback: [], message: turnMessage('ally') });
        return;
      }
      if (!HEROES.some(standing)) { set({ fieldTurns: 0, status: 'lost', message: 'Both heroes have fallen. Try the encounter again.' }); return; }
      let engine = createEncounter(state.encounterId);
      const queue = ['player', ...enemyOrder.filter(id => state.opponents[id] && !state.opponents[id].defeated)];
      if (queue.length < 2) return;
      engine = { ...engine, actors: { ...engine.actors, ...state.opponents }, queue, roundPending: [...queue], serial: ++nextTurnSession * 1000 };
      engine = encounterReducer(engine, { type: 'pass', turn: engine.serial });
      set({ fieldTurns: Math.max(0, state.fieldTurns - 1), enemyTurn: engine, activeId: engine.queue[0], turnNumber: state.turnNumber + 1, feedback: [], message: 'Opponents are acting.' });
    },
    beginEnemy() {
      const state = get(), engine = state.enemyTurn;
      if (remote || !engine || engine.action || engine.queue[0] === 'player' || state.status !== 'active') return;
      const next = encounterReducer(engine, { type: 'begin', actorId: engine.queue[0], turn: engine.serial });
      if (next !== engine) {
        if (next.action && !engine.action) useDefense.getState().begin(next.action.id, next.action.moveId);
        applyEngine(engine, next);
      }
    },
    enemyStep(type, actionId) {
      const state = get(), engine = state.enemyTurn;
      if (remote || !engine || state.status !== 'active') return;
      const next = encounterReducer(engine, { type, actionId });
      if (next !== engine) applyEngine(engine, next);
    },
    diagnosticKillAll() {
      const state = get();
      if (remote || state.status !== 'active') return;
      useDefense.getState().clear();
      if (state.pending) restoreStance(state.pending);
      set({ opponents: Object.fromEntries(Object.entries(state.opponents).map(([id, actor]) => [id, { ...actor, hp: 0, defeated: true, statuses: [] }])),
        fieldTurns: 0, pending: null, enemyTurn: null, feedback: [], activeId: 'player', status: 'won', message: 'Diagnostics: all opponents defeated.' });
    },
    setAllyAway(away) {
      const state = get();
      if (state.allyAway === away) return;
      set({ allyAway: away, message: away ? `${who('ally')} lost the connection. Their turns are skipped until they return.` : `${who('ally')} is back.` });
      if (away && !remote && state.activeId === 'ally' && !state.pending) get().endTurn();
    },
    cancelCast() {
      const pending = get().pending;
      if (remote) return;
      if (pending) restoreStance(pending);
      set({ pending: null, feedback: [] });
    },
    reset(encounterId = get().encounterId, coop = encounterId === 'knight' && get().coop) {
      useDefense.getState().clear();
      get().cancelCast();
      set({ encounterId, coop, allyAway: false, threat: NO_THREAT, fieldTurns: 0, opponents: initialOpponents(encounterId, coop), enemyTurn: null, activeId: 'player', turnNumber: 1, status: 'active',
        discoveredSpells: [...STARTER_SPELLS], hintedSpellId: 'fire-lance', lastDiscovered: null,
        pending: null, feedback: [], playerDefense: null, allyDefense: null, message: 'Choose a spell and weave its ritual.' });
    },
  };
});
