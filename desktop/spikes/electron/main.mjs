import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCoopRuntime } from "./runtime-supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let runtime = null;
let mainWindow = null;
let quitting = false;
let allowedOrigin = null;

app.enableSandbox();

function trustedSender(event) {
  try { return event.senderFrame === mainWindow?.webContents.mainFrame && new URL(event.senderFrame.url).origin === allowedOrigin; }
  catch { return false; }
}

function registerIpc() {
  ipcMain.handle("coop:choose-workspace", async (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("coop:get-shell-info", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    return { shell: "electron", platform: process.platform, packaged: app.isPackaged };
  });
}

async function createWindow() {
  const workspace = resolve(process.env.COOP_WORKSPACE || process.cwd());
  runtime = await startCoopRuntime({ workspace, coopCommand: process.env.COOP_BIN || "coop", onStderr: (text) => process.stderr.write(text) });
  allowedOrigin = runtime.ready.endpoint;
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#11151c",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    try { if (new URL(target).origin !== allowedOrigin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(`${allowedOrigin}/?token=${encodeURIComponent(runtime.ready.oneTimeToken)}`);
}

registerIpc();
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(createWindow).catch((error) => { dialog.showErrorBox("Coop Desktop could not start", error.message); app.quit(); });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!runtime || quitting) return;
  event.preventDefault();
  quitting = true;
  runtime.stop().finally(() => app.exit(0));
});
