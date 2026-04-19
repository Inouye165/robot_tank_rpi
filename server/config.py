from __future__ import annotations

from glob import glob
import os
from dataclasses import dataclass, field


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    return int(value)


def _float_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    return float(value)


def _default_serial_port() -> str:
    configured = os.getenv("TANK_SERIAL_PORT")
    if configured:
        return configured

    for pattern in ("/dev/ttyACM*", "/dev/ttyUSB*"):
        matches = sorted(glob(pattern))
        if matches:
            return matches[0]

    return "/dev/ttyACM0"


@dataclass(frozen=True)
class Config:
    server_host: str = field(default_factory=lambda: os.getenv("TANK_SERVER_HOST", "0.0.0.0"))
    server_port: int = field(default_factory=lambda: _int_env("TANK_SERVER_PORT", 5000))
    camera_stream_port: int = field(default_factory=lambda: _int_env("TANK_CAMERA_STREAM_PORT", 8081))
    serial_port: str = field(default_factory=_default_serial_port)
    serial_baud: int = field(default_factory=lambda: _int_env("TANK_SERIAL_BAUD", 115200))
    serial_write_timeout: float = field(default_factory=lambda: _float_env("TANK_SERIAL_WRITE_TIMEOUT", 1.0))
    serial_ready_delay: float = field(default_factory=lambda: _float_env("TANK_SERIAL_READY_DELAY", 2.0))
    default_drive_speed: int = field(default_factory=lambda: _int_env("TANK_DEFAULT_DRIVE_SPEED", 50))
    default_drive_duration_ms: int = field(default_factory=lambda: _int_env("TANK_DEFAULT_DRIVE_DURATION_MS", 400))