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
            "last_response": self._last_response,
            "startup_banner": self._startup_banner,
            "ready": connected,
        }

    def send_command(self, command: str) -> CommandResult:
        with self._lock:
            connection = self._ensure_connection()
            if connection is None:
                message = self._last_error or f"Serial device unavailable at {self.port}"
                return CommandResult(False, message)

            try:
                self._drain_pending_lines(connection)
                connection.write(f"{command}\n".encode("utf-8"))
                connection.flush()
            except Exception as exc:  # pragma: no cover - hardware dependent
                self._last_error = str(exc)
                self._connection = None
                return CommandResult(False, self._last_error)

            response = self._read_line(connection)
            self._last_response = response
            self._last_error = None

            if response:
                return CommandResult(True, response, response=response)

            return CommandResult(True, f"Sent '{command}' to {self.port}")

    def _ensure_connection(self):
        if self._connection is not None:
            return self._connection

        factory = self._serial_factory
        if factory is None:
            if pyserial is None:
                self._last_error = "pyserial is not installed"
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
        except (OSError, SerialException, ValueError) as exc:
            self._last_error = str(exc)
            self._connection = None

        return self._connection

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