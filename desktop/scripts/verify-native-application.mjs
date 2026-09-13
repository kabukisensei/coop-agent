#!/usr/bin/env node
// Development/CI acceptance probe. Production update policy is unchanged.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createHealthProfile, waitForProbeGroupExit } from "../src/update-health-profile.mjs";
import { terminateWindowsRuntimeTree } from "../src/runtime-supervisor.mjs";
import { packagedPaths, verifyManagedPackage } from "./verify-managed-package.mjs";

import { buildNativeProbeEnvironment } from "../src/update-probe-environment.mjs";
export { buildNativeProbeEnvironment };

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolveWait => { timer = setTimeout(() => resolveWait(null), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function processGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

export async function probeNativeApplication({ executable, version, workspace, profileRoot, timeoutMs = 90000 }, { spawnImpl = spawn } = {}) {
  if (![executable, workspace, profileRoot].every(value => typeof value === "string" && isAbsolute(value))) throw new Error("Native application probe paths must be absolute.");
  if (typeof version !== "string" || !version || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Native application probe configuration is invalid.");
  const profile = await createHealthProfile(profileRoot, "native");
  const token = randomBytes(32).toString("hex");
  const env = buildNativeProbeEnvironment(profile.path, token);
  for (const path of new Set([env.TEMP, env.APPDATA, env.LOCALAPPDATA].filter(Boolean))) await mkdir(path, { recursive: true });
  await writeFile(join(profile.path, "desktop-state.json"), JSON.stringify({ schemaVersion: 1, lastWorkspace: workspace }), { mode: 0o600 });
  let child;
  try {
    child = spawnImpl(executable, [`--user-data-dir=${profile.path}`], {
      cwd: workspace, env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw new Error(`Native application launch failed; profile retained at ${profile.path}.`); }
  let ready = false, failed = false, output = "", outputBytes = 0, stderr = "", invalidate;
  const invalid = new Promise(resolveInvalid => { invalidate = () => resolveInvalid({ invalid: true }); });
  const closed = new Promise(resolveClosed => child.once("close", (code, signal) => resolveClosed({ code, signal })));
  child.on("error", () => { failed = true; });
  child.stdout.on("data", chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 65536) { failed = true; invalidate(); return; }
    output += chunk.toString("utf8");
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "desktop.update-health" && event.token === token && event.version === version) ready = true;
      } catch { /* Native diagnostics can share stdout. */ }
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); });
  let result = await bounded(Promise.race([closed, invalid]), timeoutMs);
  if (!result || result.invalid) {
    failed = true;
    try {
      if (child.pid) {
        if (process.platform === "win32") await terminateWindowsRuntimeTree(child.pid);
        else process.kill(-child.pid, "SIGKILL");
      }
    } catch { /* Failure remains a failed probe, even if the process already exited. */ }
    result = await bounded(closed, 5000);
  }
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failed = true; }
    if (!await waitForProbeGroupExit(child.pid)) failed = true;
  }
  if (!result) {
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  if (failed || !ready || result?.code !== 0 || !processGone(child.pid)) {
    const diagnostics = stderr.replaceAll(token, "[probe challenge]");
    await writeFile(join(profile.path, "native-probe-stderr.log"), diagnostics, { mode: 0o600 });
    const error = new Error(`Native application did not confirm renderer/chat readiness and clean exit; profile retained at ${profile.path}.`);
    error.diagnostics = diagnostics;
    error.observation = { ready, exitCode: result?.code ?? null, signal: result?.signal ?? null, mainPid: child.pid ?? null, stdoutBytes: outputBytes, mainProcessExited: processGone(child.pid) };
    throw error;
  }
  const profileRemoved = await profile.discard();
  if (!profileRemoved) throw new Error(`Native application profile cleanup could not be confirmed at ${profile.path}.`);
  return { ok: true, platform: process.platform, version, mainPid: child.pid, rendererAndChatReady: true,
    runtimeShutdownReported: true, mainProcessExited: true, profileRemoved: true,
    credentialsCopied: false, modelGenerationRequested: false, visualAcceptance: false };
}

async function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist-managed");
  let output;
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--root", "--output"].includes(argv[i]) || !argv[i + 1]) throw new Error("Expected --root or --output followed by a path.");
    if (argv[i] === "--root") root = resolve(argv[i + 1]); else output = resolve(argv[i + 1]);
  }
  const verified = await verifyManagedPackage({ root });
  const paths = packagedPaths(root);
  const { extractFile } = await import("@electron/asar");
  const version = JSON.parse(extractFile(verified.appAsar, "package.json").toString("utf8")).version;
  const stateRoot = await mkdtemp(join(tmpdir(), "coop-native-acceptance-"));
  const workspace = join(stateRoot, "workspace");
  await mkdir(workspace);
  const executable = process.platform === "darwin" ? join(paths.fuseTarget, "Contents", "MacOS", "Coop Desktop") : paths.fuseTarget;
  let result;
  try { result = await probeNativeApplication({ executable, version, workspace, profileRoot: stateRoot }); }
  catch (error) {
    if (output) await writeFile(output, `${JSON.stringify({ ok: false, platform: process.platform, version, error: error.message, diagnostics: error.diagnostics || "", observation: error.observation || null }, null, 2)}\n`);
    throw error;
  }
  if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
