// The window's only bridge to coop. The renderer is sandboxed with no Node;
// it can call these functions and nothing else, and the main process checks
// every argument again (main.mjs, lib/rpc-commands.mjs).
const { contextBridge, ipcRenderer } = require("electron");

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
  onEvent: listen("pi:event"),
  onExit: listen("pi:exit"),
  onNotice: listen("pi:notice"),
  onTheme: listen("coop:theme"),
}));
