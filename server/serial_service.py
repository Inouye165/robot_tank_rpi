from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

try:
    import serial as pyserial
    from serial import SerialException
except ImportError:  # pragma: no cover - handled via status response
    pyserial = None
    SerialException = Exception


@dataclass(frozen=True)
class CommandResult:
    ok: bool
    message: str
    response: Optional[str] = None
    error_code: Optional[str] = None


@dataclass(frozen=True)
class SensorResult:
    ok: bool
    message: str
    sensors: Optional[dict[str, int]] = None
    response: Optional[str] = None
    error_code: Optional[str] = None


@dataclass(frozen=True)
class FirmwareStatusResult:
    ok: bool
    message: str
    status: Optional[dict[str, object]] = None
    response: Optional[str] = None
    error_code: Optional[str] = None


STATUS_FIELD_MAP = {
    "BUILD": "firmware_build",
    "FIRMWARE": "firmware_name",
    "PAN": "pan",
    "TARGET_PAN": "target_pan",
    "CURRENT_PAN": "pan",
    "TILT": "tilt",
    "TARGET_TILT": "target_tilt",
    "CURRENT_TILT": "tilt",
    "SPEED": "speed",
    "SONAR_US": "sonar_us",
}

STATUS_INT_FIELDS = {"pan", "target_pan", "tilt", "target_tilt", "speed", "sonar_us"}


def parse_sensor_response(response: str) -> dict[str, int]:
    parts = response.strip().split()
    if len(parts) != 7:
        raise ValueError("Unexpected sensor payload length")

    if parts[0].upper() != "SENSORS" or parts[1].upper() != "LINE" or parts[5].upper() != "SONAR":
        raise ValueError("Unexpected sensor payload format")

    return {
        "line_left": int(parts[2]),
        "line_middle": int(parts[3]),
        "line_right": int(parts[4]),
        "sonar_cm": int(parts[6]),
    }


def parse_status_response(response: str) -> dict[str, object]:
    parts = response.strip().split()
    if not parts or parts[0].upper() != "STATUS":
        raise ValueError("Unexpected status payload format")

    parsed: dict[str, object] = {}
    index = 1
    known_keys = set(STATUS_FIELD_MAP)

    while index < len(parts):
        key = parts[index].upper()
        index += 1

        if index >= len(parts):
            break

        target_field = STATUS_FIELD_MAP.get(key)
        if target_field == "firmware_build":
            value_tokens: list[str] = []
            while index < len(parts) and parts[index].upper() not in known_keys:
                value_tokens.append(parts[index])
                index += 1
            if not value_tokens:
                value_tokens.append(parts[index])
                index += 1
            parsed[target_field] = " ".join(value_tokens)
            continue

        value = parts[index]
        index += 1

        if target_field is None:
            continue

        if target_field in STATUS_INT_FIELDS:
            try:
                parsed[target_field] = int(value)
            except ValueError:
                continue
        else:
            parsed[target_field] = value

    return parsed


class SerialService:
    def __init__(
        self,
        port: str,
        baud_rate: int,
        write_timeout: float,
        ready_delay: float,
        serial_factory: Optional[Callable[..., object]] = None,
    ) -> None:
        self.port = port
        self.baud_rate = baud_rate
        self.write_timeout = write_timeout
        self.ready_delay = ready_delay
        self._serial_factory = serial_factory
        self._connection = None
        self._last_error: Optional[str] = None
        self._last_error_code: Optional[str] = None
        self._last_response: Optional[str] = None
        self._startup_banner: Optional[str] = None
        self._lock = threading.Lock()

    def status(self) -> dict[str, object]:
        with self._lock:
            self._ensure_connection()
            connected = self._connection is not None
            if connected:
                self._drain_pending_lines(self._connection)
        return {
            "connected": connected,
            "port": self.port,
            "baud_rate": self.baud_rate,
            "error": self._last_error,
            "error_code": self._last_error_code,
            "last_response": self._last_response,
            "startup_banner": self._startup_banner,
            "ready": connected,
        }

    def send_command(self, command: str) -> CommandResult:
        with self._lock:
            connection = self._ensure_connection()
            if connection is None:
                message = self._last_error or f"Serial device unavailable at {self.port}"
                return CommandResult(False, message, error_code=self._last_error_code)

            try:
                self._drain_pending_lines(connection)
                connection.write(f"{command}\n".encode("utf-8"))
                connection.flush()
            except Exception as exc:  # pragma: no cover - hardware dependent
                self._set_error(self._classify_runtime_error(exc))
                self._connection = None
                return CommandResult(False, self._last_error, error_code=self._last_error_code)

            response = self._read_line(connection)
            self._last_response = response
            self._last_error = None

            if response:
                if response.upper().startswith("ERR"):
                    return CommandResult(False, response, response=response, error_code="firmware-error")
                return CommandResult(True, response, response=response)

            return CommandResult(True, f"Sent '{command}' to {self.port}")

    def read_sensors(self) -> SensorResult:
        with self._lock:
            connection = self._ensure_connection()
            if connection is None:
                message = self._last_error or f"Serial device unavailable at {self.port}"
                return SensorResult(False, message, error_code=self._last_error_code)

            try:
                self._drain_pending_lines(connection)
                connection.write(b"SENSORS\n")
                connection.flush()
            except Exception as exc:  # pragma: no cover - hardware dependent
                self._set_error(self._classify_runtime_error(exc))
                self._connection = None
                return SensorResult(False, self._last_error, error_code=self._last_error_code)

            last_response = None
            for _ in range(4):
                response = self._read_line(connection)
                if not response:
                    break

                last_response = response
                self._last_response = response
                self._last_error = None

                if response.upper().startswith("ERR"):
                    return SensorResult(False, response, response=response, error_code="firmware-error")

                if not response.upper().startswith("SENSORS "):
                    continue

                try:
                    sensors = parse_sensor_response(response)
                except ValueError:
                    return SensorResult(
                        False,
                        f"Unexpected sensor response from firmware: {response}",
                        response=response,
                        error_code="sensor-parse-failed",
                    )

                return SensorResult(True, "Sensor snapshot read successfully.", sensors=sensors, response=response)

            message = "No sensor response received from firmware."
            if last_response is not None:
                message = f"Unexpected response while reading sensors: {last_response}"

            return SensorResult(False, message, response=last_response, error_code="sensor-read-failed")

    def read_firmware_status(self) -> FirmwareStatusResult:
        with self._lock:
            connection = self._ensure_connection()
            if connection is None:
                message = self._last_error or f"Serial device unavailable at {self.port}"
                return FirmwareStatusResult(False, message, error_code=self._last_error_code)

            try:
                self._drain_pending_lines(connection)
                connection.write(b"STATUS\n")
                connection.flush()
            except Exception as exc:  # pragma: no cover - hardware dependent
                self._set_error(self._classify_runtime_error(exc))
                self._connection = None
                return FirmwareStatusResult(False, self._last_error, error_code=self._last_error_code)

            last_response = None
            for _ in range(4):
                response = self._read_line(connection)
                if not response:
                    break

                last_response = response
                self._last_response = response
                self._last_error = None

                if response.upper().startswith("ERR"):
                    return FirmwareStatusResult(False, response, response=response, error_code="firmware-error")

                if not response.upper().startswith("STATUS"):
                    continue

                try:
                    status = parse_status_response(response)
                except ValueError:
                    return FirmwareStatusResult(
                        False,
                        f"Unexpected firmware status response: {response}",
                        response=response,
                        error_code="firmware-status-parse-failed",
                    )

                return FirmwareStatusResult(
                    True,
                    "Firmware status read successfully.",
                    status=status,
                    response=response,
                )

            message = "No firmware status response received from firmware."
            error_code = "firmware-status-read-failed"
            if last_response is not None:
                message = f"Unexpected response while reading firmware status: {last_response}"
                error_code = "firmware-status-unexpected"

            return FirmwareStatusResult(False, message, response=last_response, error_code=error_code)

    def _ensure_connection(self):
        if self._connection is not None:
            return self._connection

        factory = self._serial_factory
        if factory is None:
            if pyserial is None:
                self._set_error(("missing-dependency", "pyserial is not installed"))
                return None
            factory = pyserial.Serial

        try:
            self._connection = factory(
                self.port,
                self.baud_rate,
                timeout=1,
                write_timeout=self.write_timeout,
            )
            self._clear_input_buffer(self._connection)
            time.sleep(self.ready_delay)
            self._startup_banner = self._read_line(self._connection)
            self._clear_error()
        except (OSError, SerialException, ValueError) as exc:
            self._set_error(self._classify_connection_error(exc))
            self._connection = None

        return self._connection

    def _clear_error(self) -> None:
        self._last_error = None
        self._last_error_code = None

    def _set_error(self, error: tuple[str, str]) -> None:
        self._last_error_code, self._last_error = error

    def _classify_connection_error(self, exc: Exception) -> tuple[str, str]:
        text = str(exc)
        lowered = text.lower()

        if "no such file" in lowered or "could not open port" in lowered or "file not found" in lowered:
            return ("serial-port-missing", f"Serial port {self.port} was not found. Check the USB cable and TANK_SERIAL_PORT.")
        if "permission" in lowered or "access is denied" in lowered:
            return ("serial-permission-denied", f"Permission denied opening {self.port}. Add the service user to the dialout group or fix device permissions.")
        if "busy" in lowered or "resource temporarily unavailable" in lowered:
            return ("serial-port-busy", f"Serial port {self.port} is already in use by another process.")

        return ("serial-open-failed", f"Failed to open serial port {self.port}: {text}")

    def _classify_runtime_error(self, exc: Exception) -> tuple[str, str]:
        text = str(exc)
        lowered = text.lower()

        if "write timeout" in lowered:
            return ("serial-write-timeout", f"Timed out writing to serial port {self.port}.")
        if "device disconnected" in lowered or "input/output error" in lowered:
            return ("serial-disconnected", f"Serial device on {self.port} disconnected while sending a command.")

        return ("serial-command-failed", f"Serial command failed on {self.port}: {text}")

    def _clear_input_buffer(self, connection) -> None:
        reset_input_buffer = getattr(connection, "reset_input_buffer", None)
        if callable(reset_input_buffer):
            reset_input_buffer()

    def _read_line(self, connection) -> Optional[str]:
        try:
            raw = connection.readline()
        except Exception as exc:  # pragma: no cover - hardware dependent
            self._last_error = str(exc)
            return None

        if not raw:
            return None

        try:
            return raw.decode("utf-8", errors="replace").strip()
        except AttributeError:
            return str(raw).strip()

    def _drain_pending_lines(self, connection) -> Optional[str]:
        last_line = None
        while getattr(connection, "in_waiting", 0):
            line = self._read_line(connection)
            if line:
                last_line = line

        if last_line is not None:
            self._last_response = last_line

        return last_line