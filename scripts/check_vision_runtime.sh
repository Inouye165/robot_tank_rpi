#!/usr/bin/env bash
# Quick runtime-config check for the robot_tank_rpi controller.
#
# Run on the Pi (no sudo required for most checks). Prints the systemd
# state, recent logs, vision API payloads, model file existence, and
# whether OpenCV can be imported by the venv.

set -u

repo_dir="/home/ron/repos/robot_tank_rpi"
host="${TANK_DEBUG_HOST:-127.0.0.1}"
port="${TANK_SERVER_PORT:-5000}"
camera_port="${TANK_CAMERA_STREAM_PORT:-8081}"
model_path="${TANK_VISION_MODEL_PATH:-}"

section() {
  printf '\n=== %s ===\n' "$1"
}

section "systemd: robot-tank-rpi.service"
systemctl status robot-tank-rpi.service --no-pager 2>/dev/null | head -n 20 \
  || echo "(systemctl unavailable or service not installed)"

section "journal: last 50 lines"
journalctl -u robot-tank-rpi.service -n 50 --no-pager 2>/dev/null \
  || echo "(journalctl unavailable)"

section "GET /api/vision/status"
curl -sS --max-time 3 "http://${host}:${port}/api/vision/status" \
  || echo "(controller not reachable on ${host}:${port})"
echo

section "GET /api/vision/detections"
curl -sS --max-time 3 "http://${host}:${port}/api/vision/detections" \
  || echo "(controller not reachable on ${host}:${port})"
echo

section "Camera stream HEAD ${host}:${camera_port}"
curl -sS -I --max-time 3 "http://${host}:${camera_port}/stream.mjpg" \
  || echo "(camera stream not reachable)"

section "OpenCV import (venv)"
if [[ -x "${repo_dir}/.venv/bin/python3" ]]; then
  "${repo_dir}/.venv/bin/python3" - <<'PY' || true
try:
    import cv2  # type: ignore
    print(f"cv2 OK: {cv2.__version__}")
except Exception as exc:  # pragma: no cover - operator diagnostic
    print(f"cv2 import FAILED: {exc}")
PY
else
  echo "(venv python not found at ${repo_dir}/.venv/bin/python3)"
fi

section "Model file"
if [[ -n "${model_path}" ]]; then
  if [[ -f "${model_path}" ]]; then
    printf 'present: %s (%s bytes)\n' "${model_path}" "$(stat -c %s "${model_path}" 2>/dev/null || echo '?')"
  else
    printf 'MISSING: %s\n' "${model_path}"
  fi
else
  echo "(TANK_VISION_MODEL_PATH not set in this shell; the systemd unit may still set it via .env)"
fi

section "Effective env (from this shell)"
env | grep -E '^TANK_' | sort || true
