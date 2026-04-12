const statusPill = document.getElementById('serial-status');
const statusDetail = document.getElementById('serial-detail');
const statusBanner = document.getElementById('serial-banner');
const commandResult = document.getElementById('command-result');
const cameraPanel = document.querySelector('[data-camera-stream-port]');
const cameraStatus = document.getElementById('camera-status');
const cameraStream = document.getElementById('camera-stream');
const cameraPlaceholder = document.getElementById('camera-placeholder');
const buttons = Array.from(document.querySelectorAll('[data-command]'));
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
const cameraStreamPort = cameraPanel ? cameraPanel.dataset.cameraStreamPort : '8081';

function buildCameraBaseUrl() {
  return `${window.location.protocol}//${window.location.hostname}:${cameraStreamPort}`;
}

function showCameraUnavailable(message) {
  cameraStatus.textContent = message;
  cameraStream.classList.add('is-hidden');
  cameraStream.removeAttribute('src');
  cameraPlaceholder.classList.remove('is-hidden');
}

function showCameraAvailable(message) {
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

function setStatus(status) {
  statusPill.className = 'status-pill';

  if (status.connected) {
    statusPill.classList.add('status-ok');
    statusPill.textContent = 'Connected';
    statusDetail.textContent = `Serial link ready on ${status.port} @ ${status.baud_rate}`;
    statusBanner.textContent = status.startup_banner
      ? `Startup banner: ${status.startup_banner}`
      : 'Startup banner not seen yet.';
  } else {
    statusPill.classList.add('status-error');
    statusPill.textContent = 'Disconnected';
    statusDetail.textContent = status.error || `No serial device available on ${status.port}`;
    statusBanner.textContent = status.last_response
      ? `Last Uno response: ${status.last_response}`
      : 'No Uno response captured yet.';
  }
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    setStatus(status);
  } catch (error) {
    statusPill.className = 'status-pill status-error';
    statusPill.textContent = 'Unavailable';
    statusDetail.textContent = 'Could not reach the Flask server.';
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

async function sendCommand(command, label) {
  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
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
    const serialCommand = payload.serial_command ? ` [${payload.serial_command}]` : '';
    commandResult.textContent = `${label}${serialCommand}: ${payload.message}`;
  } catch (error) {
    commandResult.textContent = `${label}: failed to reach the server.`;
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    refreshStatus();
  }
}

buttons.forEach((button) => {
  button.addEventListener('click', () => {
    sendCommand(button.dataset.command, button.textContent.trim());
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

refreshStatus();
refreshCameraStatus();
window.setInterval(refreshStatus, 5000);
window.setInterval(refreshCameraStatus, 5000);