import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

function makeJsonResponse(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function installFetchMock(options = {}) {
  const visionPayload = options.visionPayload || {
    enabled: false,
    running: false,
    source_url: 'http://127.0.0.1:8081/stream.mjpg',
    model_backend: 'disabled',
    model_path: null,
    last_frame_time: null,
    fps: 0,
    detections: [],
    people_count: 0,
    dog_count: 0,
    hazards: [],
    targets: [],
    message: 'Vision monitoring disabled. Monitor-only mode is standing by.',
  };
  const trackingPayload = options.trackingPayload || {
    enabled: true,
    running: false,
    status: 'idle',
    label: null,
    box: null,
    confidence: null,
    last_update_time: null,
    fps: 0,
    message: 'No tracking active. Select an area on the camera feed to begin.',
  };
  const calls = [];
  const mock = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });

    if (url.endsWith('/api/status')) {
      return makeJsonResponse({
        connected: true,
        port: '/dev/ttyUSB0',
        baud_rate: 115200,
        error: null,
        error_code: null,
        last_response: null,
        startup_banner: 'ConquerorTank ready',
        startup_issues: [],
      });
    }

    if (url.endsWith('/api/sensors')) {
      return makeJsonResponse({
        ok: true,
        message: 'Sensor snapshot read successfully.',
        error_code: null,
        response: 'SENSORS LINE 812 790 805 SONAR 24',
        line_left: 812,
        line_middle: 790,
        line_right: 805,
        sonar_cm: 24,
      });
    }

    if (url.endsWith('/api/firmware/status')) {
      return makeJsonResponse({
        ok: true,
        message: 'Firmware status read successfully.',
        response: 'STATUS SPEED 50 PAN 84 TARGET_PAN 120 TILT 90 TARGET_TILT 100 BUILD Apr_18_2026_07:55:42',
        firmware_build: 'Apr_18_2026_07:55:42',
        firmware_build_display: 'Apr 18 2026 07:55:42',
        firmware_build_date: 'Apr 18 2026',
        firmware_build_time: '07:55:42',
        speed: 50,
        pan: 84,
        target_pan: 120,
        tilt: 90,
        target_tilt: 100,
      });
    }

    if (url.endsWith('/api/vision/detections')) {
      return makeJsonResponse(visionPayload);
    }

    if (url.endsWith('/api/tracking/status')) {
      return makeJsonResponse(options.trackingPayload || trackingPayload);
    }

    if (url.endsWith('/api/tracking/start')) {
      if (options.trackingStartResult !== undefined) {
        return makeJsonResponse(options.trackingStartResult, options.trackingStartResult.ok !== false);
      }
      return makeJsonResponse({ ok: true });
    }

    if (url.endsWith('/api/tracking/stop') || url.endsWith('/api/tracking/reset')) {
      return makeJsonResponse({ ok: true });
    }

    if (url.endsWith('/status')) {
      return makeJsonResponse({
        available: true,
        message: 'Camera live',
      });
    }

    if (url.endsWith('/api/command')) {
      const payload = JSON.parse(init.body);
      if (payload.command === 'center_camera') {
        return makeJsonResponse({
          ok: true,
          message: 'Centered',
          serial_command: 'CENTERCAM',
        });
      }
      return makeJsonResponse({
        ok: true,
        message: 'Queued camera target',
        serial_command: payload.command === 'camera' ? `CAMERA ${payload.pan} ${payload.tilt}` : payload.command,
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

function commandCalls(calls) {
  return calls
    .filter((call) => call.url.endsWith('/api/command'))
    .map((call) => JSON.parse(call.init.body));
}

describe('App camera controls', () => {
  beforeEach(() => {
    window.__TANK_APP_CONFIG__ = { cameraStreamPort: 8081, secondaryCameraStreamPort: 8082 };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete window.__TANK_APP_CONFIG__;
  });

  it('sends one CAMERA target for slider changes without ramp steps', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    calls.length = 0;

    fireEvent.change(screen.getByLabelText('Pan'), { target: { value: '120' } });
    await waitFor(() => expect(commandCalls(calls)).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });

    const cameraCalls = commandCalls(calls);
    expect(cameraCalls).toHaveLength(1);
    expect(cameraCalls[0]).toEqual({ command: 'camera', pan: 120, tilt: 90 });
  });

  it('click-to-center sends a single CAMERA target command', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByAltText('Robot tank wide camera stream')).toBeTruthy());
    calls.length = 0;

    const frame = screen.getByAltText('Robot tank wide camera stream').parentElement;
    expect(frame).toBeTruthy();
    frame.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
    });

    fireEvent.click(frame, { clientX: 300, clientY: 150 });
    await waitFor(() => expect(commandCalls(calls)).toHaveLength(1));

    const cameraCalls = commandCalls(calls);
    expect(cameraCalls).toHaveLength(1);
    expect(cameraCalls[0]).toEqual({ command: 'camera', pan: 111, tilt: 90 });
  });

  // Regression: the click-to-center math multiplies pan by `flipMultiplier`
  // when the cockpit's "Flip Cam" toggle is off. Without this test, swapping
  // the sign in App.jsx would silently invert aiming while the default
  // (flipped) test above continued to pass.
  it('click-to-center inverts pan delta when the flip toggle is off', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByAltText('Robot tank wide camera stream')).toBeTruthy());

    // Default state is flipped=true; toggling off exercises the
    // `flipMultiplier === 1` branch that the existing test above does not cover.
    fireEvent.click(screen.getByRole('button', { name: 'Flip Cam' }));
    calls.length = 0;

    const frame = screen.getByAltText('Robot tank wide camera stream').parentElement;
    frame.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
    });

    // Same click coordinates as the flipped test (right side of viewport).
    // With flip off the pan delta must invert: 90 - 21 = 69 (vs 111 when flipped).
    fireEvent.click(frame, { clientX: 300, clientY: 150 });
    await waitFor(() => expect(commandCalls(calls)).toHaveLength(1));

    const cameraCalls = commandCalls(calls);
    expect(cameraCalls).toHaveLength(1);
    expect(cameraCalls[0]).toEqual({ command: 'camera', pan: 69, tilt: 90 });
  });

  it('center button sends one CENTERCAM request', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    calls.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Center' }));
    await waitFor(() => expect(commandCalls(calls)).toHaveLength(1));

    const cameraCalls = commandCalls(calls);
    expect(cameraCalls).toHaveLength(1);
    expect(cameraCalls[0]).toEqual({ command: 'center_camera' });
  });

  it('renders the auxiliary camera viewport', async () => {
    installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByAltText('Robot tank secondary camera stream')).toBeTruthy());
  });

  it('arrow keys nudge by sending one CAMERA target command', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    calls.length = 0;

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(commandCalls(calls)).toHaveLength(1));

    const cameraCalls = commandCalls(calls);
    expect(cameraCalls).toHaveLength(1);
    expect(cameraCalls[0]).toEqual({ command: 'camera', pan: 95, tilt: 90 });
  });

  it('repeats forward while the button is held and stops on release', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    calls.length = 0;

    const forwardButton = screen.getByRole('button', { name: /forward/i });
    fireEvent.pointerDown(forwardButton, { pointerId: 1 });

    await waitFor(() => expect(commandCalls(calls)[0]).toEqual({ command: 'forward', speed: 50, duration_ms: 400 }));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 280));
    });

    expect(commandCalls(calls).filter((call) => call.command === 'forward').length).toBeGreaterThan(1);

    fireEvent.pointerUp(forwardButton, { pointerId: 1 });
    await waitFor(() => expect(commandCalls(calls).at(-1)).toEqual({ command: 'stop' }));

    const forwardCallCount = commandCalls(calls).filter((call) => call.command === 'forward').length;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 280));
    });

    expect(commandCalls(calls).filter((call) => call.command === 'forward')).toHaveLength(forwardCallCount);
  });

  it('repeats reverse while S is held and stops on keyup', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    calls.length = 0;

    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(commandCalls(calls)[0]).toEqual({ command: 'backward', speed: 50, duration_ms: 400 }));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 280));
    });

    expect(commandCalls(calls).filter((call) => call.command === 'backward').length).toBeGreaterThan(1);

    fireEvent.keyUp(window, { key: 's' });
    await waitFor(() => expect(commandCalls(calls).at(-1)).toEqual({ command: 'stop' }));
  });

  it('shows firmware build stamp details in the panel', async () => {
    installFetchMock();
    render(<App />);

    expect(await screen.findByText('Build: Apr_18_2026_07:55:42')).toBeTruthy();
    expect(screen.getByText('Built: Apr 18 2026 07:55:42')).toBeTruthy();
    expect(screen.getByText('Date: Apr 18 2026')).toBeTruthy();
    expect(screen.getByText('Time: 07:55:42')).toBeTruthy();
  });

  it('renders a calm disabled vision status', async () => {
    installFetchMock();
    render(<App />);

    expect(await screen.findByText('Vision')).toBeTruthy();
    expect(screen.getByText('Vision disabled')).toBeTruthy();
    expect(screen.getByText('Monitor only')).toBeTruthy();
    expect(screen.getByText('Vision monitoring disabled. Monitor-only mode is standing by.')).toBeTruthy();
  });

  it('shows vision counts and overlay boxes from normalized detections', async () => {
    installFetchMock({
      visionPayload: {
        enabled: true,
        running: true,
        source_url: 'http://127.0.0.1:8081/stream.mjpg',
        backend: 'opencv_onnx',
        model_backend: 'opencv_onnx',
        model_path: 'models/yolo-nano.onnx',
        model_loaded: true,
        stream_connected: true,
        last_frame_time: '2026-04-26T15:30:00Z',
        last_detection_time: '2026-04-26T15:30:00Z',
        fps: 2,
        detections: [
          {
            label: 'person',
            confidence: 0.91,
            box: { x: 0.1, y: 0.2, w: 0.2, h: 0.45 },
            center: { x: 0.2, y: 0.425 },
            category: 'person',
            is_hazard: false,
            is_target: true,
          },
          {
            label: 'chair',
            confidence: 0.74,
            box: { x: 0.48, y: 0.63, w: 0.16, h: 0.2 },
            center: { x: 0.56, y: 0.73 },
            category: 'hazard',
            is_hazard: true,
            is_target: false,
          },
          {
            label: 'tennis ball',
            confidence: 0.69,
            box: { x: 0.72, y: 0.44, w: 0.08, h: 0.08 },
            center: { x: 0.76, y: 0.48 },
            category: 'target',
            is_hazard: false,
            is_target: true,
          },
        ],
        people_count: 1,
        dog_count: 0,
        hazards: [
          {
            label: 'chair',
            confidence: 0.74,
            box: { x: 0.48, y: 0.63, w: 0.16, h: 0.2 },
            center: { x: 0.56, y: 0.73 },
            category: 'hazard',
            is_hazard: true,
            is_target: false,
          },
        ],
        targets: [
          {
            label: 'person',
            confidence: 0.91,
            box: { x: 0.1, y: 0.2, w: 0.2, h: 0.45 },
            center: { x: 0.2, y: 0.425 },
            category: 'person',
            is_hazard: false,
            is_target: true,
          },
          {
            label: 'tennis ball',
            confidence: 0.69,
            box: { x: 0.72, y: 0.44, w: 0.08, h: 0.08 },
            center: { x: 0.76, y: 0.48 },
            category: 'target',
            is_hazard: false,
            is_target: true,
          },
        ],
        message: 'Vision monitoring active in monitor-only mode.',
      },
    });
    render(<App />);

    expect(await screen.findByText('Vision active')).toBeTruthy();
    expect(screen.getByText('Backend: opencv_onnx')).toBeTruthy();
    expect(screen.getByText('People: 1')).toBeTruthy();
    expect(screen.getByText('Hazards: 1')).toBeTruthy();
    expect(screen.getByText('Targets: 2')).toBeTruthy();
    expect(screen.getByLabelText('Vision overlay')).toBeTruthy();
    expect(screen.getByTestId('vision-box-0')).toBeTruthy();
    expect(screen.getByTestId('vision-box-1')).toBeTruthy();
    expect(screen.getByTestId('vision-box-2')).toBeTruthy();
  });

  it('shows "model missing" when vision is enabled but the model is not loaded', async () => {
    installFetchMock({
      visionPayload: {
        enabled: true,
        running: false,
        source_url: 'http://127.0.0.1:8081/stream.mjpg',
        backend: 'opencv_onnx',
        model_backend: 'opencv_onnx',
        model_path: 'models/yolo-nano.onnx',
        model_loaded: false,
        stream_connected: false,
        last_frame_time: null,
        last_detection_time: null,
        fps: 0,
        detections: [],
        detections_count: 0,
        people_count: 0,
        dog_count: 0,
        hazards: [],
        targets: [],
        message: 'Vision monitoring enabled, but the model could not be loaded (model missing or OpenCV unavailable).',
      },
    });
    render(<App />);

    expect(await screen.findByText('Vision model missing')).toBeTruthy();
    // Counts should still render with zeros and not crash.
    expect(screen.getByText('People: 0')).toBeTruthy();
  });

  it('shows "waiting for stream" when the model is loaded but no frames have arrived', async () => {
    installFetchMock({
      visionPayload: {
        enabled: true,
        running: false,
        source_url: 'http://127.0.0.1:8081/stream.mjpg',
        backend: 'opencv_onnx',
        model_backend: 'opencv_onnx',
        model_path: 'models/yolo-nano.onnx',
        model_loaded: true,
        stream_connected: false,
        last_frame_time: null,
        last_detection_time: null,
        fps: 0,
        detections: [],
        detections_count: 0,
        people_count: 0,
        dog_count: 0,
        hazards: [],
        targets: [],
        message: 'Vision pipeline error: stream unavailable',
      },
    });
    render(<App />);

    expect(await screen.findByText('Vision waiting for stream')).toBeTruthy();
  });
});

describe('ROI tracking UI', () => {
  beforeEach(() => {
    window.__TANK_APP_CONFIG__ = { cameraStreamPort: 8081, secondaryCameraStreamPort: 8082 };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete window.__TANK_APP_CONFIG__;
  });

  it('renders the "Track area" button', async () => {
    installFetchMock();
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Track area' })).toBeTruthy();
  });

  it('Track area button enters selection mode (shows "Drawing…")', async () => {
    installFetchMock();
    render(<App />);

    const btn = await screen.findByRole('button', { name: 'Track area' });
    fireEvent.click(btn);

    expect(screen.getByRole('button', { name: 'Drawing…' })).toBeTruthy();
  });

  it('clicking Track area again cancels selection mode', async () => {
    installFetchMock();
    render(<App />);

    const btn = await screen.findByRole('button', { name: 'Track area' });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole('button', { name: 'Drawing…' }));

    expect(await screen.findByRole('button', { name: 'Track area' })).toBeTruthy();
  });

  it('dragging over the camera creates a selection overlay and calls /api/tracking/start', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByAltText('Robot tank wide camera stream')).toBeTruthy());

    fireEvent.click(await screen.findByRole('button', { name: 'Track area' }));

    const frame = screen.getByAltText('Robot tank wide camera stream').parentElement;
    frame.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360,
    });

    fireEvent.mouseDown(frame, { clientX: 100, clientY: 80 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 200 });
    fireEvent.mouseUp(document, { clientX: 300, clientY: 200 });

    await waitFor(() => {
      const trackingCalls = calls.filter((c) => c.url.endsWith('/api/tracking/start'));
      expect(trackingCalls.length).toBeGreaterThanOrEqual(1);
    });

    const startCall = calls.find((c) => c.url.endsWith('/api/tracking/start'));
    const body = JSON.parse(startCall.init.body);
    expect(body.box).toBeDefined();
    expect(body.label).toBe('manual selection');
    // The box coords should be normalised [0, 1]
    expect(body.box.x).toBeGreaterThanOrEqual(0);
    expect(body.box.x).toBeLessThanOrEqual(1);
    expect(body.box.w).toBeGreaterThan(0);
    expect(body.box.h).toBeGreaterThan(0);
  });

  it('renders the tracking box SVG when tracking is active', async () => {
    installFetchMock({
      trackingPayload: {
        enabled: true,
        running: true,
        status: 'tracking',
        label: 'manual selection',
        box: { x: 0.2, y: 0.3, w: 0.15, h: 0.2 },
        confidence: null,
        last_update_time: '2026-04-26T12:00:00Z',
        fps: 5,
        message: 'Tracking manual selection',
      },
    });
    render(<App />);

    // Camera image must be rendered for TrackingOverlay to appear
    await waitFor(() => expect(screen.getByAltText('Robot tank wide camera stream')).toBeTruthy());

    expect(await screen.findByLabelText('Tracking overlay')).toBeTruthy();
    expect(screen.getByTestId('tracking-box')).toBeTruthy();
  });

  it('shows lost tracking message when status is "lost"', async () => {
    installFetchMock({
      trackingPayload: {
        enabled: true,
        running: false,
        status: 'lost',
        label: 'manual selection',
        box: null,
        confidence: null,
        last_update_time: '2026-04-26T12:00:00Z',
        fps: 0,
        message: 'Tracking lost — select the object again.',
      },
    });
    render(<App />);

    expect(await screen.findByText('Tracking lost — select the object again.')).toBeTruthy();
  });

  it('Stop tracking button calls /api/tracking/stop', async () => {
    const { calls } = installFetchMock({
      trackingPayload: {
        enabled: true,
        running: true,
        status: 'tracking',
        label: 'manual selection',
        box: { x: 0.2, y: 0.3, w: 0.15, h: 0.2 },
        confidence: null,
        last_update_time: '2026-04-26T12:00:00Z',
        fps: 5,
        message: 'Tracking manual selection',
      },
    });
    render(<App />);

    const stopBtn = await screen.findByRole('button', { name: 'Stop tracking' });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      const stopCalls = calls.filter((c) => c.url.endsWith('/api/tracking/stop'));
      expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does not render a tracking box when status is idle', async () => {
    installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.queryByTestId('tracking-box')).toBeNull());
  });

  it('tiny drag (accidental tap) does not call /api/tracking/start', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByAltText('Robot tank wide camera stream')).toBeTruthy());

    fireEvent.click(await screen.findByRole('button', { name: 'Track area' }));

    const frame = screen.getByAltText('Robot tank wide camera stream').parentElement;
    frame.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360,
    });

    // Tiny drag — start and end at almost the same point
    fireEvent.mouseDown(frame, { clientX: 100, clientY: 80 });
    fireEvent.mouseMove(document, { clientX: 101, clientY: 81 });
    fireEvent.mouseUp(document, { clientX: 101, clientY: 81 });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });

    const trackingCalls = calls.filter((c) => c.url.endsWith('/api/tracking/start'));
    expect(trackingCalls).toHaveLength(0);
  });
});
