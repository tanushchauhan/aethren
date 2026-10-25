/**
 * Original placeholder art (simple storybook SVGs) shown until, or instead of, Muse Image.
 * Served at `GET /api/placeholder/:kind.svg`.
 */
import type { WorldImage } from '@once-upon/shared';

type Kind = WorldImage['kind'];

const PAPER = `
  <defs>
    <radialGradient id="glow" cx="50%" cy="38%" r="65%">
      <stop offset="0" stop-color="#FFF4D6"/>
      <stop offset="1" stop-color="#E9D3A6"/>
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>
  </defs>
  <rect width="512" height="512" fill="url(#glow)"/>
  <rect x="14" y="14" width="484" height="484" rx="18" fill="none" stroke="#7A5230" stroke-width="4" stroke-dasharray="2 10" stroke-linecap="round"/>`;

const TREES = `
  <g fill="#3B5D45" opacity="0.85">
    <path d="M40 470 L82 300 L124 470 Z"/><path d="M96 470 L140 250 L184 470 Z"/>
    <path d="M330 470 L376 260 L422 470 Z"/><path d="M398 470 L440 320 L482 470 Z"/>
  </g>
  <path d="M0 470 Q256 430 512 470 L512 512 L0 512 Z" fill="#5C7F4F"/>`;

const SVGS: Record<Kind, string> = {
  cover: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="An open storybook under the moon">
  ${PAPER}
  <circle cx="380" cy="120" r="54" fill="#FFF9E8" stroke="#E8C77A" stroke-width="6"/>
  <circle cx="402" cy="106" r="46" fill="#F6E7C1"/>
  <g fill="#FFD60A"><circle cx="120" cy="90" r="5"/><circle cx="180" cy="140" r="3.5"/><circle cx="260" cy="70" r="4"/><circle cx="300" cy="180" r="3"/></g>
  ${TREES}
  <g transform="translate(256 360)">
    <path d="M-170 0 Q-85 -46 0 -10 Q85 -46 170 0 L170 70 Q85 30 0 66 Q-85 30 -170 70 Z" fill="#FFFDF6" stroke="#7A5230" stroke-width="5" stroke-linejoin="round"/>
    <path d="M0 -10 L0 66" stroke="#7A5230" stroke-width="4"/>
    <g stroke="#B08A5A" stroke-width="3" stroke-linecap="round">
      <path d="M-140 10 Q-80 -14 -24 6"/><path d="M-140 30 Q-80 6 -24 26"/>
      <path d="M24 6 Q80 -14 140 10"/><path d="M24 26 Q80 6 140 30"/>
    </g>
    <g fill="#E85D04" opacity="0.9"><path d="M-6 -30 q6 -26 12 0 q-6 10 -12 0Z"/></g>
    <g fill="#FFD60A"><circle cx="-60" cy="-70" r="4"/><circle cx="40" cy="-90" r="3"/><circle cx="90" cy="-60" r="4.5"/></g>
  </g>
</svg>`,
  monster: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="A shadowy forest creature with glowing eyes">
  ${PAPER}
  ${TREES}
  <g transform="translate(256 300)">
    <ellipse cx="0" cy="150" rx="150" ry="18" fill="#2B2A33" opacity="0.25"/>
    <path d="M-130 140 Q-150 20 -80 -40 Q-40 -110 0 -120 Q40 -110 80 -40 Q150 20 130 140 Q90 120 60 140 Q30 118 0 140 Q-30 118 -60 140 Q-90 120 -130 140 Z" fill="#4A3F5C" stroke="#2B2A33" stroke-width="6" stroke-linejoin="round"/>
    <path d="M-70 -70 L-96 -140 L-40 -96 Z M70 -70 L96 -140 L40 -96 Z" fill="#4A3F5C" stroke="#2B2A33" stroke-width="6" stroke-linejoin="round"/>
    <ellipse cx="-40" cy="-30" rx="22" ry="16" fill="#FFD60A"/><ellipse cx="40" cy="-30" rx="22" ry="16" fill="#FFD60A"/>
    <circle cx="-36" cy="-30" r="7" fill="#2B2A33"/><circle cx="44" cy="-30" r="7" fill="#2B2A33"/>
    <path d="M-40 30 Q0 60 40 30" fill="none" stroke="#FFF4D6" stroke-width="6" stroke-linecap="round"/>
    <path d="M-24 36 l6 14 l6 -12 M12 38 l6 12 l6 -14" fill="#FFF4D6"/>
  </g>
</svg>`,
  boss: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="A towering crowned shadow behind a shimmering ward">
  ${PAPER}
  <g fill="#3A0CA3" opacity="0.12"><circle cx="256" cy="250" r="220"/></g>
  <g transform="translate(256 290)">
    <path d="M-150 200 Q-170 40 -90 -60 Q-60 -150 0 -170 Q60 -150 90 -60 Q170 40 150 200 Z" fill="#2E2645" stroke="#16121F" stroke-width="7" stroke-linejoin="round"/>
    <path d="M-70 -150 L-50 -215 L-20 -170 L0 -235 L20 -170 L50 -215 L70 -150 Z" fill="#FFD60A" stroke="#7A5230" stroke-width="5" stroke-linejoin="round"/>
    <circle cx="0" cy="-200" r="8" fill="#E85D04"/>
    <path d="M-60 -70 Q-36 -92 -12 -70 M12 -70 Q36 -92 60 -70" fill="none" stroke="#4CC9F0" stroke-width="9" stroke-linecap="round"/>
    <path d="M-120 60 Q-170 0 -200 30 M120 60 Q170 0 200 30" fill="none" stroke="#2E2645" stroke-width="22" stroke-linecap="round"/>
  </g>
  <g fill="none" stroke="#CDB4DB" stroke-width="5" opacity="0.9">
    <path d="M70 470 A200 200 0 0 1 442 470" stroke-dasharray="14 10"/>
    <path d="M110 470 A160 160 0 0 1 402 470" opacity="0.6"/>
  </g>
  <g fill="#FFD60A"><circle cx="90" cy="110" r="4"/><circle cx="430" cy="90" r="5"/><circle cx="460" cy="200" r="3"/><circle cx="60" cy="230" r="3.5"/></g>
</svg>`,
};

export const IMAGE_KINDS: Kind[] = ['cover', 'monster', 'boss'];

export function placeholderSvg(kind: string): string | null {
  return (IMAGE_KINDS as string[]).includes(kind) ? SVGS[kind as Kind] : null;
}

export function placeholderUrl(kind: Kind): string {
  return `/api/placeholder/${kind}.svg`;
}
