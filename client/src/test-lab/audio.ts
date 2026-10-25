/** Capture real microphone PCM and encode the mono 16 kHz WAV required by Muse. */
export async function startMicrophone() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  let stopped = false;
  return async () => {
    if (stopped) throw new Error('Recording already stopped');
    stopped = true;
    processor.disconnect(); source.disconnect(); mute.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    const sourceRate = context.sampleRate;
    await context.close();
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const input = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
    const count = Math.floor(length * 16000 / sourceRate);
    const buffer = new ArrayBuffer(44 + count * 2);
    const view = new DataView(buffer);
    const ascii = (at: number, text: string) => [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * sourceRate / 16000);
      const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * sourceRate / 16000)));
      let sample = 0;
      for (let j = start; j < end; j++) sample += input[j]!;
      sample = Math.max(-1, Math.min(1, sample / (end - start)));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  };
}
