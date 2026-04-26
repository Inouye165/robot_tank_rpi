"""Monitor-only manual ROI tracking service.

The user selects a region of interest (ROI) on the live camera feed; this
service uses an OpenCV tracker to follow that visual patch across frames.
Tracking is entirely monitor-only: no serial commands are ever sent, and
the tank does not move autonomously.

Designed to share the existing FrameReader instance that VisionService uses
so both consumers read from the same cached frame without reopening the stream.

OpenCV is optional.  If cv2 is not installed the service reports
``status="opencv_missing"`` cleanly instead of crashing.

Safety:
  - This service MUST NOT send any serial or drive commands.
  - Tracking output is display-only.
  - People/dogs/persons must never become navigation targets.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

LOGGER = logging.getLogger(__name__)

STATUS_IDLE = "idle"
STATUS_TRACKING = "tracking"
STATUS_LOST = "lost"
STATUS_ERROR = "error"
STATUS_OPENCV_MISSING = "opencv_missing"
STATUS_NO_FRAME = "no_frame"

_SAMPLE_FPS = 5.0


def _clamp_norm(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _validate_box(box: Any) -> Optional[str]:
    """Return an error string if box is invalid, otherwise None."""
    if not isinstance(box, dict):
        return "box must be a JSON object"
    for key in ("x", "y", "w", "h"):
        if key not in box:
            return f"Missing field: {key}"
        try:
            v = float(box[key])
        except (TypeError, ValueError):
            return f"Field '{key}' is not a number"
        if not (0.0 <= v <= 1.0):
            return f"Field '{key}' out of range [0.0, 1.0]: {v}"
    if float(box["w"]) <= 0 or float(box["h"]) <= 0:
        return "Box width and height must each be > 0"
    return None


def _make_cv2_tracker(cv2: Any) -> Any:
    """Return the best available OpenCV tracker object.

    Preference order: CSRT (most accurate) → KCF → MOSSE.
    Raises RuntimeError if no suitable tracker API is found.
    """
    for factory_name in ("TrackerCSRT_create", "TrackerKCF_create", "TrackerMOSSE_create"):
        factory = getattr(cv2, factory_name, None)
        if factory is not None:
            try:
                return factory()
            except Exception:  # pragma: no cover - cv2 API variations
                continue
    # Older cv2 legacy unified API
    if hasattr(cv2, "Tracker"):
        for name in ("CSRT", "KCF", "MOSSE"):
            try:
                return cv2.Tracker.create(name)  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover
                continue
    raise RuntimeError("No suitable OpenCV tracker found in the installed cv2 version.")


class FakeTracker:
    """Deterministic tracker for tests.

    Drifts the box slightly on each update so tests can verify that
    the tracking loop updates the normalised box.
    """

    def __init__(self, *, should_lose: bool = False) -> None:
        self._box: Optional[tuple[int, int, int, int]] = None
        self._should_lose = should_lose
        self.init_calls = 0
        self.update_calls = 0

    def init(self, frame: Any, box: tuple[int, int, int, int]) -> None:
        self._box = box
        self.init_calls += 1

    def update(self, frame: Any) -> tuple[bool, tuple[int, int, int, int]]:
        self.update_calls += 1
        if self._box is None or self._should_lose:
            return False, (0, 0, 0, 0)
        x, y, w, h = self._box
        # Drift by 1 pixel so tests can detect movement.
        self._box = (x + 1, y, w, h)
        return True, self._box


class TrackingService:
    """Manual ROI tracker.

    Parameters
    ----------
    frame_reader:
        A FrameReader-compatible object (``latest_frame()`` → (frame, ts)).
        Pass ``None`` and the service will always return ``status="no_frame"``.
    tracker:
        Inject a fake tracker for tests.  When ``None`` and OpenCV is
        available, a real cv2 tracker is created at ``start_tracking()`` time.
    """

    def __init__(
        self,
        frame_reader: Any | None = None,
        *,
        tracker: Any | None = None,
    ) -> None:
        self._frame_reader = frame_reader
        self._injected_tracker = tracker
        self._lock = threading.Lock()
        self._tracker: Any = None
        self._current_label: str = "manual selection"
        self._cache: dict[str, Any] = self._build_idle_cache()
        self._worker: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._cache)

    def start_tracking(self, box: Any, label: str = "manual selection") -> dict[str, Any]:
        """Initialise tracking on the given normalised ROI.

        Parameters
        ----------
        box:
            Normalised ``{"x": …, "y": …, "w": …, "h": …}`` coordinates.
        label:
            Human-readable description shown in the UI.

        Returns
        -------
        ``{"ok": True}`` on success or ``{"ok": False, "error": "…"}`` on failure.
        """
        err = _validate_box(box)
        if err:
            return {"ok": False, "error": err}

        if self._frame_reader is None:
            self._update_cache(
                running=False,
                status=STATUS_NO_FRAME,
                label=label,
                box=None,
                message="No frame reader available.",
            )
            return {"ok": False, "error": "No frame reader available."}

        frame, _ts = self._frame_reader.latest_frame()
        if frame is None:
            self._update_cache(
                running=False,
                status=STATUS_NO_FRAME,
                label=label,
                box=None,
                message="No camera frame available yet. Wait for the stream to connect.",
            )
            return {"ok": False, "error": "No camera frame available yet."}

        # Build tracker (injected or real cv2)
        tracker = self._injected_tracker
        if tracker is None:
            try:
                import cv2  # type: ignore  # noqa: PLC0415

                tracker = _make_cv2_tracker(cv2)
            except ImportError:
                self._update_cache(
                    running=False,
                    status=STATUS_OPENCV_MISSING,
                    label=label,
                    box=None,
                    message=(
                        "OpenCV is not installed. "
                        "Install opencv-python to enable manual ROI tracking."
                    ),
                )
                return {"ok": False, "error": "OpenCV is not installed."}

        # Convert normalised box → pixel rect for cv2
        h_px, w_px = frame.shape[:2]
        pixel_box = (
            int(_clamp_norm(box["x"]) * w_px),
            int(_clamp_norm(box["y"]) * h_px),
            max(1, int(_clamp_norm(box["w"]) * w_px)),
            max(1, int(_clamp_norm(box["h"]) * h_px)),
        )
        tracker.init(frame, pixel_box)

        # Stop any existing tracking worker before replacing state
        self._stop_worker()

        norm_box = {k: round(_clamp_norm(float(box[k])), 4) for k in ("x", "y", "w", "h")}
        with self._lock:
            self._tracker = tracker
            self._current_label = label
            self._cache = {
                "enabled": True,
                "running": True,
                "status": STATUS_TRACKING,
                "label": label,
                "box": norm_box,
                "confidence": None,
                "last_update_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "fps": 0.0,
                "message": f"Tracking {label}",
            }

        self._stop_event.clear()
        self._worker = threading.Thread(
            target=self._worker_loop,
            name="tank-tracking",
            daemon=True,
        )
        self._worker.start()
        return {"ok": True}

    def stop_tracking(self) -> dict[str, Any]:
        """Stop tracking and reset to idle."""
        self._stop_worker()
        with self._lock:
            self._cache = self._build_idle_cache()
        return {"ok": True}

    def reset(self) -> dict[str, Any]:
        """Alias for stop_tracking."""
        return self.stop_tracking()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_idle_cache(self) -> dict[str, Any]:
        return {
            "enabled": True,
            "running": False,
            "status": STATUS_IDLE,
            "label": None,
            "box": None,
            "confidence": None,
            "last_update_time": None,
            "fps": 0.0,
            "message": "No tracking active. Select an area on the camera feed to begin.",
        }

    def _update_cache(self, **kwargs: Any) -> None:
        with self._lock:
            self._cache.update(kwargs)

    def _stop_worker(self) -> None:
        self._stop_event.set()
        if self._worker is not None:
            self._worker.join(timeout=1.0)
            self._worker = None
        with self._lock:
            self._tracker = None

    def _worker_loop(self) -> None:  # pragma: no cover - exercised via integration tests
        sample_interval = 1.0 / _SAMPLE_FPS
        last_fps_time = time.monotonic()
        frame_count = 0

        while not self._stop_event.is_set():
            with self._lock:
                tracker = self._tracker

            if tracker is None:
                break

            if self._frame_reader is None:
                self._update_cache(
                    running=False,
                    status=STATUS_NO_FRAME,
                    message="Frame reader disconnected.",
                )
                break

            frame, _ts = self._frame_reader.latest_frame()
            if frame is None:
                self._stop_event.wait(sample_interval)
                continue

            try:
                ok, px_box = tracker.update(frame)
            except Exception as exc:
                LOGGER.warning("Tracker update raised: %s", exc)
                self._update_cache(
                    running=False,
                    status=STATUS_ERROR,
                    message=f"Tracker error: {exc}",
                )
                break

            now = time.monotonic()
            frame_count += 1
            elapsed = now - last_fps_time
            new_fps: Optional[float] = None
            if elapsed >= 1.0:
                new_fps = round(frame_count / elapsed, 1)
                last_fps_time = now
                frame_count = 0

            h_px, w_px = frame.shape[:2]

            with self._lock:
                if not ok:
                    self._cache.update(
                        {
                            "running": False,
                            "status": STATUS_LOST,
                            "box": None,
                            "last_update_time": time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                            ),
                            "message": "Tracking lost — select the object again.",
                        }
                    )
                    break

                x, y, w, h = (float(v) for v in px_box)
                norm_box = {
                    "x": round(max(0.0, min(1.0, x / w_px)), 4),
                    "y": round(max(0.0, min(1.0, y / h_px)), 4),
                    "w": round(max(0.0, min(1.0, w / w_px)), 4),
                    "h": round(max(0.0, min(1.0, h / h_px)), 4),
                }
                self._cache.update(
                    {
                        "running": True,
                        "status": STATUS_TRACKING,
                        "box": norm_box,
                        "last_update_time": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                        ),
                    }
                )
                if new_fps is not None:
                    self._cache["fps"] = new_fps

            self._stop_event.wait(sample_interval)
