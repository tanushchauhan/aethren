import { useEffect, useRef, useState } from 'react';
import { getServerNow, useGameStore } from '../net/store';
import { phraseMatches, transcribeClip } from './audio/transcribe';
import styles from './combat.module.css';
import { useSpellSelection } from './useSpellSelection';

type Verdict = 'pass' | 'fail' | 'mercy';
type Gate = 'idle' | 'arming' | 'hot' | 'failed' | 'dropping';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return target.isContentEditable;
}

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return undefined;
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function judge(transcript: string, phrase: string, fistCharged: boolean, failCount: number): {
  power: number;
  verdict: Verdict;
  nextFailCount: number;
} {
  const charged = fistCharged ? 1.5 : 1;
  if (phraseMatches(transcript, phrase)) {
    return { power: charged, verdict: 'pass', nextFailCount: 0 };
  }
  const nextFailCount = failCount + 1;
  if (nextFailCount >= 3) {
    return { power: 0.5, verdict: 'mercy', nextFailCount: 0 };
  }
  return { power: charged, verdict: 'fail', nextFailCount };
}

function verdictClass(verdict: Verdict): string {
  if (verdict === 'pass') return styles.pass;
  if (verdict === 'fail') return styles.fail;
  return styles.mercy;
}

function verdictLabel(verdict: Verdict): string {
  if (verdict === 'pass') return 'PASS';
  if (verdict === 'fail') return 'FAIL';
  return 'MERCY';
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
    </svg>
  );
}

export function PushToTalk() {
  const selection = useSpellSelection();
  const role = useGameStore((state) => state.localRole);
  const hardware = useGameStore((state) => state.hardware);
  const buttonPressed = hardware?.buttonPressed === true;
  const hardwarePtt = role === 'spellbearer' && hardware !== null;

  const [live, setLive] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [demo, setDemo] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const aliveRef = useRef(true);
  const gateRef = useRef<Gate>('idle');
  const releasedEarlyRef = useRef(false);
  const failCountRef = useRef(0);
  const micProblemRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pressRef = useRef<() => void>(() => undefined);
  const releaseRef = useRef<() => void>(() => undefined);

  const setLiveSafe = (next: boolean) => {
    if (aliveRef.current) setLive(next);
  };

  const silenceHardware = () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    chunksRef.current = [];
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      try {
        recorder.stop();
      } catch {
        // The recorder was already closed.
      }
    }
    stopStream(stream);
  };

  async function blobFromRecorder(): Promise<Blob | null> {
    const recorder = recorderRef.current;
    const stream = streamRef.current;
    const chunks = chunksRef.current;
    if (!recorder || recorder.state === 'inactive') {
      recorderRef.current = null;
      streamRef.current = null;
      chunksRef.current = [];
      stopStream(stream);
      if (chunks.length === 0) return null;
      return new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    }

    const type = recorder.mimeType || 'audio/webm';
    const blob = await new Promise<Blob>((resolve) => {
      const finish = () => resolve(new Blob(chunks.splice(0, chunks.length), { type }));
      recorder.addEventListener('stop', finish, { once: true });
      try {
        if (recorder.state === 'recording') recorder.requestData();
        recorder.stop();
      } catch {
        finish();
      }
    });
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    stopStream(stream);
    return blob.size > 0 ? blob : null;
  }

  async function castClip(blob: Blob | null): Promise<void> {
    const { element, phrase, fistCharged } = selectionRef.current;
    const mockMode = useGameStore.getState().mockMode;
    let text = phrase;
    let usedDemo = true;
    let problem: string | null = null;
    const micProblem = micProblemRef.current;
    micProblemRef.current = null;

    if (mockMode) {
      text = phrase;
      usedDemo = true;
    } else if (blob && blob.size > 0) {
      try {
        const result = await transcribeClip(blob, element);
        text = result.transcript;
        usedDemo = false;
      } catch (caught) {
        text = phrase;
        usedDemo = true;
        problem = errorText(caught, 'Transcribe failed');
      }
    } else {
      text = phrase;
      usedDemo = true;
      problem = micProblem ?? 'No audio captured';
    }

    const judged = judge(text, phrase, fistCharged, failCountRef.current);
    failCountRef.current = judged.nextFailCount;
    useGameStore.getState().sendCast({
      element,
      gesture: 'thrust',
      transcript: text,
      power: judged.power,
      serverTimestampMs: getServerNow(),
    });
    if (!aliveRef.current) return;
    setTranscript(text);
    setDemo(usedDemo);
    setVerdict(judged.verdict);
    setError(problem);
  }

  const press = () => {
    if (gateRef.current !== 'idle') return;
    gateRef.current = 'arming';
    releasedEarlyRef.current = false;
    micProblemRef.current = null;
    setLiveSafe(true);
    if (aliveRef.current) setError(null);

    const abandon = (stream: MediaStream | null) => {
      stopStream(stream);
      const early = releasedEarlyRef.current;
      releasedEarlyRef.current = false;
      gateRef.current = 'idle';
      setLiveSafe(false);
      if (aliveRef.current && early) void castClip(null);
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!aliveRef.current || gateRef.current !== 'arming' || releasedEarlyRef.current) {
          abandon(stream);
          return;
        }
        const mimeType = preferredMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        });
        recorder.start();
        if (!aliveRef.current || releasedEarlyRef.current || gateRef.current !== 'arming') {
          try {
            recorder.stop();
          } catch {
            // Already inactive.
          }
          abandon(stream);
          return;
        }
        streamRef.current = stream;
        recorderRef.current = recorder;
        gateRef.current = 'hot';
        setLiveSafe(true);
      } catch (caught) {
        const early = releasedEarlyRef.current;
        releasedEarlyRef.current = false;
        micProblemRef.current = errorText(caught, 'Microphone unavailable');
        setLiveSafe(false);
        if (!aliveRef.current) {
          gateRef.current = 'idle';
          return;
        }
        setError(micProblemRef.current);
        if (early) {
          gateRef.current = 'idle';
          void castClip(null);
          return;
        }
        gateRef.current = 'failed';
      }
    })();
  };

  const release = () => {
    if (gateRef.current === 'arming') {
      releasedEarlyRef.current = true;
      setLiveSafe(false);
      return;
    }
    if (gateRef.current === 'failed') {
      gateRef.current = 'idle';
      setLiveSafe(false);
      void castClip(null);
      return;
    }
    if (gateRef.current !== 'hot') return;
    gateRef.current = 'dropping';
    setLiveSafe(false);
    void (async () => {
      const blob = await blobFromRecorder();
      if (gateRef.current === 'dropping') gateRef.current = 'idle';
      await castClip(blob);
    })();
  };

  pressRef.current = press;
  releaseRef.current = release;

  useEffect(() => {
    if (hardwarePtt) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      if (event.repeat) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      pressRef.current();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      releaseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (aliveRef.current) releaseRef.current();
    };
  }, [hardwarePtt]);

  const buttonWasPressed = useRef(false);
  useEffect(() => {
    if (!hardwarePtt) {
      if (buttonWasPressed.current) {
        buttonWasPressed.current = false;
        if (aliveRef.current) releaseRef.current();
      }
      return undefined;
    }
    if (buttonPressed === buttonWasPressed.current) return undefined;
    buttonWasPressed.current = buttonPressed;
    if (buttonPressed) pressRef.current();
    else if (aliveRef.current) releaseRef.current();
    return undefined;
  }, [hardwarePtt, buttonPressed]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      releasedEarlyRef.current = false;
      gateRef.current = 'idle';
      silenceHardware();
    };
  }, []);

  const label = live ? 'LISTENING' : hardwarePtt ? 'HOLD BUTTON' : 'HOLD SPACE';
  const hint = hardwarePtt ? 'Hold the finger button to speak.' : 'Hold Space to speak.';

  return (
    <div className={styles.ptt}>
      <div className={styles.micWrap}>
        <div className={live ? styles.micOn : styles.mic}>
          <MicIcon />
        </div>
      </div>
      <p className={styles.micLabel}>{label}</p>
      <p className={styles.transcript} aria-live="polite">
        {transcript}
        {verdict ? <span className={`${styles.badge} ${verdictClass(verdict)}`}>{verdictLabel(verdict)}</span> : null}
        {demo ? <span className={styles.demoNote}> (demo transcribe)</span> : null}
      </p>
      {error ? <p className={styles.error}>{error}</p> : null}
      <p className={styles.pttHint}>{hint}</p>
    </div>
  );
}
