# robot_tank_rpi

Pi-side local web controller for the robot tank. This project runs on the Raspberry Pi and sends line-based ASCII commands over USB serial to an Arduino Uno R3.

## V1 scope

- Local Flask server bound to `0.0.0.0`
- Separate camera streaming service for embedding a live camera view in the controller page
- Browser UI with large motion controls for the commands the current Uno firmware actually supports
- Single-screen PWA cockpit that keeps camera, telemetry, and controls visible together
- Drive speed control and camera pan/tilt controls that map directly to the Uno serial protocol
- Independent left and right motor controls for motor-level testing and steering checks
- Reusable serial service with safe handling when the Arduino is not connected
- Structured startup and serial error reporting for operator-facing diagnostics
- Serial-open warmup for Arduino auto-reset behavior
- No camera streaming, auth, database, or Docker in this phase

## Command mapping

- `FORWARD <speed> <duration_ms>` timed forward pulse from the web UI
- `BACKWARD <speed> <duration_ms>` timed reverse pulse from the web UI
- `SPEED <speed>` updates the Uno's default drive speed
- `CAMERA <pan> <tilt>` sets both camera servos from the web UI
- `CAMERANOW <pan> <tilt>` jumps immediately for calibration/testing
- `PAN <angle>`
- `TILT <angle>`
- `CENTERCAM`
- `MOTOR LEFT <signed_speed> <duration_ms>`
- `MOTOR RIGHT <signed_speed> <duration_ms>`
- `STATUS`
- `SENSORS` (Pi-only request used by `/api/sensors`; firmware replies `SENSORS LINE <left> <middle> <right> SONAR <cm>`)
- `STOP`
- `PING`
- `RAMPTEST`

Example commands sent by the Pi app:

- `FORWARD 50 400`
- `BACKWARD 50 400`
- `SPEED 20`
- `CAMERA 120 75`
- `CAMERANOW 120 75`
- `PAN 100`
- `TILT 60`
- `CENTERCAM`
- `MOTOR LEFT -40 500`
- `MOTOR RIGHT 55 250`
- `STATUS`
- `STOP`
- `PING`
- `RAMPTEST`

Each command is sent as ASCII text terminated by a newline.

## Configuration

The app reads configuration from environment variables.

- `TANK_SERVER_HOST` default: `0.0.0.0`
- `TANK_SERVER_PORT` default: `5000`
- `TANK_CAMERA_INDEX` default: `0`
- `TANK_CAMERA_WIDTH` default: `1280`
- `TANK_CAMERA_HEIGHT` default: `720`
- `TANK_CAMERA_SENSOR_WIDTH` default: `4608`
- `TANK_CAMERA_SENSOR_HEIGHT` default: `2592`
- `TANK_CAMERA_STREAM_PORT` default: `8081`
- `TANK_SECONDARY_CAMERA_STREAM_PORT` default: `8082`
- `TANK_CAMERA_JPEG_QUALITY` default: `80` (used by `scripts/start_camera_stream.py`)
- `TANK_CAMERA_FRAME_FORMAT` default: `RGB888` (used by `scripts/start_camera_stream.py`)
- `TANK_VISION_ENABLED` default: `false`
- `TANK_VISION_SOURCE_URL` default: `http://127.0.0.1:${TANK_CAMERA_STREAM_PORT}/stream.mjpg`
- `TANK_VISION_MODEL_PATH` default: unset
- `TANK_VISION_MODEL_BACKEND` default: `disabled`
- `TANK_VISION_SAMPLE_FPS` default: `2`
- `TANK_VISION_CONFIDENCE` default: `0.45`
- `TANK_VISION_FRAME_WIDTH` default: `640`
- `TANK_VISION_TARGET_LABELS` default: `tennis ball,traffic cone,marker` (monitor-only safety: people/dogs are detected and counted but are NOT target candidates by default)
- `TANK_VISION_SOURCE_ASPECT` default: `1.7777777778` (16/9; used by the overlay geometry helper to letterbox-correct boxes)
- `TANK_VISION_HAZARD_LABELS` default: `chair,backpack,suitcase,bottle,box,cup,sports ball,potted plant,traffic cone,unknown obstacle`
- `TANK_SERIAL_PORT` default: `/dev/ttyACM0`
- `TANK_SERIAL_BAUD` default: `115200`
- `TANK_SERIAL_WRITE_TIMEOUT` default: `1.0`
- `TANK_SERIAL_READY_DELAY` default: `2.0`
- `TANK_DEFAULT_DRIVE_SPEED` default: `50`
- `TANK_DEFAULT_DRIVE_DURATION_MS` default: `400`

See `.env.example` for a sample configuration.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

Optional test dependencies:

```bash
pip install -r requirements-dev.txt
```

Frontend build dependencies:

```bash
sudo apt-get install -y nodejs npm
npm install
```

## Run

```bash
source .venv/bin/activate
npm run build
export TANK_SERIAL_PORT=/dev/ttyACM0
export TANK_SERIAL_BAUD=115200
export TANK_SERVER_PORT=5000
python3 -m server.app
```

The Flask template serves the built React cockpit from `ui/static/dist`, so rebuild the frontend after React UI changes before restarting the controller service.

The Flask server listens on `0.0.0.0`, so open it from another device on the same Wi-Fi with:

```text
http://<pi-ip>:5000/
```

The primary (wide-angle) camera stream is served separately on `http://<pi-ip>:8081/stream.mjpg` and the auxiliary stream on `http://<pi-ip>:8082/stream.mjpg`. Both are embedded into the cockpit automatically.

## API surface

- `GET /` React PWA cockpit (Flask template loads the built Vite bundle)
- `GET /sw.js` PWA service worker
- `GET /api/status` serial link state plus startup issues and camera status URLs
- `GET /api/sensors` parsed `SENSORS LINE <l> <m> <r> SONAR <cm>` snapshot
- `GET /api/firmware/status` parsed `STATUS` snapshot from firmware
- `GET /api/vision/status` and `GET /api/vision/detections` monitor-only vision payloads
- `POST /api/command` send a mapped serial command (see `COMMANDS` in `server/app.py`)

## Vision monitoring

This phase adds monitor-only vision monitoring to the Pi-side cockpit. It watches the existing primary MJPEG stream instead of opening the Pi camera directly, classifies candidate detections into people, dogs, hazards, targets, and generic objects, and exposes the latest snapshot through:

- `GET /api/vision/status`
- `GET /api/vision/detections`

The cockpit overlays normalized boxes on the main camera view and shows counts for people, dogs, hazards, and target candidates.

Safety boundary for this phase:

- vision is monitor-only
- detections do not send drive commands
- detections do not chase targets
- the existing `Stop` control remains manual and unchanged

Vision defaults to disabled. When disabled, or when no model/backend is configured, the API returns a calm status payload instead of crashing.

Suggested model placement:

- `models/yolo-nano.onnx`

Do not commit large model files to this repo. Place them on the Pi locally and point `TANK_VISION_MODEL_PATH` at the file you want to test.

Recommended vision settings for this phase:

- keep `TANK_VISION_SAMPLE_FPS=2` on Raspberry Pi 5 CPU mode for low-FPS monitoring
- treat hazard marking as a heuristic only; it is based on lower-frame obstacle-like detections, not true floor understanding
- use accelerator hardware such as Raspberry Pi AI HAT+ later if you want real-time object detection beyond lightweight monitoring

Example configuration:

```bash
export TANK_VISION_ENABLED=true
export TANK_VISION_MODEL_BACKEND=opencv_onnx
export TANK_VISION_MODEL_PATH=$PWD/models/yolo-nano.onnx
# Safe markers only by default. Add person/dog ONLY if you understand the
# implications; this phase is still monitor-only and does not act on targets.
export TANK_VISION_TARGET_LABELS=tennis ball,traffic cone,marker
```

If OpenCV/model support is not installed, leave `TANK_VISION_MODEL_BACKEND=disabled` and the cockpit will stay in monitor-only standby.

### Real vision backend (`opencv_onnx`)

The optional OpenCV ONNX backend wires a real YOLO-style detector to the
existing monitor-only pipeline. It is still **monitor-only**: detections do
not send drive commands and the `Stop` controls remain manual and
prominent.

How it works:

- A long-lived `MjpegFrameReader` opens **one** connection to the wide
  camera stream (`http://127.0.0.1:8081/stream.mjpg`) and caches the
  latest decoded frame.
- The vision worker samples that cached frame at `TANK_VISION_SAMPLE_FPS`
  and runs `OpenCvOnnxDetector.detect_frame(...)` on it. The MJPEG stream
  is **not** reopened every loop.
- Detections are classified into people, dogs, hazards, targets, and
  generic objects using the existing rules. People and dogs are still
  **not** target candidates by default (see `TANK_VISION_TARGET_LABELS`).

Install the optional dependencies (or just the headless OpenCV wheel):

```bash
pip install opencv-python-headless numpy
```

Place a COCO-trained ONNX YOLO model on the Pi locally. The repository
ships an empty `models/` directory and a `models/README.md`; weights are
gitignored. For example:

```bash
mkdir -p models
# copy your local file
cp ~/Downloads/yolo-nano.onnx models/yolo-nano.onnx
```

Example environment to enable the backend:

```bash
export TANK_VISION_ENABLED=true
export TANK_VISION_MODEL_BACKEND=opencv_onnx
export TANK_VISION_MODEL_PATH=$PWD/models/yolo-nano.onnx
export TANK_VISION_SOURCE_URL=http://127.0.0.1:8081/stream.mjpg
export TANK_VISION_SAMPLE_FPS=2
export TANK_VISION_CONFIDENCE=0.45
export TANK_VISION_FRAME_WIDTH=640
# Safe markers only by default. Add person/dog ONLY if you understand the
# implications; this phase is still monitor-only and does not act on targets.
export TANK_VISION_TARGET_LABELS=tennis ball,traffic cone,marker
```

This phase is **CPU-only first** and is expected to be **low FPS** on the
Pi (1–3 FPS depending on the model). Use accelerator hardware such as the
Raspberry Pi AI HAT+ later if you want real-time detection.

Manual test steps:

1. Confirm the wide camera stream is up:
   `curl -I http://<pi-ip>:8081/stream.mjpg` should return `200 OK`.
2. Open the cockpit at `http://<pi-ip>:5000/`.
3. Hit `http://<pi-ip>:5000/api/vision/status` and confirm
   `enabled=true`, `model_loaded=true`, `stream_connected=true`.
4. Hit `http://<pi-ip>:5000/api/vision/detections` and confirm the
   `detections` array is populated when something COCO-known is in view.
5. In the browser, the Wide Cam viewport should overlay coloured boxes on
   detected objects. The Vision pill should read **Vision active**.
6. If the pill reads **Vision model missing**, the ONNX file path is
   wrong or OpenCV is not installed. If it reads **Vision waiting for
   stream**, the MJPEG stream is unreachable — check the camera service.

Failure modes are intentionally calm: missing OpenCV, missing model file,
or unreachable stream all leave the cockpit responsive with a clear
status message instead of crashing.

Find the Pi IP with:

```bash
hostname -I
```

If the Uno is not on `/dev/ttyACM0`, check the available device nodes with `ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null` and set `TANK_SERIAL_PORT` accordingly. On this Pi, the live verification used `/dev/ttyUSB0`.

## Auto-start on boot

This repo includes a small launcher script at `scripts/start_controller.sh` that auto-detects the first available Uno serial device from `/dev/ttyUSB*` or `/dev/ttyACM*` and then starts the Flask controller.

### Runtime configuration via `.env`

`scripts/start_controller.sh` loads a local `.env` file at the repo root if
one exists, before applying defaults. This is how the systemd unit picks up
operator-supplied values for the vision backend (otherwise it would start
with vision disabled).

- The file lives at `/home/ron/repos/robot_tank_rpi/.env`.
- It is **gitignored**. Do not commit secrets or local model paths.
- `.env.example` documents every supported key.
- The script applies safe defaults for any value the `.env` does not set,
  so vision stays **disabled** unless explicitly enabled. People and dogs
  remain non-target by default. No autonomous movement, no drive commands
  from vision.

Example `.env` for enabling the real backend on the Pi:

```bash
TANK_VISION_ENABLED=true
TANK_VISION_MODEL_BACKEND=opencv_onnx
TANK_VISION_MODEL_PATH=/home/ron/repos/robot_tank_rpi/models/yolo-nano.onnx
TANK_VISION_SOURCE_URL=http://127.0.0.1:8081/stream.mjpg
TANK_VISION_SAMPLE_FPS=2
TANK_VISION_CONFIDENCE=0.45
TANK_VISION_FRAME_WIDTH=640
TANK_VISION_TARGET_LABELS=tennis ball,traffic cone,marker
```

After changing `.env`, restart the service:

```bash
sudo systemctl restart robot-tank-rpi.service
```

### Manual UI test mode (`fake` backend)

For verifying the cockpit overlay/state machine without a real ONNX model:

```bash
TANK_VISION_ENABLED=true
TANK_VISION_MODEL_BACKEND=fake
```

This emits a couple of synthetic detections, is **clearly labelled
FAKE/TEST in `/api/vision/status`**, and never sends drive commands.
Switch back to `disabled` or `opencv_onnx` for normal operation.

### Verifying runtime config on the Pi

The repo ships a small diagnostic script at
`scripts/check_vision_runtime.sh`. It prints the systemd state, recent
journal lines, the live `/api/vision/status` and `/api/vision/detections`
payloads, the camera stream HEAD response, an OpenCV import check using
the project venv, and whether the configured model file exists.

```bash
bash /home/ron/repos/robot_tank_rpi/scripts/check_vision_runtime.sh
```

You can also run the underlying commands by hand:

```bash
# Service state and recent logs
systemctl status robot-tank-rpi.service
sudo journalctl -u robot-tank-rpi.service -n 100 --no-pager

# Live vision payloads (controller default port 5000)
curl -sS http://127.0.0.1:5000/api/vision/status | jq .
curl -sS http://127.0.0.1:5000/api/vision/detections | jq .

# Camera stream is reachable (primary wide cam)
curl -I http://127.0.0.1:8081/stream.mjpg

# OpenCV import using the project venv
/home/ron/repos/robot_tank_rpi/.venv/bin/python3 -c "import cv2; print(cv2.__version__)"

# Model file exists
ls -la "$TANK_VISION_MODEL_PATH"
```

Expected results when the backend is healthy: `enabled=true`,
`model_loaded=true`, `stream_connected=true`, and the cockpit Vision pill
reads **Vision active**.

The camera stream services use system Python so they can access `picamera2` even though the main app runs inside the project virtualenv. Their launcher is `scripts/start_camera_stream.py`, with `scripts/robot-tank-camera.service` for the primary wide-angle feed and `scripts/robot-tank-camera-secondary.service` for the smaller auxiliary feed.

The primary camera unit defaults to `TANK_CAMERA_INDEX=1` so the cockpit's main viewport stays on the IMX708 wide-angle camera when both cameras are present. The secondary camera unit defaults to `TANK_CAMERA_INDEX=0` and serves the smaller auxiliary viewport.

The web UI renders the wide-angle feed in the main viewport and places the second camera in a smaller window directly below it.

The stream defaults to `1280x720` so IMX708-based Camera Module 3 hardware keeps its native 16:9 framing instead of being center-cropped into a 4:3 stream.

For IMX708 wide-angle hardware, the stream service also requests the full `4608x2592` sensor mode before scaling down to the stream size. If you need to experiment with performance or framing, override `TANK_CAMERA_SENSOR_WIDTH` and `TANK_CAMERA_SENSOR_HEIGHT`.

The included systemd service file is `scripts/robot-tank-rpi.service`. To install and enable it on the Pi:

```bash
sudo cp ~/repos/robot_tank_rpi/scripts/robot-tank-rpi.service /etc/systemd/system/robot-tank-rpi.service
sudo cp ~/repos/robot_tank_rpi/scripts/robot-tank-camera.service /etc/systemd/system/robot-tank-camera.service
sudo cp ~/repos/robot_tank_rpi/scripts/robot-tank-camera-secondary.service /etc/systemd/system/robot-tank-camera-secondary.service
sudo systemctl daemon-reload
sudo systemctl enable --now robot-tank-rpi.service
sudo systemctl enable --now robot-tank-camera.service
sudo systemctl enable --now robot-tank-camera-secondary.service
```

Useful service commands:

```bash
sudo systemctl status robot-tank-rpi.service
sudo systemctl status robot-tank-camera.service
sudo systemctl status robot-tank-camera-secondary.service
sudo journalctl -u robot-tank-rpi.service -n 100 --no-pager
sudo journalctl -u robot-tank-camera.service -n 100 --no-pager
sudo journalctl -u robot-tank-camera-secondary.service -n 100 --no-pager
sudo systemctl restart robot-tank-rpi.service
sudo systemctl restart robot-tank-camera.service
sudo systemctl restart robot-tank-camera-secondary.service
```

If the camera is connected but the stream panel still reports unavailable, check:

- `sudo journalctl -u robot-tank-camera.service -n 100 --no-pager`
- camera ribbon seating and power
- that Picamera2 can see a device with `/usr/bin/python3 -c "from picamera2 import Picamera2; print(Picamera2.global_camera_info())"`

## Raspberry Pi 5 camera note

This Pi currently runs dual cameras (IMX219 on index 0, IMX708 on index 1). `/boot/firmware/config.txt` is configured with `camera_auto_detect=0` and the explicit overlays `dtoverlay=imx708` and `dtoverlay=imx219,cam0`. The primary camera service points `TANK_CAMERA_INDEX=1` at the IMX708 wide-angle module, and the secondary service points `TANK_CAMERA_INDEX=0` at the IMX219.

On Raspberry Pi 5, the camera/display connectors are not selected with `disp1` for libcamera or Picamera2 camera capture. If you are moving the camera to the other MIPI connector:

- use the CSI connector, not a DSI display connector
- on Pi 5, the ribbon contacts should face the Ethernet jack on the Pi side
- keep `camera_auto_detect=1` unless you have a specific reason to force an overlay

If you ever need to force the IMX708 onto the non-default connector manually, use `/boot/firmware/config.txt` with auto-detect disabled and an explicit camera overlay:

```ini
camera_auto_detect=0
dtoverlay=imx708,cam0
```

If you leave off `,cam0`, Raspberry Pi's explicit overlay path defaults to camera connector 1. Reboot after any `config.txt` change.

Useful Pi-side checks before re-enabling the service:

```bash
rpicam-hello --list-cameras
/usr/bin/python3 -c "from picamera2 import Picamera2; print(Picamera2.global_camera_info())"
sudo systemctl restart robot-tank-camera.service
sudo journalctl -u robot-tank-camera.service -n 100 --no-pager
```

When the Pi opens the serial port, the Arduino Uno resets. The controller waits about 2 seconds before sending commands, then reads the startup banner if available. A good first health check from the UI is `Ping`, which should return `PONG` when the firmware is ready.

The web UI exposes:

- a speed slider plus `Set Speed`
- a move-duration input used for `Forward` and `Backward`
- keyboard controls: `W`/`S` drive, `A`/`D` pivot, `Space` stop, arrows move the camera, `[`/`]` adjust the speed setpoint
- pan and tilt sliders that send target-only `CAMERA <pan> <tilt>` commands with a light throttle while the R3 firmware smooths motion internally
- click-to-center aiming on the live camera image that computes one new camera target per click
- left and right motor sliders plus `Run Left Motor` and `Run Right Motor`
- `Center Camera`, `Ping`, `Slow Ramp Test`, and a compact firmware status panel showing build plus current/target pan and tilt
- installable PWA metadata so the control screen can be launched in standalone mode from a phone or tablet

## Manual area tracking

The cockpit includes a monitor-only manual ROI (region of interest) tracker. This lets you select any visual patch on the live camera feed and have the backend follow it across frames — even if the app does not know what the object is.

**How it works**

1. Click **Track area** in the Turret panel.
2. Drag a rectangle around anything on the wide camera view — a fingertip, a toy, a coloured marker.
3. On release, the app sends the normalised bounding box to `POST /api/tracking/start`.
4. The backend initialises an OpenCV tracker (CSRT preferred, falling back to KCF) on the current camera frame and starts a background loop that updates the box at roughly 5 FPS.
5. The cockpit overlays a yellow dashed box on the camera feed and labels it with the selection name.
6. Click **Stop tracking** to end the session.

**This is tracking, not object detection.** The tracker follows a specific visual patch by appearance, not by recognising what the object is. It works on any visual region you select.

**Limits**

- Occlusion: if the object is fully hidden behind another object, the tracker will lose it.
- Blur or lighting change: fast motion blur or sudden lighting shifts can cause the tracker to drift or lose the target.
- Object leaving frame: once the object exits the camera view, the tracker reports `status: "lost"`.
- Re-entry: the tracker does not re-acquire the object after losing it. Select the object again to restart.

When the tracker loses the target it reports `status: "lost"` and clears the box. The UI shows: **Tracking lost — select the object again.** No stale box is displayed.

**Safety**

- Default behaviour is monitor-only: tracking output is display-only.
- The backend never sends serial or drive commands from tracking unless
  the user explicitly enables **Follow with gimbal** (see below).
- Even with follow enabled, only the camera pan/tilt servos move. The
  drive wheels are never controlled by tracking.
- The tank does not move autonomously.
- People and dogs are not navigation targets.

**Follow with gimbal (opt-in)**

Once a tracking session is active, click **Follow with gimbal** in the
Turret panel to enable a closed-loop controller that pans/tilts the
camera servos to keep the tracked box centred. Click again to stop.

The controller:

- Computes the box centre's offset from the frame centre each tick.
- Inside a small deadzone it does nothing (prevents jitter).
- Outside the deadzone it issues `CAMERANOW <pan> <tilt>` commands,
  bounded to small per-tick steps so the gimbal never lurches.
- Only runs while `status` is `tracking`. When the tracker reports
  `lost` or you stop tracking, no further servo commands are sent.

If you find the gimbal moves the wrong way on either axis, send
`{"enabled": true, "pan_invert": true}` and/or `"tilt_invert": true`
to `POST /api/tracking/follow`.

**API**

- `GET /api/tracking/status` — current tracking state (now includes
  `follow_enabled`, `pan`, `tilt`)
- `POST /api/tracking/start` — `{"box": {"x": …, "y": …, "w": …, "h": …}, "label": "manual selection"}` with normalised 0–1 coords
- `POST /api/tracking/stop` — stop and reset
- `POST /api/tracking/reset` — alias for stop
- `POST /api/tracking/follow` — `{"enabled": true|false, "pan_invert"?: bool, "tilt_invert"?: bool}`

Status payload shape:

```json
{
  "enabled": true,
  "running": true,
  "status": "tracking",
  "label": "manual selection",
  "box": { "x": 0.25, "y": 0.30, "w": 0.15, "h": 0.20 },
  "confidence": null,
  "last_update_time": "2026-04-26T12:00:00Z",
  "fps": 5.0,
  "message": "Tracking manual selection"
}
```

`status` is one of: `idle`, `tracking`, `lost`, `error`, `opencv_missing`, `tracker_unavailable`, `no_frame`.

**OpenCV dependency**

Manual ROI tracking requires the **contrib** OpenCV package, which includes the CSRT/KCF tracker APIs. Plain `opencv-python` or `opencv-python-headless` does **not** include these.

Install the correct package:

```bash
pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python opencv-contrib-python-headless
pip install opencv-contrib-python-headless numpy
```

If `opencv-contrib-python-headless` is not installed:

- `POST /api/tracking/start` returns JSON `{"ok": false, "error": "…"}` with `status: "tracker_unavailable"` — never a 500.
- Everything else in the cockpit continues to work normally.

You can verify which tracker APIs are present by running `scripts/check_vision_runtime.sh` on the Pi.



```bash
source .venv/bin/activate
ruff check .
npm run build
npm run test:frontend
python3 -m pytest
```

## Project layout

- `server/` Flask app, configuration, serial service, and monitor-only vision service
- `ui/frontend/` React + Vite source for the PWA cockpit (`src/App.jsx`, `src/main.jsx`, `src/app.css`, `src/App.test.jsx`)
- `ui/static/` static assets and built bundle (`dist/` is produced by `npm run build`); also hosts the service worker `sw.js`
- `ui/templates/index.html` Flask template that loads the built React bundle and injects `cameraStreamPort`/`secondaryCameraStreamPort`
- `scripts/` launcher and systemd units: `start_controller.sh`, `start_camera_stream.py`, `robot-tank-rpi.service`, `robot-tank-camera.service`, `robot-tank-camera-secondary.service`
- `tests/` Python tests (Flask app, serial service, vision service)
- `serial/` notes for the Arduino serial protocol
- `camera/` notes for the camera streaming setup
- `docs/` project notes and setup references

## Firmware alignment note

This Pi app now targets the expanded firmware protocol with speed and camera controls. If you later expose turn helpers or single-motor steering in the UI, keep the Pi-side command strings aligned with the firmware's exact text commands.
