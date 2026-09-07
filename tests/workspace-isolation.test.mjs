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

await test("a second writer receives only worktree, read-only, or explicit-override choices", async () => {
  const f = makeRoot();
  try {
    const subdir = join(f.repo, "sql", "gold");
    mkdirSync(subdir, { recursive: true });
    const repository = await inspectWorkspace(subdir);
    const first = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c1", pid: 101, processAlive: () => true, heartbeatMs: 60_000 });
    const second = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c2", pid: 202, processAlive: () => true, heartbeatMs: 60_000 });
    assert.equal(first.acquire(f.repo, { mode: "write", repository }).ok, true);
    const conflict = second.acquire(subdir, { mode: "write", repository });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "workspace-write-conflict");
    assert.deepEqual(conflict.choices.map((choice) => choice.mode), ["worktree", "read-only", "override"]);
    assert.equal(first.release(), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("read-only attachment takes no writer lease and override requires explicit approval", () => {
  const f = makeRoot();
  try {
    const first = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c1", pid: 101, processAlive: () => true, heartbeatMs: 60_000 });
    const second = new WorkspaceLeaseManager({ agentDir: f.agentDir, ownerId: "c2", pid: 202, processAlive: () => true, heartbeatMs: 60_000 });
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
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("stale writer recovery requires both an expired heartbeat and a proven-dead process", () => {
  const f = makeRoot();
  try {
    const first = new WorkspaceLeaseManager({
      agentDir: f.agentDir,
      ownerId: "c1",
      pid: 303,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      processAlive: () => false,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    assert.equal(first.acquire(f.repo, { mode: "write" }).ok, true);
    const second = new WorkspaceLeaseManager({
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

console.log(`workspace isolation: ${count} tests passed`);
