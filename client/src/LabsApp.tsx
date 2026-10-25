import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { CALIBRATION_DURATION_MS, ELEMENT_META, POSE_SEND_HZ, POSE_TRACK_HZ } from '@once-upon/shared';
import {
  GloveSimulatorPanel,
  HARDWARE_TEST_PATH,
  HardwareTestPage,
  useGloveHardware,
} from './hardware';
import {
  ArmRaiseHoldDetector,
  PoseLandmarkerService,
  SYNTHETIC_PRESET_LABEL,
  SYNTHETIC_PRESETS,
  VISION_TEST_PATH,
  VisionCanvas,
  VisionTestPage,
  WristVelocityTracker,
  checkInZone,
  classifyDodgeAndPose,
  computeCalibrationBaseline,
  resolveActiveAction,
  sampleSyntheticPose,
  type DodgeClassification,
  type SyntheticPosePreset,
  type VisionCanvasModel,
  type VisionSourceMode,
  type WristGesture,
} from './vision';

const COMBINED_PATH = '/combined';

const ROUTES = [
  { href: '/labs', label: 'Command' },
  { href: VISION_TEST_PATH, label: 'Vision' },
  { href: HARDWARE_TEST_PATH, label: 'Glove' },
  { href: COMBINED_PATH, label: 'Combined' },
] as const;

type AppRoute = (typeof ROUTES)[number]['href'];

type HomeLab = 'vision' | 'hardware' | 'both';

const PREVIEW_BASELINE = computeCalibrationBaseline(
  [sampleSyntheticPose('standing_in_zone', 0, { breathe: false })],
  0,
);

const IDLE_GESTURE: WristGesture = { action: 'none', power: 0, speed: 0, wrist: null };

const EMPTY_POSE: DodgeClassification = {
  isSideStepLeft: false,
  isSideStepRight: false,
  isDucking: false,
  isRightArmRaised: false,
  confidence: 0,
};

function canonicalPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '');
  return pathname || '/';
}

function matchRoute(pathname: string): AppRoute | null {
  const path = canonicalPath(pathname);
  return ROUTES.some((route) => route.href === path) ? (path as AppRoute) : null;
}

function navigate(href: string): void {
  if (canonicalPath(window.location.pathname) === href) return;
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function onNavigate(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(href);
}

function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return pathname;
}

export default function App() {
  const pathname = usePathname();
  const route = matchRoute(pathname);

  return (
    <div className="min-h-screen bg-stone-950 text-amber-50">
      <header className="sticky top-0 z-50 border-b border-amber-100/10 bg-stone-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <a href="/labs" onClick={(event) => onNavigate(event, '/labs')} className="group">
            <p className="text-[10px] uppercase tracking-[0.28em] text-amber-200/70">Once Upon a Memory</p>
            <p className="font-serif text-lg leading-tight group-hover:text-amber-100">Teammate 3</p>
          </a>
          <nav aria-label="Teammate 3 labs" data-testid="app-nav" className="flex flex-wrap gap-1">
            {ROUTES.map((item) => {
              const active = route === item.href;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                  onClick={(event) => onNavigate(event, item.href)}
                  className={
                    active
                      ? 'rounded-full bg-amber-200 px-3 py-1.5 text-sm font-medium text-stone-950'
                      : 'rounded-full px-3 py-1.5 text-sm text-amber-100/80 hover:bg-white/5 hover:text-amber-50'
                  }
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        </div>
      </header>

      {route === VISION_TEST_PATH ? <VisionTestPage /> : null}
      {route === HARDWARE_TEST_PATH ? <HardwareTestPage /> : null}
      {route === COMBINED_PATH ? <CombinedLab /> : null}
      {route === '/labs' ? <CommandCenter /> : null}
      {route === null ? <CommandCenter unmatchedPath={canonicalPath(pathname)} /> : null}
    </div>
  );
}

function CommandCenter({ unmatchedPath }: { unmatchedPath?: string }) {
  const [lab, setLab] = useState<HomeLab>('both');

  return (
    <div>
      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {unmatchedPath ? (
          <p className="mb-4 rounded-2xl border border-amber-200/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100" role="status">
            <span className="font-mono">{unmatchedPath}</span> is not a lab route. The command center is open instead.
          </p>
        ) : null}
        <p className="text-xs uppercase tracking-[0.32em] text-amber-200/70">HackTX 2026 · Laptop A</p>
        <h1 className="mt-2 max-w-3xl font-serif text-4xl sm:text-5xl">Teammate 3 Command Center</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-amber-100/80">
          Combined Vision and Enchanted Glove lab. Switch the full diagnostic pages here, or open a route when the
          Spellbearer wants the pose camera and the Grove glove on their own.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <QuickLink
            href={VISION_TEST_PATH}
            title="Vision test"
            body="Webcam or cloud puppet, zone box, dodge badges, and the spell-wheel arm raise."
          />
          <QuickLink
            href={HARDWARE_TEST_PATH}
            title="Enchanted Glove bench"
            body="Grove port map, Web Serial, the local bridge, and the keyboard simulator."
          />
          <QuickLink
            href={COMBINED_PATH}
            title="Combined spellbearer"
            body="Full-body dodge on the vision canvas beside live glove casting."
          />
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-serif text-2xl">View on this page</h2>
          <div role="tablist" aria-label="Labs on the command center" className="flex flex-wrap gap-2">
            <LabTab id="vision" current={lab} onSelect={setLab} label="Vision" />
            <LabTab id="hardware" current={lab} onSelect={setLab} label="Enchanted Glove" />
            <LabTab id="both" current={lab} onSelect={setLab} label="Both" />
          </div>
        </div>
      </section>

      <div className="flex flex-col">
        {lab === 'vision' || lab === 'both' ? <VisionTestPage /> : null}
        {lab === 'hardware' || lab === 'both' ? <HardwareTestPage /> : null}
      </div>
    </div>
  );
}

function LabTab({
  id,
  current,
  onSelect,
  label,
}: {
  id: HomeLab;
  current: HomeLab;
  onSelect: (next: HomeLab) => void;
  label: string;
}) {
  const selected = current === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-testid={`home-lab-${id}`}
      onClick={() => onSelect(id)}
      className={
        selected
          ? 'rounded-full border border-amber-200 bg-amber-200 px-3 py-1.5 text-sm font-medium text-stone-950'
          : 'rounded-full border border-amber-100/20 px-3 py-1.5 text-sm text-amber-50 hover:bg-white/5'
      }
    >
      {label}
    </button>
  );
}

function QuickLink({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <a
      href={href}
      onClick={(event) => onNavigate(event, href)}
      className="rounded-3xl border border-amber-100/15 bg-white/5 p-4 transition hover:border-amber-200/40 hover:bg-white/10"
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-amber-200/70">{href}</p>
      <h2 className="mt-2 font-serif text-xl">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-amber-100/75">{body}</p>
    </a>
  );
}

function initialCombinedModel(): VisionCanvasModel {
  const landmarks = sampleSyntheticPose('standing_in_zone', 0, { breathe: false });
  const zone = PREVIEW_BASELINE ? checkInZone(landmarks, PREVIEW_BASELINE) : { inZone: false, overlapScore: 0 };
  return {
    source: 'synthetic',
    landmarks,
    baseline: PREVIEW_BASELINE,
    calibrated: false,
    inZone: zone.inZone,
    overlapScore: zone.overlapScore,
    activeAction: 'none',
    calibrationMs: 0,
    calibrating: false,
    streamHz: POSE_SEND_HZ,
    streamPulse: 0,
    teammatePoses: [],
    armHoldMs: 0,
    armCounting: false,
    confidence: 1,
    actionNote: '',
  };
}

function actionNoteFor(gesture: WristGesture, armHeldMs: number, counting: boolean): string {
  if (gesture.action === 'swipe_left') return 'LEFT';
  if (gesture.action === 'swipe_right') return 'RIGHT';
  if (gesture.action === 'thrust') return `${gesture.power.toFixed(2)}×`;
  if (counting) return `${(armHeldMs / 1000).toFixed(1)}s`;
  return '';
}

function CombinedLab() {
  const hardware = useGloveHardware();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<PoseLandmarkerService | null>(null);
  if (serviceRef.current === null) serviceRef.current = new PoseLandmarkerService();

  const trackerRef = useRef(new WristVelocityTracker());
  const armRef = useRef(new ArmRaiseHoldDetector());
  const baselineRef = useRef(PREVIEW_BASELINE);
  const calibratedRef = useRef(false);
  const calibratingRef = useRef(false);
  const calibrationStartedRef = useRef(0);
  const samplesRef = useRef<ReturnType<typeof sampleSyntheticPose>[]>([]);
  const modeRef = useRef<VisionSourceMode>('synthetic');
  const fallbackRef = useRef<string | null>(null);

  const [requestedMode, setRequestedMode] = useState<VisionSourceMode>('synthetic');
  const [statusMode, setStatusMode] = useState<VisionSourceMode>('synthetic');
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [model, setModel] = useState<VisionCanvasModel>(initialCombinedModel);
  const [preset, setPreset] = useState<SyntheticPosePreset>('standing_in_zone');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const service = serviceRef.current;
    if (!video || !service) return;
    let cancelled = false;
    setStarting(true);
    void service.start(video, requestedMode).then(() => {
      if (cancelled) return;
      const next = service.getStatus();
      modeRef.current = next.mode;
      setStatusMode(next.mode);
      setFallbackReason(next.fallbackReason);
      setStarting(false);
    });
    return () => {
      cancelled = true;
      service.stop();
    };
  }, [requestedMode]);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;
    let raf = 0;
    let lastDetect = 0;
    let lastStream = 0;
    let streamPulse = 0;
    const detectStep = 1000 / POSE_TRACK_HZ;
    const streamStep = 1000 / POSE_SEND_HZ;

    const tick = (now: number): void => {
      if (now - lastDetect >= detectStep) {
        lastDetect = now;
        const landmarks = service.sample(now);
        const baseline = baselineRef.current ?? PREVIEW_BASELINE;
        const pose = landmarks && baseline ? classifyDodgeAndPose(landmarks, baseline) : EMPTY_POSE;
        const zone = landmarks && baseline ? checkInZone(landmarks, baseline) : { inZone: false, overlapScore: 0 };
        const gesture = landmarks ? trackerRef.current.update(landmarks, now) : IDLE_GESTURE;
        const arm = armRef.current.update(pose.isRightArmRaised, now);

        if (calibratingRef.current && landmarks) {
          samplesRef.current.push(landmarks);
          const elapsed = now - calibrationStartedRef.current;
          if (elapsed >= CALIBRATION_DURATION_MS) {
            const measured = computeCalibrationBaseline(samplesRef.current, now);
            calibratingRef.current = false;
            if (measured) {
              baselineRef.current = measured;
              calibratedRef.current = true;
            }
          }
        }

        if (now - lastStream >= streamStep) {
          lastStream = now;
          streamPulse += 1;
        }

        const liveStatus = service.getStatus();
        if (liveStatus.mode !== modeRef.current || liveStatus.fallbackReason !== fallbackRef.current) {
          modeRef.current = liveStatus.mode;
          fallbackRef.current = liveStatus.fallbackReason;
          setStatusMode(liveStatus.mode);
          setFallbackReason(liveStatus.fallbackReason);
        }

        const calibrationMs = calibratingRef.current
          ? Math.min(CALIBRATION_DURATION_MS, now - calibrationStartedRef.current)
          : calibratedRef.current
            ? CALIBRATION_DURATION_MS
            : 0;

        setModel({
          source: liveStatus.mode,
          landmarks,
          baseline,
          calibrated: calibratedRef.current,
          inZone: zone.inZone,
          overlapScore: zone.overlapScore,
          activeAction: resolveActiveAction(pose, gesture, pose.isRightArmRaised),
          calibrationMs,
          calibrating: calibratingRef.current,
          streamHz: POSE_SEND_HZ,
          streamPulse,
          teammatePoses: [],
          armHoldMs: arm.heldMs,
          armCounting: arm.counting,
          confidence: pose.confidence,
          actionNote: actionNoteFor(gesture, arm.heldMs, arm.counting),
        });
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function beginCalibration(): void {
    const service = serviceRef.current;
    if (service && service.getStatus().mode === 'synthetic') {
      service.setPreset('standing_in_zone', performance.now(), true);
      setPreset('standing_in_zone');
    }
    samplesRef.current = [];
    calibrationStartedRef.current = performance.now();
    calibratingRef.current = true;
    trackerRef.current.reset();
  }

  function choosePreset(next: SyntheticPosePreset): void {
    setPreset(next);
    serviceRef.current?.setPreset(next, performance.now());
    trackerRef.current.reset();
  }

  const puppetLive = statusMode === 'synthetic';
  const locked = hardware.lockedElement ? ELEMENT_META[hardware.lockedElement].label : 'unlocked';
  const cast = hardware.lastRelease
    ? `${hardware.lastRelease.direction} · ${hardware.lastRelease.power.toFixed(2)}×`
    : 'waiting for a swipe or thrust';

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <p className="text-xs uppercase tracking-[0.32em] text-amber-200/70">Spellbearer · {COMBINED_PATH}</p>
      <h1 className="mt-2 font-serif text-4xl sm:text-5xl">Dodge and cast</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-amber-100/80">
        The body on the left answers a telegraph. The Enchanted Glove on the right turns the wheel, charges a fist,
        and releases the spell. Both run at once.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-full border border-amber-100/20 px-3 py-1" data-testid="combined-dodge">
          Dodge {model.activeAction === 'none' ? 'idle' : model.activeAction.replaceAll('_', ' ')}
        </span>
        <span className="rounded-full border border-amber-100/20 px-3 py-1" data-testid="combined-cast">
          Glove {locked} · {cast}
        </span>
        <span className="rounded-full border border-emerald-200/30 bg-emerald-300/10 px-3 py-1 text-emerald-50">
          {hardware.frame.armed ? 'Glove armed' : 'Glove disarmed'}
        </span>
      </div>

      {fallbackReason ? (
        <p className="mt-4 rounded-2xl border border-amber-200/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100" role="status">
          {fallbackReason}
        </p>
      ) : null}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <section className="space-y-4">
          <VisionCanvas model={model} videoRef={videoRef} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={chipClass(requestedMode === 'webcam')}
              onClick={() => setRequestedMode('webcam')}
              disabled={starting}
            >
              Live Webcam
            </button>
            <button
              type="button"
              className={chipClass(requestedMode === 'synthetic')}
              onClick={() => setRequestedMode('synthetic')}
              disabled={starting}
            >
              Synthetic Puppet
            </button>
            <button
              type="button"
              className="rounded-full bg-amber-200 px-3 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
              onClick={beginCalibration}
              disabled={model.calibrating}
            >
              {model.calibrating ? 'Hold still…' : 'Calibrate 3s'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {SYNTHETIC_PRESETS.map((item) => (
              <button
                key={item}
                type="button"
                className={chipClass(preset === item)}
                onClick={() => choosePreset(item)}
                disabled={!puppetLive}
              >
                {SYNTHETIC_PRESET_LABEL[item]}
              </button>
            ))}
          </div>
        </section>
        <GloveSimulatorPanel hardware={hardware} placement="dock" />
      </div>
    </main>
  );
}

function chipClass(active: boolean): string {
  return active
    ? 'rounded-full border border-emerald-200/50 bg-emerald-300/20 px-3 py-2 text-sm text-emerald-50 disabled:opacity-40'
    : 'rounded-full border border-amber-100/20 bg-white/5 px-3 py-2 text-sm text-amber-50 disabled:opacity-40';
}
