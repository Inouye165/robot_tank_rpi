import socket

from server.app import build_serial_command
from server.app import create_app
from server.app import detect_port_conflict
from server.config import Config


class StubSerialService:
    def __init__(self) -> None:
        self.commands = []
        self.next_result = type(
            "Result",
            (),
            {"ok": True, "message": "sent", "response": "sent", "error_code": None},
        )()
        self.next_firmware_result = type(
            "FirmwareResult",
            (),
            {
                "ok": True,
                "message": "Firmware status read successfully.",
                "status": {
                    "firmware_build": "Apr_18_2026_07:55:42",
                    "firmware_build_display": "Apr 18 2026 07:55:42",
                    "firmware_build_date": "Apr 18 2026",
                    "firmware_build_time": "07:55:42",
                    "speed": 50,
                    "pan": 84,
                    "target_pan": 120,
                    "tilt": 90,
                    "target_tilt": 100,
                },
                "response": "STATUS SPEED 50 PAN 84 TARGET_PAN 120 TILT 90 TARGET_TILT 100 BUILD Apr_18_2026_07:55:42",
                "error_code": None,
            },
        )()

    def status(self):
        return {
            "connected": False,
            "port": "/dev/null",
            "baud_rate": 115200,
            "error": "device missing",
            "error_code": "serial-port-missing",
            "last_response": None,
            "startup_banner": None,
            "ready": False,
        }

    def send_command(self, command: str):
        self.commands.append(command)
        if self.next_result.ok:
            self.next_result.message = f"sent {command}"
            self.next_result.response = f"sent {command}"
        return self.next_result

    def read_sensors(self):
        return type(
            "SensorResult",
            (),
            {
                "ok": True,
                "message": "Sensor snapshot read successfully.",
                "sensors": {
                    "line_left": 812,
                    "line_middle": 790,
                    "line_right": 805,
                    "sonar_cm": 24,
                },
                "response": "SENSORS LINE 812 790 805 SONAR 24",
                "error_code": None,
            },
        )()

    def read_firmware_status(self):
        return self.next_firmware_result


def test_status_endpoint_returns_serial_state():
    app = create_app(serial_service=StubSerialService())
    client = app.test_client()

    response = client.get("/api/status")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["connected"] is False
    assert payload["error_code"] == "serial-port-missing"
    assert payload["startup_issues"] == []


def test_command_endpoint_forwards_valid_command():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "forward", "speed": 80, "duration_ms": 900})

    assert response.status_code == 200
    assert service.commands == ["FORWARD 80 900"]


def test_sensor_endpoint_returns_parsed_sensor_snapshot():
    app = create_app(serial_service=StubSerialService())
    client = app.test_client()

    response = client.get("/api/sensors")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["line_left"] == 812
    assert payload["line_middle"] == 790
    assert payload["line_right"] == 805
    assert payload["sonar_cm"] == 24


def test_firmware_status_endpoint_returns_parsed_status_snapshot():
    app = create_app(serial_service=StubSerialService())
    client = app.test_client()

    response = client.get("/api/firmware/status")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["firmware_build"] == "Apr_18_2026_07:55:42"
    assert payload["firmware_build_display"] == "Apr 18 2026 07:55:42"
    assert payload["firmware_build_date"] == "Apr 18 2026"
    assert payload["firmware_build_time"] == "07:55:42"
    assert payload["pan"] == 84
    assert payload["target_pan"] == 120
    assert payload["tilt"] == 90
    assert payload["target_tilt"] == 100


def test_firmware_status_endpoint_surfaces_unexpected_response():
    service = StubSerialService()
    service.next_firmware_result = type(
        "FirmwareResult",
        (),
        {
            "ok": False,
            "message": "Unexpected response while reading firmware status: PONG",
            "status": None,
            "response": "PONG",
            "error_code": "firmware-status-unexpected",
        },
    )()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.get("/api/firmware/status")
    payload = response.get_json()

    assert response.status_code == 503
    assert payload["ok"] is False
    assert payload["response"] == "PONG"
    assert payload["error_code"] == "firmware-status-unexpected"


def test_command_endpoint_sets_speed():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "set_speed", "speed": 35})

    assert response.status_code == 200
    assert service.commands == ["SPEED 35"]


def test_command_endpoint_sets_camera():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "camera", "pan": 120, "tilt": 75})

    assert response.status_code == 200
    assert service.commands == ["CAMERA 120 75"]


def test_command_endpoint_sets_pan():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "pan", "pan": 100})

    assert response.status_code == 200
    assert service.commands == ["PAN 100"]


def test_command_endpoint_sets_tilt():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "tilt", "tilt": 60})

    assert response.status_code == 200
    assert service.commands == ["TILT 60"]


def test_command_endpoint_runs_left_motor():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "left_motor", "speed": -40, "duration_ms": 500})

    assert response.status_code == 200
    assert service.commands == ["MOTOR LEFT -40 500"]


def test_command_endpoint_runs_right_motor():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "right_motor", "speed": 55, "duration_ms": 250})

    assert response.status_code == 200
    assert service.commands == ["MOTOR RIGHT 55 250"]


def test_command_endpoint_sends_ramp_test_verbatim():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "ramp_test"})

    assert response.status_code == 200
    assert service.commands == ["RAMPTEST"]


def test_command_endpoint_rejects_out_of_range_camera_value():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "camera", "pan": 200, "tilt": 90})

    assert response.status_code == 400
    assert service.commands == []


def test_command_endpoint_rejects_out_of_range_motor_value():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "left_motor", "speed": 300, "duration_ms": 500})

    assert response.status_code == 400
    assert service.commands == []


def test_command_endpoint_surfaces_firmware_error_as_failure():
    service = StubSerialService()
    service.next_result = type(
        "Result",
        (),
        {
            "ok": False,
            "message": "ERR UNKNOWN COMMAND: SPEED",
            "response": "ERR UNKNOWN COMMAND: SPEED",
            "error_code": "firmware-error",
        },
    )()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "set_speed", "speed": 20})

    assert response.status_code == 503
    assert response.get_json()["message"] == "ERR UNKNOWN COMMAND: SPEED"
    assert response.get_json()["error_code"] == "firmware-error"


def test_command_endpoint_rejects_unknown_command():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "x"})

    assert response.status_code == 400
    assert service.commands == []


def test_status_page_contains_pwa_cockpit_markup():
    app = create_app(serial_service=StubSerialService())
    client = app.test_client()

    response = client.get("/")
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'dist/manifest.webmanifest' in body
    assert 'id="root"' in body
    assert 'window.__TANK_APP_CONFIG__' in body
    assert 'secondaryCameraStreamPort' in body
    assert 'dist/app.js' in body


def test_status_endpoint_can_surface_startup_issues():
    app = create_app(serial_service=StubSerialService())
    app.config["STARTUP_ISSUES"] = [
        {
            "code": "server-port-in-use",
            "message": "Port 5000 is already in use. Stop the other service or set TANK_SERVER_PORT to a free port.",
        }
    ]
    client = app.test_client()

    response = client.get("/api/status")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["startup_issues"][0]["code"] == "server-port-in-use"


def test_service_worker_route_is_available():
    app = create_app(serial_service=StubSerialService())
    client = app.test_client()

    response = client.get("/sw.js")

    assert response.status_code == 200
    assert "CACHE_NAME" in response.get_data(as_text=True)


def test_config_prefers_env_serial_port(monkeypatch):
    monkeypatch.setenv("TANK_SERIAL_PORT", "/dev/ttyUSB9")

    config = Config()

    assert config.serial_port == "/dev/ttyUSB9"


def test_config_auto_detects_usb_serial_port(monkeypatch):
    monkeypatch.delenv("TANK_SERIAL_PORT", raising=False)

    def fake_glob(pattern):
        if pattern == "/dev/ttyACM*":
            return []
        if pattern == "/dev/ttyUSB*":
            return ["/dev/ttyUSB0"]
        return []

    monkeypatch.setattr("server.config.glob", fake_glob)

    config = Config()

    assert config.serial_port == "/dev/ttyUSB0"


def test_detect_port_conflict_reports_busy_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]

        issue = detect_port_conflict("127.0.0.1", port)

    assert issue == {
        "code": "server-port-in-use",
        "message": f"Port {port} is already in use. Stop the other service or set TANK_SERVER_PORT to a free port.",
    }


# ---------------------------------------------------------------------------
# Regression tests below cover code paths not exercised by the HTTP tests above.
# Each test maps to a real bug class identified during the codebase review.
# ---------------------------------------------------------------------------


def test_command_endpoint_forwards_backward_command_with_correct_verb():
    """BACKWARD must serialize with the BACKWARD verb (not FORWARD).

    Symmetric coverage with `test_command_endpoint_forwards_valid_command`; a
    refactor that accidentally reused the forward branch for reverse would
    silently brick the cockpit's reverse drive.
    """
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post(
        "/api/command",
        json={"command": "backward", "speed": 80, "duration_ms": 900},
    )

    assert response.status_code == 200
    assert service.commands == ["BACKWARD 80 900"]


def test_build_serial_command_handles_camera_now_branch():
    """`camera_now` (CAMERANOW) is wired into the command map but had no test.

    Click-to-calibrate uses this branch on the firmware side, and a regression
    that fell through to `None` would surface only as a 400 in the cockpit.
    """
    config = Config()

    serial_command = build_serial_command(
        "camera_now", {"pan": 130, "tilt": 70}, config
    )

    assert serial_command == "CAMERANOW 130 70"


def test_build_serial_command_returns_none_for_unknown_action():
    """The HTTP layer relies on `None` to translate to a 400 'Unknown command'."""
    config = Config()

    assert build_serial_command("not_a_real_command", {}, config) is None


def test_build_serial_command_drive_uses_config_defaults_when_payload_empty():
    """Empty/None payload values must fall back to Config defaults rather than crash.

    Guards `_coerce_int` returning the fallback for both ``None`` and ``""``
    so the keyboard "press W with no slider input" path keeps working.
    """
    config = Config()

    serial_command = build_serial_command(
        "forward", {"speed": None, "duration_ms": ""}, config
    )

    assert serial_command == (
        f"FORWARD {config.default_drive_speed} {config.default_drive_duration_ms}"
    )


def test_status_endpoint_exposes_camera_status_urls_with_loopback_substitution():
    """When bound to 0.0.0.0, the status payload must rewrite the host to 127.0.0.1.

    Returning a literal `0.0.0.0` URL would make the cockpit fetch fail in the
    browser. This test pins the substitution behavior in `server/app.py`.
    """
    app = create_app(serial_service=StubSerialService())
    config = app.config["TANK_CONFIG"]
    client = app.test_client()

    response = client.get("/api/status")
    payload = response.get_json()

    expected_host = "127.0.0.1" if config.server_host == "0.0.0.0" else config.server_host
    assert payload["camera_status_url"] == (
        f"http://{expected_host}:{config.camera_stream_port}/status"
    )
    assert payload["secondary_camera_status_url"] == (
        f"http://{expected_host}:{config.secondary_camera_stream_port}/status"
    )


def test_config_auto_detect_prefers_acm_over_usb(monkeypatch):
    """When both Uno-style ports exist, ACM must win.

    The Uno R3 enumerates as `/dev/ttyACM*` on most kernels; if the priority
    order in `_default_serial_port` is ever swapped, the controller would grab
    an unrelated USB serial adapter on the same Pi.
    """
    monkeypatch.delenv("TANK_SERIAL_PORT", raising=False)

    def fake_glob(pattern):
        if pattern == "/dev/ttyACM*":
            return ["/dev/ttyACM0", "/dev/ttyACM1"]
        if pattern == "/dev/ttyUSB*":
            return ["/dev/ttyUSB0"]
        return []

    monkeypatch.setattr("server.config.glob", fake_glob)

    config = Config()

    assert config.serial_port == "/dev/ttyACM0"
