# Future improvements

A backlog of changes that came out of the April 2026 codebase review. Each item
notes the rough scope and the reason it would matter on this Pi-controlled
tank. Items are not ordered by priority — pick what aligns with the next
hardware milestone.

## Reliability and operations

- **Replace the Werkzeug dev server in production.** `python3 -m server.app`
  is launched directly from `robot-tank-rpi.service`. A small WSGI runner
  (`waitress` or `gunicorn` with `--workers 1 --threads 4`) would survive
  bursty fetches from the React polling loops without `app.run()`'s known
  reload/threading caveats.
- **De-hardcode service paths.** `scripts/start_controller.sh` and
  `scripts/robot-tank-rpi.service` both bake in `/home/ron/...`. Move the
  repo path into an `EnvironmentFile=` (e.g. `/etc/default/robot-tank`) so the
  same scripts work for any Pi user/account.
- **Add a `make` or `just` target for the full validation chain** (`ruff`,
  `npm run build`, `npm run test:frontend`, `pytest`). Today the command list
  lives only in the README and in repo memory.
- **Robust startup port-conflict detection.** `detect_port_conflict()` does a
  bind-then-close probe right before `app.run()`; close the TOCTOU window by
  binding the real socket up front and handing it to the WSGI server, or by
  catching the bind error from the runner directly.
- **Structured logging.** Replace the `print(...)` calls in `server/app.py`
  and `scripts/start_camera_stream.py` with `logging` (matching the
  `LOGGER` already used in `vision_service.py`) and tag log lines with the
  unit name so `journalctl -u robot-tank-*` is easier to read.

## Serial / firmware integration

- **Reconnect-on-failure for the serial link.** `SerialService._connection`
  is cleared on errors but only re-opened on the next `_ensure_connection()`
  call. A small backoff/keepalive thread that proactively retries would let
  the cockpit recover from a USB unplug without waiting for the next user
  click.
- **Tighter `_drain_pending_lines` error handling.** The bare `except` in
  `_read_line` silently overwrites `_last_error`; surface USB I/O errors
  through `_classify_runtime_error` so the UI sees the real reason.
- **Optional firmware-version handshake at startup.** Send `STATUS` once
  after the warmup delay and stash `firmware_build` on the service so the
  cockpit can flag firmware/Pi version drift without waiting for the 20s
  poll.
- **Document and test the `MOTOR LEFT/RIGHT` negative-speed path** end to
  end (currently only the HTTP layer is exercised; firmware behavior under
  rapid sign flips is unverified).

## Vision

- **Provide a real detector implementation.** `VisionService` already
  accepts a pluggable `detector`, but no concrete backend ships in-tree.
  An `opencv_onnx` detector that wraps a YOLO-nano `.onnx` would let the
  monitor-only path actually populate the cockpit overlay.
- **Bound the worker's failure log volume.** The `failure_count <= 3 or
  failure_count % 10 == 0` rule is OK, but transient stream hiccups should
  also trigger a backoff (e.g. exponential up to a few seconds) instead of
  re-hitting `Detector.detect` at full `vision_sample_fps`.
- **Hazard-zone heuristic should use a configurable threshold.**
  `DEFAULT_HAZARD_ZONE_Y = 0.6` is hardcoded; expose it via
  `TANK_VISION_HAZARD_ZONE_Y` so different mounts can tune it.
- **Gracefully recover when the detector is missing.** Today the worker
  loop logs a warning and exits; consider re-checking on a slow timer so
  enabling the model on disk doesn't require a service restart.

## Camera streaming

- **Tighten CORS on `start_camera_stream.py`.** The MJPEG handler returns
  `Access-Control-Allow-Origin: *`. For a LAN-only tool that's fine, but
  restricting to the controller origin (or the Tailscale CIDR) would close
  one easy abuse vector if the Pi ever ends up on an untrusted network.
- **Add a `/healthz` to the camera service** that reports `last_frame_age_s`
  so the cockpit can distinguish "service up, hardware stuck" from
  "service down".
- **Make the JPEG quality / sensor mode actually documented.**
  `TANK_CAMERA_JPEG_QUALITY` and `TANK_CAMERA_FRAME_FORMAT` are now in the
  README, but neither has a unit test or a sanity-check on startup.

## Frontend / PWA

- **Cache and refresh `defaultCamera` constants.** The current "is this the
  default message?" check in `cameraLevel(camera)` is brittle string
  matching; a dedicated `state` field on the camera status payload would be
  cleaner.
- **Pause polling when the document is hidden.**
  `useInterval` keeps firing when the PWA is backgrounded; switching to
  `document.visibilityState === 'visible'` gating would save battery and
  reduce serial chatter on tablets.
- **Consolidate fetch error handling.** Each `refresh*` helper in
  `App.jsx` repeats the same try/catch shape. A small `safeJson(url)` helper
  would shrink ~80 lines and make adding new endpoints easier.
- **Service worker versioning.** `CACHE_NAME = 'robot-tank-react-shell-v1'`
  is hand-bumped; tying it to `package.json` `version` (injected via Vite
  `define`) avoids stale-cache regressions after a UI rebuild.
- **Accessibility pass.** The drive pad uses `<button>` correctly, but the
  status pills and detail cards have no ARIA roles; a screen reader can't
  announce serial-blocked or vision-active states.

## Testing

- **Camera service smoke test.** `start_camera_stream.py` is uncovered.
  A minimal test that boots `CameraHandler` against a fake `RUNTIME` and
  verifies the `/status` JSON shape would catch route regressions without
  needing real picamera2.
- **Backend integration test for `POST /api/command` -> `STOP`.** Today
  the stop verb is only validated implicitly via the React drive-hold tests;
  a server-side regression that broke `STOP` would slip through.
- **Property-style tests for `parse_status_response`.** The current tests
  cover the happy path and "PONG" rejection; randomized field ordering and
  unknown extra keys would lock in the tolerant-parser contract.
- **End-to-end smoke via `flask test_client` + a fake serial connection**
  that exercises the full Pi -> firmware round trip for at least one drive,
  one camera, and one motor command. Today each layer is mocked separately.

## Security and hardening

- **Authentication / pairing for the Flask endpoints.** Right now anyone on
  the LAN (or Tailnet) can `POST /api/command`. Even a shared token in a
  `TANK_API_TOKEN` header would prevent accidental cross-device commands.
- **Rate-limit `POST /api/command`.** The drive-hold loop already throttles
  client-side, but a misbehaving client could still flood the serial link.
- **Validate `TANK_VISION_SOURCE_URL`.** A future detector that fetches the
  configured URL should refuse non-loopback / non-LAN hosts to avoid SSRF.

## Documentation

- **Add a one-page architecture diagram** (Pi services, serial link, Uno
  firmware, camera streams, browser PWA) to `docs/`. Useful for onboarding
  and for keeping the README from sprawling further.
- **Document the firmware contract in `serial/README.md`.** The exact
  `STATUS`, `SENSORS`, and error-line shapes the Pi parses live only in
  `server/serial_service.py` today.
