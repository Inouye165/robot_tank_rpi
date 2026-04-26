#!/usr/bin/env bash
set -euo pipefail

repo_dir="/home/ron/repos/robot_tank_rpi"
venv_activate="$repo_dir/.venv/bin/activate"
env_file="$repo_dir/.env"

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

# Load operator-supplied runtime config from a local .env if present. The
# file is gitignored; .env.example documents the supported keys. Every
# assignment is auto-exported so the values reach the Python process.
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

# Server / serial defaults.
export TANK_SERVER_HOST="${TANK_SERVER_HOST:-0.0.0.0}"
export TANK_SERVER_PORT="${TANK_SERVER_PORT:-5000}"
export TANK_SERIAL_BAUD="${TANK_SERIAL_BAUD:-115200}"
export TANK_SERIAL_READY_DELAY="${TANK_SERIAL_READY_DELAY:-2.0}"
export TANK_DEFAULT_DRIVE_SPEED="${TANK_DEFAULT_DRIVE_SPEED:-50}"
export TANK_DEFAULT_DRIVE_DURATION_MS="${TANK_DEFAULT_DRIVE_DURATION_MS:-400}"
export TANK_SERIAL_PORT="${TANK_SERIAL_PORT:-$(detect_serial_port)}"

# Vision defaults. Safe defaults: vision is OFF unless explicitly enabled
# via .env, and people/dogs are NOT target candidates by default. This is
# still monitor-only — no autonomous movement, no drive commands from
# detections.
export TANK_VISION_ENABLED="${TANK_VISION_ENABLED:-false}"
export TANK_VISION_MODEL_BACKEND="${TANK_VISION_MODEL_BACKEND:-disabled}"
export TANK_VISION_MODEL_PATH="${TANK_VISION_MODEL_PATH:-}"
export TANK_VISION_SOURCE_URL="${TANK_VISION_SOURCE_URL:-http://127.0.0.1:8081/stream.mjpg}"
export TANK_VISION_SAMPLE_FPS="${TANK_VISION_SAMPLE_FPS:-2}"
export TANK_VISION_CONFIDENCE="${TANK_VISION_CONFIDENCE:-0.45}"
export TANK_VISION_FRAME_WIDTH="${TANK_VISION_FRAME_WIDTH:-640}"
export TANK_VISION_TARGET_LABELS="${TANK_VISION_TARGET_LABELS:-tennis ball,traffic cone,marker}"

exec python3 -m server.app