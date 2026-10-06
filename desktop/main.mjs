// coop desktop: the Electron main process (master plan row D1b).
//
// One window per working folder; each tab in it is one session with its own Pi
// in RPC mode (several sessions at once, as each terminal runs its own coop),
// started from the launch spec `coop desktop` built with the same Build-CoopPiArgs the
// terminal uses. The renderer is untrusted: it is sandboxed, sees only the
// small bridge in preload.cjs, and every command it sends is rebuilt from an
// allowlist (lib/rpc-commands.mjs) before it reaches Pi.
import { app, BrowserWindow, WebContentsView, ipcMain, protocol, session, dialog, shell, clipboard, nativeTheme, Menu, Notification, screen } from "electron";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, piArgv, piEnv } from "./lib/spec.mjs";
import { PiSession } from "./lib/pi-session.mjs";
import { IMAGE_LIMITS, buildCommand } from "./lib/rpc-commands.mjs";
import { listSessions, isSessionPath } from "./lib/sessions.mjs";
import { ownerOf, markOpenElsewhere } from "./lib/session-owners.mjs";
import { MAX_TABS, TAB_STRIP_HEIGHT, afterClose, stripRows, tabFor, tabKey } from "./lib/tabs.mjs";
import { consoleProcess } from "./lib/terminal.mjs";
import { resolveAsset, isAppUrl, CSP, APP_ORIGIN } from "./lib/serve.mjs";
import { readBranch } from "./lib/git.mjs";
import { listFiles, rankFiles } from "./lib/files.mjs";
import { fitToScreen, loadSettings, saveSettings, THEMES } from "./lib/settings.mjs";
import { listChanges, fileDiff } from "./lib/changes.mjs";
import { readStandards, readSnapshot, readNote } from "./lib/standards-view.mjs";
import { getTeamProject, loadProject, previewProject, saveProject, shareProject, teamStatus } from "./lib/project-form.mjs";
import { DocsSetupRun, AnswerError, docsLocation, listDocsPages, pickedPathAnswer, readDocsPage, runDocsBuild } from "./lib/docs-setup.mjs";
import { attach, forget, pruneStore, saveUpload, findPdfjs, AttachError, LIMITS as ATTACH_LIMITS } from "./lib/attachments.mjs";
import { loadSplash } from "./lib/splash.mjs";
import { vibesDir, loadVibes, vibeSets, userName, fillVibe, pickVibe } from "./lib/vibes.mjs";
import { bootstrapProcess, doctorReport, findCoop, folderArgument, packagedPaths } from "./lib/bootstrap.mjs";
import { describeProject, forgetProject, projectEntries, rememberProject, startFolder, windowTitle } from "./lib/projects.mjs";
import { menuTemplate, notificationFor } from "./lib/menu.mjs";
import { restartOnce } from "./lib/restart.mjs";
import { CompanionHub } from "./lib/companion-hub.mjs";
import { DeviceStore } from "./lib/companion-devices.mjs";
import { createCompanionServer, DEFAULT_PORT } from "./lib/companion-server.mjs";
import { tailnetOrigin } from "./lib/companion-tailscale.mjs";
import { createPushSender, loadVapid } from "./lib/companion-push.mjs";
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
// A new session in the same Pi: the phone's grant and questions end with the old one.
const SESSION_CHANGES = new Set(["new_session", "switch_session", "fork", "clone"]);
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
// The native chrome (the Windows title bar and the File/Edit/View menu bar)
// follows the chosen theme: dark themes get a dark title bar and menu bar, light
// themes a light one, "auto" follows the OS. Set before any window opens; a
// change fires nativeTheme "updated", which re-broadcasts the theme below.
function applyNativeTheme(theme) {
  nativeTheme.themeSource = theme === "auto" ? "system" : theme.endsWith("-dark") ? "dark" : "light";
}
applyNativeTheme(settings.theme);
// Text pulled out of attached documents (D1b2) lives beside the settings; a
// week-old extract is of no use to anyone, so the store is pruned at start.
const attachmentStore = join(app.getPath("userData"), "attachments");
pruneStore(attachmentStore);
// Photos and files the phone sends (MC10) are saved here, never in the project.
const phoneUploadStore = join(app.getPath("userData"), "phone-uploads");
pruneStore(phoneUploadStore);
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

/** @type {Map<number, any>} tab state by its page's webContents id (one Pi each) */
const windows = new Map();
/** @type {Map<number, any>} each coop window (a frame of tabs) by BrowserWindow id */
const frames = new Map();
const runningPis = new Set();
let nextTabId = 1;

function send(state, channel, payload) {
  if (state.win.isDestroyed() || state.contents.isDestroyed()) return;
  if (!state.ready) {
    if (state.queue.length < MAX_QUEUE) state.queue.push([channel, payload]);
    return;
  }
  // A page that is reloading or crashing has no frame to receive this; the
  // reloaded page asks for the state again (coop:ready).
  try { state.contents.send(channel, payload); } catch { /* frame gone */ }
}

function broadcast(channel, payload) {
  for (const state of windows.values()) send(state, channel, payload);
  for (const frame of frames.values()) sendStrip(frame, channel, payload);
  // The project picker follows the theme too.
  if (picker.win && !picker.win.isDestroyed()) { try { picker.win.webContents.send(channel, payload); } catch { /* gone */ } }
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
  state.hub.attach(pi);
  pi.on("event", (message) => {
    if (state.pi !== pi) return;
    if (message.type === "extension_ui_request" && message.method === "setTitle") {
      const title = typeof message.title === "string" ? message.title.replace(/[\0-\x1f]/g, " ").slice(0, 120) : "";
      if (title) { state.title = title; if (state.frame.active === state && !state.win.isDestroyed()) state.win.setTitle(title); }
      return;
    }
    notifyInBackground(state, message);
    send(state, "pi:event", message);
    trackTab(state, message);
  });
  pi.on("protocol-error", (text) => send(state, "pi:notice", { level: "error", message: String(text) }));
  pi.on("exit", ({ code, reason, stderr }) => {
    runningPis.delete(pi);
    if (state.pi !== pi) return;
    if (state.working) { state.working = false; pushTabs(state.frame); }
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
  // A tab behind another counts as the background too.
  if (!settings.notify || state.win.isDestroyed() || (state.win.isFocused() && state.frame.active === state)) return;
  const body = notificationFor(message, { folder: basename(state.spec.cwd) });
  if (!body) return;
  try {
    state.win.flashFrame(true);
    if (Notification.isSupported()) {
      const note = new Notification({ title: "coop", body, silent: false });
      note.on("click", () => raise(state));
      note.show();
    }
  } catch { /* a desktop without notifications */ }
}

function windowInfo(state) {
  const { spec } = state;
  if (!state.project) state.project = describeProject(spec.cwd);
  return {
    version: spec.version,
    cwd: spec.cwd,
    folder: basename(spec.cwd) || spec.cwd,
    branch: readBranch(spec.cwd),
    // The project file coop reads here and the client it names (D1m).
    client: state.project.client,
    contract: state.project.contract,
    projectHome: state.project.home,
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

const tabPreferences = () => ({
  preload: join(HERE, "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
  devTools: process.env.COOP_DESKTOP_DEVTOOLS === "1",
});

/** A new coop window on the spec's folder, with one tab. */
function openWindow(rawSpec, token) {
  let spec;
  try {
    spec = parseSpec(rawSpec);
  } catch (error) {
    dialog.showErrorBox("coop", `coop could not open its window: ${error.message}`);
    if (!BrowserWindow.getAllWindows().length) app.quit();
    return;
  }
  // The saved size, cut down to the screen it opens on (a small VM display).
  let fit = { width: settings.width, height: settings.height };
  try { fit = fitToScreen(fit, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize); } catch { /* keep the saved size */ }
  // The window's own page is the tab strip; each tab's session page is a view below it.
  const win = new BrowserWindow({
    width: fit.width,
    height: fit.height,
    minWidth: 640,
    minHeight: 420,
    // The client the project file names, then the folder (D1m).
    title: windowTitle(describeProject(spec.cwd)),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1318" : "#f6f7f9",
    autoHideMenuBar: !settings.menuBar,
    icon: existsSync(join(HERE, "..", "themes", "coop.ico")) ? join(HERE, "..", "themes", "coop.ico") : undefined,
    webPreferences: { ...tabPreferences(), spellcheck: false },
  });
  const frame = { win, id: win.id, tabs: [], active: null, stripReady: false, title: win.getTitle() };
  frames.set(frame.id, frame);
  // The picker remembers every folder a window opened (D1m), newest first.
  try { settings = saveSettings(settingsFile, rememberProject({ ...settings, lastFolder: spec.cwd }, spec.cwd)); } catch { /* keep going */ }
  if (settings.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("focus", () => {
    try { win.flashFrame(false); } catch { /* gone */ }
    if (frame.active && !frame.active.contents.isDestroyed()) frame.active.contents.focus();
    installMenu();
  });
  for (const event of ["resize", "maximize", "unmaximize", "restore", "enter-full-screen", "leave-full-screen"]) win.on(event, () => layout(frame));
  win.on("close", () => {
    if (frames.size === 1) {
      const maximized = win.isMaximized();
      const [width, height] = maximized ? [settings.width, settings.height] : win.getSize();
      try { settings = saveSettings(settingsFile, { ...settings, width, height, maximized }); } catch { /* keep going */ }
    }
  });
  win.on("closed", () => {
    frames.delete(frame.id);
    // A view's page outlives its window unless it is closed too.
    for (const tab of [...frame.tabs]) { endTab(tab); try { if (!tab.contents.isDestroyed()) tab.contents.close(); } catch { /* already gone */ } }
    frame.tabs = [];
    installMenu();
  });
  win.webContents.on("before-input-event", (event, input) => onTabKey(frame, event, input));
  win.loadURL(`${APP_ORIGIN}/tabs.html`);
  addTab(frame, { spec, rawSpec, token });
}

/** A new tab in `frame`: the session page and its own Pi, on a new session unless `extraArgs` name one. */
function addTab(frame, { spec, rawSpec, token, extraArgs = [], noticesShown = false }) {
  if (frame.tabs.length >= MAX_TABS) return null;
  const view = new WebContentsView({ webPreferences: tabPreferences() });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0f1318" : "#f6f7f9");
  const contents = view.webContents;
  const state = {
    frame, win: frame.win, view, contents, tabId: nextTabId++, label: "", title: "", working: false, asking: false,
    spec, rawSpec, token, pi: null, ready: false, queue: [], sessionFile: "", changes: [], snapshots: new Map(), knowledgeRoots: new Map(), docs: null, build: null, vibeSet: "",
    // A second tab does not repeat the launch notices or the first-run Start menu.
    noticesShown,
  };
  state.hub = newHub(state);
  windows.set(contents.id, state);
  frame.tabs.push(state);
  frame.win.contentView.addChildView(view);
  // A renderer that crashed or reloaded subscribes again; replaying keeps
  // dialogs Pi is waiting on visible.
  contents.on("did-start-loading", () => { state.ready = false; });
  // A crashed page is reloaded once a minute at most; Pi keeps running meanwhile.
  let lastReload = 0;
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || contents.isDestroyed() || Date.now() - lastReload < 60_000) return;
    lastReload = Date.now();
    contents.reload();
  });
  contents.on("before-input-event", (event, input) => onTabKey(frame, event, input));
  contents.loadURL(`${APP_ORIGIN}/index.html`);
  startPi(state, extraArgs);
  selectTab(state);
  return state;
}

/** Stop a tab's Pi and work, as closing its window did. */
function endTab(state) {
  windows.delete(state.contents.id);
  state.hub.setAccess(false, "window-closed");
  if (state.pi) state.pi.stop();
  if (state.docs) state.docs.cancel();
  if (state.build) { try { state.build.kill(); } catch { /* already gone */ } }
}

/** Close one tab; the last tab closes its window. */
function closeTab(state) {
  const { frame } = state;
  if (!frame.tabs.includes(state)) return;
  if (frame.tabs.length === 1) { if (!frame.win.isDestroyed()) frame.win.close(); return; }
  const next = afterClose(frame.tabs, state, frame.active);
  frame.tabs = frame.tabs.filter((tab) => tab !== state);
  endTab(state);
  try { frame.win.contentView.removeChildView(state.view); } catch { /* window gone */ }
  try { if (!state.contents.isDestroyed()) state.contents.close(); } catch { /* already gone */ }
  if (next) selectTab(next);
  else pushTabs(frame);
}

/** Show one tab: only the active tab's view is visible, under the strip. */
function selectTab(state) {
  const { frame } = state;
  frame.active = state;
  layout(frame);
  if (!frame.win.isDestroyed()) {
    frame.win.setTitle(state.title || frame.title);
    if (frame.win.isFocused() && !state.contents.isDestroyed()) state.contents.focus();
  }
  pushTabs(frame);
  installMenu();
}

function layout(frame) {
  if (frame.win.isDestroyed()) return;
  const [width, height] = frame.win.getContentSize();
  for (const tab of frame.tabs) {
    tab.view.setBounds({ x: 0, y: TAB_STRIP_HEIGHT, width, height: Math.max(0, height - TAB_STRIP_HEIGHT) });
    tab.view.setVisible(tab === frame.active);
  }
}

function sendStrip(frame, channel, payload) {
  if (!frame.stripReady || frame.win.isDestroyed() || frame.win.webContents.isDestroyed()) return;
  try { frame.win.webContents.send(channel, payload); } catch { /* reloading */ }
}

function pushTabs(frame) {
  sendStrip(frame, "coop:tabs", { tabs: stripRows(frame.tabs, frame.active), canAdd: frame.tabs.length < MAX_TABS });
}

/** A tab's working and asking marks follow its Pi's events. */
function trackTab(state, message) {
  let working = state.working;
  if (message.type === "agent_start") working = true;
  // Done when Pi settles (queued follow-ups run after agent_end), as the page's busy mark.
  else if (message.type === "agent_settled") working = false;
  const asking = Boolean(state.pi && state.pi.openDialogs().length);
  if (working === state.working && asking === state.asking) return;
  state.working = working;
  state.asking = asking;
  pushTabs(state.frame);
}

/** A new tab on this window's folder, from the same launch spec: a new session, or the saved one `sessionPath` names. */
function newTab(frame, sessionPath = "") {
  const from = frame.active || frame.tabs[0];
  if (!from) return { success: false, error: "this window has no coop" };
  if (frame.tabs.length >= MAX_TABS) return { success: false, error: `A window holds up to ${MAX_TABS} tabs. Close one, or open a new window.` };
  const extraArgs = sessionPath ? ["--session", sessionPath] : [];
  addTab(frame, { spec: from.spec, rawSpec: from.rawSpec, token: from.token, extraArgs, noticesShown: true });
  return { success: true };
}

// Tab keys work from the strip and from every tab's page, before the page sees them.
function onTabKey(frame, event, input) {
  const action = tabKey(input);
  if (!action) return;
  event.preventDefault();
  if (action.type === "new") { const result = newTab(frame); if (!result.success && frame.active) send(frame.active, "pi:notice", { level: "warning", message: result.error }); return; }
  if (action.type === "close") { if (frame.active) closeTab(frame.active); return; }
  const target = tabFor(action, frame.tabs, frame.active);
  if (target && target !== frame.active) selectTab(target);
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
  if (SESSION_CHANGES.has(command.type) && response.success) { state.hub.renew(); await currentSessionFile(state); }
  if (command.type === "get_state" && response.success && response.data && typeof response.data.sessionFile === "string") {
    state.sessionFile = response.data.sessionFile;
  }
  return piResult(response);
});

handle("coop:answer", (state, id, answer) => {
  if (!state.pi || typeof id !== "string") return { success: false, error: "no such question" };
  // The phone companion's arbiter (MC2): the first answer from either screen wins.
  const result = state.hub.answerFromDesktop(id, answer);
  trackTab(state, {});
  return { success: result.ok, error: result.error };
});

handle("coop:sessions", (state) => ({ success: true, data: markOpenElsewhere(listSessions({ ...process.env, ...state.spec.env }, state.spec.cwd), windows.values(), state) }));

/**
 * The other window that has `path` open, asking each live Pi for its current
 * session first (a session started there since the last check counts too).
 */
async function sessionOwner(state, path) {
  await Promise.all([...windows.values()].filter((other) => other !== state).map((other) => currentSessionFile(other)));
  return ownerOf(windows.values(), state, path);
}

/** Bring a tab and its window to the front. */
function raise(state) {
  if (state.win.isDestroyed()) return;
  if (state.win.isMinimized()) state.win.restore();
  state.win.show();
  state.win.focus();
  if (state.frame.active !== state) selectTab(state);
}

// Several sessions at once: another window on this folder with its own coop,
// from the same launch spec (the same arguments, environment and Warehouse
// token this window started with, as a restart reuses them). Its Pi starts a
// new session; approvals, guardrails and phone access are its own.
handle("coop:new-window", (state) => {
  openWindow(state.rawSpec, state.token);
  return { success: true };
});

handle("coop:new-tab", async (state, path) => {
  if (path === undefined || path === null || path === "") return newTab(state.frame);
  if (!isSessionPath({ ...process.env, ...state.spec.env }, path)) return { success: false, error: "that is not one of coop's saved sessions" };
  const owner = await sessionOwner(null, path);
  if (owner) { raise(owner); return { success: false, openElsewhere: true, error: "That session is open in another tab, so that tab is now in front." }; }
  return newTab(state.frame, path);
});
handle("coop:close-tab", (state) => { closeTab(state); return { success: true }; });
// The page names its tab: the session's name or first prompt.
handle("coop:tab-label", (state, label) => {
  const text = typeof label === "string" ? label.slice(0, 200) : "";
  if (text !== state.label) { state.label = text; pushTabs(state.frame); }
  return { success: true };
});

// --- The tab strip: the window's own page ------------------------------------

function stripFor(event) {
  for (const frame of frames.values()) {
    if (!frame.win.isDestroyed() && frame.win.webContents.id === event.sender.id && event.senderFrame && isAppUrl(event.senderFrame.url)) return frame;
  }
  throw new Error("not a tab strip");
}

function stripHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frame = stripFor(event);
    try {
      return await fn(frame, ...args);
    } catch (error) {
      return { success: false, error: error && error.message ? error.message : String(error) };
    }
  });
}

const tabById = (frame, id) => frame.tabs.find((tab) => tab.tabId === id);

stripHandle("coop:strip-ready", (frame) => {
  frame.stripReady = true;
  return { theme: settings.theme, systemDark: nativeTheme.shouldUseDarkColors, tabs: stripRows(frame.tabs, frame.active), canAdd: frame.tabs.length < MAX_TABS };
});
stripHandle("coop:strip-select", (frame, id) => { const tab = tabById(frame, id); if (tab) selectTab(tab); return { success: Boolean(tab) }; });
stripHandle("coop:strip-close", (frame, id) => { const tab = tabById(frame, id); if (tab) closeTab(tab); return { success: Boolean(tab) }; });
stripHandle("coop:strip-new", (frame) => newTab(frame));

// @ mentions: the folder's file list, read once and kept for 20 seconds.
async function folderFiles(state, query) {
  if (!state.files || Date.now() - state.files.at > 20_000) state.files = { at: Date.now(), paths: await listFiles(state.spec.cwd) };
  return rankFiles(state.files.paths, String(query || "").slice(0, 200));
}

handle("coop:files", async (state, query) => ({ success: true, data: await folderFiles(state, query) }));

handle("coop:switch-session", async (state, path) => {
  if (!isSessionPath({ ...process.env, ...state.spec.env }, path)) return { success: false, error: "that is not one of coop's saved sessions" };
  // One window per session: two coops writing one session file would mix it up.
  const owner = await sessionOwner(state, path);
  if (owner) { raise(owner); return { success: false, openElsewhere: true, error: "That session is open in another tab, so that tab is now in front." }; }
  const response = await state.pi.request({ type: "switch_session", sessionPath: path }, { timeoutMs: 0 });
  if (response.success) state.hub.renew();
  return piResult(response);
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

/** Another folder in a new window: the same `coop desktop` the icon runs. */
function openFolderWindow(state, folder) {
  if (process.platform === "win32") {
    const proc = consoleProcess({ mode: "window", coop: state.spec.coop, cwd: folder, env: process.env, app: PACKAGED ? process.execPath : "" });
    spawn(proc.command, proc.args, proc.options).unref();
  } else {
    // Development on macOS or Linux: run the same command without a console.
    spawn("pwsh", ["-NoLogo", "-NoProfile", "-File", state.spec.coop, "desktop"], { cwd: folder, env: process.env, detached: true, stdio: "ignore" }).unref();
  }
  return { success: true };
}

handle("coop:open-folder", async (state) => {
  if (!state.spec.coop) return { success: false, error: "this window was not started by coop desktop" };
  const result = await dialog.showOpenDialog(state.win, { title: "Open a folder in a new coop window", defaultPath: state.spec.cwd, properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
  return openFolderWindow(state, result.filePaths[0]);
});

// File > Switch project (D1m): the same picker the icon shows, then a new window.
handle("coop:switch-project", async (state) => {
  if (!state.spec.coop) return { success: false, error: "this window was not started by coop desktop" };
  const folder = await pickProject(state.win);
  if (!folder) return { success: false, cancelled: true };
  return openFolderWindow(state, folder);
});

// --- The project picker (D1m) ------------------------------------------------
// One small window: the folders opened before with their client, branch and
// team state, Browse, and "open this one next time". It resolves the folder
// picked or "" (Cancel, Escape, or the window closed). Its page is served
// like the main one; its IPC answers only that page.
const picker = { win: null, resolve: null, awaitingSpec: false };

function pickerState(event) {
  if (!picker.win || picker.win.isDestroyed() || event.sender.id !== picker.win.webContents.id || !event.senderFrame || !isAppUrl(event.senderFrame.url)) throw new Error("not the project picker");
  return picker;
}

function finishPicker(folder) {
  const done = picker.resolve;
  picker.resolve = null;
  if (picker.win && !picker.win.isDestroyed()) picker.win.close();
  picker.win = null;
  if (done) done(folder || "");
}

function pickProject(parent) {
  if (picker.win && !picker.win.isDestroyed()) { picker.win.focus(); return new Promise((resolve) => { const previous = picker.resolve; picker.resolve = (folder) => { if (previous) previous(folder); resolve(folder); }; }); }
  return new Promise((resolve) => {
    picker.resolve = resolve;
    picker.win = new BrowserWindow({
      width: 560,
      height: 600,
      minWidth: 420,
      minHeight: 360,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: "coop - open a project",
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1318" : "#f6f7f9",
      autoHideMenuBar: true,
      icon: existsSync(join(HERE, "..", "themes", "coop.ico")) ? join(HERE, "..", "themes", "coop.ico") : undefined,
      webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: process.env.COOP_DESKTOP_DEVTOOLS === "1" },
    });
    picker.win.once("ready-to-show", () => picker.win.show());
    picker.win.on("closed", () => { picker.win = null; const done = picker.resolve; picker.resolve = null; if (done) done(""); });
    picker.win.loadURL(`${APP_ORIGIN}/picker.html`);
  });
}

function pickerHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return { success: true, data: await fn(pickerState(event), ...args) }; } catch (error) { return { success: false, error: error && error.message ? error.message : String(error) }; }
  });
}

pickerHandle("coop:picker-list", () => ({ entries: projectEntries(settings), openNextTime: startFolder(settings) }));
pickerHandle("coop:picker-theme", () => ({ theme: settings.theme, systemDark: nativeTheme.shouldUseDarkColors }));
pickerHandle("coop:picker-open", (_picker, path, openNextTime) => {
  const folder = typeof path === "string" && isAbsolute(path) && !/[\0\r\n]/.test(path) && existsSync(path) ? path : "";
  if (!folder) throw new Error("that folder does not exist any more");
  settings = saveSettings(settingsFile, rememberProject({ ...settings, openNextTime: openNextTime === true ? folder : "" }, folder));
  finishPicker(folder);
  return folder;
});
pickerHandle("coop:picker-browse", async (state) => {
  const result = await dialog.showOpenDialog(state.win, { title: "Open a folder in coop", defaultPath: settings.lastFolder && existsSync(settings.lastFolder) ? settings.lastFolder : app.getPath("home"), properties: ["openDirectory"], buttonLabel: "Choose" });
  if (result.canceled || !result.filePaths.length) return "";
  const folder = result.filePaths[0];
  settings = saveSettings(settingsFile, rememberProject(settings, folder));
  return folder;
});
pickerHandle("coop:picker-forget", (_picker, path) => { settings = saveSettings(settingsFile, forgetProject(settings, String(path || ""))); return true; });
pickerHandle("coop:picker-cancel", () => { finishPicker(""); return true; });

// One restart at a time per window (#286): a second request during the
// shutdown gets the same restart, and a window closed meanwhile starts nothing.
handle("coop:restart", (state) => restartOnce(state, async () => {
  const sessionFile = await currentSessionFile(state);
  if (state.pi) await state.pi.stop();
  if (state.contents.isDestroyed()) return { success: false, error: "the tab closed during the restart" };
  startPi(state, sessionFile && existsSync(sessionFile) ? ["--session", sessionFile] : []);
  return { success: true };
}));

handle("coop:theme", (state, theme) => {
  if (!THEMES.includes(theme)) return { success: false, error: "unknown theme" };
  settings = saveSettings(settingsFile, { ...settings, theme });
  applyNativeTheme(theme);
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
  const contents = state.contents;
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
  state.knowledgeRoots = result.roots;
  return { success: true, data: { source: result.source, domains: result.domains, knowledge: result.knowledge } };
});

// One note of a team knowledge clone (incremental-bi, coop-team-knowledge), by
// the path the listing gave; the clone's location stays in main.
handle("coop:knowledge-note", async (state, source, path) => {
  const root = state.knowledgeRoots && state.knowledgeRoots.get(source);
  if (!root) return { success: false, error: "that knowledge repository is not cloned here; run coop sync" };
  try { return { success: true, data: await readNote(root, path) }; }
  catch (error) { return { success: false, error: error.message }; }
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

// The shared project file (C1): how the local file compares with the team's,
// "Get the team's project file", and "Share with the team" (the one Git write
// coop performs on its own, after the button: .coop/project.yml alone).
handle("coop:project-team", (state) => ({ success: true, data: teamStatus(state.spec.cwd, { env: toolEnv(state) }) }));
handle("coop:project-get", (state) => ({ success: true, data: getTeamProject(state.spec.cwd, { env: toolEnv(state) }) }));
handle("coop:project-share", (state, force) => ({ success: true, data: shareProject(state.spec.cwd, { env: toolEnv(state), force: force === true }) }));

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

const attachOptions = (state) => ({ cwd: state.spec.cwd, store: attachmentStore, node: state.spec.node, pdfjsDir, script: UNPACKED.pdfScript || undefined, env: { ...process.env, ...state.spec.env } });

handle("coop:attach-file", async (state, path) => ({ success: true, data: await attach(String(path || ""), attachOptions(state)) }));

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


// --- Phone companion (master plan MC2, desktop/COMPANION.md) ---------------------
// One loopback server per Windows user, started the first time a window allows
// the phone; Tailscale's `serve` carries the tailnet name to it. At most one
// window has phone access on; the phone sees that window's session.

const companion = { store: null, server: null, origin: "", starting: null };
const windowsUser = (() => { try { return `${hostname()}\\${userInfo().username}`; } catch { return ""; } })();

function companionStore() {
  if (!companion.store) companion.store = new DeviceStore(join(profileDir(process.env), "companion", "devices.json"));
  return companion.store;
}

function companionAudit(entry) {
  try {
    const dir = join(profileDir(process.env), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "companion.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch { /* the audit never stops the window */ }
}

function activeHub() {
  for (const state of windows.values()) if (state.hub.accessOn) return state.hub;
  return null;
}

function newHub(state) {
  const env = () => ({ ...process.env, ...state.spec.env });
  const hub = new CompanionHub({
    windowsUser,
    client: describeProject(state.spec.cwd).client,
    // Session actions from the phone (MC9): the same lists and checks as the window's own.
    host: {
      // A session another window holds stays off the phone's list (one window per session).
      list: () => listSessions(env(), state.spec.cwd).filter((s) => isSessionPath(env(), s.path) && !ownerOf(windows.values(), state, s.path)),
      exportPath: async () => {
        const file = await currentSessionFile(state);
        if (!file || !existsSync(file)) return "";
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        return join(dirname(file), `coop-session-${stamp}.html`);
      },
      changed: (action) => send(state, "coop:refresh", { by: "phone", action }),
      // Photos and files from the phone (MC10): saved, then attached as the window attaches a file.
      attach: async (name, bytes) => {
        if (bytes.length > ATTACH_LIMITS.document) throw new AttachError(`${name} is over ${Math.round(ATTACH_LIMITS.document / 1024 / 1024)} MB; files up to that size can be attached.`);
        try {
          return await attach(saveUpload(phoneUploadStore, name, bytes), attachOptions(state));
        } catch (error) {
          throw error instanceof AttachError ? error : new Error(`${name} could not be saved on the computer.`);
        }
      },
      files: (query) => folderFiles(state, query),
      // /reload from the phone (MC9): the window restarts coop as its own /reload does.
      reload: () => send(state, "coop:refresh", { by: "phone", action: "reload" }),
    },
  });
  // The phone answered (or Pi's clock ran out): the desktop card closes.
  hub.on("resolved", ({ piId, by }) => { if (by !== "desktop") send(state, "coop:dialog-closed", { id: piId }); trackTab(state, {}); });
  // coop asked a question or finished a turn: a closed phone page gets a notice (MC11).
  hub.on("attention", () => { if (companion.server) companion.server.nudge(hub).catch(() => {}); });
  hub.on("access", ({ on, reason }) => {
    companionAudit({ kind: on ? "access-on" : "access-off", client: hub.client, reason });
    if (!on && reason && reason !== "switched") send(state, "pi:notice", { level: "info", message: "Phone access is off for this window." });
    installMenu();
  });
  return hub;
}

// Notices (MC11): one VAPID key pair per Windows user, beside the device list.
// Without it the phone's Notifications sheet says notices are not set up.
function companionPush(origin) {
  try {
    return createPushSender({ keys: loadVapid(join(profileDir(process.env), "companion", "push.json")), subject: origin });
  } catch {
    return null;
  }
}

async function startCompanion() {
  if (companion.server) return companion.origin;
  if (!companion.starting) {
    companion.starting = (async () => {
      const origin = settings.companionOrigin || await tailnetOrigin();
      if (!origin) throw new Error("Tailscale is not running or not signed in on this computer, so the phone cannot reach coop. Start Tailscale, sign in, and try again.");
      const server = createCompanionServer({
        store: companionStore(),
        active: activeHub,
        origin,
        webRoot: join(HERE, "companion"),
        shared: {
          "/shared/dialogs.mjs": join(RENDERER, "dialogs.mjs"),
          "/shared/markdown.mjs": join(RENDERER, "markdown.mjs"),
          "/shared/attach-note.mjs": join(RENDERER, "attach-note.mjs"),
          "/shared/themes.css": join(RENDERER, "styles", "themes.css"),
        },
        audit: companionAudit,
        port: DEFAULT_PORT,
        push: companionPush(origin),
      });
      await server.listen();
      companion.server = server;
      companion.origin = origin;
      return origin;
    })().finally(() => { companion.starting = null; });
  }
  return companion.starting;
}

async function togglePhone(state) {
  if (state.hub.accessOn) { state.hub.setAccess(false, "turned-off"); return; }
  if (!state.hub.client) {
    dialog.showMessageBox(state.win, { type: "info", title: "Phone", message: "This folder's project file names no client.", detail: "The phone is tied to one client. Open a client's project (File > Switch project), or create its project file with /setup-project, then allow the phone." });
    return;
  }
  try {
    const origin = await startCompanion();
    for (const other of windows.values()) if (other !== state && other.hub.accessOn) other.hub.setAccess(false, "switched");
    if (state.hub.setAccess(true)) send(state, "pi:notice", { level: "info", message: `Phone access is on for this session (${state.hub.client}). Open ${origin} on your phone.` });
    else send(state, "pi:notice", { level: "warning", message: "coop is not running in this window, so the phone cannot be allowed." });
  } catch (error) {
    dialog.showMessageBox(state.win, { type: "warning", title: "Phone", message: "The phone companion could not start.", detail: /EADDRINUSE/.test(error.message) ? `Port ${DEFAULT_PORT} on this computer is taken by another program.` : error.message });
  }
}

async function pairPhone(state) {
  if (!state.hub.client) { togglePhone(state); return; }
  let origin;
  try { origin = await startCompanion(); } catch (error) {
    dialog.showMessageBox(state.win, { type: "warning", title: "Pair a phone", message: "The phone companion could not start.", detail: error.message });
    return;
  }
  const { code } = companionStore().startPairing({ windowsUser, client: state.hub.client });
  companionAudit({ kind: "pairing-code-shown", client: state.hub.client });
  await dialog.showMessageBox(state.win, {
    type: "info",
    title: "Pair a phone",
    message: `Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`,
    detail: `1. On the phone, with Tailscale on, open ${origin}\n2. Enter this code and a name for the phone.\n\nThe code works once and for 5 minutes. The phone is paired for ${state.hub.client} as ${windowsUser}.\nAfter pairing, allow the phone with Session > Phone > Allow phone for this session.`,
    buttons: ["Done"],
  });
}

function removePhones(id) {
  const removed = companionStore().revoke(id);
  if (companion.server) companion.server.revoked(removed);
  for (const deviceId of removed) companionAudit({ kind: "revoked", device: deviceId });
  installMenu();
}

// --- Menu bar ------------------------------------------------------------------

/** The tab the menu acts on: the focused window's tab in front, else the first window's. */
function focusedFrame() {
  const win = BrowserWindow.getFocusedWindow();
  const frame = win ? frames.get(win.id) : undefined;
  return frame || frames.values().next().value;
}

function focusedState() {
  const frame = focusedFrame();
  return frame ? frame.active || undefined : undefined;
}

function installMenu() {
  const template = menuTemplate({
    run: (action) => { const state = focusedState(); if (state) send(state, "coop:menu", { action }); },
    tabs: {
      add: () => { const frame = focusedFrame(); if (frame) newTab(frame); },
      close: () => { const state = focusedState(); if (state) closeTab(state); },
      next: () => { const frame = focusedFrame(); const tab = frame && tabFor({ type: "next" }, frame.tabs, frame.active); if (tab) selectTab(tab); },
      prev: () => { const frame = focusedFrame(); const tab = frame && tabFor({ type: "prev" }, frame.tabs, frame.active); if (tab) selectTab(tab); },
      newWindow: () => { const state = focusedState(); if (state) openWindow(state.rawSpec, state.token); },
    },
    setTheme: (theme) => { if (THEMES.includes(theme)) { settings = saveSettings(settingsFile, { ...settings, theme }); applyNativeTheme(theme); broadcast("coop:theme", { theme, systemDark: nativeTheme.shouldUseDarkColors }); } },
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
    phone: {
      accessOn: Boolean(focusedState() && focusedState().hub.accessOn),
      devices: companionStore().list(),
      toggleAccess: () => { const state = focusedState(); if (state) togglePhone(state); },
      pair: () => { const state = focusedState(); if (state) pairPhone(state); },
      remove: (id) => removePhones(id),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setMenuBar(visible) {
  settings = saveSettings(settingsFile, { ...settings, menuBar: visible });
  for (const frame of frames.values()) {
    if (frame.win.isDestroyed()) continue;
    frame.win.setAutoHideMenuBar(!visible);
    frame.win.setMenuBarVisibility(visible);
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
  // The icon is the front door (D1m): `coop.exe <folder>` names the folder,
  // "open this one next time" skips the question, else the project picker.
  let folder = folderArgument(process.argv.slice(1)) || startFolder(settings);
  if (!folder) {
    picker.awaitingSpec = true;
    folder = await pickProject();
    if (!folder) { picker.awaitingSpec = false; app.quit(); return; }
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
    picker.awaitingSpec = false;
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

// Closing the picker after a choice leaves no window until coop.ps1 hands
// the spec over (bootstrap below); the child's exit timer quits if none comes.
app.on("window-all-closed", () => { if (!picker.awaitingSpec) app.quit(); });

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping || runningPis.size === 0) return;
  // Close each Pi's stdin and wait, so MCP servers and tools end with it.
  event.preventDefault();
  stopping = true;
  Promise.allSettled([...runningPis].map((pi) => pi.stop())).finally(() => app.quit());
});
