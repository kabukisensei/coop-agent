import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAuthProviders, modelProviderState, normalizeMicrosoftAccount } from "../web/auth-service.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
}

await test("an isolated model profile never falls back to another profile", async () => {
  const calls = [];
  const state = modelProviderState({ env: {},
    agentDir: "/isolated",
    globalAgentDir: "/global",
    stat: (path) => {
      calls.push(path);
      if (path === "/global/auth.json") return { isFile: () => true, size: 42 };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(state, "unauthenticated");
  assert.deepEqual(calls, ["/isolated/auth.json"]);
});

await test("empty, unrelated and malformed credentials do not report successful sign-in", () => {
  const inspect = text => modelProviderState({ env: {}, agentDir: "/isolated", stat: () => ({ isFile: () => true, size: text.length }), read: () => text });
  assert.equal(inspect("{}"), "unauthenticated");
  assert.equal(inspect(""), "unauthenticated");
  assert.equal(inspect(JSON.stringify({ anthropic: { type: "api_key", key: "fixture-only" } })), "unauthenticated");
  assert.equal(inspect(JSON.stringify({ "openai-codex": { type: "oauth" } })), "unauthenticated");
  assert.equal(inspect(JSON.stringify({ openai: { type: "api_key", key: " " } })), "unauthenticated");
  assert.equal(inspect("not JSON fixture-secret"), "error");
  assert.equal(inspect("[]"), "error");
  assert.equal(inspect("null"), "error");
  assert.equal(inspect(JSON.stringify({ openai: { type: "api_key", key: "fixture-only" } })), "authenticated");
  assert.equal(inspect(JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1 } })), "authenticated", "Pi can refresh an expired access token");
});

await test("auth reports expose no stored credential values or parse errors", async () => {
  const options = { env: {}, agentDir: "/isolated", stat: () => ({ isFile: () => true, size: 100 }),
    inspectMicrosoft: async () => ({ state: "unavailable", account: null, diagnostic: null }) };
  const report = await getAuthProviders({ ...options, read: () => JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1 } }) });
  assert.equal(report.providers[0].state, "authenticated");
  assert.doesNotMatch(JSON.stringify(report), /fixture-access|fixture-refresh/);
  const broken = await getAuthProviders({ ...options, read: () => "broken fixture-secret" });
  assert.equal(broken.providers[0].state, "error");
  assert.doesNotMatch(JSON.stringify(broken), /fixture-secret|JSON/);
  let reads = 0;
  assert.equal(modelProviderState({ env: {}, ...options, stat: () => ({ isFile: () => true, size: 2 * 1024 * 1024 }), read: () => { reads++; return "{}"; } }), "error");
  assert.equal(reads, 0);
});

await test("runtime OpenAI environment credentials work without a saved profile and stay private", async () => {
  const env = { OPENAI_API_KEY: "fixture-environment-key" };
  const report = await getAuthProviders({ env, agentDir: "/isolated",
    stat: () => { throw new Error("environment credentials must not read another profile"); },
    inspectMicrosoft: async () => ({ state: "unavailable", account: null, diagnostic: null }) });
  assert.equal(report.providers[0].state, "authenticated");
  assert.deepEqual(report.providers[0].diagnostics, []);
  assert.doesNotMatch(JSON.stringify(report), /fixture-environment-key|OPENAI_API_KEY/);
  for (const invalidEnv of [{}, { OPENAI_API_KEY: " " }, { CODEX_API_KEY: "fixture-only" }, { ANTHROPIC_API_KEY: "fixture-only" }]) {
    assert.equal(modelProviderState({ env: invalidEnv, agentDir: "/isolated",
      stat: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }), "unauthenticated");
  }
});

await test("Microsoft inspection exposes only display identity and tenant fields", async () => {
  const result = normalizeMicrosoftAccount({ code: 0, stdout: JSON.stringify({ id: "subscription-secret", tenantId: "tenant-1", user: { name: "consultant@example.com", type: "user" }, accessToken: "never" }) });
  assert.deepEqual(result.account, { label: "consultant@example.com", tenantId: "tenant-1", accountType: "user" });
  assert.doesNotMatch(JSON.stringify(result), /subscription-secret|accessToken|never/);
});

await test("provider report keeps model, client, and knowledge trust contexts separate", async () => {
  const report = await getAuthProviders({
    env: {},
    agentDir: "/none",
    globalAgentDir: "/none-global",
    stat: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    inspectMicrosoft: async () => ({ state: "authenticated", account: { label: "client-user", tenantId: "client-tenant", accountType: "user" }, diagnostic: null }),
    now: new Date("2026-09-04T12:00:00Z"),
  });
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.providers.map((provider) => provider.trustContext), ["model", "client-microsoft", "cooptimize-knowledge"]);
  assert.equal(report.providers[0].state, "unauthenticated");
  assert.equal(report.providers[1].state, "authenticated");
  assert.equal(report.providers[2].state, "unavailable");
});

await test("checked-in schema pins provider IDs, states, and login methods", async () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "config", "auth-providers.schema.json"), "utf8"));
  const provider = schema.properties.providers.items.properties;
  assert.deepEqual(provider.id.enum, ["model.openai-codex", "microsoft.client", "knowledge.cooptimize"]);
  assert.ok(provider.state.enum.includes("expired"));
  assert.ok(provider.login.properties.method.enum.includes("browser-device-code"));
});

console.log(`auth service: ${count} tests passed`);
