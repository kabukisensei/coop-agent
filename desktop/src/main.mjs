import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, session, shell } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesktopState, restoreWindowBounds, saveDesktopState } from "./desktop-state.mjs";
import { normalizeSavedChat, restoreSavedChats } from "./session-restoration.mjs";
import { selectRuntimeWorkspace } from "./workspace-selection.mjs";
import { resolveManagedDesktopProfile } from "./managed-profile.mjs";
import { inspectManagedRuntime, resolveDesktopCoopLauncher } from "./managed-runtime.mjs";
import { launchNativeModelLogin, launchNativeTerminal } from "./native-terminal.mjs";
import { startCoopRuntime } from "./runtime-supervisor.mjs";
import { waitForRuntimeState } from "./runtime-readiness.mjs";
import { runtimeExportSource, saveRuntimeExport } from "./session-export.mjs";
import { launchUpdateHelper } from "./update-handoff.mjs";
import { presentUpdateOutcome } from "./update-outcome.mjs";
import { canStartMacApplication } from "./update-startup.mjs";
import { pruneCompletedRecoveryJobs } from "./update-recovery-retention.mjs";
import { createUpdateController, loadPackagedUpdateFeed } from "./update-controller.mjs";
import { loadPackagedUpdateTrust, updateTrustSummary } from "./update-trust.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SID = /^[A-Za-z0-9_-]{1,100}$/;
const TERMINAL_MODES = new Set(["open", "clone", "move"]);
const THEMES = new Set(["modern-dark", "modern-light", "retro-messenger"]);
const THEME_BACKGROUNDS = Object.freeze({ "modern-dark": "#0D1822", "modern-light": "#F4F7F5", "retro-messenger": "#D8D8D8" });
let runtime = null;
let runtimeGeneration = 0;
let mainWindow = null;
let allowedOrigin = null;
let workspace = null;
let coopExecutable = null;
let runtimeSource = null;
let runtimeVersions = null;
let managedAgentDir = null;
let statePath = null;
let desktopState = null;
let packagedUpdateTrust = null;
let updateController = null;
let updateDialogActive = false;
let updateHandoff = null;
let updateInstallRequested = false;
let quitting = false;
let navigationRestore = null;
let navigationReady = false;
let navigationBusy = false;
let activeChatSid = null;
let recoveryFailures = [];
let checkpointTimer = null;

const managedResourcePresent = app.isPackaged && existsSync(join(process.resourcesPath, "managed-runtime", "manifest.json"));
const updateProbeToken = managedResourcePresent && /^[a-f0-9]{64}$/.test(process.env.COOP_DESKTOP_UPDATE_PROBE || "") ? process.env.COOP_DESKTOP_UPDATE_PROBE : null;
if (updateProbeToken) process.on("SIGTERM", () => app.quit());
const developmentBuild = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")).coopDesktopDevelopment === true;
app.setName(developmentBuild ? "Coop Desktop Windows Validation" : managedResourcePresent ? "Coop Desktop" : "Coop Desktop Preview");
if (developmentBuild && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), "Coop Desktop Windows Validation"));
}
app.enableSandbox();

function directoryExists(path) {
  try { return typeof path === "string" && existsSync(path) && statSync(path).isDirectory(); }
  catch { return false; }
}

function trustedSender(event) {
  try {
    return event.senderFrame === mainWindow?.webContents.mainFrame
      && new URL(event.senderFrame.url).origin === allowedOrigin;
  } catch {
    return false;
  }
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/[\0\r\n]/g, " ").trim().slice(0, max) : "";
}

async function chooseWorkspace(owner = mainWindow) {
  const result = await dialog.showOpenDialog(owner || undefined, {
    title: "Open a Coop workspace",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return resolve(result.filePaths[0]);
}

async function selectInitialWorkspace() {
  const explicit = process.env.COOP_WORKSPACE;
  if (directoryExists(explicit)) return resolve(explicit);
  if (directoryExists(desktopState.lastWorkspace)) return resolve(desktopState.lastWorkspace);
  const available = desktopState.openChats.find(entry => directoryExists(entry.cwd));
  if (available) return resolve(available.cwd);
  return chooseWorkspace(null);
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (typeof session.defaultSession.setDevicePermissionHandler === "function") {
    session.defaultSession.setDevicePermissionHandler(() => false);
  }
}

function safeExternalUrl(target) {
  try {
    if (typeof target !== "string" || target.length > 2048) return null;
    const url = new URL(target);
    if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function confirmAndOpenExternal(target) {
  const url = safeExternalUrl(target);
  if (!url || !mainWindow) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Open external link?",
    message: "Open this link in your default browser?",
    detail: url,
    buttons: ["Cancel", "Open link"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response === 1) await shell.openExternal(url, { activate: true });
}

async function loadRuntimeWindow() {
  await mainWindow.loadURL(`${allowedOrigin}/?token=${encodeURIComponent(runtime.ready.oneTimeToken)}`);
}

async function startRuntime() {
  navigationRestore = null;
  navigationReady = false;
  activeChatSid = null;
  clearInterval(checkpointTimer);
  const generation = ++runtimeGeneration;
  const launcher = resolveDesktopCoopLauncher({
    explicit: process.env.COOP_BIN || null,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  managedAgentDir = null;
  if (launcher.source === "managed") {
    try { managedAgentDir = resolveManagedDesktopProfile(app.getPath("userData")); }
    catch (error) {
      if (error.code !== "PROFILE_SELECTION_REQUIRED") throw error;
      const choice = await dialog.showOpenDialog(mainWindow || undefined, {
        title: "Choose your existing Coop Desktop profile", message: error.message,
        defaultPath: error.root, properties: ["openDirectory"],
      });
      if (choice.canceled || !choice.filePaths[0]) {
        const cancelled = new Error("Desktop profile selection cancelled.");
        cancelled.code = "PROFILE_SELECTION_CANCELLED";
        throw cancelled;
      }
      managedAgentDir = resolveManagedDesktopProfile(app.getPath("userData"), { selectedDirectory: choice.filePaths[0] });
    }
  }
  const runtimeEnv = managedAgentDir
    ? { ...process.env, COOP_DESKTOP_AGENT_DIR: managedAgentDir, COOP_AGENT_DIR: managedAgentDir, PI_CODING_AGENT_DIR: managedAgentDir }
    : process.env;
  runtime = await startCoopRuntime({
    workspace,
    coopCommand: launcher.command,
    commandPrefix: launcher.commandPrefix,
    env: runtimeEnv,
    // Cold bundled Python/extension discovery can exceed 20 seconds on Windows VMs.
    readyTimeoutMs: launcher.source === "managed" ? 90_000 : 20_000,
    onStderr: (text) => process.stderr.write(text),
    onExit: (info) => { void handleUnexpectedRuntimeExit(generation, info); },
  });
  coopExecutable = launcher.terminalExecutable;
  runtimeSource = launcher.source;
  runtimeVersions = launcher.versions;
  allowedOrigin = runtime.ready.endpoint;
}

async function handleUnexpectedRuntimeExit(generation, info) {
  if (quitting || generation !== runtimeGeneration) return;
  runtime = null;
  const result = await dialog.showMessageBox(mainWindow || undefined, {
    type: "error",
    title: "Coop Runtime stopped",
    message: "The local Coop Runtime stopped unexpectedly.",
    detail: `Exit: ${info.code ?? info.signal ?? "unknown"}. Restarting creates a fresh runtime connection; session leases continue to protect saved sessions.`,
    buttons: ["Quit", "Restart runtime"],
    defaultId: 1,
    cancelId: 0,
  });
  if (result.response !== 1) { app.quit(); return; }
  try {
    await startRuntime();
    await loadRuntimeWindow();
  } catch (error) {
    dialog.showErrorBox("Coop Desktop could not restart", error.message);
    app.quit();
  }
}

async function runtimePost(path, body) {
  if (!runtime || !allowedOrigin) throw new Error("Coop Runtime is not available.");
  const endpoint = allowedOrigin;
  const generation = runtimeGeneration;
  const cookies = await session.defaultSession.cookies.get({ url: endpoint, name: "coop_token" });
  const token = cookies[0]?.value;
  if (!token) throw new Error("Coop Runtime authentication is unavailable.");
  if (generation !== runtimeGeneration || endpoint !== allowedOrigin) throw new Error("Coop Runtime changed during the request.");
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-coop-csrf": "1",
      cookie: `coop_token=${token}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.error || `Coop Runtime request failed (${response.status}).`);
  return result;
}

async function runtimeRpc(body) {
  if (!runtime || !allowedOrigin) throw new Error("Coop Runtime is not available.");
  const endpoint = allowedOrigin;
  const generation = runtimeGeneration;
  const cookies = await session.defaultSession.cookies.get({ url: endpoint, name: "coop_token" });
  const token = cookies[0]?.value;
  if (!token) throw new Error("Coop Runtime authentication is unavailable.");
  if (generation !== runtimeGeneration || endpoint !== allowedOrigin) throw new Error("Coop Runtime changed during the request.");
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1", cookie: `coop_token=${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success !== true) {
    const error = new Error(result?.error || `Coop Runtime request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function runtimeChatState() {
  if (!runtime || !allowedOrigin) throw new Error("Coop Runtime is not available.");
  const endpoint = allowedOrigin;
  const generation = runtimeGeneration;
  const cookies = await session.defaultSession.cookies.get({ url: endpoint, name: "coop_token" });
  const token = cookies[0]?.value;
  if (!token) throw new Error("Coop Runtime authentication is unavailable.");
  if (generation !== runtimeGeneration || endpoint !== allowedOrigin) throw new Error("Coop Runtime changed during the request.");
  const response = await fetch(`${endpoint}/chat-state`, {
    headers: { cookie: `coop_token=${token}` }, signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !Array.isArray(result.chats)) throw new Error("Could not read open chats.");
  return result;
}

async function checkpointNavigation() {
  if (!navigationReady || navigationBusy || !runtime) return;
  navigationBusy = true;
  const generation = runtimeGeneration;
  const selected = activeChatSid;
  try {
    const before = await runtimeChatState();
    const entries = await Promise.all(before.chats.map(async chat => {
      if (chat.status === "exited") throw new Error("An exited chat cannot replace saved recovery state.");
      const reply = await runtimeRpc({ type: "get_state", sid: chat.sid });
      const data = reply.data || {};
      const file = data.messageCount === 0 ? null : typeof data.sessionFile === "string" ? basename(data.sessionFile) : null;
      if (data.messageCount > 0 && !file) throw new Error("Session identity is not available yet.");
      const entry = normalizeSavedChat({ cwd: chat.cwd, file, access: chat.workspaceAccess?.mode === "read-only" ? "read-only" : "write" });
      if (!entry) throw new Error("Runtime returned an invalid session reference.");
      return entry;
    }));
    const after = await runtimeChatState();
    const identity = chats => JSON.stringify(chats.map(chat => [chat.sid, chat.cwd, chat.workspaceAccess?.mode, chat.epoch]));
    if (generation !== runtimeGeneration || !navigationReady || selected !== activeChatSid || identity(before.chats) !== identity(after.chats)) return;
    const index = Math.max(0, before.chats.findIndex(chat => chat.sid === selected));
    const selectedWorkspace = before.chats[index]?.cwd;
    if (selectedWorkspace) workspace = selectedWorkspace;
    const openChats = [...entries, ...recoveryFailures.map(item => item.entry)];
    // Do not silently truncate unresolved recovery references.
    if (openChats.length > 8) return;
    const next = { ...desktopState, lastWorkspace: workspace, openChats, activeChatIndex: index };
    if (JSON.stringify(next) !== JSON.stringify(desktopState)) desktopState = saveDesktopState(statePath, next);
  } catch (error) {
    // A partial snapshot must never overwrite a complete checkpoint.
    console.error("Desktop recovery checkpoint deferred:", error.message);
  } finally { navigationBusy = false; }
}

async function restoreNavigation(initialSid) {
  if (navigationRestore) return navigationRestore;
  navigationRestore = (async () => {
    const generation = runtimeGeneration;
    const currentGeneration = () => {
      if (generation !== runtimeGeneration || quitting) throw new Error("Chat restoration was interrupted; saved references were retained.");
    };
    const post = (path, body) => { currentGeneration(); return runtimePost(path, body); };
    const saved = desktopState.openChats;
    const initial = await runtimeChatState();
    // HTTP readiness precedes extension initialization on a cold managed install.
    // Keep the recovery overlay until a real agent answers; retain saved chats if
    // startup fails, and never retry a session mutation against a new runtime.
    const state = await waitForRuntimeState(runtimeRpc, initialSid, {
      isCurrent: () => generation === runtimeGeneration && !quitting,
    });
    let result = { restored: [], failures: [], activeSid: initialSid };
    if (saved.length && initial.chats.length === 1 && initial.chats[0].sid === initialSid) {
      if (state.data?.messageCount === 0 && !initial.chats[0].busy) {
        await post("/chat-close", { sid: initialSid });
        result = await restoreSavedChats({
          entries: saved, activeIndex: desktopState.activeChatIndex,
          create: body => post("/chat-new", body),
          resume: body => post("/resume", body),
          close: body => post("/chat-close", body),
        });
        if (!result.activeSid) {
          // Retain a usable chat without escalating access when restoration fails.
          const fallback = await post("/chat-new", { cwd: workspace, workspaceAccess: "read-only" });
          result.activeSid = fallback.sid;
        }
      }
    }
    if (saved.length && !result.restored.length && !result.failures.length) {
      result.failures = saved.map((entry, index) => ({ entry, index, error: "The startup chat was already in use. Saved chats were kept for a later restart." }));
    }
    currentGeneration();
    const current = await runtimeChatState();
    currentGeneration();
    recoveryFailures = result.failures;
    activeChatSid = result.activeSid;
    navigationReady = true;
    checkpointTimer = setInterval(() => { void checkpointNavigation(); }, 10000);
    return { ...current, activeSid: result.activeSid, failures: result.failures.map(item => ({ cwd: item.entry.cwd, error: item.error })) };
  })();
  return navigationRestore;
}

function registerIpc() {
  ipcMain.handle("coop:restore-navigation", async (event, input) => {
    if (!trustedSender(event) || !SID.test(input?.sid || "")) throw new Error("Invalid navigation request.");
    return restoreNavigation(input.sid);
  });
  ipcMain.handle("coop:active-chat", (event, input) => {
    if (!trustedSender(event) || !SID.test(input?.sid || "")) throw new Error("Invalid active chat.");
    if (navigationReady) activeChatSid = input.sid;
    return { ok: true };
  });
  ipcMain.handle("coop:choose-workspace", async (event, input) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    return selectRuntimeWorkspace({
      sid: input?.sid,
      choose: () => chooseWorkspace(),
      change: (body) => runtimePost("/chdir", body),
      accept: (cwd) => {
        workspace = cwd;
        desktopState = saveDesktopState(statePath, { ...desktopState, lastWorkspace: cwd });
      },
    });
  });
  ipcMain.handle("coop:get-shell-info", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    return { shell: "electron", platform: process.platform, packaged: app.isPackaged, version: app.getVersion(), theme: desktopState.theme, runtimeSource, runtimeVersions, updates: updateTrustSummary(packagedUpdateTrust) };
  });
  ipcMain.handle("coop:set-theme", (event, input) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    if (!THEMES.has(input?.theme)) throw new Error("Invalid Coop theme.");
    desktopState = saveDesktopState(statePath, { ...desktopState, theme: input.theme });
    mainWindow?.setBackgroundColor(THEME_BACKGROUNDS[desktopState.theme]);
    return { ok: true, theme: desktopState.theme };
  });
  ipcMain.handle("coop:notify", (event, input) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    const title = cleanText(input?.title, 100);
    const body = cleanText(input?.body, 500);
    if (!title || !body || !Notification.isSupported()) return { ok: false };
    new Notification({ title, body, silent: true }).show();
    return { ok: true };
  });
  ipcMain.handle("coop:terminal-handoff", async (event, input) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    if (!input || !TERMINAL_MODES.has(input.mode) || !SID.test(input.sid || "")) throw new Error("Invalid terminal handoff request.");
    const prepared = await runtimePost("/terminal-handoff", { mode: input.mode, sid: input.sid });
    return launchNativeTerminal(prepared, { coopExecutable, agentDir: managedAgentDir });
  });
  ipcMain.handle("coop:start-model-login", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    return launchNativeModelLogin({ cwd: workspace, coopExecutable, agentDir: managedAgentDir });
  });
  ipcMain.handle("coop:export-session", async (event, input) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer.");
    if (!SID.test(input?.sid || "")) throw new Error("Invalid session export request.");
    const exported = await runtimeRpc({ type: "export_html", sid: input.sid });
    const source = runtimeExportSource(exported);
    const selected = await dialog.showSaveDialog(mainWindow || undefined, {
      title: "Export Coop session",
      defaultPath: basename(source),
      filters: [{ name: "HTML", extensions: ["html"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (selected.canceled || !selected.filePath) return { ok: false, cancelled: true };
    return saveRuntimeExport(exported, selected.filePath);
  });
}

function sendMenuAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("coop:menu-action", action);
}

async function downloadUpdateWithProgress() {
  const closeDialog = new AbortController();
  const window = mainWindow;
  window.setProgressBar(0);
  let progress = Promise.resolve();
  try {
    progress = dialog.showMessageBox(window, {
    type: "info", title: "Coop Desktop updates", message: "Downloading update…",
    detail: "Your current session will stay open.", buttons: ["Cancel"], cancelId: 0,
    signal: closeDialog.signal,
    }).then(() => { if (!closeDialog.signal.aborted) updateController.cancel(); }).catch(() => { updateController.cancel(); });
    await updateController.download({ onProgress: ({ received, total }) => {
      if (!window.isDestroyed()) window.setProgressBar(received / total);
    } });
  } finally {
    closeDialog.abort();
    await progress;
    if (!window.isDestroyed()) window.setProgressBar(-1);
  }
}

async function installUpdateWithProgress() {
  if (!runtime?.ready) throw new Error("Coop Runtime must be available before starting the update handoff.");
  const request = await updateController.installationRequest();
  const userData = app.getPath("userData");
  const bundle = inspectManagedRuntime(join(process.resourcesPath, "managed-runtime"));
  updateHandoff = launchUpdateHelper({ nodePath: bundle.node,
    helperPath: join(process.resourcesPath, "update-helper", "update-helper.mjs"),
    logPath: join(userData, "update-helper.log"),
    request: { ...request, parentPid: process.pid, runtimePid: runtime.ready.runtimePid,
      currentVersion: app.getVersion(), appPath: resolve(dirname(process.execPath), "..", ".."),
      userData, workspace, versionRoot: join(userData, "update-versions") } });
  const closeDialog = new AbortController();
  const window = mainWindow;
  let cancelled = false;
  window.setProgressBar(2);
  const progress = dialog.showMessageBox(window, {
    type: "info", title: "Coop Desktop updates", message: "Preparing installation…",
    detail: "Coop will close and restart when the update is ready.", buttons: ["Cancel"], cancelId: 0, signal: closeDialog.signal,
  }).then(async () => { if (!closeDialog.signal.aborted) { cancelled = true; await updateHandoff?.cancel(); } })
    .catch(async () => { cancelled = true; await updateHandoff?.cancel(); });
  try {
    await updateHandoff.prepared;
    if (cancelled || quitting) return;
    updateInstallRequested = true;
    app.quit();
  } catch (error) { if (!cancelled && !quitting) throw error; }
  finally {
    closeDialog.abort();
    await progress;
    if (!window.isDestroyed()) window.setProgressBar(-1);
    if (!updateInstallRequested) { await updateHandoff?.cancel(); updateHandoff = null; }
  }
}

async function checkForUpdates() {
  if (updateDialogActive || !updateController || !mainWindow || mainWindow.isDestroyed()) return;
  updateDialogActive = true;
  try {
    let result;
    try { result = await updateController.recover(); }
    catch {
      if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
      const retry = await dialog.showMessageBox(mainWindow, {
        type: "warning", title: "Coop Desktop updates", message: "A previous download could not be verified.",
        detail: "It will not be installed. Check for a fresh update?", buttons: ["Check again", "Cancel"], defaultId: 1, cancelId: 1,
      });
      if (retry.response !== 0) return;
    }
    if (!result) result = await updateController.check();
    if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
    if (result.status === "available") {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "info", title: "Coop Desktop updates", message: `Coop Desktop ${result.version} is available.`,
        detail: `Download size: ${Math.ceil(result.size / (1024 * 1024))} MB.`,
        buttons: ["Download", "Later"], defaultId: 1, cancelId: 1,
      });
      if (choice.response !== 0 || quitting) return;
      await downloadUpdateWithProgress();
      result = updateController.status();
    }
    if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
    const canInstall = result.status === "staged" && runtimeSource === "managed" && process.platform === "darwin";
    const finalChoice = await dialog.showMessageBox(mainWindow, {
      type: "info", title: "Coop Desktop updates",
      message: result.status === "staged" ? `Coop Desktop ${result.version} is downloaded and verified.`
        : result.status === "current" ? "No newer verified update is available."
        : "Updates are not configured for this development build.",
      detail: canInstall ? "Coop will save your open chats, close, install the update, check the runtime, and restart. The previous app is kept for recovery."
        : result.status === "staged" ? "The download will be checked again after restart. Automatic installation is not yet available on this platform." : "",
      buttons: canInstall ? ["Install and restart", "Later"] : ["OK"], defaultId: canInstall ? 1 : 0, cancelId: canInstall ? 1 : 0,
    });
    if (canInstall && finalChoice.response === 0 && !quitting) await installUpdateWithProgress();
  } catch {
    if (updateController.status().status !== "cancelled" && mainWindow && !mainWindow.isDestroyed() && !quitting) await dialog.showMessageBox(mainWindow, {
      type: "error", title: "Coop Desktop updates", message: "Could not prepare the update.",
      detail: "No update was applied. Try again later.", buttons: ["OK"],
    });
  } finally { updateDialogActive = false; }
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Workspace…", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("open-workspace") },
        { type: "separator" },
        { label: "Open New Terminal in Workspace", accelerator: "CmdOrCtrl+Shift+T", click: () => sendMenuAction("terminal-open") },
        { label: "Clone Session to Terminal", click: () => sendMenuAction("terminal-clone") },
        { label: "Move Session to Terminal", click: () => sendMenuAction("terminal-move") },
        { label: "Export Session…", accelerator: "CmdOrCtrl+Shift+E", click: () => sendMenuAction("session-export") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        {
          label: "Theme",
          submenu: [
            { label: "Modern Dark", click: () => sendMenuAction("theme-modern-dark") },
            { label: "Modern Light", click: () => sendMenuAction("theme-modern-light") },
            { label: "Retro Messenger", click: () => sendMenuAction("theme-retro-messenger") },
          ],
        },
        { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Check for Updates…", click: () => { void checkForUpdates(); } }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  if (managedResourcePresent && process.platform === "darwin" && !await canStartMacApplication({
    appPath: resolve(dirname(process.execPath), "../.."), probe: !!updateProbeToken, parentPid: process.ppid,
  })) {
    if (!updateProbeToken) {
      // macOS runs unparented dialogs synchronously and ignores their signal.
      const noticeWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const closeDialog = new AbortController();
      const timer = setTimeout(() => closeDialog.abort(), 2500);
      try {
        await dialog.showMessageBox(noticeWindow, { type: "info", title: "Coop Desktop update", message: "Coop is finishing an update",
          detail: "Coop will reopen automatically when installation or recovery finishes.", buttons: ["Close"], signal: closeDialog.signal });
      } finally { clearTimeout(timer); noticeWindow.destroy(); }
    }
    app.quit();
    return;
  }
  statePath = join(app.getPath("userData"), "desktop-state.json");
  desktopState = loadDesktopState(statePath);
  packagedUpdateTrust = loadPackagedUpdateTrust({ packaged: app.isPackaged, appPath: app.getAppPath() });
  updateController = createUpdateController({
    feed: loadPackagedUpdateFeed({ packaged: app.isPackaged, appPath: app.getAppPath() }),
    trustStore: packagedUpdateTrust.trustStore, currentVersion: app.getVersion(),
    downloadDir: join(app.getPath("userData"), "update-downloads"),
  });
  workspace = await selectInitialWorkspace();
  if (!workspace) { app.quit(); return; }
  await startRuntime();
  configurePermissions();

  const bounds = restoreWindowBounds(desktopState.windowBounds, screen.getAllDisplays().map(display => display.workArea));
  mainWindow = new BrowserWindow({
    width: bounds?.width || 1440,
    height: bounds?.height || 920,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: THEME_BACKGROUNDS[desktopState.theme],
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void confirmAndOpenExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    try { if (new URL(target).origin !== allowedOrigin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => { if (!updateProbeToken) mainWindow?.show(); });
  mainWindow.on("close", () => {
    if (!mainWindow?.isDestroyed()) desktopState = saveDesktopState(statePath, { ...desktopState, lastWorkspace: workspace, windowBounds: mainWindow.getBounds() });
  });
  installMenu();
  await loadRuntimeWindow();
  if (updateProbeToken) {
    const deadline = Date.now() + 60000;
    // Navigation readiness is set only by the trusted renderer's startup IPC,
    // after the app script has connected to a real chat through the preload.
    while (!navigationReady && !quitting && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!navigationReady || quitting || !activeChatSid) throw new Error("Desktop UI did not become ready.");
    await waitForRuntimeState(runtimeRpc, activeChatSid, { isCurrent: () => !quitting });
    await runtime.stop({ graceMs: 5000 });
    // Windows pipes are asynchronous. Do not enter Electron shutdown until the
    // supervisor's acknowledgement has actually been flushed to its pipe.
    await new Promise((resolveWrite, rejectWrite) => {
      process.stdout.write(JSON.stringify({ type: "desktop.update-health", token: updateProbeToken, version: app.getVersion() }) + "\n",
        error => error ? rejectWrite(error) : resolveWrite());
    });
    app.quit();
    return;
  }
  if (managedResourcePresent && !quitting && mainWindow && !mainWindow.isDestroyed()) {
    await presentUpdateOutcome({ userData: app.getPath("userData"), currentVersion: app.getVersion(),
      show: options => dialog.showMessageBox(mainWindow, options) });
    void pruneCompletedRecoveryJobs({ userData: app.getPath("userData") }).catch(() => {});
  }
}

registerIpc();
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow).catch((error) => {
    if (updateProbeToken) { console.error("Desktop health probe failed:", error.message); app.quit(); return; }
    if (error.code === "PROFILE_SELECTION_CANCELLED") { app.quit(); return; }
    dialog.showErrorBox("Coop Desktop could not start", `${error.message}\n\n${managedResourcePresent
      ? "Retry Coop Desktop. If startup keeps failing, report this message with the Desktop build version."
      : "Run coop doctor from the selected Coop installation for prerequisite checks."}`);
    app.quit();
  });
}

app.on("activate", () => mainWindow?.show());
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  updateController?.cancel();
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  clearInterval(checkpointTimer);
  void (async () => {
    // Capture while RPC is still available, before terminating Pi.
    if (navigationBusy) {
      const deadline = Date.now() + 20000;
      while (navigationBusy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    }
    await checkpointNavigation();
    if (mainWindow && !mainWindow.isDestroyed()) desktopState = saveDesktopState(statePath, { ...desktopState, windowBounds: mainWindow.getBounds() });
    await updateController?.wait();
    if (!updateInstallRequested) await updateHandoff?.cancel();
    await runtime?.stop();
    if (updateInstallRequested) await updateHandoff.apply();
  })().catch(async () => { await updateHandoff?.cancel(); }).finally(() => app.exit(0));
});
