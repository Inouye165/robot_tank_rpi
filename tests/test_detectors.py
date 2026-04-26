"""Tests for the optional OpenCvOnnxDetector and the FakeFrameReader.

These tests must remain green even when OpenCV is not installed and even
when no real ONNX model is available on disk. The detector and the frame
reader are designed to fail gracefully so the rest of the cockpit keeps
working.
"""

from __future__ import annotations

import importlib.util

import pytest

from server.detectors import (
    COCO_CLASSES,
    Detector,
    FakeDetector,
    FrameDetector,
    OpenCvOnnxDetector,
)
from server.frame_reader import FakeFrameReader, FrameReader, MjpegFrameReader

OPENCV_AVAILABLE = importlib.util.find_spec("cv2") is not None
NUMPY_AVAILABLE = importlib.util.find_spec("numpy") is not None


def test_opencv_onnx_detector_imports_cleanly():
    """The class must be importable even when OpenCV is missing."""
    assert OpenCvOnnxDetector is not None


def test_opencv_onnx_detector_handles_missing_path(tmp_path):
    detector = OpenCvOnnxDetector("")
    assert detector.model_loaded is False
    assert detector.load_error is not None
    # Calling detect_frame must not crash even without a frame.
    assert detector.detect_frame(None, confidence=0.5) == []


def test_opencv_onnx_detector_handles_missing_file(tmp_path):
    missing = tmp_path / "no-such-model.onnx"
    detector = OpenCvOnnxDetector(str(missing))
    assert detector.model_loaded is False
    assert "missing" in (detector.load_error or "")
    assert detector.detect_frame(object(), confidence=0.5) == []


def test_opencv_onnx_detector_returns_empty_when_not_loaded():
    """Even with a frame-shaped object, an unloaded detector returns []."""
    class _FakeFrame:
        shape = (480, 640, 3)

    detector = OpenCvOnnxDetector("/definitely/missing.onnx")
    assert detector.detect_frame(_FakeFrame(), confidence=0.3) == []


def test_coco_classes_are_lowercase_and_include_expected_labels():
    assert "person" in COCO_CLASSES
    assert "dog" in COCO_CLASSES
    assert "sports ball" in COCO_CLASSES
    assert all(name == name.lower() for name in COCO_CLASSES)


def test_fake_detector_implements_both_protocols():
    fake = FakeDetector()
    assert isinstance(fake, Detector)
    assert isinstance(fake, FrameDetector)


def test_fake_frame_reader_implements_protocol():
    reader = FakeFrameReader()
    assert isinstance(reader, FrameReader)


def test_fake_frame_reader_lifecycle_and_state():
    reader = FakeFrameReader()
    assert reader.connected is True
    frame, ts = reader.latest_frame()
    assert frame is None and ts is None

    reader.push_frame("frame-payload")
    frame, ts = reader.latest_frame()
    assert frame == "frame-payload"
    assert ts is not None

    reader.set_connected(False)
    assert reader.connected is False

    reader.start()
    reader.start()
    reader.stop()
    assert reader.start_calls == 2
    assert reader.stop_calls == 1


def test_mjpeg_frame_reader_handles_missing_opencv_or_unreachable_stream():
    """Starting against an unreachable URL must never raise.

    The reader either reports `connected=False` immediately because cv2 is
    missing, or attempts a background connection that fails quietly. In
    both cases `latest_frame()` must return (None, None) so the rest of
    the pipeline degrades cleanly.
    """
    reader = MjpegFrameReader("http://127.0.0.1:0/stream.mjpg")
    try:
        reader.start()
    finally:
        reader.stop()
    frame, ts = reader.latest_frame()
    assert frame is None
    assert ts is None
    assert reader.connected is False


@pytest.mark.skipif(
    not (OPENCV_AVAILABLE and NUMPY_AVAILABLE),
    reason="OpenCV/NumPy not installed; ONNX postprocess test only runs when available",
)
def test_opencv_onnx_postprocess_is_smoke_callable(tmp_path):
    """Smoke-test the postprocess path with a synthetic YOLOv8-shaped tensor.

    We do not load a real model; we construct a detector against a missing
    path so model_loaded is False, then directly exercise the internal
    post-processing helper to make sure it does not raise on a well-shaped
    output. This protects the parsing logic from regressions without
    requiring a model file in CI.
    """
    import numpy as np  # type: ignore

    detector = OpenCvOnnxDetector("/definitely/missing.onnx", input_size=640)
    # Need cv2 to call NMSBoxes; skip if NMS is unavailable.
    try:
        import cv2  # type: ignore  # noqa: F401
    except Exception:
        pytest.skip("cv2 missing")

    # Synthetic YOLOv8 output: shape (1, 84, N).
    rng = np.random.default_rng(0)
    fake_output = rng.random((1, 84, 25), dtype=np.float32) * 0.05
    # Plant one strong detection: class index 0 (person) with high score.
    fake_output[0, 0, 0] = 320.0  # cx
    fake_output[0, 1, 0] = 240.0  # cy
    fake_output[0, 2, 0] = 64.0   # w
    fake_output[0, 3, 0] = 96.0   # h
    fake_output[0, 4, 0] = 0.9    # person score

    result = detector._postprocess(  # noqa: SLF001 - internal smoke test
        fake_output,
        frame_width=640,
        frame_height=480,
        confidence_threshold=0.5,
        np=np,
        cv2=__import__("cv2"),
    )
    assert isinstance(result, list)
    if result:
        assert result[0]["label"] == "person"
        assert 0.0 <= result[0]["box"]["x"] <= 1.0
        assert 0.0 <= result[0]["box"]["w"] <= 1.0
