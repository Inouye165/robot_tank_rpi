"""MJPEG frame reader for the monitor-only vision pipeline.

The frame reader owns ONE long-lived connection to an MJPEG stream and
caches the latest decoded frame. The vision worker then samples that cached
frame at `TANK_VISION_SAMPLE_FPS` instead of reopening the stream every
detection cycle (which is what the previous scaffold did).

This module is intentionally tolerant of missing optional dependencies:

* If OpenCV (`cv2`) is not installed, :class:`MjpegFrameReader` reports
  itself as not connected and never raises at import time. The vision
  status surface then says "stream unavailable" instead of crashing.
* :class:`FakeFrameReader` exists for tests so the rest of the pipeline can
  be exercised without any real I/O.

Safety: this is monitor-only. Frame readers must not send drive commands.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional, Protocol, runtime_checkable

LOGGER = logging.getLogger(__name__)


@runtime_checkable
class FrameReader(Protocol):
    """Minimal frame reader interface used by VisionService."""

    @property
    def connected(self) -> bool:
        ...

    def latest_frame(self) -> tuple[Optional[Any], Optional[float]]:
        """Return (frame, monotonic_timestamp). frame may be None."""

    def start(self) -> None:
        ...

    def stop(self) -> None:
        ...


class FakeFrameReader:
    """Deterministic frame reader for tests.

    Exposes the latest frame the test code injected via :meth:`push_frame`.
    """

    def __init__(self, frame: Any | None = None, *, connected: bool = True) -> None:
        self._frame = frame
        self._timestamp: Optional[float] = time.monotonic() if frame is not None else None
        self._connected = connected
        self.start_calls = 0
        self.stop_calls = 0

    @property
    def connected(self) -> bool:
        return self._connected

    def push_frame(self, frame: Any) -> None:
        self._frame = frame
        self._timestamp = time.monotonic()

    def set_connected(self, value: bool) -> None:
        self._connected = value

    def latest_frame(self) -> tuple[Optional[Any], Optional[float]]:
        return self._frame, self._timestamp

    def start(self) -> None:
        self.start_calls += 1

    def stop(self) -> None:
        self.stop_calls += 1


class MjpegFrameReader:
    """Background-thread MJPEG reader backed by ``cv2.VideoCapture``.

    Only loaded if OpenCV is available at runtime. If OpenCV is missing the
    reader stays in a "not connected" state and never raises, so the rest
    of the cockpit (Flask routes, serial commands, the React UI) keeps
    working.
    """

    def __init__(self, source_url: str, *, reconnect_delay: float = 1.0) -> None:
        self._source_url = source_url
        self._reconnect_delay = max(0.1, reconnect_delay)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._frame: Optional[Any] = None
        self._frame_time: Optional[float] = None
        self._connected = False
        self._cv2: Any = None  # populated in start() to avoid hard import dep

    @property
    def connected(self) -> bool:
        return self._connected

    def latest_frame(self) -> tuple[Optional[Any], Optional[float]]:
        with self._lock:
            return self._frame, self._frame_time

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        try:
            import cv2  # type: ignore
        except Exception as exc:  # pragma: no cover - exercised at runtime only
            LOGGER.warning("OpenCV not available, MJPEG frame reader disabled: %s", exc)
            self._connected = False
            return
        self._cv2 = cv2
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="tank-vision-reader", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self._thread = None
        self._connected = False

    def _loop(self) -> None:  # pragma: no cover - requires cv2 + live stream
        cv2 = self._cv2
        while not self._stop.is_set():
            cap = cv2.VideoCapture(self._source_url)
            if not cap.isOpened():
                self._connected = False
                cap.release()
                self._stop.wait(self._reconnect_delay)
                continue
            self._connected = True
            try:
                while not self._stop.is_set():
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        break
                    with self._lock:
                        self._frame = frame
                        self._frame_time = time.monotonic()
            finally:
                cap.release()
                self._connected = False
            self._stop.wait(self._reconnect_delay)
