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


def build_serial_command(action: str, config: Config) -> Optional[str]:
    command = COMMANDS.get(action)
    if command is None:
        return None

    if command["type"] == "fixed":
        return command["command"]

    return f"{command['verb']} {config.default_drive_speed} {config.default_drive_duration_ms}"


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
        serial_command = build_serial_command(action, config)
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