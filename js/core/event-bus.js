// js/core/event-bus.js
//
// Cross-component event bus. Uses `waypoint:*` naming exclusively.
//
// codebase now uses `waypoint:datachange` and `waypoint:themechange`
// directly; no compatibility layer needed.
//
// History:

/**
 * Fire an event using the canonical `waypoint:*` name.
 *
 * @param {string} name    e.g. 'waypoint:datachange'
 * @param {*}      [detail] CustomEvent detail payload (any shape)
 */
export function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Listen for a `waypoint:*` event. Returns an unsubscribe function.
 */
export function on(name, handler) {
  document.addEventListener(name, handler);
  return () => document.removeEventListener(name, handler);
}

/**
 * Remove a previously registered listener. Equivalent to invoking the
 * unsubscribe function returned by `on()`.
 */
export function off(name, handler) {
  document.removeEventListener(name, handler);
}

// ---------------------------------------------------------------------------
// Expose on window.WP for inline-handler / monolith callers that haven't
// migrated to `import` syntax. Safe to remove once nothing reads window.WP.
// ---------------------------------------------------------------------------
window.WP = window.WP || {};
window.WP.emit = emit;
window.WP.on = on;
window.WP.off = off;
