#!/usr/bin/env /usr/bin/python3
from __future__ import annotations

import json
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

try:
    from picamera2 import Picamera2
except Exception as exc:  # pragma: no cover
    Picamera2 = None
    IMPORT_ERROR = str(exc)
else:
    IMPORT_ERROR = None


class CameraRuntime:
    def __init__(self) -> None:
        self.width = int(os.getenv("TANK_CAMERA_WIDTH", "640"))
        self.height = int(os.getenv("TANK_CAMERA_HEIGHT", "480"))
        self.quality = int(os.getenv("TANK_CAMERA_JPEG_QUALITY", "80"))
        self._camera = None
        self._lock = threading.Lock()
        self._message = "Camera service starting."

    def status(self) -> dict[str, object]:
        available = self._ensure_camera()
        return {
            "available": available,
            "message": self._message,
            "width": self.width,
            "height": self.height,
        }

    def stream_frames(self):
        if not self._ensure_camera():
            raise RuntimeError(self._message)

        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self.quality]
        while True:
            with self._lock:
                frame = self._camera.capture_array()
            frame_bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            ok, encoded = cv2.imencode('.jpg', frame_bgr, encode_params)
            if not ok:
                continue
            yield encoded.tobytes()

    def _ensure_camera(self) -> bool:
        if IMPORT_ERROR is not None:
            self._message = f"picamera2 import failed: {IMPORT_ERROR}"
            return False

        with self._lock:
            if self._camera is not None:
                return True

            camera_info = Picamera2.global_camera_info()
            if not camera_info:
                self._message = "No camera detected by Picamera2."
                return False

            try:
                camera = Picamera2()
                config = camera.create_video_configuration(main={"size": (self.width, self.height), "format": "RGB888"})
                camera.configure(config)
                camera.start()
                time.sleep(0.5)
            except Exception as exc:
                self._message = f"Camera start failed: {exc}"
                return False

            self._camera = camera
            self._message = f"Camera streaming at {self.width}x{self.height}."
            return True


RUNTIME = CameraRuntime()


class CameraHandler(BaseHTTPRequestHandler):
    def _send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/status":
            payload = json.dumps(RUNTIME.status()).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self._send_cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if self.path == "/stream.mjpg":
            status = RUNTIME.status()
            if not status["available"]:
                payload = status["message"].encode("utf-8")
                self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
                self._send_cors()
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            self.send_response(HTTPStatus.OK)
            self._send_cors()
            self.send_header("Age", "0")
            self.send_header("Cache-Control", "no-cache, private")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            try:
                for jpeg in RUNTIME.stream_frames():
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode("utf-8"))
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except BrokenPipeError:
                return
            except ConnectionResetError:
                return
            return

        self.send_response(HTTPStatus.NOT_FOUND)
        self._send_cors()
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        print("camera-stream:", fmt % args)


def main() -> None:
    port = int(os.getenv("TANK_CAMERA_STREAM_PORT", "8081"))
    server = ThreadingHTTPServer(("0.0.0.0", port), CameraHandler)
    print(f"Camera stream service listening on 0.0.0.0:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()