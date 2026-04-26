"""Tests for `scripts/start_controller.sh` runtime config behavior.

These tests run the launcher with `python3 -m server.app` swapped out for a
small probe that prints the resolved environment, so we can assert that:

* a local `.env` file is honoured,
* sensible vision defaults are applied when `.env` does not set them,
* existing values in the calling shell are not clobbered.

The tests do not start the real Flask server.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "start_controller.sh"


def _patched_script(tmp_path: Path) -> Path:
    """Copy start_controller.sh into tmp_path with the venv activate and
    final `exec python3 ...` neutralised so the script just dumps env."""
    text = SCRIPT.read_text()
    # Replace venv activate (path doesn't exist on every CI/dev box) with a
    # no-op, and replace the final exec with a deterministic env probe.
    text = text.replace(
        'source "$venv_activate"',
        ': "$venv_activate"  # patched: skip venv for tests',
    )
    text = text.replace(
        "exec python3 -m server.app",
        'env | grep -E "^TANK_" | sort',
    )
    # Repoint repo_dir at tmp_path so the script reads our throwaway .env.
    text = text.replace(
        'repo_dir="/home/ron/repos/robot_tank_rpi"',
        f'repo_dir="{tmp_path}"',
    )
    patched = tmp_path / "start_controller.sh"
    patched.write_text(text)
    patched.chmod(0o755)
    return patched


def _run(patched: Path, env: dict[str, str] | None = None) -> str:
    base_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    if env:
        base_env.update(env)
    result = subprocess.run(
        ["bash", str(patched)],
        check=True,
        capture_output=True,
        text=True,
        env=base_env,
    )
    return result.stdout


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_start_controller_applies_safe_vision_defaults_without_env(tmp_path):
    """No `.env` present -> vision must default to disabled, with safe
    monitor-only target labels."""
    patched = _patched_script(tmp_path)

    output = _run(patched)

    assert "TANK_VISION_ENABLED=false" in output
    assert "TANK_VISION_MODEL_BACKEND=disabled" in output
    assert "TANK_VISION_TARGET_LABELS=tennis ball,traffic cone,marker" in output
    # People/dogs must not be in the default target labels.
    target_line = next(
        line for line in output.splitlines() if line.startswith("TANK_VISION_TARGET_LABELS=")
    )
    assert "person" not in target_line
    assert "dog" not in target_line


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_start_controller_loads_local_env_file(tmp_path):
    """A local `.env` must override the safe defaults so the systemd unit
    actually picks up the operator-supplied vision config."""
    (tmp_path / ".env").write_text(
        textwrap.dedent(
            """
            TANK_VISION_ENABLED=true
            TANK_VISION_MODEL_BACKEND=opencv_onnx
            TANK_VISION_MODEL_PATH=/srv/models/yolo-nano.onnx
            TANK_VISION_SAMPLE_FPS=3
            """
        ).strip()
        + "\n"
    )
    patched = _patched_script(tmp_path)

    output = _run(patched)

    assert "TANK_VISION_ENABLED=true" in output
    assert "TANK_VISION_MODEL_BACKEND=opencv_onnx" in output
    assert "TANK_VISION_MODEL_PATH=/srv/models/yolo-nano.onnx" in output
    assert "TANK_VISION_SAMPLE_FPS=3" in output
    # Defaults still fill in the keys the .env did not set.
    assert "TANK_VISION_CONFIDENCE=0.45" in output


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_start_controller_respects_caller_env_over_defaults(tmp_path):
    """A value supplied by the calling shell must win over the defaults
    even when no `.env` exists."""
    patched = _patched_script(tmp_path)

    output = _run(
        patched,
        env={
            "TANK_VISION_ENABLED": "true",
            "TANK_VISION_MODEL_BACKEND": "fake",
        },
    )

    assert "TANK_VISION_ENABLED=true" in output
    assert "TANK_VISION_MODEL_BACKEND=fake" in output
