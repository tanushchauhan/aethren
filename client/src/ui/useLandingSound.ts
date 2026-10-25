import { useCallback, useEffect, useRef } from 'react';

/** Dry impact plus a short stereo convolution tail; all nodes belong to this scene. */
export function useLandingSound(muted: boolean, enabled: boolean) {
  const graph = useRef<{ context: AudioContext; gain: GainNode; buffer: Promise<AudioBuffer> } | null>(null);
  const isMuted = useRef(muted); isMuted.current = muted;
  const played = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    played.current = false;
    const context = new AudioContext(), gain = context.createGain();
    gain.gain.value = isMuted.current ? 0 : .65;
    gain.connect(context.destination);
    const abort = new AbortController();
    const buffer = fetch('/audio/gatekeeper-impact.wav', { signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error('Impact audio unavailable');
      return response.arrayBuffer();
    }).then(data => context.decodeAudioData(data));
    void buffer.catch(() => {});
    graph.current = { context, gain, buffer };
    const visibility = () => {
      if (document.hidden) void context.suspend().catch(() => {});
      else if (played.current) void context.resume().catch(() => {});
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      abort.abort(); graph.current = null;
      document.removeEventListener('visibilitychange', visibility);
      void context.close().catch(() => {});
    };
  }, [enabled]);
  useEffect(() => { if (graph.current) graph.current.gain.gain.setTargetAtTime(muted ? 0 : .65, graph.current.context.currentTime, .025); }, [muted]);
  const prepare = useCallback(() => { void graph.current?.context.resume().catch(() => {}); }, []);
  const play = useCallback(() => {
    const current = graph.current;
    if (!current || played.current) return;
    played.current = true;
    if (!document.hidden) void current.context.resume().catch(() => {});
    void current.buffer.then(buffer => {
      if (graph.current !== current || current.context.state === 'closed') return;
      const { context, gain } = current;
      const source = context.createBufferSource(); source.buffer = buffer;
      const dry = context.createGain(); dry.gain.value = .85;
      const wet = context.createGain(); wet.gain.value = .24;
      const reverb = context.createConvolver();
      const impulse = context.createBuffer(2, Math.floor(context.sampleRate * 2.2), context.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
      }
      reverb.buffer = impulse;
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 3200;
      source.connect(dry).connect(gain);
      source.connect(reverb).connect(filter).connect(wet).connect(gain);
      source.start();
    }).catch(() => {});
  }, []);
  return { prepare, play };
}
