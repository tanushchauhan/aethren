import { useEffect, useState, type ReactNode } from 'react';
import { getServerNow } from './clock';
import {
  ELEMENTS_P0,
  MAX_TEAM_HEARTS,
  ROUND_TIMINGS,
  type AttackTypeP0,
  type CombatPhase,
  type GameState,
  type HardwareEvent,
  type RoomPhase,
} from './contract';
import { useGameStore } from './store';

const ROOM_PHASES = [
  'lobby',
  'upload',
  'opening',
  'intro',
  'encounter',
  'boss',
  'ending',
  'defeat',
] as const satisfies readonly RoomPhase[];

const COMBAT_PHASES = ['telegraph', 'defense', 'return', 'team_turn', 'resolve'] as const satisfies readonly CombatPhase[];

const TELEGRAPHS = ['low_sweep', 'high_swing', 'projectile'] as const satisfies readonly AttackTypeP0[];

const TELEGRAPH_HINTS: Record<AttackTypeP0, string> = {
  low_sweep: 'Low sweep — step aside!',
  high_swing: 'High swing — duck!',
  projectile: 'Projectile — step aside!',
};

const HARDWARE_DEFAULT: HardwareEvent = {
  dialSlot: 0,
  buttonPressed: false,
  fistCharged: false,
  parryTriggered: false,
  colorToken: null,
  noiseLevel: 0,
  armed: false,
};

function ensureRoom(): void {
  const state = useGameStore.getState();
  if (state.gameState) return;
  state.quickStart(state.playerName || 'Dev', state.localRole ?? 'spellbearer');
}

function patchGame(partial: Partial<GameState>): void {
  ensureRoom();
  const gameState = useGameStore.getState().gameState;
  if (!gameState) return;
  useGameStore.setState({ gameState: { ...gameState, ...partial } });
}

function emitHardware(partial: Partial<HardwareEvent>): void {
  const current = useGameStore.getState().hardware ?? HARDWARE_DEFAULT;
  useGameStore.getState().sendHardware({ ...current, ...partial });
}

function fireTelegraph(attackType: AttackTypeP0): void {
  ensureRoom();
  const state = useGameStore.getState();
  const phase = state.gameState?.phase;
  const roomPhase = phase === 'boss' || phase === 'encounter' ? phase : 'encounter';
  state.setPhase(roomPhase, 'telegraph');
  const playerId = useGameStore.getState().localPlayerId ?? 'player-spellbearer';
  state.applyTelegraph({
    attackId: `mock-${attackType}-${Date.now()}`,
    attackType,
    targetPlayerIds: [playerId],
    impactServerMs: getServerNow() + ROUND_TIMINGS.telegraphMs,
    windowMs: ROUND_TIMINGS.defenseMs,
    narratorHint: TELEGRAPH_HINTS[attackType],
  });
}

export function MockToolbar() {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => getServerNow());
  const connection = useGameStore((state) => state.connection);
  const mockMode = useGameStore((state) => state.mockMode);
  const gameState = useGameStore((state) => state.gameState);
  const hardware = useGameStore((state) => state.hardware);
  const telegraph = useGameStore((state) => state.latestTelegraph);
  const lastError = useGameStore((state) => state.lastError);
  const offsetMs = useGameStore((state) => state.serverTimeOffsetMs);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '`') return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(getServerNow()), 100);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        className="fixed top-3 right-3 z-50 rounded-full border border-ink/30 bg-parchment-deep px-3 py-1 font-sans text-xs text-ink shadow"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label="Open mock toolbar"
      >
        Mock
      </button>
    );
  }

  const impactIn = telegraph ? Math.max(0, telegraph.impactServerMs - now) / 1000 : null;

  return (
    <aside className="fixed top-3 right-3 z-50 max-h-[85vh] w-80 overflow-y-auto rounded-lg border border-ink/20 bg-parchment-deep p-3 font-sans text-xs text-ink shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-sm font-semibold">Dev mock</h1>
        <button type="button" className="rounded border border-ink/20 px-2 py-0.5" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="mt-1 text-[10px] tracking-wide text-ink/60">Toggle with `</p>
      <p className="mt-2">
        {mockMode ? 'mock' : 'live'} · {connection}
        {gameState ? ` · ${gameState.roomCode} · ${gameState.phase}/${gameState.combatPhase}` : ''}
      </p>
      <p className="text-ink/70">offset {Math.round(offsetMs)}ms</p>
      {impactIn !== null ? (
        <p className="text-ember">
          {telegraph?.attackType} impact in {impactIn.toFixed(1)}s
        </p>
      ) : null}
      {gameState?.narratorCaption ? <p className="mt-1 line-clamp-2 text-ink/80">{gameState.narratorCaption}</p> : null}
      {lastError ? <p className="mt-1 text-ember">{lastError}</p> : null}

      <Section title="Connection">
        <ToolButton label="Connect" onClick={() => useGameStore.getState().connect()} />
        <ToolButton label="Disconnect" onClick={() => useGameStore.getState().disconnect()} />
        <ToolButton
          label={mockMode ? 'Mock on' : 'Mock off'}
          active={mockMode}
          onClick={() => useGameStore.setState({ mockMode: !mockMode })}
        />
      </Section>

      <Section title="Room phase">
        {ROOM_PHASES.map((phase) => (
          <ToolButton
            key={phase}
            label={phase}
            active={gameState?.phase === phase}
            onClick={() => {
              ensureRoom();
              useGameStore.getState().setPhase(phase);
            }}
          />
        ))}
      </Section>

      <Section title="Combat phase">
        {COMBAT_PHASES.map((phase) => (
          <ToolButton
            key={phase}
            label={phase}
            active={gameState?.combatPhase === phase}
            onClick={() => {
              ensureRoom();
              const roomPhase = useGameStore.getState().gameState?.phase ?? 'encounter';
              useGameStore.getState().setPhase(roomPhase, phase);
            }}
          />
        ))}
      </Section>

      <Section title="Telegraph">
        {TELEGRAPHS.map((attackType) => (
          <ToolButton key={attackType} label={attackType} onClick={() => fireTelegraph(attackType)} />
        ))}
      </Section>

      <Section title="Hearts">
        {Array.from({ length: MAX_TEAM_HEARTS + 1 }, (_, hearts) => (
          <ToolButton
            key={hearts}
            label={String(hearts)}
            active={gameState?.teamHearts === hearts}
            onClick={() => patchGame({ teamHearts: hearts, maxTeamHearts: MAX_TEAM_HEARTS })}
          />
        ))}
      </Section>

      <Section title="Ward and twin cast">
        <ToolButton
          label={gameState?.wardUp ? 'Ward up' : 'Ward down'}
          active={gameState?.wardUp === true}
          onClick={() => {
            ensureRoom();
            const current = useGameStore.getState().gameState;
            if (!current) return;
            const wardUp = !current.wardUp;
            useGameStore.setState({
              gameState: {
                ...current,
                wardUp,
                boss: current.boss ? { ...current.boss, wardUp } : current.boss,
              },
            });
          }}
        />
        {[0, 1, 2].map((meter) => (
          <ToolButton
            key={meter}
            label={`Twin ${meter}`}
            active={gameState?.twinCastMeter === meter}
            onClick={() => patchGame({ twinCastMeter: meter })}
          />
        ))}
        <ToolButton
          label={gameState?.tooLoud ? 'Too loud' : 'Mic clear'}
          active={gameState?.tooLoud === true}
          onClick={() => patchGame({ tooLoud: !useGameStore.getState().gameState?.tooLoud })}
        />
      </Section>

      <Section title="Narrator and cast">
        <ToolButton
          label="Narrator line"
          onClick={() => {
            ensureRoom();
            useGameStore.getState().applyNarrator({
              text: 'The story leans closer. Dodge when the lantern flares.',
              useBrowserTts: false,
            });
          }}
        />
        <ToolButton
          label="Cast ember thrust"
          onClick={() => {
            ensureRoom();
            const transcript =
              useGameStore.getState().gameState?.world?.incantations.ember ??
              'By the Corolla that would not start, burn!';
            useGameStore.getState().sendCast({
              element: 'ember',
              gesture: 'thrust',
              transcript,
              power: 1,
              serverTimestampMs: getServerNow(),
            });
          }}
        />
      </Section>

      <Section title="Hardware">
        {([0, 1, 2] as const).map((slot) => (
          <ToolButton
            key={slot}
            label={`Dial ${slot} ${ELEMENTS_P0[slot]}`}
            active={hardware?.dialSlot === slot}
            onClick={() => emitHardware({ dialSlot: slot })}
          />
        ))}
        <ToolButton
          label="Fist charged"
          active={hardware?.fistCharged === true}
          onClick={() => emitHardware({ fistCharged: !(hardware?.fistCharged ?? false) })}
        />
        <ToolButton
          label="Button"
          active={hardware?.buttonPressed === true}
          onClick={() => emitHardware({ buttonPressed: !(hardware?.buttonPressed ?? false) })}
        />
        <ToolButton
          label="Parry"
          active={hardware?.parryTriggered === true}
          onClick={() => emitHardware({ parryTriggered: !(hardware?.parryTriggered ?? false) })}
        />
        <ToolButton
          label="Armed"
          active={hardware?.armed === true}
          onClick={() => emitHardware({ armed: !(hardware?.armed ?? false) })}
        />
        {(['ember', 'frost', 'bloom', 'yellow'] as const).map((token) => (
          <ToolButton
            key={token}
            label={token}
            active={hardware?.colorToken === token}
            onClick={() => emitHardware({ colorToken: hardware?.colorToken === token ? null : token })}
          />
        ))}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3">
      <h2 className="mb-1 text-[10px] uppercase tracking-wider text-ink/60">{title}</h2>
      <div className="flex flex-wrap gap-1">{children}</div>
    </section>
  );
}

function ToolButton({ label, onClick, active = false }: { label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 ${active ? 'border-ink bg-ink text-parchment' : 'border-ink/20 bg-parchment hover:border-ember'}`}
    >
      {label}
    </button>
  );
}
