// Drag handles for the window's panes (master plan D1b2): the session
// sidebar, the side pane and the changed-files list. Each size is a CSS
// variable, kept per window in localStorage; the arrow keys move a focused
// handle and a double click puts the default back.

const STEP = 24;
// The conversation keeps at least this much room between the sidebar and the pane.
export const MIN_MAIN = 480;
export const SIDEBAR_MAX = 480;

/** px clamped to [min, max]; max below min yields min. */
export function clampSize(px, min, max) {
  return Math.round(Math.max(min, Math.min(Math.max(min, max), px)));
}

/** The widest the side pane may be next to a sidebar of the given width. */
export function paneMaxWidth(windowWidth, sidebarWidth) {
  return Math.min(Math.floor(windowWidth * 0.7), windowWidth - sidebarWidth - MIN_MAIN);
}

/** The widest the session sidebar may be next to an open pane (0 when shut). */
export function sidebarMaxWidth(windowWidth, paneWidth) {
  return Math.min(SIDEBAR_MAX, windowWidth - paneWidth - MIN_MAIN);
}

function stored(key) {
  try { return Number(window.localStorage.getItem(key)) || 0; } catch { return 0; }
}

function store(key, value) {
  try {
    if (value) window.localStorage.setItem(key, String(value));
    else window.localStorage.removeItem(key);
  } catch { /* storage off */ }
}

/**
 * Wire one handle. options: { handle, key, cssVar, min, max() (px, read at
 * each move), measure() (the size now), fromPointer(event, start) -> px
 * where start is { size, x, y }, keys: { grow, shrink }, axis ("x" or "y",
 * for the drag cursor), target (element the variable is set on, default
 * <html>) }. Returns { set(px), reset(), apply() }.
 */
export function makeResizer(options) {
  const { handle, key, cssVar, min, max, measure, fromPointer } = options;
  const target = options.target || document.documentElement;
  const keys = options.keys || { grow: "ArrowRight", shrink: "ArrowLeft" };
  const dragClass = options.axis === "y" ? "resizing-y" : "resizing-x";

  function set(px, { save = true } = {}) {
    const size = clampSize(px, min, max());
    target.style.setProperty(cssVar, `${size}px`);
    handle.setAttribute("aria-valuenow", String(size));
    if (save) store(key, size);
    return size;
  }

  function reset() {
    target.style.removeProperty(cssVar);
    handle.removeAttribute("aria-valuenow");
    store(key, 0);
  }

  // A saved size re-clamps when the window shrinks, without overwriting it.
  function apply() {
    const saved = stored(key);
    if (saved) set(saved, { save: false });
  }

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const start = { size: measure(), x: event.clientX, y: event.clientY };
    document.body.classList.add("resizing", dragClass);
    const move = (e) => set(fromPointer(e, start));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing", dragClass);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key === keys.grow) { event.preventDefault(); set(measure() + STEP); }
    if (event.key === keys.shrink) { event.preventDefault(); set(measure() - STEP); }
    if (event.key === "Home") { event.preventDefault(); reset(); }
  });
  handle.addEventListener("dblclick", reset);
  handle.setAttribute("aria-valuemin", String(min));
  apply();
  return { set, reset, apply };
}
