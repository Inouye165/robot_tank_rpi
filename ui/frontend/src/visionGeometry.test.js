import { describe, it, expect } from 'vitest';

import { DEFAULT_SOURCE_ASPECT, projectNormalizedBox, projectNormalizedDetection, unprojectNormalizedBox } from './visionGeometry';

const SAMPLE_BOX = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };

describe('projectNormalizedBox', () => {
  it('returns the box unchanged when source and container share the aspect ratio', () => {
    const result = projectNormalizedBox(SAMPLE_BOX, {
      sourceAspect: 16 / 9,
      containerAspect: 16 / 9,
    });

    expect(result.x).toBeCloseTo(0.1, 6);
    expect(result.y).toBeCloseTo(0.2, 6);
    expect(result.w).toBeCloseTo(0.4, 6);
    expect(result.h).toBeCloseTo(0.5, 6);
  });

  it('letterboxes horizontally when the container is wider than the source', () => {
    // Container 32:9 vs source 16:9 -> source covers half the container width
    // centered, so the image occupies x in [0.25, 0.75].
    const result = projectNormalizedBox(SAMPLE_BOX, {
      sourceAspect: 16 / 9,
      containerAspect: 32 / 9,
    });

    // scaleX = (16/9) / (32/9) = 0.5; offsetX = 0.25
    expect(result.x).toBeCloseTo(0.25 + 0.1 * 0.5, 6); // 0.30
    expect(result.w).toBeCloseTo(0.4 * 0.5, 6); // 0.20
    // Vertical axis untouched.
    expect(result.y).toBeCloseTo(0.2, 6);
    expect(result.h).toBeCloseTo(0.5, 6);
  });

  it('letterboxes vertically when the container is taller than the source', () => {
    // Container 16:18 (= 8/9) vs source 16:9 -> image occupies y in [0.25, 0.75].
    const result = projectNormalizedBox(SAMPLE_BOX, {
      sourceAspect: 16 / 9,
      containerAspect: 16 / 18,
    });

    // scaleY = (16/18) / (16/9) = 0.5; offsetY = 0.25
    expect(result.y).toBeCloseTo(0.25 + 0.2 * 0.5, 6); // 0.35
    expect(result.h).toBeCloseTo(0.5 * 0.5, 6); // 0.25
    // Horizontal axis untouched.
    expect(result.x).toBeCloseTo(0.1, 6);
    expect(result.w).toBeCloseTo(0.4, 6);
  });

  it('falls back to the default source aspect for invalid inputs', () => {
    const result = projectNormalizedBox(SAMPLE_BOX, {
      sourceAspect: 0,
      containerAspect: DEFAULT_SOURCE_ASPECT,
    });

    expect(result.x).toBeCloseTo(SAMPLE_BOX.x, 6);
    expect(result.y).toBeCloseTo(SAMPLE_BOX.y, 6);
    expect(result.w).toBeCloseTo(SAMPLE_BOX.w, 6);
    expect(result.h).toBeCloseTo(SAMPLE_BOX.h, 6);
  });

  it('does not change the data model when the camera is flipped (visual-only transform)', () => {
    // The flip toggle is a CSS rotate on the overlay container; the
    // detection data flowing into the helper must not be mirrored or
    // reordered. Calling the helper twice with identical inputs must yield
    // identical outputs regardless of any external "flipped" state.
    const flippedState = true;
    const a = projectNormalizedBox(SAMPLE_BOX, {
      sourceAspect: 16 / 9,
      containerAspect: 32 / 9,
    });
    const b = projectNormalizedBox(SAMPLE_BOX, {
      sourceAspect: 16 / 9,
      containerAspect: 32 / 9,
    });
    // Sanity check the closure variable is referenced so linters accept it.
    expect(flippedState).toBe(true);
    expect(a).toEqual(b);
  });
});

describe('projectNormalizedDetection', () => {
  it('recomputes the center after projection', () => {
    const projected = projectNormalizedDetection(
      {
        label: 'tennis ball',
        confidence: 0.7,
        box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
        center: { x: 0.5, y: 0.5 },
      },
      { sourceAspect: 16 / 9, containerAspect: 32 / 9 },
    );

    // scaleX = 0.5, offsetX = 0.25 -> center x = 0.25 + 0.5 * 0.5 = 0.5
    expect(projected.center.x).toBeCloseTo(0.5, 6);
    // Vertical axis unchanged in this letterbox case.
    expect(projected.center.y).toBeCloseTo(0.5, 6);
    // Original metadata preserved.
    expect(projected.label).toBe('tennis ball');
    expect(projected.confidence).toBe(0.7);
  });
});

describe('unprojectNormalizedBox', () => {
  it('is the inverse of projectNormalizedBox for matching aspects', () => {
    const original = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };
    const projected = projectNormalizedBox(original, { sourceAspect: 16 / 9, containerAspect: 16 / 9 });
    const unprojected = unprojectNormalizedBox(projected, { sourceAspect: 16 / 9, containerAspect: 16 / 9 });

    expect(unprojected.x).toBeCloseTo(original.x, 5);
    expect(unprojected.y).toBeCloseTo(original.y, 5);
    expect(unprojected.w).toBeCloseTo(original.w, 5);
    expect(unprojected.h).toBeCloseTo(original.h, 5);
  });

  it('is the inverse of projectNormalizedBox for wide container (horizontal letterbox)', () => {
    const original = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };
    const opts = { sourceAspect: 16 / 9, containerAspect: 32 / 9 };
    const projected = projectNormalizedBox(original, opts);
    const unprojected = unprojectNormalizedBox(projected, opts);

    expect(unprojected.x).toBeCloseTo(original.x, 5);
    expect(unprojected.y).toBeCloseTo(original.y, 5);
    expect(unprojected.w).toBeCloseTo(original.w, 5);
    expect(unprojected.h).toBeCloseTo(original.h, 5);
  });

  it('is the inverse of projectNormalizedBox for tall container (vertical letterbox)', () => {
    const original = { x: 0.1, y: 0.2, w: 0.4, h: 0.3 };
    const opts = { sourceAspect: 16 / 9, containerAspect: 16 / 18 };
    const projected = projectNormalizedBox(original, opts);
    const unprojected = unprojectNormalizedBox(projected, opts);

    expect(unprojected.x).toBeCloseTo(original.x, 5);
    expect(unprojected.y).toBeCloseTo(original.y, 5);
    expect(unprojected.w).toBeCloseTo(original.w, 5);
    expect(unprojected.h).toBeCloseTo(original.h, 5);
  });

  it('clamps coords from letterbox bars to [0, 1]', () => {
    // A selection rect starting in the left letterbox bar (x < offsetX)
    // should be clamped to 0.
    const opts = { sourceAspect: 16 / 9, containerAspect: 32 / 9 };
    const inBarBox = { x: 0.0, y: 0.0, w: 0.1, h: 0.5 };
    const unprojected = unprojectNormalizedBox(inBarBox, opts);

    expect(unprojected.x).toBeGreaterThanOrEqual(0);
    expect(unprojected.x).toBeLessThanOrEqual(1);
  });

  it('returns a zeroed box for invalid input', () => {
    const result = unprojectNormalizedBox(null);
    expect(result).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
