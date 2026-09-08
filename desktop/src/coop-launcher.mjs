import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute as posixIsAbsolute, join as posixJoin } from "node:path";
import { win32 } from "node:path";

function defaultAvailable(candidate, platform) {
  try {
    if (platform === "win32") return existsSync(candidate);
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function absolute(path, platform) {
  return platform === "win32" ? win32.isAbsolute(path) : posixIsAbsolute(path);
}

function findOnPath(name, { platform, env, available }) {
  const pathValue = platform === "win32" ? (env.Path || env.PATH || "") : (env.PATH || "");
  const pathApi = platform === "win32" ? win32 : { join: posixJoin };
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    if (!absolute(directory, platform)) continue;
    for (const suffix of extensions) {
      const candidate = pathApi.join(directory, platform === "win32" ? `${name}${suffix.toLowerCase()}` : name);
      if (available(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function resolveCoopLauncher(input = "coop", { platform = process.platform, env = process.env, available = defaultAvailable } = {}) {
  if (typeof input !== "string" || !input || /[\0\r\n]/.test(input)) throw new Error("Coop launcher is invalid.");
  if (!absolute(input, platform) && input !== "coop") throw new Error("A relative Coop launcher path is not allowed.");
  const target = absolute(input, platform) ? input : findOnPath("coop", { platform, env, available });
  if (!target || !available(target, platform)) throw new Error("Coop is not installed or is unavailable on PATH.");

  if (platform !== "win32") {
    return { command: target, commandPrefix: [], terminalExecutable: target };
  }

  const extension = win32.extname(target).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return { command: target, commandPrefix: [], terminalExecutable: target };
  }
  const script = extension === ".ps1" ? target : target.slice(0, -extension.length) + ".ps1";
  if (!new Set([".cmd", ".bat", ".ps1"]).has(extension) || !available(script, platform)) {
    throw new Error("The Windows Coop launcher is missing its trusted PowerShell dispatcher.");
  }
  const powershell = findOnPath("pwsh", { platform, env, available })
    || findOnPath("powershell", { platform, env, available });
  if (!powershell) throw new Error("PowerShell is required to start Coop Runtime on Windows.");
  return {
    command: powershell,
    commandPrefix: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    terminalExecutable: target,
  };
}
