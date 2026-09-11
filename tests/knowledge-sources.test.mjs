import { strict as assert } from "node:assert";
import { normalizeSources, getSourceHealth, SCHEMA_VERSION } from "../lib/knowledge-sources.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("exports schema version 2", () => assert.equal(SCHEMA_VERSION, 2));
t("normalizes legacy repositories with safe defaults", () => {
  const { sources } = normalizeSources({ knowledge: { enabled: true, repos: [{ repository: "org/Team-KB.git", local_path: "/kb" }] } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "team-kb");
  assert.equal(sources[0].scope, "team");
  assert.equal(sources[0].sensitivity, "internal");
  assert.equal(sources[0].agent_read, true);
  assert.equal(sources[0].activate_skills, false);
  assert.equal(sources[0].publication, "disabled");
  assert.deepEqual(sources[0].capabilities, ["browse", "agent-read"]);
});
t("accepts a knowledge block directly", () => assert.equal(normalizeSources({ repos: [{ url: "https://x/y.git" }] }).sources[0].repository, "https://x/y.git"));
t("explicit v2 source wins and is not duplicated", () => {
  const result = normalizeSources({ knowledge: { repos: [{ repository: "org/kb", local_path: "/old" }], sources: [{ id: "patterns.kb", kind: "patterns", repository: "https://org/kb.git", local_path: "/new", scope: "project" }] } });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "patterns.kb");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("preserves unknown source fields", () => assert.equal(normalizeSources({ sources: [{ repository: "a/b", future_flag: { x: 1 } }] }).sources[0].future_flag.x, 1));
t("does not broaden project scope", () => {
  const result = normalizeSources({ sources: [{ repository: "a/b", scope: "project" }], repos: [{ repository: "a/b" }] });
  assert.equal(result.sources[0].scope, "project");
  assert.ok(!result.sources.some((source) => source.scope === "team"));
});
t("allows explicit project downgrade", () => assert.equal(normalizeSources({ repos: [{ repository: "a/b" }], sources: [{ repository: "a/b", scope: "project" }] }).sources[0].scope, "project"));
t("reports malformed definitions", () => assert.ok(normalizeSources({ sources: [{}] }).errors.length > 0));
t("classifies ready only after search", () => { const h = getSourceHealth({}, { searched: true }); assert.equal(h.status, "ready"); assert.equal(h.searched, true); });
t("distinguishes cached offline from zero matches", () => { const h = getSourceHealth({}, { offline: true, searched: false, cached: true, result_count: 0 }); assert.equal(h.status, "cached-offline"); assert.equal(h.searched, false); });
t("classifies every operational failure state", () => {
  assert.equal(getSourceHealth({}, { disabled: true }).status, "disabled");
  assert.equal(getSourceHealth({}, {}).status, "unconfigured");
  assert.equal(getSourceHealth({}, { authentication_required: true }).status, "authentication-required");
  assert.equal(getSourceHealth({}, { accessible: false }).status, "inaccessible");
  assert.equal(getSourceHealth({}, { dirty: true }).status, "dirty");
  assert.equal(getSourceHealth({}, { diverged: true }).status, "diverged");
  assert.equal(getSourceHealth({}, { failed: true }).status, "failed");
});

console.log(`✓ ${n} knowledge source tests passed`);
