import vm from "node:vm";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { normalizeSavedChat, normalizeSavedChats, restoreSavedChats } from "../desktop/src/session-restoration.mjs";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCoopLauncher } from "../desktop/src/coop-launcher.mjs";
import { loadDesktopState, normalizeDesktopState, restoreWindowBounds, saveDesktopState } from "../desktop/src/desktop-state.mjs";
import { selectRuntimeWorkspace } from "../desktop/src/workspace-selection.mjs";
import { buildNativeModelLoginProcess, buildNativeTerminalProcess, launchNativeModelLogin, launchNativeTerminal, validateTerminalLaunch } from "../desktop/src/native-terminal.mjs";
import { startCoopRuntime } from "../desktop/src/runtime-supervisor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }

function launch(mode = "open", pathStyle = "posix") {
  const cwd = pathStyle === "windows" ? "C:\\Client Work\\Repo" : "/client work/repo";
  const session = pathStyle === "windows" ? "C:\\Users\\consultant\\.coop\\sessions\\one.jsonl" : "/users/consultant/.coop/sessions/one.jsonl";
  return {
    ok: true,
    launch: {
      schemaVersion: 1,
      kind: "native-terminal",
      handoffId: "handoff-1",
      mode,
      cwd,
      executable: "coop",
      args: mode === "open" ? [] : ["--session", session],
    },
  };
}

await test("preview package has a distinct identity and fixed audited dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "desktop", "package.json"), "utf8"));
  assert.equal(pkg.build.appId, "com.cooptimize.coop.desktop.preview");
  assert.equal(pkg.devDependencies.electron, "44.2.0");
  assert.equal(pkg.devDependencies["electron-builder"], "26.15.3");
  assert.match(pkg.scripts["package:win"], /--x64/);
  assert.deepEqual(pkg.build.files, ["src/**/*", "resources/desktop-update-trust.json", "resources/desktop-update-feed.json", "package.json"]);
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.electronFuses.runAsNode, false);
  assert.equal(pkg.build.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(pkg.build.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(pkg.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(pkg.build.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(pkg.build.electronFuses.grantFileProtocolExtraPrivileges, false);
});

await test("desktop-only state is normalized and atomically persisted outside project config", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-desktop-state-"));
  try {
    const file = join(dir, "desktop-state.json");
    assert.deepEqual(loadDesktopState(file), { schemaVersion: 1, lastWorkspace: null, windowBounds: null, theme: "modern-dark", openChats: [], activeChatIndex: 0 });
    const state = saveDesktopState(file, { lastWorkspace: "/client/repo", windowBounds: { x: 10, y: 20, width: 1440, height: 920 }, theme: "retro-messenger" });
    assert.deepEqual(loadDesktopState(file), state);
    assert.equal(state.theme, "retro-messenger");
    assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
    writeFileSync(file, "not-json", "utf8");
    assert.equal(loadDesktopState(file).lastWorkspace, null);
    const invalid = normalizeDesktopState({ lastWorkspace: "bad\0path", windowBounds: { width: 1, height: 1, x: 0, y: 0 }, theme: "untrusted" });
    assert.equal(invalid.windowBounds, null);
    assert.equal(invalid.theme, "modern-dark");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("saved navigation accepts bounded references and never restores an access override", () => {
  const valid = { cwd: "/work/project", file: "session.jsonl", access: "read-only" };
  assert.deepEqual(normalizeSavedChats([valid, { ...valid, file: "../private.jsonl" }, { ...valid, access: "override" }, { ...valid, cwd: "relative" }]), [valid]);
  assert.equal(normalizeSavedChats(Array(20).fill(valid)).length, 8);
  const state = normalizeDesktopState({ openChats: [valid], activeChatIndex: 0 });
  assert.deepEqual(state.openChats, [valid]);
});

await test("chat restoration preserves order, active selection and read-only access through runtime calls", async () => {
  const entries = [
    { cwd: "/one", file: "one.jsonl", access: "write" },
    { cwd: "/two", file: "two.jsonl", access: "read-only" },
    { cwd: "/three", file: null, access: "write" },
  ];
  const calls = [];
  let number = 0;
  const result = await restoreSavedChats({ entries, activeIndex: 1,
    create: async body => { calls.push(["create", body]); return { sid: `restored-${++number}` }; },
    resume: async body => { calls.push(["resume", body]); },
    close: async () => { throw new Error("Should not close successful restoration"); },
  });
  assert.equal(result.activeSid, "restored-2");
  assert.equal(result.restored.length, 3);
  assert.deepEqual(calls.map(call => call[0]), ["create", "resume", "create", "resume", "create"]);
  assert.deepEqual(calls[2][1], { cwd: "/two", workspaceAccess: "read-only" });
  assert.deepEqual(calls[3][1], { sid: "restored-2", workspace: "/two", file: "two.jsonl" });
});

await test("failed restoration retains references, closes incomplete chats and never escalates a conflict", async () => {
  const entries = [
    { cwd: "/conflict", file: "first.jsonl", access: "write" },
    { cwd: "/missing", file: "gone.jsonl", access: "read-only" },
    { cwd: "/available", file: "last.jsonl", access: "read-only" },
  ];
  const closed = [], created = [];
  const result = await restoreSavedChats({ entries, activeIndex: 0,
    create: async body => { created.push(body); if (body.cwd === "/conflict") throw new Error("Workspace is owned"); return { sid: body.cwd === "/missing" ? "missing" : "last" }; },
    resume: async body => { if (body.sid === "missing") throw new Error("Session not found"); },
    close: async body => { closed.push(body.sid); },
  });
  assert.deepEqual(closed, ["missing"]);
  assert.deepEqual(result.failures.map(item => item.entry), entries.slice(0, 2));
  assert.equal(result.activeSid, "last");
  assert.ok(created.every(body => !body.approved && body.workspaceAccess !== "override"));
  const stopped = await restoreSavedChats({ entries,
    create: async () => ({ sid: "created" }), resume: async () => { throw new Error("Failed"); }, close: async () => { throw new Error("Offline"); },
  });
  assert.equal(stopped.failures.length, entries.length, "unattempted references survive cleanup failure");
});

await test("recovery checkpoints preserve complete state when a snapshot is partial or races a session reset", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const start = source.indexOf("async function checkpointNavigation()");
  const saved = [];
  let epoch = 0, failRpc = false, race = false, readCount = 0;
  let data = { sessionFile: "/store/current.jsonl", messageCount: 3 };
  const entry = { cwd: "/keep", file: "keep.jsonl", access: "write" };
  const ctx = vm.createContext({
    navigationReady: true, navigationBusy: false, runtime: {}, runtimeGeneration: 1,
    activeChatSid: "active", recoveryFailures: [{ entry }], workspace: "/old", statePath: "unused",
    desktopState: { openChats: [entry] }, basename, normalizeSavedChat,
    console: { error() {} },
    runtimeChatState: async () => { readCount++; return { chats: [{ sid: "active", cwd: "/new", epoch: race && readCount % 2 === 0 ? ++epoch : epoch, workspaceAccess: { mode: "read-only" } }] }; },
    runtimeRpc: async body => { assert.equal(body.sid, "active"); if (failRpc) throw new Error("Unavailable"); return { data }; },
    saveDesktopState: (path, value) => { saved.push(value); return value; },
  });
  vm.runInContext(source.slice(start, source.indexOf("async function restoreNavigation", start)), ctx);
  failRpc = true;
  await ctx.checkpointNavigation();
  assert.equal(saved.length, 0);
  failRpc = false; race = true; readCount = 0;
  await ctx.checkpointNavigation();
  assert.equal(saved.length, 0, "reset during snapshot must preserve the previous checkpoint");
  race = false;
  await ctx.checkpointNavigation();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].lastWorkspace, "/new");
  assert.equal(saved[0].openChats[0].file, "current.jsonl");
  assert.equal(saved[0].openChats[0].access, "read-only");
  assert.equal(saved[0].openChats[1].file, "keep.jsonl", "unresolved recovery reference retained");
  assert.equal(ctx.navigationBusy, false);
  data = { sessionFile: "/store/named.jsonl", messageCount: 0, sessionName: "Named empty chat" };
  await ctx.checkpointNavigation();
  assert.equal(saved[1].openChats[0].file, null, "naming an empty chat does not flush a Pi session file");
});

await test("startup uses another saved workspace when the selected folder disappeared", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const from = source.indexOf("async function selectInitialWorkspace()");
  let pickerCalls = 0;
  const ctx = vm.createContext({ process: { env: {} }, resolve,
    desktopState: { lastWorkspace: "/missing", openChats: [{ cwd: "/available" }] },
    directoryExists: path => path === "/available" || path === "/explicit",
    chooseWorkspace: async () => { pickerCalls++; return "/chosen"; },
  });
  vm.runInContext(source.slice(from, source.indexOf("function configurePermissions", from)), ctx);
  assert.equal(await ctx.selectInitialWorkspace(), resolve("/available"));
  assert.equal(pickerCalls, 0);
  ctx.process.env.COOP_WORKSPACE = "/explicit";
  assert.equal(await ctx.selectInitialWorkspace(), resolve("/explicit"));
  delete ctx.process.env.COOP_WORKSPACE;
  ctx.desktopState.openChats = [];
  assert.equal(await ctx.selectInitialWorkspace(), "/chosen");
});

await test("an interrupted restore cannot issue commands against a replacement runtime", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const start = source.indexOf("async function restoreNavigation(initialSid)");
  const calls = [];
  const saved = { openChats: [{ cwd: "/project", file: "saved.jsonl", access: "write" }], activeChatIndex: 0 };
  const ctx = vm.createContext({ navigationRestore: null, runtimeGeneration: 1, quitting: false,
    desktopState: saved, workspace: "/project", navigationReady: false, restoreSavedChats,
    runtimeChatState: async () => ({ chats: [{ sid: "initial", busy: false }] }),
    runtimeRpc: async () => ({ data: { messageCount: 0 } }),
    runtimePost: async path => { calls.push(path); if (path === "/chat-new") ctx.runtimeGeneration++; return { sid: "restored" }; },
    setInterval: () => { throw new Error("Interrupted restore must not start checkpoints"); },
  });
  vm.runInContext(source.slice(start, source.indexOf("function registerIpc", start)), ctx);
  await assert.rejects(ctx.restoreNavigation("initial"), /interrupted/);
  assert.deepEqual(calls, ["/chat-close", "/chat-new"]);
  assert.equal(ctx.navigationReady, false);
  assert.equal(ctx.desktopState, saved);
});

await test("workspace selection persists only runtime-confirmed paths and preserves state on rejection or cancel", async () => {
  let current = "/original";
  const accept = cwd => { current = cwd; };
  const common = { sid: "session-1", choose: async () => "/candidate", accept };
  assert.equal(await selectRuntimeWorkspace({ ...common, change: async body => { assert.deepEqual(body, { dir: "/candidate", sid: "session-1" }); return { cwd: "/canonical" }; } }), "/canonical");
  assert.equal(current, "/canonical");
  await assert.rejects(selectRuntimeWorkspace({ ...common, change: async () => { throw new Error("busy"); } }), /busy/);
  assert.equal(current, "/canonical");
  assert.equal(await selectRuntimeWorkspace({ ...common, choose: async () => null, change: () => { throw new Error("must not run"); } }), null);
  assert.equal(current, "/canonical");
  await assert.rejects(selectRuntimeWorkspace({ ...common, sid: "../invalid" }), /Invalid/);
});

await test("window restoration keeps title bars reachable after monitor removal", () => {
  const screen = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(restoreWindowBounds({ x: 3000, y: -1000, width: 1920, height: 1080 }, [screen]), { x: 0, y: 0, width: 1440, height: 900 });
  const secondary = { x: -1920, y: 0, width: 1920, height: 1080 };
  const saved = { x: -1600, y: 30, width: 1000, height: 700 };
  assert.deepEqual(restoreWindowBounds(saved, [screen, secondary]), saved);
  assert.equal(restoreWindowBounds(saved, []), null);
});

await test("terminal launch accepts only the runtime's fixed Coop descriptor", () => {
  assert.equal(validateTerminalLaunch(launch()).executable, "coop");
  assert.throws(() => validateTerminalLaunch({ ...launch(), launch: { ...launch().launch, executable: "bash" } }), /invalid terminal launch/);
  assert.throws(() => validateTerminalLaunch({ ...launch("clone"), launch: { ...launch("clone").launch, args: ["--session", "/tmp/not-json.txt"] } }), /session arguments/);
  const mac = buildNativeTerminalProcess(launch("clone"), "darwin", "/opt/coop/bin/coop");
  assert.equal(mac.command, "/usr/bin/osascript");
  assert.equal(mac.args.includes("/users/consultant/.coop/sessions/one.jsonl"), true);
  assert.equal(mac.args[1].includes("/users/consultant/.coop/sessions/one.jsonl"), false);
  assert.equal(mac.args.includes("/opt/coop/bin/coop"), true);
  const windows = buildNativeTerminalProcess(launch("clone", "windows"), "win32", "C:\\Coop\\coop.cmd");
  assert.equal(windows.command, "cmd.exe");
  assert.equal(windows.args.join(" ").includes("Client Work"), false);
  assert.equal(windows.options.env.COOP_TERMINAL_CWD, "C:\\Client Work\\Repo");
  assert.equal(windows.options.env.COOP_TERMINAL_SESSION.endsWith("one.jsonl"), true);
  assert.equal(windows.options.env.COOP_TERMINAL_BIN, "C:\\Coop\\coop.cmd");
  const isolated = buildNativeTerminalProcess(launch("clone", "windows"), "win32", "C:\\Coop\\coop.cmd", "C:\\Users\\consultant\\AppData\\Coop Desktop\\managed-agent");
  assert.equal(isolated.options.env.COOP_AGENT_DIR, isolated.options.env.COOP_DESKTOP_AGENT_DIR);
  assert.equal(isolated.options.env.PI_CODING_AGENT_DIR, isolated.options.env.COOP_DESKTOP_AGENT_DIR);
  const isolatedMac = buildNativeTerminalProcess(launch("clone"), "darwin", "/opt/coop/bin/coop", "/users/consultant/Library/Application Support/Coop Desktop/managed-agent");
  assert.equal(isolatedMac.args.at(-1).endsWith("managed-agent"), true);
  assert.throws(() => buildNativeTerminalProcess(launch(), "darwin", "/opt/coop/bin/coop", "relative-agent"), /agent folder/);
});

await test("Windows resolves the installed cmd shim through its trusted PowerShell sibling", () => {
  const available = (candidate) => new Set(["C:\\Coop\\coop.cmd", "C:\\Coop\\coop.ps1", "C:\\Windows\\pwsh.exe"]).has(candidate);
  const result = resolveCoopLauncher("coop", {
    platform: "win32",
    env: { Path: "C:\\Coop;C:\\Windows", PATHEXT: ".CMD;.EXE" },
    available,
  });
  assert.equal(result.command, "C:\\Windows\\pwsh.exe");
  assert.deepEqual(result.commandPrefix, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Coop\\coop.ps1"]);
  assert.equal(result.terminalExecutable, "C:\\Coop\\coop.cmd");
  assert.throws(() => resolveCoopLauncher(".\\coop", { platform: "win32" }), /relative/);
  assert.throws(() => resolveCoopLauncher("coop", { platform: "darwin", env: { PATH: "." }, available: () => true }), /not installed/);
});

await test("terminal process launch is detached, shell-free, and injectable for tests", () => {
  let call;
  const result = launchNativeTerminal(launch(), {
    platform: "darwin",
    coopExecutable: "/opt/coop/bin/coop",
    spawnImpl(command, args, options) {
      call = { command, args, options, unref: false };
      return { pid: 42, unref() { call.unref = true; } };
    },
  });
  assert.deepEqual(result, { ok: true, pid: 42, mode: "open" });
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.unref, true);
});

await test("model login opens the fixed Pi TUI handoff without renderer-supplied arguments", () => {
  const mac = buildNativeModelLoginProcess({ cwd: "/client work/repo", coopExecutable: "/opt/coop/bin/coop", platform: "darwin" });
  assert.equal(mac.command, "/usr/bin/osascript");
  assert.equal(mac.args.includes("/client work/repo"), true);
  assert.equal(mac.args[1].includes("/client work/repo"), false);
  assert.match(mac.args[1], /COOP_PRIME_MODEL_LOGIN=1 COOP_LOGIN_ONLY=1/);
  assert.equal((mac.args[1].match(/COOP_WORKSPACE_ACCESS_MODE=read-only/g) || []).length, 2, "both managed and preview login are read-only");
  const windows = buildNativeModelLoginProcess({ cwd: "C:\\Client Work\\Repo", coopExecutable: "C:\\Coop\\coop.cmd", platform: "win32" });
  assert.equal(windows.command, "cmd.exe");
  assert.equal(windows.args.join(" ").includes("Client Work"), false);
  assert.equal(windows.options.env.COOP_TERMINAL_BIN, "C:\\Coop\\coop.cmd");
  assert.equal(windows.options.env.COOP_WORKSPACE_ACCESS_MODE, "read-only");
  const isolated = buildNativeModelLoginProcess({ cwd: "C:\\Client Work\\Repo", coopExecutable: "C:\\Coop\\coop.cmd", agentDir: "C:\\Users\\consultant\\AppData\\Coop Desktop\\managed-agent", platform: "win32" });
  assert.equal(isolated.options.env.PI_CODING_AGENT_DIR, isolated.options.env.COOP_DESKTOP_AGENT_DIR);
  let call;
  const result = launchNativeModelLogin({ cwd: "/repo", coopExecutable: "/opt/coop/bin/coop", platform: "darwin", spawnImpl(command, args, options) {
    call = { command, args, options, unref: false };
    return { pid: 43, unref() { call.unref = true; } };
  } });
  assert.deepEqual(result, { ok: true, pid: 43, providerId: "model.openai-codex" });
  assert.equal(call.options.shell, false);
  assert.equal(call.unref, true);
});

await test("failed runtime startup confirms exit even when the process ignores termination", async () => {
  for (const mode of ["malformed", "timeout"]) {
    let child, closed = false;
    try {
      await assert.rejects(startCoopRuntime({ workspace: ROOT, coopCommand: process.execPath,
        commandPrefix: ["-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); ${mode === "malformed" ? 'console.log("not-json");' : ''}`],
        readyTimeoutMs: 1000,
        spawnImpl(...args) { child = spawn(...args); child.once("close", () => { closed = true; }); return child; },
      }), mode === "timeout" ? /did not become ready/ : /JSON/);
      assert.equal(closed, true, "startup failure must not leave a live runtime behind");
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    } finally {
      if (child && !closed) { const done = once(child, "close"); child.kill("SIGKILL"); await done; }
    }
  }
});

await test("concurrent runtime stops both wait until the child has exited", async () => {
  const ready = { type: "runtime.ready", contractVersion: 1, transport: "http", endpoint: "http://127.0.0.1:12345", oneTimeToken: "a".repeat(32), runtimePid: 1 };
  const runtime = await startCoopRuntime({ workspace: ROOT, coopCommand: process.execPath,
    commandPrefix: ["-e", `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 250)); setInterval(() => {}, 1000); console.log(JSON.stringify({...${JSON.stringify(ready)}, runtimePid: process.pid}));`] });
  let closed = false;
  runtime.child.once("close", () => { closed = true; });
  const first = runtime.stop({ graceMs: 1000 });
  try {
    await runtime.stop({ graceMs: 1000 });
    assert.equal(closed, true, "a second stop must await the in-flight shutdown");
    await first;
    await runtime.stop();
  } finally { await first; if (!closed) { const done = once(runtime.child, "close"); runtime.child.kill("SIGKILL"); await done; } }
});

await test("runtime restart callback fires only for an unexpected child exit", async () => {
  const fixture = join(ROOT, "tests", "fixtures", "stub-coop-runtime.mjs");
  let expectedStops = 0;
  const controlled = await startCoopRuntime({ workspace: ROOT, coopCommand: process.execPath, commandPrefix: [fixture], onExit: () => expectedStops++ });
  await controlled.stop({ graceMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(expectedStops, 0);

  let unexpected = null;
  const crashed = await startCoopRuntime({ workspace: ROOT, coopCommand: process.execPath, commandPrefix: [fixture], onExit: (value) => { unexpected = value; } });
  crashed.child.kill("SIGKILL");
  for (let i = 0; i < 50 && !unexpected; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(Boolean(unexpected), true);
});

await test("production renderer bridge is sandboxed and individually allowlisted", () => {
  const main = readFileSync(join(ROOT, "desktop", "src", "main.mjs"), "utf8");
  const preload = readFileSync(join(ROOT, "desktop", "src", "preload.cjs"), "utf8");
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setPermissionRequestHandler\([^]*callback\(false\)/);
  assert.match(main, /event\.senderFrame === mainWindow\?\.webContents\.mainFrame/);
  assert.match(main, /setWindowOpenHandler\([^]*action: "deny"/);
  assert.match(main, /ipcMain\.handle\("coop:start-model-login"[^]*trustedSender/);
  assert.match(main, /ipcMain\.handle\("coop:export-session"[^]*SID\.test\(input\?\.sid/);
  assert.match(main, /runtimeRpc\(\{ type: "export_html", sid: input\.sid \}\)/);
  assert.match(main, /resolveManagedDesktopProfile\(app\.getPath\("userData"\)\)/);
  assert.match(main, /COOP_DESKTOP_AGENT_DIR: managedAgentDir/);
  assert.match(main, /loadPackagedUpdateTrust\(\{ packaged: app\.isPackaged, appPath: app\.getAppPath\(\) \}\)/);
  assert.match(main, /updates: updateTrustSummary\(packagedUpdateTrust\)/);
  assert.doesNotMatch(main, /executeJavaScript|nodeIntegration:\s*true/);
  assert.doesNotMatch(preload, /child_process|node:fs|shell\.|ipcRenderer\.send\(/);
  assert.deepEqual([...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]).sort(), ["coop:active-chat", "coop:choose-workspace", "coop:export-session", "coop:get-shell-info", "coop:notify", "coop:restore-navigation", "coop:set-theme", "coop:start-model-login", "coop:terminal-handoff"]);
  assert.match(main, /ipcMain\.handle\("coop:set-theme"[^]*THEMES\.has\(input\?\.theme\)/);
  assert.match(preload, /getNativeCommands/);
});

await test("shared SPA uses native features only when the Desktop bridge exists", () => {
  const app = readFileSync(join(ROOT, "web", "public", "app.js"), "utf8");
  assert.match(app, /window\.coopDesktop\?\.chooseWorkspace/);
  assert.match(app, /window\.coopDesktop\.terminalHandoff\(mode, activeSid\)/);
  assert.match(app, /window\.coopDesktop\?\.notify/);
  assert.match(app, /window\.coopDesktop\?\.getNativeCommands/);
  assert.match(app, /window\.coopDesktop\?\.setTheme/);
  assert.match(app, /window\.CoopThemes\.apply/);
  assert.match(app, /type: "steer"/);
  assert.match(app, /type: "follow_up"/);
  assert.match(app, /clipboardData\?\.items/);
  assert.match(app, /window\.coopDesktop\?\.exportSession/);
  assert.match(app, /type: "set_auto_compaction"/);
  assert.match(app, /type: "set_auto_retry"/);
  assert.match(app, /type: "abort_retry"/);
  assert.match(app, /!window\.coopDesktop \|\| desktopMissionControlOpened/);
  assert.match(app, /void openMissionControl\(\)/);
  assert.match(app, /Browser\/Web clients retain the existing/);
});

console.log(`desktop preview shell: ${count} tests passed`);
