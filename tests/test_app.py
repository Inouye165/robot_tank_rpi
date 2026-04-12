from server.app import create_app


class StubSerialService:
    def __init__(self) -> None:
        self.commands = []

    def status(self):
        return {
            "connected": False,
            "port": "/dev/null",
            "baud_rate": 115200,
            "error": "device missing",
            "ready": False,
        }

    def send_command(self, command: str):
        self.commands.append(command)
        return type("Result", (), {"ok": True, "message": f"sent {command}", "response": f"sent {command}"})()


def test_status_endpoint_returns_serial_state():
    app = create_app(serial_service=StubSerialService())
    client = app.test_client()

    response = client.get("/api/status")

    assert response.status_code == 200
    assert response.get_json()["connected"] is False


def test_command_endpoint_forwards_valid_command():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "forward", "speed": 80, "duration_ms": 900})

    assert response.status_code == 200
    assert service.commands == ["FORWARD 80 900"]


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


def test_command_endpoint_surfaces_firmware_error_as_failure():
    class ErrorSerialService(StubSerialService):
        def send_command(self, command: str):
            self.commands.append(command)
            return type("Result", (), {"ok": False, "message": "ERR UNKNOWN COMMAND: SPEED", "response": "ERR UNKNOWN COMMAND: SPEED"})()

    service = ErrorSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "set_speed", "speed": 20})

    assert response.status_code == 503
    assert response.get_json()["message"] == "ERR UNKNOWN COMMAND: SPEED"


def test_command_endpoint_rejects_unknown_command():
    service = StubSerialService()
    app = create_app(serial_service=service)
    client = app.test_client()

    response = client.post("/api/command", json={"command": "x"})

    assert response.status_code == 400
    assert service.commands == []