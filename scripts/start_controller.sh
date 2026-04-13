#!/usr/bin/env bash
set -euo pipefail

repo_dir="/home/ron/repos/robot_tank_rpi"
venv_activate="$repo_dir/.venv/bin/activate"

detect_serial_port() {
  local candidate
  for candidate in /dev/ttyUSB* /dev/ttyACM*; do
    if [[ -e "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' "${TANK_SERIAL_PORT:-/dev/ttyUSB0}"
}

cd "$repo_dir"
source "$venv_activate"

export TANK_SERVER_HOST="${TANK_SERVER_HOST:-0.0.0.0}"
export TANK_SERVER_PORT="${TANK_SERVER_PORT:-5000}"
export TANK_SERIAL_BAUD="${TANK_SERIAL_BAUD:-115200}"
export TANK_SERIAL_READY_DELAY="${TANK_SERIAL_READY_DELAY:-2.0}"
export TANK_DEFAULT_DRIVE_SPEED="${TANK_DEFAULT_DRIVE_SPEED:-50}"
export TANK_DEFAULT_DRIVE_DURATION_MS="${TANK_DEFAULT_DRIVE_DURATION_MS:-400}"
export TANK_SERIAL_PORT="$(detect_serial_port)"

exec python3 -m server.app