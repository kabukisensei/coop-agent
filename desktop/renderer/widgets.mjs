// Extension widgets: the lines an extension puts above or below the prompt
// through Pi's `setWidget` (desktop/PARITY.md, Extension UI). The todo panel
// (`@juicesharp/rpiv-todo`) is one; in the terminal its key collapses the panel
// to its heading and a one-line hint, and the window does the same with Alt+T
// for every widget above the prompt.

export const COLLAPSE_KEY = "Alt+T";

/**
 * The lines to show for one widget: all of them, or, when collapsed and the
 * widget has more than a heading, the first line plus a hint that counts the
 * hidden ones (blank spacer lines are not counted).
 */
export function widgetView(widget, collapsed) {
  const lines = Array.isArray(widget && widget.lines) ? widget.lines.map(String) : [];
  if (!collapsed || lines.length <= 1) return lines;
  const hidden = lines.slice(1).filter((line) => line.trim()).length;
  if (!hidden) return [lines[0]];
  return [lines[0], `  … ${hidden} more line${hidden === 1 ? "" : "s"} (${COLLAPSE_KEY} expands)`];
}
