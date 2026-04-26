// Geometry helper for the monitor-only vision overlay.
//
// The camera image uses CSS `object-fit: contain`, so when the rendered
// container's aspect ratio differs from the source frame's aspect ratio the
// image is letterboxed (horizontal bars top/bottom for a wider container,
// vertical bars left/right for a taller container). Detection boxes are
// expressed in normalized source-image coordinates (0..1), so they must be
// re-projected into the overlay's coordinate space to line up with what the
// user actually sees.
//
// This phase is monitor-only. Geometry transforms here are visual only and
// must never feed drive commands.

export const DEFAULT_SOURCE_ASPECT = 16 / 9;

/**
 * Project a normalized source-frame box into normalized container coords
 * matching CSS `object-fit: contain`.
 *
 * Input box: { x, y, w, h } in source-image normalized coords (0..1).
 * Output box: { x, y, w, h } in container normalized coords (0..1) where the
 * letterbox bars are accounted for.
 *
 * sourceAspect / containerAspect are width/height ratios.
 */
export function projectNormalizedBox(box, { sourceAspect = DEFAULT_SOURCE_ASPECT, containerAspect } = {}) {
  if (!box || typeof box !== 'object') {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const src = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : DEFAULT_SOURCE_ASPECT;
  const container = Number.isFinite(containerAspect) && containerAspect > 0 ? containerAspect : src;

  // Scale and offset describe how the source rectangle is laid out inside
  // the container under object-fit: contain.
  let scaleX;
  let scaleY;
  let offsetX;
  let offsetY;

  if (Math.abs(container - src) < 1e-9) {
    scaleX = 1;
    scaleY = 1;
    offsetX = 0;
    offsetY = 0;
  } else if (container > src) {
    // Container is wider than the source: vertical letterbox bars on the
    // left and right, image fills the full height.
    scaleX = src / container;
    scaleY = 1;
    offsetX = (1 - scaleX) / 2;
    offsetY = 0;
  } else {
    // Container is taller than the source: horizontal letterbox bars on the
    // top and bottom, image fills the full width.
    scaleX = 1;
    scaleY = container / src;
    offsetX = 0;
    offsetY = (1 - scaleY) / 2;
  }

  return {
    x: offsetX + box.x * scaleX,
    y: offsetY + box.y * scaleY,
    w: box.w * scaleX,
    h: box.h * scaleY,
  };
}

/**
 * Convenience: project the box's center too, so callers don't have to
 * recompute it after letterbox correction.
 */
export function projectNormalizedDetection(detection, options) {
  if (!detection || typeof detection !== 'object') {
    return detection;
  }
  const projected = projectNormalizedBox(detection.box || { x: 0, y: 0, w: 0, h: 0 }, options);
  return {
    ...detection,
    box: projected,
    center: {
      x: projected.x + projected.w / 2,
      y: projected.y + projected.h / 2,
    },
  };
}

/**
 * Un-project container-space normalised coords back to source-image normalised coords.
 * This is the inverse of projectNormalizedBox and is used to convert a drag selection
 * made on the rendered container into source-image coordinates for the tracking backend.
 *
 * Coords that fall in the letterbox bars are clamped to [0, 1].
 */
export function unprojectNormalizedBox(box, { sourceAspect = DEFAULT_SOURCE_ASPECT, containerAspect } = {}) {
  if (!box || typeof box !== 'object') {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const src = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : DEFAULT_SOURCE_ASPECT;
  const container = Number.isFinite(containerAspect) && containerAspect > 0 ? containerAspect : src;

  let scaleX;
  let scaleY;
  let offsetX;
  let offsetY;

  if (Math.abs(container - src) < 1e-9) {
    scaleX = 1;
    scaleY = 1;
    offsetX = 0;
    offsetY = 0;
  } else if (container > src) {
    scaleX = src / container;
    scaleY = 1;
    offsetX = (1 - scaleX) / 2;
    offsetY = 0;
  } else {
    scaleX = 1;
    scaleY = container / src;
    offsetX = 0;
    offsetY = (1 - scaleY) / 2;
  }

  const sx = scaleX > 0 ? (box.x - offsetX) / scaleX : 0;
  const sy = scaleY > 0 ? (box.y - offsetY) / scaleY : 0;
  const sw = scaleX > 0 ? box.w / scaleX : 0;
  const sh = scaleY > 0 ? box.h / scaleY : 0;

  return {
    x: Math.max(0, Math.min(1, sx)),
    y: Math.max(0, Math.min(1, sy)),
    w: Math.max(0, Math.min(1, sw)),
    h: Math.max(0, Math.min(1, sh)),
  };
}
