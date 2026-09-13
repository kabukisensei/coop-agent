import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
if (!dist) throw new Error("COOP_TEST_DIST is required");
const {
  normalizeSessionLeasePath,
  sessionLeaseKey,
  SessionLeaseManager,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const extensionModule = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
}

function fixture() {
  const root = mkdtempSync(join(os.tmpdir(), "coop-session-lease-"));
  const agentDir = join(root, "agent");
  const sessions = join(root, "sessions");
  const session = join(sessions, "session.jsonl");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(session, "", "utf8");
  return { root, agentDir, session };
}

await test("canonical keys are stable and Windows paths are case-insensitive", async () => {
  assert.equal(sessionLeaseKey("/tmp/a/../b"), sessionLeaseKey("/tmp/b"));
  assert.equal(
    normalizeSessionLeasePath("C:\\Users\\Coop\\Session.jsonl", "win32"),
    normalizeSessionLeasePath("c:\\users\\coop\\session.jsonl", "win32"),
  );
});

await test("only one live writer can acquire a persisted session", async () => {
  const f = fixture();
  try {
    const first = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "terminal",
      pid: 101,
      processAlive: () => true,
      heartbeatMs: 60_000,
    });
    const second = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "desktop",
      pid: 202,
      processAlive: () => true,
      heartbeatMs: 60_000,
    });
    const acquired = first.acquire(f.session);
    assert.equal(acquired.ok, true);
    const blocked = second.acquire(f.session);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.state, "held");
    assert.equal(blocked.owner.clientInterface, "terminal");
    assert.match(blocked.message, /already open for writing/);
    assert.equal(first.release(), true);
    assert.equal(second.acquire(f.session).ok, true);
    assert.equal(second.release(), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("a fresh lease is not stolen merely because liveness is unknown", async () => {
  const f = fixture();
  try {
    const firstNow = new Date("2026-09-04T12:00:00.000Z");
    const first = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "web",
      pid: 303,
      now: () => firstNow,
      processAlive: () => false,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    assert.equal(first.acquire(f.session).ok, true);
    const second = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "desktop",
      pid: 404,
      now: () => new Date("2026-09-04T12:00:10.000Z"),
      processAlive: () => false,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    assert.equal(second.acquire(f.session).ok, false);
    assert.equal(first.release(), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("a stale lease is recovered only after its owner is proven gone", async () => {
  const f = fixture();
  try {
    const first = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "runtime",
      pid: 505,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      processAlive: () => false,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    assert.equal(first.acquire(f.session).ok, true);
    const second = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "terminal",
      pid: 606,
      now: () => new Date("2026-09-04T12:01:00.000Z"),
      processAlive: (pid) => pid !== 505,
      heartbeatMs: 5_000,
      staleMs: 20_000,
    });
    const recovered = second.acquire(f.session);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered.pid, 505);
    assert.equal(first.release(), false, "prior owner must not delete the replacement lease");
    assert.equal(second.release(), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("invalid lock metadata fails closed", async () => {
  const f = fixture();
  try {
    const key = sessionLeaseKey(f.session);
    const lockDir = join(f.agentDir, "session-leases", "v1", key);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), "not-json", "utf8");
    const manager = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "desktop",
      processAlive: () => false,
    });
    const result = manager.acquire(f.session);
    assert.equal(result.ok, false);
    assert.equal(result.state, "invalid");
    assert.match(result.message, /metadata is missing or invalid/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("heartbeat ownership loss is detected and reported once", async () => {
  const f = fixture();
  try {
    let lost = 0;
    const first = new SessionLeaseManager({
      agentDir: f.agentDir,
      clientInterface: "web",
      pid: 707,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      processAlive: () => false,
      heartbeatMs: 60_000,
      staleMs: 120_000,
      onLost: () => { lost++; },
    });
    const acquired = first.acquire(f.session);
    assert.equal(acquired.ok, true);
    const ownerPath = join(f.agentDir, "session-leases", "v1", sessionLeaseKey(f.session), "owner.json");
    const replaced = JSON.parse(readFileSync(ownerPath, "utf8"));
    replaced.leaseId = "replacement";
    writeFileSync(ownerPath, `${JSON.stringify(replaced)}\n`, "utf8");
    assert.equal(first.heartbeat(), false);
    assert.equal(first.heartbeat(), false);
    assert.equal(lost, 1);
    assert.equal(first.release(), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

await test("Pi lifecycle hooks acquire, preflight, release, and fail closed", async () => {
  const f = fixture();
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorInterface = process.env.COOP_CLIENT_INTERFACE;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  process.env.COOP_CLIENT_INTERFACE = "terminal";
  const makePi = () => {
    const handlers = new Map();
    return {
      handlers,
      api: {
        on: (event, handler) => {
          const list = handlers.get(event) || [];
          list.push(handler);
          handlers.set(event, list);
        },
        registerTool: () => {},
        registerCommand: () => {},
        sendUserMessage: () => {},
      },
    };
  };
  const makeCtx = () => {
    const notifications = [];
    const statuses = [];
    let shutdowns = 0;
    return {
      notifications,
      statuses,
      get shutdowns() { return shutdowns; },
      ctx: {
        cwd: f.root,
        mode: "tui",
        sessionManager: { getSessionFile: () => f.session },
        ui: {
          notify: (...args) => notifications.push(args),
          setStatus: (...args) => statuses.push(args),
        },
        shutdown: () => { shutdowns++; },
      },
    };
  };
  const emit = async (registered, event, payload, ctx) => {
    const results = [];
    for (const handler of registered.handlers.get(event) || []) results.push(await handler(payload, ctx));
    return results;
  };
  try {
    const first = makePi();
    extensionModule.default(first.api);
    const firstCtx = makeCtx();
    await emit(first, "session_start", { type: "session_start", reason: "startup" }, firstCtx.ctx);
    assert.equal(firstCtx.shutdowns, 0);

    process.env.COOP_CLIENT_INTERFACE = "desktop";
    const second = makePi();
    extensionModule.default(second.api);
    const secondCtx = makeCtx();
    const switchResults = await emit(second, "session_before_switch", {
      type: "session_before_switch",
      reason: "resume",
      targetSessionFile: f.session,
    }, secondCtx.ctx);
    assert.deepEqual(switchResults, [{ cancel: true }]);
    assert.match(secondCtx.notifications[0][0], /already open for writing in terminal/);

    await emit(second, "session_start", { type: "session_start", reason: "resume" }, secondCtx.ctx);
    assert.equal(secondCtx.shutdowns, 1, "a startup race must shut down the losing process");
    assert.match(secondCtx.statuses.at(-1)[1], /already open for writing in terminal/);

    await emit(first, "session_shutdown", { type: "session_shutdown", reason: "quit" }, firstCtx.ctx);
    const retryCtx = makeCtx();
    await emit(second, "session_start", { type: "session_start", reason: "resume" }, retryCtx.ctx);
    assert.equal(retryCtx.shutdowns, 0);
    await emit(second, "session_shutdown", { type: "session_shutdown", reason: "quit" }, retryCtx.ctx);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorInterface === undefined) delete process.env.COOP_CLIENT_INTERFACE;
    else process.env.COOP_CLIENT_INTERFACE = priorInterface;
    rmSync(f.root, { recursive: true, force: true });
  }
});

console.log(`session leases: ${count} tests passed`);
