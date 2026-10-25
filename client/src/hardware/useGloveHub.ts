import { useCallback, useEffect, useRef, useState } from 'react';

/** The glove hub (`pnpm --dir firmware hub`) relays every glove's Wi-Fi packets on this WebSocket. */
export const GLOVE_HUB_URL = 'ws://localhost:8765';

export interface GloveSample {
  /** Browser clock (performance.now) when the frame arrived. */
  t: number;
  seq: number;
  /** Milli-g. */
  ax: number;
  ay: number;
  az: number;
  d3: number;
  d7: number;
  d4: number;
  d8: number;
  dial: number;
  rssi: number;
}

export interface GloveSummary {
  id: number;
  ip: string;
  /** Grove LCD version this firmware was built for (4 or 2). */
  variant: number | null;
  fw: string;
  ssid: string;
  rssi: number;
  acc: string;
  hubSeen: boolean;
  uptimeS: number;
  gloveFps: number;
  i2c: number[];
  online: boolean;
  ageMs: number;
  received: number;
  dropped: number;
  rxRate: number;
  conflict: boolean;
}

export interface GloveEdgeCounts {
  d3: number;
  d7: number;
  d4: number;
  d8: number;
}

export type HubStatus = 'connecting' | 'open' | 'closed';

/** Keeps about this many seconds of samples per glove for the charts. */
export const SAMPLE_WINDOW_MS = 12_000;
const MAX_SAMPLES = 1200;

export interface GloveHub {
  status: HubStatus;
  gloves: GloveSummary[];
  /** Mutable: read inside a render tick or animation frame. */
  samples: React.MutableRefObject<Map<number, GloveSample[]>>;
  edges: React.MutableRefObject<Map<number, GloveEdgeCounts>>;
  /** Bumps about 5 times a second so cards re-read the refs. */
  tick: number;
  send: (id: number, command: Record<string, unknown>) => void;
  clear: (id?: number) => void;
}

export function useGloveHub(url: string = GLOVE_HUB_URL): GloveHub {
  const [status, setStatus] = useState<HubStatus>('connecting');
  const [gloves, setGloves] = useState<GloveSummary[]>([]);
  const [tick, setTick] = useState(0);
  const samples = useRef(new Map<number, GloveSample[]>());
  const edges = useRef(new Map<number, GloveEdgeCounts>());
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;

    const open = () => {
      setStatus('connecting');
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => setStatus('open');
      ws.onclose = () => {
        setStatus('closed');
        if (!closed) retry = window.setTimeout(open, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (event) => {
        let message: { type?: string; [key: string]: unknown };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'snapshot' && Array.isArray(message.gloves)) {
          setGloves(message.gloves as GloveSummary[]);
        } else if (message.type === 'glove' && message.glove) {
          const next = message.glove as GloveSummary;
          setGloves((current) => [...current.filter((g) => g.id !== next.id), next].sort((a, b) => a.id - b.id));
        } else if (message.type === 'frame' && typeof message.id === 'number' && message.f) {
          const id = message.id;
          const f = message.f as Omit<GloveSample, 't'>;
          const now = performance.now();
          const list = samples.current.get(id) ?? [];
          const prev = list[list.length - 1];
          list.push({ ...f, t: now });
          while (list.length > MAX_SAMPLES || (list[0] && now - list[0].t > SAMPLE_WINDOW_MS)) list.shift();
          samples.current.set(id, list);
          const counts = edges.current.get(id) ?? { d3: 0, d7: 0, d4: 0, d8: 0 };
          if (prev) {
            if (!prev.d3 && f.d3) counts.d3++;
            if (!prev.d7 && f.d7) counts.d7++;
            if (!prev.d4 && f.d4) counts.d4++;
            if (!prev.d8 && f.d8) counts.d8++;
          }
          edges.current.set(id, counts);
        }
      };
    };
    open();
    const timer = window.setInterval(() => setTick((n) => n + 1), 200);
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearInterval(timer);
      socket.current?.close();
    };
  }, [url]);

  const send = useCallback((id: number, command: Record<string, unknown>) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cmd', id, ...command }));
  }, []);

  const clear = useCallback((id?: number) => {
    if (id === undefined) {
      samples.current.clear();
      edges.current.clear();
    } else {
      samples.current.delete(id);
      edges.current.delete(id);
    }
  }, []);

  return { status, gloves, samples, edges, tick, send, clear };
}
