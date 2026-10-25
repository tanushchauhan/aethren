import { useEffect, useState, type CSSProperties } from 'react';
import { animate, motion, useReducedMotion } from 'motion/react';
import Markdown from 'react-markdown';
import './visual-novel-dialogue.css';

export interface DialogueLine { speaker: string; text: string; color?: string; voicePitch?: number; voiceVolume?: number }
interface Props { lines: DialogueLine[]; onComplete?: () => void; onLineChange?: (index: number) => void; muted?: boolean; active?: boolean; advanceTo?: number }

// Split text nodes after Markdown parsing so formatting never flashes raw syntax.
interface TextTree { type: string; value?: string; children?: TextTree[]; [key: string]: unknown }
function revealCharacters() {
  return (tree: TextTree) => {
    let index = 0;
    function visit(node: TextTree) {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text') { visit(child); return [child]; }
        return Array.from(child.value ?? '').map(character => ({
          type: 'element', tagName: 'span', properties: { 'data-character': index++ },
          children: [{ type: 'text', value: character }],
        }));
      });
    }
    visit(tree);
  };
}

export function VisualNovelDialogue({ lines, onComplete, onLineChange, muted = false, active = true, advanceTo }: Props) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (advanceTo !== undefined) setIndex(advanceTo); }, [advanceTo]);
  const line = lines[index];
  useEffect(() => { onLineChange?.(index); }, [index, onLineChange]);
  function finish() { setDismissed(true); onComplete?.(); }
  if (dismissed || !line) return null;
  return <DialoguePage key={`${index}:${line.text}`} line={line} index={index} total={lines.length} muted={muted} active={active}
    onNext={() => index + 1 < lines.length ? setIndex(index + 1) : finish()} onSkip={finish} />;
}

function DialoguePage({ line, index, total, onNext, onSkip, muted, active }: {
  muted: boolean; active: boolean; line: DialogueLine; index: number; total: number; onNext: () => void; onSkip: () => void;
}) {
  const reduced = useReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const complete = revealed || Boolean(reduced);
  useEffect(() => {
    if (complete || muted || !active) return;
    const typing = new Audio('/audio/dialogue-typing.mp3');
    typing.loop = true; typing.volume = line.voiceVolume ?? .36;
    typing.preservesPitch = false;
    typing.playbackRate = line.voicePitch ?? 1;
    const play = () => { if (!document.hidden) void typing.play().catch(() => {}); };
    const visibility = () => { if (document.hidden) typing.pause(); else play(); };
    play();
    window.addEventListener('pointerdown', play);
    window.addEventListener('keydown', play);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      typing.pause(); typing.src = '';
      window.removeEventListener('pointerdown', play);
      window.removeEventListener('keydown', play);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [complete, muted, active, line.voicePitch, line.voiceVolume]);

  useEffect(() => {
    if (complete) return;
    const animation = animate(0, 1, { duration: Array.from(line.text).length * .024 + .1,
      onComplete: () => setRevealed(true) });
    return () => animation.stop();
  }, [line.text, complete]);
  return <motion.section className="novel-dialogue" style={{ '--speaker-color': line.color ?? '#ffe5ad' } as CSSProperties} aria-label={`${line.speaker} dialogue`}
    initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25 }}>
    <div className="novel-speaker"><span aria-hidden="true">◆</span>{line.speaker}</div>
    <div className="novel-prose" aria-live="polite" aria-atomic="true">
      <Markdown allowedElements={['p', 'strong', 'em', 'br', 'span']} unwrapDisallowed
        rehypePlugins={[revealCharacters]} components={{
          span: ({ node, children }) => <motion.span aria-hidden="true" initial={{ opacity: 0 }}
            animate={{ opacity: 1 }} transition={{ duration: complete ? 0 : .06,
              delay: complete ? 0 : Number(node?.properties['data-character'] ?? 0) * .024 }}>{children}</motion.span>,
        }}>{line.text}</Markdown>
      <span className="novel-sr-text">{line.text.replace(/[*_]/g, '')}</span>
    </div>
    <footer className="novel-dialogue-actions">
      <span className="novel-page" aria-label={`Dialogue ${index + 1} of ${total}`}>{String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}</span>
      <button type="button" className="novel-skip" data-glove-hold-b2 onClick={onSkip}>Skip <kbd className="glove-key">Hold B2</kbd></button>
      <button type="button" className="novel-next" data-glove-b1="Next Line" onClick={() => complete ? onNext() : setRevealed(true)}>
        Next <kbd className="glove-key">B1</kbd>
      </button>
    </footer>
  </motion.section>;
}
