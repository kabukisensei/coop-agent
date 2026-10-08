// The coop window's Windows taskbar identity: one app id for every window,
// and an icon and relaunch command the Windows shell can read itself.
//
// Without them a window started from the terminal install (`coop desktop`, or
// the "coop" shortcut that runs bin\coop-desktop.ps1) belongs to Electron's own
// electron.exe, so the taskbar shows Electron's icon and a pinned button starts
// bare Electron. The installed package's coop.exe carries coop's icon itself;
// its id here is the package's appId, which its installer also writes on the
// Start Menu shortcut, so the window, the shortcut and a pinned button group
// as one coop.
import { win32 } from "node:path";

/** The package's appId (desktop/installer/electron-builder.cjs). */
export const APP_ID = "com.cooptimize.coop";

/**
 * BrowserWindow.setAppDetails options for this launch. The packaged exe is its
 * own icon and relaunch command; the terminal install points at its checkout's
 * themes\coop.ico and relaunches through the same launcher its "coop" shortcut
 * runs. The shell reads these paths directly, so none may be inside the asar.
 */
export function taskbarDetails({ packaged, execPath, repo, systemRoot }) {
  if (packaged) {
    return { appId: APP_ID, appIconPath: execPath, appIconIndex: 0, relaunchCommand: `"${execPath}"`, relaunchDisplayName: "coop" };
  }
  const powershell = win32.join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const launcher = win32.join(repo, "bin", "coop-desktop.ps1");
  return {
    appId: APP_ID,
    appIconPath: win32.join(repo, "themes", "coop.ico"),
    appIconIndex: 0,
    relaunchCommand: `"${powershell}" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${launcher}" desktop`,
    relaunchDisplayName: "coop",
  };
}
