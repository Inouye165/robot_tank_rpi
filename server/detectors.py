"""Detector abstractions for the monitor-only vision scaffold.

Two layers live here:

1. :class:`Detector` — the legacy adapter used by the original scaffold. It
   accepts ``source_url`` and was responsible for reading the MJPEG stream
   itself. This is kept for backwards compatibility with existing tests.
   The new code path prefers the future-ready :class:`FrameDetector`.
2. :class:`FrameDetector` — accepts an already-decoded frame and returns
   normalized detection candidates. Real backends (such as
   :class:`OpenCvOnnxDetector`) implement this interface; the
   :class:`MjpegFrameReader` owns the stream and feeds the frames in.

Detectors must NEVER send drive commands. This phase remains monitor-only.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Iterable, Optional, Protocol, Sequence, runtime_checkable

LOGGER = logging.getLogger(__name__)


@runtime_checkable
class Detector(Protocol):
    """Legacy detector interface used by the original worker loop.

    The current ``detect(source_url=...)`` shape is TEMPORARY. New backends
    should also implement :class:`FrameDetector` so the MJPEG stream can be
    owned by a single frame reader instead of being reopened every loop.
    See ``server/frame_reader.py`` and ``docs/FUTURE_IMPROVEMENTS.md``.
    """

    def detect(
        self,
        *,
        source_url: str,
        confidence: float,
        frame_width: int,
    ) -> Iterable[dict[str, Any]]:
        ...


@runtime_checkable
class FrameDetector(Protocol):
    """Future-ready detector that consumes already-decoded frames."""

    @property
    def model_loaded(self) -> bool:
        ...

    def detect_frame(
        self,
        frame: Any,
        *,
        confidence: float,
    ) -> list[dict[str, Any]]:
        ...


class FakeDetector:
    """Deterministic detector for tests.

    Implements both the legacy :class:`Detector` shape and the future-ready
    :class:`FrameDetector` shape so it can stand in for either path.
    """

    def __init__(self, candidates: Iterable[dict[str, Any]] | None = None) -> None:
        self._candidates: list[dict[str, Any]] = list(candidates or [])
        self.call_count = 0
        self.frame_call_count = 0
        self.last_kwargs: dict[str, Any] | None = None
        self.last_frame: Any = None

    # Legacy Detector path -----------------------------------------------------
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
        return [dict(item) for item in self._candidates]

    # FrameDetector path -------------------------------------------------------
    @property
    def model_loaded(self) -> bool:
        return True

    def detect_frame(
        self,
        frame: Any,
        *,
        confidence: float,
    ) -> list[dict[str, Any]]:
        self.frame_call_count += 1
        self.last_frame = frame
        return [dict(item) for item in self._candidates]


# COCO 80 class names. Index matches the standard YOLO/COCO order so any
# COCO-trained ONNX YOLO model can use them directly.
COCO_CLASSES: tuple[str, ...] = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon",
    "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
    "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
    "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
)


class OpenCvOnnxDetector:
    """Optional OpenCV/ONNX YOLO detector.

    The detector lazy-loads OpenCV and the ONNX model so the rest of the
    cockpit keeps working when:

    * OpenCV is not installed (``opencv-python-headless`` is optional)
    * The configured model file does not exist
    * The model fails to load for any other reason

    In all of those cases :attr:`model_loaded` stays ``False`` and
    :meth:`detect_frame` returns an empty list. The vision status surface
    then reports ``"model missing"`` instead of crashing.

    Output detections are in the existing normalized shape used by the rest
    of the pipeline::

        {
            "label": "person",                          # lowercase, COCO class
            "confidence": 0.87,                         # 0..1
            "box": {"x": 0.12, "y": 0.20, "w": 0.25, "h": 0.50},  # normalized
        }
    """

    def __init__(
        self,
        model_path: str,
        *,
        class_names: Sequence[str] = COCO_CLASSES,
        input_size: int = 640,
        nms_iou_threshold: float = 0.45,
    ) -> None:
        self._model_path = model_path
        self._class_names = tuple(name.strip().lower() for name in class_names)
        self._input_size = int(input_size)
        self._nms_iou_threshold = float(nms_iou_threshold)
        self._net: Any = None
        self._cv2: Any = None
        self._np: Any = None
        self._load_error: Optional[str] = None
        self._load()

    # Public API ---------------------------------------------------------------
    @property
    def model_loaded(self) -> bool:
        return self._net is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    @property
    def model_path(self) -> str:
        return self._model_path

    def detect_frame(
        self,
        frame: Any,
        *,
        confidence: float,
    ) -> list[dict[str, Any]]:
        if self._net is None or frame is None:
            return []
        cv2 = self._cv2
        np = self._np
        try:
            height, width = frame.shape[:2]
        except Exception:  # pragma: no cover - defensive
            return []
        if height <= 0 or width <= 0:
            return []

        blob = cv2.dnn.blobFromImage(
            frame,
            scalefactor=1.0 / 255.0,
            size=(self._input_size, self._input_size),
            swapRB=True,
            crop=False,
        )
        self._net.setInput(blob)
        try:
            outputs = self._net.forward()
        except Exception as exc:  # pragma: no cover - runtime failure
            LOGGER.warning("ONNX forward pass failed: %s", exc)
            return []

        return self._postprocess(
            outputs,
            frame_width=width,
            frame_height=height,
            confidence_threshold=confidence,
            np=np,
            cv2=cv2,
        )

    # Legacy Detector path (kept so adapters do not break) --------------------
    def detect(
        self,
        *,
        source_url: str,
        confidence: float,
        frame_width: int,
    ) -> list[dict[str, Any]]:  # pragma: no cover - legacy compat shim
        # The new VisionService uses detect_frame via a frame reader. This
        # legacy entry point is intentionally a no-op so misconfiguration
        # does not crash the cockpit.
        del source_url, confidence, frame_width
        return []

    # Internals ----------------------------------------------------------------
    def _load(self) -> None:
        if not self._model_path:
            self._load_error = "model path not configured"
            return
        if not os.path.exists(self._model_path):
            self._load_error = f"model file missing: {self._model_path}"
            LOGGER.warning(self._load_error)
            return
        try:
            import cv2  # type: ignore
            import numpy as np  # type: ignore
        except Exception as exc:
            self._load_error = f"opencv/numpy not installed: {exc}"
            LOGGER.warning(self._load_error)
            return
        try:
            net = cv2.dnn.readNetFromONNX(self._model_path)
        except Exception as exc:  # pragma: no cover - depends on real model
            self._load_error = f"failed to load ONNX model: {exc}"
            LOGGER.warning(self._load_error)
            return
        self._cv2 = cv2
        self._np = np
        self._net = net

    def _postprocess(
        self,
        outputs: Any,
        *,
        frame_width: int,
        frame_height: int,
        confidence_threshold: float,
        np: Any,
        cv2: Any,
    ) -> list[dict[str, Any]]:
        # Normalize the output tensor to shape (N, 4 + num_classes [+1]) where
        # the first 4 columns are cx, cy, w, h in input-image pixels. Handles
        # both YOLOv5 (N, 85) and YOLOv8 (1, 84, N) layouts.
        arr = np.array(outputs)
        if arr.ndim == 3:
            arr = np.squeeze(arr, axis=0)
        if arr.ndim != 2:
            return []
        num_classes = len(self._class_names)
        if arr.shape[0] in (num_classes + 4, num_classes + 5) and arr.shape[1] != arr.shape[0]:
            arr = arr.T

        boxes: list[list[float]] = []
        confidences: list[float] = []
        class_ids: list[int] = []

        x_scale = frame_width / float(self._input_size)
        y_scale = frame_height / float(self._input_size)

        for row in arr:
            if row.shape[0] == num_classes + 5:
                obj_conf = float(row[4])
                class_scores = row[5:]
            elif row.shape[0] == num_classes + 4:
                obj_conf = 1.0
                class_scores = row[4:]
            else:
                continue
            class_id = int(np.argmax(class_scores))
            score = float(class_scores[class_id]) * obj_conf
            if score < confidence_threshold:
                continue
            cx, cy, w, h = (
                float(row[0]),
                float(row[1]),
                float(row[2]),
                float(row[3]),
            )
            x = (cx - w / 2.0) * x_scale
            y = (cy - h / 2.0) * y_scale
            bw = w * x_scale
            bh = h * y_scale
            boxes.append([x, y, bw, bh])
            confidences.append(score)
            class_ids.append(class_id)

        if not boxes:
            return []

        keep = cv2.dnn.NMSBoxes(
            boxes, confidences, confidence_threshold, self._nms_iou_threshold
        )
        if keep is None or len(keep) == 0:
            return []
        try:
            indices = [int(i) for i in np.array(keep).flatten()]
        except Exception:  # pragma: no cover - defensive
            indices = list(keep)

        results: list[dict[str, Any]] = []
        fw = float(frame_width)
        fh = float(frame_height)
        for idx in indices:
            x, y, bw, bh = boxes[idx]
            cls = class_ids[idx]
            label = self._class_names[cls] if 0 <= cls < num_classes else "object"
            results.append(
                {
                    "label": label,
                    "confidence": round(float(confidences[idx]), 4),
                    "box": {
                        "x": max(0.0, min(1.0, x / fw)),
                        "y": max(0.0, min(1.0, y / fh)),
                        "w": max(0.0, min(1.0, bw / fw)),
                        "h": max(0.0, min(1.0, bh / fh)),
                    },
                }
            )
        return results
