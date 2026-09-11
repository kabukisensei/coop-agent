// Cross-client workspace ownership and managed Git worktree lifecycle.
//
// The lease protects a checkout, not a Pi session file. A normal writer owns one
// canonical checkout exclusively. Additional clients must attach read-only, use a
// Coop-managed worktree, or record an explicit override. No function accepts a
// renderer-supplied command, executable, worktree path, or Git option.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, win32 } from "node:path";

const execFileAsync = promisify(execFile);

export const WORKSPACE_LEASE_SCHEMA_VERSION = 1;
export const MANAGED_WORKTREE_SCHEMA_VERSION = 1;
export const DEFAULT_WORKSPACE_HEARTBEAT_MS = 5_000;
export const DEFAULT_WORKSPACE_STALE_MS = 20_000;

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const WORKTREE_ID = /^wt-[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ACCESS_MODES = new Set(["write", "read-only", "override"]);

function platformResolve(value, platform) {
  return platform === "win32" ? win32.resolve(value) : resolve(value);
}

export function normalizeWorkspacePath(value, platform = process.platform) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError("Workspace path is invalid.");
  let canonical = platformResolve(value, platform);
  if (platform === process.platform && existsSync(canonical)) {
    try { canonical = realpathSync.native(canonical); } catch { /* lexical fallback */ }
  }
  canonical = canonical.replace(/[\\/]+$/, "") || canonical;
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function workspaceLeaseKey(value, platform = process.platform) {
  return createHash("sha256").update(normalizeWorkspacePath(value, platform)).digest("hex");
}

function positive(value, fallback) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

async function runGit(cwd, args, { maxBuffer = 1024 * 1024 } = {}) {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer,
      shell: false,
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      missing: error?.code === "ENOENT",
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim(),
      code: error?.code,
    };
  }
}

export async function inspectWorkspace(cwd) {
  const workspacePath = normalizeWorkspacePath(cwd);
  const top = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout) {
    return {
      schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
      workspacePath,
      git: false,
      repositoryRoot: null,
      gitCommonDir: null,
      isWorktree: false,
      worktreeEligible: false,
    };
  }
  const repositoryRoot = normalizeWorkspacePath(top.stdout);
  const [common, gitDir] = await Promise.all([
    runGit(repositoryRoot, ["rev-parse", "--git-common-dir"]),
    runGit(repositoryRoot, ["rev-parse", "--git-dir"]),
  ]);
  const absoluteGitPath = (raw) => normalizeWorkspacePath(resolve(repositoryRoot, raw));
  const gitCommonDir = common.ok && common.stdout ? absoluteGitPath(common.stdout) : null;
  const resolvedGitDir = gitDir.ok && gitDir.stdout ? absoluteGitPath(gitDir.stdout) : null;
  return {
    schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
    workspacePath: repositoryRoot,
    git: true,
    repositoryRoot,
    gitCommonDir,
    isWorktree: Boolean(gitCommonDir && resolvedGitDir && gitCommonDir !== resolvedGitDir),
    worktreeEligible: true,
  };
}

function validOwner(value) {
  return value?.schemaVersion === WORKSPACE_LEASE_SCHEMA_VERSION
    && typeof value.leaseId === "string" && value.leaseId.length > 0
    && typeof value.workspacePath === "string" && value.workspacePath.length > 0
    && typeof value.ownerId === "string" && OWNER_ID.test(value.ownerId)
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.clientInterface === "string" && value.clientInterface.length > 0
    && ["write", "override"].includes(value.accessMode)
    && typeof value.createdAt === "string"
    && typeof value.lastHeartbeatAt === "string";
}

function conflictChoices(worktreeEligible) {
  return [
    {
      mode: "worktree",
      available: worktreeEligible,
      approvalOperation: "worktree.create",
      description: worktreeEligible ? "Create an isolated Coop-managed Git worktree." : "Unavailable because this folder is not a Git worktree.",
    },
    { mode: "read-only", available: true, approvalOperation: null, description: "Attach without workspace mutation authority." },
    { mode: "override", available: true, approvalOperation: "workspace.write.override", description: "Allow concurrent writes to this checkout after explicit approval." },
  ];
}

export class WorkspaceLeaseManager {
  constructor({
    agentDir,
    ownerId,
    clientInterface = "unknown",
    pid = process.pid,
    processStartedAt = new Date(Date.now() - Math.max(0, process.uptime()) * 1000),
    now = () => new Date(),
    processAlive = defaultProcessAlive,
    heartbeatMs = DEFAULT_WORKSPACE_HEARTBEAT_MS,
    staleMs = DEFAULT_WORKSPACE_STALE_MS,
    platform = process.platform,
    onLost,
  } = {}) {
    if (typeof agentDir !== "string" || !agentDir || agentDir.includes("\0")) throw new TypeError("Agent directory is required.");
    if (typeof ownerId !== "string" || !OWNER_ID.test(ownerId)) throw new TypeError("Workspace lease owner ID is invalid.");
    this.root = join(resolve(agentDir), "workspace-leases", `v${WORKSPACE_LEASE_SCHEMA_VERSION}`);
    this.ownerId = ownerId;
    this.clientInterface = String(clientInterface).slice(0, 64) || "unknown";
    this.pid = pid;
    this.processStartedAt = processStartedAt.toISOString();
    this.now = now;
    this.processAlive = processAlive;
    this.heartbeatMs = positive(heartbeatMs, DEFAULT_WORKSPACE_HEARTBEAT_MS);
    this.staleMs = Math.max(this.heartbeatMs * 2, positive(staleMs, DEFAULT_WORKSPACE_STALE_MS));
    this.platform = platform;
    this.onLost = onLost;
    this.active = null;
    this.timer = null;
    this.lossReported = false;
  }

  paths(cwd) {
    const workspacePath = normalizeWorkspacePath(cwd, this.platform);
    const lockDir = join(this.root, workspaceLeaseKey(workspacePath, this.platform));
    return { workspacePath, lockDir, ownerPath: join(lockDir, "owner.json") };
  }

  readOwner(ownerPath) {
    try {
      const value = JSON.parse(readFileSync(ownerPath, "utf8"));
      return validOwner(value) ? value : null;
    } catch { return null; }
  }

  readOverrides(lockDir, primary) {
    const directory = join(lockDir, "overrides");
    try {
      if (lstatSync(directory).isSymbolicLink()) return null;
      const owners = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) return null;
        const owner = this.readOwner(join(directory, entry.name));
        if (!owner || owner.accessMode !== "override"
          || owner.workspacePath !== primary.workspacePath
          || owner.overridesLeaseId !== primary.leaseId) return null;
        owners.push(owner);
      }
      return owners;
    } catch (error) { return error?.code === "ENOENT" ? [] : null; }
  }

  writeJsonAtomic(path, value) {
    const temporary = join(dirname(path), `.${this.pid}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }

  inspect(cwd) {
    const paths = this.paths(cwd);
    if (this.active?.workspacePath === paths.workspacePath) {
      return { ok: true, state: "already-owned", owner: this.active.owner, access: this.publicAccess() };
    }
    try {
      const stat = lstatSync(paths.lockDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, state: "invalid", code: "workspace-lease-invalid", message: "Workspace lease storage is invalid." };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, state: "available", owner: null };
      return { ok: false, state: "invalid", code: "workspace-lease-invalid", message: "Workspace lease could not be inspected." };
    }
    const owner = this.readOwner(paths.ownerPath);
    if (!owner || owner.workspacePath !== paths.workspacePath) {
      return { ok: false, state: "invalid", code: "workspace-lease-invalid", message: "Workspace lease metadata is missing or invalid." };
    }
    const heartbeat = Date.parse(owner.lastHeartbeatAt);
    const overrides = this.readOverrides(paths.lockDir, owner);
    const released = typeof owner.releasedAt === "string" && Number.isFinite(Date.parse(owner.releasedAt));
    const explicitlyReleased = released && overrides !== null && overrides.length === 0;
    const recoverable = explicitlyReleased || (Number.isFinite(heartbeat)
      && this.now().getTime() - heartbeat > this.staleMs
      && (released || !this.processAlive(owner.pid))
      && overrides !== null
      && overrides.every(item => Number.isFinite(Date.parse(item.lastHeartbeatAt))
        && this.now().getTime() - Date.parse(item.lastHeartbeatAt) > this.staleMs
        && !this.processAlive(item.pid)));
    return { ok: false, state: "held", code: "workspace-write-conflict", owner, recoverable };
  }

  publicAccess() {
    if (!this.active) return null;
    return {
      schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
      mode: this.active.mode,
      workspacePath: this.active.workspacePath,
      leaseId: this.active.owner?.leaseId || null,
      overridesLeaseId: this.active.overridesLeaseId || null,
      delegated: false,
    };
  }

  acquire(cwd, { mode = "write", approved = false, repository = null } = {}) {
    if (!ACCESS_MODES.has(mode)) throw new TypeError("Workspace access mode is invalid.");
    if (mode === "override" && approved !== true) throw new TypeError("Explicit approval is required for a workspace write override.");
    if (this.active) this.release();
    const paths = this.paths(repository?.repositoryRoot || cwd);
    const worktreeEligible = repository ? repository.worktreeEligible === true : false;
    if (mode === "read-only") {
      this.active = { mode, workspacePath: paths.workspacePath, owner: null, overridePath: null, overridesLeaseId: null };
      return { ok: true, state: "attached", access: this.publicAccess() };
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    let recovered = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(paths.lockDir, { mode: 0o700 });
        const at = this.now().toISOString();
        const owner = {
          schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
          leaseId: randomUUID(),
          workspacePath: paths.workspacePath,
          repositoryRoot: repository?.repositoryRoot || null,
          gitCommonDir: repository?.gitCommonDir || null,
          ownerId: this.ownerId,
          pid: this.pid,
          processStartedAt: this.processStartedAt,
          clientInterface: this.clientInterface,
          accessMode: "write",
          createdAt: at,
          lastHeartbeatAt: at,
        };
        try { this.writeJsonAtomic(paths.ownerPath, owner); } catch (error) { rmSync(paths.lockDir, { recursive: true, force: true }); throw error; }
        this.active = { mode: "write", workspacePath: paths.workspacePath, lockDir: paths.lockDir, ownerPath: paths.ownerPath, owner, overridePath: null, overridesLeaseId: null };
        this.startHeartbeat();
        return { ok: true, state: "acquired", access: this.publicAccess(), recovered };
      } catch (error) {
        if (error?.code !== "EEXIST") return { ok: false, state: "invalid", code: "workspace-lease-invalid", message: `Could not acquire workspace ownership: ${error?.message || error}` };
      }
      const held = this.inspect(paths.workspacePath);
      if (held.ok) continue;
      if (mode === "override" && held.state === "held" && held.owner && !held.recoverable) {
        const overrideDir = join(paths.lockDir, "overrides");
        mkdirSync(overrideDir, { recursive: true, mode: 0o700 });
        const overrideKey = createHash("sha256").update(this.ownerId).digest("hex");
        const overridePath = join(overrideDir, `${overrideKey}.json`);
        const at = this.now().toISOString();
        const owner = {
          schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
          leaseId: randomUUID(),
          workspacePath: paths.workspacePath,
          ownerId: this.ownerId,
          pid: this.pid,
          processStartedAt: this.processStartedAt,
          clientInterface: this.clientInterface,
          accessMode: "override",
          createdAt: at,
          lastHeartbeatAt: at,
          overridesLeaseId: held.owner.leaseId,
        };
        this.writeJsonAtomic(overridePath, owner);
        this.active = { mode: "override", workspacePath: paths.workspacePath, lockDir: paths.lockDir, ownerPath: paths.ownerPath, owner, overridePath, overridesLeaseId: held.owner.leaseId };
        this.startHeartbeat();
        return { ok: true, state: "overridden", access: this.publicAccess(), conflictOwner: held.owner };
      }
      if (!held.recoverable || !held.owner) {
        return {
          ok: false,
          state: held.state,
          code: held.code,
          message: `This checkout is already writable in ${held.owner?.clientInterface || "another Coop client"}.`,
          owner: held.owner,
          choices: conflictChoices(worktreeEligible),
        };
      }
      const stalePath = `${paths.lockDir}.stale.${this.pid}.${randomUUID()}`;
      try {
        renameSync(paths.lockDir, stalePath);
        recovered = held.owner;
        rmSync(stalePath, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") return { ok: false, state: "invalid", code: "workspace-lease-invalid", message: "Could not recover stale workspace ownership." };
      }
    }
    return { ok: false, state: "held", code: "workspace-write-conflict", message: "Workspace ownership changed repeatedly; retry.", choices: conflictChoices(worktreeEligible) };
  }

  heartbeat() {
    if (!this.active || this.active.mode === "read-only") return true;
    const path = this.active.overridePath || this.active.ownerPath;
    const current = this.readOwner(path);
    if (!current || current.leaseId !== this.active.owner.leaseId) {
      if (!this.lossReported) { this.lossReported = true; this.onLost?.("Workspace write ownership was lost."); }
      return false;
    }
    current.lastHeartbeatAt = this.now().toISOString();
    try { this.writeJsonAtomic(path, current); this.active.owner = current; return true; } catch { return false; }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  release() {
    this.stopHeartbeat();
    if (!this.active) return false;
    const active = this.active;
    this.active = null;
    if (active.mode === "read-only") return true;
    const path = active.overridePath || active.ownerPath;
    const current = this.readOwner(path);
    if (!current || current.leaseId !== active.owner.leaseId) return false;
    if (active.overridePath) {
      try { unlinkSync(active.overridePath); return true; } catch { return false; }
    }
    // Approved concurrent writers own their individual records. Releasing the
    // original writer must not delete those records and revoke their authority.
    // Keep the group until its remaining writers are gone; normal stale recovery
    // requires every recorded writer to have stopped and its heartbeat to expire.
    const overrides = this.readOverrides(active.lockDir, current);
    if (overrides === null || overrides.length > 0) {
      try { this.writeJsonAtomic(active.ownerPath, { ...current, releasedAt: this.now().toISOString() }); return true; }
      catch { return false; }
    }
    try { rmSync(active.lockDir, { recursive: true, force: true }); return true; } catch { return false; }
  }
}

function managedRoots(agentDir) {
  mkdirSync(resolve(agentDir), { recursive: true, mode: 0o700 });
  const base = join(normalizeWorkspacePath(agentDir), "workspace-worktrees", `v${MANAGED_WORKTREE_SCHEMA_VERSION}`);
  return { base, checkouts: join(base, "checkouts"), records: join(base, "records") };
}

function validManagedId(id) {
  if (typeof id !== "string" || !WORKTREE_ID.test(id)) throw new TypeError("Managed worktree ID is invalid.");
  return id;
}

function readManagedRecord(agentDir, id) {
  validManagedId(id);
  const roots = managedRoots(agentDir);
  const metadataPath = join(roots.records, `${id}.json`);
  let record;
  try { record = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { throw new TypeError("Managed worktree record is unavailable."); }
  if (record?.schemaVersion !== MANAGED_WORKTREE_SCHEMA_VERSION || record.id !== id || record.metadataPath !== metadataPath) {
    throw new TypeError("Managed worktree record is invalid.");
  }
  const checkoutPath = normalizeWorkspacePath(record.checkoutPath);
  const rel = relative(roots.checkouts, checkoutPath);
  if (!rel || rel.startsWith("..") || resolve(roots.checkouts, rel) !== checkoutPath) throw new TypeError("Managed worktree path escapes Coop state.");
  return { record: { ...record, checkoutPath }, roots, metadataPath };
}

export async function createManagedWorktree({ cwd, agentDir, ownerId, approved = false, createId = () => randomUUID() } = {}) {
  if (approved !== true) throw new TypeError("Explicit approval is required before creating a managed worktree.");
  if (typeof ownerId !== "string" || !OWNER_ID.test(ownerId)) throw new TypeError("Managed worktree owner ID is invalid.");
  const repository = await inspectWorkspace(cwd);
  if (!repository.git || !repository.repositoryRoot) return { ok: false, code: "worktree-unavailable", message: "This folder is not a Git worktree." };
  const rawId = String(createId()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 70);
  const id = validManagedId(`wt-${rawId}`);
  const roots = managedRoots(agentDir);
  const checkoutParent = join(roots.checkouts, workspaceLeaseKey(repository.gitCommonDir || repository.repositoryRoot), id);
  const checkoutPath = join(checkoutParent, "checkout");
  const metadataPath = join(roots.records, `${id}.json`);
  mkdirSync(checkoutParent, { recursive: true, mode: 0o700 });
  mkdirSync(roots.records, { recursive: true, mode: 0o700 });
  if (existsSync(metadataPath) || existsSync(checkoutPath)) return { ok: false, code: "worktree-id-conflict", message: "Managed worktree ID already exists." };
  const added = await runGit(repository.repositoryRoot, ["worktree", "add", "--detach", checkoutPath, "HEAD"], { maxBuffer: 2 * 1024 * 1024 });
  if (!added.ok) {
    rmSync(checkoutParent, { recursive: true, force: true });
    return { ok: false, code: "worktree-create-failed", message: "Git could not create the isolated worktree." };
  }
  const record = {
    schemaVersion: MANAGED_WORKTREE_SCHEMA_VERSION,
    id,
    ownerId,
    repositoryRoot: repository.repositoryRoot,
    gitCommonDir: repository.gitCommonDir,
    checkoutPath: normalizeWorkspacePath(checkoutPath),
    metadataPath,
    createdAt: new Date().toISOString(),
    state: "active",
  };
  try {
    const temporary = join(roots.records, `.${id}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, metadataPath);
  } catch (error) {
    await runGit(repository.repositoryRoot, ["worktree", "remove", checkoutPath]);
    rmSync(checkoutParent, { recursive: true, force: true });
    throw error;
  }
  return { ok: true, record };
}

export async function removeManagedWorktree({ agentDir, id, approved = false } = {}) {
  if (approved !== true) throw new TypeError("Explicit approval is required before removing a managed worktree.");
  const { record, metadataPath } = readManagedRecord(agentDir, id);
  if (!existsSync(record.checkoutPath)) return { ok: false, code: "worktree-missing", message: "The managed worktree folder is missing; repair it manually." };
  const status = await runGit(record.checkoutPath, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok || status.stdout) return { ok: false, code: "worktree-not-clean", message: "The managed worktree has changes or could not be verified; cleanup was cancelled." };
  const removed = await runGit(record.repositoryRoot, ["worktree", "remove", record.checkoutPath]);
  if (!removed.ok) return { ok: false, code: "worktree-remove-failed", message: "Git refused to remove the managed worktree; no force option was used." };
  unlinkSync(metadataPath);
  rmSync(dirname(record.checkoutPath), { recursive: true, force: true });
  return { ok: true, id: record.id, checkoutPath: record.checkoutPath };
}

export function workspaceConflictChoices(worktreeEligible) {
  return conflictChoices(worktreeEligible === true);
}
