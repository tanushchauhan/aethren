import { useState } from 'react';

interface TaleArtProps {
  src?: string;
  alt: string;
  variant: 'cover' | 'monster' | 'boss';
}

export function TaleArt({ src, alt, variant }: TaleArtProps) {
  const [failed, setFailed] = useState(false);
  const showImage = typeof src === 'string' && src.length > 0 && !failed;
  if (showImage) {
    return <img className="ouam-art" src={src} alt={alt} onError={() => setFailed(true)} />;
  }
  if (variant === 'monster') return <MonsterArt label={alt} />;
  if (variant === 'boss') return <BossArt label={alt} />;
  return <CoverArt label={alt} />;
}

function CoverArt({ label }: { label: string }) {
  return (
    <svg className="ouam-art" role="img" aria-label={label} viewBox="0 0 360 240">
      <rect width="360" height="240" fill="#1b140e" />
      <circle cx="274" cy="54" r="28" fill="#f4e2a8" />
      <path d="M36 196 L92 86 L148 196 Z" fill="#243024" />
      <path d="M104 208 L176 64 L248 208 Z" fill="#1c2a1e" />
      <path d="M214 198 L270 108 L326 198 Z" fill="#314233" />
      <path d="M0 198 C90 168 150 214 210 186 C270 160 310 198 360 176 L360 240 L0 240 Z" fill="#3b2a18" />
      <path d="M168 236 C172 188 196 156 184 118" fill="none" stroke="#e0b341" strokeWidth="4" />
      <rect x="146" y="148" width="52" height="36" rx="2" fill="#f4e6c4" stroke="#e0b341" />
      <path d="M172 148 V184" stroke="#8d6a2f" />
    </svg>
  );
}

function MonsterArt({ label }: { label: string }) {
  return (
    <svg className="ouam-art" role="img" aria-label={label} viewBox="0 0 360 240">
      <rect width="360" height="240" fill="#142028" />
      <ellipse cx="176" cy="150" rx="96" ry="48" fill="#24343c" />
      <circle cx="262" cy="118" r="38" fill="#2c4148" />
      <circle cx="276" cy="112" r="8" fill="var(--ouam-frost)" />
      <path d="M40 168 C70 120 90 150 110 132" fill="none" stroke="var(--ouam-frost)" strokeWidth="3" />
      <path d="M118 176 L78 214 M156 190 L136 224 M214 188 L236 222" fill="none" stroke="#10181c" strokeWidth="8" />
      <path d="M248 96 L262 78 L270 98" fill="#d7e7ea" />
    </svg>
  );
}

function BossArt({ label }: { label: string }) {
  return (
    <svg className="ouam-art" role="img" aria-label={label} viewBox="0 0 360 240">
      <rect width="360" height="240" fill="#2a140e" />
      <polygon points="132,92 146,52 164,86 180,40 196,86 214,52 228,92" fill="#e0b341" />
      <rect x="118" y="108" width="124" height="82" rx="4" fill="#f4e6c4" stroke="#e0b341" strokeWidth="4" />
      <path d="M180 108 V190" stroke="#8d6a2f" strokeWidth="2" />
      <circle cx="180" cy="78" r="8" fill="var(--ouam-ember)" />
      <path d="M70 190 C110 160 150 200 180 176 C220 146 260 196 310 168" fill="none" stroke="var(--ouam-bloom)" strokeWidth="3" />
    </svg>
  );
}
