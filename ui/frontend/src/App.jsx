import { useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_SOURCE_ASPECT, projectNormalizedBox, unprojectNormalizedBox } from './visionGeometry';
import { useGamepadControls } from './useGamepadControls';

const SERIAL_ERROR_HELP = {
  'serial-port-missing': 'Serial port missing. Check the USB cable and TANK_SERIAL_PORT.',
  'serial-port-busy': 'Serial port busy. Another process is already using the Arduino link.',
  'serial-permission-denied': 'Serial permission denied. Add the service user to dialout or fix device permissions.',
  'serial-open-failed': 'Serial port failed to open. Check the configured device and baud settings.',
  'serial-write-timeout': 'Serial write timed out. The Arduino may be powered but not accepting writes.',
  'serial-disconnected': 'Serial device disconnected while a command was in flight.',
  'serial-command-failed': 'Serial command failed. Inspect the device and retry.',
  'sensor-parse-failed': 'The Arduino returned a sensor line the Pi could not parse.',
  'sensor-read-failed': 'The Arduino did not return a sensor snapshot before the read timed out.',
  'firmware-error': 'The Arduino rejected the command and returned an error.',
  'firmware-status-parse-failed': 'The Pi could not parse the firmware STATUS response.',
  'firmware-status-read-failed': 'The firmware did not return a STATUS snapshot before the read timed out.',
  'firmware-status-unexpected': 'The firmware returned an unexpected line instead of STATUS.',
  'server-port-in-use': 'Server port already in use. Start the app on a different TANK_SERVER_PORT or stop the conflicting service.',
};

const defaultStatus = {
  connected: false,
  port: '/dev/ttyUSB0',
  baud_rate: 115200,
  error: null,
  error_code: null,
  last_response: null,
  startup_banner: null,
  startup_issues: [],
};

const defaultCamera = {
  available: false,
  message: 'Checking camera service.',
};

const defaultSensors = {
  available: false,
  message: 'Waiting for sensor poll.',
  error_code: null,
  response: null,
  line_left: null,
  line_middle: null,
  line_right: null,
  sonar_cm: null,
};

const defaultFirmware = {
  ok: false,
  message: 'Waiting for firmware status.',
  error_code: null,
  response: null,
  firmware_build: null,
  firmware_build_display: null,
  firmware_build_date: null,
  firmware_build_time: null,
  speed: null,
  pan: null,
  target_pan: null,
  tilt: null,
  target_tilt: null,
};

const defaultVision = {
  enabled: false,
  running: false,
  source_url: null,
  backend: 'disabled',
  model_backend: 'disabled',
  model_path: null,
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
  message: 'Vision monitoring disabled. Monitor-only mode is standing by.',
};

const defaultRoiTracking = {
  enabled: true,
  running: false,
  status: 'idle',
  label: null,
  box: null,
  confidence: null,
  last_update_time: null,
  fps: 0,
  message: 'No tracking active. Select an area on the camera feed to begin.',
  follow_enabled: false,
  pan: 90,
  tilt: 90,
};

const commandButtons = [
  { command: 'set_speed', label: 'Set Speed', tone: 'secondary' },
  { command: 'ping', label: 'Ping', tone: 'secondary' },
];

const cameraButtons = [
  { command: 'center_camera', label: 'Center', tone: 'secondary' },
  { command: 'ramp_test', label: 'Ramp Test', tone: 'secondary' },
];

const CAMERA_TARGET_THROTTLE_MS = 90;
const TRACKING_POLL_MS = 300;
const CAMERA_HFOV_DEG = 114;
const CAMERA_VFOV_DEG = 81;
const CAMERA_NATIVE_ASPECT = 16 / 9;
const CAMERA_NUDGE_DEG = 5;
// Camera-tracking constants. DEAD_ZONE prevents servo jitter when the
// detected object is already near-centre (in normalized 0-1 coords).
const TRACKING_DEAD_ZONE = 0.04;  // ~5 deg; no move inside this radius
const TRACKING_PAN_GAIN = 1.0;   // fraction of full-error correction per tick
const TRACKING_TILT_GAIN = 1.0;
const DRIVE_HOLD_MIN_PULSE_MS = 80;
const DRIVE_HOLD_MIN_REPEAT_MS = 50;
const DRIVE_HOLD_MAX_REPEAT_MS = 250;
const FIRMWARE_STATUS_POLL_MS = 20000;
const VISION_POLL_MS = 500;

// Click-to-center is calibrated in software because exact centering depends on camera FOV,
// letterboxing, servo direction, backlash, and mount geometry on the physical tank.
const PAN_CLICK_SIGN = -1;
const TILT_CLICK_SIGN = -1;
const PAN_CLICK_GAIN = 1;
const TILT_CLICK_GAIN = 1;

function getAppConfig() {
  return window.__TANK_APP_CONFIG__ || { cameraStreamPort: 8081, secondaryCameraStreamPort: 8082 };
}

function describeError(payload) {
  if (!payload) {
    return 'Unknown error.';
  }

  const help = payload.error_code ? SERIAL_ERROR_HELP[payload.error_code] : null;
  return help ? `${payload.message} ${help}` : payload.message;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function statusLevel(status) {
  if (status.connected) {
    return { label: 'Serial ready', tone: 'ok' };
  }
  if (status.error_code) {
    return { label: 'Serial blocked', tone: 'error' };
  }
  return { label: 'Checking serial', tone: 'pending' };
}

function cameraLevel(camera) {
  if (camera.available) {
    return { label: 'Camera live', tone: 'ok' };
  }
  if (camera.message !== defaultCamera.message) {
    return { label: 'Camera offline', tone: 'error' };
  }
  return { label: 'Checking camera', tone: 'pending' };
}

function appLevel(status, serverOnline) {
  if (!serverOnline) {
    return { label: 'App offline', tone: 'error' };
  }
  if (status.startup_issues?.length) {
    return { label: 'App warning', tone: 'warning' };
  }
  return { label: 'App online', tone: 'ok' };
}

function visionLevel(vision) {
  if (!vision.enabled) {
    return { label: 'Vision disabled', tone: 'pending' };
  }
  if (vision.model_backend === 'disabled') {
    return { label: 'Vision standby', tone: 'pending' };
  }
  if (!vision.model_path || !vision.model_loaded) {
    return { label: 'Vision model missing', tone: 'warning' };
  }
  if (!vision.stream_connected) {
    return { label: 'Vision waiting for stream', tone: 'warning' };
  }
  if (vision.running) {
    return { label: 'Vision active', tone: 'ok' };
  }
  return { label: 'Vision waiting', tone: 'warning' };
}

function formatVisionTime(value) {
  if (!value) {
    return '--';
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return timestamp.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatVisionCount(items) {
  return Array.isArray(items) ? items.length : 0;
}

function useInterval(callback, delay) {
  useEffect(() => {
    const timer = window.setInterval(callback, delay);
    return () => window.clearInterval(timer);
  }, [callback, delay]);
}

function formatAxisStatus(currentValue, targetValue) {
  const hasCurrent = Number.isFinite(currentValue);
  const hasTarget = Number.isFinite(targetValue);

  if (!hasCurrent && !hasTarget) {
    return '--';
  }

  if (!hasTarget) {
    return `${currentValue} deg`;
  }

  if (!hasCurrent) {
    return `target ${targetValue} deg`;
  }

  return `${currentValue} deg -> ${targetValue} deg`;
}

export default function App() {
  const [driveSpeed, setDriveSpeed] = useState(50);
  const [driveDuration, setDriveDuration] = useState(400);
  const [motorDuration, setMotorDuration] = useState(400);
  const [pan, setPan] = useState(90);
  const [tilt, setTilt] = useState(90);
  const [leftMotor, setLeftMotor] = useState(0);
  const [rightMotor, setRightMotor] = useState(0);
  const [status, setStatus] = useState(defaultStatus);
  const [camera, setCamera] = useState(defaultCamera);
  const [secondaryCamera, setSecondaryCamera] = useState(defaultCamera);
  const [sensors, setSensors] = useState(defaultSensors);
  const [firmware, setFirmware] = useState(defaultFirmware);
  const [vision, setVision] = useState(defaultVision);
  const [roiTracking, setRoiTracking] = useState(defaultRoiTracking);
  const [roiSelectMode, setRoiSelectMode] = useState(false);
  const [roiDrag, setRoiDrag] = useState(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [commandLog, setCommandLog] = useState('No command sent yet.');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flipped, setFlipped] = useState(true);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const roiDragRef = useRef(null);
  const roiContainerAspectRef = useRef(16 / 9);
  const roiFrameRef = useRef(null);
  const activeKeysRef = useRef(new Set());
  const driveConfigRef = useRef({ speed: 50, duration: 400 });
  const driveHoldRef = useRef({ command: null, timerId: null, inFlight: false });
  const queueRef = useRef(Promise.resolve());
  const cameraTargetRef = useRef({ pan: 90, tilt: 90 });
  const cameraPendingRef = useRef(null);
  const cameraLastSentAtRef = useRef(0);
  const cameraLastSentTargetRef = useRef(null);
  const cameraSendTimerRef = useRef(null);
  const trackingEnabledRef = useRef(false);
  const visionRef = useRef(defaultVision);
  const flippedRef = useRef(true); // matches useState(true) default
  const appConfig = useMemo(() => getAppConfig(), []);
  const cameraBaseUrl = useMemo(
    () => `${window.location.protocol}//${window.location.hostname}:${appConfig.cameraStreamPort}`,
    [appConfig.cameraStreamPort]
  );
  const secondaryCameraBaseUrl = useMemo(
    () => `${window.location.protocol}//${window.location.hostname}:${appConfig.secondaryCameraStreamPort}`,
    [appConfig.secondaryCameraStreamPort]
  );

  const serialIndicator = statusLevel(status);
  const cameraIndicator = cameraLevel(camera);
  const appIndicator = appLevel(status, serverOnline);
  const visionIndicator = visionLevel(vision);

  const serialDetail = status.connected
    ? `Serial link ready on ${status.port} @ ${status.baud_rate}.`
    : describeError({ message: status.error || `No serial device available on ${status.port}.`, error_code: status.error_code });

  const cameraStreamUrl = `${cameraBaseUrl}/stream.mjpg`;
  const secondaryCameraStreamUrl = `${secondaryCameraBaseUrl}/stream.mjpg`;
  const sensorDetail = sensors.available
    ? `Front sonar ${sensors.sonar_cm} cm. Bottom sensors L ${sensors.line_left}, M ${sensors.line_middle}, R ${sensors.line_right}.`
    : describeError({ message: sensors.message, error_code: sensors.error_code });
  const sensorResponseDetail = sensors.response || 'No sensor response captured yet.';
  const firmwareDetail = firmware.ok
    ? 'R3-reported camera state.'
    : describeError({ message: firmware.message, error_code: firmware.error_code });
  const hazardCount = formatVisionCount(vision.hazards);
  const targetCount = formatVisionCount(vision.targets);
  const visionLastSeen = formatVisionTime(vision.last_frame_time);

  // Gamepad callbacks are plain closures — the hook wraps them in a ref so the
  // RAF poll loop always calls the latest version without stale captures.
  const { connected: gamepadConnected, name: gamepadName } = useGamepadControls({
    // onDrive receives tank-mixed { left, right } speeds from the hook's analog math.
    onDrive: ({ left, right }) => {
      const dur = Math.max(driveConfigRef.current.duration, 80);
      void postCommand('left_motor',  { speed: left,  duration_ms: dur });
      void postCommand('right_motor', { speed: right, duration_ms: dur });
    },
    onStop: () => { void sendDirectCommand('stop', 'Gamepad Stop'); },
    // onCameraMove receives pre-curved degree steps from the hook.
    onCameraMove: (panStep, tiltStep) => {
      const nextPan  = clamp(Math.round(cameraTargetRef.current.pan  + panStep),  0, 180);
      const nextTilt = clamp(Math.round(cameraTargetRef.current.tilt + tiltStep), 0, 180);
      scheduleCameraTarget(nextPan, nextTilt, { immediate: true });
    },
    onCenterCamera: () => { void handleCenterCamera(); },
    onSpeedDown: () => setDriveSpeed((v) => clamp(v - 5, 0, 255)),
    onSpeedUp:   () => setDriveSpeed((v) => clamp(v + 5, 0, 255)),
  });

  useEffect(() => {
    driveConfigRef.current = {
      speed: driveSpeed,
      duration: driveDuration,
    };
  }, [driveDuration, driveSpeed]);

  useEffect(() => { visionRef.current = vision; }, [vision]);
  useEffect(() => { trackingEnabledRef.current = trackingEnabled; }, [trackingEnabled]);
  useEffect(() => { flippedRef.current = flipped; }, [flipped]);

  async function refreshStatus() {
    try {
      const response = await fetch('/api/status');
      const payload = await response.json();
      setStatus(payload);
      setServerOnline(true);
    } catch {
      setServerOnline(false);
      setStatus((current) => ({ ...current, startup_issues: [] }));
    }
  }

  async function refreshCameraStatus() {
    try {
      const response = await fetch(`${cameraBaseUrl}/status`);
      const payload = await response.json();
      setCamera(payload);
    } catch {
      setCamera({ available: false, message: 'Could not reach the camera streaming service.' });
    }
  }

  async function refreshSecondaryCameraStatus() {
    try {
      const response = await fetch(`${secondaryCameraBaseUrl}/status`);
      const payload = await response.json();
      setSecondaryCamera(payload);
    } catch {
      setSecondaryCamera({ available: false, message: 'Could not reach the secondary camera streaming service.' });
    }
  }

  async function refreshSensors() {
    try {
      const response = await fetch('/api/sensors');
      const payload = await response.json();
      setSensors({
        available: response.ok && payload.ok,
        message: payload.message,
        error_code: payload.error_code,
        response: payload.response,
        line_left: payload.line_left ?? null,
        line_middle: payload.line_middle ?? null,
        line_right: payload.line_right ?? null,
        sonar_cm: payload.sonar_cm ?? null,
      });
    } catch {
      setSensors({
        ...defaultSensors,
        message: 'Could not reach the sensor endpoint.',
      });
    }
  }

  async function refreshFirmwareStatus() {
    try {
      const response = await fetch('/api/firmware/status');
      const payload = await response.json();
      setFirmware({
        ok: response.ok && payload.ok,
        message: payload.message,
        error_code: payload.error_code,
        response: payload.response,
        firmware_build: payload.firmware_build ?? null,
        firmware_build_display: payload.firmware_build_display ?? null,
        firmware_build_date: payload.firmware_build_date ?? null,
        firmware_build_time: payload.firmware_build_time ?? null,
        speed: payload.speed ?? null,
        pan: payload.pan ?? null,
        target_pan: payload.target_pan ?? null,
        tilt: payload.tilt ?? null,
        target_tilt: payload.target_tilt ?? null,
      });
    } catch {
      setFirmware({
        ...defaultFirmware,
        message: 'Could not reach the firmware status endpoint.',
      });
    }
  }

  async function refreshVision() {
    try {
      const response = await fetch('/api/vision/detections');
      const payload = await response.json();
      const newVision = {
        enabled: Boolean(payload.enabled),
        running: Boolean(payload.running),
        source_url: payload.source_url ?? null,
        backend: payload.backend ?? payload.model_backend ?? 'disabled',
        model_backend: payload.model_backend ?? payload.backend ?? 'disabled',
        model_path: payload.model_path ?? null,
        model_loaded: Boolean(payload.model_loaded),
        stream_connected: Boolean(payload.stream_connected),
        last_frame_time: payload.last_frame_time ?? null,
        last_detection_time: payload.last_detection_time ?? null,
        fps: Number.isFinite(payload.fps) ? payload.fps : Number(payload.fps || 0),
        detections: Array.isArray(payload.detections) ? payload.detections : [],
        detections_count: Number.isFinite(payload.detections_count)
          ? payload.detections_count
          : Array.isArray(payload.detections) ? payload.detections.length : 0,
        people_count: payload.people_count ?? 0,
        dog_count: payload.dog_count ?? 0,
        hazards: Array.isArray(payload.hazards) ? payload.hazards : [],
        targets: Array.isArray(payload.targets) ? payload.targets : [],
        message: payload.message || defaultVision.message,
      };
      setVision(newVision);
      // Run tracking synchronously with the freshest data instead of relying
      // on a separate interval that may read a stale visionRef.
      trackingTick(newVision);
    } catch {
      setVision({
        ...defaultVision,
        message: 'Vision monitor is unavailable right now. Movement controls remain manual only.',
      });
    }
  }

  async function refreshRoiTracking() {
    try {
      const response = await fetch('/api/tracking/status');
      const payload = await response.json();
      setRoiTracking({
        enabled: Boolean(payload.enabled),
        running: Boolean(payload.running),
        status: payload.status ?? 'idle',
        label: payload.label ?? null,
        box: payload.box ?? null,
        confidence: payload.confidence ?? null,
        last_update_time: payload.last_update_time ?? null,
        fps: Number.isFinite(payload.fps) ? payload.fps : 0,
        message: payload.message ?? defaultRoiTracking.message,
        follow_enabled: Boolean(payload.follow_enabled),
        pan: Number.isFinite(payload.pan) ? payload.pan : 90,
        tilt: Number.isFinite(payload.tilt) ? payload.tilt : 90,
      });
    } catch {
      // Tracking poll failing silently is acceptable; UI keeps last known state.
    }
  }

  async function stopRoiTracking() {
    try {
      await fetch('/api/tracking/stop', { method: 'POST' });
    } catch {
      // best-effort
    }
    setRoiSelectMode(false);
    setRoiDrag(null);
    roiDragRef.current = null;
    setRoiTracking(defaultRoiTracking);
  }

  async function toggleRoiFollow() {
    const next = !roiTracking.follow_enabled;
    // Optimistic UI update
    setRoiTracking((current) => ({ ...current, follow_enabled: next }));
    try {
      await fetch('/api/tracking/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      await refreshRoiTracking();
    } catch {
      // best-effort; refresh will reconcile state
    }
  }

  function handleRoiMouseDown(event) {
    if (!roiSelectMode) return;
    event.preventDefault();
    const el = roiFrameRef.current;
    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    roiContainerAspectRef.current = rect.width > 0 && rect.height > 0
      ? rect.width / rect.height
      : 16 / 9;
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const drag = { x0: x, y0: y, x1: x, y1: y };
    roiDragRef.current = drag;
    setRoiDrag(drag);

    // Attach move/up to document so drag works even when cursor leaves the element.
    function onDocMove(e) {
      if (!roiDragRef.current) return;
      const cx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const cy = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const updated = { ...roiDragRef.current, x1: cx, y1: cy };
      roiDragRef.current = updated;
      setRoiDrag(updated);
    }

    function onDocUp() {
      document.removeEventListener('mousemove', onDocMove);
      document.removeEventListener('mouseup', onDocUp);
      finishRoiDrag();
    }

    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);
  }

  async function finishRoiDrag() {
    const drag = roiDragRef.current;
    roiDragRef.current = null;
    setRoiDrag(null);
    setRoiSelectMode(false);

    if (!drag) return;

    // Compute normalised container-space box from drag start/end
    const containerBox = {
      x: Math.min(drag.x0, drag.x1),
      y: Math.min(drag.y0, drag.y1),
      w: Math.abs(drag.x1 - drag.x0),
      h: Math.abs(drag.y1 - drag.y0),
    };

    // Skip tiny accidental taps and guard against NaN coords
    if (
      !Number.isFinite(containerBox.w) || !Number.isFinite(containerBox.h) ||
      containerBox.w < 0.01 || containerBox.h < 0.01
    ) return;

    // When the camera is displayed rotated 180° (flipped), the user's drag is
    // in visually-flipped container space. Invert before converting to source
    // image coords so the backend receives the correct region.
    const containerBoxForSource = flippedRef.current
      ? {
          x: 1 - containerBox.x - containerBox.w,
          y: 1 - containerBox.y - containerBox.h,
          w: containerBox.w,
          h: containerBox.h,
        }
      : containerBox;

    // Invert letterbox to get source-image normalised coords
    const sourceBox = unprojectNormalizedBox(containerBoxForSource, {
      sourceAspect: DEFAULT_SOURCE_ASPECT,
      containerAspect: roiContainerAspectRef.current,
    });

    try {
      const response = await fetch('/api/tracking/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ box: sourceBox, label: 'manual selection' }),
      });
      const result = await response.json();
      if (result.ok) {
        await refreshRoiTracking();
      } else {
        setRoiTracking((current) => ({
          ...current,
          status: 'error',
          message: result.error ?? 'Could not start tracking.',
        }));
      }
    } catch {
      setRoiTracking((current) => ({
        ...current,
        status: 'error',
        message: 'Could not reach the tracking endpoint.',
      }));
    }
  }

  function payloadFor(command) {
    if (command === 'forward' || command === 'backward') {
      return { speed: driveSpeed, duration_ms: driveDuration };
    }
    if (command === 'set_speed') {
      return { speed: driveSpeed };
    }
    if (command === 'camera') {
      return { pan, tilt };
    }
    if (command === 'pan') {
      return { pan };
    }
    if (command === 'tilt') {
      return { tilt };
    }
    if (command === 'left_motor') {
      return { speed: leftMotor, duration_ms: motorDuration };
    }
    if (command === 'right_motor') {
      return { speed: rightMotor, duration_ms: motorDuration };
    }
    return {};
  }

  function queueCommand(run) {
    queueRef.current = queueRef.current.then(run, run);
    return queueRef.current;
  }

  async function postCommand(command, extraPayload = null) {
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, ...(extraPayload || payloadFor(command)) }),
    });
    const payload = await response.json();
    return { response, payload };
  }

  async function sendCommand(command, label, extraPayload = null) {
    return queueCommand(async () => {
      setBusy(true);
      try {
        const { response, payload } = await postCommand(command, extraPayload);
        const serialCommand = payload.serial_command ? ` [${payload.serial_command}]` : '';
        setCommandLog(`${label}${serialCommand}: ${response.ok ? payload.message : describeError(payload)}`);
      } catch {
        setCommandLog(`${label}: failed to reach the server.`);
      } finally {
        setBusy(false);
        refreshStatus();
      }
    });
  }

  async function sendDirectCommand(command, label, extraPayload = null) {
    try {
      const { response, payload } = await postCommand(command, extraPayload);
      const serialCommand = payload.serial_command ? ` [${payload.serial_command}]` : '';
      setCommandLog(`${label}${serialCommand}: ${response.ok ? payload.message : describeError(payload)}`);
    } catch {
      setCommandLog(`${label}: failed to reach the server.`);
    }
  }

  function clearDriveHoldTimer() {
    if (driveHoldRef.current.timerId !== null) {
      window.clearTimeout(driveHoldRef.current.timerId);
      driveHoldRef.current.timerId = null;
    }
  }

  function driveHoldPayload() {
    return {
      speed: driveConfigRef.current.speed,
      duration_ms: Math.max(driveConfigRef.current.duration, DRIVE_HOLD_MIN_PULSE_MS),
    };
  }

  function driveHoldRepeatDelay(durationMs) {
    return clamp(Math.floor(durationMs * 0.6), DRIVE_HOLD_MIN_REPEAT_MS, DRIVE_HOLD_MAX_REPEAT_MS);
  }

  async function runDriveHoldPulse(command, label) {
    if (driveHoldRef.current.command !== command || driveHoldRef.current.inFlight) {
      return;
    }

    driveHoldRef.current.inFlight = true;
    const payload = driveHoldPayload();

    try {
      const { response, payload: responsePayload } = await postCommand(command, payload);
      const serialCommand = responsePayload.serial_command ? ` [${responsePayload.serial_command}]` : '';
      setCommandLog(`${label}${serialCommand}: ${response.ok ? responsePayload.message : describeError(responsePayload)}`);
    } catch {
      setCommandLog(`${label}: failed to reach the server.`);
    } finally {
      driveHoldRef.current.inFlight = false;

      if (driveHoldRef.current.command !== command) {
        refreshStatus();
        return;
      }

      clearDriveHoldTimer();
      driveHoldRef.current.timerId = window.setTimeout(() => {
        void runDriveHoldPulse(command, label);
      }, driveHoldRepeatDelay(payload.duration_ms));
    }
  }

  function startDriveHold(command, label) {
    if (driveHoldRef.current.command === command) {
      return;
    }

    clearDriveHoldTimer();
    driveHoldRef.current.command = command;
    void runDriveHoldPulse(command, label);
  }

  async function stopDriveHold(options = {}) {
    const { sendStop = false, label = 'Drive Stop' } = options;
    const activeCommand = driveHoldRef.current.command;

    clearDriveHoldTimer();
    driveHoldRef.current.command = null;

    if (!sendStop || !activeCommand) {
      return;
    }

    await sendDirectCommand('stop', label);
    refreshStatus();
  }

  async function sendPivot(leftSpeed, rightSpeed, label) {
    return queueCommand(async () => {
      setBusy(true);
      try {
        const duration = motorDuration;
        const left = await postCommand('left_motor', { speed: leftSpeed, duration_ms: duration });
        if (!left.response.ok) {
          setCommandLog(`${label}: ${describeError(left.payload)}`);
          return;
        }
        const right = await postCommand('right_motor', { speed: rightSpeed, duration_ms: duration });
        if (!right.response.ok) {
          setCommandLog(`${label}: ${describeError(right.payload)}`);
          return;
        }
        setCommandLog(`${label}: MOTOR LEFT ${leftSpeed} ${duration} and MOTOR RIGHT ${rightSpeed} ${duration}`);
      } catch {
        setCommandLog(`${label}: failed to reach the server.`);
      } finally {
        setBusy(false);
        refreshStatus();
      }
    });
  }

  function setCameraTargetState(nextPan, nextTilt) {
    const clampedPan = clamp(nextPan, 0, 180);
    const clampedTilt = clamp(nextTilt, 0, 180);
    cameraTargetRef.current = { pan: clampedPan, tilt: clampedTilt };
    setPan(clampedPan);
    setTilt(clampedTilt);
    return { pan: clampedPan, tilt: clampedTilt };
  }

  function clearPendingCameraSend() {
    if (cameraSendTimerRef.current !== null) {
      window.clearTimeout(cameraSendTimerRef.current);
      cameraSendTimerRef.current = null;
    }
  }

  function flushCameraTarget() {
    clearPendingCameraSend();
    const pending = cameraPendingRef.current;
    if (!pending) {
      return;
    }

    const lastSent = cameraLastSentTargetRef.current;
    cameraPendingRef.current = null;

    if (lastSent && lastSent.pan === pending.pan && lastSent.tilt === pending.tilt) {
      return;
    }

    cameraLastSentAtRef.current = Date.now();
    cameraLastSentTargetRef.current = pending;
    void sendDirectCommand('camera', 'Camera Target', pending);
  }

  function scheduleCameraTarget(nextPan, nextTilt, options = {}) {
    const target = setCameraTargetState(nextPan, nextTilt);
    cameraPendingRef.current = target;

    if (options.immediate) {
      flushCameraTarget();
      return;
    }

    const elapsed = Date.now() - cameraLastSentAtRef.current;
    if (elapsed >= CAMERA_TARGET_THROTTLE_MS && cameraSendTimerRef.current === null) {
      flushCameraTarget();
      return;
    }

    clearPendingCameraSend();
    cameraSendTimerRef.current = window.setTimeout(
      flushCameraTarget,
      Math.max(CAMERA_TARGET_THROTTLE_MS - elapsed, 0)
    );
  }

  function commitCameraTarget() {
    flushCameraTarget();
  }

  function handlePanChange(value) {
    scheduleCameraTarget(value, cameraTargetRef.current.tilt);
  }

  function handleTiltChange(value) {
    scheduleCameraTarget(cameraTargetRef.current.pan, value);
  }

  function handleVideoClick(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const containerAspect = rect.width / rect.height;
    let visibleHFov = CAMERA_HFOV_DEG;
    let visibleVFov = CAMERA_VFOV_DEG;

    if (containerAspect > CAMERA_NATIVE_ASPECT) {
      visibleVFov = CAMERA_VFOV_DEG * (CAMERA_NATIVE_ASPECT / containerAspect);
    } else {
      visibleHFov = CAMERA_HFOV_DEG * (containerAspect / CAMERA_NATIVE_ASPECT);
    }

    const xFrac = (event.clientX - rect.left) / rect.width - 0.5;
    const yFrac = (event.clientY - rect.top) / rect.height - 0.5;
    const flipMultiplier = flipped ? -1 : 1;
    const nextPan = clamp(
      Math.round(cameraTargetRef.current.pan + (PAN_CLICK_SIGN * flipMultiplier * xFrac * visibleHFov * PAN_CLICK_GAIN)),
      0,
      180
    );
    const nextTilt = clamp(
      Math.round(cameraTargetRef.current.tilt + (TILT_CLICK_SIGN * flipMultiplier * yFrac * visibleVFov * TILT_CLICK_GAIN)),
      0,
      180
    );

    scheduleCameraTarget(nextPan, nextTilt, { immediate: true });
  }

  async function handleCenterCamera() {
    setTrackingEnabled(false);
    clearPendingCameraSend();
    cameraPendingRef.current = null;
    cameraLastSentTargetRef.current = null;
    setCameraTargetState(90, 90);
    await sendDirectCommand('center_camera', 'Center Camera');
  }

  // Accepts a vision snapshot directly so it can be called with fresh data
  // from refreshVision without waiting for a separate interval or ref sync.
  function trackingTick(v) {
    if (!trackingEnabledRef.current) return;
    if (!v.running || v.detections.length === 0) return;

    // Prefer target-labelled detections; fall back to highest-confidence any.
    const pool = v.targets.length > 0 ? v.targets : v.detections;
    const best = pool.reduce((a, b) => (b.confidence > a.confidence ? b : a));

    const cx = best.center?.x ?? (best.box ? best.box.x + best.box.w / 2 : 0.5);
    const cy = best.center?.y ?? (best.box ? best.box.y + best.box.h / 2 : 0.5);
    // Apply the same flip as the click handler so tracking direction matches.
    const flipMultiplier = flippedRef.current ? -1 : 1;
    const errorX = (cx - 0.5) * flipMultiplier;
    const errorY = (cy - 0.5) * flipMultiplier;

    // Dead-zone: don't move the servo when the target is already centred.
    if (Math.abs(errorX) < TRACKING_DEAD_ZONE && Math.abs(errorY) < TRACKING_DEAD_ZONE) return;

    const current = cameraTargetRef.current;
    const nextPan = clamp(
      Math.round(current.pan + PAN_CLICK_SIGN * errorX * CAMERA_HFOV_DEG * TRACKING_PAN_GAIN),
      0, 180
    );
    const nextTilt = clamp(
      Math.round(current.tilt + TILT_CLICK_SIGN * errorY * CAMERA_VFOV_DEG * TRACKING_TILT_GAIN),
      0, 180
    );
    scheduleCameraTarget(nextPan, nextTilt, { immediate: true });
  }

  function handleCameraAction(item) {
    if (item.command === 'center_camera') {
      void handleCenterCamera();
      return;
    }
    void sendCommand(item.command, item.label);
  }

  useEffect(() => {
    refreshStatus();
    refreshCameraStatus();
    refreshSecondaryCameraStatus();
    refreshSensors();
    refreshFirmwareStatus();
    refreshVision();
    refreshRoiTracking();
    return () => {
      clearDriveHoldTimer();
      clearPendingCameraSend();
    };
  }, []);

  useInterval(refreshStatus, 5000);
  useInterval(refreshCameraStatus, 5000);
  useInterval(refreshSecondaryCameraStatus, 5000);
  useInterval(refreshSensors, 1500);
  useInterval(refreshFirmwareStatus, FIRMWARE_STATUS_POLL_MS);
  useInterval(refreshVision, VISION_POLL_MS);
  useInterval(refreshRoiTracking, TRACKING_POLL_MS);

  useEffect(() => {
    function onBeforeInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.repeat) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return;
      }

      const key = event.key.toLowerCase();
      if (activeKeysRef.current.has(key)) {
        return;
      }
      activeKeysRef.current.add(key);

      if (key === 'w') {
        event.preventDefault();
        startDriveHold('forward', 'Keyboard Forward');
      } else if (key === 's') {
        event.preventDefault();
        startDriveHold('backward', 'Keyboard Reverse');
      } else if (key === 'a') {
        event.preventDefault();
        sendPivot(-driveSpeed, driveSpeed, 'Keyboard Pivot Left');
      } else if (key === 'd') {
        event.preventDefault();
        sendPivot(driveSpeed, -driveSpeed, 'Keyboard Pivot Right');
      } else if (key === ' ') {
        event.preventDefault();
        sendCommand('stop', 'Keyboard Stop');
      } else if (key === 'arrowleft') {
        event.preventDefault();
        scheduleCameraTarget(cameraTargetRef.current.pan - CAMERA_NUDGE_DEG, cameraTargetRef.current.tilt, { immediate: true });
      } else if (key === 'arrowright') {
        event.preventDefault();
        scheduleCameraTarget(cameraTargetRef.current.pan + CAMERA_NUDGE_DEG, cameraTargetRef.current.tilt, { immediate: true });
      } else if (key === 'arrowup') {
        event.preventDefault();
        scheduleCameraTarget(cameraTargetRef.current.pan, cameraTargetRef.current.tilt - CAMERA_NUDGE_DEG, { immediate: true });
      } else if (key === 'arrowdown') {
        event.preventDefault();
        scheduleCameraTarget(cameraTargetRef.current.pan, cameraTargetRef.current.tilt + CAMERA_NUDGE_DEG, { immediate: true });
      } else if (key === '[') {
        event.preventDefault();
        setDriveSpeed((value) => {
          const next = clamp(value - 5, 0, 255);
          setCommandLog(`Speed setpoint reduced to ${next}. Use Set Speed to push it to firmware.`);
          return next;
        });
      } else if (key === ']') {
        event.preventDefault();
        setDriveSpeed((value) => {
          const next = clamp(value + 5, 0, 255);
          setCommandLog(`Speed setpoint increased to ${next}. Use Set Speed to push it to firmware.`);
          return next;
        });
      }
    }

    function onKeyUp(event) {
      const key = event.key.toLowerCase();
      activeKeysRef.current.delete(key);

      if (key === 'w' && driveHoldRef.current.command === 'forward') {
        if (activeKeysRef.current.has('s')) {
          startDriveHold('backward', 'Keyboard Reverse');
          return;
        }
        void stopDriveHold({ sendStop: true, label: 'Keyboard Stop' });
      }

      if (key === 's' && driveHoldRef.current.command === 'backward') {
        if (activeKeysRef.current.has('w')) {
          startDriveHold('forward', 'Keyboard Forward');
          return;
        }
        void stopDriveHold({ sendStop: true, label: 'Keyboard Stop' });
      }
    }

    function onWindowBlur() {
      activeKeysRef.current.clear();
      void stopDriveHold({ sendStop: true, label: 'Keyboard Stop' });
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [driveSpeed, motorDuration]);

  function handleDriveButtonPress(event, command, label) {
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures from synthetic test events or unsupported pointers.
      }
    }
    startDriveHold(command, label);
  }

  function handleDriveButtonRelease(event, command, label) {
    if (typeof event.currentTarget.releasePointerCapture === 'function' && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release failures from synthetic test events or unsupported pointers.
      }
    }

    if (driveHoldRef.current.command === command) {
      void stopDriveHold({ sendStop: true, label });
    }
  }

  async function handleInstall() {
    if (!installPrompt) {
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <main className="app-shell">
      <section className="hero panel panel-screen">
        <div className="hero-bar">
          <div>
            <p className="eyebrow">React PWA drone tank control</p>
            <h1>Robot Tank Cockpit</h1>
          </div>
          <div className="hero-actions">
            {installPrompt ? (
              <button className="control small ghost" type="button" onClick={handleInstall}>Install App</button>
            ) : null}
            <button className={`control small flip-btn${flipped ? ' active' : ''}`} type="button" onClick={() => setFlipped((f) => !f)}>Flip Cam</button>
            <button className="control small stop" type="button" disabled={busy} onClick={() => sendCommand('stop', 'Stop All')}>Stop All</button>
          </div>
        </div>

        <div className="screen-grid">
          <section className="viewport-stack panel-block">
            <section className="viewport viewport-primary">
              <div
                ref={roiFrameRef}
                className="camera-frame-wrap"
                onClick={!roiSelectMode ? handleVideoClick : undefined}
                onMouseDown={roiSelectMode ? handleRoiMouseDown : undefined}
                style={{ cursor: roiSelectMode ? 'crosshair' : (camera.available ? 'default' : 'default') }}
              >
                {camera.available ? <img className="camera-stream" src={cameraStreamUrl} alt="Robot tank wide camera stream" style={{ transform: flipped ? 'rotate(180deg)' : 'none' }} /> : null}
                {camera.available ? <VisionOverlay detections={vision.detections} flipped={flipped} /> : null}
                {camera.available ? <TrackingOverlay tracking={roiTracking} flipped={flipped} /> : null}
                {roiDrag ? <RoiSelectionOverlay drag={roiDrag} /> : null}
                <div className="camera-overlay">
                  <div className="camera-hud-top">
                    <div className="status-stack status-stack-inline">
                      <StatusPill label={serialIndicator.label} tone={serialIndicator.tone} />
                      <StatusPill label={cameraIndicator.label} tone={cameraIndicator.tone} />
                      <StatusPill label={appIndicator.label} tone={appIndicator.tone} />
                    </div>
                    <div className="camera-label-badge">Wide Cam</div>
                  </div>
                  <div className="camera-detail-strip detail-grid detail-grid-overlay">
                    <DetailCard>{serialDetail}</DetailCard>
                    <DetailCard>{sensorDetail}</DetailCard>
                  </div>
                  {!camera.available ? <div className="camera-placeholder">{camera.message}</div> : null}
                </div>
              </div>
            </section>

            <section className="viewport viewport-secondary">
              <div className="camera-frame-wrap secondary-camera-wrap">
                {secondaryCamera.available ? <img className="camera-stream" src={secondaryCameraStreamUrl} alt="Robot tank secondary camera stream" /> : null}
                <div className="camera-overlay secondary-camera-overlay">
                  <div className="camera-hud-top">
                    <div className="status-stack status-stack-inline">
                      <StatusPill label={secondaryCamera.available ? 'Aux camera live' : 'Aux camera offline'} tone={secondaryCamera.available ? 'ok' : 'error'} />
                    </div>
                    <div className="camera-label-badge">Aux Cam</div>
                  </div>
                  {!secondaryCamera.available ? <div className="camera-placeholder">{secondaryCamera.message}</div> : null}
                </div>
              </div>
            </section>
          </section>

          <section className="command-deck">
            <article className="subpanel drive-cluster wide-panel">
              <HeaderActions title="Drive" actions={commandButtons} disabled={busy} onAction={(item) => sendCommand(item.command, item.label)} />
              <p className="status-detail compact-help">
                <GamepadIndicator connected={gamepadConnected} name={gamepadName} />
              </p>
              <div className="drive-pad">
                <div className="pad-spacer" />
                <button
                  className="control pad-button"
                  type="button"
                  disabled={busy}
                  onClick={(event) => event.preventDefault()}
                  onPointerCancel={(event) => handleDriveButtonRelease(event, 'forward', 'Forward Stop')}
                  onPointerDown={(event) => handleDriveButtonPress(event, 'forward', 'Forward')}
                  onPointerUp={(event) => handleDriveButtonRelease(event, 'forward', 'Forward Stop')}
                ><strong className="control-label">Forward</strong><span>W</span></button>
                <div className="pad-spacer" />
                <button className="control pivot-button secondary" type="button" disabled={busy} onClick={() => sendPivot(-driveSpeed, driveSpeed, 'Pivot Left')}><strong className="control-label">Pivot Left</strong><span>A</span></button>
                <button className="control stop" type="button" disabled={busy} onClick={() => sendCommand('stop', 'Stop')}><strong className="control-label">Stop</strong><span>Space</span></button>
                <button className="control pivot-button secondary" type="button" disabled={busy} onClick={() => sendPivot(driveSpeed, -driveSpeed, 'Pivot Right')}><strong className="control-label">Pivot Right</strong><span>D</span></button>
                <div className="pad-spacer" />
                <button
                  className="control pad-button"
                  type="button"
                  disabled={busy}
                  onClick={(event) => event.preventDefault()}
                  onPointerCancel={(event) => handleDriveButtonRelease(event, 'backward', 'Reverse Stop')}
                  onPointerDown={(event) => handleDriveButtonPress(event, 'backward', 'Reverse')}
                  onPointerUp={(event) => handleDriveButtonRelease(event, 'backward', 'Reverse Stop')}
                ><strong className="control-label">Reverse</strong><span>S</span></button>
                <div className="pad-spacer" />
              </div>
            </article>

            <div className="control-grid">
              <article className="subpanel tuning-panel">
                <div className="subpanel-head compact"><h2>Live Tuning</h2></div>
                <div className="slider-grid tuning-grid">
                  <RangeField label="Speed" min={0} max={255} value={driveSpeed} onChange={setDriveSpeed} />
                  <NumberField label="Drive Pulse (ms)" min={0} max={60000} step={50} value={driveDuration} onChange={setDriveDuration} />
                  <NumberField label="Pivot Pulse (ms)" min={0} max={60000} step={50} value={motorDuration} onChange={setMotorDuration} />
                </div>
              </article>

              <article className="subpanel camera-cluster">
                <HeaderActions title="Turret" actions={cameraButtons} disabled={busy} onAction={handleCameraAction} />
                <div className="slider-grid compact-slider-grid">
                  <RangeField label="Pan" min={0} max={180} value={pan} onChange={handlePanChange} onCommit={commitCameraTarget} />
                  <RangeField label="Tilt" min={0} max={180} value={tilt} onChange={handleTiltChange} onCommit={commitCameraTarget} />
                </div>
                <div className="tracking-bar">
                  <button
                    className={`control small track-btn${trackingEnabled ? ' active' : ''}`}
                    type="button"
                    onClick={() => setTrackingEnabled((t) => !t)}
                  >
                    {trackingEnabled ? 'Tracking ON' : 'Track Target'}
                  </button>
                  {trackingEnabled ? (
                    <span className="status-detail tracking-label">
                      {vision.targets.length > 0
                        ? `Locking: ${vision.targets[0].label}`
                        : vision.detections.length > 0
                          ? `Locking: ${vision.detections[0].label}`
                          : 'Searching…'}
                    </span>
                  ) : null}
                </div>
                <div className="tracking-bar roi-tracking-bar">
                  <button
                    className={`control small track-btn${roiSelectMode ? ' active' : ''}`}
                    type="button"
                    onClick={() => {
                      if (roiSelectMode) {
                        setRoiSelectMode(false);
                        setRoiDrag(null);
                        roiDragRef.current = null;
                      } else {
                        setRoiSelectMode(true);
                      }
                    }}
                  >
                    {roiSelectMode ? 'Drawing…' : 'Track area'}
                  </button>
                  {(roiTracking.status === 'tracking' || roiTracking.status === 'lost') ? (
                    <button
                      className="control small secondary"
                      type="button"
                      onClick={stopRoiTracking}
                    >
                      Stop tracking
                    </button>
                  ) : null}
                  {roiTracking.status === 'tracking' ? (
                    <button
                      className={`control small${roiTracking.follow_enabled ? ' active' : ''}`}
                      type="button"
                      onClick={toggleRoiFollow}
                      title="Move the camera gimbal to keep the tracked area centered"
                    >
                      {roiTracking.follow_enabled ? 'Following ON' : 'Follow with gimbal'}
                    </button>
                  ) : null}
                  {roiTracking.status === 'tracking' ? (
                    <span className="status-detail tracking-label">
                      {roiTracking.label ?? 'manual selection'}
                    </span>
                  ) : roiTracking.status === 'lost' ? (
                    <span className="status-detail tracking-label" style={{ color: 'var(--warning)' }}>
                      Tracking lost — select the object again.
                    </span>
                  ) : roiSelectMode ? (
                    <span className="status-detail tracking-label">
                      Drag a box over the camera feed.
                    </span>
                  ) : null}
                </div>
                <p className="status-detail compact-help">Drag sliders for live target updates. Click video to center a point. Arrows nudge camera.</p>
              </article>

              <article className="subpanel motor-cluster">
                <div className="subpanel-head compact"><h2>Motor Override</h2></div>
                <div className="slider-grid two-up compact-slider-grid">
                  <RangeField label="Left Motor" min={-255} max={255} value={leftMotor} onChange={setLeftMotor} />
                  <RangeField label="Right Motor" min={-255} max={255} value={rightMotor} onChange={setRightMotor} />
                </div>
                <div className="aux-grid compact-aux-grid">
                  <button className="control small secondary" type="button" disabled={busy} onClick={() => sendCommand('left_motor', 'Run Left Motor')}>Run Left Motor</button>
                  <button className="control small secondary" type="button" disabled={busy} onClick={() => sendCommand('right_motor', 'Run Right Motor')}>Run Right Motor</button>
                </div>
              </article>

              <article className="subpanel firmware-panel">
                <div className="subpanel-head compact">
                  <h2>Firmware</h2>
                  <div className="mini-actions">
                    <button className="control small secondary" type="button" onClick={refreshFirmwareStatus}>Refresh Firmware Status</button>
                  </div>
                </div>
                <div className="detail-grid firmware-grid">
                  <DetailCard>Build: {firmware.firmware_build || '--'}</DetailCard>
                  <DetailCard>Built: {firmware.firmware_build_display || '--'}</DetailCard>
                  <DetailCard>Date: {firmware.firmware_build_date || '--'}</DetailCard>
                  <DetailCard>Time: {firmware.firmware_build_time || '--'}</DetailCard>
                  <DetailCard>Speed: {Number.isFinite(firmware.speed) ? firmware.speed : '--'}</DetailCard>
                  <DetailCard>Pan: {formatAxisStatus(firmware.pan, firmware.target_pan)}</DetailCard>
                  <DetailCard>Tilt: {formatAxisStatus(firmware.tilt, firmware.target_tilt)}</DetailCard>
                </div>
                <p className="status-detail sensor-copy">{firmwareDetail}</p>
              </article>

              <article className="subpanel sensor-panel wide-panel">
                <div className="subpanel-head compact">
                  <h2>Sensor Watch</h2>
                  <div className="mini-actions">
                    <button className="control small secondary" type="button" onClick={refreshSensors}>Refresh Sensors</button>
                  </div>
                </div>
                <div className="sensor-grid">
                  <SensorMetric label="Front Distance" value={sensors.sonar_cm} unit="cm" maximum={400} tone="sonar" />
                  <SensorMetric label="Bottom Left" value={sensors.line_left} maximum={1023} tone="line" />
                  <SensorMetric label="Bottom Middle" value={sensors.line_middle} maximum={1023} tone="line" />
                  <SensorMetric label="Bottom Right" value={sensors.line_right} maximum={1023} tone="line" />
                </div>
                <p className="status-detail sensor-copy">{sensorDetail}</p>
                <p className="status-detail sensor-copy">Firmware reply: {sensorResponseDetail}</p>
              </article>

              <article className="subpanel vision-panel wide-panel">
                <div className="subpanel-head compact">
                  <h2>Vision</h2>
                  <div className="status-stack status-stack-inline">
                    <StatusPill label={visionIndicator.label} tone={visionIndicator.tone} />
                    <StatusPill label="Monitor only" tone="warning" />
                  </div>
                </div>
                <div className="detail-grid vision-grid">
                  <DetailCard>Backend: {vision.model_backend || 'disabled'}</DetailCard>
                  <DetailCard>Model: {vision.model_path || 'Not configured'}</DetailCard>
                  <DetailCard>Last Seen: {visionLastSeen}</DetailCard>
                  <DetailCard>FPS: {Number.isFinite(vision.fps) ? vision.fps : 0}</DetailCard>
                  <DetailCard>People: {vision.people_count}</DetailCard>
                  <DetailCard>Dogs: {vision.dog_count}</DetailCard>
                  <DetailCard>Hazards: {hazardCount}</DetailCard>
                  <DetailCard>Targets: {targetCount}</DetailCard>
                </div>
                <p className="status-detail sensor-copy">{vision.message}</p>
                <p className="status-detail sensor-copy">Vision labels and alerts are monitor-only in this phase. No drive or chase commands are sent from detections.</p>
              </article>

              <article className="subpanel telemetry-panel">
                <div className="subpanel-head compact"><h2>Mission Log</h2></div>
                <p className="command-result compact-log">{commandLog}</p>
                <p className="status-detail keyboard-help compact-help">Hold Forward or Reverse, or hold W/S, for continuous drive. A/D pivot, Space stop, arrows move camera, [ and ] adjust speed.</p>
              </article>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function StatusPill({ label, tone }) {
  return <span className={`status-pill status-${tone}`}>{label}</span>;
}

/**
 * Small gamepad icon + status text.
 * When connected the icon is accent-coloured; when disconnected it is muted.
 */
function GamepadIndicator({ connected, name }) {
  const title = connected
    ? `${name || 'Controller'} connected`
    : 'Controller disconnected';

  return (
    <span
      className={`status-pill status-${connected ? 'ok' : 'pending'}`}
      title={title}
      aria-label={title}
      data-testid="gamepad-indicator"
    >
      {/* Minimal inline gamepad SVG — no external dependency */}
      <svg
        width="14"
        height="10"
        viewBox="0 0 14 10"
        aria-hidden="true"
        style={{ verticalAlign: 'middle', marginRight: '4px', opacity: connected ? 1 : 0.45 }}
      >
        <rect x="1" y="2" width="12" height="6" rx="3" ry="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <line x1="3.5" y1="5" x2="5.5" y2="5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        <line x1="4.5" y1="4" x2="4.5" y2="6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="9.5" cy="5" r="0.8" fill="currentColor" />
        <circle cx="11" cy="4" r="0.8" fill="currentColor" />
      </svg>
      {connected ? (name || 'Controller: connected') : 'Controller: disconnected'}
    </span>
  );
}

function DetailCard({ children }) {
  return <p className="status-detail">{children}</p>;
}

function HeaderActions({ title, actions, onAction, disabled }) {
  return (
    <div className="subpanel-head compact">
      <h2>{title}</h2>
      <div className="mini-actions">
        {actions.map((item) => (
          <button
            key={`${title}-${item.command}`}
            className={`control small ${item.tone || ''}`.trim()}
            type="button"
            disabled={disabled}
            onClick={() => onAction(item)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RangeField({ label, min, max, value, onChange, onCommit }) {
  function handleCommit(event) {
    if (!onCommit) {
      return;
    }
    onCommit(Number(event.currentTarget.value));
  }

  return (
    <label className="control-group">
      <span>{label}</span>
      <div className="inline-control">
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step="1"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={handleCommit}
          onMouseUp={handleCommit}
          onTouchEnd={handleCommit}
          onKeyUp={handleCommit}
        />
        <output>{value}</output>
      </div>
    </label>
  );
}

function NumberField({ label, min, max, step, value, onChange }) {
  return (
    <label className="control-group">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function SensorMetric({ label, value, unit = '', maximum, tone }) {
  const hasValue = Number.isFinite(value);
  const safeValue = hasValue ? value : 0;
  const fill = maximum > 0 ? `${Math.max(0, Math.min(100, (safeValue / maximum) * 100))}%` : '0%';

  return (
    <div className={`sensor-card sensor-${tone}`} style={{ '--sensor-fill': fill }}>
      <p className="sensor-label">{label}</p>
      <p className="sensor-value">{hasValue ? `${value}${unit ? ` ${unit}` : ''}` : '--'}</p>
      <div className="sensor-bar" aria-hidden="true">
        <span className="sensor-bar-fill" />
      </div>
    </div>
  );
}

function VisionOverlay({ detections, flipped, sourceAspect = DEFAULT_SOURCE_ASPECT }) {
  const containerRef = useRef(null);
  const [containerAspect, setContainerAspect] = useState(sourceAspect);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerAspect(rect.width / rect.height);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!Array.isArray(detections) || detections.length === 0) {
    return null;
  }

  const projected = detections.map((detection) => {
    const box = projectNormalizedBox(detection.box || { x: 0, y: 0, w: 0, h: 0 }, {
      sourceAspect,
      containerAspect,
    });
    const center = {
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
    };
    return { ...detection, _projectedBox: box, _projectedCenter: center };
  });

  return (
    <svg
      ref={containerRef}
      className="vision-overlay-svg"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-label="Vision overlay"
      style={{ transform: flipped ? 'rotate(180deg)' : 'none' }}
    >
      {projected.map((detection, index) => (
        <g key={`${detection.label}-${index}`} data-testid={`vision-box-${index}`} className={`vision-detection tone-${detection.category || 'object'}`}>
          <rect
            x={detection._projectedBox.x}
            y={detection._projectedBox.y}
            width={detection._projectedBox.w}
            height={detection._projectedBox.h}
            rx="0.01"
            ry="0.01"
          />
          <text x={detection._projectedBox.x} y={Math.max(0.03, detection._projectedBox.y - 0.015)}>{`${detection.label} ${Math.round((detection.confidence || 0) * 100)}%`}</text>
          <circle cx={detection._projectedCenter.x} cy={detection._projectedCenter.y} r="0.01" />
        </g>
      ))}
    </svg>
  );
}

/**
 * Renders the live tracking box returned by /api/tracking/status.
 * Monitor-only — never feeds drive commands.
 */
function TrackingOverlay({ tracking, flipped, sourceAspect = DEFAULT_SOURCE_ASPECT }) {
  const containerRef = useRef(null);
  const [containerAspect, setContainerAspect] = useState(sourceAspect);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerAspect(rect.width / rect.height);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!tracking || tracking.status !== 'tracking' || !tracking.box) {
    return null;
  }

  const projected = projectNormalizedBox(tracking.box, { sourceAspect, containerAspect });
  const cx = projected.x + projected.w / 2;
  const cy = projected.y + projected.h / 2;

  return (
    <svg
      ref={containerRef}
      className="vision-overlay-svg"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-label="Tracking overlay"
      style={{ transform: flipped ? 'rotate(180deg)' : 'none' }}
    >
      <g data-testid="tracking-box" className="tracking-roi-box">
        <rect
          x={projected.x}
          y={projected.y}
          width={projected.w}
          height={projected.h}
          rx="0.008"
          ry="0.008"
          fill="none"
          stroke="rgba(249,185,80,0.9)"
          strokeWidth="0.006"
          strokeDasharray="0.02 0.01"
        />
        <circle cx={cx} cy={cy} r="0.008" fill="rgba(249,185,80,0.7)" />
        <text
          x={projected.x}
          y={Math.max(0.03, projected.y - 0.012)}
          fill="rgba(249,185,80,0.9)"
          fontSize="0.038"
          fontWeight="700"
          paintOrder="stroke"
          stroke="rgba(4,10,18,0.88)"
          strokeWidth="0.01"
        >
          {tracking.label ?? 'manual selection'}
        </text>
      </g>
    </svg>
  );
}

/**
 * Renders the in-progress drag selection rectangle in container coords.
 * Uses a simple absolute-positioned SVG so it sits on top of the camera feed.
 */
function RoiSelectionOverlay({ drag }) {
  const x = Math.min(drag.x0, drag.x1);
  const y = Math.min(drag.y0, drag.y1);
  const w = Math.abs(drag.x1 - drag.x0);
  const h = Math.abs(drag.y1 - drag.y0);

  return (
    <svg
      className="vision-overlay-svg"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-label="ROI selection"
      data-testid="roi-selection-overlay"
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="rgba(19,176,165,0.12)"
        stroke="rgba(19,176,165,0.9)"
        strokeWidth="0.005"
        strokeDasharray="0.025 0.012"
      />
    </svg>
  );
}
