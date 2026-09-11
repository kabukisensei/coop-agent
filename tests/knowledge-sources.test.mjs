import { strict as assert } from "node:assert";
import { normalizeSources, getSourceHealth, SCHEMA_VERSION } from "../lib/knowledge-sources.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("exports schema version 2", () => assert.equal(SCHEMA_VERSION, 2));
t("normalizes legacy repositories with safe defaults", () => {
  const { sources } = normalizeSources({ knowledge: { enabled: true, repos: [{ repository: "org/Team-KB.git", local_path: "/kb" }] } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "org-team-kb--3aafde32");
  assert.equal(sources[0].scope, "team");
  assert.equal(sources[0].sensitivity, "internal");
  assert.equal(sources[0].agent_read, true);
  assert.equal(sources[0].activate_skills, false);
  assert.equal(sources[0].publication, "disabled");
  assert.deepEqual(sources[0].capabilities, ["browse", "agent-read"]);
});
t("accepts a knowledge block directly", () => assert.equal(normalizeSources({ repos: [{ url: "https://x/y.git" }] }).sources[0].repository, "https://x/y.git"));
t("canonicalizes GitHub shorthand and URL identities", () => {
  const result = normalizeSources({
    repos: [{ repository: "org/kb" }],
    sources: [
      { repository: "https://github.com/org/kb.git", id: "patterns.kb" },
      { repository: "git@github.com:org/kb.git", id: "patterns.scp" },
    ],
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "patterns.kb");
});
t("explicit v2 source wins and is not duplicated", () => {
  const result = normalizeSources({ knowledge: { repos: [{ repository: "org/kb", local_path: "/old" }], sources: [{ id: "patterns.kb", kind: "patterns", repository: "https://org/kb.git", local_path: "/new", scope: "project" }] } });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "patterns.kb");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("explicit IDs conflict with matching legacy-generated IDs", () => {
  const result = normalizeSources({ sources: [{ id: "one-kb--cfceedae", repository: "other/repo" }], repos: [{ repository: "one/kb" }] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "one-kb--cfceedae");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("preserves unknown source fields", () => assert.equal(normalizeSources({ sources: [{ repository: "a/b", future_flag: { x: 1 } }] }).sources[0].future_flag.x, 1));
t("does not create colliding generated IDs", () => {
  const sources = normalizeSources({ repos: [{ repository: "one/kb" }, { repository: "two/kb" }] }).sources;
  assert.equal(new Set(sources.map((source) => source.id)).size, 2);
});
t("keeps colliding generated v2 slugs as distinct sources", () => {
  const sources = normalizeSources({ sources: [{ repository: "one/a-b" }, { repository: "one/a/b" }] }).sources;
  assert.equal(sources.length, 2);
  assert.equal(new Set(sources.map((source) => source.id)).size, 2);
});
t("generates order-independent IDs from canonical identity", () => {
  const forward = normalizeSources({ repos: [{ repository: "one/kb" }, { repository: "two/kb" }] }).sources.map(({ repository, id }) => [repository, id]);
  const reverse = normalizeSources({ repos: [{ repository: "two/kb" }, { repository: "one/kb" }] }).sources.map(({ repository, id }) => [repository, id]);
  assert.deepEqual(Object.fromEntries(forward), Object.fromEntries(reverse));
  assert.deepEqual(Object.fromEntries(forward), { "one/kb": "one-kb--cfceedae", "two/kb": "two-kb--f6da22b6" });
});
t("keeps a legacy ID stable when another colliding slug is configured", () => {
  const alone = normalizeSources({ repos: [{ repository: "one/kb" }] }).sources[0].id;
  const withOther = normalizeSources({ repos: [{ repository: "one/kb" }, { repository: "one-kb" }] }).sources[0].id;
  assert.equal(withOther, alone);
});
t("keeps a generated ID stable when a colliding slug is added later", () => {
  const alone = normalizeSources({ sources: [{ repository: "one/a-b" }] }).sources[0].id;
  const together = normalizeSources({ sources: [{ repository: "one/a-b" }, { repository: "one/a/b" }] }).sources;
  assert.equal(together.find((source) => source.repository === "one/a-b").id, alone);
  assert.match(alone, /^learnings\.one-a-b--[0-9a-f]{8}$/);
});
t("uses local paths as bindings even when repositories are present", () => {
  const result = normalizeSources({
    sources: [{ id: "project.kb", repository: "one/kb", local_path: "/work/shared", scope: "project" }],
    repos: [{ repository: "two/kb", local_path: "/work/./shared/" }],
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "project.kb");
  assert.equal(result.sources[0].scope, "project");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("removes every collided record without stale id mappings", () => {
  const result = normalizeSources({ sources: [
    { id: "shared", repository: "one/a" },
    { id: "shared", repository: "two/b" },
    { id: "narrow", repository: "git@github.com:two/b.git", scope: "project" },
  ] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "narrow");
  assert.equal(new Set(result.sources.map((source) => source.id)).size, result.sources.length);
});
t("excludes every identity that claims a reused explicit ID", () => {
  const result = normalizeSources({ sources: [
    { id: "shared", repository: "one/a" },
    { id: "shared", repository: "two/b" },
    { id: "narrow", repository: "two/b", scope: "project" },
    { id: "shared", repository: "three/c" },
  ] });
  assert.deepEqual(result.sources.map((source) => source.id), ["narrow"]);
  assert.ok(result.errors.some((entry) => entry.includes("explicit id is claimed by multiple source identities")));
});
t("does not broaden project scope", () => {
  const result = normalizeSources({ sources: [{ repository: "a/b", scope: "project" }], repos: [{ repository: "a/b" }] });
  assert.equal(result.sources[0].scope, "project");
  assert.ok(!result.sources.some((source) => source.scope === "team"));
});
t("allows explicit project downgrade", () => assert.equal(normalizeSources({ repos: [{ repository: "a/b" }], sources: [{ repository: "a/b", scope: "project" }] }).sources[0].scope, "project"));
t("rejects a later explicit team definition that would broaden project scope", () => {
  const result = normalizeSources({ sources: [
    { id: "restricted", repository: "a/b", scope: "project" },
    { id: "broad", repository: "https://github.com/a/b", scope: "team" },
  ] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "restricted");
  assert.equal(result.sources[0].scope, "project");
});
t("reports malformed definitions", () => assert.ok(normalizeSources({ sources: [{}] }).errors.length > 0));
t("rejects malformed permissions and capabilities", () => {
  const result = normalizeSources({ sources: [{ repository: "a/b", agent_read: "yes", activate_skills: 1, capabilities: ["browse", 2] }] });
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors.length, 3);
});
t("rejects malformed string, publication, adapter, classification, and path fields", () => {
  const result = normalizeSources({ sources: [{
    repository: "a/b", kind: 1, adapter: {}, scope: "global", sensitivity: [],
    classification: false, publication: 2, content_paths: ["docs", 3],
  }] });
  assert.equal(result.sources.length, 0);
  for (const field of ["kind", "adapter", "scope", "sensitivity", "classification", "publication", "content-paths"]) {
    assert.ok(result.errors.some((entry) => entry.includes(`invalid-${field}`)), field);
  }
});
t("preserves valid v2 adapter, classification, and content paths", () => {
  const source = normalizeSources({ sources: [{ repository: "a/b", adapter: "git", classification: "curated", content_paths: ["docs/**"] }] }).sources[0];
  assert.equal(source.adapter, "git");
  assert.equal(source.classification, "curated");
  assert.deepEqual(source.content_paths, ["docs/**"]);
});
t("classifies ready only after search", () => { const h = getSourceHealth({}, { searched: true }); assert.equal(h.status, "ready"); assert.equal(h.searched, true); });
t("distinguishes cached offline from zero matches", () => { const h = getSourceHealth({}, { offline: true, searched: false, cache_revision: "abc123", result_count: 0 }); assert.equal(h.status, "cached-offline"); assert.equal(h.searched, false); });
t("does not claim cached offline without a cache", () => assert.equal(getSourceHealth({}, { offline: true, searched: false }).status, "inaccessible"));
t("does not treat a cache flag as an actual revision", () => assert.equal(getSourceHealth({}, { status: "cached-offline", cached: true }).status, "inaccessible"));
t("failure wins over cached offline", () => assert.equal(getSourceHealth({}, { failed: true, cache_revision: "abc123", offline: true }).status, "failed"));
t("declared terminal statuses win over ready and cache metadata", () => {
  for (const status of ["failed", "inaccessible", "authentication-required", "diverged", "dirty", "disabled", "unconfigured"]) {
    assert.equal(getSourceHealth({}, { status, searched: true, ready: true, offline: true, cache_revision: "abc123" }).status, status);
  }
});
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
