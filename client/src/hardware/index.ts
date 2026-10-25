export {
  BUTTON_CLICK_MAX_MS,
  DEFAULT_GLOVE_FRAME,
  GLOVE_LCD_ELEMENT_RGB,
  GloveEdgeTracker,
  LineBufferProcessor,
  buildLcdCommand,
  buildWifiCommand,
  createIdleGloveEdges,
  detectGloveEdges,
  elementForDialSlot,
  fitLcdLine,
  isGloveCommand,
  normalizeGloveCommand,
  normalizeWireChunk,
  parseGloveSerialLine,
  parseGloveWifiStatus,
  previewGloveLcd,
  serializeGloveCommand,
  spellReleasePower,
  toHardwareEvent,
} from './serialProtocol';
export type {
  DialChange,
  GloveEdgeClock,
  GloveEdges,
  GloveLcdMessage,
  GloveLcdPreview,
  GloveWifiState,
  GloveWifiStatus,
  SwipeRelease,
} from './serialProtocol';

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
