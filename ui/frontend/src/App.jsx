import { useEffect, useMemo, useRef, useState } from 'react';

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
  speed: null,
  pan: null,
  target_pan: null,
  tilt: null,
  target_tilt: null,
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
const CAMERA_HFOV_DEG = 62;
const CAMERA_VFOV_DEG = 48;
const CAMERA_NATIVE_ASPECT = 4 / 3;
const CAMERA_NUDGE_DEG = 5;
const FIRMWARE_STATUS_POLL_MS = 20000;

// Click-to-center is calibrated in software because exact centering depends on camera FOV,
// object-fit crop, servo direction, backlash, and mount geometry on the physical tank.
const PAN_CLICK_SIGN = -1;
const TILT_CLICK_SIGN = -1;
const PAN_CLICK_GAIN = 1;
const TILT_CLICK_GAIN = 1;

function getAppConfig() {
  return window.__TANK_APP_CONFIG__ || { cameraStreamPort: 8081 };
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
  const [sensors, setSensors] = useState(defaultSensors);
  const [firmware, setFirmware] = useState(defaultFirmware);
  const [serverOnline, setServerOnline] = useState(true);
  const [commandLog, setCommandLog] = useState('No command sent yet.');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flipped, setFlipped] = useState(true);
  const activeKeysRef = useRef(new Set());
  const queueRef = useRef(Promise.resolve());
  const cameraTargetRef = useRef({ pan: 90, tilt: 90 });
  const cameraPendingRef = useRef(null);
  const cameraLastSentAtRef = useRef(0);
  const cameraLastSentTargetRef = useRef(null);
  const cameraSendTimerRef = useRef(null);
  const appConfig = useMemo(() => getAppConfig(), []);
  const cameraBaseUrl = useMemo(
    () => `${window.location.protocol}//${window.location.hostname}:${appConfig.cameraStreamPort}`,
    [appConfig.cameraStreamPort]
  );

  const serialIndicator = statusLevel(status);
  const cameraIndicator = cameraLevel(camera);
  const appIndicator = appLevel(status, serverOnline);

  const serialDetail = status.connected
    ? `Serial link ready on ${status.port} @ ${status.baud_rate}.`
    : describeError({ message: status.error || `No serial device available on ${status.port}.`, error_code: status.error_code });

  const cameraStreamUrl = `${cameraBaseUrl}/stream.mjpg`;
  const sensorDetail = sensors.available
    ? `Front sonar ${sensors.sonar_cm} cm. Bottom sensors L ${sensors.line_left}, M ${sensors.line_middle}, R ${sensors.line_right}.`
    : describeError({ message: sensors.message, error_code: sensors.error_code });
  const sensorResponseDetail = sensors.response || 'No sensor response captured yet.';
  const firmwareDetail = firmware.ok
    ? 'R3-reported camera state.'
    : describeError({ message: firmware.message, error_code: firmware.error_code });

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
    clearPendingCameraSend();
    cameraPendingRef.current = null;
    cameraLastSentTargetRef.current = null;
    setCameraTargetState(90, 90);
    await sendDirectCommand('center_camera', 'Center Camera');
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
    refreshSensors();
    refreshFirmwareStatus();
    return () => {
      clearPendingCameraSend();
    };
  }, []);

  useInterval(refreshStatus, 5000);
  useInterval(refreshCameraStatus, 5000);
  useInterval(refreshSensors, 1500);
  useInterval(refreshFirmwareStatus, FIRMWARE_STATUS_POLL_MS);

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
        sendCommand('forward', 'Keyboard Forward');
      } else if (key === 's') {
        event.preventDefault();
        sendCommand('backward', 'Keyboard Reverse');
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
      activeKeysRef.current.delete(event.key.toLowerCase());
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [driveSpeed, motorDuration]);

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
          <section className="viewport panel-block">
            <div className="camera-frame-wrap" onClick={handleVideoClick} style={{ cursor: camera.available ? 'crosshair' : 'default' }}>
              {camera.available ? <img className="camera-stream" src={cameraStreamUrl} alt="Robot tank camera stream" style={{ transform: flipped ? 'rotate(180deg)' : 'none' }} /> : null}
              <div className="camera-overlay">
                <div className="camera-hud-top">
                  <div className="status-stack status-stack-inline">
                    <StatusPill label={serialIndicator.label} tone={serialIndicator.tone} />
                    <StatusPill label={cameraIndicator.label} tone={cameraIndicator.tone} />
                    <StatusPill label={appIndicator.label} tone={appIndicator.tone} />
                  </div>
                </div>
                <div className="camera-detail-strip detail-grid detail-grid-overlay">
                  <DetailCard>{serialDetail}</DetailCard>
                  <DetailCard>{sensorDetail}</DetailCard>
                </div>
                {!camera.available ? <div className="camera-placeholder">{camera.message}</div> : null}
              </div>
            </div>
          </section>

          <section className="command-deck">
            <article className="subpanel drive-cluster wide-panel">
              <HeaderActions title="Drive" actions={commandButtons} disabled={busy} onAction={(item) => sendCommand(item.command, item.label)} />
              <div className="drive-pad">
                <div className="pad-spacer" />
                <button className="control pad-button" type="button" disabled={busy} onClick={() => sendCommand('forward', 'Forward')}><strong className="control-label">Forward</strong><span>W</span></button>
                <div className="pad-spacer" />
                <button className="control pivot-button secondary" type="button" disabled={busy} onClick={() => sendPivot(-driveSpeed, driveSpeed, 'Pivot Left')}><strong className="control-label">Pivot Left</strong><span>A</span></button>
                <button className="control stop" type="button" disabled={busy} onClick={() => sendCommand('stop', 'Stop')}><strong className="control-label">Stop</strong><span>Space</span></button>
                <button className="control pivot-button secondary" type="button" disabled={busy} onClick={() => sendPivot(driveSpeed, -driveSpeed, 'Pivot Right')}><strong className="control-label">Pivot Right</strong><span>D</span></button>
                <div className="pad-spacer" />
                <button className="control pad-button" type="button" disabled={busy} onClick={() => sendCommand('backward', 'Reverse')}><strong className="control-label">Reverse</strong><span>S</span></button>
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

              <article className="subpanel telemetry-panel">
                <div className="subpanel-head compact"><h2>Mission Log</h2></div>
                <p className="command-result compact-log">{commandLog}</p>
                <p className="status-detail keyboard-help compact-help">Keyboard: W/S drive, A/D pivot, Space stop, arrows move camera, [ and ] adjust speed.</p>
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
