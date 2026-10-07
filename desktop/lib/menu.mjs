// The window's menu bar (desktop UX review, 2026-10-03): File, Edit, View,
// Session and Help, so a teammate who presses Alt or looks for a menu finds
// what Ctrl+K already holds. This builds Electron's menu template from plain
// callbacks, so tests can read it without Electron; main.mjs wires it.

export const THEME_LABELS = Object.freeze({ auto: "Match Windows", "modern-dark": "Modern dark", "modern-light": "Modern light", "retro-dark": "Retro dark", "retro-light": "Retro light" });

export const INSTALL_GUIDE_URL = "https://github.com/kabukisensei/coop-agent/blob/main/docs/install-windows.md";

/**
 * The template. `run(action)` sends a renderer action (the ids in
 * app.mjs ACTIONS); `setTheme(theme)` and `toggleMenuBar()` act in the main
 * process; `openExternal(url)` opens the browser; `about()` shows the version.
 */
export function menuTemplate({ run, setTheme, theme, themes, menuBar, toggleMenuBar, openExternal, about, isMac = false, phone, tabs }) {
  const action = (label, id, accelerator) => ({ label, accelerator, click: () => run(id) });
  // Tab keys are caught before the page (main.mjs onTabKey), so the menu only shows them.
  const tabItem = (label, fn, accelerator) => ({ label, accelerator, registerAccelerator: false, click: () => fn() });
  return [
    {
      label: "&File",
      submenu: [
        ...(tabs ? [tabItem("New tab", tabs.add, "CmdOrCtrl+N"), { label: "New window", click: () => tabs.newWindow() }] : []),
        action("New session", "new", "CmdOrCtrl+Shift+N"),
        action("Sessions...", "resume", "CmdOrCtrl+Shift+R"),
        action("Switch project...", "switch"),
        action("Open folder in a new window...", "folder"),
        { type: "separator" },
        action("Open in terminal", "terminal"),
        action("Restart coop on this session", "reload"),
        { type: "separator" },
        ...(tabs ? [tabItem("Next tab", tabs.next, "CmdOrCtrl+Tab"), tabItem("Previous tab", tabs.prev, "CmdOrCtrl+Shift+Tab"), { type: "separator" }] : []),
        tabs ? tabItem("Close tab", tabs.close, "CmdOrCtrl+W") : isMac ? { role: "close" } : action("Close window", "quit", "CmdOrCtrl+W"),
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        action("Copy the last answer", "copy"),
        action("Find in conversation", "find", "CmdOrCtrl+F"),
      ],
    },
    {
      label: "&View",
      submenu: [
        {
          label: "Theme",
          submenu: themes.map((id) => ({ label: THEME_LABELS[id] || id, type: "radio", checked: id === theme, click: () => setTheme(id) })),
        },
        action("Side pane", "pane", "CmdOrCtrl+\\"),
        action("Sessions list", "sidebar"),
        { type: "separator" },
        action("Changes since the last commit", "changes", "CmdOrCtrl+Shift+D"),
        action("Standards coop applies here", "standards", "CmdOrCtrl+Shift+S"),
        action("Project settings", "project"),
        action("Lineage docs", "docs"),
        { type: "separator" },
        { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
        { type: "separator" },
        { label: "Menu bar", type: "checkbox", checked: menuBar, click: () => toggleMenuBar() },
      ],
    },
    {
      label: "&Session",
      submenu: [
        action("Pick a model", "model", "CmdOrCtrl+L"),
        action("Thinking level", "thinking"),
        action("Settings", "settings"),
        { type: "separator" },
        action("Name this session", "name"),
        action("Session details", "session"),
        action("Session tree", "tree", "CmdOrCtrl+Shift+T"),
        action("Fork from an earlier prompt", "fork", "CmdOrCtrl+Shift+F"),
        action("Clone this session", "clone"),
        action("Compact the conversation", "compact"),
        action("Export as a web page", "export"),
        ...(phone ? [{ type: "separator" }, phoneMenu(phone)] : []),
      ],
    },
    {
      label: "&Help",
      submenu: [
        action("Start menu: common tasks", "start"),
        action("Keyboard shortcuts", "hotkeys"),
        action("Commands (Ctrl+K)", "palette", "CmdOrCtrl+K"),
        { type: "separator" },
        { label: "Install guide", click: () => openExternal(INSTALL_GUIDE_URL) },
        { label: "About coop", click: () => about() },
      ],
    },
  ];
}

/** The body of a background notification for a Pi event, or "" for none. */
export function notificationFor(event, { folder = "" } = {}) {
  if (!event || typeof event !== "object") return "";
  const where = folder ? ` in ${folder}` : "";
  if (event.type === "agent_end") return `coop finished${where}.`;
  if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
    const title = String(event.title || event.message || "").split("\n")[0].trim().slice(0, 120);
    return `coop is waiting for your answer${where}${title ? `: ${title}` : "."}`;
  }
  return "";
}

/**
 * Session > Phone (master plan row MC2): phone access for the whole app (pair
 * once), pair a phone, and remove phones. `phone` is `{ accessOn, devices,
 * toggleAccess(), pair(), remove(id) }`; remove("*") removes every phone.
 */
export function phoneMenu({ accessOn, devices = [], toggleAccess, pair, remove }) {
  return {
    label: "Phone",
    submenu: [
      { label: "Allow phone access", type: "checkbox", checked: Boolean(accessOn), click: () => toggleAccess() },
      { label: "Pair a phone...", click: () => pair() },
      {
        label: "Paired phones",
        submenu: devices.length
          ? [...devices.map((device) => ({ label: `Remove ${device.name}${device.client ? ` (${device.client})` : ""}`, click: () => remove(device.id) })), { type: "separator" }, { label: "Remove all phones", click: () => remove("*") }]
          : [{ label: "No phones paired", enabled: false }],
      },
    ],
  };
}
