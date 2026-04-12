from __future__ import annotations

from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, render_template, request

from .config import Config
from .serial_service import SerialService

COMMANDS = {
    "forward": {
        "label": "Forward",
        "type": "drive",
        "verb": "FORWARD",
    },
    "backward": {
        "label": "Backward",
        "type": "drive",
        "verb": "BACKWARD",
    },
    "stop": {
        "label": "Stop",
        "type": "fixed",
        "command": "STOP",
    },
    "set_speed": {
        "label": "Set Speed",
        "type": "speed",
    },
    "camera": {
        "label": "Set Camera",
        "type": "camera",
    },
    "center_camera": {
        "label": "Center Camera",
        "type": "fixed",
        "command": "CENTERCAM",
    },
    "firmware_status": {
        "label": "Read Status",
        "type": "fixed",
        "command": "STATUS",
    },
    "ping": {
        "label": "Ping",
        "type": "fixed",
        "command": "PING",
    },
    "ramp_test": {
        "label": "Slow Ramp Test",
        "type": "fixed",
        "command": "RAMPTEST",
    },
}


def _coerce_int(value, fallback: int) -> int:
    if value in (None, ""):
        return fallback
    return int(value)


def _require_range(value: int, minimum: int, maximum: int, label: str) -> int:
    if value < minimum or value > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return value


def build_serial_command(action: str, payload: dict[str, object], config: Config) -> Optional[str]:
    command = COMMANDS.get(action)
    if command is None:
        return None

    if command["type"] == "fixed":
        return command["command"]

    if command["type"] == "drive":
        speed = _require_range(
            _coerce_int(payload.get("speed"), config.default_drive_speed),
            0,
            255,
            "speed",
        )
        duration_ms = _require_range(
            _coerce_int(payload.get("duration_ms"), config.default_drive_duration_ms),
            0,
            60000,
            "duration_ms",
        )
        return f"{command['verb']} {speed} {duration_ms}"

    if command["type"] == "speed":
        speed = _require_range(
            _coerce_int(payload.get("speed"), config.default_drive_speed),
            0,
            255,
            "speed",
        )
        return f"SPEED {speed}"

    if command["type"] == "camera":
        pan = _require_range(_coerce_int(payload.get("pan"), 90), 0, 180, "pan")
        tilt = _require_range(_coerce_int(payload.get("tilt"), 90), 0, 180, "tilt")
        return f"CAMERA {pan} {tilt}"

    return None


def create_app(serial_service: Optional[SerialService] = None) -> Flask:
    repo_root = Path(__file__).resolve().parent.parent
    config = Config()
    app = Flask(
        __name__,
        template_folder=str(repo_root / "ui" / "templates"),
        static_folder=str(repo_root / "ui" / "static"),
    )
    app.config["TANK_CONFIG"] = config
    app.config["SERIAL_SERVICE"] = serial_service or SerialService(
        port=config.serial_port,
        baud_rate=config.serial_baud,
        write_timeout=config.serial_write_timeout,
        ready_delay=config.serial_ready_delay,
    )

    @app.get("/")
    def index():
        return render_template("index.html", commands=COMMANDS)

    @app.get("/api/status")
    def status():
        service = app.config["SERIAL_SERVICE"]
        return jsonify(service.status())

    @app.post("/api/command")
    def send_command():
        payload = request.get_json(silent=True) or {}
        action = payload.get("command")
        try:
            serial_command = build_serial_command(action, payload, config)
        except (TypeError, ValueError) as exc:
            return jsonify({"ok": False, "message": str(exc)}), 400

        if serial_command is None:
            return jsonify({"ok": False, "message": "Unknown command"}), 400

        service = app.config["SERIAL_SERVICE"]
        result = service.send_command(serial_command)
        status_code = 200 if result.ok else 503
        return jsonify(
            {
                "ok": result.ok,
                "message": result.message,
                "command": action,
                "serial_command": serial_command,
            }
        ), status_code

    return app


if __name__ == "__main__":
    app = create_app()
    config = app.config["TANK_CONFIG"]
    app.run(host=config.server_host, port=config.server_port)