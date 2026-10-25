/** Muse Voice Transcribe accepts WAV PCM16 mono at 16 kHz; MediaRecorder gives WebM/MP4. */
export const WAV_SAMPLE_RATE = 16_000;

export function encodeWav(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(s * (s < 0 ? 0x8000 : 0x7fff)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Decodes a recorded clip and resamples it to 16 kHz mono WAV. Returns `null` if the browser cannot. */
export async function toWav16k(clip: Blob): Promise<Blob | null> {
  if (typeof OfflineAudioContext === 'undefined') return null;
  try {
    const decoded = await new OfflineAudioContext(1, 1, WAV_SAMPLE_RATE).decodeAudioData(await clip.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, WAV_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0));
  } catch {
    return null;
  }
}
