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
    def __init__(
        self,
        config: Config,
        detector: Any | None = None,
        frame_reader: Any | None = None,
    ) -> None:
        self._config = config
        self._detector = detector
        self._frame_reader = frame_reader
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
            "backend": model_backend,
            # `model_backend` is preserved for backwards compatibility with
            # existing clients/tests; `backend` is the future-ready alias.
            "model_backend": model_backend,
            "model_path": model_path,
            "model_loaded": self._detector_model_loaded(),
            "source_url": self._source_url,
            "stream_connected": self._frame_reader.connected if self._frame_reader is not None else False,
            "last_frame_time": None,
            "last_detection_time": None,
            "fps": 0.0,
            "detections": [],
            "detections_count": 0,
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
        if model_backend == "fake":
            return (
                "Vision running in FAKE/TEST mode (manual UI verification only). "
                "Detections are synthetic. No drive commands will ever be sent."
            )
        if not model_path:
            return "Vision monitoring enabled, but no model path is configured."
        if not self._detector_model_loaded():
            return "Vision monitoring enabled, but the model could not be loaded (model missing or OpenCV unavailable)."
        return "Vision monitoring ready."

    @property
    def frame_reader(self) -> Any | None:
        """Expose the internal frame reader so the tracking service can share it."""
        return self._frame_reader

    def _detector_model_loaded(self) -> bool:
        if self._detector is None:
            return False
        return bool(getattr(self._detector, "model_loaded", True))

    def _start_if_configured(self) -> None:
        if not self._config.vision_enabled:
            return
        backend = self._config.vision_model_backend or "disabled"
        if backend == "disabled":
            return
        # The fake backend is allowed to run without a model file because
        # it only emits synthetic detections for manual UI verification.
        if backend != "fake" and not self._config.vision_model_path:
            return

        # Auto-construct the OpenCV ONNX detector + MJPEG frame reader when
        # the operator selected the opencv_onnx backend and did not pass
        # explicit collaborators. This keeps tests free to inject fakes.
        if self._detector is None and backend == "opencv_onnx":
            try:
                from .detectors import OpenCvOnnxDetector

                self._detector = OpenCvOnnxDetector(
                    self._config.vision_model_path,
                    input_size=self._config.vision_frame_width,
                )
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning("Failed to construct OpenCvOnnxDetector: %s", exc)
                self._detector = None

        # Auto-construct a FakeDetector when the operator selected the
        # fake/test backend. The synthetic detections only exist so the
        # cockpit UI can be verified without a real model. This backend
        # never sends drive commands and is clearly labelled in the
        # status message.
        if self._detector is None and backend == "fake":
            from .detectors import FakeDetector

            self._detector = FakeDetector(
                candidates=[
                    {
                        "label": "tennis ball",
                        "confidence": 0.82,
                        "box": {"x": 0.45, "y": 0.55, "w": 0.08, "h": 0.08},
                    },
                    {
                        "label": "traffic cone",
                        "confidence": 0.74,
                        "box": {"x": 0.20, "y": 0.60, "w": 0.10, "h": 0.18},
                    },
                ]
            )

        if self._frame_reader is None and self._detector is not None and backend == "opencv_onnx":
            try:
                from .frame_reader import MjpegFrameReader

                self._frame_reader = MjpegFrameReader(self._source_url)
                self._frame_reader.start()
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning("Failed to construct MjpegFrameReader: %s", exc)
                self._frame_reader = None

        # Refresh the initial status fields now that collaborators may exist.
        with self._lock:
            self._cache["model_loaded"] = self._detector_model_loaded()
            self._cache["stream_connected"] = (
                self._frame_reader.connected if self._frame_reader is not None else False
            )
            self._cache["message"] = self._status_message(
                enabled=self._config.vision_enabled,
                model_backend=self._config.vision_model_backend or "disabled",
                model_path=self._config.vision_model_path or None,
            )

        self._worker = Thread(target=self._worker_loop, name="tank-vision", daemon=True)
        self._worker.start()

    def _worker_loop(self) -> None:  # pragma: no cover - exercised via integration
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
                raw_detections = self._detect_once()
                self.update_from_candidates(raw_detections)
                failure_count = 0
            except Exception as exc:
                failure_count += 1
                if failure_count <= 3 or failure_count % 10 == 0:
                    LOGGER.warning("Vision worker iteration failed: %s", exc)
                with self._lock:
                    self._cache["stream_connected"] = (
                        self._frame_reader.connected if self._frame_reader is not None else False
                    )
                    self._cache["message"] = f"Vision pipeline error: {exc}"

            self._stop_event.wait(sample_interval)

    def _detect_once(self) -> list[dict[str, Any]]:
        """Run one detection pass.

        Prefers the future-ready frame-reader + ``detect_frame`` path. Falls
        back to the legacy ``detect(source_url=...)`` shape for older
        adapters that have not been migrated yet.
        """
        if self._frame_reader is not None and hasattr(self._detector, "detect_frame"):
            frame, frame_time = self._frame_reader.latest_frame()
            with self._lock:
                self._cache["stream_connected"] = self._frame_reader.connected
                if frame_time is not None:
                    self._cache["last_frame_time"] = time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    )
            if frame is None:
                return []
            return list(
                self._detector.detect_frame(
                    frame, confidence=self._config.vision_confidence
                )
            )
        # Legacy adapter path (kept for backwards compatibility).
        return list(
            self._detector.detect(
                source_url=self._source_url,
                confidence=self._config.vision_confidence,
                frame_width=self._config.vision_frame_width,
            )
        )

    def stop(self) -> None:
        self._stop_event.set()
        if self._worker is not None:
            self._worker.join(timeout=1.0)
        if self._frame_reader is not None:
            try:
                self._frame_reader.stop()
            except Exception:  # pragma: no cover - defensive
                pass

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
        backend = self._config.vision_model_backend or "disabled"
        if backend == "fake":
            active_message = (
                "Vision running in FAKE/TEST mode (synthetic detections). "
                "No drive commands will ever be sent."
            )
        else:
            active_message = "Vision monitoring active in monitor-only mode."
        with self._lock:
            # Always update liveness / connectivity fields.
            self._cache.update(
                {
                    "running": self._detector is not None,
                    "model_loaded": self._detector_model_loaded(),
                    "stream_connected": (
                        self._frame_reader.connected if self._frame_reader is not None else False
                    ),
                    "last_frame_time": now,
                    "fps": float(self._config.vision_sample_fps),
                    "message": active_message,
                }
            )
            # Only replace detection results when this frame actually found something.
            # This keeps the last-known detections alive between sparse YOLO frames so
            # that the tracking loop has a stable target to follow.
            if classified:
                hazards = [item for item in classified if item["is_hazard"]]
                targets = [item for item in classified if item["is_target"]]
                people_count = sum(1 for item in classified if item["category"] == "person")
                dog_count = sum(1 for item in classified if item["category"] == "dog")
                self._cache.update(
                    {
                        "last_detection_time": now,
                        "detections": classified,
                        "detections_count": len(classified),
                        "people_count": people_count,
                        "dog_count": dog_count,
                        "hazards": hazards,
                        "targets": targets,
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