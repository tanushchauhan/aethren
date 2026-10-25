/** Save art and narration for the existing demo world, without replacing its story. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildImagePrompts, CACHED_IMAGES_DIR, sniffImageType } from './images';
import { museImageGenerate } from './providers';
import { createDefaultRuntime } from './runtime';
import { CACHED_WORLD, prewarmLines } from './service';
import { CACHED_AUDIO_DIR, createTts } from './tts';

const rt = createDefaultRuntime();
let failures = 0;
const prompts = buildImagePrompts(CACHED_WORLD);
mkdirSync(CACHED_IMAGES_DIR, { recursive: true });
mkdirSync(CACHED_AUDIO_DIR, { recursive: true });
await Promise.all(Object.entries(prompts).map(async ([kind, prompt]) => {
  try {
    if (!rt.config.muse.apiKey) throw new Error('MUSE_API_KEY is missing');
    const image = await museImageGenerate({ baseUrl: rt.config.muse.baseUrl, apiKey: rt.config.muse.apiKey,
      model: rt.config.muse.imageModel, prompt, timeoutMs: 90_000 });
    let imageBytes: Buffer;
    if (image.b64) imageBytes = Buffer.from(image.b64, 'base64');
    else {
      const response = await fetch(image.url!, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Image download HTTP ${response.status}`);
      imageBytes = Buffer.from(await response.arrayBuffer());
    }
    const extension = sniffImageType(imageBytes).split('/')[1]!.replace('jpeg', 'jpg');
    writeFileSync(new URL(`${kind}.${extension}`, CACHED_IMAGES_DIR), imageBytes);
    console.log(`Saved ${kind} art (${imageBytes.length} bytes)`);
  } catch (error) { failures++; rt.warn(`Cache ${kind}: ${String(error)}`); }
}));
const tts = createTts(rt);
const entries: { key: string; provider: string }[] = [];
for (const line of prewarmLines(CACHED_WORLD)) {
  const result = await tts.synthesize(line.text, line.speaker);
  if (!result) { failures++; continue; }
  writeFileSync(new URL(`${result.key}.mp3`, CACHED_AUDIO_DIR), result.audio);
  entries.push({ key: result.key, provider: result.provider });
}
writeFileSync(new URL('manifest.json', CACHED_AUDIO_DIR), JSON.stringify(entries, null, 2) + '\n');
console.log(`Saved ${entries.length} narration clips; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
