const statusPill = document.getElementById('serial-status');
const appHealth = document.getElementById('app-health');
const cameraHealth = document.getElementById('camera-health');
const statusDetail = document.getElementById('serial-detail');
const statusBanner = document.getElementById('serial-banner');
const startupIssues = document.getElementById('startup-issues');
const commandResult = document.getElementById('command-result');
const cockpit = document.querySelector('[data-camera-stream-port]');
const cameraStatus = document.getElementById('camera-status');
const cameraStream = document.getElementById('camera-stream');
const cameraPlaceholder = document.getElementById('camera-placeholder');
const installButton = document.getElementById('install-app');
const buttons = Array.from(document.querySelectorAll('[data-command]'));
const keyboardButtons = Array.from(document.querySelectorAll('[data-key-action]'));
const speedRange = document.getElementById('speed-range');
const speedValue = document.getElementById('speed-value');
const durationInput = document.getElementById('duration-ms');
const panRange = document.getElementById('pan-range');
const panValue = document.getElementById('pan-value');
const tiltRange = document.getElementById('tilt-range');
const tiltValue = document.getElementById('tilt-value');
const leftMotorSpeed = document.getElementById('left-motor-speed');
const leftMotorValue = document.getElementById('left-motor-value');
const rightMotorSpeed = document.getElementById('right-motor-speed');
const rightMotorValue = document.getElementById('right-motor-value');
const motorDurationInput = document.getElementById('motor-duration-ms');
const cameraStreamPort = cockpit ? cockpit.dataset.cameraStreamPort : '8081';

let deferredInstallPrompt = null;
let commandQueue = Promise.resolve();
const activeKeys = new Set();

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

function buildCameraBaseUrl() {
  return `${window.location.protocol}//${window.location.hostname}:${cameraStreamPort}`;
}

function setPillState(element, label, level) {
  element.className = 'status-pill';
  if (level === 'ok') {
    element.classList.add('status-ok');
  } else if (level === 'warning') {
    element.classList.add('status-warning');
  } else if (level === 'error') {
    element.classList.add('status-error');
  } else {
    element.classList.add('status-pending');
  }
  element.textContent = label;
}

function showCameraUnavailable(message) {
  setPillState(cameraHealth, 'Camera offline', 'error');
  cameraStatus.textContent = message;
  cameraStream.classList.add('is-hidden');
  cameraStream.removeAttribute('src');
  cameraPlaceholder.classList.remove('is-hidden');
}

function showCameraAvailable(message) {
  setPillState(cameraHealth, 'Camera live', 'ok');
  cameraStatus.textContent = message;
  if (!cameraStream.getAttribute('src')) {
    cameraStream.src = `${buildCameraBaseUrl()}/stream.mjpg`;
  }
  cameraStream.classList.remove('is-hidden');
  cameraPlaceholder.classList.add('is-hidden');
}

function syncOutput(input, output) {
  output.textContent = input.value;
}

function readCommandPayload(command) {
  if (command === 'forward' || command === 'backward') {
    return {
      speed: Number(speedRange.value),
      duration_ms: Number(durationInput.value),
    };
  }

  if (command === 'set_speed') {
    return {
      speed: Number(speedRange.value),
    };
  }

  if (command === 'camera') {
    return {
      pan: Number(panRange.value),
      tilt: Number(tiltRange.value),
    };
  }

  if (command === 'pan') {
    return {
      pan: Number(panRange.value),
    };
  }

  if (command === 'tilt') {
    return {
      tilt: Number(tiltRange.value),
    };
  }

  if (command === 'left_motor') {
    return {
      speed: Number(leftMotorSpeed.value),
      duration_ms: Number(motorDurationInput.value),
    };
  }

  if (command === 'right_motor') {
    return {
      speed: Number(rightMotorSpeed.value),
      duration_ms: Number(motorDurationInput.value),
    };
  }

  return {};
}

function describeError(payload) {
  if (!payload) {
    return 'Unknown error.';
  }

  const help = payload.error_code ? SERIAL_ERROR_HELP[payload.error_code] : null;
  if (help) {
    return `${payload.message} ${help}`;
  }
  return payload.message;
}

function renderStartupIssues(issues) {
  if (!issues || issues.length === 0) {
    startupIssues.textContent = 'No startup issues reported.';
    return;
  }

  startupIssues.textContent = issues.map((issue) => issue.message).join(' ');
}

function setStatus(status) {
  renderStartupIssues(status.startup_issues || []);

  if (status.connected) {
    setPillState(statusPill, 'Serial ready', 'ok');
    setPillState(appHealth, 'App online', 'ok');
    statusDetail.textContent = `Serial link ready on ${status.port} @ ${status.baud_rate}.`;
    statusBanner.textContent = status.startup_banner
      ? `Startup banner: ${status.startup_banner}`
      : 'Startup banner not seen yet.';
    return;
  }

  setPillState(statusPill, 'Serial blocked', 'error');
  setPillState(appHealth, 'App degraded', 'warning');
  const help = status.error_code ? SERIAL_ERROR_HELP[status.error_code] : null;
  statusDetail.textContent = help ? `${status.error} ${help}` : (status.error || `No serial device available on ${status.port}.`);
  statusBanner.textContent = status.last_response
    ? `Last Uno response: ${status.last_response}`
    : 'No Uno response captured yet.';
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    setStatus(status);
  } catch (error) {
    setPillState(statusPill, 'Serial unknown', 'error');
    setPillState(appHealth, 'App offline', 'error');
    statusDetail.textContent = 'Could not reach the Flask server.';
    statusBanner.textContent = 'Command feedback is unavailable because the app API did not respond.';
  }
}

async function refreshCameraStatus() {
  try {
    const response = await fetch(`${buildCameraBaseUrl()}/status`);
    const status = await response.json();
    if (status.available) {
      showCameraAvailable(status.message || 'Camera stream is live.');
    } else {
      showCameraUnavailable(status.message || 'Camera stream unavailable.');
    }
  } catch (error) {
    showCameraUnavailable('Could not reach the camera streaming service.');
  }
}

function setButtonsDisabled(disabled) {
  buttons.forEach((button) => {
    button.disabled = disabled;
  });
  keyboardButtons.forEach((button) => {
    button.disabled = disabled;
  });
}

async function postCommand(command) {
  const requestBody = {
    command,
    ...readCommandPayload(command),
  };

  const response = await fetch('/api/command', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  const payload = await response.json();
  return { response, payload };
}

function queueCommand(run) {
  commandQueue = commandQueue.then(run, run);
  return commandQueue;
}

async function sendCommand(command, label) {
  return queueCommand(async () => {
    setButtonsDisabled(true);

    try {
      const { response, payload } = await postCommand(command);
      const serialCommand = payload.serial_command ? ` [${payload.serial_command}]` : '';
      const detail = response.ok ? payload.message : describeError(payload);
      commandResult.textContent = `${label}${serialCommand}: ${detail}`;
    } catch (error) {
      commandResult.textContent = `${label}: failed to reach the server.`;
    } finally {
      setButtonsDisabled(false);
      refreshStatus();
    }
  });
}

async function sendPivot(leftSpeed, rightSpeed, label) {
  return queueCommand(async () => {
    setButtonsDisabled(true);

    try {
      const duration = Number(motorDurationInput.value);
      const left = await fetch('/api/command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'left_motor',
          speed: leftSpeed,
          duration_ms: duration,
        }),
      });
      const leftPayload = await left.json();
      if (!left.ok) {
        commandResult.textContent = `${label}: ${describeError(leftPayload)}`;
        return;
      }

      const right = await fetch('/api/command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'right_motor',
          speed: rightSpeed,
          duration_ms: duration,
        }),
      });
      const rightPayload = await right.json();
      if (!right.ok) {
        commandResult.textContent = `${label}: ${describeError(rightPayload)}`;
        return;
      }

      commandResult.textContent = `${label}: MOTOR LEFT ${leftSpeed} ${duration} and MOTOR RIGHT ${rightSpeed} ${duration}`;
    } catch (error) {
      commandResult.textContent = `${label}: failed to reach the server.`;
    } finally {
      setButtonsDisabled(false);
      refreshStatus();
    }
  });
}

function adjustRange(input, output, delta, minimum, maximum) {
  const nextValue = Math.max(minimum, Math.min(maximum, Number(input.value) + delta));
  input.value = String(nextValue);
  syncOutput(input, output);
}

function targetIsEditable(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function markButtonActive(selector, active) {
  const button = document.querySelector(selector);
  if (button) {
    button.classList.toggle('is-active', active);
  }
}

function handleKeyboardCommand(event) {
  if (event.repeat || targetIsEditable(event.target)) {
    return;
  }

  const key = event.key.toLowerCase();
  if (activeKeys.has(key)) {
    return;
  }
  activeKeys.add(key);

  if (key === 'w') {
    event.preventDefault();
    markButtonActive('[data-command="forward"]', true);
    sendCommand('forward', 'Keyboard Forward');
    return;
  }

  if (key === 's') {
    event.preventDefault();
    markButtonActive('[data-command="backward"]', true);
    sendCommand('backward', 'Keyboard Reverse');
    return;
  }

  if (key === 'a') {
    event.preventDefault();
    markButtonActive('[data-key-action="pivot-left"]', true);
    sendPivot(-Number(speedRange.value), Number(speedRange.value), 'Keyboard Pivot Left');
    return;
  }

  if (key === 'd') {
    event.preventDefault();
    markButtonActive('[data-key-action="pivot-right"]', true);
    sendPivot(Number(speedRange.value), -Number(speedRange.value), 'Keyboard Pivot Right');
    return;
  }

  if (key === ' ') {
    event.preventDefault();
    markButtonActive('[data-command="stop"]', true);
    sendCommand('stop', 'Keyboard Stop');
    return;
  }

  if (key === 'arrowleft') {
    event.preventDefault();
    adjustRange(panRange, panValue, -5, 0, 180);
    sendCommand('pan', 'Keyboard Pan Left');
    return;
  }

  if (key === 'arrowright') {
    event.preventDefault();
    adjustRange(panRange, panValue, 5, 0, 180);
    sendCommand('pan', 'Keyboard Pan Right');
    return;
  }

  if (key === 'arrowup') {
    event.preventDefault();
    adjustRange(tiltRange, tiltValue, -5, 0, 180);
    sendCommand('tilt', 'Keyboard Tilt Up');
    return;
  }

  if (key === 'arrowdown') {
    event.preventDefault();
    adjustRange(tiltRange, tiltValue, 5, 0, 180);
    sendCommand('tilt', 'Keyboard Tilt Down');
    return;
  }

  if (key === '[') {
    event.preventDefault();
    adjustRange(speedRange, speedValue, -5, 0, 255);
    commandResult.textContent = `Speed setpoint reduced to ${speedRange.value}. Use Set Speed to push it to firmware.`;
    return;
  }

  if (key === ']') {
    event.preventDefault();
    adjustRange(speedRange, speedValue, 5, 0, 255);
    commandResult.textContent = `Speed setpoint increased to ${speedRange.value}. Use Set Speed to push it to firmware.`;
    return;
  }
}

function handleKeyboardRelease(event) {
  const key = event.key.toLowerCase();
  activeKeys.delete(key);

  if (key === 'w') {
    markButtonActive('[data-command="forward"]', false);
  }
  if (key === 's') {
    markButtonActive('[data-command="backward"]', false);
  }
  if (key === 'a') {
    markButtonActive('[data-key-action="pivot-left"]', false);
  }
  if (key === 'd') {
    markButtonActive('[data-key-action="pivot-right"]', false);
  }
  if (key === ' ') {
    markButtonActive('[data-command="stop"]', false);
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/service-worker.js').catch(() => {
      commandResult.textContent = 'PWA service worker registration failed.';
    });
  }
}

function wireInstallPrompt() {
  if (!installButton) {
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.classList.remove('is-hidden');
  });

  installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.classList.add('is-hidden');
  });
}

buttons.forEach((button) => {
  button.addEventListener('click', () => {
    sendCommand(button.dataset.command, button.textContent.replace(/\s+/g, ' ').trim());
  });
});

keyboardButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.keyAction === 'pivot-left') {
      sendPivot(-Number(speedRange.value), Number(speedRange.value), 'Pivot Left');
    }
    if (button.dataset.keyAction === 'pivot-right') {
      sendPivot(Number(speedRange.value), -Number(speedRange.value), 'Pivot Right');
    }
  });
});

syncOutput(speedRange, speedValue);
syncOutput(panRange, panValue);
syncOutput(tiltRange, tiltValue);
syncOutput(leftMotorSpeed, leftMotorValue);
syncOutput(rightMotorSpeed, rightMotorValue);

speedRange.addEventListener('input', () => {
  syncOutput(speedRange, speedValue);
});

panRange.addEventListener('input', () => {
  syncOutput(panRange, panValue);
});

tiltRange.addEventListener('input', () => {
  syncOutput(tiltRange, tiltValue);
});

leftMotorSpeed.addEventListener('input', () => {
  syncOutput(leftMotorSpeed, leftMotorValue);
});

rightMotorSpeed.addEventListener('input', () => {
  syncOutput(rightMotorSpeed, rightMotorValue);
});

window.addEventListener('keydown', handleKeyboardCommand);
window.addEventListener('keyup', handleKeyboardRelease);

registerServiceWorker();
wireInstallPrompt();
refreshStatus();
refreshCameraStatus();
window.setInterval(refreshStatus, 5000);
window.setInterval(refreshCameraStatus, 5000);
