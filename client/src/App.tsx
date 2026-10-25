import { ELEMENT_META, P0_ELEMENTS, ROUND_TIMINGS_MS } from '@once-upon/shared';

export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-950 p-8 text-amber-50">
      <div className="max-w-lg space-y-4 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-amber-200/70">HackTX 2026</p>
        <h1 className="font-serif text-4xl">Once Upon a Memory</h1>
        <p className="text-amber-100/80">
          Phase 0 scaffold. The spell wheel is {P0_ELEMENTS.map((id) => ELEMENT_META[id].label).join(', ')}.
          A telegraph lasts {ROUND_TIMINGS_MS.telegraph} ms.
        </p>
      </div>
    </main>
  );
}
