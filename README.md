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
- `TANK_CAMERA_STREAM_PORT` default: `8081`
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

The live camera stream is served separately on `http://<pi-ip>:8081/stream.mjpg` and is embedded into the main page automatically.

Find the Pi IP with:

```bash
hostname -I
```

If the Uno is not on `/dev/ttyACM0`, check the available device nodes with `ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null` and set `TANK_SERIAL_PORT` accordingly. On this Pi, the live verification used `/dev/ttyUSB0`.

## Auto-start on boot

This repo includes a small launcher script at `scripts/start_controller.sh` that auto-detects the first available Uno serial device from `/dev/ttyUSB*` or `/dev/ttyACM*` and then starts the Flask controller.

The camera stream service uses system Python so it can access `picamera2` even though the main app runs inside the project virtualenv. Its launcher is `scripts/start_camera_stream.py` and its systemd unit is `scripts/robot-tank-camera.service`.

The included systemd service file is `scripts/robot-tank-rpi.service`. To install and enable it on the Pi:

```bash
sudo cp ~/repos/robot_tank_rpi/scripts/robot-tank-rpi.service /etc/systemd/system/robot-tank-rpi.service
sudo cp ~/repos/robot_tank_rpi/scripts/robot-tank-camera.service /etc/systemd/system/robot-tank-camera.service
sudo systemctl daemon-reload
sudo systemctl enable --now robot-tank-rpi.service
sudo systemctl enable --now robot-tank-camera.service
```

Useful service commands:

```bash
sudo systemctl status robot-tank-rpi.service
sudo systemctl status robot-tank-camera.service
sudo journalctl -u robot-tank-rpi.service -n 100 --no-pager
sudo journalctl -u robot-tank-camera.service -n 100 --no-pager
sudo systemctl restart robot-tank-rpi.service
sudo systemctl restart robot-tank-camera.service
```

If the camera is connected but the stream panel still reports unavailable, check:

- `sudo journalctl -u robot-tank-camera.service -n 100 --no-pager`
- camera ribbon seating and power
- that Picamera2 can see a device with `/usr/bin/python3 -c "from picamera2 import Picamera2; print(Picamera2.global_camera_info())"`

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

## Run tests

```bash
source .venv/bin/activate
ruff check .
npm run build
python3 -m pytest
```

## Project layout

- `server/` Flask app, config, and serial service integration
- `ui/` plain HTML, CSS, and JavaScript for the local controller
- `serial/` notes for the Arduino serial protocol
- `camera/` reserved for a future streaming phase
- `docs/` project notes and setup references

## Firmware alignment note

This Pi app now targets the expanded firmware protocol with speed and camera controls. If you later expose turn helpers or single-motor steering in the UI, keep the Pi-side command strings aligned with the firmware's exact text commands.
