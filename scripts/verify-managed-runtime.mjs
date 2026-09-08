#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedRuntime, resolveDesktopCoopLauncher } from "../desktop/src/managed-runtime.mjs";
import { startCoopRuntime } from "../desktop/src/runtime-supervisor.mjs";
import { buildNativeProbeEnvironment } from "../desktop/scripts/verify-native-application.mjs";
import { verifyManagedToolWork } from "./verify-managed-tool-work.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(message); }
function parseArgs(argv) {
  const result = { environment: "inherited" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--bundle", "--workspace", "--agent", "--environment"]).has(key) || !value) fail(`Unknown or incomplete argument: ${key || "<missing>"}.`);
    if (key === "--environment") {
      if (!["inherited", "native"].includes(value)) fail("--environment must be inherited or native.");
      result.environment = value;
    } else result[key.slice(2)] = resolve(value);
  }
  for (const key of ["bundle", "workspace", "agent"]) if (!result[key] || !isAbsolute(result[key])) fail(`--${key} must be absolute.`);
  return result;
}

async function authenticatedGet(origin, token, path) {
  const landing = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  if (!landing.ok) fail(`Runtime authentication failed (${landing.status}).`);
  const cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie?.startsWith("coop_token=")) fail("Runtime did not issue its authenticated cookie.");
  const response = await fetch(`${origin}${path}`, { headers: { cookie } });
  if (!response.ok) fail(`Runtime ${path} failed (${response.status}).`);
  return response.json();
}

async function verifyBundle() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.workspace)) fail("Workspace is unavailable.");
  mkdirSync(options.agent, { recursive: true });
  const bundle = inspectManagedRuntime(options.bundle);
  const toolWork = verifyManagedToolWork(bundle);
  const resourcesPath = dirname(options.bundle);
  if (join(resourcesPath, "managed-runtime") !== options.bundle) fail("Bundle must be named managed-runtime for packaged resolution verification.");
  const launchEnv = options.environment === "native"
    ? buildNativeProbeEnvironment(join(options.agent, "launch-environment"), undefined)
    : process.env;
  if (options.environment === "native") {
    delete launchEnv.COOP_DESKTOP_UPDATE_PROBE;
    for (const path of new Set([launchEnv.HOME, launchEnv.TEMP, launchEnv.APPDATA, launchEnv.LOCALAPPDATA].filter(Boolean))) mkdirSync(path, { recursive: true });
  }
  const launcher = resolveDesktopCoopLauncher({ packaged: true, resourcesPath, env: launchEnv });
  if (launcher.source !== "managed" || realpathSync(launcher.managedRoot) !== realpathSync(options.bundle)) fail("Desktop did not select the managed runtime.");

  const env = {
    ...launchEnv,
    COOP_DESKTOP_AGENT_DIR: options.agent,
    COOP_AGENT_DIR: options.agent,
    PI_CODING_AGENT_DIR: options.agent,
    COOP_SKIP_AZ: "1",
    COOP_NO_ONBOARD: "1",
  };
  const runtimePids = [], startupMilliseconds = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    const started = performance.now();
    const runtime = await startCoopRuntime({
      workspace: options.workspace,
      coopCommand: launcher.command,
      commandPrefix: launcher.commandPrefix,
      env,
      readyTimeoutMs: options.environment === "native" ? 20_000 : 60_000,
      onStderr: (text) => process.stderr.write(text),
    });
    startupMilliseconds.push(Math.round(performance.now() - started));
    try {
      if (runtime.ready.shutdownProtocol !== "http-v1") fail("Runtime does not support owner-controlled shutdown.");
      const access = await authenticatedGet(runtime.ready.endpoint, runtime.ready.oneTimeToken, "/workspace/access");
      if (access.access?.mode !== "write") fail("Runtime did not acquire writable workspace access during start/restart.");
      const capabilities = await authenticatedGet(runtime.ready.endpoint, runtime.ready.oneTimeToken, "/capabilities");
      if (capabilities.contractVersion !== 1 || capabilities.versions?.coop !== bundle.versions.coop || capabilities.versions?.pi !== bundle.versions.pi) fail("Runtime capability versions do not match the managed bundle.");
      for (const [integration, expected] of [["coop-data-doc", bundle.versions.pythonTools["coop-data-doc"]], ["coop-sql-review", bundle.versions.pythonTools["coop-sql-review"]], ["coop-dax-review", bundle.versions.pythonTools["coop-dax-review"]]]) {
        if (capabilities.versions?.[integration === "coop-data-doc" ? "dataDoc" : integration === "coop-sql-review" ? "sqlReview" : "daxReview"] !== expected) fail(`Runtime capability version mismatch: ${integration}.`);
      }
      const authPath = join(options.agent, "auth.json");
      if (existsSync(authPath) && readFileSync(authPath).length > 2) fail("Managed smoke unexpectedly populated model credentials.");
    } finally {
      await runtime.stop({ graceMs: 5000 });
    }
    runtimePids.push(runtime.ready.runtimePid);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, environment: options.environment, launcher: launcher.command, startupMilliseconds, target: `${process.platform}-${process.arch}`, versions: bundle.versions, runtimePid: runtimePids[0], restartRuntimePid: runtimePids[1], shutdownConfirmed: true, immediateWritableRestart: true, toolWork })}\n`);
}

verifyBundle().catch((error) => { process.stderr.write(`verify-managed-runtime: ${error.message}\n`); process.exitCode = 1; });
