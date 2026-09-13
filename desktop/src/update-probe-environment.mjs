import { join, win32 } from "node:path";

// Native update and CI probes use the same disposable home and OS-only launch
// environment. Never inherit provider credentials or workstation tool paths.
export function buildNativeProbeEnvironment(profile, token, platform = process.platform, source = process.env) {
  const paths = platform === "win32" ? win32 : { join };
  const env = {
    HOME: profile, USERPROFILE: profile,
    TMPDIR: paths.join(profile, "tmp"), TMP: paths.join(profile, "tmp"), TEMP: paths.join(profile, "tmp"),
    COOP_SKIP_AZ: "1", COOP_NO_ONBOARD: "1", PI_OFFLINE: "1",
    COOP_DESKTOP_UPDATE_PROBE: token,
  };
  if (platform === "win32") {
    if (!source.SystemRoot || !win32.isAbsolute(source.SystemRoot)) throw new Error("Windows SystemRoot is required for the native probe.");
    env.OS = "Windows_NT";
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    env.SystemRoot = source.SystemRoot;
    env.WINDIR = source.SystemRoot;
    env.APPDATA = win32.join(profile, "AppData", "Roaming");
    env.LOCALAPPDATA = win32.join(profile, "AppData", "Local");
    env.ComSpec = win32.join(source.SystemRoot, "System32", "cmd.exe");
    env.PATH = [win32.join(source.SystemRoot, "System32"), win32.join(source.SystemRoot, "System32", "WindowsPowerShell", "v1.0"), source.SystemRoot].join(";");
  } else env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}
