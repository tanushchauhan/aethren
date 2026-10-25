import { useWolfTutorial, type TutorialStep } from '../../combat/wolfTutorial';
import './combat-tutorial.css';

export type CombatTutorialKind = TutorialStep;

export interface CombatTutorialKey {
  label: string;
  action: string;
}

export interface CombatTutorialOverlayProps {
  kind: CombatTutorialKind;
  title: string;
  lines: string[];
  keys?: CombatTutorialKey[];
  step?: number;
  totalSteps?: number;
  continueLabel?: string;
  onContinue?: () => void;
  onSkip?: () => void;
  onSkipAll?: () => void;
}

const STEP_CONFIG: Record<TutorialStep, {
  step: number;
  title: string;
  badge: string;
  lines: string[];
  requirement: string;
  keys: CombatTutorialKey[];
}> = {
  dial: {
    step: 1,
    badge: 'GLOVE TRAINING',
    title: 'Spin the Spell Wheel',
    lines: [
      'Your Spell Wheel holds 12 spells across 3 elements: Fire, Frost, and Storm.',
      'Twist the physical Rotary Dial on your glove to sweep the golden pointer around the wheel.',
    ],
    requirement: '◆ Turn [Dial] on your glove (or press ← / →) to continue',
    keys: [
      { label: 'Dial', action: 'Rotate knob to pick any spell' },
      { label: '← / →', action: 'Keyboard fallback' },
    ],
  },
  element: {
    step: 2,
    badge: 'GLOVE TRAINING',
    title: 'Jump Elements & Rest',
    lines: [
      'Tap [B2] to leap straight to the next Element sector (Fire → Frost → Storm).',
      'When your Magic Power runs low later in battle, HOLD [B2] to Rest (+3 MP & +45 Stance).',
    ],
    requirement: '◆ Tap [B2] on your glove (or press E) to jump elements',
    keys: [
      { label: 'B2', action: 'Jump to next Element arc' },
      { label: 'Hold B2', action: 'Rest (+3 MP & Stance)' },
    ],
  },
  target: {
    step: 3,
    badge: 'GLOVE TRAINING',
    title: 'Lock Onto Your Target',
    lines: [
      'Three wolves stand before you in the clearing.',
      'Tap the [T] Touch Sensor pad on your glove to cycle which wolf your spell will strike.',
    ],
    requirement: '◆ Tap [T] Touch Sensor (or press T / Tab) to switch target wolf',
    keys: [
      { label: 'T', action: 'Cycle targeted wolf' },
      { label: 'Tab', action: 'Keyboard fallback' },
    ],
  },
  cast: {
    step: 4,
    badge: 'GLOVE TRAINING',
    title: 'Unleash Your Spell',
    lines: [
      'Press [B1] to cast — or SWING your glove forward to unleash the spell with up to 1.45× bonus kinetic power!',
      'Turns switch automatically right after your spell lands.',
    ],
    requirement: '◆ Press [B1] or SWING your glove to cast your first spell!',
    keys: [
      { label: 'B1', action: 'Cast selected spell' },
      { label: 'Swing', action: 'Cast with kinetic power boost' },
    ],
  },
  parry: {
    step: 5,
    badge: '⏸ FREEZE FRAME · WOLF MID-ATTACK!',
    title: 'Parry or Dodge Now!',
    lines: [
      'The wolf is mid-leap! Time is frozen just before impact.',
      'SHAKE your glove or press [T] / [B2] right now to raise your Glove Ward — halving damage and reflecting 4 damage back!',
    ],
    requirement: '◆ SHAKE Glove or Press [T] / [B2] NOW to Parry the attack!',
    keys: [
      { label: 'Shake Glove', action: 'Raise Glove Ward & reflect 4 DMG' },
      { label: 'T / B2', action: 'Instant Parry Ward' },
      { label: 'Camera', action: 'Or Duck / Side-step to Dodge' },
    ],
  },
};

/** Looping SVG/CSS animated "GIF-style" visual demonstration for each glove mechanic. */
function TutorialDemo({ kind }: { kind: CombatTutorialKind }) {
  if (kind === 'dial') {
    return (
      <div className="ct-demo ct-demo-wheel" aria-hidden="true">
        <div className="ct-demo-tag">LIVE DEMO · ROTARY DIAL → SPELL WHEEL</div>
        <svg viewBox="0 0 380 140" className="ct-svg">
          {/* Physical Rotary Dial Knob on the left */}
          <g transform="translate(88, 74)">
            <circle r="40" fill="#09161e" stroke="#6e5a35" strokeWidth="2" />
            <circle r="33" fill="none" stroke="#c9b88355" strokeWidth="1.5" strokeDasharray="4 4" />
            <path d="M -34 -22 A 42 42 0 0 1 34 -22" fill="none" stroke="#ffe5ad" strokeWidth="2" strokeDasharray="3 3" />
            <g className="ct-anim-knob">
              <circle r="24" fill="#132832" stroke="#ffe5ad" strokeWidth="2.5" />
              <line x1="0" y1="0" x2="0" y2="-20" stroke="#ffe5ad" strokeWidth="3.5" strokeLinecap="round" />
              <circle cx="0" cy="-14" r="3" fill="#ff8a3d" />
            </g>
            <text y="54" textAnchor="middle" fill="#ffe5ad" fontSize="13">GLOVE DIAL</text>
          </g>

          {/* Animated energy脉冲 arrow connecting Knob -> Spell Wheel */}
          <g transform="translate(155, 74)" className="ct-anim-pulse">
            <line x1="-12" y1="0" x2="32" y2="0" stroke="#ffe5ad" strokeWidth="2" strokeDasharray="4 4" />
            <polygon points="36,0 26,-5 26,5" fill="#ffe5ad" />
          </g>

          {/* Mini 12-wedge Spell Wheel on the right */}
          <g transform="translate(275, 74)">
            <circle r="48" fill="#08141b" stroke="#a8844a" strokeWidth="2" />
            {/* 3 Element Arcs: Fire, Frost, Storm */}
            <path d="M 0 -46 A 46 46 0 0 1 39.8 23" fill="none" stroke="#ff8a3d" strokeWidth="5" />
            <path d="M 39.8 23 A 46 46 0 0 1 -39.8 23" fill="none" stroke="#7fd8ff" strokeWidth="5" />
            <path d="M -39.8 23 A 46 46 0 0 1 0 -46" fill="none" stroke="#c49bff" strokeWidth="5" />
            {Array.from({ length: 12 }, (_, i) => {
              const a = (i * 30 - 90) * (Math.PI / 180);
              return <circle key={i} cx={Math.cos(a) * 33} cy={Math.sin(a) * 33} r="4.5" fill={i < 4 ? '#ff8a3d88' : i < 8 ? '#7fd8ff88' : '#c49bff88'} />;
            })}
            <g className="ct-anim-knob">
              <line x1="0" y1="0" x2="0" y2="-32" stroke="#ffd479" strokeWidth="3" />
              <circle cx="0" cy="-33" r="7" fill="none" stroke="#fff3c4" strokeWidth="2" />
            </g>
            <circle r="15" fill="#10232c" stroke="#c9b883" strokeWidth="1.5" />
            <text y="4" textAnchor="middle" fill="#ffe5ad" fontSize="10">12</text>
            <text y="54" textAnchor="middle" fill="#c1ccbf" fontSize="12">RADIAL WHEEL</text>
          </g>
        </svg>
      </div>
    );
  }

  if (kind === 'element') {
    return (
      <div className="ct-demo ct-demo-menu" aria-hidden="true">
        <div className="ct-demo-tag">LIVE DEMO · TAP [B2] ELEMENT · HOLD [B2] REST</div>
        <svg viewBox="0 0 380 140" className="ct-svg">
          {/* B2 Button Tap Animation */}
          <g transform="translate(82, 68)">
            <rect x="-36" y="-26" width="72" height="52" rx="6" fill="#0b1922" stroke="#c9b883" strokeWidth="2" />
            <g className="ct-anim-tap">
              <rect x="-24" y="-16" width="48" height="32" rx="4" fill="#ffe5ad" stroke="#9f8c63" strokeWidth="2" />
              <text y="5" textAnchor="middle" fill="#0b1922" fontSize="16" fontWeight="bold">B2</text>
            </g>
            <text y="44" textAnchor="middle" fill="#ffe5ad" fontSize="12">TAP: ELEMENT</text>
            <text y="58" textAnchor="middle" fill="#9fb5b0" fontSize="11">HOLD: +3 MP REST</text>
          </g>

          {/* Jumping Elemental Sectors */}
          <g transform="translate(248, 72)">
            <g className="ct-el-card ct-el-fire" transform="translate(-82, 0)">
              <rect x="-34" y="-28" width="68" height="56" rx="4" fill="#26140c" stroke="#ff8a3d" strokeWidth="2" />
              <text y="-4" textAnchor="middle" fill="#ff8a3d" fontSize="15">◆ FIRE</text>
              <text y="14" textAnchor="middle" fill="#f5cbb0" fontSize="11">4 Spells</text>
            </g>
            <g className="ct-el-card ct-el-frost" transform="translate(0, 0)">
              <rect x="-34" y="-28" width="68" height="56" rx="4" fill="#0b222e" stroke="#7fd8ff" strokeWidth="2" />
              <text y="-4" textAnchor="middle" fill="#7fd8ff" fontSize="15">❖ FROST</text>
              <text y="14" textAnchor="middle" fill="#c4eeff" fontSize="11">4 Spells</text>
            </g>
            <g className="ct-el-card ct-el-storm" transform="translate(82, 0)">
              <rect x="-34" y="-28" width="68" height="56" rx="4" fill="#1d142c" stroke="#c49bff" strokeWidth="2" />
              <text y="-4" textAnchor="middle" fill="#c49bff" fontSize="15">✦ STORM</text>
              <text y="14" textAnchor="middle" fill="#e5d4ff" fontSize="11">4 Spells</text>
            </g>
          </g>
        </svg>
      </div>
    );
  }

  if (kind === 'target') {
    return (
      <div className="ct-demo ct-demo-target" aria-hidden="true">
        <div className="ct-demo-tag">LIVE DEMO · TAP [T] TOUCH PAD → SWITCH WOLF</div>
        <svg viewBox="0 0 380 140" className="ct-svg">
          {/* Touch Sensor Pad */}
          <g transform="translate(68, 74)">
            <circle r="32" fill="#0b1922" stroke="#7fd8ff" strokeWidth="2" />
            <circle r="22" className="ct-anim-touch-ring" fill="#7fd8ff22" stroke="#ffe5ad" strokeWidth="2" />
            <text y="5" textAnchor="middle" fill="#ffe5ad" fontSize="18">T</text>
            <text y="48" textAnchor="middle" fill="#ffe5ad" fontSize="12">TOUCH SENSOR</text>
          </g>

          {/* 3 Wolf Silhouettes with Hopping Reticle */}
          <g transform="translate(245, 76)">
            {[
              { x: -75, label: 'LEFT WOLF' },
              { x: 0, label: 'LEADER' },
              { x: 75, label: 'RIGHT WOLF' },
            ].map((w, idx) => (
              <g key={w.label} transform={`translate(${w.x}, 0)`}>
                <polygon points="-18,16 -14,-14 -6,-4 0,-18 6,-4 14,-14 18,16" fill="#1b313a" stroke="#8aa09a" strokeWidth="1.5" />
                <circle cx="-5" cy="-2" r="2" fill="#ff6a4d" />
                <circle cx="5" cy="-2" r="2" fill="#ff6a4d" />
                <text y="34" textAnchor="middle" fill="#9fb5b0" fontSize="10">{w.label}</text>
                <g className={`ct-reticle ct-reticle-${idx}`}>
                  <circle r="24" fill="none" stroke="#ffe5ad" strokeWidth="2.5" strokeDasharray="6 3" />
                  <text y="-28" textAnchor="middle" fill="#ffe5ad" fontSize="11">◆ TARGET</text>
                </g>
              </g>
            ))}
          </g>
        </svg>
      </div>
    );
  }

  if (kind === 'cast') {
    return (
      <div className="ct-demo ct-demo-cast" aria-hidden="true">
        <div className="ct-demo-tag">LIVE DEMO · PRESS [B1] OR SWING GLOVE TO CAST</div>
        <svg viewBox="0 0 380 140" className="ct-svg">
          {/* Glove Swing + B1 button on left */}
          <g transform="translate(78, 76)" className="ct-anim-glove-swing">
            <rect x="-34" y="-22" width="68" height="44" rx="8" fill="#132832" stroke="#ff8a3d" strokeWidth="2.5" />
            <text y="-2" textAnchor="middle" fill="#ffe5ad" fontSize="14">B1 / SWING</text>
            <text y="14" textAnchor="middle" fill="#ff8a3d" fontSize="11">1.45× POWER</text>
          </g>

          {/* Blazing Spell Projectile flying across */}
          <g className="ct-anim-fireball" transform="translate(140, 76)">
            <circle r="14" fill="#ff8a3d" />
            <circle r="8" fill="#fff3c4" />
            <path d="M -12 -8 L -38 0 L -12 8 Z" fill="#ff6a2a99" />
          </g>

          {/* Target Wolf Impact on right */}
          <g transform="translate(310, 76)">
            <polygon points="-22,18 -16,-18 -6,-5 0,-22 6,-5 16,-18 22,18" fill="#2a161c" stroke="#ff8a3d" strokeWidth="2" />
            <circle r="28" className="ct-anim-impact-burst" fill="none" stroke="#ffe5ad" strokeWidth="3" />
            <text y="-32" textAnchor="middle" fill="#ffe5ad" fontSize="12" className="ct-anim-impact-burst">−18 DMG · AUTO TURN!</text>
          </g>
        </svg>
      </div>
    );
  }

  // Parry (Freeze-frame mid-attack demo)
  return (
    <div className="ct-demo ct-demo-parry" aria-hidden="true">
      <div className="ct-demo-tag">⏸ MID-ATTACK FREEZE · SHAKE GLOVE OR PRESS [T] / [B2]</div>
      <svg viewBox="0 0 380 140" className="ct-svg">
        {/* Lunging Wolf Claws on Left */}
        <g transform="translate(86, 76)" className="ct-anim-wolf-lunge">
          <polygon points="-26,20 -18,-20 -6,-6 4,-24 12,-6 24,-16 26,20" fill="#3a121a" stroke="#ff5a3c" strokeWidth="2" />
          <path d="M 30 -16 L 54 -4 M 32 0 L 58 10 M 28 14 L 52 24" stroke="#ffc4c9" strokeWidth="3" strokeLinecap="round" />
          <text y="38" textAnchor="middle" fill="#ff9688" fontSize="11">WOLF LUNGE</text>
        </g>

        {/* Glowing Runic Parry Shield in Center */}
        <g transform="translate(192, 74)" className="ct-anim-shield-flash">
          <polygon points="0,-38 32,-18 26,24 0,40 -26,24 -32,-18" fill="#0d2b36cc" stroke="#7fd8ff" strokeWidth="3" />
          <text y="-2" textAnchor="middle" fill="#ffe5ad" fontSize="13">◆ WARD</text>
          <text y="14" textAnchor="middle" fill="#9fffd4" fontSize="11">−50% DMG</text>
          <text y="-44" textAnchor="middle" fill="#ffe27a" fontSize="11">↩ REFLECT 4 DMG</text>
        </g>

        {/* Shaking Glove / T Button on Right */}
        <g transform="translate(304, 76)" className="ct-anim-glove-shake">
          <rect x="-38" y="-24" width="76" height="48" rx="8" fill="#142834" stroke="#ffe5ad" strokeWidth="2.5" />
          <text y="-3" textAnchor="middle" fill="#ffe5ad" fontSize="13">SHAKE GLOVE</text>
          <text y="14" textAnchor="middle" fill="#7fd8ff" fontSize="12">or TAP [T] / [B2]</text>
        </g>
      </svg>
    </div>
  );
}

export function CombatTutorialOverlay(props?: Partial<CombatTutorialOverlayProps>) {
  const { enabled, activeStep, notifyAction, skipStep, skipAll } = useWolfTutorial();
  const kind = props?.kind ?? activeStep;
  if (!kind || (!props?.kind && !enabled)) return null;

  const cfg = STEP_CONFIG[kind];
  const title = props?.title ?? cfg.title;
  const lines = props?.lines ?? cfg.lines;
  const keys = props?.keys ?? cfg.keys;
  const step = props?.step ?? cfg.step;
  const totalSteps = props?.totalSteps ?? 5;
  const handleContinue = props?.onContinue ?? (() => notifyAction(kind));
  const handleSkip = props?.onSkip ?? skipStep;
  const handleSkipAll = props?.onSkipAll ?? skipAll;

  return (
    <div className={`combat-tutorial ct-${kind}`} data-step={kind} role="dialog" aria-modal="false" aria-label={title}>
      <div className="ct-scanlines" aria-hidden="true" />
      <div className="ct-panel">
        <div className="ct-step">{cfg.badge} · STEP {step} / {totalSteps}</div>
        <h2 className="ct-title">{title}</h2>
        <TutorialDemo kind={kind} />
        <div className="ct-lines">
          {lines.map((line, i) => (
            <p key={i} style={{ '--i': i } as React.CSSProperties}>{line}</p>
          ))}
        </div>
        <p className="ct-requirement" role="status">{cfg.requirement}</p>
        {keys && keys.length > 0 && (
          <ul className="ct-keys">
            {keys.map(k => (
              <li key={k.label}>
                <kbd>{k.label}</kbd>
                <span>{k.action}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="ct-actions">
          <button type="button" className="ct-continue" onClick={handleContinue}>
            {props?.continueLabel ?? (kind === 'parry' ? 'Parry Now (T / B2)' : 'Next Lesson →')}
          </button>
          <button type="button" className="ct-skip" onClick={handleSkip}>Skip step</button>
          <button type="button" className="ct-skip" onClick={handleSkipAll}>Skip tutorial</button>
        </div>
      </div>
      {kind !== 'parry' && (
        <div className="ct-wheel-callout" aria-hidden="true">
          <span>▼ TRY IT ON THE SPELL WHEEL BELOW ▼</span>
        </div>
      )}
    </div>
  );
}
