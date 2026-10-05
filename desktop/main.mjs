// coop desktop: the Electron main process (master plan row D1b).
//
// One window per working folder, each with its own Pi in RPC mode, started
// from the launch spec `coop desktop` built with the same Build-CoopPiArgs the
// terminal uses. The renderer is untrusted: it is sandboxed, sees only the
// small bridge in preload.cjs, and every command it sends is rebuilt from an
// allowlist (lib/rpc-commands.mjs) before it reaches Pi.
import { app, BrowserWindow, ipcMain, protocol, session, dialog, shell, clipboard, nativeTheme, Menu, Notification } from "electron";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, piArgv, piEnv } from "./lib/spec.mjs";
import { PiSession } from "./lib/pi-session.mjs";
import { IMAGE_LIMITS, buildCommand, buildUiResponse } from "./lib/rpc-commands.mjs";
import { listSessions, isSessionPath } from "./lib/sessions.mjs";
import { consoleProcess } from "./lib/terminal.mjs";
import { resolveAsset, isAppUrl, CSP, APP_ORIGIN } from "./lib/serve.mjs";
import { readBranch } from "./lib/git.mjs";
import { listFiles, rankFiles } from "./lib/files.mjs";
import { loadSettings, saveSettings, THEMES } from "./lib/settings.mjs";
import { listChanges, fileDiff } from "./lib/changes.mjs";
import { readStandards, readSnapshot } from "./lib/standards-view.mjs";
import { loadProject, previewProject, saveProject } from "./lib/project-form.mjs";
import { DocsSetupRun, AnswerError, docsLocation, listDocsPages, pickedPathAnswer, readDocsPage, runDocsBuild } from "./lib/docs-setup.mjs";
import { attach, forget, pruneStore, findPdfjs, LIMITS as ATTACH_LIMITS } from "./lib/attachments.mjs";
import { loadSplash } from "./lib/splash.mjs";
import { vibesDir, loadVibes, vibeSets, userName, fillVibe, pickVibe } from "./lib/vibes.mjs";
import { bootstrapProcess, doctorReport, findCoop, folderArgument, packagedPaths } from "./lib/bootstrap.mjs";
import { menuTemplate, notificationFor } from "./lib/menu.mjs";
import { restartOnce } from "./lib/restart.mjs";
import { profileDir } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(HERE, "renderer");
// The checkout this code runs from: the terminal's clone, or, in the installed
// package (D1c), the staged copy inside the asar (desktop/, lib/, vibes/, the
// splash and the icon). Child processes cannot read an asar, so the package
// runs the standards reader on the terminal's checkout (repoRootFor) and keeps
// pdf.js and the PDF script unpacked beside the asar (packagedPaths).
const REPO = join(HERE, "..");
const PACKAGED = app.isPackaged;
// Chromium's own log lines (the GPU process's "GetGpuDriverOverlayInfo: Failed
// to retrieve video device" on some Windows drivers) otherwise land in the
// terminal that ran `coop desktop`. They are not coop's and change nothing;
// keep only fatal ones. Must run before the app is ready.
app.commandLine.appendSwitch("log-level", "3");
const UNPACKED = PACKAGED ? packagedPaths(process.resourcesPath) : { pdfjsDir: "", pdfScript: "" };
const MAX_QUEUE = 20_000;
const MAX_COPY = 4 * 1024 * 1024;
// Pi answers these only when the work is done, which can include a question
// an extension asks the user (a /start menu, an approval), so no deadline.
const WAITS_ON_WORK = new Set(["prompt", "steer", "follow_up", "bash", "compact", "new_session", "switch_session", "fork", "clone"]);

// The spec and the Warehouse MCP token arrive in the environment (never argv
// or disk) and leave it at once, so no later child inherits them.
const initial = { spec: process.env.COOP_DESKTOP_SPEC || "", token: process.env.COOP_FABRIC_MCP_TOKEN || "" };
// The package started from its shortcut has no spec: its data goes where coop
// desktop would put it (the profile's desktop\data), so the process that
// coop.ps1 then starts with the spec shares this one's single-instance lock.
const dataRoot = process.env.COOP_DESKTOP_DATA || (PACKAGED ? join(profileDir(process.env), "desktop", "data") : "");
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
// Text pulled out of attached documents (D1b2) lives beside the settings; a
// week-old extract is of no use to anyone, so the store is pruned at start.
const attachmentStore = join(app.getPath("userData"), "attachments");
pruneStore(attachmentStore);
// pdf.js is the window runtime's second package, next to Electron; the
// installed package carries it unpacked beside its asar.
const pdfjsDir = PACKAGED ? UNPACKED.pdfjsDir : findPdfjs(process.execPath);

/** The checkout whose scripts a child node process may run: the terminal's. */
function repoRootFor(spec) {
  return PACKAGED && spec.coop ? dirname(dirname(spec.coop)) : REPO;
}
const splashArt = loadSplash(REPO);

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
    notifyInBackground(state, message);
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

// A finished turn or a question while the window is in the background: one
// Windows notification (clicking it brings the window up) and a taskbar flash,
// cleared when the window gets focus. Off with the Settings toggle.
function notifyInBackground(state, message) {
  if (!settings.notify || state.win.isDestroyed() || state.win.isFocused()) return;
  const body = notificationFor(message, { folder: basename(state.spec.cwd) });
  if (!body) return;
  try {
    state.win.flashFrame(true);
    if (Notification.isSupported()) {
      const note = new Notification({ title: "coop", body, silent: false });
      note.on("click", () => { if (!state.win.isDestroyed()) { state.win.show(); state.win.focus(); } });
      note.show();
    }
  } catch { /* a desktop without notifications */ }
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
    // The first interactive launch per profile (coop.ps1 sets COOP_FIRST_RUN):
    // the window opens the Start menu once, as the terminal does.
    firstRun: !state.noticesShown && /^(1|true|yes|on)$/i.test(String(spec.env.COOP_FIRST_RUN || "")),
    notify: settings.notify,
    menuBar: settings.menuBar,
    splash: splashArt,
    vibe: vibeFor(state),
    vibeSets: vibeSets(vibesDir(REPO)),
    attachLimits: { perMessage: ATTACH_LIMITS.perMessage, images: ATTACH_LIMITS.images, imageBytes: IMAGE_LIMITS.maxImageBytes, imageTotalBytes: IMAGE_LIMITS.maxTotalBytes },
    pdfReady: Boolean(pdfjsDir),
  };
}

// The terminal rotates a vibe under its splash and on its working line; the
// window asks for one here, from the same files, with the same {user} rule.
function vibeFor(state) {
  return fillVibe(pickVibe(loadVibes(vibesDir(REPO), state.vibeSet)), userName({ ...process.env, ...state.spec.env }));
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
    autoHideMenuBar: !settings.menuBar,
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
  const state = { win, spec, token, pi: null, ready: false, queue: [], sessionFile: "", changes: [], snapshots: new Map(), docs: null, build: null, vibeSet: "" };
  windows.set(win.webContents.id, state);
  if (settings.lastFolder !== spec.cwd) { try { settings = saveSettings(settingsFile, { ...settings, lastFolder: spec.cwd }); } catch { /* keep going */ } }
  if (settings.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("focus", () => { try { win.flashFrame(false); } catch { /* gone */ } });
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
    if (state.docs) state.docs.cancel();
    if (state.build) { try { state.build.kill(); } catch { /* already gone */ } }
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
    const proc = consoleProcess({ mode: "window", coop: state.spec.coop, cwd: folder, env: process.env, app: PACKAGED ? process.execPath : "" });
    spawn(proc.command, proc.args, proc.options).unref();
  } else {
    // Development on macOS or Linux: run the same command without a console.
    spawn("pwsh", ["-NoLogo", "-NoProfile", "-File", state.spec.coop, "desktop"], { cwd: folder, env: process.env, detached: true, stdio: "ignore" }).unref();
  }
  return { success: true };
});

// One restart at a time per window (#286): a second request during the
// shutdown gets the same restart, and a window closed meanwhile starts nothing.
handle("coop:restart", (state) => restartOnce(state, async () => {
  const sessionFile = await currentSessionFile(state);
  if (state.pi) await state.pi.stop();
  if (state.win.isDestroyed()) return { success: false, error: "the window closed during the restart" };
  startPi(state, sessionFile && existsSync(sessionFile) ? ["--session", sessionFile] : []);
  return { success: true };
}));

handle("coop:theme", (state, theme) => {
  if (!THEMES.includes(theme)) return { success: false, error: "unknown theme" };
  settings = saveSettings(settingsFile, { ...settings, theme });
  broadcast("coop:theme", { theme, systemDark: nativeTheme.shouldUseDarkColors });
  installMenu();
  return { success: true };
});

// Window preferences: notifications in the background, the menu bar.
handle("coop:pref", (state, key, value) => {
  if (key === "notify") settings = saveSettings(settingsFile, { ...settings, notify: value !== false });
  else if (key === "menuBar") setMenuBar(value !== false);
  else return { success: false, error: "unknown preference" };
  return { success: true, data: { notify: settings.notify, menuBar: settings.menuBar } };
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

// --- Panes (D1b2): read-only views, and two forms that write only through
// the /setup-project writer and coop-data-doc's own wizard -------------------

// coop's environment for the tools the panes run: the window's own without
// Electron's variables, plus the spec's (piEnv), never the Warehouse token.
function toolEnv(state) {
  return piEnv(state.spec, process.env);
}

handle("coop:changes", async (state) => {
  const result = await listChanges(state.spec.cwd);
  state.changes = result.files;
  return { success: true, data: result };
});

handle("coop:change-diff", async (state, path) => {
  const entry = state.changes.find((file) => file.path === path);
  if (!entry) return { success: false, error: "that file is not in the list of changes; refresh it" };
  return { success: true, data: await fileDiff(state.spec.cwd, entry) };
});

handle("coop:standards", async (state) => {
  const result = await readStandards({ node: state.spec.node, repoRoot: repoRootFor(state.spec), cwd: state.spec.cwd, env: toolEnv(state) });
  state.snapshots = result.snapshots;
  return { success: true, data: { source: result.source, domains: result.domains } };
});

handle("coop:standards-text", async (state, domain) => {
  const path = state.snapshots.get(domain);
  if (!path) return { success: false, error: "no standards are resolved for that domain" };
  return { success: true, data: await readSnapshot(path) };
});

handle("coop:project-load", (state) => ({ success: true, data: loadProject(state.spec.cwd, { env: toolEnv(state) }) }));

handle("coop:project-preview", (state, input) => ({ success: true, data: previewProject(state.spec.cwd, input, { env: toolEnv(state) }) }));

handle("coop:project-save", (state, input, token) => {
  if (typeof token !== "string") return { success: false, error: "review the changes first" };
  return { success: true, data: saveProject(state.spec.cwd, input, token, { env: toolEnv(state) }) };
});

// A folder for a path field, relative to what that field is relative to.
handle("coop:pick-folder", async (state, purpose, current) => {
  const def = typeof current === "string" ? current.slice(0, 2000) : "";
  let base;
  if (purpose === "project") base = loadProject(state.spec.cwd, { env: toolEnv(state) }).root;
  else if (purpose === "docs" && state.docs && state.docs.base) base = state.docs.base;
  else return { success: false, error: "nothing is asking for a folder" };
  const start = isAbsolute(def) ? def : join(base, def || ".");
  const result = await dialog.showOpenDialog(state.win, { title: "Choose a folder", defaultPath: existsSync(start) ? start : base, properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
  return { success: true, data: pickedPathAnswer(base, result.filePaths[0], def) };
});

handle("coop:docs-start", (state) => {
  if (state.docs && !state.docs.finished) return { success: false, error: "the docs setup is already running" };
  const run = new DocsSetupRun({ cwd: state.spec.cwd, env: toolEnv(state), send: (event) => send(state, "coop:docs", event) });
  state.docs = run;
  run.start().catch((error) => send(state, "coop:docs", { type: "done", ok: false, message: error.message }));
  return { success: true };
});

// A reloaded window asks for the question the wizard is waiting on.
handle("coop:docs-state", (state) => {
  const run = state.docs;
  return { success: true, data: { running: Boolean(run && !run.finished), prompt: run && run.pending ? run.pending.prompt : null, building: Boolean(state.build) } };
});

handle("coop:docs-answer", (state, id, value) => {
  if (!state.docs || state.docs.finished) return { success: false, error: "the docs setup is not running" };
  try {
    state.docs.answer(String(id), value);
    return { success: true };
  } catch (error) {
    if (error instanceof AnswerError) return { success: false, error: error.message };
    throw error;
  }
});

handle("coop:docs-cancel", (state) => {
  if (state.docs && !state.docs.finished) state.docs.cancel();
  if (state.build) { try { state.build.kill(); } catch { /* already gone */ } }
  return { success: true };
});

function docsView(state) {
  const where = docsLocation(state.spec.cwd, toolEnv(state));
  return { config: where.config, exists: where.exists, outputDir: where.outputDir, built: where.built, portal: Boolean(where.portal) };
}

handle("coop:docs-location", (state) => ({ success: true, data: docsView(state) }));

handle("coop:docs-build", async (state) => {
  if (state.build) return { success: false, error: "a build is already running" };
  const where = docsLocation(state.spec.cwd, toolEnv(state));
  if (!where.exists) return { success: false, error: "set up the docs first" };
  try {
    const result = await runDocsBuild({
      cwd: state.spec.cwd,
      env: toolEnv(state),
      onChild: (child) => { state.build = child; },
      onLine: (line) => send(state, "coop:docs", { type: "build-line", line }),
    });
    return { success: true, data: { ...result, location: docsView(state) } };
  } finally {
    state.build = null;
  }
});

handle("coop:docs-page", (state, page) => {
  const where = docsLocation(state.spec.cwd, toolEnv(state));
  if (!where.built) return { success: false, error: "the docs are not built yet" };
  return { success: true, data: readDocsPage(where.outputDir, page) };
});

handle("coop:docs-pages", (state) => {
  const where = docsLocation(state.spec.cwd, toolEnv(state));
  if (!where.built) return { success: false, error: "the docs are not built yet" };
  return { success: true, data: listDocsPages(where.outputDir) };
});

// Attachments (D1b2): the picker, one file at a time (validated and read in
// lib/attachments.mjs), and the stored text of a chip removed before sending.
handle("coop:pick-files", async (state) => {
  const result = await dialog.showOpenDialog(state.win, {
    title: "Attach files",
    defaultPath: state.spec.cwd,
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Files coop reads", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "docx", "xlsx", "pptx", "md", "txt", "csv", "tsv", "json", "yml", "yaml", "sql", "dax", "tmdl", "pq", "kql", "py", "ps1", "xml", "html", "log"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return { success: true, data: [] };
  return { success: true, data: result.filePaths.slice(0, ATTACH_LIMITS.perMessage) };
});

handle("coop:attach-file", async (state, path) => ({
  success: true,
  data: await attach(String(path || ""), { cwd: state.spec.cwd, store: attachmentStore, node: state.spec.node, pdfjsDir, script: UNPACKED.pdfScript || undefined, env: { ...process.env, ...state.spec.env } }),
}));

handle("coop:attachment-forget", (state, id) => ({ success: forget(attachmentStore, String(id || "")) }));

handle("coop:vibe", (state, set) => {
  if (typeof set === "string" && set) {
    if (set === "all") state.vibeSet = "";
    else if (vibeSets(vibesDir(REPO)).includes(set)) state.vibeSet = set;
    else return { success: false, error: `no vibe set named ${set}` };
  }
  return { success: true, data: vibeFor(state) };
});

handle("coop:docs-portal", async (state) => {
  const where = docsLocation(state.spec.cwd, toolEnv(state));
  if (!where.portal) return { success: false, error: "the docs portal is not built yet" };
  const error = await shell.openPath(where.portal);
  return error ? { success: false, error } : { success: true };
});

// --- Menu bar ------------------------------------------------------------------

/** The window the menu acts on: the focused one, else the only one. */
function focusedState() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return win ? windows.get(win.webContents.id) : undefined;
}

function installMenu() {
  const template = menuTemplate({
    run: (action) => { const state = focusedState(); if (state) send(state, "coop:menu", { action }); },
    setTheme: (theme) => { if (THEMES.includes(theme)) { settings = saveSettings(settingsFile, { ...settings, theme }); broadcast("coop:theme", { theme, systemDark: nativeTheme.shouldUseDarkColors }); } },
    theme: settings.theme,
    themes: THEMES,
    menuBar: settings.menuBar,
    toggleMenuBar: () => setMenuBar(!settings.menuBar),
    openExternal: (url) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); },
    about: () => {
      const state = focusedState();
      const version = state ? state.spec.version : app.getVersion();
      dialog.showMessageBox(state ? state.win : undefined, { type: "info", title: "About coop", message: `coop ${version}`, detail: PACKAGED ? "The coop window (installed package)." : "The coop window." });
    },
    isMac: process.platform === "darwin",
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setMenuBar(visible) {
  settings = saveSettings(settingsFile, { ...settings, menuBar: visible });
  for (const state of windows.values()) {
    if (state.win.isDestroyed()) continue;
    state.win.setAutoHideMenuBar(!visible);
    state.win.setMenuBarVisibility(visible);
  }
  installMenu();
}

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

// `coop.exe --doctor`: one JSON line about this package, then exit (the CI
// job and `coop doctor` read it; nothing starts).
if (process.argv.includes("--doctor")) {
  const report = JSON.stringify(doctorReport({ version: app.getVersion(), packaged: PACKAGED, execPath: process.execPath, resourcesPath: process.resourcesPath }));
  process.stdout.write(report + "\n", () => app.exit(0));
}

// The installed package started with no spec (its shortcut, or `coop.exe
// <folder>`): ask the terminal coop for one. coop.ps1 starts this exe again
// with the spec; that process hands it over through the single-instance lock
// (second-instance below) and this one opens the window.
async function bootstrap() {
  // The package's own coop snapshot (D1d) answers first; a terminal coop only
  // for a package that carries none.
  const coop = findCoop(process.env, existsSync, process.resourcesPath);
  if (!coop) {
    dialog.showErrorBox("coop", "This coop window package carries no coop of its own and the terminal coop is not installed on this computer.\n\nInstall the newest coop window from the release page (it includes everything), then start it again.");
    app.quit();
    return;
  }
  let folder = folderArgument(process.argv.slice(1));
  if (!folder) {
    const picked = await dialog.showOpenDialog({ title: "Open a folder in coop", defaultPath: settings.lastFolder && existsSync(settings.lastFolder) ? settings.lastFolder : app.getPath("home"), properties: ["openDirectory"], buttonLabel: "Open in coop" });
    if (picked.canceled || !picked.filePaths.length) { app.quit(); return; }
    folder = picked.filePaths[0];
  }
  let proc;
  try {
    proc = bootstrapProcess({ coop, app: process.execPath, cwd: folder, env: process.env });
  } catch (error) {
    dialog.showErrorBox("coop", `coop could not start its window: ${error.message}`);
    app.quit();
    return;
  }
  const child = spawn(proc.command, proc.args, proc.options);
  child.on("error", (error) => {
    dialog.showErrorBox("coop", `coop could not start its window: ${error.message}`);
    app.quit();
  });
  child.on("exit", () => {
    // The console showed coop's own message on a failure; on success the
    // window is open by now, or another window process took the spec.
    setTimeout(() => { if (!windows.size) app.quit(); }, 5000);
  });
}

if (!app.requestSingleInstanceLock({ spec: initial.spec, token: initial.token })) {
  // Another coop window process is running: it opens this folder's window.
  app.quit();
} else {
  app.on("second-instance", (_event, _argv, _cwd, data) => {
    if (data && typeof data.spec === "string" && data.spec) openWindow(data.spec, typeof data.token === "string" ? data.token : "");
  });
  app.whenReady().then(() => {
    installMenu();
    harden();
    nativeTheme.on("updated", () => broadcast("coop:theme", { theme: settings.theme, systemDark: nativeTheme.shouldUseDarkColors }));
    if (!initial.spec && PACKAGED) bootstrap();
    else openWindow(initial.spec, initial.token);
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
