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

function installFetchMock() {
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

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));
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

  it('center button sends one CENTERCAM request', async () => {
    const { calls } = installFetchMock();
    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));
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

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));
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

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));
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

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));
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
});
