import { Component, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { MockToolbar } from '@/net';

const routeLoaders = import.meta.glob(['./ui/AppRoutes.ts', './ui/AppRoutes.tsx']);
const combatLoaders = import.meta.glob(['./combat-ui/CombatLayer.ts', './combat-ui/CombatLayer.tsx']);

type ScreenModule = Record<string, unknown>;

function isComponent(value: unknown): value is ComponentType {
  if (typeof value === 'function') return true;
  return typeof value === 'object' && value !== null && '$$typeof' in value;
}

function pickComponent(mod: unknown, exportName: string): ComponentType | null {
  if (!mod || typeof mod !== 'object') return null;
  const record = mod as ScreenModule;
  for (const key of [exportName, 'default']) {
    const candidate = record[key];
    if (isComponent(candidate)) return candidate;
  }
  return null;
}

function useOptionalComponent(
  loaders: Record<string, () => Promise<unknown>>,
  exportName: string,
): { Component: ComponentType | null; pending: boolean } {
  const hasLoader = Object.keys(loaders).length > 0;
  const [Screen, setScreen] = useState<ComponentType | null>(null);
  const [pending, setPending] = useState(hasLoader);

  useEffect(() => {
    const load = Object.values(loaders)[0];
    if (!load) return undefined;
    let cancelled = false;
    load()
      .then((mod) => {
        if (cancelled) return;
        const next = pickComponent(mod, exportName);
        if (next) setScreen(() => next);
      })
      .catch(() => {
        // Teammate screens are optional until Agents 2B and 2C land.
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loaders, exportName]);

  return { Component: Screen, pending };
}

function StoryPlaceholder() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-parchment px-6 text-center text-ink">
      <h1 className="font-story text-5xl">Once Upon a Memory</h1>
    </main>
  );
}

class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error('Screen failed to render', error);
  }

  render() {
    if (this.state.failed) return <StoryPlaceholder />;
    return this.props.children;
  }
}

export default function App() {
  const routes = useOptionalComponent(routeLoaders, 'AppRoutes');
  const combat = useOptionalComponent(combatLoaders, 'CombatLayer');
  const waiting = routes.pending || combat.pending;
  const Routes = routes.Component;
  const Combat = combat.Component;
  const showPlaceholder = !waiting && !Routes && !Combat;

  return (
    <>
      <ScreenBoundary>
        {showPlaceholder ? <StoryPlaceholder /> : null}
        {Routes ? <Routes /> : null}
        {Combat ? <Combat /> : null}
      </ScreenBoundary>
      <MockToolbar />
    </>
  );
}
