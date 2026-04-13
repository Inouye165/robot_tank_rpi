import { useEffect, useMemo, useRef, useState } from 'react';

const SERIAL_ERROR_HELP = {
  'serial-port-missing': 'Serial port missing. Check the USB cable and TANK_SERIAL_PORT.',
  'serial-port-busy': 'Serial port busy. Another process is already using the Arduino link.',
  'serial-permission-denied': 'Serial permission denied. Add the service user to dialout or fix device permissions.',
  'serial-open-failed': 'Serial port failed to open. Check the configured device and baud settings.',
  'serial-write-timeout': 'Serial write timed out. The Arduino may be powered but not accepting writes.',
  'serial-disconnected': 'Serial device disconnected while a command was in flight.',
  'serial-command-failed': 'Serial command failed. Inspect the device and retry.',
  'firmware-error': 'The Arduino rejected the command and returned an error.',
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

const commandButtons = [
  { command: 'set_speed', label: 'Set Speed', tone: 'secondary' },
  { command: 'ping', label: 'Ping', tone: 'secondary' },
  { command: 'firmware_status', label: 'Read Status', tone: 'secondary' },
];

const cameraButtons = [
  { command: 'center_camera', label: 'Center', tone: 'secondary' },
  { command: 'camera', label: 'Set Camera', tone: 'secondary' },
  { command: 'pan', label: 'Pan', tone: 'secondary' },
  { command: 'tilt', label: 'Tilt', tone: 'secondary' },
  { command: 'ramp_test', label: 'Ramp Test', tone: 'secondary' },
];

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
  const [serverOnline, setServerOnline] = useState(true);
  const [commandLog, setCommandLog] = useState('No command sent yet.');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const activeKeysRef = useRef(new Set());
  const queueRef = useRef(Promise.resolve());
  const appConfig = useMemo(() => getAppConfig(), []);
  const cameraBaseUrl = useMemo(
    () => `${window.location.protocol}//${window.location.hostname}:${appConfig.cameraStreamPort}`,
    [appConfig.cameraStreamPort]
  );

  const serialIndicator = statusLevel(status);
  const cameraIndicator = cameraLevel(camera);
  const appIndicator = appLevel(status, serverOnline);

  const startupIssueText = status.startup_issues?.length
    ? status.startup_issues.map((issue) => issue.message).join(' ')
    : 'No startup issues reported.';

  const serialDetail = status.connected
    ? `Serial link ready on ${status.port} @ ${status.baud_rate}.`
    : describeError({ message: status.error || `No serial device available on ${status.port}.`, error_code: status.error_code });

  const serialBanner = status.connected
    ? (status.startup_banner ? `Startup banner: ${status.startup_banner}` : 'Startup banner not seen yet.')
    : (status.last_response ? `Last Uno response: ${status.last_response}` : 'No Uno response captured yet.');

  const cameraStreamUrl = `${cameraBaseUrl}/stream.mjpg`;

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

  useEffect(() => {
    refreshStatus();
    refreshCameraStatus();
  }, []);

  useInterval(refreshStatus, 5000);
  useInterval(refreshCameraStatus, 5000);

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
        setPan((value) => {
          const next = clamp(value - 5, 0, 180);
          sendCommand('pan', 'Keyboard Pan Left', { pan: next });
          return next;
        });
      } else if (key === 'arrowright') {
        event.preventDefault();
        setPan((value) => {
          const next = clamp(value + 5, 0, 180);
          sendCommand('pan', 'Keyboard Pan Right', { pan: next });
          return next;
        });
      } else if (key === 'arrowup') {
        event.preventDefault();
        setTilt((value) => {
          const next = clamp(value - 5, 0, 180);
          sendCommand('tilt', 'Keyboard Tilt Up', { tilt: next });
          return next;
        });
      } else if (key === 'arrowdown') {
        event.preventDefault();
        setTilt((value) => {
          const next = clamp(value + 5, 0, 180);
          sendCommand('tilt', 'Keyboard Tilt Down', { tilt: next });
          return next;
        });
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
  }, [driveSpeed, motorDuration, pan, tilt]);

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
            <p className="subtitle">Installed on mobile it runs standalone; on desktop it keeps the full mission view on one screen.</p>
          </div>
          <div className="hero-actions">
            {installPrompt ? (
              <button className="control small ghost" type="button" onClick={handleInstall}>Install App</button>
            ) : null}
            <button className="control small stop" type="button" disabled={busy} onClick={() => sendCommand('stop', 'Stop All')}>Stop All</button>
          </div>
        </div>

        <div className="screen-grid">
          <section className="viewport panel-block">
            <div className="camera-frame-wrap">
              {camera.available ? <img className="camera-stream" src={cameraStreamUrl} alt="Robot tank camera stream" /> : null}
              <div className="camera-overlay">
                <div className="status-stack status-stack-inline">
                  <StatusPill label={serialIndicator.label} tone={serialIndicator.tone} />
                  <StatusPill label={cameraIndicator.label} tone={cameraIndicator.tone} />
                  <StatusPill label={appIndicator.label} tone={appIndicator.tone} />
                </div>
                {!camera.available ? <div className="camera-placeholder">{camera.message}</div> : null}
              </div>
            </div>

            <div className="detail-grid">
              <DetailCard>{serialDetail}</DetailCard>
              <DetailCard>{camera.message}</DetailCard>
              <DetailCard>{serialBanner}</DetailCard>
              <DetailCard>{startupIssueText}</DetailCard>
            </div>
          </section>

          <section className="command-deck">
            <article className="subpanel drive-cluster">
              <HeaderActions title="Drive" actions={commandButtons} disabled={busy} onAction={(item) => sendCommand(item.command, item.label)} />
              <div className="drive-pad">
                <div className="pad-spacer" />
                <button className="control pad-button" type="button" disabled={busy} onClick={() => sendCommand('forward', 'Forward')}>Forward<span>W</span></button>
                <div className="pad-spacer" />
                <button className="control pivot-button secondary" type="button" disabled={busy} onClick={() => sendPivot(-driveSpeed, driveSpeed, 'Pivot Left')}>Pivot Left<span>A</span></button>
                <button className="control stop" type="button" disabled={busy} onClick={() => sendCommand('stop', 'Stop')}>Stop<span>Space</span></button>
                <button className="control pivot-button secondary" type="button" disabled={busy} onClick={() => sendPivot(driveSpeed, -driveSpeed, 'Pivot Right')}>Pivot Right<span>D</span></button>
                <div className="pad-spacer" />
                <button className="control pad-button" type="button" disabled={busy} onClick={() => sendCommand('backward', 'Reverse')}>Reverse<span>S</span></button>
                <div className="pad-spacer" />
              </div>
            </article>

            <article className="subpanel tuning-panel">
              <h2>Live Tuning</h2>
              <div className="slider-grid">
                <RangeField label="Speed" min={0} max={255} value={driveSpeed} onChange={setDriveSpeed} />
                <NumberField label="Drive Pulse (ms)" min={0} max={60000} step={50} value={driveDuration} onChange={setDriveDuration} />
                <NumberField label="Pivot Pulse (ms)" min={0} max={60000} step={50} value={motorDuration} onChange={setMotorDuration} />
              </div>
            </article>

            <article className="subpanel camera-cluster">
              <HeaderActions title="Turret" actions={cameraButtons} disabled={busy} onAction={(item) => sendCommand(item.command, item.label)} />
              <div className="slider-grid">
                <RangeField label="Pan" min={0} max={180} value={pan} onChange={setPan} />
                <RangeField label="Tilt" min={0} max={180} value={tilt} onChange={setTilt} />
              </div>
              <div className="aux-grid">
                <button className="control small secondary" type="button" disabled={busy} onClick={() => sendCommand('pan', 'Pan')}>Pan Left/Right<span>Arrow Left/Right</span></button>
                <button className="control small secondary" type="button" disabled={busy} onClick={() => sendCommand('tilt', 'Tilt')}>Tilt Up/Down<span>Arrow Up/Down</span></button>
              </div>
            </article>

            <article className="subpanel motor-cluster">
              <div className="subpanel-head compact"><h2>Motor Override</h2></div>
              <div className="slider-grid two-up">
                <RangeField label="Left Motor" min={-255} max={255} value={leftMotor} onChange={setLeftMotor} />
                <RangeField label="Right Motor" min={-255} max={255} value={rightMotor} onChange={setRightMotor} />
              </div>
              <div className="aux-grid">
                <button className="control small secondary" type="button" disabled={busy} onClick={() => sendCommand('left_motor', 'Run Left Motor')}>Run Left Motor</button>
                <button className="control small secondary" type="button" disabled={busy} onClick={() => sendCommand('right_motor', 'Run Right Motor')}>Run Right Motor</button>
              </div>
            </article>

            <article className="subpanel telemetry-panel">
              <div className="subpanel-head compact"><h2>Mission Log</h2></div>
              <p className="command-result">{commandLog}</p>
              <p className="status-detail keyboard-help">Keyboard: W/S drive, A/D pivot, Space stop, arrows move camera, [ and ] adjust speed.</p>
            </article>
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

function RangeField({ label, min, max, value, onChange }) {
  return (
    <label className="control-group">
      <span>{label}</span>
      <div className="inline-control">
        <input type="range" min={min} max={max} step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} />
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
