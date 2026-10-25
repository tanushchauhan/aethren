import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cueForMove, useDefense } from './defense';
import { useSpellBattle } from './spellBattle';
import { playerStore } from './playerState';
import { classifyDodgeAndPose, computeCalibrationBaseline } from '../vision/poseClassifiers';
import { sampleSyntheticPose } from '../vision/syntheticPoseGenerator';
const defense = () => useDefense.getState();
const battle = () => useSpellBattle.getState();
const baseline = computeCalibrationBaseline([sampleSyntheticPose('standing_in_zone', 0, { breathe: false })], 0)!;
const pose = (preset: Parameters<typeof sampleSyntheticPose>[0]) => classifyDodgeAndPose(sampleSyntheticPose(preset, 0, { breathe: false }), baseline);
beforeEach(() => { defense().setEnabled(false); defense().clear(); playerStore.getState().reset(); battle().reset('knight'); });
afterEach(() => { vi.restoreAllMocks(); defense().setEnabled(false); defense().clear(); });
function hold(preset: Parameters<typeof sampleSyntheticPose>[0]) { defense().sample(pose(preset), 1000); defense().sample(pose(preset), 1150); }
describe('camera defense', () => {
  it('keeps ring progress scoped to the current attack and clamps media time', () => {
    defense().begin(1, 'dark-slash', 0);
    defense().setProgress(1, .7); expect(defense().progress).toBe(.7);
    defense().setProgress(2, 1); expect(defense().progress).toBe(.7);
    defense().setProgress(1, 2); expect(defense().progress).toBe(1);
    defense().begin(2, 'dark-slash', 0); expect(defense().progress).toBe(0);
  });
  it('varies dodge cues but keeps aura attacks blockable and buffs cue-free', () => {
    expect([0,.4,.9].map(roll => cueForMove('dark-slash', roll))).toEqual(['left','right','duck']);
    expect(cueForMove('jaw-grab', .9)).toBe('right');
    expect(cueForMove('aura-flash')).toBe('block');
    expect(cueForMove('scorn-inferno')).toBe('block');
    expect(cueForMove('roar')).toBeNull(); expect(cueForMove('rest')).toBeNull();
  });
  it('uses real classifier output and requires the indicated direction', () => {
    defense().setEnabled(true); defense().begin(1, 'dark-slash', 0);
    hold('side_step_left'); expect(defense().resolve(1, 100, 1150)).toBe('dodged');
    defense().begin(2, 'dark-slash', .4); hold('side_step_left');
    expect(defense().resolve(2, 100, 1150)).toBe('hit');
    defense().begin(3, 'dark-slash', .9); hold('duck');
    expect(defense().resolve(3, 100, 1150)).toBe('dodged');
  });
  it('rejects disabled, stale, low-confidence, short and missing pose evidence', () => {
    defense().begin(1, 'dark-slash', 0); hold('side_step_left'); expect(defense().resolve(1,100,1150)).toBe('hit');
    defense().setEnabled(true); defense().begin(2,'dark-slash',0); hold('side_step_left'); expect(defense().resolve(2,100,1500)).toBe('hit');
    defense().begin(3,'dark-slash',0); defense().sample(pose('side_step_left'),1000); expect(defense().resolve(3,100,1050)).toBe('hit');
    defense().begin(4,'dark-slash',0); hold('side_step_left'); defense().sample(null,1150); expect(defense().resolve(4,100,1150)).toBe('hit');
    defense().begin(5,'dark-slash',0); defense().sample({...pose('side_step_left'),confidence:.2},1000); defense().sample({...pose('side_step_left'),confidence:.2},1150); expect(defense().resolve(5,100,1150)).toBe('hit');
  });
  it('blocks with a raised arm, but not a grab or while staggered', () => {
    const raised = {...pose('standing_in_zone'),isRightArmRaised:true};
    defense().setEnabled(true);
    for (const [id, move, stance, expected] of [[1,'aura-flash',100,'blocked'],[2,'jaw-grab',100,'hit'],[3,'dark-slash',20,'hit']] as const) {
      defense().begin(id,move,0); defense().sample(raised,1000); defense().sample(raised,1150);
      expect(defense().resolve(id,stance,1150)).toBe(expected);
    }
  });
  it('dodges the actual engine impact and duplicate/fallback callbacks do not damage again', () => {
    vi.spyOn(Math,'random').mockReturnValue(0); vi.spyOn(performance,'now').mockReturnValue(1150);
    defense().setEnabled(true); battle().endTurn(); battle().beginEnemy();
    const id = battle().enemyTurn!.action!.id;
    hold('side_step_left'); battle().enemyStep('play',id); battle().enemyStep('impact',id); battle().enemyStep('impact',id); battle().enemyStep('return',id);
    expect(playerStore.getState()).toMatchObject({health:100,stanceValue:100,statuses:[]});
    expect(defense().result).toBe('dodged');
  });
  it('reduces actual boss damage and stance damage and prevents attached curse on block', () => {
    vi.spyOn(performance,'now').mockReturnValue(1150);
    defense().setEnabled(true); battle().endTurn(); battle().beginEnemy();
    const id = battle().enemyTurn!.action!.id;
    const raised = {...pose('standing_in_zone'),isRightArmRaised:true};
    defense().sample(raised,1000); defense().sample(raised,1150);
    battle().enemyStep('play',id); battle().enemyStep('return',id);
    expect(playerStore.getState()).toMatchObject({health:97,stanceValue:87,statuses:[]});
    expect(defense().result).toBe('blocked');
  });
  it('continues normal damage without a camera and clears defense on retry', () => {
    battle().endTurn(); battle().beginEnemy(); const id=battle().enemyTurn!.action!.id;
    battle().enemyStep('play',id); battle().enemyStep('impact',id);
    expect(playerStore.getState().health).toBe(86);
    battle().reset(); expect(defense().cue).toBeNull(); expect(defense().actionId).toBeNull();
  });
});

it('combines a camera block and glove parry without double damage', () => {
  vi.spyOn(performance,'now').mockReturnValue(1150);
  defense().setEnabled(true); battle().endTurn(); battle().beginEnemy();
  const id = battle().enemyTurn!.action!.id;
  const raised = {...pose('standing_in_zone'),isRightArmRaised:true};
  defense().sample(raised,1000); defense().sample(raised,1150);
  battle().triggerDefense('parry', 'Glove Ward');
  battle().enemyStep('play',id); battle().enemyStep('impact',id); battle().enemyStep('return',id);
  expect(playerStore.getState()).toMatchObject({health:97,stanceValue:87,statuses:[]});
  expect(battle().opponents.knight.hp).toBeLessThan(240);
  expect(battle().playerDefense).toBeNull();
});
it('lets a successful camera dodge take precedence over a simultaneous glove parry', () => {
  vi.spyOn(Math,'random').mockReturnValue(0); vi.spyOn(performance,'now').mockReturnValue(1150);
  defense().setEnabled(true); battle().endTurn(); battle().beginEnemy();
  const id = battle().enemyTurn!.action!.id;
  hold('side_step_left'); battle().triggerDefense('parry', 'Glove Ward');
  battle().enemyStep('play',id); battle().enemyStep('impact',id);
  expect(playerStore.getState().health).toBe(100);
  expect(battle().opponents.knight.hp).toBe(240);
  expect(battle().playerDefense).toBeNull();
});
