// "Open in terminal" and "Open folder": run coop itself in a real console
// window. Paths travel only through environment variables, never through a
// command line a shell parses (salvaged from the September desktop line,
// desktop/src/native-terminal.mjs, Windows path only).
import { win32 } from "node:path";

const SCRIPTS = {
  // coop in the terminal, in the same folder, on the same session file.
  terminal: [
    "$ErrorActionPreference='Stop'",
    "Set-Location -LiteralPath $env:COOP_TERMINAL_CWD",
    "if ($env:COOP_TERMINAL_SESSION) { & $env:COOP_TERMINAL_COOP --session $env:COOP_TERMINAL_SESSION } else { & $env:COOP_TERMINAL_COOP }",
  ].join("; "),
  // `coop desktop` in another folder: its preflight shows in this console,
  // which closes once the new window is up and stays open on a failure. The
  // installed package (D1c) names itself, so the new window is the same exe.
  window: [
    "Set-Location -LiteralPath $env:COOP_TERMINAL_CWD",
    "if ($env:COOP_TERMINAL_APP) { & $env:COOP_TERMINAL_COOP desktop --app $env:COOP_TERMINAL_APP } else { & $env:COOP_TERMINAL_COOP desktop }",
    "if ($LASTEXITCODE) { Read-Host 'Press Enter to close' }",
  ].join("; "),
};

function encoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function checkPath(name, value) {
  if (typeof value !== "string" || !win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${name} is not an absolute path`);
}

/** The process that opens a new console running coop. Windows only. */
export function consoleProcess({ mode = "terminal", coop, cwd, session = "", app = "", env, systemRoot = process.env.SystemRoot }) {
  const script = SCRIPTS[mode];
  if (!script) throw new Error(`unknown console mode ${mode}`);
  checkPath("coop", coop);
  checkPath("cwd", cwd);
  if (session) checkPath("session", session);
  if (app) checkPath("app", app);
  checkPath("SystemRoot", systemRoot);
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const keepOpen = mode === "terminal" ? "'-NoExit'," : "";
  // Start-Process gives the child its own real console; the inner command is fixed text.
  const outer = `Start-Process -FilePath '${powershell.replace(/'/g, "''")}' -ArgumentList @('-NoLogo',${keepOpen}'-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded(script)}') -WindowStyle Normal`;
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(outer)],
    options: { cwd, env: { ...env, COOP_TERMINAL_COOP: coop, COOP_TERMINAL_CWD: cwd, COOP_TERMINAL_SESSION: session, COOP_TERMINAL_APP: app }, windowsHide: true, shell: false, detached: true, stdio: "ignore" },
  };
}
