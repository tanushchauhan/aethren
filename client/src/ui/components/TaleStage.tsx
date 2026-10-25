import type { CSSProperties, ReactNode } from 'react';
import { useGameStore } from '../../net/store';
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
  const narrator = useGameStore(s => s.gameState?.narratorCaption);
  const openingLines: Record<string, string> = {
    upload: 'Every friendship holds a story. Choose the memories that will awaken yours.',
    opening: 'A few forgotten moments flicker in the moonlight. Which will you carry into the tale?',
  };
  caption = narrator || caption || openingLines[screen];
  return (
    <div
      className={cx('ouam-stage', caption ? 'ouam-stage-captioned' : undefined)}
      data-screen={screen}
      style={stageVars}
    >
      <div className="ouam-shell">
        <div className="ouam-topbar"><span className="vn-chapter">Once in a Memory · {screen === 'upload' ? 'Prologue' : screen === 'opening' ? 'Memories' : screen === 'ending' ? 'Epilogue' : 'The tale'}</span>{roomCode ? <RoomCodeBadge code={roomCode} /> : null}</div>
        {children}
      </div>
      {caption ? (
        <p className="ouam-caption" role="status">
          <span className="vn-nameplate">The storyteller</span>
          {caption}
          <span className="vn-dialogue-diamond" aria-hidden="true">◆</span>
        </p>
      ) : null}
    </div>
  );
}
