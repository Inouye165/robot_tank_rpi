const statusPill = document.getElementById('serial-status');
const statusDetail = document.getElementById('serial-detail');
const statusBanner = document.getElementById('serial-banner');
const commandResult = document.getElementById('command-result');
const buttons = Array.from(document.querySelectorAll('[data-command]'));

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

async function sendCommand(command, label) {
  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command }),
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

refreshStatus();
window.setInterval(refreshStatus, 5000);