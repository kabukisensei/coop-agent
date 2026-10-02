// coop desktop: the Electron main process (master plan row D1b).
//
// One window per working folder, each with its own Pi in RPC mode, started
// from the launch spec `coop desktop` built with the same Build-CoopPiArgs the
// terminal uses. The renderer is untrusted: it is sandboxed, sees only the
// small bridge in preload.cjs, and every command it sends is rebuilt from an
// allowlist (lib/rpc-commands.mjs) before it reaches Pi.
import { app, BrowserWindow, ipcMain, protocol, session, dialog, shell, clipboard, nativeTheme, Menu } from "electron";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, piArgv, piEnv } from "./lib/spec.mjs";
import { PiSession } from "./lib/pi-session.mjs";
import { buildCommand, buildUiResponse } from "./lib/rpc-commands.mjs";
import { listSessions, isSessionPath } from "./lib/sessions.mjs";
import { consoleProcess } from "./lib/terminal.mjs";
import { resolveAsset, isAppUrl, CSP, APP_ORIGIN } from "./lib/serve.mjs";
import { readBranch } from "./lib/git.mjs";
import { listFiles, rankFiles } from "./lib/files.mjs";
import { loadSettings, saveSettings, THEMES } from "./lib/settings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(HERE, "renderer");
const MAX_QUEUE = 20_000;
const MAX_COPY = 4 * 1024 * 1024;
// Pi answers these only when the work is done, which can include a question
// an extension asks the user (a /start menu, an approval), so no deadline.
const WAITS_ON_WORK = new Set(["prompt", "steer", "follow_up", "bash", "compact", "new_session", "switch_session", "fork", "clone"]);

// The spec and the Warehouse MCP token arrive in the environment (never argv
// or disk) and leave it at once, so no later child inherits them.
const initial = { spec: process.env.COOP_DESKTOP_SPEC || "", token: process.env.COOP_FABRIC_MCP_TOKEN || "" };
const dataRoot = process.env.COOP_DESKTOP_DATA || "";
delete process.env.COOP_DESKTOP_SPEC;
delete process.env.COOP_FABRIC_MCP_TOKEN;
delete process.env.COOP_DESKTOP_DATA;

app.setName("coop");
// The window's data lives under coop's profile dir (<profile>\desktop\data, from
// coop desktop), so a redirected sandbox profile keeps it too; one folder per
// coop checkout, so a sandbox clone never shares the real one's window.
const checkout = createHash("sha256").update(HERE.toLowerCase()).digest("hex").slice(0, 12);
app.setPath("userData", join(isAbsolute(dataRoot) ? dataRoot : join(app.getPath("appData"), "coop", "desktop"), checkout));
const settingsFile = join(app.getPath("userData"), "settings.json");
let settings = loadSettings(settingsFile);

protocol.registerSchemesAsPrivileged([
  { scheme: "coop", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } },
]);

/** @type {Map<number, any>} window state by webContents id */
const windows = new Map();
const runningPis = new Set();

function send(state, channel, payload) {
  if (state.win.isDestroyed() || state.win.webContents.isDestroyed()) return;
  if (!state.ready) {
    if (state.queue.length < MAX_QUEUE) state.queue.push([channel, payload]);
    return;
  }
  // A page that is reloading or crashing has no frame to receive this; the
  // reloaded page asks for the state again (coop:ready).
  try { state.win.webContents.send(channel, payload); } catch { /* frame gone */ }
}

function broadcast(channel, payload) {
  for (const state of windows.values()) send(state, channel, payload);
}

function startPi(state, extraArgs = []) {
  const { command, args } = piArgv(state.spec);
  const pi = new PiSession({
    command,
    args: [...args, ...extraArgs],
    cwd: state.spec.cwd,
    env: piEnv(state.spec, process.env, { fabricToken: state.token }),
  });
  state.pi = pi;
  pi.on("event", (message) => {
    if (state.pi !== pi) return;
    if (message.type === "extension_ui_request" && message.method === "setTitle") {
      const title = typeof message.title === "string" ? message.title.replace(/[\0-\x1f]/g, " ").slice(0, 120) : "";
      if (title && !state.win.isDestroyed()) state.win.setTitle(title);
      return;
    }
    send(state, "pi:event", message);
  });
  pi.on("protocol-error", (text) => send(state, "pi:notice", { level: "error", message: String(text) }));
  pi.on("exit", ({ code, reason, stderr }) => {
    runningPis.delete(pi);
    if (state.pi !== pi) return;
    send(state, "pi:exit", { code, reason, stderr: String(stderr || "").slice(-4000) });
  });
  runningPis.add(pi);
  try {
    pi.start();
  } catch (error) {
    runningPis.delete(pi);
    send(state, "pi:exit", { code: null, reason: error.message, stderr: "" });
  }
}

function windowInfo(state) {
  const { spec } = state;
  return {
    version: spec.version,
    cwd: spec.cwd,
    folder: basename(spec.cwd) || spec.cwd,
    branch: readBranch(spec.cwd),
    platform: process.platform,
    theme: settings.theme,
    themes: THEMES,
    systemDark: nativeTheme.shouldUseDarkColors,
    canOpenTerminal: process.platform === "win32" && Boolean(spec.coop),
    canOpenFolder: Boolean(spec.coop),
    loginPresent: spec.loginPresent,
    notices: state.noticesShown ? [] : spec.notices,
  };
}

function openWindow(rawSpec, token) {
  let spec;
  try {
    spec = parseSpec(rawSpec);
  } catch (error) {
    dialog.showErrorBox("coop", `coop could not open its window: ${error.message}`);
    if (!BrowserWindow.getAllWindows().length) app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: settings.width,
    height: settings.height,
    minWidth: 640,
    minHeight: 420,
    title: `coop - ${basename(spec.cwd) || spec.cwd}`,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1318" : "#f6f7f9",
    autoHideMenuBar: true,
    icon: existsSync(join(HERE, "..", "themes", "coop.ico")) ? join(HERE, "..", "themes", "coop.ico") : undefined,
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: process.env.COOP_DESKTOP_DEVTOOLS === "1",
    },
  });
  const state = { win, spec, token, pi: null, ready: false, queue: [], sessionFile: "" };
  windows.set(win.webContents.id, state);
  if (settings.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", () => {
    if (windows.size === 1) {
      const maximized = win.isMaximized();
      const [width, height] = maximized ? [settings.width, settings.height] : win.getSize();
      try { settings = saveSettings(settingsFile, { ...settings, width, height, maximized }); } catch { /* keep going */ }
    }
  });
  const id = win.webContents.id;
  win.on("closed", () => {
    windows.delete(id);
    if (state.pi) state.pi.stop();
  });
  // A renderer that crashed or reloaded subscribes again; replaying keeps
  // dialogs Pi is waiting on visible.
  win.webContents.on("did-start-loading", () => { state.ready = false; });
  // A crashed page is reloaded once a minute at most; Pi keeps running meanwhile.
  let lastReload = 0;
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed() || Date.now() - lastReload < 60_000) return;
    lastReload = Date.now();
    win.webContents.reload();
  });
  win.loadURL(`${APP_ORIGIN}/index.html`);
  startPi(state);
}

// --- IPC ---------------------------------------------------------------------

function stateFor(event) {
  const state = windows.get(event.sender.id);
  if (!state || !event.senderFrame || !isAppUrl(event.senderFrame.url)) throw new Error("not a coop window");
  return state;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const state = stateFor(event);
    try {
      return await fn(state, ...args);
    } catch (error) {
      return { success: false, error: error && error.message ? error.message : String(error) };
    }
  });
}

function piResult(response) {
  return { success: Boolean(response.success), data: response.data, error: response.error };
}

async function currentSessionFile(state) {
  if (state.pi && !state.pi.exited) {
    try {
      const response = await state.pi.request({ type: "get_state" });
      if (response.success && response.data && typeof response.data.sessionFile === "string") state.sessionFile = response.data.sessionFile;
    } catch { /* fall back to the last known file */ }
  }
  return state.sessionFile;
}

function isDialog(channel, payload) {
  return channel === "pi:event" && payload && payload.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(payload.method);
}

handle("coop:ready", (state) => {
  state.ready = true;
  const queued = state.queue;
  state.queue = [];
  // Dialogs come from Pi's open list instead, so a reloaded window shows the
  // questions Pi is still waiting on and none it already has an answer for.
  for (const [channel, payload] of queued) if (!isDialog(channel, payload)) send(state, channel, payload);
  if (state.pi && !state.pi.exited) for (const request of state.pi.openDialogs()) send(state, "pi:event", request);
  const info = windowInfo(state);
  state.noticesShown = true;
  return info;
});

handle("coop:info", (state) => windowInfo(state));

handle("coop:command", async (state, input) => {
  const command = buildCommand(input);
  if (!state.pi || state.pi.exited) return { success: false, error: "coop is not running in this window; restart it" };
  const timeoutMs = WAITS_ON_WORK.has(command.type) ? 0 : undefined;
  const response = await state.pi.request(command, { timeoutMs });
  if (command.type === "get_state" && response.success && response.data && typeof response.data.sessionFile === "string") {
    state.sessionFile = response.data.sessionFile;
  }
  return piResult(response);
});

handle("coop:answer", (state, id, answer) => {
  if (!state.pi || typeof id !== "string") return { success: false, error: "no such question" };
  const request = state.pi.dialog(id);
  if (!request) return { success: false, error: "that question was already answered" };
  return { success: state.pi.answer(buildUiResponse(request, answer)) };
});

handle("coop:sessions", (state) => ({ success: true, data: listSessions({ ...process.env, ...state.spec.env }, state.spec.cwd) }));

// @ mentions: the folder's file list, read once and kept for 20 seconds.
handle("coop:files", async (state, query) => {
  if (!state.files || Date.now() - state.files.at > 20_000) state.files = { at: Date.now(), paths: await listFiles(state.spec.cwd) };
  return { success: true, data: rankFiles(state.files.paths, String(query || "").slice(0, 200)) };
});

handle("coop:switch-session", async (state, path) => {
  if (!isSessionPath({ ...process.env, ...state.spec.env }, path)) return { success: false, error: "that is not one of coop's saved sessions" };
  return piResult(await state.pi.request({ type: "switch_session", sessionPath: path }, { timeoutMs: 0 }));
});

handle("coop:export", async (state) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const result = await dialog.showSaveDialog(state.win, {
    title: "Export this session",
    defaultPath: join(state.spec.cwd, `coop-session-${stamp}.html`),
    filters: [{ name: "Web page", extensions: ["html"] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };
  return piResult(await state.pi.request({ type: "export_html", outputPath: result.filePath }));
});

handle("coop:open-terminal", async (state) => {
  if (process.platform !== "win32" || !state.spec.coop) return { success: false, error: "Open in terminal works on Windows" };
  const sessionFile = await currentSessionFile(state);
  const proc = consoleProcess({ mode: "terminal", coop: state.spec.coop, cwd: state.spec.cwd, session: sessionFile && existsSync(sessionFile) ? sessionFile : "", env: process.env });
  spawn(proc.command, proc.args, proc.options).unref();
  return { success: true };
});

handle("coop:open-folder", async (state) => {
  if (!state.spec.coop) return { success: false, error: "this window was not started by coop desktop" };
  const result = await dialog.showOpenDialog(state.win, { title: "Open a folder in a new coop window", defaultPath: state.spec.cwd, properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
  const folder = result.filePaths[0];
  if (process.platform === "win32") {
    const proc = consoleProcess({ mode: "window", coop: state.spec.coop, cwd: folder, env: process.env });
    spawn(proc.command, proc.args, proc.options).unref();
  } else {
    // Development on macOS or Linux: run the same command without a console.
    spawn("pwsh", ["-NoLogo", "-NoProfile", "-File", state.spec.coop, "desktop"], { cwd: folder, env: process.env, detached: true, stdio: "ignore" }).unref();
  }
  return { success: true };
});

handle("coop:restart", async (state) => {
  const sessionFile = await currentSessionFile(state);
  if (state.pi) await state.pi.stop();
  startPi(state, sessionFile && existsSync(sessionFile) ? ["--session", sessionFile] : []);
  return { success: true };
});

handle("coop:theme", (state, theme) => {
  if (!THEMES.includes(theme)) return { success: false, error: "unknown theme" };
  settings = saveSettings(settingsFile, { ...settings, theme });
  broadcast("coop:theme", { theme, systemDark: nativeTheme.shouldUseDarkColors });
  return { success: true };
});

handle("coop:copy", (state, text) => {
  if (typeof text !== "string" || text.length > MAX_COPY) return { success: false, error: "nothing to copy" };
  clipboard.writeText(text);
  return { success: true };
});

handle("coop:open-external", async (state, url) => {
  let parsed;
  try { parsed = new URL(url); } catch { return { success: false, error: "not a web address" }; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { success: false, error: "only web addresses open from coop" };
  const choice = await dialog.showMessageBox(state.win, {
    type: "question",
    buttons: ["Open", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Open this address in your browser?",
    detail: parsed.href.slice(0, 2000),
  });
  if (choice.response !== 0) return { success: false, cancelled: true };
  await shell.openExternal(parsed.href);
  return { success: true };
});

handle("coop:zoom", (state, step) => {
  const contents = state.win.webContents;
  const level = step === 0 ? 0 : Math.max(-3, Math.min(4, contents.getZoomLevel() + (step > 0 ? 0.5 : -0.5)));
  contents.setZoomLevel(level);
  return { success: true, level };
});

// --- App lifecycle -----------------------------------------------------------

function harden() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // The window never loads anything from the network.
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (_details, callback) => callback({ cancel: true }));
  protocol.handle("coop", async (request) => {
    const asset = resolveAsset(RENDERER, request.url);
    if (!asset) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(asset.file);
      return new Response(body, { headers: { "content-type": asset.type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  contents.on("will-redirect", (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

if (!app.requestSingleInstanceLock({ spec: initial.spec, token: initial.token })) {
  // Another coop window process is running: it opens this folder's window.
  app.quit();
} else {
  app.on("second-instance", (_event, _argv, _cwd, data) => {
    if (data && typeof data.spec === "string") openWindow(data.spec, typeof data.token === "string" ? data.token : "");
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    harden();
    nativeTheme.on("updated", () => broadcast("coop:theme", { theme: settings.theme, systemDark: nativeTheme.shouldUseDarkColors }));
    openWindow(initial.spec, initial.token);
    initial.token = "";
  });
}

app.on("window-all-closed", () => app.quit());

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping || runningPis.size === 0) return;
  // Close each Pi's stdin and wait, so MCP servers and tools end with it.
  event.preventDefault();
  stopping = true;
  Promise.allSettled([...runningPis].map((pi) => pi.stop())).finally(() => app.quit());
});
