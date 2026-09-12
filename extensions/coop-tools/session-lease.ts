import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SESSION_LEASE_SCHEMA_VERSION = 1;
export const DEFAULT_SESSION_LEASE_HEARTBEAT_MS = 5_000;
export const DEFAULT_SESSION_LEASE_STALE_MS = 20_000;

export interface SessionLeaseOwner {
  schemaVersion: 1;
  leaseId: string;
  sessionPath: string;
  pid: number;
  processStartedAt: string;
  clientInterface: string;
  createdAt: string;
  lastHeartbeatAt: string;
}

export interface SessionLeaseConflict {
  ok: false;
  state: "held" | "invalid";
  message: string;
  owner?: SessionLeaseOwner;
}

export interface SessionLeaseAcquired {
  ok: true;
  state: "acquired" | "already-owned" | "available";
  lease?: SessionLeaseOwner;
  recovered?: SessionLeaseOwner;
}

export type SessionLeaseResult = SessionLeaseConflict | SessionLeaseAcquired;

interface SessionLeaseOptions {
  agentDir: string;
  clientInterface?: string;
  heartbeatMs?: number;
  staleMs?: number;
  pid?: number;
  processStartedAt?: Date;
  now?: () => Date;
  processAlive?: (pid: number) => boolean;
  onLost?: (message: string) => void;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

export function normalizeSessionLeasePath(sessionPath: string, platform = process.platform): string {
  const absolute = resolve(sessionPath);
  let canonical = absolute;
  if (existsSync(absolute)) {
    try {
      canonical = realpathSync.native(absolute);
    } catch {
      canonical = absolute;
    }
  }
  canonical = canonical.replace(/[\\/]+$/, "") || canonical;
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function sessionLeaseKey(sessionPath: string, platform = process.platform): string {
  return createHash("sha256").update(normalizeSessionLeasePath(sessionPath, platform)).digest("hex");
}

export function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but is owned by another account. Unknown
    // failures are also treated as alive so stale recovery always fails closed.
    return true;
  }
}

function isOwner(value: any): value is SessionLeaseOwner {
  return value?.schemaVersion === SESSION_LEASE_SCHEMA_VERSION
    && typeof value.leaseId === "string" && value.leaseId.length > 0
    && typeof value.sessionPath === "string" && value.sessionPath.length > 0
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.processStartedAt === "string"
    && typeof value.clientInterface === "string"
    && typeof value.createdAt === "string"
    && typeof value.lastHeartbeatAt === "string";
}

export class SessionLeaseManager {
  private readonly root: string;
  private readonly clientInterface: string;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly pid: number;
  private readonly processStartedAt: string;
  private readonly now: () => Date;
  private readonly processAlive: (pid: number) => boolean;
  private readonly onLost?: (message: string) => void;
  private active: { lockDir: string; ownerPath: string; owner: SessionLeaseOwner } | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lossReported = false;

  constructor(options: SessionLeaseOptions) {
    this.root = join(resolve(options.agentDir), "session-leases", `v${SESSION_LEASE_SCHEMA_VERSION}`);
    this.clientInterface = String(options.clientInterface || "unknown").slice(0, 64);
    this.heartbeatMs = boundedPositive(options.heartbeatMs, DEFAULT_SESSION_LEASE_HEARTBEAT_MS);
    this.staleMs = Math.max(
      this.heartbeatMs * 2,
      boundedPositive(options.staleMs, DEFAULT_SESSION_LEASE_STALE_MS),
    );
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.processStartedAt = (options.processStartedAt
      ?? new Date(Date.now() - Math.max(0, process.uptime()) * 1000)).toISOString();
    this.onLost = options.onLost;
  }

  private paths(sessionPath: string): { canonical: string; lockDir: string; ownerPath: string } {
    const canonical = normalizeSessionLeasePath(sessionPath);
    const lockDir = join(this.root, sessionLeaseKey(canonical));
    return { canonical, lockDir, ownerPath: join(lockDir, "owner.json") };
  }

  private readOwner(ownerPath: string): SessionLeaseOwner | undefined {
    try {
      const parsed = JSON.parse(readFileSync(ownerPath, "utf8"));
      return isOwner(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private writeOwner(ownerPath: string, owner: SessionLeaseOwner): void {
    const temporaryPath = join(dirname(ownerPath), `.owner.${this.pid}.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, ownerPath);
  }

  private inspectPaths(canonical: string, lockDir: string, ownerPath: string): SessionLeaseResult & { recoverable?: boolean } {
    try {
      const stat = lstatSync(lockDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, state: "invalid", message: `Session lease path is not a directory: ${lockDir}` };
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") return { ok: true, state: "available" };
      return { ok: false, state: "invalid", message: `Could not inspect session lease: ${error?.message || error}` };
    }

    const owner = this.readOwner(ownerPath);
    if (!owner || owner.sessionPath !== canonical) {
      return {
        ok: false,
        state: "invalid",
        message: `Session lease metadata is missing or invalid: ${ownerPath}`,
      };
    }
    const heartbeatAt = Date.parse(owner.lastHeartbeatAt);
    const stale = Number.isFinite(heartbeatAt) && this.now().getTime() - heartbeatAt > this.staleMs;
    const alive = this.processAlive(owner.pid);
    if (stale && !alive) {
      return {
        ok: false,
        state: "held",
        message: `Recoverable stale session lease from ${owner.clientInterface} (PID ${owner.pid}).`,
        owner,
        recoverable: true,
      };
    }
    return {
      ok: false,
      state: "held",
      message: `Session is already open for writing in ${owner.clientInterface} (PID ${owner.pid}).`,
      owner,
    };
  }

  inspect(sessionPath: string | undefined): SessionLeaseResult {
    if (!sessionPath) return { ok: true, state: "available" };
    const paths = this.paths(sessionPath);
    if (this.active?.owner.sessionPath === paths.canonical) {
      return { ok: true, state: "already-owned", lease: this.active.owner };
    }
    return this.inspectPaths(paths.canonical, paths.lockDir, paths.ownerPath);
  }

  acquire(sessionPath: string | undefined): SessionLeaseResult {
    if (!sessionPath) return { ok: true, state: "available" };
    const paths = this.paths(sessionPath);
    if (this.active?.owner.sessionPath === paths.canonical) {
      return { ok: true, state: "already-owned", lease: this.active.owner };
    }
    if (this.active) this.release();
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
    } catch (error: any) {
      return { ok: false, state: "invalid", message: `Could not create session lease store: ${error?.message || error}` };
    }
    let recovered: SessionLeaseOwner | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(paths.lockDir, { mode: 0o700 });
        const timestamp = this.now().toISOString();
        const owner: SessionLeaseOwner = {
          schemaVersion: SESSION_LEASE_SCHEMA_VERSION,
          leaseId: randomUUID(),
          sessionPath: paths.canonical,
          pid: this.pid,
          processStartedAt: this.processStartedAt,
          clientInterface: this.clientInterface,
          createdAt: timestamp,
          lastHeartbeatAt: timestamp,
        };
        try {
          this.writeOwner(paths.ownerPath, owner);
        } catch (error) {
          rmSync(paths.lockDir, { recursive: true, force: true });
          throw error;
        }
        this.active = { lockDir: paths.lockDir, ownerPath: paths.ownerPath, owner };
        this.lossReported = false;
        this.startHeartbeat();
        return { ok: true, state: "acquired", lease: owner, recovered };
      } catch (error: any) {
        if (error?.code !== "EEXIST") {
          return { ok: false, state: "invalid", message: `Could not acquire session lease: ${error?.message || error}` };
        }
      }

      const status = this.inspectPaths(paths.canonical, paths.lockDir, paths.ownerPath);
      if (status.ok || !status.recoverable || !status.owner) return status;
      const stalePath = `${paths.lockDir}.stale.${this.pid}.${randomUUID()}`;
      try {
        renameSync(paths.lockDir, stalePath);
        recovered = status.owner;
        rmSync(stalePath, { recursive: true, force: true });
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          return { ok: false, state: "invalid", message: `Could not recover stale session lease: ${error?.message || error}` };
        }
      }
    }
    return { ok: false, state: "held", message: "Session lease changed repeatedly while acquiring it; try again." };
  }

  heartbeat(): boolean {
    if (!this.active) return false;
    const current = this.readOwner(this.active.ownerPath);
    if (!current || current.leaseId !== this.active.owner.leaseId) {
      this.stopHeartbeat();
      this.active = null;
      if (!this.lossReported) {
        this.lossReported = true;
        this.onLost?.("The writable session lease was lost to another process.");
      }
      return false;
    }
    this.active.owner.lastHeartbeatAt = this.now().toISOString();
    try {
      this.writeOwner(this.active.ownerPath, this.active.owner);
      return true;
    } catch (error: any) {
      this.stopHeartbeat();
      if (!this.lossReported) {
        this.lossReported = true;
        this.onLost?.(`The writable session lease could not be renewed: ${error?.message || error}`);
      }
      return false;
    }
  }

  release(): boolean {
    this.stopHeartbeat();
    if (!this.active) return false;
    const active = this.active;
    this.active = null;
    const current = this.readOwner(active.ownerPath);
    if (!current || current.leaseId !== active.owner.leaseId) return false;
    try {
      rmSync(active.lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

export function formatSessionLeaseConflict(result: SessionLeaseConflict): string {
  const suffix = result.owner
    ? ` Close or safely hand off that ${result.owner.clientInterface} session before continuing.`
    : " Inspect Coop Doctor before continuing.";
  return `${result.message}${suffix}`;
}
