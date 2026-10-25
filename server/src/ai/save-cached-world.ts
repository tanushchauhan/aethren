/**
 * Regenerates `cached-demo-world.json` from the fixture cards with live Muse Spark, for the
 * team to run once at the venue. Refuses to overwrite when Muse fails (the fallback would just
 * copy the old file). With `--images`, also saves cover/monster/boss art to `cached-images/`,
 * which the server serves instead of placeholders whenever the cached world is in play.
 *
 *   pnpm --filter @once-upon/server exec tsx src/ai/save-cached-world.ts [--images] [--dry-run]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorldSchema } from '@once-upon/shared';
import { buildImagePrompts, CACHED_IMAGES_DIR, sniffImageType } from './images';
import { museImageGenerate } from './providers';
import { createDefaultRuntime } from './runtime';
import { CACHED_PICKS, CACHED_WORLD, FIXTURE_CARDS } from './service';
import { createMuseChat } from './spark';
import { CACHED_PLAYER_NAMES, generateWorldDetailed, StrictWorldSchema } from './world';

const withImages = process.argv.includes('--images');
const dryRun = process.argv.includes('--dry-run');
const rt = createDefaultRuntime();
const muse = createMuseChat(rt);

if (!muse.available) {
  console.error('Muse Spark is not configured (set MUSE_API_KEY in server/.env). Nothing written.');
  process.exit(1);
}

const encounterCard = FIXTURE_CARDS.find((c) => c.id === CACHED_PICKS.encounterCardId) ?? null;
const bossCard = FIXTURE_CARDS.find((c) => c.id === CACHED_PICKS.bossCardId) ?? null;

console.log('Generating a world from the fixture cards with live Muse Spark...');
const started = Date.now();
const result = await generateWorldDetailed(
  muse,
  {
    cards: FIXTURE_CARDS,
    encounterCard,
    bossCard,
    playerNames: [...CACHED_PLAYER_NAMES],
    difficulty: 'normal',
  },
  { cached: CACHED_WORLD, useCachedWorld: false, timeoutMs: Math.max(rt.config.aiTimeoutMs, 30_000) },
);

if (result.source !== 'muse') {
  console.error(`Muse did not produce a world (${result.reason}). Nothing written.`);
  process.exit(1);
}
const strict = StrictWorldSchema.safeParse(result.world);
if (!strict.success) {
  console.error('Generated world failed the strict schema. Nothing written.', strict.error.issues);
  process.exit(1);
}
const world: WorldSchema = result.world;
console.log(`Got "${world.title}" in ${Date.now() - started}ms.`);
console.log(`  encounter: ${world.encounters[0]!.name} (weak to ${world.encounters[0]!.weakness})`);
console.log(`  boss:      ${world.boss.name} (weak to ${world.boss.weakness})`);
console.log(`  incantations: ${JSON.stringify(world.incantations)}`);

const target = fileURLToPath(new URL('./cached-demo-world.json', import.meta.url));
if (dryRun) {
  console.log('\n--dry-run: not writing. JSON follows.\n');
  console.log(JSON.stringify(world, null, 2));
} else {
  writeFileSync(target, `${JSON.stringify(world, null, 2)}\n`);
  console.log(`Wrote ${target}`);
}

if (withImages && !dryRun) {
  if (!rt.caps.image) {
    console.error('Muse Image is not configured; skipping images.');
    process.exit(1);
  }
  mkdirSync(CACHED_IMAGES_DIR, { recursive: true });
  const prompts = buildImagePrompts(world);
  await Promise.all(
    (Object.keys(prompts) as (keyof typeof prompts)[]).map(async (kind) => {
      try {
        const img = await museImageGenerate({
          baseUrl: rt.config.muse.baseUrl,
          apiKey: rt.config.muse.apiKey!,
          model: rt.config.muse.imageModel,
          prompt: prompts[kind],
          timeoutMs: 90_000,
        });
        const buf = img.b64
          ? Buffer.from(img.b64, 'base64')
          : Buffer.from(await (await fetch(img.url!)).arrayBuffer());
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[sniffImageType(buf)] ?? 'png';
        const file = new URL(`${kind}.${ext}`, CACHED_IMAGES_DIR);
        writeFileSync(file, buf);
        console.log(`Saved ${fileURLToPath(file)} (${Math.round(buf.length / 1024)} KB)`);
      } catch (err) {
        console.error(`Image ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  console.log('Commit server/src/ai/cached-images/ with the JSON so the demo has its art offline.');
}
