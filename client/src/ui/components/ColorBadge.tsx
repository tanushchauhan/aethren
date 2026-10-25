import { colorLabel, colorSwatch } from '../colors';

interface ColorBadgeProps {
  color: string;
}

export function ColorBadge({ color }: ColorBadgeProps) {
  const label = colorLabel(color);
  return (
    <span className="ouam-color-badge">
      <span className="ouam-color-swatch" style={{ background: colorSwatch(color) }} aria-hidden="true" />
      {label}
    </span>
  );
}
