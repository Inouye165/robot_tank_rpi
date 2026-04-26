"""Detector abstractions for the monitor-only vision scaffold.

This module defines the small adapter surface that `VisionService` uses to
fetch raw detections. Real backends (e.g. an OpenCV/ONNX YOLO adapter) will
implement :class:`Detector` in a follow-up change. For now we ship the
protocol plus a deterministic :class:`FakeDetector` that tests use to drive
the service without any model files, OpenCV, or network I/O.

Note: this phase is monitor-only. Detectors must not send any drive
commands; they only return candidate boxes for the cockpit overlay.
"""

from __future__ import annotations

from typing import Any, Iterable, Protocol, runtime_checkable


@runtime_checkable
class Detector(Protocol):
    """Minimal detector interface.

    The current `detect()` signature accepts a `source_url` for backwards
    compatibility with the existing worker loop. That shape is TEMPORARY:
    re-opening the MJPEG stream every call is wasteful. The future-ready
    layout will split a frame reader (owns the MJPEG connection) from a
    detector (owns the model and consumes raw frames). See
    `docs/FUTURE_IMPROVEMENTS.md`.
    """

    def detect(
        self,
        *,
        source_url: str,
        confidence: float,
        frame_width: int,
    ) -> Iterable[dict[str, Any]]:
        ...


class FakeDetector:
    """Deterministic detector for tests.

    Returns the candidates passed at construction time. Counts how many times
    `detect()` was called so tests can assert worker behaviour without any
    real I/O.
    """

    def __init__(self, candidates: Iterable[dict[str, Any]] | None = None) -> None:
        self._candidates: list[dict[str, Any]] = list(candidates or [])
        self.call_count = 0
        self.last_kwargs: dict[str, Any] | None = None

    def detect(
        self,
        *,
        source_url: str,
        confidence: float,
        frame_width: int,
    ) -> list[dict[str, Any]]:
        self.call_count += 1
        self.last_kwargs = {
            "source_url": source_url,
            "confidence": confidence,
            "frame_width": frame_width,
        }
        # Return a copy so callers cannot mutate the canned candidates.
        return [dict(item) for item in self._candidates]
