// The window's only bridge to coop. The renderer is sandboxed with no Node;
// it can call these functions and nothing else, and the main process checks
// every argument again (main.mjs, lib/rpc-commands.mjs).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function listen(channel) {
  return (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("coop", Object.freeze({
  ready: () => ipcRenderer.invoke("coop:ready"),
  info: () => ipcRenderer.invoke("coop:info"),
  command: (input) => ipcRenderer.invoke("coop:command", input),
  answer: (id, answer) => ipcRenderer.invoke("coop:answer", id, answer),
  sessions: () => ipcRenderer.invoke("coop:sessions"),
  files: (query) => ipcRenderer.invoke("coop:files", String(query || "")),
  switchSession: (path) => ipcRenderer.invoke("coop:switch-session", path),
  exportHtml: () => ipcRenderer.invoke("coop:export"),
  openTerminal: () => ipcRenderer.invoke("coop:open-terminal"),
  openFolder: () => ipcRenderer.invoke("coop:open-folder"),
  restart: () => ipcRenderer.invoke("coop:restart"),
  setTheme: (theme) => ipcRenderer.invoke("coop:theme", theme),
  copy: (text) => ipcRenderer.invoke("coop:copy", text),
  openExternal: (url) => ipcRenderer.invoke("coop:open-external", url),
  zoom: (step) => ipcRenderer.invoke("coop:zoom", step),
  // Window preferences kept by the main process (notifications, menu bar).
  setPref: (key, value) => ipcRenderer.invoke("coop:pref", String(key || ""), value),
  // Panes (D1b2).
  changes: () => ipcRenderer.invoke("coop:changes"),
  changeDiff: (path) => ipcRenderer.invoke("coop:change-diff", String(path || "")),
  standards: () => ipcRenderer.invoke("coop:standards"),
  standardsText: (domain) => ipcRenderer.invoke("coop:standards-text", String(domain || "")),
  projectLoad: () => ipcRenderer.invoke("coop:project-load"),
  projectPreview: (input) => ipcRenderer.invoke("coop:project-preview", input),
  projectSave: (input, token) => ipcRenderer.invoke("coop:project-save", input, token),
  pickFolder: (purpose, current) => ipcRenderer.invoke("coop:pick-folder", String(purpose || ""), String(current || "")),
  docsStart: () => ipcRenderer.invoke("coop:docs-start"),
  docsState: () => ipcRenderer.invoke("coop:docs-state"),
  docsAnswer: (id, value) => ipcRenderer.invoke("coop:docs-answer", id, value),
  docsCancel: () => ipcRenderer.invoke("coop:docs-cancel"),
  docsLocation: () => ipcRenderer.invoke("coop:docs-location"),
  docsBuild: () => ipcRenderer.invoke("coop:docs-build"),
  docsPage: (page) => ipcRenderer.invoke("coop:docs-page", String(page || "")),
  docsPages: () => ipcRenderer.invoke("coop:docs-pages"),
  docsPortal: () => ipcRenderer.invoke("coop:docs-portal"),
  // Attachments (D1b2). pathForFile turns a dropped or pasted File into its
  // path (File.path is gone in this Electron); the main process reads it.
  pickFiles: () => ipcRenderer.invoke("coop:pick-files"),
  attachFile: (path) => ipcRenderer.invoke("coop:attach-file", String(path || "")),
  forgetAttachment: (id) => ipcRenderer.invoke("coop:attachment-forget", String(id || "")),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  // A fresh vibe (tip) for the empty screen and the working line; a set name switches the pool.
  vibe: (set) => ipcRenderer.invoke("coop:vibe", String(set || "")),
  onEvent: listen("pi:event"),
  onExit: listen("pi:exit"),
  onNotice: listen("pi:notice"),
  onTheme: listen("coop:theme"),
  onMenu: listen("coop:menu"),
  onDocs: listen("coop:docs"),
}));
