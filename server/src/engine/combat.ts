/**
 * Pure combat rules: enemy HP, element effects, power clamps and boss-plan validation.
 * No timers or sockets here, so every rule is unit-tested directly.
 */
import {
  COMBAT,
  DEFENSE_WINDOW_MS,
  DIFFICULTY_HP_MULTIPLIER,
  ENEMY_TEMPLATES,
  P0_ELEMENTS,
  ROUND_TIMINGS_MS,
  TAUNT_MAX_CHARS,
  TIER_MULTIPLIERS,
  WARD_HP_RATIO,
} from '@once-upon/shared';
import type {
  AttackType,
  BossEffectName,
  BossPlan,
  BossSchema,
  ElementType,
  EncounterSchema,
  EncounterTemplate,
  P0ElementType,
  PoseActionType,
  QuestDifficulty,
} from '@once-upon/shared';

export type Enemy = EncounterSchema | BossSchema;

/** Attacks P0 clients know how to telegraph and judge. */
export const P0_ATTACKS: readonly AttackType[] = ['low_sweep', 'high_swing', 'projectile'];

/**
 * P0 HP tuning on top of template x tier x difficulty. With two casts of about 10 damage per
 * round, a tier-1 encounter (charger 60 x 1.25 = 75) lasts about 4 rounds; the boss
 * (guardian 80 x tier 3 = 160) lasts about 5 rounds including one warded round.
 */
export const HP_SCALE = { encounter: 1.25, boss: 1 } as const;

/** Share of `COMBAT.baseSpellDamage` each P0 element deals. Bloom heals instead. */
export const ELEMENT_DAMAGE: Record<P0ElementType, number> = { ember: 1, frost: 0.6, bloom: 0 };

/** Damage multiplier when the element matches the enemy's weakness. */
export const WEAKNESS_MULTIPLIER = 1.5;

/** Extra defense window (ms) on the round after a Frost cast lands. */
export const FROST_WINDOW_BONUS_MS = 500;

export const MAX_POWER = 2;

/** Telegraph wind-up stays readable even for fast templates. */
export const TELEGRAPH_MS = { min: 1200, max: 3000 } as const;

const TEMPLATES = Object.keys(ENEMY_TEMPLATES) as EncounterTemplate[];
const BOSS_EFFECTS: readonly BossEffectName[] = ['tick', 'cast', 'fizzle', 'hit', 'servo_open'];
const MAX_EFFECTS_PER_ROUND = 3;

export function isP0Element(value: unknown): value is P0ElementType {
  return typeof value === 'string' && (P0_ELEMENTS as readonly string[]).includes(value);
}

export function templateOf(enemy: Enemy): EncounterTemplate {
  return TEMPLATES.includes(enemy.template) ? enemy.template : 'charger';
}

function tierOf(enemy: Enemy, isBoss: boolean): 1 | 2 | 3 {
  if (isBoss) return 3;
  return enemy.tier === 2 || enemy.tier === 3 ? enemy.tier : 1;
}

export function enemyMaxHp(enemy: Enemy, isBoss: boolean, difficulty: QuestDifficulty): number {
  const base = ENEMY_TEMPLATES[templateOf(enemy)].baseHp;
  const tier = TIER_MULTIPLIERS[tierOf(enemy, isBoss)].hp;
  const diff = DIFFICULTY_HP_MULTIPLIER[difficulty] ?? 1;
  const scale = isBoss ? HP_SCALE.boss : HP_SCALE.encounter;
  return Math.max(1, Math.round(base * tier * diff * scale));
}

/** The enemy's attacks that P0 supports, or its template's scripted cycle. */
export function enemyAttacks(enemy: Enemy): AttackType[] {
  const own = (Array.isArray(enemy.attacks) ? enemy.attacks : []).filter((a) => P0_ATTACKS.includes(a));
  const unique = [...new Set(own)];
  if (unique.length > 0) return unique;
  return ENEMY_TEMPLATES[templateOf(enemy)].defaultAttacks.filter((a) => P0_ATTACKS.includes(a));
}

/** Telegraph wind-up: faster templates and higher tiers wind up quicker. */
export function telegraphMs(enemy: Enemy, isBoss: boolean): number {
  const speed =
    ENEMY_TEMPLATES[templateOf(enemy)].attackSpeed * TIER_MULTIPLIERS[tierOf(enemy, isBoss)].attackSpeed;
  const ms = ROUND_TIMINGS_MS.telegraph / (speed > 0 ? speed : 1);
  return Math.round(Math.min(TELEGRAPH_MS.max, Math.max(TELEGRAPH_MS.min, ms)));
}

export function clampPower(power: unknown): number {
  const n = typeof power === 'number' && Number.isFinite(power) ? power : 1;
  return Math.min(MAX_POWER, Math.max(0, n));
}

export function clampDefenseWindow(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFENSE_WINDOW_MS.default;
  return Math.round(Math.min(DEFENSE_WINDOW_MS.max, Math.max(DEFENSE_WINDOW_MS.min, n)));
}

export interface SpellEffect {
  damage: number;
  heal: number;
  weaknessHit: boolean;
}

/**
 * One cast's effect before the ward is considered.
 * Ember: base x power. Frost: 0.6 x base x power (plus the next-round window bonus).
 * Bloom: heals `COMBAT.bloomHeal`. Weakness x1.5; a Twin Cast pair doubles both damage and heal.
 */
export function spellEffect(
  element: P0ElementType,
  power: number,
  weakness: ElementType | null | undefined,
  opts: { twin?: boolean } = {},
): SpellEffect {
  const p = clampPower(power);
  const twin = opts.twin ? COMBAT.twinCastMultiplier : 1;
  const weaknessHit = weakness === element;
  const raw =
    COMBAT.baseSpellDamage * ELEMENT_DAMAGE[element] * p * (weaknessHit ? WEAKNESS_MULTIPLIER : 1) * twin;
  const heal = element === 'bloom' && p > 0 ? COMBAT.bloomHeal * twin : 0;
  return { damage: Math.round(raw), heal, weaknessHit };
}

export interface WardContext {
  isBoss: boolean;
  enemyHp: number;
  enemyMaxHp: number;
  wardActive: boolean;
  wardRaisedThisPhase: boolean;
}

/** Ward may rise: boss only, at or below `WARD_HP_RATIO` of max HP, once per boss fight. */
export function wardEligible(ctx: WardContext): boolean {
  return (
    ctx.isBoss &&
    !ctx.wardActive &&
    !ctx.wardRaisedThisPhase &&
    ctx.enemyHp > 0 &&
    ctx.enemyHp <= ctx.enemyMaxHp * WARD_HP_RATIO
  );
}

export interface PlanContext extends WardContext {
  enemy: Enemy;
  playerIds: string[];
  roundIndex: number;
}

/** Engine-side scripted cycle, used when the planner is late, throws or returns garbage. */
export function scriptedPlan(ctx: PlanContext): BossPlan {
  const attacks = enemyAttacks(ctx.enemy);
  const attackType = attacks[ctx.roundIndex % attacks.length] ?? 'low_sweep';
  const ids = ctx.playerIds;
  return {
    attackType,
    targetPlayerIds: ids.length > 0 ? [ids[ctx.roundIndex % ids.length]!] : [],
    defenseWindowMs: DEFENSE_WINDOW_MS.default,
    raiseWard: wardEligible(ctx),
    taunt: null,
    effects: [],
    source: 'scripted',
  };
}

/**
 * Re-checks a plan against the rules, whatever the planner promised:
 * attack in the enemy's (P0) attacks, real targets, window inside `DEFENSE_WINDOW_MS`,
 * ward only when eligible, taunt at most `TAUNT_MAX_CHARS`, effects from the fixed list.
 */
export function sanitizePlan(plan: Partial<BossPlan> | null | undefined, ctx: PlanContext): BossPlan {
  const fallback = scriptedPlan(ctx);
  if (!plan || typeof plan !== 'object') return fallback;

  const attacks = enemyAttacks(ctx.enemy);
  const attackType =
    plan.attackType && attacks.includes(plan.attackType) ? plan.attackType : fallback.attackType;

  const valid = new Set(ctx.playerIds);
  const targets = [
    ...new Set((Array.isArray(plan.targetPlayerIds) ? plan.targetPlayerIds : []).filter((id) => valid.has(id))),
  ];

  const taunt =
    typeof plan.taunt === 'string' && plan.taunt.trim() !== ''
      ? truncate(plan.taunt.trim(), TAUNT_MAX_CHARS)
      : null;

  const effects = [
    ...new Set((Array.isArray(plan.effects) ? plan.effects : []).filter((e) => BOSS_EFFECTS.includes(e))),
  ].slice(0, MAX_EFFECTS_PER_ROUND);

  return {
    attackType,
    targetPlayerIds: targets.length > 0 ? targets : fallback.targetPlayerIds,
    defenseWindowMs: clampDefenseWindow(plan.defenseWindowMs),
    raiseWard: Boolean(plan.raiseWard) && wardEligible(ctx),
    taunt,
    effects,
    source: plan.source === 'agent' ? 'agent' : 'scripted',
  };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Which way a player dodged, from their latest pose action. */
export function dodgeDirection(action: PoseActionType | undefined): 'left' | 'right' | 'down' | null {
  switch (action) {
    case 'side_step_left':
      return 'left';
    case 'side_step_right':
      return 'right';
    case 'duck':
      return 'down';
    default:
      return null;
  }
}

const ATTACK_CUES: Record<AttackType, string> = {
  low_sweep: 'a low sweep! Step out of your zone!',
  high_swing: 'a high swing! Duck!',
  projectile: 'a projectile! Dodge it, or parry it back!',
  ground_wave: 'a ground wave! Jump!',
  stare: 'a stony stare! Freeze!',
};

/** Short, actionable telegraph hint: who is targeted and how to answer. */
export function telegraphHint(attackType: AttackType, targetNames: string[]): string {
  const who = targetNames.length > 0 ? targetNames.join(' and ') : 'Everyone';
  return `${who}, ${ATTACK_CUES[attackType] ?? 'watch out!'}`;
}
