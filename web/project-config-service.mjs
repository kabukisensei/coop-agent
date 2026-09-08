import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_CONFIG_PROPOSAL_SCHEMA_VERSION = 1;
// COOP_ROOT is exported by both supported launchers. The fallback keeps direct
// module/unit-test use working when this file is not bundled into an extension.
const ROOT = resolve(process.env.COOP_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const CONFIG_MAX = 512 * 1024;

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function syncFile(path, flags = "r+") {
  // Windows FlushFileBuffers requires write access. r+ preserves existing bytes
  // while allowing the newly written temporary file or backup to be flushed.
  const fd = openSync(path, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path) {
  // POSIX permits fsync on a directory so the rename itself is durable. Some
  // Windows filesystems reject opening a directory as a file; atomic rename is
  // still preserved there and the managed updater/config tests cover recovery.
  try { syncFile(path, "r"); } catch { /* unsupported by this filesystem */ }
}

function readExisting(path) {
  if (!existsSync(path)) return null;
  if (statSync(path).size > CONFIG_MAX) throw new TypeError("Existing project configuration exceeds the 512 KiB limit.");
  return readFileSync(path, "utf8");
}

function normalizedCandidate(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Project configuration must not be empty.");
  if (value.includes("\0")) throw new TypeError("Project configuration contains an invalid NUL character.");
  if (Buffer.byteLength(value, "utf8") > CONFIG_MAX) throw new TypeError("Project configuration exceeds the 512 KiB limit.");
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function getProjectConfig({ workspace }) {
  const root = resolve(workspace);
  const targetPath = join(root, ".coop", "project.yml");
  const content = readExisting(targetPath);
  return {
    schemaVersion: PROJECT_CONFIG_PROPOSAL_SCHEMA_VERSION,
    workspace: root,
    targetPath,
    state: content === null ? "not-configured" : "configured",
    content,
  };
}

async function defaultValidate(content) {
  return await new Promise((resolveResult, reject) => {
    const python = process.env.COOP_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, [join(ROOT, "lib", "project_config_validate.py")], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || "Project configuration validation failed."));
      else {
        try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("Project configuration validator returned invalid JSON.")); }
      }
    });
    child.stdin.end(content);
  });
}

export async function proposeProjectConfig({ workspace, candidate, validate = defaultValidate, proposalId = randomUUID() }) {
  const root = resolve(workspace);
  const targetPath = join(root, ".coop", "project.yml");
  const content = normalizedCandidate(candidate);
  const before = readExisting(targetPath);
  const validation = await validate(content);
  const valid = validation?.valid === true;
  return {
    schemaVersion: PROJECT_CONFIG_PROPOSAL_SCHEMA_VERSION,
    proposalId,
    workspace: root,
    targetPath,
    state: valid ? "proposed" : "invalid",
    baseDigest: before === null ? null : digest(before),
    candidateDigest: digest(content),
    changed: before !== content,
    preview: { before, after: content },
    validation: { valid, diagnostics: Array.isArray(validation?.diagnostics) ? validation.diagnostics : [] },
    requiresApproval: true,
  };
}

export function applyProjectConfig(proposal, { now = new Date(), rename = renameSync } = {}) {
  if (proposal?.schemaVersion !== 1 || proposal.state !== "proposed" || proposal.validation?.valid !== true) throw new TypeError("Only a valid proposed configuration can be applied.");
  const root = resolve(proposal.workspace);
  const target = join(root, ".coop", "project.yml");
  if (target !== proposal.targetPath) throw new Error("Project configuration target no longer matches its workspace.");
  const current = readExisting(target);
  const currentDigest = current === null ? null : digest(current);
  if (currentDigest !== proposal.baseDigest) return { ...proposal, state: "stale", backupPath: null };
  const content = normalizedCandidate(proposal.preview.after);
  if (digest(content) !== proposal.candidateDigest) throw new Error("Project configuration proposal content was modified after validation.");
  if (!proposal.changed) return { ...proposal, state: "applied", backupPath: null };

  const coopDir = dirname(target);
  const backupDir = join(root, ".backups");
  mkdirSync(coopDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace(/-/g, "").replace("T", "_").replace(/:/g, "");
  let backupPath = current === null ? null : join(backupDir, `project.yml.${stamp}.bak`);
  if (backupPath && existsSync(backupPath)) backupPath = join(backupDir, `project.yml.${stamp}.${randomUUID()}.bak`);
  if (backupPath) {
    copyFileSync(target, backupPath);
    syncFile(backupPath);
  }
  const temporary = join(coopDir, `.project.yml.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    syncFile(temporary);
    rename(temporary, target);
    syncDirectory(coopDir);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* absent */ }
    throw error;
  }
  return { ...proposal, state: "applied", backupPath };
}
