import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console });
context.globalThis = context;
vm.runInContext(readFileSync(join(ROOT, "web", "public", "mission-control-model.js"), "utf8"), context);
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };

const healthy = {
  activeSid: "chat-1",
  fallbackCwd: "/workspace",
  chats: [{ sid: "chat-1", cwd: "/workspace", busy: false, status: "running", workspaceAccess: { mode: "write" } }],
  access: { access: { mode: "write", workspacePath: "/workspace" }, repository: { git: true, workspacePath: "/workspace", isWorktree: false } },
  git: { ok: true, git: true, repo: true, files: [], truncated: false },
  capabilities: { platform: { os: "windows" }, versions: { coop: "0.23.1" }, capabilities: [{ runtime: { state: "available" } }, { runtime: { state: "available" } }] },
  health: { state: "healthy", checkedAt: "2026-09-04T00:00:00.000Z", sections: [{ id: "doctor" }] },
  knowledge: { complete: true, sources: [{ id: "team" }], current: [{ id: "one" }], history: [] },
};

test("healthy contracts produce a ready workspace summary without claiming reviews ran", () => {
  const model = context.CoopMissionControl.build(structuredClone(healthy));
  assert.equal(model.state, "ready");
  assert.equal(model.ready, true);
  assert.equal(model.workspace.accessMode, "write");
  assert.equal(model.changes.count, 0);
  assert.equal(model.capabilities.available, 2);
  assert.equal(model.engineering.reviews.state, "not-run");
  assert.equal(model.engineering.lineage.state, "not-run");
});

test("partial evidence and unavailable contracts cannot appear ready", () => {
  const input = structuredClone(healthy);
  input.knowledge.complete = false;
  input.git = null;
  input.failures = [{ id: "doctor", message: "Doctor timed out." }];
  const model = context.CoopMissionControl.build(input);
  assert.equal(model.ready, false);
  assert.equal(model.knowledge.state, "partial");
  assert.equal(model.changes.state, "unavailable");
  assert.deepEqual(Array.from(model.failures, (item) => item.id), ["doctor"]);
});

test("session, checkout, and changed-file states remain explicit", () => {
  const input = structuredClone(healthy);
  input.chats.push({ sid: "chat-2", cwd: "/workspace", busy: true, status: "exited", workspaceAccess: { mode: "read-only" } });
  input.access.access.mode = "read-only";
  input.git.files = [{ path: "model.tmdl" }, { path: "query.sql" }];
  input.git.truncated = true;
  const model = context.CoopMissionControl.build(input);
  assert.equal(model.workspace.state, "read-only");
  assert.equal(model.sessions.total, 2);
  assert.equal(model.sessions.busy, 1);
  assert.equal(model.sessions.crashed, 1);
  assert.equal(model.sessions.readOnly, 1);
  assert.equal(model.changes.count, 2);
  assert.equal(model.changes.truncated, true);
  assert.equal(model.ready, false);
});

test("the active working folder is not replaced by its enclosing Git root", () => {
  const input = structuredClone(healthy);
  input.fallbackCwd = "/workspace/models/client";
  input.access.access.workspacePath = "/workspace";
  input.access.repository.workspacePath = "/workspace";
  const model = context.CoopMissionControl.build(input);
  assert.equal(model.workspace.cwd, "/workspace/models/client");
});

console.log(`mission control model: ${count} tests passed`);
