from __future__ import annotations

from dataclasses import dataclass
import logging
from threading import Event, Lock, Thread
import time
from typing import Any

from .config import Config

LOGGER = logging.getLogger(__name__)

DEFAULT_SOURCE_HOST = "127.0.0.1"
DEFAULT_HAZARD_ZONE_Y = 0.6


def _parse_label_list(raw_value: str) -> set[str]:
    return {item.strip().lower() for item in raw_value.split(",") if item.strip()}


def _clamp_normalized(value: float) -> float:
    return max(0.0, min(1.0, value))


def _round_normalized(value: float) -> float:
    return round(_clamp_normalized(value), 4)


@dataclass(frozen=True)
class DetectionCandidate:
    label: str
    confidence: float
    box: dict[str, float]


class VisionService:
    def __init__(self, config: Config, detector: Any | None = None) -> None:
        self._config = config
        self._detector = detector
        self._lock = Lock()
        self._stop_event = Event()
        self._worker: Thread | None = None
        self._source_url = config.vision_source_url or (
            f"http://{DEFAULT_SOURCE_HOST}:{config.camera_stream_port}/stream.mjpg"
        )
        self._target_labels = _parse_label_list(config.vision_target_labels)
        self._hazard_labels = _parse_label_list(config.vision_hazard_labels)
        self._cache = self._build_initial_cache()
        self._start_if_configured()

    def _build_initial_cache(self) -> dict[str, Any]:
        enabled = self._config.vision_enabled
        model_backend = self._config.vision_model_backend or "disabled"
        model_path = self._config.vision_model_path or None
        message = self._status_message(enabled=enabled, model_backend=model_backend, model_path=model_path)
        return {
            "enabled": enabled,
            "running": False,
            "source_url": self._source_url,
            "model_backend": model_backend,
            "model_path": model_path,
            "last_frame_time": None,
            "fps": 0.0,
            "detections": [],
            "people_count": 0,
            "dog_count": 0,
            "hazards": [],
            "targets": [],
            "message": message,
        }

    def _status_message(self, *, enabled: bool, model_backend: str, model_path: str | None) -> str:
        if not enabled:
            return "Vision monitoring disabled. Set TANK_VISION_ENABLED=true to enable monitor-only detection."
        if model_backend == "disabled":
            return "Vision monitoring enabled, but model backend is disabled. No detections will run."
        if not model_path:
            return "Vision monitoring enabled, but no model path is configured."
        return "Vision monitoring ready."

    def _start_if_configured(self) -> None:
        if not self._config.vision_enabled:
            return
        if (self._config.vision_model_backend or "disabled") == "disabled":
            return
        if not self._config.vision_model_path:
            return

        self._worker = Thread(target=self._worker_loop, name="tank-vision", daemon=True)
        self._worker.start()

    def _worker_loop(self) -> None:
        with self._lock:
            self._cache["running"] = True
            self._cache["message"] = "Vision monitoring worker started in monitor-only mode."
        LOGGER.info("Vision worker started with backend=%s source=%s", self._cache["model_backend"], self._source_url)

        sample_interval = 1.0 / max(self._config.vision_sample_fps, 0.1)
        failure_count = 0
        while not self._stop_event.is_set():
            if self._detector is None:
                with self._lock:
                    self._cache["running"] = False
                    self._cache["message"] = "Vision backend configured, but no detector implementation is available."
                LOGGER.warning("Vision worker stopping because no detector implementation is attached.")
                return

            try:
                # NOTE: passing `source_url` per call is TEMPORARY. The future
                # shape splits a frame reader (which owns the MJPEG
                # connection) from a detector (which consumes already-decoded
                # frames), so detectors stop reopening the stream every loop.
                # See docs/FUTURE_IMPROVEMENTS.md and server/detectors.py.
                raw_detections = self._detector.detect(
                    source_url=self._source_url,
                    confidence=self._config.vision_confidence,
                    frame_width=self._config.vision_frame_width,
                )
                self.update_from_candidates(raw_detections)
                failure_count = 0
            except Exception as exc:  # pragma: no cover - exercised via integration/runtime only
                failure_count += 1
                if failure_count <= 3 or failure_count % 10 == 0:
                    LOGGER.warning("Vision worker could not read detections from %s: %s", self._source_url, exc)
                with self._lock:
                    self._cache["running"] = False
                    self._cache["message"] = f"Vision stream unavailable: {exc}"

            self._stop_event.wait(sample_interval)

    def stop(self) -> None:
        self._stop_event.set()
        if self._worker is not None:
            self._worker.join(timeout=1.0)

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._cache)

    def get_detections(self) -> dict[str, Any]:
        return self.get_status()

    def classify_detection(self, detection: DetectionCandidate | dict[str, Any]) -> dict[str, Any]:
        if isinstance(detection, DetectionCandidate):
            label = detection.label
            confidence = detection.confidence
            box = detection.box
        else:
            label = str(detection["label"])
            confidence = float(detection["confidence"])
            box = dict(detection["box"])

        normalized_box = {
            "x": _round_normalized(float(box["x"])),
            "y": _round_normalized(float(box["y"])),
            "w": _round_normalized(float(box["w"])),
            "h": _round_normalized(float(box["h"])),
        }
        center = {
            "x": _round_normalized(normalized_box["x"] + normalized_box["w"] / 2),
            "y": _round_normalized(normalized_box["y"] + normalized_box["h"] / 2),
        }
        normalized_label = label.strip().lower()

        is_person = normalized_label == "person"
        is_dog = normalized_label == "dog"
        is_target = normalized_label in self._target_labels
        is_hazard = self._is_hazard_label(normalized_label) and self._is_in_hazard_zone(normalized_box)
        category = self._classify_category(normalized_label, is_person=is_person, is_dog=is_dog, is_hazard=is_hazard, is_target=is_target)

        return {
            "label": normalized_label,
            "confidence": round(confidence, 4),
            "box": normalized_box,
            "center": center,
            "category": category,
            "is_hazard": is_hazard,
            "is_target": is_target,
        }

    def update_from_candidates(self, detections: list[DetectionCandidate | dict[str, Any]]) -> None:
        classified = [self.classify_detection(detection) for detection in detections]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        hazards = [item for item in classified if item["is_hazard"]]
        targets = [item for item in classified if item["is_target"]]
        people_count = sum(1 for item in classified if item["category"] == "person")
        dog_count = sum(1 for item in classified if item["category"] == "dog")
        with self._lock:
            self._cache.update(
                {
                    "running": self._detector is not None,
                    "last_frame_time": now,
                    "fps": float(self._config.vision_sample_fps),
                    "detections": classified,
                    "people_count": people_count,
                    "dog_count": dog_count,
                    "hazards": hazards,
                    "targets": targets,
                    "message": "Vision monitoring active in monitor-only mode.",
                }
            )

    def _is_hazard_label(self, label: str) -> bool:
        return label in self._hazard_labels

    def _is_in_hazard_zone(self, box: dict[str, float]) -> bool:
        bottom = box["y"] + box["h"]
        center_y = box["y"] + box["h"] / 2
        return bottom >= DEFAULT_HAZARD_ZONE_Y or center_y >= 2.0 / 3.0

    def _classify_category(
        self,
        label: str,
        *,
        is_person: bool,
        is_dog: bool,
        is_hazard: bool,
        is_target: bool,
    ) -> str:
        if is_person:
            return "person"
        if is_dog:
            return "dog"
        if is_hazard:
            return "hazard"
        if is_target:
            return "target"
        if label:
            return "object"
        return "object"