from __future__ import annotations

from glob import glob
import os
from dataclasses import dataclass, field


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _str_env(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value


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
    secondary_camera_stream_port: int = field(default_factory=lambda: _int_env("TANK_SECONDARY_CAMERA_STREAM_PORT", 8082))
    vision_enabled: bool = field(default_factory=lambda: _bool_env("TANK_VISION_ENABLED", False))
    vision_source_url: str = field(default_factory=lambda: _str_env("TANK_VISION_SOURCE_URL", ""))
    vision_model_path: str = field(default_factory=lambda: _str_env("TANK_VISION_MODEL_PATH", ""))
    vision_model_backend: str = field(default_factory=lambda: _str_env("TANK_VISION_MODEL_BACKEND", "disabled"))
    vision_sample_fps: float = field(default_factory=lambda: _float_env("TANK_VISION_SAMPLE_FPS", 2.0))
    vision_confidence: float = field(default_factory=lambda: _float_env("TANK_VISION_CONFIDENCE", 0.45))
    vision_frame_width: int = field(default_factory=lambda: _int_env("TANK_VISION_FRAME_WIDTH", 640))
    vision_target_labels: str = field(
        default_factory=lambda: _str_env(
            "TANK_VISION_TARGET_LABELS",
            # Monitor-only safety: people and dogs are detected and counted, but
            # are intentionally NOT target candidates by default. Only safe
            # marker objects are eligible until an operator opts in explicitly.
            "tennis ball,traffic cone,marker",
        )
    )
    vision_hazard_labels: str = field(
        default_factory=lambda: _str_env(
            "TANK_VISION_HAZARD_LABELS",
            "chair,backpack,suitcase,bottle,box,cup,sports ball,potted plant,traffic cone,unknown obstacle",
        )
    )
    serial_port: str = field(default_factory=_default_serial_port)
    serial_baud: int = field(default_factory=lambda: _int_env("TANK_SERIAL_BAUD", 115200))
    serial_write_timeout: float = field(default_factory=lambda: _float_env("TANK_SERIAL_WRITE_TIMEOUT", 1.0))
    serial_ready_delay: float = field(default_factory=lambda: _float_env("TANK_SERIAL_READY_DELAY", 2.0))
    default_drive_speed: int = field(default_factory=lambda: _int_env("TANK_DEFAULT_DRIVE_SPEED", 50))
    default_drive_duration_ms: int = field(default_factory=lambda: _int_env("TANK_DEFAULT_DRIVE_DURATION_MS", 400))