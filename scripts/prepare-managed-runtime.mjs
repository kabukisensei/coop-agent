#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { managedRuntimeBuildPlan } from "./managed-runtime-build-plan.mjs";
import { completeNpmIntegrity } from "./complete-npm-integrity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(message); }

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!new Set(["--target", "--work", "--output"]).has(key) || !argv[i + 1]) fail(`Unknown or incomplete argument: ${key || "<missing>"}.`);
    options[key.slice(2)] = key === "--target" ? argv[i + 1] : resolve(argv[i + 1]);
    i += 1;
  }
  options.target ||= `${process.platform}-${process.arch}`;
  for (const name of ["work", "output"]) if (!options[name]) fail(`--${name} is required.`);
  if (!isAbsolute(options.work) || !isAbsolute(options.output)) fail("Build paths must be absolute.");
  return options;
}

function run(command, args, { env = process.env, label = command } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env, windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || result.stdout || result.error?.message || ""}`.trim().slice(-3000);
    fail(`${label} failed${detail ? `: ${detail}` : "."}`);
  }
  return `${result.stdout || ""}`.trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadPinned(source, destination, label) {
  const temp = `${destination}.partial-${process.pid}`;
  let response;
  try {
    response = await fetch(source.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) fail(`${label} download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    const actual = await sha256(temp);
    if (actual !== source.sha256) fail(`${label} archive checksum mismatch (expected ${source.sha256}, got ${actual}).`);
    renameSync(temp, destination);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function pythonVersion(python) {
  const output = run(python, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], { label: "Python version check" });
  if (!/^3\.12\.\d+$/.test(output)) fail(`Managed tools require Python 3.12.x; found ${output || "unknown"}.`);
  return output;
}

export function preparationCommands(plan, paths) {
  const windows = plan.target.startsWith("win32-");
  const path = windows ? win32 : posix;
  const node = path.join(paths.nodeRoot, windows ? "node.exe" : "bin/node");
  const npmCli = path.join(paths.nodeRoot, windows ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
  const python = path.join(paths.pythonRoot, windows ? "python.exe" : "bin/python3");
  const pythonTools = plan.pipSpecs.map((spec) => {
    const name = spec.slice(0, spec.indexOf("=="));
    return Object.freeze({ name, spec, root: path.join(paths.work, "python-tools", name) });
  });
  return Object.freeze({
    npm: Object.freeze({ command: node, args: Object.freeze([npmCli, "install", "--prefix", paths.npmPrefix, "--no-save", "--no-audit", "--no-fund", ...plan.npmSpecs]) }),
    python: Object.freeze({ command: python }),
    pythonTools: Object.freeze(pythonTools.map((tool) => Object.freeze({
      ...tool,
      command: python,
      args: Object.freeze(["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-compile", "--target", tool.root, tool.spec]),
    }))),
    stage: Object.freeze({
      command: process.execPath,
      args: Object.freeze([
        join(ROOT, "scripts", "stage-managed-runtime.mjs"),
        "--output", paths.output,
        "--node-root", paths.nodeRoot,
        "--npm-prefix", paths.npmPrefix,
        "--python-root", paths.pythonRoot,
        ...pythonTools.flatMap((tool) => ["--python-tool", `${tool.name}=${tool.root}`]),
      ]),
    }),
  });
}

async function prepare() {
  const options = parseArgs(process.argv.slice(2));
  const hostTarget = `${process.platform}-${process.arch}`;
  if (options.target !== hostTarget) fail(`Execution must run on its target worker (${hostTarget}); requested ${options.target}.`);
  if (existsSync(options.work)) fail(`Work directory already exists; refusing contaminated input: ${options.work}`);
  if (existsSync(options.output)) fail(`Output already exists; refusing to overwrite: ${options.output}`);
  const plan = managedRuntimeBuildPlan(options.target);
  mkdirSync(options.work, { recursive: false });
  const nodeArchive = join(options.work, plan.node.file);
  const pythonArchive = join(options.work, plan.python.file);
  await downloadPinned(plan.node, nodeArchive, "Node");
  await downloadPinned(plan.python, pythonArchive, "Python");
  const nodeExtract = join(options.work, "node-extract");
  const pythonExtract = join(options.work, "python-extract");
  mkdirSync(nodeExtract);
  mkdirSync(pythonExtract);
  run("tar", ["-xf", nodeArchive, "-C", nodeExtract], { label: "Node archive extraction" });
  run("tar", ["-xf", pythonArchive, "-C", pythonExtract], { label: "Python archive extraction" });
  const nodeRoot = realpathSync(join(nodeExtract, plan.node.root));
  const pythonRoot = realpathSync(join(pythonExtract, plan.python.root));
  const npmPrefix = join(options.work, "npm");
  const paths = { work: options.work, output: options.output, nodeRoot, npmPrefix, pythonRoot };
  const commands = preparationCommands(plan, paths);
  const pyVersion = pythonVersion(commands.python.command);
  if (pyVersion !== plan.python.version) fail(`Managed Python ${pyVersion} does not match pinned ${plan.python.version}.`);
  const nodeBin = dirname(commands.npm.command);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const env = { ...process.env, [pathKey]: `${nodeBin}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey] || process.env.PATH || ""}` };
  run(commands.npm.command, commands.npm.args, { env, label: "Pinned npm dependency installation" });
  await completeNpmIntegrity({ npmPrefix, npmCli: commands.npm.args[0] });
  const pythonEnv = { ...env, PYTHONNOUSERSITE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" };
  for (const tool of commands.pythonTools) {
    run(tool.command, tool.args, { env: pythonEnv, label: `Pinned Python package ${tool.spec} installation` });
  }
  run(commands.stage.command, commands.stage.args, { label: "Managed runtime staging" });
  process.stdout.write(`${JSON.stringify({ ok: true, target: plan.target, output: options.output, node: plan.node.version, python: pyVersion })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare().catch((error) => { process.stderr.write(`prepare-managed-runtime: ${error.message}\n`); process.exitCode = 1; });
}
