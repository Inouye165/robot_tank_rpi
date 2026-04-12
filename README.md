# robot_tank_rpi

Pi-side local web controller for the robot tank. This project runs on the Raspberry Pi and sends line-based ASCII commands over USB serial to an Arduino Uno R3.

## V1 scope

- Local Flask server bound to `0.0.0.0`
- Browser UI with large motion controls for the commands the current Uno firmware actually supports
- Drive speed control and camera pan/tilt controls that map directly to the Uno serial protocol
- Reusable serial service with safe handling when the Arduino is not connected
- Serial-open warmup for Arduino auto-reset behavior
- No camera streaming, auth, database, or Docker in this phase

## Command mapping

- `FORWARD <speed> <duration_ms>` timed forward pulse from the web UI
- `BACKWARD <speed> <duration_ms>` timed reverse pulse from the web UI
- `SPEED <speed>` updates the Uno's default drive speed
- `CAMERA <pan> <tilt>` sets both camera servos from the web UI
- `CENTERCAM`
- `STATUS`
- `STOP`
- `PING`
- `RAMPTEST`

Example commands sent by the Pi app:

- `FORWARD 50 400`
- `BACKWARD 50 400`
- `SPEED 20`
- `CAMERA 120 75`
- `CENTERCAM`
- `STATUS`
- `STOP`
- `PING`
- `RAMPTEST`

Each command is sent as ASCII text terminated by a newline.

## Configuration

The app reads configuration from environment variables.

- `TANK_SERVER_HOST` default: `0.0.0.0`
- `TANK_SERVER_PORT` default: `5000`
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

## Run

```bash
source .venv/bin/activate
export TANK_SERIAL_PORT=/dev/ttyACM0
export TANK_SERIAL_BAUD=115200
export TANK_SERVER_PORT=5000
python3 -m server.app
```

The Flask server listens on `0.0.0.0`, so open it from another device on the same Wi-Fi with:

```text
http://<pi-ip>:5000/
```

Find the Pi IP with:

```bash
hostname -I
```

If the Uno is not on `/dev/ttyACM0`, check the available device nodes with `ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null` and set `TANK_SERIAL_PORT` accordingly. On this Pi, the live verification used `/dev/ttyUSB0`.

When the Pi opens the serial port, the Arduino Uno resets. The controller waits about 2 seconds before sending commands, then reads the startup banner if available. A good first health check from the UI is `Ping`, which should return `PONG` when the firmware is ready.

The web UI exposes:

- a speed slider plus `Set Speed`
- a move-duration input used for `Forward` and `Backward`
- pan and tilt sliders plus `Set Camera`
- `Center Camera`, `Read Status`, `Ping`, and `Slow Ramp Test`

## Run tests

```bash
source .venv/bin/activate
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
