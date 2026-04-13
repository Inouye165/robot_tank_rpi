from server.serial_service import SerialService


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