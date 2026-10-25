/**
 * Muse Image: cover, monster and boss in parallel. URLs pass straight through; base64 images
 * are kept in memory and served at `GET /api/images/:id`. Failures fall back to images saved
 * with the cached world (`ai/cached-images/`), then to the placeholder SVGs.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { WorldImage, WorldSchema } from '@once-upon/shared';
import { museImageGenerate } from './providers';
import { IMAGE_KINDS, placeholderUrl } from './placeholders';
import { describeError, type AiRuntime } from './runtime';
import { createLru } from './lru';
import { aiTimings } from './timings';

type Kind = WorldImage['kind'];

export const IMAGE_STYLE =
  'Whimsical ink-and-watercolor fairy-tale picture-book illustration, warm lantern light, soft paper texture, original characters, no text or lettering';
const IMAGE_TIMEOUT_FLOOR_MS = 30_000;
export const CACHED_IMAGES_DIR = new URL('./cached-images/', import.meta.url);
const CACHED_IMAGE_EXTS = ['png', 'jpg', 'webp'] as const;

export interface StoredImage {
  buf: Buffer;
  contentType: string;
  length: number;
}

export function sniffImageType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'image/png';
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim().slice(0, 240);
}

export function buildImagePrompts(world: WorldSchema): Record<Kind, string> {
  const monster = world.encounters[0];
  return {
    cover: `${IMAGE_STYLE}. The cover scene of a storybook called "${world.title}": ${firstSentence(world.intro)}`,
    monster: `${IMAGE_STYLE}. ${monster?.artPrompt ?? `A mischievous forest creature named ${monster?.name ?? 'the Beast'}`}`,
    boss: `${IMAGE_STYLE}. ${world.boss.artPrompt}`,
  };
}

export function createImageService(rt: AiRuntime, cachedWorldTitle: string, savedImagesDir = CACHED_IMAGES_DIR) {
  const store = createLru<StoredImage>(60, 120 * 1024 * 1024);
  const byPrompt = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  const cachedKinds = new Set<Kind>();

  function put(buf: Buffer, contentType: string, id: string = randomUUID().replace(/-/g, '')): string {
    store.set(id, { buf, contentType, length: buf.length });
    return `/api/images/${id}`;
  }

  // Images saved next to the cached world by `save-cached-world.ts --images`.
  for (const kind of IMAGE_KINDS) {
    for (const ext of CACHED_IMAGE_EXTS) {
      const file = new URL(`${kind}.${ext}`, savedImagesDir);
      if (!existsSync(file)) continue;
      try {
        const buf = readFileSync(file);
        put(buf, sniffImageType(buf), `cached-${kind}`);
        cachedKinds.add(kind);
      } catch {
        // unreadable file: placeholder instead
      }
      break;
    }
  }
  const fallbackUrl = (kind: Kind) => (cachedKinds.has(kind) ? `/api/images/cached-${kind}` : placeholderUrl(kind));

  async function generateOne(prompt: string): Promise<string | null> {
    const hit = byPrompt.get(prompt);
    if (hit) return hit;
    const pending = inflight.get(prompt);
    if (pending) return pending;
    const job = (async () => {
      const started = Date.now();
      try {
        const img = await museImageGenerate({
          baseUrl: rt.config.muse.baseUrl,
          apiKey: rt.config.muse.apiKey!,
          model: rt.config.muse.imageModel,
          prompt,
          timeoutMs: Math.max(rt.config.aiTimeoutMs, IMAGE_TIMEOUT_FLOOR_MS),
        });
        let url: string;
        if (img.url) url = img.url;
        else {
          const buf = Buffer.from(img.b64!, 'base64');
          url = put(buf, img.mimeType ?? sniffImageType(buf));
        }
        byPrompt.set(prompt, url);
        aiTimings.record('image.generate', Date.now() - started, 'ok');
        return url;
      } catch (err) {
        aiTimings.record('image.generate', Date.now() - started, 'error');
        rt.warn(`muse image failed: ${describeError(err)}`);
        return null;
      } finally {
        inflight.delete(prompt);
      }
    })();
    inflight.set(prompt, job);
    return job;
  }

  async function generateImages(world: WorldSchema, onImage: (img: WorldImage) => void): Promise<void> {
    const emit = (img: WorldImage) => {
      try {
        onImage(img);
      } catch (err) {
        rt.warn(`onImage callback threw: ${describeError(err)}`);
      }
    };
    const prompts = buildImagePrompts(world);
    const isCachedWorld = world.title === cachedWorldTitle;
    const canGenerate = rt.caps.image && Boolean(rt.config.muse.apiKey);
    await Promise.all(
      IMAGE_KINDS.map(async (kind) => {
        try {
          if (isCachedWorld && cachedKinds.has(kind)) return emit({ kind, url: fallbackUrl(kind) });
          const url = canGenerate ? await generateOne(prompts[kind]) : null;
          emit({ kind, url: url ?? fallbackUrl(kind) });
        } catch (err) {
          rt.warn(`image ${kind} failed: ${describeError(err)}`);
          emit({ kind, url: fallbackUrl(kind) });
        }
      }),
    );
  }

  return { generateImages, getImage: (id: string) => store.get(id), generateOne, put };
}
