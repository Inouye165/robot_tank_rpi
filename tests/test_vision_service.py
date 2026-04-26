from __future__ import annotations

from server.app import create_app
from server.config import Config
from server.detectors import Detector, FakeDetector
from server.vision_service import VisionService


def make_config(monkeypatch, **overrides):
    defaults = {
        "TANK_CAMERA_STREAM_PORT": "8081",
        "TANK_VISION_ENABLED": "false",
        "TANK_VISION_SOURCE_URL": "",
        "TANK_VISION_MODEL_PATH": "",
        "TANK_VISION_MODEL_BACKEND": "disabled",
        "TANK_VISION_SAMPLE_FPS": "2",
        "TANK_VISION_CONFIDENCE": "0.45",
        "TANK_VISION_FRAME_WIDTH": "640",
        # Tests that need person/dog as targets opt in explicitly. The
        # safe production default is `tennis ball,traffic cone,marker`.
        "TANK_VISION_TARGET_LABELS": "tennis ball,traffic cone,marker",
        "TANK_VISION_HAZARD_LABELS": "chair,backpack,suitcase,bottle,box,cup,sports ball,potted plant,traffic cone,unknown obstacle",
    }
    defaults.update(overrides)
    for key, value in defaults.items():
        monkeypatch.setenv(key, value)
    return Config()


def test_vision_service_disabled_status(monkeypatch):
    service = VisionService(make_config(monkeypatch))

    payload = service.get_status()

    assert payload["enabled"] is False
    assert payload["running"] is False
    assert payload["model_backend"] == "disabled"
    assert payload["source_url"] == "http://127.0.0.1:8081/stream.mjpg"
    assert payload["detections"] == []
    assert "disabled" in payload["message"].lower()


def test_detection_result_shape(monkeypatch):
    # Opt person back in for this shape test only.
    service = VisionService(make_config(monkeypatch, TANK_VISION_TARGET_LABELS="person,dog,tennis ball"))

    payload = service.classify_detection(
        {
            "label": "person",
            "confidence": 0.8731,
            "box": {"x": 0.12, "y": 0.2, "w": 0.25, "h": 0.5},
        }
    )

    assert payload == {
        "label": "person",
        "confidence": 0.8731,
        "box": {"x": 0.12, "y": 0.2, "w": 0.25, "h": 0.5},
        "center": {"x": 0.245, "y": 0.45},
        "category": "person",
        "is_hazard": False,
        "is_target": True,
    }


def test_person_is_not_target_by_default(monkeypatch):
    """Safety regression: person must be detected and categorized as 'person'
    but must NOT be flagged as a target candidate under the default config.
    """
    service = VisionService(make_config(monkeypatch))

    payload = service.classify_detection(
        {
            "label": "person",
            "confidence": 0.92,
            "box": {"x": 0.2, "y": 0.3, "w": 0.2, "h": 0.4},
        }
    )

    assert payload["category"] == "person"
    assert payload["is_target"] is False


def test_dog_is_not_target_by_default(monkeypatch):
    """Safety regression: dog must be counted but not targetable by default."""
    service = VisionService(make_config(monkeypatch))

    payload = service.classify_detection(
        {
            "label": "dog",
            "confidence": 0.81,
            "box": {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2},
        }
    )

    assert payload["category"] == "dog"
    assert payload["is_target"] is False


def test_configured_target_label_becomes_target(monkeypatch):
    """A configured marker label (default: 'tennis ball') must be is_target=True."""
    service = VisionService(make_config(monkeypatch))

    payload = service.classify_detection(
        {
            "label": "tennis ball",
            "confidence": 0.7,
            "box": {"x": 0.5, "y": 0.5, "w": 0.05, "h": 0.05},
        }
    )

    assert payload["is_target"] is True
    assert payload["category"] == "target"


def test_hazard_classification_heuristic(monkeypatch):
    service = VisionService(make_config(monkeypatch))

    hazard = service.classify_detection(
        {
            "label": "chair",
            "confidence": 0.81,
            "box": {"x": 0.3, "y": 0.62, "w": 0.2, "h": 0.28},
        }
    )
    non_hazard = service.classify_detection(
        {
            "label": "chair",
            "confidence": 0.81,
            "box": {"x": 0.3, "y": 0.1, "w": 0.2, "h": 0.15},
        }
    )

    assert hazard["category"] == "hazard"
    assert hazard["is_hazard"] is True
    assert non_hazard["category"] == "object"
    assert non_hazard["is_hazard"] is False


def test_target_label_classification(monkeypatch):
    service = VisionService(make_config(monkeypatch, TANK_VISION_TARGET_LABELS="dog,tennis ball"))

    dog = service.classify_detection(
        {
            "label": "dog",
            "confidence": 0.79,
            "box": {"x": 0.22, "y": 0.18, "w": 0.2, "h": 0.24},
        }
    )
    ball = service.classify_detection(
        {
            "label": "tennis ball",
            "confidence": 0.66,
            "box": {"x": 0.55, "y": 0.58, "w": 0.08, "h": 0.08},
        }
    )

    assert dog["category"] == "dog"
    assert dog["is_target"] is True
    assert ball["category"] == "target"
    assert ball["is_target"] is True


def test_vision_status_endpoint_returns_service_snapshot(monkeypatch):
    vision_service = VisionService(make_config(monkeypatch))
    app = create_app(vision_service=vision_service)
    client = app.test_client()

    response = client.get("/api/vision/status")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["enabled"] is False
    assert payload["running"] is False
    assert payload["model_backend"] == "disabled"


def test_vision_detections_endpoint_returns_classified_results(monkeypatch):
    vision_service = VisionService(
        make_config(
            monkeypatch,
            TANK_VISION_ENABLED="true",
            # Opt person/dog back in to exercise the multi-target endpoint shape.
            TANK_VISION_TARGET_LABELS="person,dog,tennis ball",
        )
    )
    vision_service.update_from_candidates(
        [
            {
                "label": "person",
                "confidence": 0.91,
                "box": {"x": 0.1, "y": 0.2, "w": 0.2, "h": 0.45},
            },
            {
                "label": "dog",
                "confidence": 0.88,
                "box": {"x": 0.5, "y": 0.42, "w": 0.22, "h": 0.3},
            },
            {
                "label": "chair",
                "confidence": 0.72,
                "box": {"x": 0.35, "y": 0.66, "w": 0.2, "h": 0.25},
            },
        ]
    )
    app = create_app(vision_service=vision_service)
    client = app.test_client()

    response = client.get("/api/vision/detections")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["enabled"] is True
    assert payload["people_count"] == 1
    assert payload["dog_count"] == 1
    assert len(payload["hazards"]) == 1
    assert len(payload["targets"]) == 2
    assert payload["detections"][0]["center"] == {"x": 0.2, "y": 0.425}

def test_fake_detector_satisfies_detector_protocol():
    fake = FakeDetector()
    assert isinstance(fake, Detector)


def test_vision_service_runs_with_injected_fake_detector(monkeypatch):
    """Inject a FakeDetector and prove update_from_candidates updates state.

    This intentionally drives the public update path used by the worker loop
    rather than spinning a background thread (so the test stays fast and
    deterministic).
    """
    fake = FakeDetector(
        candidates=[
            {
                "label": "tennis ball",
                "confidence": 0.7,
                "box": {"x": 0.5, "y": 0.5, "w": 0.05, "h": 0.05},
            },
            {
                "label": "person",
                "confidence": 0.9,
                "box": {"x": 0.1, "y": 0.2, "w": 0.2, "h": 0.4},
            },
        ]
    )
    config = make_config(monkeypatch)
    service = VisionService(config, detector=fake)

    candidates = fake.detect(
        source_url=service.get_status()["source_url"],
        confidence=config.vision_confidence,
        frame_width=config.vision_frame_width,
    )
    service.update_from_candidates(candidates)

    snapshot = service.get_status()

    assert fake.call_count == 1
    assert fake.last_kwargs["source_url"] == "http://127.0.0.1:8081/stream.mjpg"
    assert snapshot["running"] is True
    assert snapshot["people_count"] == 1
    # Default config: tennis ball is a target, person is not.
    assert len(snapshot["targets"]) == 1
    assert snapshot["targets"][0]["label"] == "tennis ball"
    person_entry = next(d for d in snapshot["detections"] if d["label"] == "person")
    assert person_entry["is_target"] is False


def test_vision_status_includes_extended_fields_when_disabled(monkeypatch):
    """The new vision status fields must be present even when disabled."""
    service = VisionService(make_config(monkeypatch))
    payload = service.get_status()

    for key in (
        "enabled",
        "running",
        "backend",
        "model_backend",
        "model_path",
        "model_loaded",
        "source_url",
        "stream_connected",
        "last_frame_time",
        "last_detection_time",
        "fps",
        "detections",
        "detections_count",
        "message",
    ):
        assert key in payload, f"missing status field: {key}"

    assert payload["backend"] == "disabled"
    assert payload["model_loaded"] is False
    assert payload["stream_connected"] is False
    assert payload["detections_count"] == 0


def test_vision_service_uses_frame_reader_when_available(monkeypatch):
    """A FrameDetector + FrameReader must drive update_from_candidates without
    reopening the MJPEG stream every iteration."""
    from server.frame_reader import FakeFrameReader

    fake_detector = FakeDetector(
        candidates=[
            {
                "label": "tennis ball",
                "confidence": 0.7,
                "box": {"x": 0.5, "y": 0.5, "w": 0.05, "h": 0.05},
            }
        ]
    )
    reader = FakeFrameReader(frame=object())
    config = make_config(monkeypatch)
    service = VisionService(config, detector=fake_detector, frame_reader=reader)

    # Drive one iteration of the future-ready path manually so the test
    # stays deterministic and does not depend on the worker thread.
    raw = service._detect_once()  # noqa: SLF001 - test-only access
    service.update_from_candidates(raw)

    snapshot = service.get_status()
    assert fake_detector.frame_call_count == 1
    assert fake_detector.call_count == 0  # legacy path NOT used
    assert snapshot["stream_connected"] is True
    assert snapshot["model_loaded"] is True
    assert snapshot["detections_count"] == 1
    assert snapshot["targets"][0]["label"] == "tennis ball"


def test_vision_service_handles_unavailable_stream_gracefully(monkeypatch):
    """When the frame reader has no frame yet, no detections are produced
    and the cockpit must not crash."""
    from server.frame_reader import FakeFrameReader

    fake_detector = FakeDetector(
        candidates=[
            {
                "label": "tennis ball",
                "confidence": 0.7,
                "box": {"x": 0.5, "y": 0.5, "w": 0.05, "h": 0.05},
            }
        ]
    )
    reader = FakeFrameReader(frame=None, connected=False)
    config = make_config(monkeypatch)
    service = VisionService(config, detector=fake_detector, frame_reader=reader)

    raw = service._detect_once()  # noqa: SLF001
    assert raw == []
    assert fake_detector.frame_call_count == 0

    snapshot = service.get_status()
    assert snapshot["stream_connected"] is False
