#!/usr/bin/env node
// Repeatable local-only measurement for DSK-011. It always uses stub Pi and
// terminates the shell after the existing SPA reaches the Changes panel.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.argv[2];
const binaries = {
  preview: join(ROOT, "desktop", "dist", "mac-arm64", "Coop Desktop Preview.app", "Contents", "MacOS", "Coop Desktop Preview"),
  electron: join(ROOT, "desktop", "spikes", "electron", "dist", "mac-arm64", "Coop Desktop Spike.app", "Contents", "MacOS", "Coop Desktop Spike"),
  tauri: join(ROOT, "desktop", "spikes", "tauri", "src-tauri", "target", "release", "bundle", "macos", "Coop Desktop Tauri Spike.app", "Contents", "MacOS", "coop-desktop-tauri-spike"),
};
if (!Object.hasOwn(binaries, shell)) {
  process.stderr.write("Usage: node scripts/measure-desktop-shell-spike.mjs preview|electron|tauri\n");
  process.exit(2);
}

const start = performance.now();
const child = spawn(binaries[shell], [], {
  cwd: ROOT,
  env: {
    ...process.env,
    COOP_BIN: join(ROOT, "tests", "fixtures", "stub-desktop-coop.mjs"),
    COOP_WORKSPACE: ROOT,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let done = false;
const timeout = setTimeout(() => finish(new Error(`${shell} did not load the Changes panel within 20 seconds.`)), 20_000);
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
    if (output.includes("GET /git/changes -> 200")) finish();
  });
}
child.once("error", finish);
child.once("exit", (code, signal) => {
  if (!done) {
    done = true;
    clearTimeout(timeout);
    process.stderr.write(`${shell} exited before ready (${code ?? signal ?? "unknown"}).\n${output.slice(-2000)}`);
    process.exitCode = 1;
  }
});

async function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  const readyMs = Math.round(performance.now() - start);
  if (child.exitCode === null) {
    child.kill("SIGINT");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(killTimer);
  }
  if (error) {
    process.stderr.write(`${error.message}\n${output.slice(-2000)}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ shell, readyMs, marker: "GET /git/changes -> 200", cleanExit: true })}\n`);
}
