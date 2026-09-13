import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";

const MODES = new Set(["open", "clone", "move"]);
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const APPLE_SCRIPT = `on run argv
  set targetDir to item 1 of argv
  set sessionFile to item 2 of argv
  set coopExecutable to item 3 of argv
  set agentDir to item 4 of argv
  set commandText to "cd " & quoted form of targetDir & "; exec " & quoted form of coopExecutable
  if agentDir is not "" then set commandText to "cd " & quoted form of targetDir & "; export COOP_DESKTOP_AGENT_DIR=" & quoted form of agentDir & " COOP_AGENT_DIR=" & quoted form of agentDir & " PI_CODING_AGENT_DIR=" & quoted form of agentDir & "; exec " & quoted form of coopExecutable
  if sessionFile is not "" then set commandText to commandText & " --session " & quoted form of sessionFile
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run`;
const WINDOWS_COMMAND = "$ErrorActionPreference='Stop'; Set-Location -LiteralPath $env:COOP_TERMINAL_CWD; if ($env:COOP_TERMINAL_SESSION) { & $env:COOP_TERMINAL_BIN --session $env:COOP_TERMINAL_SESSION } else { & $env:COOP_TERMINAL_BIN }";
const MODEL_LOGIN_APPLE_SCRIPT = `on run argv
  set targetDir to item 1 of argv
  set coopExecutable to item 2 of argv
  set agentDir to item 3 of argv
  set commandText to "cd " & quoted form of targetDir & "; export COOP_PRIME_MODEL_LOGIN=1 COOP_LOGIN_ONLY=1 COOP_WORKSPACE_ACCESS_MODE=read-only; exec " & quoted form of coopExecutable
  if agentDir is not "" then set commandText to "cd " & quoted form of targetDir & "; export COOP_DESKTOP_AGENT_DIR=" & quoted form of agentDir & " COOP_AGENT_DIR=" & quoted form of agentDir & " PI_CODING_AGENT_DIR=" & quoted form of agentDir & " COOP_PRIME_MODEL_LOGIN=1 COOP_LOGIN_ONLY=1 COOP_WORKSPACE_ACCESS_MODE=read-only; exec " & quoted form of coopExecutable
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run`;
const WINDOWS_MODEL_LOGIN = "$ErrorActionPreference='Stop'; Set-Location -LiteralPath $env:COOP_TERMINAL_CWD; $env:COOP_PRIME_MODEL_LOGIN='1'; $env:COOP_LOGIN_ONLY='1'; & $env:COOP_TERMINAL_BIN";

function windowsConsoleProcess(script, cwd, env) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // Start-Process gives the interactive child its own real console handles. A
  // Node child with ignored stdio cannot itself host the interactive Pi TUI.
  // Both commands are fixed code; workspace/session paths travel only in env.
  const bootstrap = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo','-NoExit','-NoProfile','-WindowStyle','Normal','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') -Verb Open -WindowStyle Normal -PassThru; [Console]::Out.WriteLine($p.Id)`;
  return { command: win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")], options: { cwd, env } };
}

function launchWindowsConsole(spec, spawnImpl, fields) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, { ...spec.options, detached: false, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Windows terminal launch timed out.")); }, 15000);
    child.stdout.on("data", data => { output += data; if (output.length > 128) child.kill(); });
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Windows terminal could not start.")); });
    child.once("close", code => {
      clearTimeout(timeout);
      const pid = Number(output.trim());
      if (code !== 0 || !/^\d+$/.test(output.trim()) || !Number.isSafeInteger(pid) || pid < 1) reject(new Error("Windows terminal could not start."));
      else resolve({ ok: true, pid, ...fields });
    });
  });
}

function isAbsolute(path) {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

function validatedAgentDir(agentDir) {
  if (agentDir == null || agentDir === "") return "";
  if (typeof agentDir !== "string" || !isAbsolute(agentDir) || /[\0\r\n]/.test(agentDir)) throw new Error("Managed Desktop agent folder is invalid.");
  return agentDir;
}

export function validateTerminalLaunch(value) {
  const launch = value?.launch;
  if (value?.ok !== true || !launch || launch.schemaVersion !== 1 || launch.kind !== "native-terminal") throw new Error("Runtime returned an invalid terminal launch request.");
  if (!HANDOFF_ID.test(launch.handoffId || "") || !MODES.has(launch.mode) || launch.executable !== "coop") throw new Error("Runtime returned an invalid terminal launch request.");
  if (typeof launch.cwd !== "string" || !isAbsolute(launch.cwd) || /[\0\r\n]/.test(launch.cwd)) throw new Error("Runtime returned an invalid terminal working folder.");
  const args = launch.args;
  if (launch.mode === "open") {
    if (!Array.isArray(args) || args.length !== 0) throw new Error("Runtime returned invalid terminal arguments.");
  } else if (!Array.isArray(args) || args.length !== 2 || args[0] !== "--session" || typeof args[1] !== "string" || !isAbsolute(args[1]) || !args[1].endsWith(".jsonl") || /[\0\r\n]/.test(args[1])) {
    throw new Error("Runtime returned invalid terminal session arguments.");
  }
  return launch;
}

export function buildNativeTerminalProcess(value, platform = process.platform, coopExecutable, agentDir = null) {
  const launch = validateTerminalLaunch(value);
  if (typeof coopExecutable !== "string" || !isAbsolute(coopExecutable) || /[\0\r\n]/.test(coopExecutable)) throw new Error("Coop executable is invalid.");
  const sessionPath = launch.args[1] || "";
  const isolatedAgentDir = validatedAgentDir(agentDir);
  if (platform === "darwin") {
    return { command: "/usr/bin/osascript", args: ["-e", APPLE_SCRIPT, "--", launch.cwd, sessionPath, coopExecutable, isolatedAgentDir], options: { cwd: launch.cwd } };
  }
  if (platform === "win32") {
    return windowsConsoleProcess(WINDOWS_COMMAND, launch.cwd, { ...process.env, COOP_TERMINAL_BIN: coopExecutable, COOP_TERMINAL_CWD: launch.cwd, COOP_TERMINAL_SESSION: sessionPath, ...(isolatedAgentDir ? { COOP_DESKTOP_AGENT_DIR: isolatedAgentDir, COOP_AGENT_DIR: isolatedAgentDir, PI_CODING_AGENT_DIR: isolatedAgentDir } : {}) });
  }
  return { command: "x-terminal-emulator", args: ["-e", coopExecutable, ...launch.args], options: { cwd: launch.cwd } };
}

export async function launchNativeTerminal(value, { platform = process.platform, coopExecutable, agentDir = null, spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  const spec = buildNativeTerminalProcess(value, platform, coopExecutable, agentDir);
  if (platform === "win32") return launchWindowsConsole(spec, spawnImpl, { mode: value.launch.mode });
  const result = await launchNativeProcess(spec, { spawnImpl, timeoutMs });
  return { ...result, mode: value.launch.mode };
}

export function buildNativeModelLoginProcess({ cwd, coopExecutable, agentDir = null, platform = process.platform }) {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) throw new Error("Model login working folder is invalid.");
  if (typeof coopExecutable !== "string" || !isAbsolute(coopExecutable) || /[\0\r\n]/.test(coopExecutable)) throw new Error("Coop executable is invalid.");
  const isolatedAgentDir = validatedAgentDir(agentDir);
  if (platform === "darwin") {
    return { command: "/usr/bin/osascript", args: ["-e", MODEL_LOGIN_APPLE_SCRIPT, "--", cwd, coopExecutable, isolatedAgentDir], options: { cwd } };
  }
  if (platform === "win32") {
    return windowsConsoleProcess(WINDOWS_MODEL_LOGIN, cwd, { ...process.env, COOP_WORKSPACE_ACCESS_MODE: "read-only", COOP_TERMINAL_BIN: coopExecutable, COOP_TERMINAL_CWD: cwd, ...(isolatedAgentDir ? { COOP_DESKTOP_AGENT_DIR: isolatedAgentDir, COOP_AGENT_DIR: isolatedAgentDir, PI_CODING_AGENT_DIR: isolatedAgentDir } : {}) });
  }
  return { command: "x-terminal-emulator", args: ["-e", "/usr/bin/env", "COOP_PRIME_MODEL_LOGIN=1", "COOP_LOGIN_ONLY=1", "COOP_WORKSPACE_ACCESS_MODE=read-only", coopExecutable], options: { cwd } };
}

export async function launchNativeModelLogin({ cwd, coopExecutable, agentDir = null, platform = process.platform, spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  const spec = buildNativeModelLoginProcess({ cwd, coopExecutable, agentDir, platform });
  if (platform === "win32") return launchWindowsConsole(spec, spawnImpl, { providerId: "model.openai-codex" });
  const result = await launchNativeProcess(spec, { spawnImpl, timeoutMs });
  return { ...result, providerId: "model.openai-codex" };
}export function launchNativeProcess(spec, { spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    const isInteractiveTerminal = spec.waitForExit === false || spec.command === "x-terminal-emulator";
    const waitForExit = spec.waitForExit ?? !isInteractiveTerminal;

    let child;
    try {
      child = spawnImpl(spec.command, spec.args, {
        ...spec.options,
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: false,
      });
    } catch (error) {
      return finish({ ok: false, error: error?.message || "Failed to spawn process.", pid: null });
    }

    if (typeof child?.on === "function") {
      child.on("error", (error) => {
        finish({ ok: false, error: error?.message || "Process spawn failed.", pid: null });
      });

      child.on("exit", (code, signal) => {
        if (code === 0 && !signal) {
          finish({ ok: true, pid: child?.pid || null });
        } else {
          const detail = signal
            ? (code !== null && code !== undefined ? `code ${code} (${signal})` : `signal ${signal}`)
            : `code ${code}`;
          finish({
            ok: false,
            error: `Launcher process exited with ${detail}.`,
            pid: child?.pid || null,
          });
        }
      });
    }

    if (typeof child?.unref === "function") {
      child.unref();
    }

    const pid = child?.pid || null;
    if (!pid) {
      if (typeof child?.on === "function") {
        setImmediate(() => {
          finish({ ok: false, error: "Failed to obtain process PID.", pid: null });
        });
        return;
      }
      return finish({ ok: false, error: "Failed to obtain process PID.", pid: null });
    }

    if (typeof child?.on !== "function") {
      return finish({ ok: true, pid });
    }

    if (!waitForExit) {
      // For long-lived interactive terminal sessions (e.g. Linux x-terminal-emulator),
      // confirm successful process spawn without waiting for session exit or killing the child after timeout.
      // Defers to next tick/turn to allow immediate spawn errors (e.g. ENOENT) to be delivered.
      setImmediate(() => {
        finish({ ok: true, pid });
      });
      return;
    }

    // For short-lived launchers (Windows cmd/start, macOS osascript), await confirmed launcher completion.
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (typeof child?.kill === "function") child.kill();
        } catch {}
        finish({
          ok: false,
          error: `Launcher process timed out after ${timeoutMs}ms without confirmation.`,
          pid: child?.pid || null,
        });
      }, timeoutMs);
    }
  });
}


