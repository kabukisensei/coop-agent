// lib/fabric-discovery.mjs: Fabric ids looked up by name for /setup-project
// (suite review 2026-10-26, pick 10). Read-only GETs with the az token; every
// failure resolves to "" so the wizard keeps its typed fallback.
import { strict as assert } from "node:assert";
import { azureCliInvocation, fabricDiscovery, isUuid, SQL_ITEM_TYPES } from "../lib/fabric-discovery.mjs";

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const WH = "33333333-3333-4333-8333-333333333333";
const LH = "44444444-4444-4444-8444-444444444444";
const EP = "55555555-5555-4555-8555-555555555555";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

function fake({ token = "tok", azCode = 0, pages = {} } = {}) {
  const calls = { az: [], urls: [] };
  const exec = async (command, args) => { calls.az.push([command, ...args]); return { code: azCode, stdout: JSON.stringify({ accessToken: token }), stderr: "" }; };
  const fetchFn = async (url, init) => {
    calls.urls.push(url);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    const body = pages[url];
    return body ? { ok: true, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  return { exec, fetchFn, calls };
}

const FAB = "https://api.fabric.microsoft.com/v1";
const PAGES = {
  [`${FAB}/workspaces`]: { value: [{ id: WS, displayName: "Contoso Sales Dev", type: "Workspace" }, { id: WS2, displayName: "Contoso Sales", type: "Workspace" }, { id: "not-an-id", displayName: "Broken" }] },
  [`${FAB}/workspaces/${WS}/items`]: { value: [{ id: WH, displayName: "SalesDW", type: "Warehouse" }, { id: LH, displayName: "Bronze", type: "Lakehouse" }, { id: "66666666-6666-4666-8666-666666666666", displayName: "Notes", type: "Notebook" }] },
  [`${FAB}/workspaces/${WS}/lakehouses/${LH}`]: { id: LH, properties: { sqlEndpointProperties: { id: EP.toUpperCase() } } },
};

await t("workspaces and SQL items resolve by name, case-insensitively, with one az mint and cached pages", async () => {
  const f = fake({ pages: PAGES });
  const d = fabricDiscovery({ exec: f.exec, fetchFn: f.fetchFn, tenant: "contoso.onmicrosoft.com", platform: "linux" });
  assert.equal(await d.workspaceId("contoso sales dev"), WS);
  assert.equal(await d.workspaceId("Contoso Sales"), WS2);
  assert.equal(await d.workspaceId("Nowhere"), "");
  assert.equal(await d.resolveWorkspace(WS2.toUpperCase()), WS2, "an id passes through, lower-cased");
  assert.deepEqual((await d.sqlItems(WS)).map((i) => `${i.type}:${i.name}`), ["Warehouse:SalesDW", "Lakehouse:Bronze"], "only SQL item types, the broken and foreign ones dropped");
  assert.equal(await d.resolveItem(WS, "salesdw", "Warehouse"), WH);
  assert.equal(await d.resolveItem(WS, "SalesDW", "Lakehouse"), "", "the type must match");
  assert.equal(await d.resolveItem(WS, "Bronze"), LH);
  assert.equal(await d.lakehouseEndpointId(WS, LH), EP, "the endpoint id is lower-cased");
  assert.equal(await d.lakehouseEndpointId(WS, WH), "", "a warehouse has no lakehouse endpoint");
  assert.equal(f.calls.az.length, 1, "one token mint per discovery");
  assert.deepEqual(f.calls.az[0].slice(0, 2), ["az", "account"]);
  assert.ok(f.calls.az[0].includes("--tenant") && f.calls.az[0].includes("contoso.onmicrosoft.com"));
  assert.equal(f.calls.urls.filter((u) => u === `${FAB}/workspaces`).length, 1, "the workspace list is fetched once");
  assert.deepEqual(SQL_ITEM_TYPES, ["Warehouse", "Lakehouse", "SQLDatabase"]);
  assert.equal(isUuid(WS), true);
  assert.equal(isUuid("x"), false);
});

await t("an ambiguous name, a failed mint, no exec or a failed GET all resolve to nothing", async () => {
  const dup = fake({ pages: { [`${FAB}/workspaces`]: { value: [{ id: WS, displayName: "Same" }, { id: WS2, displayName: "same" }] } } });
  assert.equal(await fabricDiscovery({ exec: dup.exec, fetchFn: dup.fetchFn }).workspaceId("Same"), "", "two workspaces with one name never resolve");
  const failed = fake({ azCode: 1, pages: PAGES });
  const d = fabricDiscovery({ exec: failed.exec, fetchFn: failed.fetchFn });
  assert.equal(await d.workspaceId("Contoso Sales Dev"), "");
  assert.equal(failed.calls.urls.length, 0, "no token, no request");
  assert.equal(await fabricDiscovery({ fetchFn: failed.fetchFn }).workspaceId("Contoso Sales Dev"), "", "no exec: nothing is looked up");
  const noPage = fake({ pages: {} });
  assert.deepEqual(await fabricDiscovery({ exec: noPage.exec, fetchFn: noPage.fetchFn }).sqlItems(WS), []);
  const throwing = fabricDiscovery({ exec: async () => { throw new Error("ENOENT"); }, fetchFn: fake().fetchFn });
  assert.equal(await throwing.workspaceId("Contoso Sales Dev"), "");
  const invalidTenant = fake({ pages: PAGES });
  await fabricDiscovery({ exec: invalidTenant.exec, fetchFn: invalidTenant.fetchFn, tenant: "bad tenant; rm", platform: "linux" }).workspaces();
  assert.ok(!invalidTenant.calls.az[0].includes("--tenant"), "a tenant that is not a GUID or domain is never passed to az");
});

await t("on Windows the az call goes through cmd.exe (az is a .cmd Pi's exec cannot spawn); elsewhere az runs as it is", async () => {
  const args = ["account", "get-access-token", "--resource", "https://api.fabric.microsoft.com", "--output", "json", "--tenant", "contoso.onmicrosoft.com"];
  assert.deepEqual(azureCliInvocation(args, "linux", {}), { command: "az", args });
  assert.deepEqual(azureCliInvocation(args, "win32", { ComSpec: "C:\Windows\System32\cmd.exe" }), {
    command: "C:\Windows\System32\cmd.exe",
    args: ["/d", "/s", "/c", "az account get-access-token --resource https://api.fabric.microsoft.com --output json --tenant contoso.onmicrosoft.com"],
  });
  assert.equal(azureCliInvocation(args, "win32", {}).command, "cmd.exe", "no ComSpec: cmd.exe from PATH");
  const win = fake({ pages: PAGES });
  const d = fabricDiscovery({ exec: win.exec, fetchFn: win.fetchFn, tenant: "contoso.onmicrosoft.com", platform: "win32", env: { ComSpec: "C:\Windows\System32\cmd.exe" } });
  assert.equal(await d.workspaceId("Contoso Sales Dev"), WS, "the lookup works through cmd.exe");
  assert.deepEqual(win.calls.az[0].slice(0, 4), ["C:\Windows\System32\cmd.exe", "/d", "/s", "/c"]);
  assert.ok(win.calls.az[0][4].startsWith("az account get-access-token ") && win.calls.az[0][4].endsWith("--tenant contoso.onmicrosoft.com"));
  const spaced = fake({ pages: PAGES });
  await fabricDiscovery({ exec: spaced.exec, fetchFn: spaced.fetchFn, tenant: "bad tenant; rm", platform: "win32", env: {} }).workspaces();
  assert.ok(!spaced.calls.az[0][4].includes("--tenant"), "an invalid tenant never reaches the cmd.exe line");
});

await t("paged lists follow continuationUri on the Fabric host only", async () => {
  const next = `${FAB}/workspaces?continuationToken=abc`;
  const f = fake({ pages: {
    [`${FAB}/workspaces`]: { value: [{ id: WS, displayName: "One" }], continuationUri: next },
    [next]: { value: [{ id: WS2, displayName: "Two" }], continuationUri: "https://evil.example/v1/workspaces" },
  } });
  const d = fabricDiscovery({ exec: f.exec, fetchFn: f.fetchFn });
  assert.deepEqual((await d.workspaces()).map((w) => w.name), ["One", "Two"]);
  assert.ok(!f.calls.urls.some((u) => u.startsWith("https://evil")));
});

console.log(`fabric-discovery: ${n} tests passed`);
