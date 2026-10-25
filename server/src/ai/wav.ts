/**
 * WAV helpers. Muse Voice Transcribe (as researched) takes WAV only: 16-bit PCM, mono,
 * 16 or 24 kHz, at most 32 MB / 10 minutes. No ffmpeg here: the client should record or
 * convert to that format, and the server only checks the header.
 */

export interface WavInfo {
  /** 1 = PCM, 3 = IEEE float, 0xFFFE = extensible. */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSec: number;
}

export const MUSE_WAV_SAMPLE_RATES = [16_000, 24_000] as const;
export const MUSE_WAV_MAX_BYTES = 32 * 1024 * 1024;
export const MUSE_WAV_MAX_SECONDS = 600;

export function looksLikeWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

/** Parses a RIFF/WAVE header by walking its chunks. `null` when it is not a usable WAV. */
export function parseWavHeader(buf: Buffer): WavInfo | null {
  if (!looksLikeWav(buf)) return null;
  let offset = 12;
  let fmt: Omit<WavInfo, 'dataBytes' | 'durationSec'> | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      let audioFormat = buf.readUInt16LE(body);
      if (audioFormat === 0xfffe && size >= 40 && body + 26 <= buf.length) {
        audioFormat = buf.readUInt16LE(body + 24); // sub-format GUID starts with the format tag
      }
      fmt = {
        audioFormat,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      // Streaming recorders sometimes write 0 or 0xFFFFFFFF; trust the buffer length then.
      const dataBytes = size === 0 || size === 0xffffffff ? buf.length - body : Math.min(size, buf.length - body);
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return { ...fmt, dataBytes, durationSec: bytesPerSec > 0 ? dataBytes / bytesPerSec : 0 };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Problems that would make Muse ASR reject the clip. Empty when it fits the spec. */
export function museWavProblems(info: WavInfo | null, byteLength: number): string[] {
  if (!info) return ['not a WAV file'];
  const problems: string[] = [];
  if (info.audioFormat !== 1) problems.push(`format ${info.audioFormat} is not PCM`);
  if (info.bitsPerSample !== 16) problems.push(`${info.bitsPerSample}-bit, expected 16-bit`);
  if (info.channels !== 1) problems.push(`${info.channels} channels, expected mono`);
  if (!(MUSE_WAV_SAMPLE_RATES as readonly number[]).includes(info.sampleRate)) {
    problems.push(`${info.sampleRate} Hz, expected 16000 or 24000`);
  }
  if (byteLength > MUSE_WAV_MAX_BYTES) problems.push('larger than 32 MB');
  if (info.durationSec > MUSE_WAV_MAX_SECONDS) problems.push('longer than 10 minutes');
  return problems;
}

/** Builds a 16-bit PCM mono WAV with a sine tone (0 Hz gives silence). For live checks and tests. */
export function makeToneWav(opts: { seconds?: number; sampleRate?: number; frequency?: number; amplitude?: number } = {}): Buffer {
  const seconds = opts.seconds ?? 1;
  const sampleRate = opts.sampleRate ?? 16_000;
  const frequency = opts.frequency ?? 440;
  const amplitude = opts.amplitude ?? 0.3;
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const v = frequency > 0 ? Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}
