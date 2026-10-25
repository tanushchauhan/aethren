import type { ReactNode } from 'react';
import { cx } from '../cx';

interface ParchmentPanelProps {
  children: ReactNode;
  title?: string;
  className?: string;
  id?: string;
}

export function ParchmentPanel({ children, title, className, id }: ParchmentPanelProps) {
  return (
    <section id={id} className={cx('ouam-parchment', className)}>
      {title ? <h2 className="ouam-panel-title">{title}</h2> : null}
      {children}
    </section>
  );
}
