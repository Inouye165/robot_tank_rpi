# Serial

The Raspberry Pi sends line-based ASCII commands over USB serial to the Arduino Uno R3 at `115200` baud.

Current command set:

- `PING`
- `SPEED <0-255>`
- `FORWARD <speed> <duration_ms>`
- `BACKWARD <speed> <duration_ms>`
- `STOP`
- `HELP`
- `STATUS`
- `MOTOR LEFT <signed_speed> <duration_ms>`
- `MOTOR RIGHT <signed_speed> <duration_ms>`
- `PAN <0-180>`
- `TILT <0-180>`
- `CAMERA <pan> <tilt>`
- `CENTERCAM`
- `RAMPTEST`

Protocol notes:

- Open the serial port and wait about 2 seconds for the Arduino auto-reset.
- The Uno should print `ConquerorTank ready` on startup.
- Commands are terminated with a newline.
- `PING` should return `PONG` as a quick health check.