#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const BOUND_MS = 180_000;
const POLL_MS = 5_000;
const CANDIDATE = "ed516b2a183f3e6346344a669d6e37b321a4dcf8";
const now = () => new Date().toISOString();
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const root = resolve("desktop/dist-installers");
const output = process.env.INSTALLER_PROBE_OUT;
const identityPath = process.env.INSTALLER_BUILD_IDENTITY;
const controlRoot = resolve("_probe-control");
const treeProbe = join(controlRoot, "scripts", "windows-process-tree-snapshot.py");
const reg = win32.join(process.env.SystemRoot, "System32", "reg.exe");
const taskkill = win32.join(process.env.SystemRoot, "System32", "taskkill.exe");
const registryRoots = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.env.COOP_DESKTOP_DISPOSABLE_INSTALL_TEST !== "1") throw new Error("Installer discriminator requires an explicitly enabled disposable GitHub-hosted Windows runner.");
if (!output || !identityPath || !process.env.RUNNER_TEMP || !win32.isAbsolute(process.env.RUNNER_TEMP)) throw new Error("Bounded output, build identity, and runner temporary directory are required.");

function queryRegistryRoot(registryRoot) {
  let text = "";
  try { text = execFileSync(reg, ["query", registryRoot, "/s"], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { if (error.status !== 1) return { error: error.code || `exit-${error.status}`, entries: [] }; }
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^HKEY_/i.test(trimmed)) { current = { key: trimmed, values: {} }; entries.push(current); continue; }
    const match = line.match(/^\s+([^\s]+)\s+REG_[^\s]+\s+(.*)$/i);
    if (current && match) current.values[match[1]] = match[2].trim();
  }
  return { error: null, entries: entries.filter(entry => /^Coop Desktop/i.test(entry.values.DisplayName || "")) };
}

function queryRegistry() {
  const results = registryRoots.map(queryRegistryRoot);
  return { queriedAt: now(), errors: results.map((result, index) => result.error ? { root: registryRoots[index], error: result.error } : null).filter(Boolean), installations: results.flatMap(result => result.entries) };
}

async function target(path, type) {
  try {
    const value = await stat(path);
    return { exists: type === "directory" ? value.isDirectory() : value.isFile(), size: value.size, mtimeMs: Math.round(value.mtimeMs) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, size: null, mtimeMs: null };
    return { exists: false, size: null, mtimeMs: null, error: error.code || error.name };
  }
}

function snapshotTree(pid) {
  try { return JSON.parse(execFileSync("python", [treeProbe, String(pid)], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 })); }
  catch (error) { return { rootPid: pid, rootPresent: null, processes: [], error: error.code || `exit-${error.status}` }; }
}

function digestFile(path) { return readFile(path).then(bytes => createHash("sha256").update(bytes).digest("hex")); }

const report = { schemaVersion: 1, diagnosticOnly: true, candidate: CANDIDATE, boundMs: BOUND_MS, pollMs: POLL_MS, ok: false, samples: [], firstAppearance: {}, registry: {}, cleanup: {} };
let state = null;
let installed = null;
let appData = null;
let marker = null;
let sentinel = null;
let child = null;
let pid = null;
let processClosed = false;
let processExitAt = null;
let processExitCode = null;
let processSignal = null;
let timedOut = false;
let lastSignature = null;
let stableTicks = 0;
let payloadStatsStableAt = null;
let lastKnownTree = [];
let buildIdentity = null;

try {
  const files = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && /^Coop-Desktop-.*\.exe$/i.test(entry.name));
  if (files.length !== 1) throw new Error("Expected exactly one candidate NSIS installer.");
  const installer = join(root, files[0].name);
  report.installer = files[0].name;
  report.installerSha256 = await digestFile(installer);
  report.installerSize = (await stat(installer)).size;
  if (identityPath) {
    buildIdentity = JSON.parse(await readFile(identityPath, "utf8"));
    if (buildIdentity.productCandidateSha !== CANDIDATE || buildIdentity.checksums?.installerSha256 !== report.installerSha256) {
      throw new Error("Installer build identity does not match the exact product candidate and installer bytes.");
    }
    report.buildIdentity = {
      productCandidateSha: buildIdentity.productCandidateSha,
      productCandidateTree: buildIdentity.productCandidateTree,
      diagnosticOnly: buildIdentity.diagnosticOnly === true,
      releaseAcceptance: buildIdentity.releaseAcceptance === true,
    };
  }

  const beforeRegistry = queryRegistry();
  report.registry.before = beforeRegistry;
  if (beforeRegistry.errors.length || beforeRegistry.installations.length) throw new Error("Refusing discriminator because registry precondition is not clean.");
  appData = join(process.env.APPDATA, "Coop Desktop");
  if (!win32.isAbsolute(appData) || existsSync(appData)) throw new Error("Refusing discriminator because disposable application-data path is unavailable or occupied.");

  state = await mkdtemp(join(process.env.RUNNER_TEMP, "coop-installer-first-install-"));
  installed = join(state, "Coop Desktop");
  const workspace = join(state, "workspace");
  await mkdir(workspace);
  await mkdir(appData);
  marker = join(appData, "installer-acceptance-sentinel.txt");
  sentinel = randomBytes(32).toString("hex");
  await writeFile(marker, sentinel, { flag: "wx" });

  const candidateVerifier = await import(pathToFileURL(resolve("desktop/scripts/verify-windows-installer.mjs")));
  const invocation = candidateVerifier.buildNsisInvocation(installer, installed);
  report.invocation = { flags: invocation.args.slice(0, -1), directoryArgumentKind: "/D=", windowsVerbatimArguments: invocation.options.windowsVerbatimArguments === true };
  const paths = {
    installDirectory: installed,
    executable: join(installed, "Coop Desktop.exe"),
    appAsar: join(installed, "resources", "app.asar"),
    managedRuntime: join(installed, "resources", "managed-runtime"),
  };

  report.process = { startedAt: now() };
  const startedMs = Date.now();
  child = spawn(invocation.executable, invocation.args, { ...invocation.options, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  pid = child.pid || null;
  report.process.pid = pid;
  let outputBytes = { stdout: 0, stderr: 0 };
  child.stdout.on("data", chunk => { outputBytes.stdout += chunk.length; });
  child.stderr.on("data", chunk => { outputBytes.stderr += chunk.length; });
  child.once("error", error => { report.process.spawnError = error.code || error.name; });
  const closed = new Promise(done => child.once("close", (code, signal) => {
    processClosed = true; processExitAt = now(); processExitCode = code; processSignal = signal; done();
  }));

  async function observe() {
    const observedAt = now();
    const filesNow = {};
    for (const [name, path] of Object.entries(paths)) filesNow[name] = await target(path, name === "installDirectory" || name === "managedRuntime" ? "directory" : "file");
    for (const [name, value] of Object.entries(filesNow)) if (value.exists && !report.firstAppearance[name]) report.firstAppearance[name] = observedAt;
    const signature = JSON.stringify(filesNow);
    const payloadChanged = signature !== lastSignature;
    if (payloadChanged) { lastSignature = signature; stableTicks = 0; report.filesystemLastChangedAt = observedAt; }
    else stableTicks += 1;
    const payloadPresent = Object.values(filesNow).some(value => value.exists);
    const payloadComplete = Object.values(filesNow).every(value => value.exists);
    if (payloadComplete && stableTicks >= 1 && !payloadStatsStableAt) payloadStatsStableAt = observedAt;
    const registryNow = queryRegistry();
    if (registryNow.installations.length && !report.registry.firstAppearedAt) report.registry.firstAppearedAt = observedAt;
    const completeRegistration = registryNow.installations.find(entry => entry.values.DisplayVersion && entry.values.UninstallString && entry.values.UninstallString.toLowerCase().includes(installed.toLowerCase()));
    if (completeRegistration && !report.registry.completedAt) {
      report.registry.completedAt = observedAt;
      report.registry.displayVersion = completeRegistration.values.DisplayVersion;
      report.registry.uninstallString = completeRegistration.values.UninstallString;
      report.registry.completeWhileInstallerAlive = !processClosed;
    }
    const tree = pid ? snapshotTree(pid) : { rootPid: null, rootPresent: false, processes: [] };
    if (tree.processes.length) lastKnownTree = tree.processes;
    let stateName = processClosed ? "installer-exited" : !payloadPresent ? "installer-alive-no-payload"
      : payloadChanged ? "payload-actively-changing"
        : payloadComplete && report.registry.completedAt ? "payload-complete-installer-alive" : "payload-present-incomplete-stable";
    report.samples.push({ observedAt, elapsedMs: Date.now() - startedMs, state: stateName, files: filesNow,
      registry: { errors: registryNow.errors, count: registryNow.installations.length, complete: Boolean(completeRegistration) }, processTree: tree });
  }

  await observe();
  while (!processClosed && Date.now() - startedMs < BOUND_MS) {
    await Promise.race([closed, delay(Math.min(POLL_MS, BOUND_MS - (Date.now() - startedMs)))]);
    await observe();
  }
  if (!processClosed) {
    timedOut = true;
    report.process.boundExceededAt = now();
    try { execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); report.cleanup.processTreeTermination = "taskkill-root-tree-exit-0"; }
    catch (error) { report.cleanup.processTreeTermination = `taskkill-root-tree-${error.status ?? error.code ?? "failed"}`; }
    await Promise.race([closed, delay(5_000)]);
  }
  await observe();

  report.process.exitAt = processExitAt;
  report.process.exitCode = processExitCode;
  report.process.signal = processSignal;
  report.process.exceededBound = timedOut;
  report.process.elapsedMs = Date.now() - startedMs;
  report.process.outputBytes = outputBytes;
  report.payloadStatsStableAt = payloadStatsStableAt;
  report.payloadStatsStableBeforeExit = Boolean(payloadStatsStableAt && processExitAt && payloadStatsStableAt <= processExitAt);
  report.process.lastKnownOwnedTree = lastKnownTree;

  const finalRegistry = queryRegistry();
  report.registry.afterProcess = finalRegistry;
  const finalFiles = report.samples.at(-1)?.files || {};
  const anyPayload = Object.values(finalFiles).some(value => value.exists);
  const payloadComplete = Object.values(finalFiles).every(value => value.exists);
  const registryComplete = Boolean(report.registry.completedAt);
  if (finalFiles.executable?.exists && finalFiles.appAsar?.exists && finalFiles.managedRuntime?.exists) {
    const installedIdentity = {
      executableSha256: await digestFile(paths.executable),
      appAsarSha256: await digestFile(paths.appAsar),
      managedRuntimeManifestSha256: await digestFile(join(paths.managedRuntime, "manifest.json")),
      managedRuntimeInventorySha256: await digestFile(join(paths.managedRuntime, "dependency-inventory.json")),
    };
    installedIdentity.matchesBuiltPackage = installedIdentity.executableSha256 === buildIdentity.checksums.packagedExecutableSha256
      && installedIdentity.appAsarSha256 === buildIdentity.checksums.packagedAppAsarSha256
      && installedIdentity.managedRuntimeManifestSha256 === buildIdentity.checksums.managedRuntimeManifestSha256
      && installedIdentity.managedRuntimeInventorySha256 === buildIdentity.checksums.managedRuntimeInventorySha256;
    report.installedPayloadIdentity = installedIdentity;
  }
  const payloadIdentityMatchesBuild = report.installedPayloadIdentity?.matchesBuiltPackage === true;
  const recentlyChanging = report.filesystemLastChangedAt && Date.parse(report.process.boundExceededAt || processExitAt || now()) - Date.parse(report.filesystemLastChangedAt) < POLL_MS * 2;
  const descendants = report.samples.at(-1)?.processTree?.processes?.filter(process => process.pid !== pid) || [];
  if (!timedOut && processExitCode === 0 && payloadComplete && registryComplete && payloadIdentityMatchesBuild && !descendants.length) report.decision = "FIRST_INSTALL_COMPLETE";
  else if (timedOut && !anyPayload && !finalRegistry.installations.length) report.decision = "INSTALLER_STARTUP_HANG";
  else if (timedOut && recentlyChanging) report.decision = "INSTALLER_TOO_SLOW_FOR_ACCEPTANCE";
  else if (payloadComplete && registryComplete && descendants.length) report.decision = "INSTALLER_CHILD_LIFECYCLE";
  else if (timedOut && payloadComplete && registryComplete) report.decision = "INSTALLER_EXIT_HANG";
  else report.decision = "INSTALLER_INCONCLUSIVE";
  report.ok = report.decision === "FIRST_INSTALL_COMPLETE";
} catch (error) {
  report.error = error.message;
  report.decision ||= "INSTALLER_INCONCLUSIVE";
} finally {
  if (pid && child && !processClosed) {
    try { execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); report.cleanup.finalProcessTreeTermination = "taskkill-root-tree-exit-0"; }
    catch (error) { report.cleanup.finalProcessTreeTermination = `taskkill-root-tree-${error.status ?? error.code ?? "failed"}`; }
  }
  const afterTree = pid ? snapshotTree(pid) : { rootPid: pid, rootPresent: false, processes: [] };
  report.cleanup.processTreeAfterCleanup = afterTree;
  report.cleanup.processTreeConfirmedGone = afterTree.rootPresent === false && afterTree.processes.length === 0;
  const registered = queryRegistry();
  report.cleanup.registryKeysRemoved = [];
  for (const entry of registered.installations) {
    try { execFileSync(reg, ["delete", entry.key, "/f"], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); report.cleanup.registryKeysRemoved.push(entry.key); }
    catch (error) { report.cleanup.registryDeleteError = error.code || `exit-${error.status}`; }
  }
  report.cleanup.registryAfterCleanup = queryRegistry();
  report.cleanup.registryConfirmedClean = report.cleanup.registryAfterCleanup.installations.length === 0 && report.cleanup.registryAfterCleanup.errors.length === 0;
  if (state) { try { await rm(state, { recursive: true, force: true }); report.cleanup.testInstallDirectoryRemoved = !existsSync(state); } catch (error) { report.cleanup.testInstallDirectoryRemovalError = error.code || error.name; } }
  if (marker && sentinel) {
    try { report.cleanup.userDataSentinelPreserved = (await readFile(marker, "utf8")) === sentinel; }
    catch { report.cleanup.userDataSentinelPreserved = false; }
  }
  report.cleanup.confirmed = report.cleanup.processTreeConfirmedGone && report.cleanup.registryConfirmedClean && report.cleanup.testInstallDirectoryRemoved === true && report.cleanup.userDataSentinelPreserved === true;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ decision: report.decision, ok: report.ok, pid: report.process?.pid, elapsedMs: report.process?.elapsedMs, cleanupConfirmed: report.cleanup.confirmed }));
}
