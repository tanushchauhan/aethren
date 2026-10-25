import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ACCEL_POWER,
  FIST_CHARGE_MULTIPLIER,
  NOISE_TOO_LOUD_THRESHOLD,
  P0_ELEMENTS,
} from '@once-upon/shared';
import type { GloveSensorFrame } from '@once-upon/shared';
import { GloveSimulatorPanel } from '../GloveSimulatorPanel';
import { HARDWARE_TEST_PATH, HardwareTestPage } from '../HardwareTestPage';
import {
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
  normalizeWireChunk,
  parseGloveSerialLine,
  parseGloveWifiStatus,
  previewGloveLcd,
  serializeGloveCommand,
  spellReleasePower,
  toHardwareEvent,
  type GloveWifiStatus,
} from '../serialProtocol';
import { SERIAL_BRIDGE_URL, type GloveHardwareController } from '../useGloveHardware';

const SAMPLE =
  '{"dial":1,"btn":1,"fist":true,"swipe":"thrust","accel":1.35,"parry":false,"armed":true,"noise":310,"color":"ember"}';
/** A line captured from the flashed 7-part Uno R4 WiFi. */
const FIRMWARE_SAMPLE =
  '{"dial":2,"btn":0,"btn2":0,"fist":false,"swipe":"none","accel":1.00,"parry":false,"armed":true,"noise":0,"color":"none","d3":0,"d4":0,"d8":0,"rawDial":1021}';

function frame(patch: Partial<GloveSensorFrame> = {}): GloveSensorFrame {
  return { ...DEFAULT_GLOVE_FRAME, ...patch };
}

describe('parseGloveSerialLine', () => {
  it('parses the 50 Hz firmware line', () => {
    expect(parseGloveSerialLine(SAMPLE)).toEqual({
      dial: 1,
      btn: 1,
      fist: true,
      swipe: 'thrust',
      accel: 1.35,
      parry: false,
      armed: true,
      noise: 310,
      color: 'ember',
    });
  });

  it('trims whitespace and accepts a boolean button', () => {
    const line = `  ${SAMPLE.replace('"btn":1', '"btn":false')} \r`;
    expect(parseGloveSerialLine(line)?.btn).toBe(0);
    expect(parseGloveSerialLine(SAMPLE.replace('"btn":1', '"btn":true'))?.btn).toBe(1);
  });

  it('clamps dial, accel, noise, and button into range', () => {
    const high = parseGloveSerialLine(
      '{"dial":9,"btn":4,"fist":true,"swipe":"left","accel":4,"parry":false,"armed":true,"noise":5000,"color":"boss"}',
    );
    expect(high).toMatchObject({ dial: 2, btn: 1, accel: ACCEL_POWER.max, noise: 1023, color: 'boss' });

    const low = parseGloveSerialLine(
      '{"dial":-4,"btn":-1,"fist":false,"swipe":"right","accel":0.2,"parry":true,"armed":false,"noise":-20,"color":"frost"}',
    );
    expect(low).toMatchObject({ dial: 0, btn: 0, accel: ACCEL_POWER.min, noise: 0, armed: false });
  });

  it('ignores boot text, partial lines, and frames with bad types or enums', () => {
    expect(parseGloveSerialLine('')).toBeNull();
    expect(parseGloveSerialLine('Grove Base Shield ready')).toBeNull();
    expect(parseGloveSerialLine('{"dial":1')).toBeNull();
    expect(parseGloveSerialLine('{"dial":1}')).toBeNull();
    expect(parseGloveSerialLine('null')).toBeNull();
    expect(parseGloveSerialLine('[1,2,3]')).toBeNull();
    expect(parseGloveSerialLine(SAMPLE.replace('"swipe":"thrust"', '"swipe":"up"'))).toBeNull();
    expect(parseGloveSerialLine(SAMPLE.replace('"color":"ember"', '"color":"red"'))).toBeNull();
    expect(parseGloveSerialLine(SAMPLE.replace('"fist":true', '"fist":1'))).toBeNull();
    expect(parseGloveSerialLine(SAMPLE.replace('"dial":1', '"dial":"1"'))).toBeNull();
    expect(parseGloveSerialLine('{"msg":"ready"}')).toBeNull();
  });

  it('keeps unknown extra fields from rejecting a valid frame', () => {
    expect(parseGloveSerialLine(`${SAMPLE.slice(0, -1)},"debug":1}`)?.dial).toBe(1);
  });

  it('reads the 7-part pin fields from the firmware frame', () => {
    expect(parseGloveSerialLine(FIRMWARE_SAMPLE)).toEqual({
      dial: 2,
      btn: 0,
      btn2: 0,
      fist: false,
      swipe: 'none',
      accel: 1,
      parry: false,
      armed: true,
      noise: 0,
      color: 'none',
      d3: 0,
      d4: 0,
      d8: 0,
      rawDial: 1021,
    });
  });

  it('clamps the pin fields and drops malformed ones without rejecting the frame', () => {
    const parsed = parseGloveSerialLine(`${SAMPLE.slice(0, -1)},"btn2":3,"d3":1,"d4":"x","d8":-2,"rawDial":4000}`);
    expect(parsed).toMatchObject({ btn2: 1, d3: 1, d8: 0, rawDial: 1023 });
    expect(parsed).not.toHaveProperty('d4');
    expect(parseGloveSerialLine(SAMPLE)).not.toHaveProperty('btn2');
  });
});

describe('parseGloveWifiStatus', () => {
  it('reads the board status line and ignores frames', () => {
    expect(
      parseGloveWifiStatus('{"event":"wifi","status":"connected","ssid":"Glove","ip":"172.20.10.4","port":4210}'),
    ).toEqual({ status: 'connected', ssid: 'Glove', ip: '172.20.10.4', port: 4210 });
    expect(parseGloveWifiStatus('{"event":"wifi","status":"off","ssid":"","ip":"0.0.0.0","port":4210}')?.status).toBe('off');
    expect(parseGloveWifiStatus('{"event":"wifi","status":"bogus"}')).toBeNull();
    expect(parseGloveWifiStatus(FIRMWARE_SAMPLE)).toBeNull();
    expect(parseGloveWifiStatus('not json')).toBeNull();
  });

  it('is routed out of the line buffer without becoming a frame', () => {
    const seen: GloveWifiStatus[] = [];
    const processor = new LineBufferProcessor((status) => seen.push(status));
    const frames = processor.push(
      `${FIRMWARE_SAMPLE}\n{"event":"wifi","status":"joining","ssid":"Glove","ip":"0.0.0.0","port":4210}\n${FIRMWARE_SAMPLE}\n`,
    );
    expect(frames).toHaveLength(2);
    expect(seen).toEqual([{ status: 'joining', ssid: 'Glove', ip: '0.0.0.0', port: 4210 }]);
  });
});

describe('LineBufferProcessor', () => {
  it('reassembles a frame split across Uint8Array chunks', () => {
    const processor = new LineBufferProcessor();
    const bytes = new TextEncoder().encode(`${SAMPLE}\n`);
    const split = 17;
    expect(processor.push(bytes.slice(0, split))).toEqual([]);
    expect(processor.pending().length).toBeGreaterThan(0);
    expect(processor.push(bytes.slice(split))).toEqual([parseGloveSerialLine(SAMPLE)]);
    expect(processor.pending()).toBe('');
  });

  it('parses string chunks, CRLF, and several frames in one push', () => {
    const processor = new LineBufferProcessor();
    const second = SAMPLE.replace('"dial":1', '"dial":2');
    const chunk = `${SAMPLE}\r\nboot noise\n${second}\n`;
    const frames = processor.push(chunk);
    expect(frames.map((item) => item.dial)).toEqual([1, 2]);
  });

  it('does not let a partial or malformed line desync the next frame', () => {
    const processor = new LineBufferProcessor();
    expect(processor.push('{"dial":1')).toEqual([]);
    expect(processor.push('}\n')).toEqual([]);
    expect(processor.push('not json\n')).toEqual([]);
    expect(processor.push(`${SAMPLE}\n`)[0]?.color).toBe('ember');
  });

  it('drops a runaway buffer and still reads the following line', () => {
    const processor = new LineBufferProcessor();
    expect(processor.push('x'.repeat(5000))).toEqual([]);
    expect(processor.pending()).toBe('');
    expect(processor.push(`${SAMPLE}\n`)).toHaveLength(1);
  });

  it('treats a complete bridge message without a newline as one frame', () => {
    const processor = new LineBufferProcessor();
    expect(normalizeWireChunk(SAMPLE)).toBe(`${SAMPLE}\n`);
    expect(normalizeWireChunk('{"dial":1')).toBe('{"dial":1');
    expect(processor.push(normalizeWireChunk(SAMPLE))[0]?.swipe).toBe('thrust');
  });

  it('resets pending bytes', () => {
    const processor = new LineBufferProcessor();
    processor.push('{"dial":');
    processor.reset();
    expect(processor.pending()).toBe('');
    expect(processor.push(`${SAMPLE}\n`)).toHaveLength(1);
  });
});

describe('serializeGloveCommand', () => {
  it('writes newline-terminated glove and socket commands', () => {
    expect(serializeGloveCommand({ cmd: 'buzz', p: 'cast' })).toBe('{"cmd":"buzz","p":"cast"}\n');
    expect(serializeGloveCommand({ cmd: 'servo', open: true })).toBe('{"cmd":"servo","open":true}\n');
    expect(serializeGloveCommand({ cmd: 'servo', open: false })).toBe('{"cmd":"servo","open":false}\n');
    expect(serializeGloveCommand({ type: 'buzz', pattern: 'fizzle' })).toBe('{"cmd":"buzz","p":"fizzle"}\n');
    expect(serializeGloveCommand({ type: 'buzz', pattern: 'hit' })).toBe('{"cmd":"buzz","p":"hit"}\n');
    expect(serializeGloveCommand({ type: 'buzz', pattern: 'tick' })).toBe('{"cmd":"buzz","p":"tick"}\n');
    expect(serializeGloveCommand({ type: 'servo', servoOpen: true })).toBe('{"cmd":"servo","open":true}\n');
    expect(serializeGloveCommand({ type: 'servo', servoOpen: false })).toBe('{"cmd":"servo","open":false}\n');
    expect(serializeGloveCommand({ type: 'buzz' })).toBe('{"cmd":"buzz","p":"tick"}\n');
    expect(serializeGloveCommand({ type: 'servo' })).toBe('{"cmd":"servo","open":false}\n');
  });

  it('writes the arm, hello, lcd, and wifi commands the 7-part firmware accepts', () => {
    expect(serializeGloveCommand({ cmd: 'arm', open: false })).toBe('{"cmd":"arm","open":false}\n');
    expect(serializeGloveCommand({ cmd: 'hello' })).toBe('{"cmd":"hello"}\n');
    expect(serializeGloveCommand({ cmd: 'lcd', l1: 'WARD SHATTERED!', l2: 'TWIN CAST 2.0x', r: 255, g: 215, b: 0 })).toBe(
      '{"cmd":"lcd","l1":"WARD SHATTERED!","l2":"TWIN CAST 2.0x","r":255,"g":215,"b":0}\n',
    );
    expect(serializeGloveCommand({ cmd: 'lcd' })).toBe('{"cmd":"lcd","l1":"","l2":""}\n');
    expect(serializeGloveCommand({ cmd: 'wifi', ssid: 'Glove', pass: 'spellbook' })).toBe(
      '{"cmd":"wifi","ssid":"Glove","pass":"spellbook"}\n',
    );
    expect(serializeGloveCommand({ cmd: 'wifi' })).toBe('{"cmd":"wifi"}\n');
  });
});

describe('LCD and Wi-Fi helpers', () => {
  it('fits a line to 16 printable ASCII characters like the board', () => {
    expect(fitLcdLine('HELLO')).toBe('HELLO');
    expect(fitLcdLine('ABCDEFGHIJKLMNOPQRST')).toBe('ABCDEFGHIJKLMNOP');
    expect(fitLcdLine('café ✨')).toBe('caf? ?');
  });

  it('builds an lcd command with clamped RGB and an optional hold time', () => {
    expect(buildLcdCommand({ l1: 'HI', l2: 'THERE', rgb: [300, -5, 80.4] })).toEqual({
      cmd: 'lcd',
      l1: 'HI',
      l2: 'THERE',
      r: 255,
      g: 0,
      b: 80,
    });
    expect(buildLcdCommand({ l1: 'STAY', l2: '', ms: 0 })).toEqual({ cmd: 'lcd', l1: 'STAY', l2: '', ms: 0 });
  });

  it('builds a wifi join, or a status request when the SSID is blank', () => {
    expect(buildWifiCommand('  Glove  ', 'pw')).toEqual({ cmd: 'wifi', ssid: 'Glove', pass: 'pw' });
    expect(buildWifiCommand('Glove', '')).toEqual({ cmd: 'wifi', ssid: 'Glove', pass: '' });
    expect(buildWifiCommand('   ', 'pw')).toEqual({ cmd: 'wifi' });
    expect(buildWifiCommand('x'.repeat(40), 'y'.repeat(80))).toEqual({ cmd: 'wifi', ssid: 'x'.repeat(32), pass: 'y'.repeat(63) });
  });

  it('previews the forearm LCD with the firmware line priorities', () => {
    const idle = previewGloveLcd(frame({ dial: 1 }));
    expect(idle.lines).toEqual(['WHEEL: FROST    ', 'D4:TALK  D8:LOCK']);
    expect(idle.rgb).toEqual(GLOVE_LCD_ELEMENT_RGB.frost);

    expect(previewGloveLcd(frame({ dial: 0 }), { lockedElement: 'ember' }).lines[0]).toBe('LOCKED: EMBER * ');
    expect(previewGloveLcd(frame({ btn: 1 })).lines[1]).toBe('>> SPEAKING <<  ');
    expect(previewGloveLcd(frame({ parry: true, btn: 1 })).lines[1]).toBe('!! PARRY !!     ');
    expect(previewGloveLcd(frame({ fist: true })).lines[1]).toBe('CHARGED 1.25x   ');
    expect(previewGloveLcd(frame({ armed: false })).lines[1]).toBe('DISARMED        ');

    const custom = previewGloveLcd(frame(), { custom: { l1: 'WARD SHATTERED!', l2: 'TWIN CAST', rgb: [255, 215, 0] } });
    expect(custom.lines).toEqual(['WARD SHATTERED! ', 'TWIN CAST       ']);
    expect(custom.rgb).toEqual([255, 215, 0]);
    expect(previewGloveLcd(frame({ parry: true }), { custom: { l1: 'A', l2: 'B' } }).lines[1]).toBe('!! PARRY !!     ');
  });
});

describe('toHardwareEvent', () => {
  it('maps a raw frame onto the socket snapshot', () => {
    expect(toHardwareEvent(frame({ dial: 1, btn: 1, fist: true, parry: false, color: 'ember', noise: 310 }))).toEqual({
      dialSlot: 1,
      buttonPressed: true,
      fistCharged: true,
      parryTriggered: false,
      colorToken: 'ember',
      noiseLevel: 310,
      armed: true,
    });
  });

  it('turns an empty token well into null and a released button into false', () => {
    expect(toHardwareEvent(frame({ btn: 0, color: 'none' })).colorToken).toBeNull();
    expect(toHardwareEvent(frame({ btn: 0 })).buttonPressed).toBe(false);
    expect(toHardwareEvent(frame({ color: 'boss' })).colorToken).toBe('boss');
  });
});

describe('elementForDialSlot', () => {
  it('follows the P0 wheel', () => {
    expect(P0_ELEMENTS).toEqual(['ember', 'frost', 'bloom']);
    expect(elementForDialSlot(0)).toBe('ember');
    expect(elementForDialSlot(1)).toBe('frost');
    expect(elementForDialSlot(2)).toBe('bloom');
    expect(elementForDialSlot(3)).toBeNull();
  });
});

describe('detectGloveEdges', () => {
  it('gates every semantic signal while the glove is disarmed', () => {
    const prev = frame({ dial: 0, btn: 1, parry: false, swipe: 'none', color: 'none', noise: 10, armed: true });
    const next = frame({
      dial: 2,
      btn: 0,
      fist: true,
      swipe: 'left',
      accel: 1.5,
      parry: true,
      color: 'boss',
      noise: 900,
      armed: false,
    });
    expect(detectGloveEdges(prev, next, { nowMs: 400, buttonDownAtMs: 0, pushToTalkActive: true })).toEqual(
      createIdleGloveEdges(),
    );
  });

  it('reports dial slot transitions and their elements', () => {
    expect(detectGloveEdges(frame({ dial: 0 }), frame({ dial: 1 })).dialChanged).toEqual({
      slot: 1,
      element: 'frost',
    });
    expect(detectGloveEdges(frame({ dial: 1 }), frame({ dial: 2 })).dialChanged).toEqual({
      slot: 2,
      element: 'bloom',
    });
    expect(detectGloveEdges(frame({ dial: 2 }), frame({ dial: 0 })).dialChanged?.element).toBe('ember');
    expect(detectGloveEdges(frame({ dial: 1 }), frame({ dial: 1 })).dialChanged).toBeNull();
    expect(detectGloveEdges(null, frame({ dial: 2 })).dialChanged).toBeNull();
  });

  it('locks on the D8 Button 2 rising edge only', () => {
    expect(detectGloveEdges(frame({ btn2: 0 }), frame({ btn2: 1 })).lockPressed).toBe(true);
    expect(detectGloveEdges(frame({ btn2: 1 }), frame({ btn2: 1 })).lockPressed).toBe(false);
    expect(detectGloveEdges(frame({ btn2: 1 }), frame({ btn2: 0 })).lockPressed).toBe(false);
    expect(detectGloveEdges(frame(), frame({ btn2: 1 })).lockPressed).toBe(true);
    expect(detectGloveEdges(null, frame({ btn2: 1 })).lockPressed).toBe(false);
    expect(detectGloveEdges(frame({ btn2: 0 }), frame({ btn2: 1, armed: false })).lockPressed).toBe(false);
  });

  it('fires a parry only on the rising edge', () => {
    expect(detectGloveEdges(frame({ parry: false }), frame({ parry: true })).parryTriggered).toBe(true);
    expect(detectGloveEdges(frame({ parry: true }), frame({ parry: true })).parryTriggered).toBe(false);
    expect(detectGloveEdges(frame({ parry: true }), frame({ parry: false })).parryTriggered).toBe(false);
    expect(detectGloveEdges(null, frame({ parry: true })).parryTriggered).toBe(false);
  });

  it('releases a swipe with accel power, then fist charge', () => {
    const plain = detectGloveEdges(frame({ swipe: 'none', accel: 1.2, fist: false }), frame({ swipe: 'left', accel: 1.2, fist: false }));
    expect(plain.swipeReleased).toEqual({ direction: 'left', power: spellReleasePower(frame({ accel: 1.2, fist: false })) });
    expect(plain.swipeReleased?.power).toBeCloseTo(1.2, 5);

    const charged = detectGloveEdges(
      frame({ swipe: 'none', accel: 1.35, fist: true }),
      frame({ swipe: 'thrust', accel: 1.35, fist: true }),
    );
    expect(charged.swipeReleased?.direction).toBe('thrust');
    expect(charged.swipeReleased?.power).toBeCloseTo(1.35 * FIST_CHARGE_MULTIPLIER, 5);
    expect(spellReleasePower({ accel: 9, fist: true })).toBeCloseTo(ACCEL_POWER.max * FIST_CHARGE_MULTIPLIER, 5);
    expect(spellReleasePower({ accel: 0, fist: false })).toBeCloseTo(ACCEL_POWER.min, 5);

    expect(detectGloveEdges(frame({ swipe: 'left' }), frame({ swipe: 'left' })).swipeReleased).toBeNull();
    expect(detectGloveEdges(frame({ swipe: 'left' }), frame({ swipe: 'right' })).swipeReleased?.direction).toBe('right');
    expect(detectGloveEdges(frame({ swipe: 'thrust' }), frame({ swipe: 'none' })).swipeReleased).toBeNull();
    expect(detectGloveEdges(null, frame({ swipe: 'thrust' })).swipeReleased).toBeNull();
  });

  it('reports a new color token, including clearing the well', () => {
    expect(detectGloveEdges(frame({ color: 'none' }), frame({ color: 'ember' })).colorTokenChanged).toBe('ember');
    expect(detectGloveEdges(frame({ color: 'ember' }), frame({ color: 'ember' })).colorTokenChanged).toBeNull();
    expect(detectGloveEdges(frame({ color: 'frost' }), frame({ color: 'none' })).colorTokenChanged).toBe('none');
    expect(detectGloveEdges(null, frame({ color: 'boss' })).colorTokenChanged).toBeNull();
  });

  it('raises the room-noise flag at the shared threshold while armed', () => {
    expect(NOISE_TOO_LOUD_THRESHOLD).toBe(450);
    expect(detectGloveEdges(frame({ noise: 449 }), frame({ noise: 449 })).isRoomTooLoud).toBe(false);
    expect(detectGloveEdges(frame({ noise: 100 }), frame({ noise: 450 })).isRoomTooLoud).toBe(true);
    expect(detectGloveEdges(null, frame({ noise: 1023 })).isRoomTooLoud).toBe(true);
    expect(detectGloveEdges(frame({ noise: 900, armed: true }), frame({ noise: 900, armed: false })).isRoomTooLoud).toBe(false);
  });

  it('splits a short click from a push-to-talk hold', () => {
    expect(BUTTON_CLICK_MAX_MS).toBe(250);
    const clock = { nowMs: 200, buttonDownAtMs: 0, pushToTalkActive: false };
    const tap = detectGloveEdges(frame({ btn: 1 }), frame({ btn: 0 }), clock);
    expect(tap.buttonClicked).toBe(true);
    expect(tap.pushToTalkStart).toBe(false);
    expect(tap.pushToTalkStop).toBe(false);

    const boundary = detectGloveEdges(frame({ btn: 1 }), frame({ btn: 0 }), {
      nowMs: 249,
      buttonDownAtMs: 0,
      pushToTalkActive: false,
    });
    expect(boundary.buttonClicked).toBe(true);

    const holdStart = detectGloveEdges(frame({ btn: 1 }), frame({ btn: 1 }), {
      nowMs: 250,
      buttonDownAtMs: 0,
      pushToTalkActive: false,
    });
    expect(holdStart.pushToTalkStart).toBe(true);
    expect(holdStart.buttonClicked).toBe(false);

    const holdStop = detectGloveEdges(frame({ btn: 1 }), frame({ btn: 0 }), {
      nowMs: 400,
      buttonDownAtMs: 0,
      pushToTalkActive: true,
    });
    expect(holdStop.pushToTalkStop).toBe(true);
    expect(holdStop.buttonClicked).toBe(false);

    expect(detectGloveEdges(frame({ btn: 1 }), frame({ btn: 0 })).buttonClicked).toBe(false);
  });
});

describe('GloveEdgeTracker', () => {
  it('locks a tap under 250ms and opens push-to-talk once a hold crosses it', () => {
    const tracker = new GloveEdgeTracker();
    expect(tracker.update(frame({ btn: 0 }), 0).buttonClicked).toBe(false);
    expect(tracker.update(frame({ btn: 1 }), 10).pushToTalkStart).toBe(false);
    expect(tracker.update(frame({ btn: 1 }), 100).buttonClicked).toBe(false);
    const tap = tracker.update(frame({ btn: 0 }), 120);
    expect(tap.buttonClicked).toBe(true);
    expect(tap.pushToTalkStop).toBe(false);

    tracker.reset();
    tracker.update(frame({ btn: 0 }), 0);
    tracker.update(frame({ btn: 1 }), 0);
    expect(tracker.update(frame({ btn: 1 }), 249).pushToTalkStart).toBe(false);
    expect(tracker.update(frame({ btn: 1 }), 250).pushToTalkStart).toBe(true);
    const stopped = tracker.update(frame({ btn: 0 }), 400);
    expect(stopped.pushToTalkStop).toBe(true);
    expect(stopped.buttonClicked).toBe(false);
  });

  it('forgets a hold when the switch disarms, so the next tap can lock', () => {
    const tracker = new GloveEdgeTracker();
    tracker.update(frame({ btn: 1, armed: true }), 0);
    expect(tracker.update(frame({ btn: 1, armed: true }), 300).pushToTalkStart).toBe(true);
    expect(tracker.update(frame({ btn: 1, armed: false, noise: 900, swipe: 'thrust', parry: true }), 320).pushToTalkStop).toBe(
      false,
    );
    tracker.update(frame({ btn: 1, armed: true }), 340);
    const release = tracker.update(frame({ btn: 0, armed: true }), 400);
    expect(release.buttonClicked).toBe(true);
    expect(release.pushToTalkStop).toBe(false);
  });

  it('applies the fist multiplier on a tracked swipe and stays quiet while disarmed', () => {
    const tracker = new GloveEdgeTracker();
    tracker.update(frame({ swipe: 'none', fist: true, accel: 1.2, armed: false }), 0);
    expect(tracker.update(frame({ swipe: 'left', fist: true, accel: 1.2, armed: false }), 20).swipeReleased).toBeNull();
    tracker.update(frame({ swipe: 'none', fist: true, accel: 1.2, armed: true }), 40);
    const release = tracker.update(frame({ swipe: 'thrust', fist: true, accel: 1.2, armed: true }), 60);
    expect(release.swipeReleased?.power).toBeCloseTo(1.2 * FIST_CHARGE_MULTIPLIER, 5);
  });
});

function stubHardware(patch: Partial<GloveSensorFrame> = {}): GloveHardwareController {
  const next = frame(patch);
  const noop = () => undefined;
  return {
    mode: 'simulator',
    status: 'idle',
    error: null,
    frame: next,
    event: toHardwareEvent(next),
    edges: createIdleGloveEdges(),
    servoOpen: true,
    servoAngle: 110,
    recentLines: [JSON.stringify(next)],
    sampleHz: 50,
    frameCount: 4,
    pushToTalk: false,
    lockedElement: 'ember',
    lastRelease: null,
    parryLit: false,
    lastCommand: null,
    lcdMessage: null,
    wifiStatus: null,
    keyboardEnabled: true,
    webSerialSupported: true,
    simulatorActive: true,
    bridgeUrl: SERIAL_BRIDGE_URL,
    connectSerial: async () => undefined,
    disconnectSerial: async () => undefined,
    connectBridge: noop,
    disconnectBridge: noop,
    useSimulator: noop,
    setBridgeUrl: noop,
    setDial: noop,
    stepDial: noop,
    setButton: noop,
    setButton2: noop,
    setFist: noop,
    setSwipe: noop,
    releaseSwipe: noop,
    setAccel: noop,
    setParry: noop,
    tapParry: noop,
    setArmed: noop,
    toggleArmed: noop,
    setNoise: noop,
    setColor: noop,
    cycleColor: noop,
    sendCommand: noop,
    setServoOpen: noop,
    playBuzz: noop,
    sendLcd: noop,
    clearLcd: noop,
    configureWifi: noop,
    requestWifiStatus: noop,
    setKeyboardEnabled: noop,
  };
}

describe('glove bench markup', () => {
  it('shows the mic-gate banner, the spell wheel, and the open storybook', () => {
    const html = renderToStaticMarkup(
      createElement(GloveSimulatorPanel, {
        hardware: stubHardware({ noise: NOISE_TOO_LOUD_THRESHOLD, armed: true, dial: 0 }),
      }),
    );
    expect(html).toContain('TOO LOUD — MIC GATE RAISED');
    expect(html).toContain('Ember');
    expect(html).toContain('Frost');
    expect(html).toContain('Bloom');
    expect(html).toContain('110°');
    expect(html).toContain('Web Serial');
    expect(html).toContain('lcd-preview');
    expect(html).toContain('D8 Lock');
  });

  it('shows the raw 7-part pin levels when the board sends them', () => {
    const html = renderToStaticMarkup(
      createElement(GloveSimulatorPanel, { hardware: stubHardware({ d3: 1, d4: 0, d8: 1, rawDial: 777 }) }),
    );
    expect(html).toContain('pin-readout');
    expect(html).toContain('HIGH');
    expect(html).toContain('777');
  });

  it('renders the hardware bench with the 7-part port map, LCD, Wi-Fi, and the hotkey guide', () => {
    const html = renderToStaticMarkup(createElement(HardwareTestPage));
    expect(html).toContain(HARDWARE_TEST_PATH);
    for (const part of [
      'Grove Touch Sensor',
      'Grove Button 1',
      'Grove Button 2',
      'Grove Buzzer',
      'Grove Rotary Angle Sensor',
      'Grove 16x2 RGB LCD',
      'Grove 3-Axis Accelerometer',
    ]) {
      expect(html).toContain(part);
    }
    for (const port of ['D3', 'D4', 'D8', 'D5', 'A0', 'I2C LCD', 'I2C Accel']) expect(html).toContain(port);
    expect(html).not.toContain('Grove I2C Color Sensor');
    expect(html).not.toContain('Grove Servo');
    expect(html).toContain('lcd-composer');
    expect(html).toContain('Send to LCD');
    expect(html).toContain('wifi-setup');
    expect(html).toContain('Join hotspot');
    expect(html).toContain('4210');
    expect(html).toContain('Arrow Left / Right / Up');
    expect(html).toContain('115200');
    expect(html).toContain(SERIAL_BRIDGE_URL);
    expect(html).toContain('serial-stream');
  });
});
