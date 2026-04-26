from __future__ import annotations

from server.app import create_app
from server.config import Config
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
        "TANK_VISION_TARGET_LABELS": "person,dog,tennis ball",
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
    service = VisionService(make_config(monkeypatch))

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
    vision_service = VisionService(make_config(monkeypatch, TANK_VISION_ENABLED="true"))
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