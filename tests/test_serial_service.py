from server.serial_service import SerialService
from server.serial_service import parse_status_response
from server.serial_service import parse_sensor_response


def test_status_reports_missing_dependency_when_pyserial_unavailable(monkeypatch):
    monkeypatch.setattr("server.serial_service.pyserial", None)

    service = SerialService(
        port="/dev/ttyUSB0",
        baud_rate=115200,
        write_timeout=1.0,
        ready_delay=0.0,
    )

    status = service.status()

    assert status["connected"] is False
    assert status["error_code"] == "missing-dependency"
    assert status["error"] == "pyserial is not installed"


def test_status_reports_busy_serial_port():
    def busy_factory(*args, **kwargs):
        raise OSError("[Errno 16] Device or resource busy: '/dev/ttyUSB0'")

    service = SerialService(
        port="/dev/ttyUSB0",
        baud_rate=115200,
        write_timeout=1.0,
        ready_delay=0.0,
        serial_factory=busy_factory,
    )

    status = service.status()

    assert status["connected"] is False
    assert status["error_code"] == "serial-port-busy"
    assert status["error"] == "Serial port /dev/ttyUSB0 is already in use by another process."


def test_send_command_returns_structured_runtime_error():
    class BrokenConnection:
        in_waiting = 0

        def write(self, payload):
            raise OSError("write timeout")

        def flush(self):
            return None

        def readline(self):
            return b""

        def reset_input_buffer(self):
            return None

    service = SerialService(
        port="/dev/ttyUSB0",
        baud_rate=115200,
        write_timeout=1.0,
        ready_delay=0.0,
        serial_factory=lambda *args, **kwargs: BrokenConnection(),
    )

    result = service.send_command("PING")

    assert result.ok is False
    assert result.error_code == "serial-write-timeout"
    assert result.message == "Timed out writing to serial port /dev/ttyUSB0."


def test_parse_sensor_response_extracts_front_and_bottom_values():
    sensors = parse_sensor_response("SENSORS LINE 812 790 805 SONAR 24")

    assert sensors == {
        "line_left": 812,
        "line_middle": 790,
        "line_right": 805,
        "sonar_cm": 24,
    }


def test_parse_status_response_extracts_camera_targets_and_build():
    status = parse_status_response(
        "STATUS SPEED 50 PAN 84 TARGET_PAN 120 TILT 90 TARGET_TILT 100 SONAR_US 2187 BUILD Apr_18_2026_07:55:42"
    )

    assert status == {
        "speed": 50,
        "pan": 84,
        "target_pan": 120,
        "tilt": 90,
        "target_tilt": 100,
        "sonar_us": 2187,
        "firmware_build": "Apr_18_2026_07:55:42",
    }


def test_parse_status_response_tolerates_missing_fields():
    status = parse_status_response("STATUS PAN 91 BUILD Apr_18_2026_07:55:42")

    assert status == {
        "pan": 91,
        "firmware_build": "Apr_18_2026_07:55:42",
    }


def test_parse_status_response_rejects_non_status_payload():
    try:
        parse_status_response("PONG")
    except ValueError as exc:
        assert str(exc) == "Unexpected status payload format"
    else:  # pragma: no cover - defensive
        raise AssertionError("Expected ValueError for non-STATUS payload")


def test_read_sensors_skips_async_lines_until_sensor_snapshot_arrives():
    class SensorConnection:
        def __init__(self):
            self.lines = [b"ConquerorTank ready\n"]
            self.writes = []

        @property
        def in_waiting(self):
            return len(self.lines)

        def write(self, payload):
            self.writes.append(payload)
            self.lines.extend(
                [
                    b"OK STOP\n",
                    b"SENSORS LINE 812 790 805 SONAR 24\n",
                ]
            )

        def flush(self):
            return None

        def readline(self):
            if not self.lines:
                return b""
            return self.lines.pop(0)

        def reset_input_buffer(self):
            return None

    service = SerialService(
        port="/dev/ttyUSB0",
        baud_rate=115200,
        write_timeout=1.0,
        ready_delay=0.0,
        serial_factory=lambda *args, **kwargs: SensorConnection(),
    )

    result = service.read_sensors()

    assert result.ok is True
    assert result.sensors == {
        "line_left": 812,
        "line_middle": 790,
        "line_right": 805,
        "sonar_cm": 24,
    }


def test_read_firmware_status_reads_status_snapshot():
    class StatusConnection:
        def __init__(self):
            self.lines = [b"ConquerorTank ready\n"]

        @property
        def in_waiting(self):
            return len(self.lines)

        def write(self, payload):
            if payload == b"STATUS\n":
                self.lines.extend(
                    [
                        b"OK STOP\n",
                        b"STATUS SPEED 50 PAN 84 TARGET_PAN 120 TILT 90 TARGET_TILT 100 BUILD Apr_18_2026_07:55:42\n",
                    ]
                )

        def flush(self):
            return None

        def readline(self):
            if not self.lines:
                return b""
            return self.lines.pop(0)

        def reset_input_buffer(self):
            return None

    service = SerialService(
        port="/dev/ttyUSB0",
        baud_rate=115200,
        write_timeout=1.0,
        ready_delay=0.0,
        serial_factory=lambda *args, **kwargs: StatusConnection(),
    )

    result = service.read_firmware_status()

    assert result.ok is True
    assert result.status == {
        "speed": 50,
        "pan": 84,
        "target_pan": 120,
        "tilt": 90,
        "target_tilt": 100,
        "firmware_build": "Apr_18_2026_07:55:42",
    }


def test_read_firmware_status_reports_unexpected_response():
    class UnexpectedStatusConnection:
        def __init__(self):
            self.lines = [b"ConquerorTank ready\n"]

        @property
        def in_waiting(self):
            return len(self.lines)

        def write(self, payload):
            if payload == b"STATUS\n":
                self.lines.extend([b"PONG\n"])

        def flush(self):
            return None

        def readline(self):
            if not self.lines:
                return b""
            return self.lines.pop(0)

        def reset_input_buffer(self):
            return None

    service = SerialService(
        port="/dev/ttyUSB0",
        baud_rate=115200,
        write_timeout=1.0,
        ready_delay=0.0,
        serial_factory=lambda *args, **kwargs: UnexpectedStatusConnection(),
    )

    result = service.read_firmware_status()

    assert result.ok is False
    assert result.error_code == "firmware-status-unexpected"
    assert result.response == "PONG"