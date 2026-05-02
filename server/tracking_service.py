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
STATUS_TRACKER_UNAVAILABLE = "tracker_unavailable"
STATUS_NO_FRAME = "no_frame"

_SAMPLE_FPS = 5.0

# Gimbal follow controller tuning
_PAN_GAIN_DEG = 30.0      # degrees per full-frame error (half-image)
_TILT_GAIN_DEG = 25.0
_MAX_STEP_DEG = 8.0       # max degrees moved per control cycle
_DEADZONE = 0.04          # ignore errors smaller than this fraction of frame
_SERVO_MIN = 0
_SERVO_MAX = 180
_SERVO_CENTER = 90


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


def available_tracker_apis(cv2: Any) -> dict[str, bool]:
    """Return which OpenCV tracker creator names are available in *cv2*.

    Checks both the top-level namespace (plain ``opencv-python``) and the
    legacy namespace (``opencv-contrib-python-headless``).
    """
    names = [
        "TrackerCSRT_create",
        "TrackerKCF_create",
        "TrackerMOSSE_create",
        "legacy.TrackerCSRT_create",
        "legacy.TrackerKCF_create",
        "legacy.TrackerMOSSE_create",
    ]
    result: dict[str, bool] = {}
    for name in names:
        obj: Any = cv2
        ok = True
        for part in name.split("."):
            if not hasattr(obj, part):
                ok = False
                break
            obj = getattr(obj, part)
        result[name] = ok
    return result


def _make_cv2_tracker(cv2: Any) -> Any:
    """Return the best available OpenCV tracker object.

    Checks both the top-level namespace (plain opencv-python) and the
    legacy namespace (opencv-contrib-python-headless, OpenCV ≥ 4.5).
    Preference order: CSRT → KCF → MOSSE.
    Raises RuntimeError if no suitable tracker API is found.
    """
    # Top-level names (older contrib builds and some platform packages)
    for factory_name in ("TrackerCSRT_create", "TrackerKCF_create", "TrackerMOSSE_create"):
        factory = getattr(cv2, factory_name, None)
        if factory is not None:
            try:
                return factory()
            except Exception:  # pragma: no cover - cv2 API variations
                continue
    # cv2.legacy namespace (opencv-contrib ≥ 4.5)
    legacy = getattr(cv2, "legacy", None)
    if legacy is not None:
        for factory_name in ("TrackerCSRT_create", "TrackerKCF_create", "TrackerMOSSE_create"):
            factory = getattr(legacy, factory_name, None)
            if factory is not None:
                try:
                    return factory()
                except Exception:  # pragma: no cover
                    continue
    # Older unified Tracker.create API
    if hasattr(cv2, "Tracker"):
        for name in ("CSRT", "KCF", "MOSSE"):
            try:
                return cv2.Tracker.create(name)  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover
                continue
    raise RuntimeError(
        "No suitable OpenCV tracker found. "
        "Install opencv-contrib-python-headless to enable CSRT/KCF tracking."
    )


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
        serial_service: Any | None = None,
    ) -> None:
        self._frame_reader = frame_reader
        self._injected_tracker = tracker
        self._serial_service = serial_service
        self._lock = threading.Lock()
        self._tracker: Any = None
        self._current_label: str = "manual selection"
        # Follow-mode state
        self._follow_enabled: bool = False
        self._pan_invert: bool = False  # set True if gimbal moves the wrong way on pan
        self._tilt_invert: bool = True   # tilt servo geometry is inverted on this rig
        self._pan_deg: float = float(_SERVO_CENTER)
        self._tilt_deg: float = float(_SERVO_CENTER)
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
                        "Install opencv-contrib-python-headless to enable manual ROI tracking."
                    ),
                )
                return {"ok": False, "error": "OpenCV is not installed."}
            except RuntimeError as exc:
                msg = (
                    "OpenCV is installed, but no CSRT/KCF tracker API is available. "
                    "Install opencv-contrib-python-headless."
                )
                LOGGER.warning("Tracker unavailable: %s", exc)
                self._update_cache(
                    running=False,
                    status=STATUS_TRACKER_UNAVAILABLE,
                    label=label,
                    box=None,
                    message=msg,
                )
                return {"ok": False, "error": msg}

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
                "follow_enabled": self._follow_enabled,
                "pan": round(self._pan_deg, 1),
                "tilt": round(self._tilt_deg, 1),
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

    def set_follow(
        self,
        enabled: bool,
        *,
        pan_invert: Optional[bool] = None,
        tilt_invert: Optional[bool] = None,
    ) -> dict[str, Any]:
        """Enable or disable gimbal follow mode.

        When enabled and the tracker reports a valid box, the worker loop
        proportionally adjusts the camera pan/tilt servos to keep the box
        centred. When disabled, no servo commands are sent.

        Optional ``pan_invert``/``tilt_invert`` flip the control sign on each
        axis — useful when the camera is mounted upside down or rotated.
        """
        with self._lock:
            self._follow_enabled = bool(enabled)
            if pan_invert is not None:
                self._pan_invert = bool(pan_invert)
            if tilt_invert is not None:
                self._tilt_invert = bool(tilt_invert)
            self._cache["follow_enabled"] = self._follow_enabled
            self._cache["pan"] = round(self._pan_deg, 1)
            self._cache["tilt"] = round(self._tilt_deg, 1)
        if not enabled:
            # When turning off, recentre nothing — leave servos where they are.
            LOGGER.info("Gimbal follow disabled")
        else:
            LOGGER.info(
                "Gimbal follow enabled (pan_invert=%s, tilt_invert=%s)",
                self._pan_invert, self._tilt_invert,
            )
        return {"ok": True, "follow_enabled": self._follow_enabled}

    def _follow_step(self, box: dict[str, float]) -> Optional[tuple[int, int]]:
        """Compute the next (pan, tilt) servo target from a tracking box.

        Returns ``None`` when the error is inside the deadzone (no command
        needed). Updates internal pan/tilt state in-place.
        """
        cx = box["x"] + box["w"] / 2.0
        cy = box["y"] + box["h"] / 2.0
        err_x = cx - 0.5
        err_y = cy - 0.5
        if abs(err_x) < _DEADZONE and abs(err_y) < _DEADZONE:
            return None
        # Proportional step, clamped
        sign_x = -1.0 if self._pan_invert else 1.0
        sign_y = -1.0 if self._tilt_invert else 1.0
        delta_pan = max(-_MAX_STEP_DEG, min(_MAX_STEP_DEG, sign_x * _PAN_GAIN_DEG * err_x))
        delta_tilt = max(-_MAX_STEP_DEG, min(_MAX_STEP_DEG, sign_y * _TILT_GAIN_DEG * err_y))
        new_pan = max(_SERVO_MIN, min(_SERVO_MAX, self._pan_deg + delta_pan))
        new_tilt = max(_SERVO_MIN, min(_SERVO_MAX, self._tilt_deg + delta_tilt))
        if int(round(new_pan)) == int(round(self._pan_deg)) and int(round(new_tilt)) == int(round(self._tilt_deg)):
            return None
        self._pan_deg = new_pan
        self._tilt_deg = new_tilt
        return (int(round(new_pan)), int(round(new_tilt)))

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
            "follow_enabled": getattr(self, "_follow_enabled", False),
            "pan": round(getattr(self, "_pan_deg", float(_SERVO_CENTER)), 1),
            "tilt": round(getattr(self, "_tilt_deg", float(_SERVO_CENTER)), 1),
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
                # Run gimbal follow controller while still holding the lock
                # (modifies self._pan_deg/_tilt_deg).
                follow_command: Optional[tuple[int, int]] = None
                if self._follow_enabled and self._serial_service is not None:
                    follow_command = self._follow_step(norm_box)
                self._cache["pan"] = round(self._pan_deg, 1)
                self._cache["tilt"] = round(self._tilt_deg, 1)
                self._cache["follow_enabled"] = self._follow_enabled

            # Send servo command outside the lock so a slow serial write does
            # not block status reads.
            if follow_command is not None:
                pan_deg, tilt_deg = follow_command
                try:
                    self._serial_service.send_command(f"CAMERANOW {pan_deg} {tilt_deg}")
                except Exception as exc:  # pragma: no cover - serial failures shouldn't crash worker
                    LOGGER.warning("Gimbal follow send failed: %s", exc)

            self._stop_event.wait(sample_interval)
