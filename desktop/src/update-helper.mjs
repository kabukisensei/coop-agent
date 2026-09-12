import { createMacRecoveryJob } from "./update-recovery-job.mjs";
import { writeFile } from "node:fs/promises";
import { createHealthProfile } from "./update-health-profile.mjs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareMacUpdate, runUpdateCommand, verifyMacUpdateApplication } from "./update-installer.mjs";
import { replaceMacApplication } from "./update-replacement.mjs";
import { compareVersions, verifySignedUpdateDescriptor } from "./update-service.mjs";
import { startCoopRuntime } from "./runtime-supervisor.mjs";
import { nativeApplicationHealth } from "./update-native-health.mjs";
import { swapMacDirectories } from "./update-swap.mjs";
import { inspectManagedRuntime } from "./managed-runtime.mjs";

export function validateHelperRequest(value, parentPid) {
  const fields = ["appPath", "artifactPath", "channel", "currentVersion", "manifest", "parentPid", "runtimePid", "signature", "trustStore", "type", "userData", "versionRoot", "workspace"];
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields.sort()) || value.type !== "prepare" || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error("Update helper request is invalid.");
  if (!Number.isSafeInteger(value.parentPid) || value.parentPid !== parentPid || !Number.isSafeInteger(value.runtimePid) || value.runtimePid <= 0 || value.runtimePid === value.parentPid) throw new Error("Update helper process ownership is invalid.");
  for (const key of ["appPath", "artifactPath", "userData", "versionRoot", "workspace"]) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key]) || /[\0\r\n]/.test(value[key])) throw new Error("Update helper path is invalid.");
  }
  if (typeof value.currentVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.currentVersion)) throw new Error("Current Desktop version is invalid.");
  if (typeof value.manifest !== "string" || Buffer.from(value.manifest, "base64").toString("base64") !== value.manifest) throw new Error("Update helper manifest is invalid.");
  return value;
}

export async function waitForStoppedProcesses(pids, { signal, timeoutMs = 60000, alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
} } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(alive)) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("The previous Desktop or runtime is still running.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  signal?.throwIfAborted();
}

export async function runtimeHealth(appPath, request, descriptor, signal, { start = startCoopRuntime, fetchImpl = fetch } = {}) {
  const profile = await createHealthProfile(request.versionRoot, "runtime");
  const runtime = await start({ workspace: request.workspace,
    coopCommand: join(appPath, "Contents", "Resources", "managed-runtime", "bin", "coop-desktop"),
    env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", COOP_DESKTOP_AGENT_DIR: profile.path, COOP_SKIP_AZ: "1", COOP_NO_ONBOARD: "1" },
    readyTimeoutMs: 60000 });
  let healthy = false;
  try {
    signal.throwIfAborted();
    const origin = runtime.ready.endpoint;
    const landing = await fetchImpl(`${origin}/?token=${runtime.ready.oneTimeToken}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const cookie = landing.headers.get("set-cookie")?.split(";")[0];
    if (!landing.ok || !cookie) return false;
    const response = await fetchImpl(`${origin}/capabilities`, { headers: { cookie }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const capabilities = await response.json();
    return healthy = response.ok && capabilities.contractVersion === descriptor.protocolVersion && capabilities.versions?.coop === descriptor.coopVersion;
  } finally {
    await runtime.stop({ graceMs: 5000 });
    if (healthy) await profile.discard();
  }
}

async function applicationHealth(appPath, request, descriptor, signal) {
  return await runtimeHealth(appPath, request, descriptor, signal)
    && await nativeApplicationHealth(appPath, request, descriptor, signal);
}

export async function runUpdateHelper({ request, parentPid, authorize, notify = () => {}, signal,
  prepare = prepareMacUpdate, replace = replaceMacApplication, waitStopped = waitForStoppedProcesses,
  health = applicationHealth, createRecovery = createMacRecoveryJob, execute = runUpdateCommand, now = Date.now, platform = process.platform, arch = process.arch } = {}) {
  validateHelperRequest(request, parentPid);
  const signed = { manifestBytes: Buffer.from(request.manifest, "base64"), signature: request.signature, trustStore: request.trustStore, channel: request.channel };
  const descriptor = verifySignedUpdateDescriptor({ ...signed, now: now(), platform, arch });
  if (compareVersions(descriptor.desktopVersion, request.currentVersion) <= 0) throw new Error("Update helper cannot downgrade or replace the same version.");
  async function verifyCurrent() {
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", request.appPath], { signal });
    const info = JSON.parse(await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(request.appPath, "Contents", "Info.plist")], { signal }));
    if (info.CFBundleIdentifier !== "com.cooptimize.coop.desktop" || info.CFBundleShortVersionString !== request.currentVersion) throw new Error("The installed app changed before update activation.");
  }
  await verifyCurrent();
  const prepared = await prepare({ ...signed, artifactPath: request.artifactPath, versionRoot: request.versionRoot, signal, now: now(), platform, arch });
  const discardPrepared = async () => { try { await prepared.discard?.(); } catch { /* Storage cleanup cannot prevent restart or hide the original failure. */ } };
  let recoveryJob;
  try { recoveryJob = await createRecovery({ request, targetVersion: descriptor.desktopVersion, signal, platform }); }
  catch (error) { await discardPrepared(); throw error; }
  let authorized = false, settled = false;
  try {
    notify({ type: "ready", version: descriptor.desktopVersion });
    await authorize();
    authorized = true;
    await waitStopped([request.parentPid, request.runtimePid], { signal });
    // Trust/expiry must still hold after preparation and the shutdown wait.
    verifySignedUpdateDescriptor({ ...signed, now: now(), platform, arch });
    async function recordOutcome(value) {
      try {
        await writeFile(join(request.userData, "update-result.json"), JSON.stringify(value) + "\n", { mode: 0o600 });
      } catch {
        // Reporting must never prevent relaunch of a healthy or restored app.
        notify({ type: "outcome-unavailable" });
      }
    }
    let result;
    try {
      result = await replace({ appPath: request.appPath, candidatePath: prepared.installPath, runtimeStopped: true, signal,
        swap: (left, right, options) => swapMacDirectories(left, right, { ...options,
          pythonPath: inspectManagedRuntime(join(prepared.installPath, "Contents", "Resources", "managed-runtime"), { platform, arch }).python }),
        validateCandidate: async path => { await verifyMacUpdateApplication(path, descriptor, { signal, platform, arch }); await verifyCurrent(); },
        checkHealth: (path, { signal }) => health(path, request, descriptor, signal) });
    } catch (error) {
      // Replacement reports failure after attempting to restore the original app.
      await recordOutcome({ status: "failed", message: "Update failed. The prior application may have been restored; inspect the update log before retrying." });
      if (error.message === "Update failed; the previous application is restored.") {
        await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", request.appPath]);
        await execute("/usr/bin/open", ["-n", request.appPath, "--args", `--user-data-dir=${request.userData}`]);
        settled = true;
      }
      throw error;
    }
    await recordOutcome({ status: "healthy", version: descriptor.desktopVersion });
    await execute("/usr/bin/open", ["-n", request.appPath, "--args", `--user-data-dir=${request.userData}`]);
    settled = true;
    return result;
  } finally {
    // An authorized interruption leaves the independent job armed. It can recover
    // after this helper exits or the machine next starts its GUI session.
    if (!authorized || settled) {
      await recoveryJob.disarm();
      await discardPrepared();
    }
  }
}

async function main() {
  const parentPid = process.ppid;
  const abort = new AbortController();
  let requestResolve, authorizeResolve, authorizeReject, authorized = false;
  const initial = new Promise(resolve => { requestResolve = resolve; });
  const authorization = new Promise((resolve, reject) => { authorizeResolve = resolve; authorizeReject = reject; });
  authorization.catch(() => {});
  const cancel = () => { abort.abort(); authorizeReject(new Error("Update handoff cancelled.")); };
  process.on("SIGTERM", cancel);
  process.on("disconnect", () => { if (!authorized) cancel(); });
  process.on("message", message => {
    if (message?.type === "prepare") { requestResolve(message); requestResolve = () => {}; }
    else if (message?.type === "apply") { authorized = true; authorizeResolve(); }
    else if (message?.type === "cancel") cancel();
  });
  const request = await initial;
  try {
    await runUpdateHelper({ request, parentPid, signal: abort.signal, authorize: () => authorization,
      notify: message => { if (process.connected) process.send(message); } });
  } catch {
    process.stderr.write("Coop update helper: installation did not complete successfully.\n");
    if (process.connected) process.send({ type: "error" });
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && typeof process.send === "function") void main();
