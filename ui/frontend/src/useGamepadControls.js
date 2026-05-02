import { useEffect, useRef, useState } from 'react';

// ---- Tuning constants (easy to adjust here) --------------------------------
const GAMEPAD_DEAD_ZONE          = 0.18;
const DRIVE_MIN_SPEED            = 20;   // % of max speed once outside dead zone
const DRIVE_MAX_SPEED            = 255;  // absolute motor speed units (0–255)
const DRIVE_COMMAND_INTERVAL_MS  = 100;
const CAMERA_MIN_STEP            = 1;    // degrees per interval at minimum stick
const CAMERA_MAX_STEP            = 8;    // degrees per interval at full stick
const CAMERA_COMMAND_INTERVAL_MS = 90;
export const DRIVE_PULSE_MS      = 120;  // duration_ms sent to the firmware

// Standard Gamepad API button indices for Xbox / "Standard Gamepad" layout.
const BTN_A  = 0;
const BTN_Y  = 3;
const BTN_LB = 4;
const BTN_RB = 5;

const AXIS_LEFT_X  = 0;
const AXIS_LEFT_Y  = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;

// ---- Helper math -----------------------------------------------------------

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Zero the axis inside the dead zone; return the raw value outside.
 */
export function applyDeadZone(value, deadZone = GAMEPAD_DEAD_ZONE) {
  return Math.abs(value) > deadZone ? value : 0;
}

/**
 * Remap a raw axis value (already past dead zone) to a 0–1 normalised range,
 * then apply a quadratic curve to make the low end easier to control.
 */
export function curveAxis(raw, deadZone = GAMEPAD_DEAD_ZONE) {
  const normalized = clamp((Math.abs(raw) - deadZone) / (1 - deadZone), 0, 1);
  return normalized * normalized; // quadratic: fine control at low end
}

/**
 * Map an axis value with dead zone + curve to a signed motor speed integer.
 */
export function axisToSpeed(raw, minSpeed = DRIVE_MIN_SPEED, maxSpeed = DRIVE_MAX_SPEED) {
  const curved = curveAxis(raw);
  if (curved === 0) return 0;
  const speed = Math.round(minSpeed + curved * (maxSpeed - minSpeed));
  return raw < 0 ? -speed : speed;
}

/**
 * Map an axis value to a camera step size in degrees (signed).
 */
export function axisToCameraStep(raw) {
  const curved = curveAxis(raw);
  if (curved === 0) return 0;
  const step = CAMERA_MIN_STEP + curved * (CAMERA_MAX_STEP - CAMERA_MIN_STEP);
  return raw < 0 ? -step : step;
}

/**
 * Classic tank-drive mixing: forward/back on Y, steer on X.
 * Returns { left, right } motor speeds clamped to ±DRIVE_MAX_SPEED.
 */
export function mixTankDrive(rawX, rawY) {
  const fwd  = axisToSpeed(-rawY); // invert Y so stick-up = positive forward
  const turn = axisToSpeed(rawX);
  return {
    left:  clamp(fwd + turn, -DRIVE_MAX_SPEED, DRIVE_MAX_SPEED),
    right: clamp(fwd - turn, -DRIVE_MAX_SPEED, DRIVE_MAX_SPEED),
  };
}

export { GAMEPAD_DEAD_ZONE, DRIVE_MIN_SPEED, DRIVE_MAX_SPEED, CAMERA_MIN_STEP, CAMERA_MAX_STEP };

/**
 * Polls the browser Gamepad API and fires callbacks for Xbox controller input.
 *
 * Callbacks:
 *   onDrive({ left, right })        — per DRIVE_COMMAND_INTERVAL_MS while stick is active;
 *                                     left/right are signed speeds in [-255, 255]
 *   onStop()                        — stick neutral, disconnect, blur, hidden, unmount
 *   onCameraMove(panStep, tiltStep) — per CAMERA_COMMAND_INTERVAL_MS; values in degrees
 *   onCenterCamera()                — Y button press (edge-triggered)
 *   onSpeedDown() / onSpeedUp()     — LB / RB press (edge-triggered)
 *
 * Returns { connected: boolean, name: string | null }
 */
export function useGamepadControls(callbacks) {
  const [gamepadState, setGamepadState] = useState({ connected: false, name: null });

  // Wrap callbacks in a ref so the RAF poll always calls the latest version.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const pollRef = useRef({
    gamepadIndex:      null,
    driveActive:       false, // true while any drive output is non-zero
    lastDriveSentAt:   0,
    lastCameraSentAt:  0,
    prevAPressed:      false,
    prevYPressed:      false,
    prevLbPressed:     false,
    prevRbPressed:     false,
  });

  useEffect(() => {
    let rafId = null;

    function poll() {
      const gamepads = typeof navigator.getGamepads === 'function'
        ? navigator.getGamepads()
        : [];
      const gp = pollRef.current.gamepadIndex !== null
        ? gamepads[pollRef.current.gamepadIndex]
        : null;

      // Re-schedule before early return so the loop survives a momentary gap.
      rafId = requestAnimationFrame(poll);

      if (!gp || !gp.connected) return;

      const now   = Date.now();
      const state = pollRef.current;
      const cb    = cbRef.current;

      // ----- Button edge detection -----
      const aPressed  = Boolean(gp.buttons[BTN_A]?.pressed);
      const yPressed  = Boolean(gp.buttons[BTN_Y]?.pressed);
      const lbPressed = Boolean(gp.buttons[BTN_LB]?.pressed);
      const rbPressed = Boolean(gp.buttons[BTN_RB]?.pressed);

      if (aPressed  && !state.prevAPressed)  cb.onStop?.();
      if (yPressed  && !state.prevYPressed)  cb.onCenterCamera?.();
      if (lbPressed && !state.prevLbPressed) cb.onSpeedDown?.();
      if (rbPressed && !state.prevRbPressed) cb.onSpeedUp?.();

      state.prevAPressed  = aPressed;
      state.prevYPressed  = yPressed;
      state.prevLbPressed = lbPressed;
      state.prevRbPressed = rbPressed;

      // ----- Left stick → analog tank drive -----
      const rawX = applyDeadZone(gp.axes[AXIS_LEFT_X] ?? 0);
      const rawY = applyDeadZone(gp.axes[AXIS_LEFT_Y] ?? 0);
      const stickActive = rawX !== 0 || rawY !== 0;

      if (!stickActive) {
        // Send stop once when stick first returns to neutral.
        if (state.driveActive) {
          state.driveActive     = false;
          state.lastDriveSentAt = 0;
          cb.onStop?.();
        }
      } else {
        state.driveActive = true;
        if (now - state.lastDriveSentAt >= DRIVE_COMMAND_INTERVAL_MS) {
          state.lastDriveSentAt = now;
          cb.onDrive?.(mixTankDrive(rawX, rawY));
        }
      }

      // ----- Right stick → analog camera pan/tilt -----
      const rightX = applyDeadZone(gp.axes[AXIS_RIGHT_X] ?? 0);
      const rightY = applyDeadZone(gp.axes[AXIS_RIGHT_Y] ?? 0);

      if ((rightX !== 0 || rightY !== 0) && now - state.lastCameraSentAt >= CAMERA_COMMAND_INTERVAL_MS) {
        state.lastCameraSentAt = now;
        cb.onCameraMove?.(axisToCameraStep(rightX), axisToCameraStep(rightY));
      }
    }

    function resetPollState(index) {
      const state = pollRef.current;
      state.gamepadIndex     = index;
      state.driveActive      = false;
      state.lastDriveSentAt  = 0;
      state.lastCameraSentAt = 0;
      state.prevAPressed     = false;
      state.prevYPressed     = false;
      state.prevLbPressed    = false;
      state.prevRbPressed    = false;
    }

    function onConnected(event) {
      const gp = event.gamepad;
      resetPollState(gp.index);
      setGamepadState({ connected: true, name: gp.id ?? null });
      if (rafId === null) rafId = requestAnimationFrame(poll);
    }

    function onDisconnected(event) {
      if (event.gamepad.index !== pollRef.current.gamepadIndex) return;
      pollRef.current.gamepadIndex = null;
      pollRef.current.driveActive  = false;
      setGamepadState({ connected: false, name: null });
      // Safety: always stop on disconnect regardless of current drive state.
      cbRef.current.onStop?.();
    }

    // Stop the tank when the page loses focus while the controller is connected.
    function onBlur() {
      if (pollRef.current.gamepadIndex === null) return;
      pollRef.current.driveActive = false;
      cbRef.current.onStop?.();
    }

    // Stop the tank when the tab becomes hidden (phone switches apps, etc.).
    function onVisibilityChange() {
      if (!document.hidden || pollRef.current.gamepadIndex === null) return;
      pollRef.current.driveActive = false;
      cbRef.current.onStop?.();
    }

    window.addEventListener('gamepadconnected',    onConnected);
    window.addEventListener('gamepaddisconnected', onDisconnected);
    window.addEventListener('blur',                onBlur);
    document.addEventListener('visibilitychange',  onVisibilityChange);

    // Some browsers expose an already-connected gamepad on first getGamepads() call.
    const existing = typeof navigator.getGamepads === 'function'
      ? [...navigator.getGamepads()].find(Boolean)
      : null;
    if (existing) {
      resetPollState(existing.index);
      setGamepadState({ connected: true, name: existing.id ?? null });
      rafId = requestAnimationFrame(poll);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('gamepadconnected',    onConnected);
      window.removeEventListener('gamepaddisconnected', onDisconnected);
      window.removeEventListener('blur',                onBlur);
      document.removeEventListener('visibilitychange',  onVisibilityChange);
      // Safety: stop on unmount so the tank halts if the page closes mid-drive.
      cbRef.current.onStop?.();
    };
  }, []);

  return gamepadState;
}
