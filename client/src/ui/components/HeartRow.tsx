interface HeartRowProps {
  filled: number;
  total: number;
  emptyLabel?: string;
}

export function HeartRow({ filled, total, emptyLabel }: HeartRowProps) {
  const count = Number.isFinite(total) ? Math.max(0, Math.min(8, Math.floor(total))) : 0;
  const full = Number.isFinite(filled) ? Math.max(0, Math.min(count, Math.floor(filled))) : 0;
  const label = full === 0 && emptyLabel ? emptyLabel : `${full} of ${count} hearts remain`;
  return (
    <p className="ouam-hearts">
      <span className="ouam-hearts-label">{label}</span>
      <span className="ouam-hearts-row" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className={index < full ? 'ouam-heart is-full' : 'ouam-heart'}>
            {index < full ? '♥' : '♡'}
          </span>
        ))}
      </span>
    </p>
  );
}
