import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LabsApp from '../LabsApp';
import {
  DEBUG_AUDIO_PATH,
  DEBUG_COMBINED_PATH,
  DEBUG_HARDWARE_PATH,
  DEBUG_PATH,
  DEBUG_ROUTES,
  DEBUG_VISION_PATH,
  isDebugPath,
  isGamePath,
  matchDebugRoute,
  resolveLabPath,
} from '../debugRoutes';
import { HARDWARE_TEST_PATH } from '../hardware';
import { VISION_TEST_PATH } from '../vision';

function stubWindow(pathname: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { pathname, search: '', hash: '', origin: 'http://localhost:5173' },
    history: { pushState: vi.fn(), replaceState },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  return { replaceState };
}

function renderLabs(pathname: string): string {
  stubWindow(pathname);
  return renderToStaticMarkup(createElement(LabsApp));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('debug routes', () => {
  it('keeps / as the only game path', () => {
    expect(isGamePath('/')).toBe(true);
    expect(isGamePath('')).toBe(true);
    expect(isGamePath('/debug')).toBe(false);
    expect(isGamePath('/somewhere')).toBe(false);
  });

  it('treats /debug, its children, and the legacy lab URLs as debug paths', () => {
    for (const path of ['/debug', '/debug/', '/debug/audio', '/debug/vision', '/labs', '/vision-test', '/hardware-test', '/combined']) {
      expect(isDebugPath(path), path).toBe(true);
    }
    expect(isDebugPath('/debugger')).toBe(false);
    expect(isDebugPath('/')).toBe(false);
  });

  it('redirects every legacy lab URL to its /debug home', () => {
    expect(resolveLabPath('/labs')).toBe(DEBUG_PATH);
    expect(resolveLabPath('/vision-test')).toBe(DEBUG_VISION_PATH);
    expect(resolveLabPath('/hardware-test/')).toBe(DEBUG_HARDWARE_PATH);
    expect(resolveLabPath('/combined')).toBe(DEBUG_COMBINED_PATH);
    expect(resolveLabPath('/debug/audio/')).toBe(DEBUG_AUDIO_PATH);
  });

  it('matches every lab and rejects unknown debug paths', () => {
    for (const route of DEBUG_ROUTES) expect(matchDebugRoute(route.href)).toBe(route.href);
    expect(matchDebugRoute('/vision-test')).toBe(DEBUG_VISION_PATH);
    expect(matchDebugRoute('/debug/nope')).toBeNull();
  });

  it('points the lab path constants at /debug', () => {
    expect(VISION_TEST_PATH).toBe('/debug/vision');
    expect(HARDWARE_TEST_PATH).toBe('/debug/hardware');
  });
});

describe('LabsApp shell', () => {
  it('shows the back link and every /debug lab in the top navigation', () => {
    const html = renderLabs('/debug/audio');
    expect(html).toContain('data-testid="nav-game"');
    expect(html).toContain('href="/"');
    expect(html).toContain('← Back to Game');
    for (const route of DEBUG_ROUTES) {
      expect(html).toContain(`href="${route.href}"`);
      expect(html).toContain(`data-testid="nav-${route.id}"`);
    }
    expect(html).toContain('Audio &amp; Narrator');
  });

  it('opens the audio lab at /debug/audio and marks it current', () => {
    const html = renderLabs('/debug/audio');
    expect(html).toContain('data-testid="audio-test-page"');
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="nav-audio"/);
  });

  it('opens the command center at /debug with quick links to every lab', () => {
    const html = renderLabs('/debug');
    expect(html).toContain('Debug Command Center');
    expect(html).toContain(`href="${DEBUG_AUDIO_PATH}"`);
    expect(html).not.toContain('is not a lab route');
  });

  it('serves the hardware bench at /debug/hardware and through the legacy URL', () => {
    for (const path of [DEBUG_HARDWARE_PATH, '/hardware-test']) {
      const html = renderLabs(path);
      expect(html, path).toContain('Glove monitor');
      expect(html, path).toMatch(/aria-current="page"[^>]*data-testid="nav-glove"/);
    }
  });

  it('serves the combined lab through the legacy /combined URL', () => {
    const html = renderLabs('/combined');
    expect(html).toContain('Dodge and cast');
    expect(html).toContain(DEBUG_COMBINED_PATH);
  });

  it('falls back to the command center for an unknown debug path', () => {
    const html = renderLabs('/debug/nope');
    expect(html).toContain('is not a lab route');
  });
});
