import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  MANAGED_WORKTREE_SCHEMA_VERSION,
  WORKSPACE_LEASE_SCHEMA_VERSION,
  WorkspaceLeaseManager,
  createManagedWorktree,
  inspectWorkspace,
  normalizeWorkspacePath,
  removeManagedWorktree,
  workspaceLeaseKey,
} from "../lib/workspace-isolation.mjs";
import { CoopRuntimeClient } from "../web/runtime-client.mjs";

let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
}

function makeRoot() {
  const root = mkdtempSync(join(os.tmpdir(), "coop-workspace-isolation-"));
  const agentDir = join(root, "agent");
  const repo = join(root, "Client Project");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "coop-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Coop Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return { root, agentDir, repo };
}

await test("canonical checkout keys are stable and Windows paths are case-insensitive", () => {
  assert.equal(workspaceLeaseKey("/tmp/a/../b"), workspaceLeaseKey("/tmp/b"));
  assert.equal(
    workspaceLeaseKey("C:\\Users\\Coop\\Client", "win32"),
    workspaceLeaseKey("c:\\users\\coop\\client", "win32"),
  );
});

// Windows identity: an 8.3 short-name spelling and the long spelling of the SAME
// directory must produce the same normalized path and lease key (short TEMP paths
// appear when %TEMP% or the profile has an alias). Skips visibly when the host
// does not mint short names for new directories.
if (process.platform === "win32") {
  await test("Windows 8.3 short and long spellings identify the same directory", () => {
    const base = mkdtempSync(join(os.tmpdir(), "coop-shortpath-"));
    try {
      const longDir = join(base, "Long Directory Name With Spaces 12345");
      const otherDir = join(base, "Other Directory Name With Spaces 67890");
      mkdirSync(longDir, { recursive: true });
      mkdirSync(otherDir, { recursive: true });
      const shortDir = execFileSync("powershell.exe", ["-NoProfile", "-Command",
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longDir.replace(/'/g, "''")}').ShortPath`], { encoding: "utf8" }).trim();
      if (shortDir === longDir || !shortDir.includes("~")) {
        console.log("  ~ SKIP 8.3 alias body (no short name minted on this host)");
        return;
      }
      assert.equal(normalizeWorkspacePath(shortDir), normalizeWorkspacePath(longDir));
      assert.equal(workspaceLeaseKey(shortDir), workspaceLeaseKey(longDir));
      assert.notEqual(workspaceLeaseKey(shortDir), workspaceLeaseKey(otherDir));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

await test("a second writer receives only worktree, read-only, or explicit-override choices", async () => {
  const f = makeRoot();
  let first, second;
  try {
    const subdir = join(f.repo, "sql", "gold");
    mkdirSync(subdir, { recursive: true });
    const repository = await inspectWorkspace(subdir);
    first = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c1", pid: 101, processAlive: () => true, heartbeatMs: 60_000 });
    second = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c2", pid: 202, processAlive: () => true, heartbeatMs: 60_000 });
    assert.equal(first.acquire(f.repo, { mode: "write", repository }).ok, true);
    const conflict = second.acquire(subdir, { mode: "write", repository });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "workspace-write-conflict");
    assert.deepEqual(conflict.choices.map((choice) => choice.mode), ["worktree", "read-only", "override"]);
    assert.equal(first.release(), true);
  } finally {
    first?.stopHeartbeat();
    second?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("read-only attachment takes no writer lease and override requires explicit approval", () => {
  const f = makeRoot();
  let first, second;
  try {
    first = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c1", pid: 101, processAlive: () => true, heartbeatMs: 60_000 });
    second = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c2", pid: 202, processAlive: () => true, heartbeatMs: 60_000 });
    assert.equal(first.acquire(f.repo, { mode: "write" }).ok, true);
    const readOnly = second.acquire(f.repo, { mode: "read-only" });
    assert.equal(readOnly.ok, true);
    assert.equal(readOnly.access.mode, "read-only");
    assert.equal(readOnly.access.leaseId, null);
    assert.throws(() => second.acquire(f.repo, { mode: "override" }), /explicit approval/i);
    const overridden = second.acquire(f.repo, { mode: "override", approved: true });
    assert.equal(overridden.ok, true);
    assert.equal(overridden.access.mode, "override");
    assert.equal(overridden.access.overridesLeaseId, first.inspect(f.repo).owner.leaseId);
    assert.equal(second.release(), true);
    assert.equal(first.release(), true);
  } finally {
    first?.stopHeartbeat();
    second?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("stale writer recovery requires both an expired heartbeat and a proven-dead process", () => {
  const f = makeRoot();
  let first, second;
  try {
    first = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c1",
      pid: 303,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      processAlive: () => false,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    assert.equal(first.acquire(f.repo, { mode: "write" }).ok, true);
    second = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c2",
      pid: 404,
      now: () => new Date("2026-09-04T12:01:00.000Z"),
      processAlive: (pid) => pid !== 303,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    const recovered = second.acquire(f.repo, { mode: "write" });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered.ownerId, "c1");
    assert.equal(first.release(), false);
    assert.equal(second.release(), true);
  } finally {
    first?.stopHeartbeat();
    second?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("managed worktrees are created under Coop state and removed only by opaque ID", async () => {
  const f = makeRoot();
  try {
    const created = await createManagedWorktree({ cwd: f.repo, agentDir: f.agentDir, ownerId: "c2", approved: true, createId: () => "fixed-id" });
    assert.equal(created.ok, true);
    assert.equal(created.record.schemaVersion, MANAGED_WORKTREE_SCHEMA_VERSION);
    assert.equal(created.record.id, "wt-fixed-id");
    assert.equal(created.record.checkoutPath.startsWith(normalizeWorkspacePath(f.agentDir)), true);
    assert.equal(existsSync(join(created.record.checkoutPath, "README.md")), true);
    const metadata = JSON.parse(readFileSync(created.record.metadataPath, "utf8"));
    assert.equal(metadata.repositoryRoot, normalizeWorkspacePath(f.repo));
    assert.equal((await inspectWorkspace(created.record.checkoutPath)).isWorktree, true);

    await assert.rejects(() => removeManagedWorktree({ agentDir: f.agentDir, id: "../../Client Project", approved: true }), /managed worktree ID/i);
    const removed = await removeManagedWorktree({ agentDir: f.agentDir, id: created.record.id, approved: true });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(created.record.checkoutPath), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("dirty managed worktree cleanup fails closed and preserves the checkout", async () => {
  const f = makeRoot();
  try {
    const created = await createManagedWorktree({ cwd: f.repo, agentDir: f.agentDir, ownerId: "c2", approved: true, createId: () => "dirty-id" });
    writeFileSync(join(created.record.checkoutPath, "uncommitted.txt"), "keep me\n", "utf8");
    const refused = await removeManagedWorktree({ agentDir: f.agentDir, id: created.record.id, approved: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "worktree-not-clean");
    assert.equal(existsSync(join(created.record.checkoutPath, "uncommitted.txt")), true);
    rmSync(join(created.record.checkoutPath, "uncommitted.txt"));
    assert.equal((await removeManagedWorktree({ agentDir: f.agentDir, id: created.record.id, approved: true })).ok, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("contract versions and metadata stay explicit", () => {
  assert.equal(WORKSPACE_LEASE_SCHEMA_VERSION, 1);
  assert.equal(MANAGED_WORKTREE_SCHEMA_VERSION, 1);
  const schema = JSON.parse(readFileSync(new URL("../config/workspace-access.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, "https://coop.local/schemas/workspace-access.v1.json");
  assert.deepEqual(schema.properties.mode.enum, ["write", "read-only", "override"]);
});

await test("runtime client exposes named access methods without a command escape hatch", async () => {
  const requests = [];
  const client = new CoopRuntimeClient({
    baseUrl: "http://127.0.0.1:7420",
    sid: "c1",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await client.getWorkspaceAccess();
  await client.createChat({ cwd: "/workspace", workspaceAccess: "read-only" });
  await client.removeManagedWorktree("wt-safe");
  assert.match(requests[0].url, /\/workspace\/access\?sid=c1$/);
  assert.deepEqual(requests[1].body, { cwd: "/workspace", workspaceAccess: "read-only", approved: false, sid: "c1" });
  assert.deepEqual(requests[2].body, { id: "wt-safe", approved: true, sid: "c1" });
});

await test("primary departure with one override", () => {
  const f = makeRoot();
  let primary, override, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    override = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(override.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // Primary departs (releases)
    assert.equal(primary.release(), true);

    // Override is promoted to base owner; checkout remains held and not recoverable
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(insp.owner.ownerId, "b");
    assert.equal(insp.recoverable, false);

    // Override heartbeats and releases
    assert.equal(override.heartbeat(), true);
    assert.equal(override.release(), true);

    // After override release, workspace is available
    const inspAfter = observer.inspect(f.repo);
    assert.equal(inspAfter.ok, true);
    assert.equal(inspAfter.state, "available");
  } finally {
    primary?.stopHeartbeat();
    override?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("primary departure with multiple overrides", () => {
  const f = makeRoot();
  let primary, overrideB, overrideC, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 103]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideC = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c",
      pid: 103,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    assert.equal(overrideC.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // Primary departs
    assert.equal(primary.release(), true);

    // One of the overrides is promoted; checkout is held and not recoverable
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(["b", "c"].includes(insp.owner.ownerId), true);
    assert.equal(insp.recoverable, false);

    // Both surviving overrides can still heartbeat
    assert.equal(overrideB.heartbeat(), true);
    assert.equal(overrideC.heartbeat(), true);

    assert.equal(overrideB.release(), true);
    assert.equal(overrideC.release(), true);
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    overrideC?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("promoted override departure while another survives", () => {
  const f = makeRoot();
  let primary, overrideB, overrideC, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 103]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideC = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c",
      pid: 103,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    assert.equal(overrideC.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // Primary departs
    assert.equal(primary.release(), true);

    // Determine who was promoted first
    const firstPromoted = observer.inspect(f.repo).owner.ownerId;
    const [promoted, surviving] = firstPromoted === "b" ? [overrideB, overrideC] : [overrideC, overrideB];
    const survivingId = firstPromoted === "b" ? "c" : "b";

    // Promoted override departs
    assert.equal(promoted.release(), true);

    // Surviving override is promoted to base owner; checkout remains held and not recoverable
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(insp.owner.ownerId, survivingId);
    assert.equal(insp.recoverable, false);

    // Surviving override continues to heartbeat and can release
    assert.equal(surviving.heartbeat(), true);
    assert.equal(surviving.release(), true);

    const inspAfter = observer.inspect(f.repo);
    assert.equal(inspAfter.ok, true);
    assert.equal(inspAfter.state, "available");
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    overrideC?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("promoted owner death while another survives and heartbeats", () => {
  const f = makeRoot();
  let primary, overrideB, overrideC, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 103]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideC = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c",
      pid: 103,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    assert.equal(overrideC.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // Primary departs
    assert.equal(primary.release(), true);

    // Identify promoted owner
    const promotedOwnerId = observer.inspect(f.repo).owner.ownerId;
    const promotedPid = promotedOwnerId === "b" ? 102 : 103;
    const surviving = promotedOwnerId === "b" ? overrideC : overrideB;
    const survivingId = promotedOwnerId === "b" ? "c" : "b";

    // Promoted owner crashes/dies without releasing: mark process dead and advance time beyond staleMs
    alive.delete(promotedPid);
    currentTime += 30_000;

    // Surviving override heartbeats at current time
    assert.equal(surviving.heartbeat(), true);

    // Observer inspects: checkout must NOT be recoverable because a live override exists!
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(insp.owner.ownerId, survivingId);
    assert.equal(insp.recoverable, false);

    assert.equal(surviving.heartbeat(), true);
    assert.equal(surviving.release(), true);
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    overrideC?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("ordinary acquisition remains blocked while a writer survives", () => {
  const f = makeRoot();
  let primary, overrideB, overrideC, writerD, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 103, 104]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideC = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c",
      pid: 103,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    writerD = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "d",
      pid: 104,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    // 1. Primary A acquires write access
    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);

    // 2. B and C acquire explicitly approved overrides
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    assert.equal(overrideC.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // 3. A releases, promoting either B or C
    assert.equal(primary.release(), true);
    const promotedOwnerId = observer.inspect(f.repo).owner.ownerId;
    const [promoted, surviving] = promotedOwnerId === "b" ? [overrideB, overrideC] : [overrideC, overrideB];
    const departedPid = promotedOwnerId === "b" ? 102 : 103;

    // 4. The promoted override releases while the other remains active
    assert.equal(promoted.release(), true);

    // 5. Mark the departed process dead and advance time beyond staleMs
    alive.delete(departedPid);
    currentTime += 30_000;

    // 6. Heartbeat the surviving override
    assert.equal(surviving.heartbeat(), true);

    // 7. Attempt ordinary write acquisition from D
    const dResult = writerD.acquire(f.repo, { mode: "write" });
    assert.equal(dResult.ok, false);
    assert.equal(dResult.code, "workspace-write-conflict");

    // Surviving override lease is NOT removed and continues to heartbeat
    assert.equal(surviving.heartbeat(), true);
    assert.equal(surviving.release(), true);
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    overrideC?.stopHeartbeat();
    writerD?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("final release permits normal acquisition", () => {
  const f = makeRoot();
  let primary, overrideB, overrideC, writerD;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 103, 104]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideC = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c",
      pid: 103,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    writerD = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "d",
      pid: 104,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    assert.equal(overrideC.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // All active writers release
    assert.equal(primary.release(), true);
    assert.equal(overrideB.release(), true);
    assert.equal(overrideC.release(), true);

    // Normal acquisition from D succeeds
    const dResult = writerD.acquire(f.repo, { mode: "write" });
    assert.equal(dResult.ok, true);
    assert.equal(dResult.state, "acquired");
    assert.equal(dResult.access.mode, "write");
    assert.equal(writerD.release(), true);
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    overrideC?.stopHeartbeat();
    writerD?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("expired, proven-dead owners can still be recovered", () => {
  const f = makeRoot();
  let primary, overrideB, overrideC, writerD, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 103, 104]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideC = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c",
      pid: 103,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    writerD = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "d",
      pid: 104,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    assert.equal(overrideC.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // Primary departs
    assert.equal(primary.release(), true);

    // All remaining processes die without releasing
    alive.delete(102);
    alive.delete(103);
    currentTime += 30_000;

    // Both base owner and all overrides are expired and dead -> recoverable
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(insp.recoverable, true);

    // Writer D recovers and acquires write access
    const acquired = writerD.acquire(f.repo, { mode: "write" });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.state, "acquired");
    assert.ok(acquired.recovered);
    assert.equal(["b", "c"].includes(acquired.recovered.ownerId), true);
    assert.equal(writerD.release(), true);
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    overrideC?.stopHeartbeat();
    writerD?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("promotion write failure preserves surviving override lease and heartbeat", () => {
  const f = makeRoot();
  let primary, overrideB, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    const bOverridePath = overrideB.active.overridePath;
    assert.equal(existsSync(bOverridePath), true);

    // Override A's writeJsonAtomic to throw EACCES during promotion
    primary.writeJsonAtomic = () => {
      const err = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    };

    // Promotion fails
    const rel = primary.release();
    assert.equal(rel, false);
    assert.equal(existsSync(bOverridePath), true);
    assert.equal(overrideB.heartbeat(), true);
    assert.notEqual(primary.active, null);
    assert.equal(primary.active.mode, "write");
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("release retry succeeds after promotion write failure is cleared", () => {
  const f = makeRoot();
  let primary, overrideB, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    const originalWriteJsonAtomic = primary.writeJsonAtomic;
    primary.writeJsonAtomic = () => {
      const err = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    };

    assert.equal(primary.release(), false);
    assert.equal(overrideB.heartbeat(), true);

    // Remove the injected failure and retry release
    primary.writeJsonAtomic = originalWriteJsonAtomic;
    const retryRel = primary.release();
    assert.equal(retryRel, true);
    assert.equal(primary.active, null);

    // B is now promoted to base owner and remains held
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(insp.owner.ownerId, "b");
    assert.equal(insp.recoverable, false);

    assert.equal(overrideB.heartbeat(), true);
    assert.equal(overrideB.release(), true);

    const inspAfter = observer.inspect(f.repo);
    assert.equal(inspAfter.ok, true);
    assert.equal(inspAfter.state, "available");
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("override enumeration/read failure prevents destructive cleanup and ordinary acquisition", () => {
  const f = makeRoot();
  let primary, overrideB, writerD, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102, 104]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    writerD = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "d",
      pid: 104,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);
    const lockDir = primary.active.lockDir;
    const bOverridePath = overrideB.active.overridePath;

    // Introduce corrupted / unreadable override metadata in overrides/
    const corruptFile = join(lockDir, "overrides", "corrupted.json");
    writeFileSync(corruptFile, "INVALID JSON DATA{{{", "utf8");

    // Primary release fails closed and preserves all surviving leases
    assert.equal(primary.release(), false);
    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(bOverridePath), true);
    assert.notEqual(primary.active, null);

    // Observer inspection marks state invalid, not recoverable
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "invalid");
    assert.equal(insp.code, "workspace-lease-invalid");
    assert.equal(insp.recoverable, undefined);

    // Ordinary acquisition from D fails closed; does NOT perform stale recovery or wipe directory
    const dAcquire = writerD.acquire(f.repo, { mode: "write" });
    assert.equal(dAcquire.ok, false);
    assert.equal(dAcquire.code, "workspace-lease-invalid");
    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(bOverridePath), true);

    // Directory enumeration failure also fails closed
    const originalReadOverrides = observer.readActiveOverrides;
    observer.readActiveOverrides = () => ({ ok: false, code: "unreadable-override-dir", error: new Error("EACCES") });
    const inspDirErr = observer.inspect(f.repo);
    assert.equal(inspDirErr.ok, false);
    assert.equal(inspDirErr.state, "invalid");
    observer.readActiveOverrides = originalReadOverrides;

    // Once corrupt file is removed, normal operations succeed
    rmSync(corruptFile);
    assert.equal(primary.release(), true);
    assert.equal(overrideB.heartbeat(), true);
    assert.equal(overrideB.release(), true);
    assert.equal(observer.inspect(f.repo).state, "available");
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    writerD?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("unreadable primary metadata during override release preserves leases and retries cleanly", () => {
  const f = makeRoot();
  let primary, overrideB, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102]);
    primary = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    assert.equal(primary.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    const originalBReadOwnerRecord = overrideB.readOwnerRecord;
    overrideB.readOwnerRecord = function(ownerPath) {
      if (ownerPath === primary.active?.ownerPath) {
        return { ok: false, exists: true, owner: null, code: "unreadable" };
      }
      return originalBReadOwnerRecord.call(this, ownerPath);
    };

    // Override heartbeat path must not treat unreadable primary metadata as recoverable/absent
    assert.equal(overrideB.heartbeat(), true);
    assert.equal(primary.heartbeat(), true);
    const primaryRecordOnDisk = JSON.parse(readFileSync(primary.active.ownerPath, "utf8"));
    assert.equal(primaryRecordOnDisk.ownerId, "a");

    // Override release must fail closed, avoiding deleting A's lease or lockDir
    assert.equal(overrideB.release(), false);
    assert.notEqual(overrideB.active, null);
    assert.equal(existsSync(primary.active.lockDir), true);
    assert.equal(existsSync(primary.active.ownerPath), true);
    assert.equal(primary.heartbeat(), true);
    assert.equal(overrideB.heartbeat(), true);

    // After clearing the injected failure, release retry succeeds cleanly
    overrideB.readOwnerRecord = originalBReadOwnerRecord;
    assert.equal(overrideB.release(), true);
    assert.equal(overrideB.active, null);

    // Primary owner A remains active and held on the workspace
    assert.equal(primary.heartbeat(), true);
    const insp = observer.inspect(f.repo);
    assert.equal(insp.ok, false);
    assert.equal(insp.state, "held");
    assert.equal(insp.owner.ownerId, "a");

    assert.equal(primary.release(), true);
    assert.equal(observer.inspect(f.repo).state, "available");
  } finally {
    primary?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("acquire aborts transition when releasing existing workspace fails and preserves active lease", () => {
  const f = makeRoot();
  const qRepo = join(f.root, "Workspace Q");
  mkdirSync(qRepo, { recursive: true });
  let primaryA, overrideB, observer;
  try {
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const alive = new Set([101, 102]);
    primaryA = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "a",
      pid: 101,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    overrideB = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "b",
      pid: 102,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    observer = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "obs",
      pid: 999,
      now: () => new Date(currentTime),
      processAlive: (p) => alive.has(p),
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });

    // A owns workspace P with B as an override
    assert.equal(primaryA.acquire(f.repo, { mode: "write" }).ok, true);
    assert.equal(overrideB.acquire(f.repo, { mode: "override", approved: true }).ok, true);

    // Inject promotion write failure on A for P's owner.json
    const originalWriteJsonAtomic = primaryA.writeJsonAtomic;
    primaryA.writeJsonAtomic = (path, value) => {
      if (path === primaryA.active?.ownerPath && value?.ownerId !== "a") {
        const err = new Error("EACCES: permission denied on owner promotion");
        err.code = "EACCES";
        throw err;
      }
      return originalWriteJsonAtomic.call(primaryA, path, value);
    };

    // A attempts to acquire workspace Q; must abort transition
    const qAcquire = primaryA.acquire(qRepo, { mode: "write" });
    assert.equal(qAcquire.ok, false);
    assert.equal(qAcquire.code, "workspace-lease-invalid");

    // P's active state and heartbeat must be preserved; Q remains unacquired
    assert.notEqual(primaryA.active, null);
    assert.equal(primaryA.active.workspacePath, normalizeWorkspacePath(f.repo));
    assert.equal(primaryA.heartbeat(), true);
    assert.equal(overrideB.heartbeat(), true);

    const qInsp = observer.inspect(qRepo);
    assert.equal(qInsp.ok, true);
    assert.equal(qInsp.state, "available");

    // Clear injected failure and retry A.acquire(Q)
    primaryA.writeJsonAtomic = originalWriteJsonAtomic;
    const qRetry = primaryA.acquire(qRepo, { mode: "write" });
    assert.equal(qRetry.ok, true);
    assert.equal(primaryA.active.workspacePath, normalizeWorkspacePath(qRepo));
    assert.equal(primaryA.heartbeat(), true);

    // P was released with B promoted to base owner
    const pInsp = observer.inspect(f.repo);
    assert.equal(pInsp.ok, false);
    assert.equal(pInsp.state, "held");
    assert.equal(pInsp.owner.ownerId, "b");
    assert.equal(overrideB.heartbeat(), true);

    assert.equal(overrideB.release(), true);
    assert.equal(observer.inspect(f.repo).state, "available");
    assert.equal(primaryA.release(), true);
    assert.equal(observer.inspect(qRepo).state, "available");
  } finally {
    primaryA?.stopHeartbeat();
    overrideB?.stopHeartbeat();
    observer?.stopHeartbeat();
    rmSync(f.root, { recursive: true, force: true });
  }
});

console.log(`workspace isolation: ${count} tests passed`);
