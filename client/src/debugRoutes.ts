/**
 * Every testing and debug lab lives under /debug. Kept free of lab imports so App.tsx can route
 * without pulling the lab bundle into the game chunk.
 */

export const GAME_PATH = '/';
export const DEBUG_PATH = '/debug';
export const DEBUG_VISION_PATH = '/debug/vision';
export const DEBUG_HARDWARE_PATH = '/debug/hardware';
export const DEBUG_COMBINED_PATH = '/debug/combined';
export const DEBUG_AUDIO_PATH = '/debug/audio';

export const DEBUG_ROUTES = [
  { href: DEBUG_PATH, label: 'Command', id: 'command' },
  { href: DEBUG_VISION_PATH, label: 'Vision', id: 'vision' },
  { href: DEBUG_HARDWARE_PATH, label: 'Glove', id: 'glove' },
  { href: DEBUG_COMBINED_PATH, label: 'Combined', id: 'combined' },
  { href: DEBUG_AUDIO_PATH, label: 'Audio & Narrator', id: 'audio' },
] as const;

export type DebugRoute = (typeof DEBUG_ROUTES)[number]['href'];

/** Old lab URLs keep working and are rewritten to their /debug home. */
export const LEGACY_LAB_REDIRECTS: Readonly<Record<string, DebugRoute>> = {
  '/labs': DEBUG_PATH,
  '/vision-test': DEBUG_VISION_PATH,
  '/hardware-test': DEBUG_HARDWARE_PATH,
  '/combined': DEBUG_COMBINED_PATH,
};

export function canonicalPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname || '/';
}

export function isGamePath(pathname: string): boolean {
  return canonicalPath(pathname) === GAME_PATH;
}

export function isDebugPath(pathname: string): boolean {
  const path = canonicalPath(pathname);
  return path === DEBUG_PATH || path.startsWith(`${DEBUG_PATH}/`) || path in LEGACY_LAB_REDIRECTS;
}

/** Legacy paths become their /debug equivalent; anything else is returned canonicalized. */
export function resolveLabPath(pathname: string): string {
  const path = canonicalPath(pathname);
  return LEGACY_LAB_REDIRECTS[path] ?? path;
}

export function matchDebugRoute(pathname: string): DebugRoute | null {
  const path = resolveLabPath(pathname);
  return DEBUG_ROUTES.find((route) => route.href === path)?.href ?? null;
}
