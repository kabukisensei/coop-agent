// Tabs (several sessions at once): one coop window holds tabs, and each tab is
// the whole session page with its own Pi, as each terminal tab runs its own
// coop. A tab's approvals, guardrails and questions are its own;
// tabs share only the window's folder. These are the plain parts main.mjs
// uses (keys, the strip's rows, which tab comes forward after a close), so
// tests can run them without Electron.

export const TAB_STRIP_HEIGHT = 34;
export const MAX_TABS = 12;
const LABEL_MAX = 60;

/**
 * The tab action for a key press (Electron's before-input-event `input`), or
 * null. Ctrl+N new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab and
 * Ctrl+PageDown / Ctrl+PageUp next and previous, Ctrl+1..8 that tab, Ctrl+9
 * the last, as browsers and Windows Terminal do.
 */
export function tabKey(input) {
  if (!input || input.type !== "keyDown") return null;
  const ctrl = input.control || input.meta;
  if (!ctrl || input.alt) return null;
  const key = String(input.key || "");
  if (key === "Tab") return { type: input.shift ? "prev" : "next" };
  if (key === "PageDown" && !input.shift) return { type: "next" };
  if (key === "PageUp" && !input.shift) return { type: "prev" };
  if (input.shift) return null;
  const lower = key.toLowerCase();
  if (lower === "n") return { type: "new" };
  if (lower === "w") return { type: "close" };
  if (/^[1-9]$/.test(key)) return key === "9" ? { type: "last" } : { type: "index", index: Number(key) - 1 };
  return null;
}

/** The tab to show for an action on `tabs` (an array) from `active`. */
export function tabFor(action, tabs, active) {
  if (!tabs.length) return null;
  const at = Math.max(0, tabs.indexOf(active));
  if (action.type === "next") return tabs[(at + 1) % tabs.length];
  if (action.type === "prev") return tabs[(at - 1 + tabs.length) % tabs.length];
  if (action.type === "last") return tabs[tabs.length - 1];
  if (action.type === "index") return tabs[action.index] || null;
  return null;
}

/** After closing `closing`, the tab that comes forward: the one to its right, else its left. */
export function afterClose(tabs, closing, active) {
  const rest = tabs.filter((tab) => tab !== closing);
  if (!rest.length) return null;
  if (closing !== active) return active;
  const at = tabs.indexOf(closing);
  return rest[Math.min(at, rest.length - 1)];
}

/** A tab's label from what its page reported, cut to fit the strip. */
export function tabLabel(text) {
  const clean = String(text || "").replace(/[\0-\x1f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "New session";
  return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX - 1)}…` : clean;
}

/** The rows the strip draws: id, label, working, asking, active. */
export function stripRows(tabs, active) {
  return tabs.map((tab) => ({
    id: tab.tabId,
    label: tabLabel(tab.label),
    working: Boolean(tab.working),
    asking: Boolean(tab.asking),
    active: tab === active,
  }));
}
