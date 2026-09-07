const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coopDesktop", Object.freeze({
  getNativeCommands: () => Object.freeze([
    Object.freeze({ id: "open-workspace", name: "Open workspace", description: "Choose a Coop project folder." }),
    Object.freeze({ id: "choose-theme", name: "Choose theme", description: "Switch Modern Dark, Modern Light, or Retro Messenger without changing capabilities." }),
    Object.freeze({ id: "terminal-open", name: "Open terminal", description: "Open a new terminal in this workspace." }),
    Object.freeze({ id: "terminal-clone", name: "Clone session to terminal", description: "Continue independently in a terminal." }),
    Object.freeze({ id: "terminal-move", name: "Move session to terminal", description: "Transfer writable session ownership to a terminal." }),
    Object.freeze({ id: "session-export", name: "Export session", description: "Save this session as HTML through a native save dialog." }),
  ]),
  chooseWorkspace: (sid) => ipcRenderer.invoke("coop:choose-workspace", { sid }),
  restoreNavigation: (sid) => ipcRenderer.invoke("coop:restore-navigation", { sid }),
  setActiveChat: (sid) => ipcRenderer.invoke("coop:active-chat", { sid }),
  getShellInfo: () => ipcRenderer.invoke("coop:get-shell-info"),
  setTheme: (theme) => ipcRenderer.invoke("coop:set-theme", { theme }),
  terminalHandoff: (mode, sid) => ipcRenderer.invoke("coop:terminal-handoff", { mode, sid }),
  startModelLogin: () => ipcRenderer.invoke("coop:start-model-login"),
  exportSession: (sid) => ipcRenderer.invoke("coop:export-session", { sid }),
  notify: (title, body) => ipcRenderer.invoke("coop:notify", { title, body }),
  onMenuAction: (callback) => {
    if (typeof callback !== "function") throw new TypeError("callback is required");
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("coop:menu-action", listener);
    return () => ipcRenderer.removeListener("coop:menu-action", listener);
  },
}));
