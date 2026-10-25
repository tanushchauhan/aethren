import { useEffect, useRef, useState } from 'react';
import { ELEMENTS_P0, NOISE_LOUD_THRESHOLD, type Gesture } from '../net/contract';
import { useGameStore, getServerNow } from '../net/store';
import { BattleStage } from './BattleStage';
import { TelegraphOverlay } from './TelegraphOverlay';
import { useSpellSelection } from './useSpellSelection';
import { phraseMatches, transcribeClip } from './audio/transcribe';
import { stopNarration } from './audio/tts';
import styles from './combat.module.css';

export function CombatLayer() {
  const phase = useGameStore(s => s.gameState?.phase);
  if (phase !== 'calibrating' && phase !== 'encounter' && phase !== 'boss') return null;
  return <CombatScreen />;
}

function CombatScreen() {
  const game = useGameStore(s => s.gameState)!;
  const hardware = useGameStore(s => s.hardware);
  const mock = useGameStore(s => s.mockMode);
  const playerId = useGameStore(s => s.localPlayerId);
  const spell = useSpellSelection();
  const local = game.players.find(p => p.id === playerId);
  const armed = !hardware || hardware.armed;
  const canSpeak = armed && game.combatPhase === 'team_turn' && local?.inZone === true;
  const [held, setHeld] = useState(false);
  const [pageActive, setPageActive] = useState(true);
  const [recording, setRecording] = useState(false);
  useEffect(() => { window.dispatchEvent(new CustomEvent('ouam:recording', { detail: recording })); return () => { window.dispatchEvent(new CustomEvent('ouam:recording', { detail: false })); }; }, [recording]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Choose an element, then hold to speak.');
  const [ready, setReady] = useState<{ element: typeof spell.element; transcript: string; power: number } | null>(null);
  const attempts = useRef(0);
  const generation = useRef(0);
  const desired = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pressed = held || (hardware?.buttonPressed === true);
  desired.current = pressed && canSpeak && pageActive;

  useEffect(() => {
    function down(e: KeyboardEvent) {
      const target = e.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT|BUTTON/.test(target.tagName))) return;
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setHeld(true); }
      if (/^[123]$/.test(e.key)) spell.choose((Number(e.key) - 1) as 0 | 1 | 2);
    }
    function up(e: KeyboardEvent) { if (e.code === 'Space') { e.preventDefault(); setHeld(false); } }
    const release = () => { setHeld(false); setPageActive(false); };
    const resume = () => setPageActive(!document.hidden);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('focus', resume);
      window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', release);
    };
  }, [spell.choose]);

  useEffect(() => {
    generation.current++;
    attempts.current = 0;
    setReady(null);
    setHeld(false);
  }, [spell.element, game.currentRound, game.combatPhase]);

  useEffect(() => {
    if (!desired.current) {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach(t => t.stop());
      return;
    }
    if (busy || recorder.current) return;
    let cancelled = false;
    const token = generation.current;
    const element = spell.element;
    const phrase = spell.phrase;
    setReady(null);
    stopNarration();
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording needs a supported browser on HTTPS or localhost.');
        const media = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled || !desired.current || token !== generation.current) { media.getTracks().forEach(t => t.stop()); return; }
        stream.current = media;
        const rec = new MediaRecorder(media);
        recorder.current = rec;
        const chunks: Blob[] = [];
        rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          media.getTracks().forEach(t => t.stop());
          recorder.current = null;
          stream.current = null;
          setRecording(false);
          if (token !== generation.current || !chunks.length) return;
          setBusy(true);
          void transcribeClip(new Blob(chunks, { type: rec.mimeType }), element).then(result => {
            if (token !== generation.current) return;
            attempts.current++;
            const passed = result.pass ?? phraseMatches(result.transcript, phrase);
            const mercy = !passed && attempts.current >= 3;
            setMessage(passed ? 'Words accepted. Release your spell!' : mercy ? 'A little help from the tale. Cast at half power.' : 'Almost. Hold to try the phrase again.');
            if (passed || mercy) setReady({ element, transcript: result.transcript, power: mercy ? 0.5 : 1 });
          }).catch(error => {
            if (token === generation.current) setMessage(error instanceof Error ? error.message : 'Transcription is unavailable. Try again.');
          }).finally(() => setBusy(false));
        };
        rec.start(); setRecording(true); setMessage('Listening… release to finish.');
      } catch (error) {
        stream.current?.getTracks().forEach(t => t.stop());
        recorder.current = null;
        setRecording(false);
        setMessage(error instanceof Error ? error.message : 'Microphone unavailable.');
      }
    })();
    return () => { cancelled = true; };
  }, [pressed, canSpeak, pageActive]);

  useEffect(() => () => {
    generation.current++;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach(t => t.stop());
  }, []);

  function cast(gesture: Gesture) {
    if (!ready || !canSpeak || (hardware && !hardware.fistCharged)) return;
    useGameStore.getState().sendCast({ ...ready, gesture, serverTimestampMs: getServerNow() });
    setReady(null);
    setMessage('Spell sent. Match your partner’s element for Twin Cast.');
  }

  // Teammate 3's camera bridge can release the accepted incantation with this event.
  useEffect(() => {
    const release = (event: Event) => {
      const gesture = (event as CustomEvent<{ gesture: Gesture }>).detail?.gesture;
      if (gesture === 'swipe' || gesture === 'thrust') cast(gesture);
    };
    window.addEventListener('ouam:gesture', release);
    return () => window.removeEventListener('ouam:gesture', release);
  });

  return <main className={styles.root} data-phase={game.phase} aria-label="Battle stage">
    <BattleStage />
    <section className={styles.vision} aria-label="Player stage">
      <span className={styles.visionTag}>{local?.name || 'Spellbearer'} · {mock ? 'Practice tale' : 'Your place in the tale'}</span>
      <div className={styles.calibration}>
        {game.phase === 'calibrating' && <svg className={styles.silhouette} viewBox="0 0 180 280" aria-hidden="true"><circle cx="90" cy="38" r="24"/><path d="M58 86 Q90 68 122 86 L146 160 M58 86 L34 160 M64 90 L64 180 L48 260 M116 90 L116 180 L132 260 M64 180 L116 180"/></svg>}
        <h1 className={styles.calibText}>{game.phase === 'calibrating' ? 'Find your place in the tale' : game.combatPhase === 'team_turn' ? 'Your turn to make magic' : 'Watch the next move'}</h1>
        <p className={styles.pttHint}>{game.phase === 'calibrating' ? 'Stand where your whole body can be seen. Camera tracking is not connected yet.' : 'Two spellbearers. One shared fate. Choose your magic together.'}</p>
        {mock && game.phase === 'calibrating' && <button className="ouam-button" style={{ pointerEvents: 'auto', marginTop: 20 }} onClick={() => useGameStore.getState().setPhase('encounter', 'team_turn')}>Preview casting</button>}
      </div>
    </section>
    <aside className={styles.rail} aria-label="Spell controls">
      <div className={styles.spellChoices}>
        <p className={styles.meterTitle}>Choose your magic</p>
        <div className={styles.choiceList}>
          {ELEMENTS_P0.map((element, index) => <button key={element} aria-pressed={spell.element === element} className={styles.spellChoice} data-element={element} disabled={spell.hardwareDrives || recording || busy} onClick={() => spell.choose(index as 0 | 1 | 2)}><span aria-hidden="true">{spell.element === element ? '▸' : '◇'}</span><span>{element}</span><kbd>{index + 1}</kbd></button>)}
        </div>
        <button className={styles.choiceLock} onClick={spell.toggleLock} aria-pressed={spell.locked}>{spell.locked ? 'Unlock element' : 'Lock element'}</button>
      </div>
      <div className={styles.incantation}>
        <p className={styles.meterTitle}>Your incantation · {spell.element}</p>
        <p className={styles.phrase}>“{spell.phrase}”</p>
        <p className={styles.wheelHint}>Choose with your glove dial or the choices here. Cast the same element together for Twin Cast.</p>
      </div>
      <div className={styles.spellActions}>
      <button className="ouam-button" disabled={!canSpeak || busy} aria-label="Hold to speak incantation" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setHeld(true); }} onPointerUp={() => setHeld(false)} onPointerCancel={() => setHeld(false)} onLostPointerCapture={() => setHeld(false)} onKeyDown={e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); setHeld(true); } }} onKeyUp={() => setHeld(false)} onBlur={() => setHeld(false)}>{recording ? '● Listening…' : busy ? 'Reading your words…' : 'Hold to speak'}</button>
      <p className={styles.pttHint}>{!armed ? 'Arm your glove to cast.' : !canSpeak ? 'Cast during your team’s turn, inside the outline.' : 'Hold your glove’s finger button or Spacebar to speak.'}</p>
      <p className={styles.transcript} role="status">{message}</p>
      <div className={styles.castActions}>{(['swipe', 'thrust'] as const).map(gesture => <button className="ouam-button" key={gesture} disabled={!ready || !canSpeak || (!!hardware && !hardware.fistCharged)} onClick={() => cast(gesture)}>Cast · {gesture}</button>)}</div>
      </div>
    </aside>
    <TelegraphOverlay />
    {(game.tooLoud || (hardware?.noiseLevel ?? 0) > NOISE_LOUD_THRESHOLD) && <p className={styles.loud} role="status">Room too loud — move the microphone closer</p>}
    <footer className={styles.caption}><span className={styles.speaker}>The storyteller</span><p className={styles.captionText} role="status">{game.narratorCaption || 'Two friends. Two enchanted gloves. A story only you can tell.'}</p></footer>
  </main>;
}
