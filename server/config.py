from __future__ import annotations

import os
from dataclasses import dataclass


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


@dataclass(frozen=True)
class Config:
    server_host: str = os.getenv("TANK_SERVER_HOST", "0.0.0.0")
    server_port: int = _int_env("TANK_SERVER_PORT", 5000)
    serial_port: str = os.getenv("TANK_SERIAL_PORT", "/dev/ttyACM0")
    serial_baud: int = _int_env("TANK_SERIAL_BAUD", 115200)
    serial_write_timeout: float = _float_env("TANK_SERIAL_WRITE_TIMEOUT", 1.0)
    serial_ready_delay: float = _float_env("TANK_SERIAL_READY_DELAY", 2.0)
    default_drive_speed: int = _int_env("TANK_DEFAULT_DRIVE_SPEED", 50)
    default_drive_duration_ms: int = _int_env("TANK_DEFAULT_DRIVE_DURATION_MS", 400)