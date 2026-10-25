export {
  BUTTON_CLICK_MAX_MS,
  DEFAULT_GLOVE_FRAME,
  GloveEdgeTracker,
  LineBufferProcessor,
  createIdleGloveEdges,
  detectGloveEdges,
  elementForDialSlot,
  isGloveCommand,
  normalizeGloveCommand,
  normalizeWireChunk,
  parseGloveSerialLine,
  serializeGloveCommand,
  spellReleasePower,
  toHardwareEvent,
} from './serialProtocol';
export type { DialChange, GloveEdgeClock, GloveEdges, SwipeRelease } from './serialProtocol';

export { GloveSoundSynthesizer } from './soundSynthesizer';

export {
  SERIAL_BRIDGE_URL,
  SIMULATOR_HOTKEYS,
  useGloveHardware,
  useGloveSerial,
} from './useGloveHardware';
export type {
  GloveHardwareController,
  HardwareConnectionStatus,
  HardwareLinkMode,
  UseGloveHardwareOptions,
} from './useGloveHardware';

export { GloveSimulatorPanel, GloveSimulatorWidget } from './GloveSimulatorPanel';
export type { GloveSimulatorPanelProps } from './GloveSimulatorPanel';

export { HARDWARE_TEST_PATH, HardwareTestPage } from './HardwareTestPage';
