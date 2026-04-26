from __future__ import annotations

from pathlib import Path
import socket
from typing import Any, Optional

from flask import Flask, jsonify, render_template, request, send_from_directory

from .config import Config
from .serial_service import SerialService
from .tracking_service import TrackingService
from .vision_service import VisionService

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
    "camera_now": {
        "label": "Jump Camera",
        "type": "camera_now",
    },
    "pan": {
        "label": "Set Pan",
        "type": "servo",
        "verb": "PAN",
        "field": "pan",
    },
    "tilt": {
        "label": "Set Tilt",
        "type": "servo",
        "verb": "TILT",
        "field": "tilt",
    },
    "center_camera": {
        "label": "Center Camera",
        "type": "fixed",
        "command": "CENTERCAM",
    },
    "left_motor": {
        "label": "Left Motor",
        "type": "motor",
        "side": "LEFT",
    },
    "right_motor": {
        "label": "Right Motor",
        "type": "motor",
        "side": "RIGHT",
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

    if command["type"] == "camera_now":
        pan = _require_range(_coerce_int(payload.get("pan"), 90), 0, 180, "pan")
        tilt = _require_range(_coerce_int(payload.get("tilt"), 90), 0, 180, "tilt")
        return f"CAMERANOW {pan} {tilt}"

    if command["type"] == "servo":
        angle = _require_range(_coerce_int(payload.get(command["field"]), 90), 0, 180, command["field"])
        return f"{command['verb']} {angle}"

    if command["type"] == "motor":
        speed = _require_range(
            _coerce_int(payload.get("speed"), 0),
            -255,
            255,
            "speed",
        )
        duration_ms = _require_range(
            _coerce_int(payload.get("duration_ms"), config.default_drive_duration_ms),
            0,
            60000,
            "duration_ms",
        )
        return f"MOTOR {command['side']} {speed} {duration_ms}"

    return None


def create_app(
    serial_service: Optional[SerialService] = None,
    vision_service: Optional[VisionService] = None,
    tracking_service: Optional[TrackingService] = None,
) -> Flask:
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
    app.config["VISION_SERVICE"] = vision_service or VisionService(config)
    vision_svc = app.config["VISION_SERVICE"]
    app.config["TRACKING_SERVICE"] = tracking_service or TrackingService(
        frame_reader=vision_svc.frame_reader,
        serial_service=app.config["SERIAL_SERVICE"],
    )
    app.config["STARTUP_ISSUES"] = []

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            commands=COMMANDS,
            camera_stream_port=config.camera_stream_port,
            secondary_camera_stream_port=config.secondary_camera_stream_port,
        )

    @app.get("/sw.js")
    def service_worker():
        return send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")

    @app.get("/api/status")
    def status():
        service = app.config["SERIAL_SERVICE"]
        payload = service.status()
        payload["startup_issues"] = app.config["STARTUP_ISSUES"]
        payload["camera_status_url"] = f"http://{config.server_host if config.server_host != '0.0.0.0' else '127.0.0.1'}:{config.camera_stream_port}/status"
        payload["secondary_camera_status_url"] = f"http://{config.server_host if config.server_host != '0.0.0.0' else '127.0.0.1'}:{config.secondary_camera_stream_port}/status"
        return jsonify(payload)

    @app.get("/api/sensors")
    def sensors():
        service = app.config["SERIAL_SERVICE"]
        result = service.read_sensors()
        status_code = 200 if result.ok else 503
        payload = {
            "ok": result.ok,
            "message": result.message,
            "error_code": result.error_code,
            "response": result.response,
        }
        if result.sensors is not None:
            payload.update(result.sensors)
        return jsonify(payload), status_code

    @app.get("/api/firmware/status")
    def firmware_status():
        service = app.config["SERIAL_SERVICE"]
        result = service.read_firmware_status()
        status_code = 200 if result.ok else 503
        payload = {
            "ok": result.ok,
            "message": result.message,
            "error_code": result.error_code,
            "response": result.response,
        }
        if result.status is not None:
            payload.update(result.status)
        return jsonify(payload), status_code

    @app.get("/api/vision/status")
    def vision_status():
        service = app.config["VISION_SERVICE"]
        return jsonify(service.get_status())

    @app.get("/api/vision/detections")
    def vision_detections():
        service = app.config["VISION_SERVICE"]
        return jsonify(service.get_detections())

    @app.get("/api/tracking/status")
    def tracking_status():
        service = app.config["TRACKING_SERVICE"]
        return jsonify(service.get_status())

    @app.post("/api/tracking/start")
    def tracking_start():
        payload = request.get_json(silent=True) or {}
        box = payload.get("box")
        label = str(payload.get("label", "manual selection"))
        if box is None:
            return jsonify({"ok": False, "error": "Missing 'box' field"}), 400
        service = app.config["TRACKING_SERVICE"]
        result = service.start_tracking(box, label)
        status_code = 200 if result.get("ok") else 400
        return jsonify(result), status_code

    @app.post("/api/tracking/stop")
    def tracking_stop():
        service = app.config["TRACKING_SERVICE"]
        result = service.stop_tracking()
        return jsonify(result)

    @app.post("/api/tracking/reset")
    def tracking_reset():
        service = app.config["TRACKING_SERVICE"]
        result = service.reset()
        return jsonify(result)

    @app.post("/api/tracking/follow")
    def tracking_follow():
        payload = request.get_json(silent=True) or {}
        if "enabled" not in payload:
            return jsonify({"ok": False, "error": "Missing 'enabled' field"}), 400
        enabled = bool(payload.get("enabled"))
        kwargs: dict[str, Any] = {}
        if "pan_invert" in payload:
            kwargs["pan_invert"] = bool(payload["pan_invert"])
        if "tilt_invert" in payload:
            kwargs["tilt_invert"] = bool(payload["tilt_invert"])
        service = app.config["TRACKING_SERVICE"]
        result = service.set_follow(enabled, **kwargs)
        return jsonify(result)

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
                "error_code": result.error_code,
                "serial_command": serial_command,
            }
        ), status_code

    return app


def detect_startup_issues(config: Config) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []

    port_issue = detect_port_conflict(config.server_host, config.server_port)
    if port_issue is not None:
        issues.append(port_issue)

    return issues


def detect_port_conflict(host: str, port: int) -> Optional[dict[str, str]]:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return {
                "code": "server-port-in-use",
                "message": f"Port {port} is already in use. Stop the other service or set TANK_SERVER_PORT to a free port.",
            }
    return None


if __name__ == "__main__":
    app = create_app()
    config = app.config["TANK_CONFIG"]
    startup_issues = detect_startup_issues(config)
    app.config["STARTUP_ISSUES"] = startup_issues
    if startup_issues:
        for issue in startup_issues:
            print(f"startup-error [{issue['code']}]: {issue['message']}")
        raise SystemExit(1)
    app.run(host=config.server_host, port=config.server_port)