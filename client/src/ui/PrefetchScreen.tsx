import { useEffect, useRef } from 'react';
import { usePrefetch } from '../net/prefetch';
import './prefetch-screen.css';

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(bytes > 10_485_760 ? 0 : 1);

/** The loading screen for the home menu's preload button. */
export function PrefetchScreen() {
  const { open, status, loadedFiles, totalFiles, loadedBytes, totalBytes, current, failed, webcamModel, start, cancel, close } = usePrefetch();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  // A finished download closes itself after a moment, so nobody has to look for a button.
  useEffect(() => {
    if (status !== 'done') return;
    const timer = window.setTimeout(() => usePrefetch.getState().close(), 2200);
    return () => window.clearTimeout(timer);
  }, [status]);

  const fraction = totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0;
  const running = status === 'running';
  return <dialog ref={dialog} className="title-dialog prefetch-dialog" aria-labelledby="prefetch-title"
    onCancel={event => { event.preventDefault(); if (running) cancel(); else close(); }}>
    <button type="button" className="dialog-close" aria-label={running ? 'Cancel' : 'Close'} onClick={() => (running ? cancel() : close())}>×</button>
    <h2 id="prefetch-title">{status === 'done' ? 'Ready to play' : status === 'error' ? 'Some files failed' : 'Preparing the game'}</h2>
    <div className="prefetch-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
      <span style={{ width: `${status === 'done' ? 100 : fraction * 100}%` }} />
    </div>
    <p className="prefetch-numbers">
      {status === 'done' ? 'Everything is saved in this browser.' : `${loadedFiles} of ${totalFiles || '?'} assets · ${mb(loadedBytes)} of ${totalBytes ? mb(totalBytes) : '?'} MB`}
    </p>
    {running && <p className="prefetch-current">{current}</p>}
    {status === 'done' && webcamModel === false && <p className="prefetch-warn">The webcam model could not be downloaded (no internet). Tracking will fetch it when you are online.</p>}
    {status === 'error' && <>
      <p className="prefetch-warn">{failed.length ? `Could not download: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}.` : current}</p>
      <button type="button" className="title-confirm" data-glove-b1="Retry" onClick={() => void start()}>Try again <kbd className="glove-key">B1</kbd></button>
    </>}
    {running && <button type="button" className="prefetch-cancel" data-glove-b2="Cancel" onClick={cancel}>Cancel <kbd className="glove-key">B2</kbd></button>}
    {status === 'done' && <button type="button" className="title-confirm" data-glove-b1="Done" onClick={close}>Done <kbd className="glove-key">B1</kbd></button>}
  </dialog>;
}
