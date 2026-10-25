import type { CSSProperties, ReactNode } from 'react';
import { ELEMENT_COLORS } from '../../net/contract';
import { cx } from '../cx';
import { RoomCodeBadge } from './RoomCodeBadge';

const stageVars = {
  '--ouam-ember': ELEMENT_COLORS.ember,
  '--ouam-frost': ELEMENT_COLORS.frost,
  '--ouam-bloom': ELEMENT_COLORS.bloom,
} as CSSProperties;

interface TaleStageProps {
  screen: string;
  children: ReactNode;
  roomCode?: string;
  caption?: string;
}

export function TaleStage({ screen, children, roomCode, caption }: TaleStageProps) {
  return (
    <div
      className={cx('ouam-stage', caption ? 'ouam-stage-captioned' : undefined)}
      data-screen={screen}
      style={stageVars}
    >
      <div className="ouam-shell">
        <div className="ouam-topbar">{roomCode ? <RoomCodeBadge code={roomCode} /> : null}</div>
        {children}
      </div>
      {caption ? (
        <p className="ouam-caption" role="status">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
