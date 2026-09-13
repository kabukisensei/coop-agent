const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coopDesktop", Object.freeze({
  chooseWorkspace: () => ipcRenderer.invoke("coop:choose-workspace"),
  getShellInfo: () => ipcRenderer.invoke("coop:get-shell-info"),
}));
