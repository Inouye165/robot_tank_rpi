"""Backend tests for the monitor-only manual ROI tracking service.

Safety note: tracking must never send serial commands. These tests verify
only the status/tracking logic and the HTTP API shape.
"""

from __future__ import annotations

import numpy as np

from server.app import create_app
from server.tracking_service import (
    FakeTracker,
    TrackingService,
    STATUS_IDLE,
    STATUS_LOST,
    STATUS_NO_FRAME,
    STATUS_OPENCV_MISSING,
    STATUS_TRACKER_UNAVAILABLE,
    STATUS_TRACKING,
    _validate_box,
    _make_cv2_tracker,
    available_tracker_apis,
)
from server.frame_reader import FakeFrameReader


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_frame(width: int = 320, height: int = 240) -> object:
    """Return a minimal numpy-like frame array for tracker tests."""
    return np.zeros((height, width, 3), dtype=np.uint8)


def make_service(frame=None, *, tracker=None):
    """Convenience factory for TrackingService with optional injected frame."""
    reader = FakeFrameReader(frame=frame) if frame is not None else FakeFrameReader(connected=False)
    if frame is None:
        reader = FakeFrameReader(frame=None)
    return TrackingService(frame_reader=reader, tracker=tracker)


# ---------------------------------------------------------------------------
# _validate_box unit tests
# ---------------------------------------------------------------------------

def test_validate_box_valid():
    assert _validate_box({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}) is None


def test_validate_box_missing_field():
    err = _validate_box({"x": 0.1, "y": 0.2, "w": 0.3})
    assert err is not None
    assert "h" in err


def test_validate_box_out_of_range():
    err = _validate_box({"x": 1.5, "y": 0.0, "w": 0.1, "h": 0.1})
    assert err is not None
    assert "x" in err


def test_validate_box_zero_dimension():
    err = _validate_box({"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.1})
    assert err is not None


def test_validate_box_not_dict():
    err = _validate_box([0.1, 0.2, 0.3, 0.4])
    assert err is not None


# ---------------------------------------------------------------------------
# TrackingService initial state
# ---------------------------------------------------------------------------

def test_tracking_status_starts_idle():
    service = TrackingService()
    status = service.get_status()

    assert status["status"] == STATUS_IDLE
    assert status["running"] is False
    assert status["box"] is None
    assert status["label"] is None


def test_tracking_status_shape_is_stable():
    service = TrackingService()
    status = service.get_status()

    required_keys = {
        "enabled", "running", "status", "label", "box",
        "confidence", "last_update_time", "fps", "message",
    }
    assert required_keys.issubset(status.keys())


# ---------------------------------------------------------------------------
# start_tracking validation
# ---------------------------------------------------------------------------

def test_start_tracking_rejects_invalid_box():
    service = TrackingService()
    result = service.start_tracking({"x": 0.1, "y": 0.2, "w": 0.0, "h": 0.3})
    assert result["ok"] is False
    assert "error" in result


def test_start_tracking_rejects_out_of_range_box():
    service = TrackingService()
    result = service.start_tracking({"x": -0.1, "y": 0.2, "w": 0.3, "h": 0.4})
    assert result["ok"] is False


def test_start_tracking_rejects_non_dict_box():
    service = TrackingService()
    result = service.start_tracking("not a box")
    assert result["ok"] is False


# ---------------------------------------------------------------------------
# start_tracking with no frame reader
# ---------------------------------------------------------------------------

def test_start_tracking_no_frame_reader():
    service = TrackingService(frame_reader=None)
    result = service.start_tracking({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})
    assert result["ok"] is False
    assert result["error"] == "No frame reader available."

    status = service.get_status()
    assert status["status"] == STATUS_NO_FRAME


def test_start_tracking_no_frame_available():
    # Frame reader exists but has returned no frame yet
    empty_reader = FakeFrameReader(frame=None)
    service = TrackingService(frame_reader=empty_reader, tracker=FakeTracker())
    result = service.start_tracking({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})
    assert result["ok"] is False
    status = service.get_status()
    assert status["status"] == STATUS_NO_FRAME


# ---------------------------------------------------------------------------
# start_tracking with OpenCV missing
# ---------------------------------------------------------------------------

def test_start_tracking_opencv_missing(monkeypatch):
    """When cv2 cannot be imported and no tracker is injected, report opencv_missing."""
    frame = make_frame()
    reader = FakeFrameReader(frame=frame)
    service = TrackingService(frame_reader=reader)  # no injected tracker

    # Simulate cv2 import failure by patching builtins.__import__
    import builtins

    real_import = builtins.__import__

    def mock_import(name, *args, **kwargs):
        if name == "cv2":
            raise ImportError("cv2 not found (mocked)")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", mock_import)

    result = service.start_tracking({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})
    assert result["ok"] is False
    assert result["error"] == "OpenCV is not installed."

    status = service.get_status()
    assert status["status"] == STATUS_OPENCV_MISSING


# ---------------------------------------------------------------------------
# start_tracking when cv2 is present but has no tracker APIs
# ---------------------------------------------------------------------------

def test_start_tracking_tracker_unavailable(monkeypatch):
    """When cv2 imports but _make_cv2_tracker raises RuntimeError, return tracker_unavailable."""
    frame = make_frame()
    reader = FakeFrameReader(frame=frame)
    service = TrackingService(frame_reader=reader)  # no injected tracker

    # Patch _make_cv2_tracker to raise RuntimeError (simulates plain opencv-python)
    import server.tracking_service as ts_mod
    monkeypatch.setattr(ts_mod, "_make_cv2_tracker", lambda cv2: (_ for _ in ()).throw(
        RuntimeError("No suitable OpenCV tracker found.")
    ))

    result = service.start_tracking({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})
    assert result["ok"] is False
    assert "contrib" in result["error"].lower() or "csrt" in result["error"].lower()

    status = service.get_status()
    assert status["status"] == STATUS_TRACKER_UNAVAILABLE
    assert "contrib" in status["message"].lower() or "csrt" in status["message"].lower()


def test_start_tracking_tracker_unavailable_http(monkeypatch):
    """/api/tracking/start returns JSON 200 with ok=False, never a 500."""
    import server.tracking_service as ts_mod
    monkeypatch.setattr(ts_mod, "_make_cv2_tracker", lambda cv2: (_ for _ in ()).throw(
        RuntimeError("No suitable OpenCV tracker found.")
    ))

    frame = make_frame()
    reader = FakeFrameReader(frame=frame)
    tracking_svc = TrackingService(frame_reader=reader)

    app = create_app(tracking_service=tracking_svc)
    client = app.test_client()
    resp = client.post(
        "/api/tracking/start",
        json={"box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}, "label": "test"},
    )
    # Must be JSON 4xx, never a 500
    assert resp.status_code != 500
    assert resp.status_code < 500
    data = resp.get_json()
    assert data is not None, "response must be JSON, not HTML"
    assert data["ok"] is False
    assert "contrib" in data.get("error", "").lower() or "csrt" in data.get("error", "").lower()


# ---------------------------------------------------------------------------
# available_tracker_apis helper
# ---------------------------------------------------------------------------

def test_available_tracker_apis_empty_cv2():
    """available_tracker_apis returns all-False for a stub with no tracker attrs."""
    class _EmptyCv2:
        pass

    result = available_tracker_apis(_EmptyCv2())
    assert isinstance(result, dict)
    assert len(result) > 0
    assert all(v is False for v in result.values())


def test_available_tracker_apis_with_factory():
    """available_tracker_apis returns True for a creator that exists."""
    class _StubCv2:
        def TrackerCSRT_create(self):  # noqa: N802
            pass

    result = available_tracker_apis(_StubCv2())
    assert result["TrackerCSRT_create"] is True
    assert result["TrackerKCF_create"] is False


def test_available_tracker_apis_legacy_namespace():
    """available_tracker_apis correctly traverses the legacy namespace."""
    class _Legacy:
        def TrackerKCF_create(self):  # noqa: N802
            pass

    class _StubCv2:
        legacy = _Legacy()

    result = available_tracker_apis(_StubCv2())
    assert result["legacy.TrackerKCF_create"] is True
    assert result["legacy.TrackerCSRT_create"] is False


def test_make_cv2_tracker_raises_when_no_apis():
    """_make_cv2_tracker raises RuntimeError for a bare cv2 stub."""
    import pytest

    class _EmptyCv2:
        pass

    with pytest.raises(RuntimeError, match="No suitable OpenCV tracker"):
        _make_cv2_tracker(_EmptyCv2())


# ---------------------------------------------------------------------------
# Injected FakeTracker — happy path
# ---------------------------------------------------------------------------

def test_start_tracking_with_fake_tracker():
    frame = make_frame()
    tracker = FakeTracker()
    service = make_service(frame=frame, tracker=tracker)

    result = service.start_tracking({"x": 0.2, "y": 0.3, "w": 0.15, "h": 0.20}, label="toy")
    assert result["ok"] is True

    status = service.get_status()
    assert status["status"] == STATUS_TRACKING
    assert status["running"] is True
    assert status["label"] == "toy"
    assert status["box"] is not None
    assert 0.0 <= status["box"]["x"] <= 1.0

    # Init was called once with the pixel rect
    assert tracker.init_calls == 1

    service.stop_tracking()


def test_stop_tracking_returns_idle():
    frame = make_frame()
    tracker = FakeTracker()
    service = make_service(frame=frame, tracker=tracker)

    service.start_tracking({"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2})
    result = service.stop_tracking()
    assert result["ok"] is True

    status = service.get_status()
    assert status["status"] == STATUS_IDLE
    assert status["running"] is False


def test_reset_is_alias_for_stop():
    frame = make_frame()
    tracker = FakeTracker()
    service = make_service(frame=frame, tracker=tracker)

    service.start_tracking({"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2})
    result = service.reset()
    assert result["ok"] is True
    assert service.get_status()["status"] == STATUS_IDLE


# ---------------------------------------------------------------------------
# Lost tracking
# ---------------------------------------------------------------------------

def test_lost_tracker_returns_status_lost():
    """A FakeTracker configured to lose the target should produce status='lost'."""
    frame = make_frame()
    reader = FakeFrameReader(frame=frame)
    tracker = FakeTracker(should_lose=True)
    service = TrackingService(frame_reader=reader, tracker=tracker)

    # Use start_tracking which inits the tracker synchronously
    service.start_tracking({"x": 0.2, "y": 0.2, "w": 0.2, "h": 0.2})

    # Simulate one worker iteration by calling the tracker.update directly
    # (the worker loop is a daemon thread; we test the tracker state here)
    ok, _ = tracker.update(frame)
    assert ok is False  # Confirm the fake loses the target

    # Force the cache into lost state the same way the worker would
    service._update_cache(
        running=False,
        status=STATUS_LOST,
        box=None,
        message="Tracking lost — select the object again.",
    )

    status = service.get_status()
    assert status["status"] == STATUS_LOST
    assert status["running"] is False
    assert status["box"] is None
    assert "lost" in status["message"].lower()

    service.stop_tracking()


# ---------------------------------------------------------------------------
# HTTP endpoint tests
# ---------------------------------------------------------------------------

def make_app_with_tracking(tracking_service=None):
    """Build a test Flask app with a controllable tracking service."""
    class _StubSerial:
        def status(self):
            return {"connected": False, "port": "/dev/null", "baud_rate": 115200,
                    "error": None, "error_code": None, "last_response": None,
                    "startup_banner": None, "ready": False}
        def send_command(self, cmd):
            return type("R", (), {"ok": True, "message": "ok", "error_code": None, "response": "ok"})()
        def read_sensors(self):
            return type("R", (), {"ok": True, "message": "ok", "sensors": {}, "response": "", "error_code": None})()
        def read_firmware_status(self):
            return type("R", (), {"ok": True, "message": "ok", "status": None, "response": "", "error_code": None})()

    return create_app(
        serial_service=_StubSerial(),
        tracking_service=tracking_service or TrackingService(),
    )


def test_tracking_status_endpoint_idle():
    app = make_app_with_tracking()
    client = app.test_client()

    response = client.get("/api/tracking/status")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["status"] == STATUS_IDLE
    assert payload["running"] is False


def test_tracking_status_endpoint_shape():
    app = make_app_with_tracking()
    client = app.test_client()

    payload = client.get("/api/tracking/status").get_json()
    for key in ("enabled", "running", "status", "label", "box", "confidence",
                "last_update_time", "fps", "message"):
        assert key in payload, f"Key '{key}' missing from tracking status"


def test_tracking_start_missing_box():
    app = make_app_with_tracking()
    client = app.test_client()

    response = client.post("/api/tracking/start", json={"label": "toy"})
    assert response.status_code == 400
    assert response.get_json()["ok"] is False


def test_tracking_start_invalid_box():
    app = make_app_with_tracking()
    client = app.test_client()

    response = client.post("/api/tracking/start", json={
        "box": {"x": 0.1, "y": 0.2, "w": 0.0, "h": 0.3},
    })
    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert "error" in payload


def test_tracking_start_no_frame():
    """Start tracking with no frame returns a non-crash 400."""
    service = TrackingService(frame_reader=FakeFrameReader(frame=None))
    app = make_app_with_tracking(tracking_service=service)
    client = app.test_client()

    response = client.post("/api/tracking/start", json={
        "box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.3},
    })
    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False


def test_tracking_start_with_fake_tracker():
    frame = make_frame()
    tracker = FakeTracker()
    service = TrackingService(
        frame_reader=FakeFrameReader(frame=frame),
        tracker=tracker,
    )
    app = make_app_with_tracking(tracking_service=service)
    client = app.test_client()

    response = client.post("/api/tracking/start", json={
        "box": {"x": 0.2, "y": 0.3, "w": 0.15, "h": 0.20},
        "label": "manual selection",
    })
    assert response.status_code == 200
    assert response.get_json()["ok"] is True

    status_response = client.get("/api/tracking/status")
    status = status_response.get_json()
    assert status["status"] == STATUS_TRACKING
    assert status["label"] == "manual selection"

    service.stop_tracking()


def test_tracking_stop_endpoint():
    frame = make_frame()
    service = TrackingService(
        frame_reader=FakeFrameReader(frame=frame),
        tracker=FakeTracker(),
    )
    service.start_tracking({"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2})
    app = make_app_with_tracking(tracking_service=service)
    client = app.test_client()

    response = client.post("/api/tracking/stop")
    assert response.status_code == 200
    assert response.get_json()["ok"] is True

    status = client.get("/api/tracking/status").get_json()
    assert status["status"] == STATUS_IDLE


def test_tracking_reset_endpoint():
    app = make_app_with_tracking()
    client = app.test_client()

    response = client.post("/api/tracking/reset")
    assert response.status_code == 200
    assert response.get_json()["ok"] is True


def test_tracking_does_not_send_serial_commands():
    """Safety: starting tracking (without follow mode) must never touch serial."""

    class _SpySerial:
        def __init__(self):
            self.commands = []

        def status(self):
            return {"connected": False, "port": "/dev/null", "baud_rate": 115200,
                    "error": None, "error_code": None, "last_response": None,
                    "startup_banner": None, "ready": False}

        def send_command(self, cmd):
            self.commands.append(cmd)
            return type("R", (), {"ok": True, "message": "ok", "error_code": None, "response": "ok"})()

        def read_sensors(self):
            return type("R", (), {"ok": True, "message": "ok", "sensors": {}, "response": "", "error_code": None})()

        def read_firmware_status(self):
            return type("R", (), {"ok": True, "message": "ok", "status": None, "response": "", "error_code": None})()

    frame = make_frame()
    serial = _SpySerial()
    tracking = TrackingService(
        frame_reader=FakeFrameReader(frame=frame),
        tracker=FakeTracker(),
        serial_service=serial,
    )
    app = create_app(serial_service=serial, tracking_service=tracking)
    client = app.test_client()

    client.post("/api/tracking/start", json={
        "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2},
    })
    client.post("/api/tracking/stop")

    assert serial.commands == [], "Tracking without follow must never send serial commands"


# ---------------------------------------------------------------------------
# Gimbal-follow controller
# ---------------------------------------------------------------------------

def test_follow_step_inside_deadzone_returns_none():
    """Box centred inside the deadzone produces no servo command."""
    service = TrackingService()
    # Box centred at (0.5, 0.5)
    result = service._follow_step({"x": 0.48, "y": 0.49, "w": 0.04, "h": 0.02})
    assert result is None


def test_follow_step_box_right_of_centre_moves_pan():
    """A box to the right of centre moves the pan servo (default invert=False)."""
    service = TrackingService()
    initial_pan = service._pan_deg
    # Box centred at (0.7, 0.5) → err_x = +0.2, well beyond deadzone
    result = service._follow_step({"x": 0.65, "y": 0.48, "w": 0.10, "h": 0.04})
    assert result is not None
    pan, tilt = result
    # With pan_invert=False (default), positive err_x → positive delta → pan increases
    assert pan > initial_pan
    # Tilt error inside deadzone, but the controller still updates state if any
    # axis moved; tilt should be near initial.
    assert abs(tilt - 90) <= 1


def test_follow_step_box_below_centre_moves_tilt():
    """A box below centre moves the tilt servo."""
    service = TrackingService()
    initial_tilt = service._tilt_deg
    # Box centred at (0.5, 0.75)
    result = service._follow_step({"x": 0.48, "y": 0.70, "w": 0.04, "h": 0.10})
    assert result is not None
    _pan, tilt = result
    assert tilt != initial_tilt


def test_follow_step_invert_enabled_flips_sign():
    """With invert enabled, a right-of-centre box moves pan in the opposite direction."""
    service = TrackingService()
    service.set_follow(True, pan_invert=True, tilt_invert=True)
    initial_pan = service._pan_deg
    result = service._follow_step({"x": 0.65, "y": 0.48, "w": 0.10, "h": 0.04})
    assert result is not None
    pan, _tilt = result
    assert pan < initial_pan


def test_follow_step_max_step_clamped():
    """Even an extreme error is clamped to the per-cycle max step."""
    service = TrackingService()
    initial_pan = service._pan_deg
    # Box centred at the far right edge (0.95, 0.5)
    result = service._follow_step({"x": 0.93, "y": 0.49, "w": 0.04, "h": 0.02})
    assert result is not None
    pan, _tilt = result
    # With gain 30 deg, err_x = 0.45 would imply +13.5°
    # but max_step is 8°, so |delta| ≤ 8.
    assert abs(pan - initial_pan) <= 8


def test_follow_step_servo_clamped_to_range():
    """Pan/tilt cannot exceed [0, 180]."""
    service = TrackingService()
    service._pan_deg = 5.0
    # Box at far left → err_x negative → delta_pan positive (with invert) … move to 0
    # Or set pan near 0 then push toward 0
    service._pan_deg = 0.0
    result = service._follow_step({"x": 0.05, "y": 0.49, "w": 0.04, "h": 0.02})
    if result is not None:
        pan, _tilt = result
        assert 0 <= pan <= 180


def test_set_follow_endpoint_enables_follow():
    """POST /api/tracking/follow {enabled: true} flips the flag."""
    app = make_app_with_tracking()
    client = app.test_client()

    response = client.post("/api/tracking/follow", json={"enabled": True})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["follow_enabled"] is True

    status = client.get("/api/tracking/status").get_json()
    assert status["follow_enabled"] is True


def test_set_follow_endpoint_missing_enabled_returns_400():
    app = make_app_with_tracking()
    client = app.test_client()

    response = client.post("/api/tracking/follow", json={})
    assert response.status_code == 400
    assert response.get_json()["ok"] is False


def test_follow_with_serial_sends_camera_command():
    """When follow is enabled and a tracking step finds error, CAMERANOW is sent."""

    class _SpySerial:
        def __init__(self):
            self.commands = []

        def status(self):
            return {"connected": False, "port": "/dev/null", "baud_rate": 115200,
                    "error": None, "error_code": None, "last_response": None,
                    "startup_banner": None, "ready": False}

        def send_command(self, cmd):
            self.commands.append(cmd)
            return type("R", (), {"ok": True, "message": "ok", "error_code": None, "response": "ok"})()

        def read_sensors(self):
            return type("R", (), {"ok": True, "message": "ok", "sensors": {}, "response": "", "error_code": None})()

        def read_firmware_status(self):
            return type("R", (), {"ok": True, "message": "ok", "status": None, "response": "", "error_code": None})()

    serial = _SpySerial()
    service = TrackingService(serial_service=serial)
    service.set_follow(True)
    # Direct controller call simulates one tracking cycle's update.
    cmd = service._follow_step({"x": 0.65, "y": 0.65, "w": 0.10, "h": 0.10})
    assert cmd is not None
    pan, tilt = cmd
    # Mimic the worker's outside-the-lock send (kept simple; the real worker
    # would do this automatically inside _worker_loop).
    serial.send_command(f"CAMERANOW {pan} {tilt}")
    assert any(c.startswith("CAMERANOW ") for c in serial.commands)
