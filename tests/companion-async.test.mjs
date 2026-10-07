// #342: real hub/server with deferred fake RPCs, no timer races or client data.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { CompanionHub } from "../desktop/lib/companion-hub.mjs";
import { DeviceStore } from "../desktop/lib/companion-devices.mjs";
import { createCompanionServer } from "../desktop/lib/companion-server.mjs";

let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`  ✓ ${name}`); }
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
class Pi extends EventEmitter {
  constructor() { super(); this.sent = []; this.delays = new Map(); this.exited = false; }
  hold(type) { const entered = deferred(), result = deferred(); this.delays.set(type, { entered, result }); return { entered: entered.promise, resolve: result.resolve, reject: result.reject }; }
  request(command) {
    this.sent.push(command);
    const delay = this.delays.get(command.type);
    if (delay) { delay.entered.resolve(); return delay.result.promise; }
    const data = command.type === "get_messages" ? { messages: [{ role: "user", content: "SYNTHETIC_CURRENT_SESSION" }] }
      : command.type === "get_available_models" ? { models: [{ provider: "test", id: "test" }] }
      : command.type === "get_fork_messages" ? { messages: [{ entryId: "prompt1" }] } : {};
    return Promise.resolve({ success: true, data });
  }
}
function fixture(extra = {}) { const pi = new Pi(); const hub = new CompanionHub({ client: "Synthetic", windowsUser: "Synthetic", appAccess: () => true, ...extra }); hub.attach(pi); return { pi, hub }; }
const request = (hub, action) => ({ incarnation: hub.incarnation, submissionId: "00000000-0000-4000-8000-000000000001", action, provider: "test", modelId: "test", entryId: "prompt1" });
const stale = (promise, code = "wrong-session") => assert.rejects(promise, (e) => e.code === code);

for (const change of ["attach", "renew", "revoke-and-restore"]) {
  await check(`snapshot cannot mix sessions after ${change}; next authorized snapshot follows app access`, async () => {
    const { pi, hub } = fixture(); const wait = pi.hold("get_session_stats");
    const pending = hub.snapshot(); const rejected = stale(pending, change === "revoke-and-restore" ? "access-off" : "wrong-session");
    await wait.entered;
    if (change === "attach") hub.attach(new Pi());
    else if (change === "renew") hub.renew();
    else { hub.setAccess(false); hub.setAccess(true); }
    wait.resolve({ success: true, data: {} }); await rejected;
    assert.equal(hub.todos.found, false);
    assert.equal(pi.sent.filter((c) => c.type === "get_messages").length, 0);
    pi.delays.clear();
    const next = await hub.snapshot(); assert.equal(next.incarnation, hub.incarnation); assert.equal(next.messages[0].text, "SYNTHETIC_CURRENT_SESSION");
  });
}
for (const action of ["model", "fork", "export"]) {
  await check(`delayed ${action} prerequisite never mutates replacement worker`, async () => {
    const exportWait = deferred();
    const { pi, hub } = fixture({ host: { exportPath: () => exportWait.promise } });
    const wait = pi.hold(action === "model" ? "get_available_models" : "get_fork_messages");
    const pending = action === "model" ? hub.control("d", request(hub, action)) : hub.sessionAction("d", request(hub, action));
    const rejected = stale(pending);
    if (action !== "export") await wait.entered;
    const next = new Pi(); hub.attach(next);
    wait.resolve({ success: true, data: { models: [{ provider: "test", id: "test" }], messages: [{ entryId: "prompt1" }] } }); exportWait.resolve("/synthetic/export.html");
    await rejected; assert.equal(next.sent.length, 0);
  });
}
await check("same-worker renew invalidates delayed control and background caches", async () => {
  const { pi, hub } = fixture(); const wait = pi.hold("get_available_models");
  const pending = hub.control("d", request(hub, "model")); const rejected = stale(pending); await wait.entered; hub.renew();
  wait.resolve({ success: true, data: { models: [{ provider: "test", id: "test" }] } }); await rejected;
  assert.equal(pi.sent.some((c) => c.type === "set_model"), false);
  const commands = pi.hold("get_commands"); const refresh = hub.refreshCommands(); const refreshRejected = stale(refresh); await commands.entered; hub.renew();
  commands.resolve({ success: true, data: { commands: [{ name: "stale" }] } }); await refreshRejected; assert.deepEqual(hub.commands, []);
});
await check("upload cannot publish an attachment id after same-worker renew", async () => {
  const wait = deferred(); const { hub } = fixture({ host: { attach: () => wait.promise } });
  const pending = hub.upload("d", { ...request(hub), name: "synthetic.txt", data: "eA==" }); const rejected = stale(pending);
  hub.renew(); wait.resolve({ name: "synthetic.txt", kind: "text" }); await rejected; assert.equal(hub.uploads.size, 0);
});

for (const change of ["renew", "access-off-and-on"]) {
  await check(`rejected old upload after ${change} returns only authorization failure`, async () => {
    const wait = deferred(); const { hub } = fixture({ host: { attach: () => wait.promise } });
    const pending = hub.upload("d", { ...request(hub), name: "synthetic.txt", data: "eA==" });
    const rejected = stale(pending, change === "renew" ? "wrong-session" : "access-off");
    if (change === "renew") hub.renew(); else { hub.setAccess(false); hub.setAccess(true); }
    wait.reject(new Error("SYNTHETIC_OLD_SESSION_ERROR")); await rejected;
  });
}
await check("rejected old export RPC cannot report old-session errors after replacement", async () => {
  const { pi, hub } = fixture({ host: { exportPath: async () => "/synthetic/export.html" } });
  const wait = pi.hold("export_html"); const pending = hub.sessionAction("d", request(hub, "export")); const rejected = stale(pending);
  await wait.entered; hub.attach(new Pi()); wait.reject(new Error("SYNTHETIC_OLD_SESSION_ERROR")); await rejected;
});

for (const change of ["renew", "revoke", "access-off", "replace"]) {
  await check(`queued phone session transition validates actual host wiring after ${change}`, async () => {
    const queued = deferred(); let sent = 0, denied = null;
    let hub;
    ({ hub } = fixture({ host: {
      sessionCommand: async (_command, validate) => { await queued.promise; validate(); sent++; return { success: true }; },
      changed: () => {},
    } }));
    const pending = hub.sessionAction("d", request(hub, "new"), () => denied);
    const rejected = stale(pending, change === "revoke" ? "revoked" : change === "access-off" ? "access-off" : "wrong-session");
    if (change === "renew") hub.renew();
    if (change === "revoke") denied = "revoked";
    if (change === "access-off") hub.setAccess(false);
    if (change === "replace") hub.attach(new Pi());
    queued.resolve(); await rejected; assert.equal(sent, 0);
  });
}
await check("owned queued transition adopts only its returned incarnation and retains app access", async () => {
  let hub, changed = 0;
  ({ hub } = fixture({ host: {
    sessionCommand: async (_command, validate) => { validate(); hub.renew({ keepAccess: true }); return { success: true, incarnation: hub.incarnation }; },
    changed: () => { changed++; },
  } }));
  assert.deepEqual(await hub.sessionAction("d", request(hub, "new")), { ok: true });
  assert.equal(changed, 1); assert.equal(hub.accessOn, true);
});
await check("another transition after owned renew prevents stale completion", async () => {
  let hub;
  ({ hub } = fixture({ host: {
    sessionCommand: async (_command, validate) => { validate(); hub.renew({ keepAccess: true }); const incarnation = hub.incarnation; hub.renew(); return { success: true, incarnation }; },
    changed: () => { throw new Error("stale completion published"); },
  } }));
  await stale(hub.sessionAction("d", request(hub, "new")));
});

function http(port, path, cookie, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers: { host: "synthetic.example", cookie, ...(body ? { Origin: "https://synthetic.example", "X-Coop-Companion": "1", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    }); req.on("error", reject); req.end(data);
  });
}
const temp = mkdtempSync(join(tmpdir(), "coop-async-"));
try {
  for (const change of ["device-revoke", "access-off", "replace", "close-tab", "select-tab"]) {
    await check(`HTTP snapshot refuses in-flight ${change}`, async () => {
      const { pi, hub } = fixture(); const second = fixture(); let tabs = [{ id: 1, hub }, { id: 2, hub: second.hub }];
      const store = new DeviceStore(join(temp, `${change}.json`)); const { code } = store.startPairing({ client: hub.client, windowsUser: hub.windowsUser }); const { device, secret } = store.redeem(code, "synthetic");
      const cookie = `coop_device=${device.id}.${secret}`;
      const server = createCompanionServer({ store, tabs: () => tabs, origin: "https://synthetic.example", port: 0 });
      const { port } = await server.listen();
      try {
        const wait = pi.hold("get_session_stats"); const pending = http(port, "/api/snapshot", cookie); await wait.entered;
        if (change === "device-revoke") store.revoke(device.id);
        if (change === "access-off") hub.setAccess(false);
        if (change === "replace") hub.attach(new Pi());
        if (change === "close-tab") tabs = [tabs[1]];
        if (change === "select-tab") assert.equal((await http(port, "/api/tabs", cookie, { tabId: 2, submissionId: "00000000-0000-4000-8000-000000000001" })).json.ok, true);
        wait.resolve({ success: true, data: {} });
        const result = await pending; assert.equal(result.json.ok, false); assert.equal(result.json.snapshot, undefined);
        assert.equal(result.json.code, change === "device-revoke" ? "revoked" : change === "access-off" ? "access-off" : "wrong-session");
        assert.equal(pi.sent.some((c) => c.type === "get_messages"), false);
        if (change === "replace") assert.equal((await http(port, "/api/snapshot", cookie)).json.ok, true, "new same-client request follows replacement");
      } finally { await server.close(); }
    });
  }
  await check("device revoked during model listing prevents follow-on mutation", async () => {
    const { pi, hub } = fixture(); const store = new DeviceStore(join(temp, "control.json")); const { code } = store.startPairing({ client: hub.client, windowsUser: hub.windowsUser }); const { device, secret } = store.redeem(code, "synthetic");
    const server = createCompanionServer({ store, tabs: () => [{ id: 1, hub }], origin: "https://synthetic.example", port: 0 }); const { port } = await server.listen();
    try {
      const wait = pi.hold("get_available_models"); const pending = http(port, "/api/session", `coop_device=${device.id}.${secret}`, (({ entryId, ...body }) => body)(request(hub, "model"))); await Promise.race([wait.entered, pending.then((r) => { throw new Error(`control refused before RPC: ${JSON.stringify(r)}`); })]);
      store.revoke(device.id); wait.resolve({ success: true, data: { models: [{ provider: "test", id: "test" }] } });
      assert.equal((await pending).json.code, "revoked"); assert.equal(pi.sent.some((c) => c.type === "set_model"), false);
    } finally { await server.close(); }
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`✓ companion async authorization: ${checks} checks`);
