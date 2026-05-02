import { useEffect, useRef, useState } from 'react';

const DEAD_ZONE = 0.18;
const DRIVE_THROTTLE_MS = 100;
const CAMERA_THROTTLE_MS = 90;

// Standard Gamepad API button indices for Xbox / "Standard Gamepad" layout.
const BTN_A  = 0;
const BTN_Y  = 3;
const BTN_LB = 4;
const BTN_RB = 5;

const AXIS_LEFT_X  = 0;
const AXIS_LEFT_Y  = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;

function applyDeadZone(value) {
  return Math.abs(value) > DEAD_ZONE ? value : 0;
}

/**
 * Polls the browser Gamepad API and fires callbacks for Xbox controller input.
 *
 * Callbacks object keys:
 *   onForward, onBackward, onPivotLeft, onPivotRight  — called at DRIVE_THROTTLE_MS while stick is held
 *   onStop      — called when stick returns to neutral, on disconnect, blur, hide, or unmount
 *   onCameraMove(rightX, rightY)  — called at CAMERA_THROTTLE_MS while right stick is moved
 *   onCenterCamera — Y button press
 *   onSpeedDown / onSpeedUp — LB / RB press (edge-triggered, not held)
 *
 * Returns { connected: boolean, name: string | null }
 */
export function useGamepadControls(callbacks) {
  const [gamepadState, setGamepadState] = useState({ connected: false, name: null });

  // Always-fresh callbacks inside RAF without stale closure risk.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const pollRef = useRef({
    gamepadIndex: null,
    driveState: null,        // null | 'forward' | 'backward' | 'pivotLeft' | 'pivotRight'
    lastDriveSentAt: 0,
    lastCameraSentAt: 0,
    prevAPressed:  false,
    prevYPressed:  false,
    prevLbPressed: false,
    prevRbPressed: false,
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

      // ----- Left stick → drive -----
      const leftX = applyDeadZone(gp.axes[AXIS_LEFT_X] ?? 0);
      const leftY = applyDeadZone(gp.axes[AXIS_LEFT_Y] ?? 0);

      let nextDrive = null;
      if (Math.abs(leftX) > Math.abs(leftY)) {
        if (leftX < 0) nextDrive = 'pivotLeft';
        else if (leftX > 0) nextDrive = 'pivotRight';
      } else if (leftY < 0) {
        nextDrive = 'forward';
      } else if (leftY > 0) {
        nextDrive = 'backward';
      }

      if (nextDrive !== state.driveState) {
        // Stick returned to neutral — stop the tank.
        if (state.driveState !== null && nextDrive === null) cb.onStop?.();
        state.driveState      = nextDrive;
        state.lastDriveSentAt = 0; // fire immediately on direction change
      }

      if (nextDrive !== null && now - state.lastDriveSentAt >= DRIVE_THROTTLE_MS) {
        state.lastDriveSentAt = now;
        if      (nextDrive === 'forward')    cb.onForward?.();
        else if (nextDrive === 'backward')   cb.onBackward?.();
        else if (nextDrive === 'pivotLeft')  cb.onPivotLeft?.();
        else if (nextDrive === 'pivotRight') cb.onPivotRight?.();
      }

      // ----- Right stick → camera -----
      const rightX = applyDeadZone(gp.axes[AXIS_RIGHT_X] ?? 0);
      const rightY = applyDeadZone(gp.axes[AXIS_RIGHT_Y] ?? 0);

      if ((rightX !== 0 || rightY !== 0) && now - state.lastCameraSentAt >= CAMERA_THROTTLE_MS) {
        state.lastCameraSentAt = now;
        cb.onCameraMove?.(rightX, rightY);
      }
    }

    function resetPollState(index) {
      const state = pollRef.current;
      state.gamepadIndex    = index;
      state.driveState      = null;
      state.lastDriveSentAt = 0;
      state.lastCameraSentAt = 0;
      state.prevAPressed    = false;
      state.prevYPressed    = false;
      state.prevLbPressed   = false;
      state.prevRbPressed   = false;
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
      pollRef.current.driveState   = null;
      setGamepadState({ connected: false, name: null });
      // Safety: always stop on disconnect regardless of current drive state.
      cbRef.current.onStop?.();
    }

    // Stop the tank when the page loses focus while the controller is connected.
    function onBlur() {
      if (pollRef.current.gamepadIndex === null) return;
      pollRef.current.driveState = null;
      cbRef.current.onStop?.();
    }

    // Stop the tank when the tab becomes hidden (phone switches apps, etc.).
    function onVisibilityChange() {
      if (!document.hidden || pollRef.current.gamepadIndex === null) return;
      pollRef.current.driveState = null;
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
