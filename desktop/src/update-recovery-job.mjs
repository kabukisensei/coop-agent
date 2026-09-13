import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectManagedRuntime } from "./managed-runtime.mjs";
import { runUpdateCommand } from "./update-installer.mjs";
import { bootSessionId, disarmRecoveryWorker, recoveryPaths, saveRecoveryRecord } from "./update-recovery-worker.mjs";

const xml = value => String(value).replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[char]));
export function recoveryJobPlist({ paths, node, uid }) {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("Recovery user identity is invalid.");
  const args = [node, join(paths.workerApp, "Contents", "Resources", "update-helper", "update-recovery-worker.mjs"), "--recover", paths.requestPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(paths.label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>AbandonProcessGroup</key><false/>
<key>StandardErrorPath</key><string>${xml(join(paths.root, "recovery.log"))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>\n`;
}

// Construct the worker from the currently trusted app, never the candidate.
// The independent bundle stays reachable across activation and rollback swaps.
export async function createMacRecoveryJob({ request, targetVersion, helperPid = process.pid,
  home = homedir(), uid = process.getuid?.(), bootId = null, platform = process.platform,
  execute = runUpdateCommand, inspectRuntime = inspectManagedRuntime, signal } = {}) {
  if (platform !== "darwin") throw new Error("Update recovery jobs require macOS.");
  bootId ||= bootSessionId();
  const root = join(request.userData, "update-recovery", randomUUID());
  const requestPath = join(root, "request.json");
  const record = { schemaVersion: 1, phase: "watching", appPath: request.appPath, userData: request.userData,
    versionRoot: request.versionRoot, currentVersion: request.currentVersion, targetVersion,
    helperPid, parentPid: request.parentPid, runtimePid: request.runtimePid, bootId };
  const paths = recoveryPaths(requestPath, record, home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", request.appPath], { signal });
  await execute("/usr/bin/ditto", [request.appPath, paths.workerApp], { signal });
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", paths.workerApp], { signal });
  const info = JSON.parse(await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(paths.workerApp, "Contents", "Info.plist")], { signal }));
  if (info.CFBundleIdentifier !== "com.cooptimize.coop.desktop" || info.CFBundleShortVersionString !== request.currentVersion) throw new Error("Recovery app identity changed.");
  await access(join(paths.workerApp, "Contents", "Resources", "update-helper", "update-recovery-worker.mjs"));
  const runtime = inspectRuntime(join(paths.workerApp, "Contents", "Resources", "managed-runtime"));
  await saveRecoveryRecord(requestPath, record);
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
  await writeFile(paths.plist, recoveryJobPlist({ paths, node: runtime.node, uid }), { mode: 0o600, flag: "wx" });
  try {
    await execute("/bin/launchctl", ["bootstrap", `gui/${uid}`, paths.plist], { signal });
  } catch (error) {
    // An interrupted bootstrap may have registered the service already.
    await disarmRecoveryWorker(paths, record, { execute, uid }).catch(() => {});
    throw error;
  }
  return Object.freeze({ paths, record, disarm: () => disarmRecoveryWorker(paths, record, { execute, uid }) });
}
