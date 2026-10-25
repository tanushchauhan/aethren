import { useId, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { CalibrationBaseline, NormalizedLandmark } from '@once-upon/shared';
import { DUCK_THRESHOLD } from '@once-upon/shared';
import { getZoneBounds, resolveTorso } from '../../vision/poseClassifiers';
import type { DefenseCue, DefenseResult } from '../../combat/defense';

/** Fixed calibration-space mapping: moving the player must move the projection, not its camera. */
export function projectBodyPoint(point: Pick<NormalizedLandmark, 'x' | 'y'>, baseline: CalibrationBaseline) {
  const scale = 160 / Math.max(.045, baseline.shoulderWidth);
  return { x: 320 + (baseline.centerX - point.x) * scale, y: 170 + (point.y - baseline.shoulderY) * scale * .75 };
}
export function DefenseProjection({ landmarks, baseline, cue, progress, approaching, windupMs, result, tracking }: {
  landmarks: NormalizedLandmark[]; baseline: CalibrationBaseline; cue: DefenseCue; progress: number;
  approaching: boolean; windupMs: number; result: DefenseResult | null; tracking: boolean;
}) {
  const reduced = useReducedMotion();
  const stripeId = useId().replaceAll(':', '');
  const zone = getZoneBounds(baseline);
  const leftEdge = projectBodyPoint({ x: zone.maxX, y: baseline.shoulderY }, baseline).x;
  const rightEdge = projectBodyPoint({ x: zone.minX, y: baseline.shoulderY }, baseline).x;
  const duckLine = projectBodyPoint({ x: baseline.centerX, y: baseline.shoulderY + DUCK_THRESHOLD }, baseline).y;
  const point = (i: number) => projectBodyPoint(landmarks[i], baseline);
  const [targets] = useState(() => {
    if (cue === 'duck') return [point(0), point(11), point(12)];
    if (cue === 'block') return [point(11), point(12)];
    const lockedTorso = resolveTorso(landmarks);
    return lockedTorso ? [lockedTorso.leftShoulder, lockedTorso.rightShoulder, lockedTorso.leftHip, lockedTorso.rightHip].map(p => projectBodyPoint(p, baseline)) : [point(11), point(12)];
  });
  const torso = resolveTorso(landmarks);
  const body = torso ? [torso.leftShoulder, torso.rightShoulder, torso.rightHip, torso.leftHip].map(p => projectBodyPoint(p, baseline)) : [];
  const head = point(0);
  const links = [[11,13],[13,15],[12,14],[14,16]];
  const tint = result === 'dodged' || result === 'blocked' ? '#9fffd4' : '#ffc09a';
  return <svg className="defense-projection" viewBox="0 0 640 480" role="img" aria-label="Your projected body and incoming impact rings">
    <defs><pattern id={stripeId} patternUnits="userSpaceOnUse" width="16" height="16" patternTransform="rotate(35)"><rect width="16" height="16" fill="#df263518" /><rect width="3" height="16" fill="#ff46572e" /></pattern></defs>
    {cue !== 'block' && <g className="defense-danger-zone">
      <rect x={cue === 'left' ? leftEdge : 0} y="0" width={cue === 'left' ? 640-leftEdge : cue === 'right' ? rightEdge : 640} height={cue === 'duck' ? duckLine : 480} fill={`url(#${stripeId})`} />
      {cue === 'duck' ? <line x1="0" x2="640" y1={duckLine} y2={duckLine} /> : <line x1={cue === 'left' ? leftEdge : rightEdge} x2={cue === 'left' ? leftEdge : rightEdge} y1="0" y2="480" />}
      <text x="320" y="20" textAnchor="middle">{cue === 'duck' ? 'SHOULDER LINE BELOW THE RED LINE' : cue === 'left' ? '← ENTIRE TORSO PAST THE RED LINE' : 'ENTIRE TORSO PAST THE RED LINE →'}</text>
    </g>}
    <g className="projected-body" opacity={tracking ? 1 : .2}>
      {body.length > 0 && <polygon points={body.map(p => `${p.x},${p.y}`).join(' ')} />}
      <ellipse cx={head.x} cy={head.y} rx="29" ry="36" />
      {links.map(([a,b]) => (landmarks[a]?.visibility ?? 0) > .4 && (landmarks[b]?.visibility ?? 0) > .4 && <line key={`${a}-${b}`} x1={point(a).x} y1={point(a).y} x2={point(b).x} y2={point(b).y} />)}
      {[11,12,13,14,15,16].map(i => (landmarks[i]?.visibility ?? 0) > .4 && <circle key={i} cx={point(i).x} cy={point(i).y} r="7" />)}
    </g>
    {targets.map((p,i) => <g key={i} className="projected-impact" style={{ color:tint }}>
      <circle cx={p.x} cy={p.y} r="28" className="impact-target" />
      <motion.circle cx={p.x} cy={p.y} className="impact-approach" initial={{ r: reduced ? 28 : 84 }}
        animate={{ r: reduced || result ? 28 : approaching ? 56 : 28 * (2 - progress) }} transition={{ duration: reduced ? 0 : approaching ? windupMs / 1000 : .05, ease:'linear' }} />
      <text x={p.x} y={p.y + 6} textAnchor="middle">{result === 'dodged' || result === 'blocked' ? '✓' : i+1}</text>
    </g>)}
  </svg>;
}
