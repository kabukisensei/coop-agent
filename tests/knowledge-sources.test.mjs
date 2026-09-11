import { strict as assert } from "node:assert";
import { normalizeSources, getSourceHealth, SCHEMA_VERSION } from "../lib/knowledge-sources.mjs";

// v2 explicit definitions are gated for the September 20 candidate; tests that
// exercise the v2 path opt in explicitly.
const normalizeV2 = (config) => normalizeSources(config, { allowV2Definitions: true });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("exports schema version 2", () => assert.equal(SCHEMA_VERSION, 2));
t("normalizes legacy repositories with safe defaults", () => {
  const { sources } = normalizeV2({ knowledge: { enabled: true, repos: [{ repository: "org/Team-KB.git", local_path: "/kb" }] } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "org-team-kb--3aafde32");
  assert.equal(sources[0].scope, "team");
  assert.equal(sources[0].sensitivity, "internal");
  assert.equal(sources[0].agent_read, true);
  assert.equal(sources[0].activate_skills, false);
  assert.equal(sources[0].publication, "disabled");
  assert.deepEqual(sources[0].capabilities, ["browse", "agent-read"]);
});
t("globally disabled legacy config disables every normalized source", () => {
  const { sources } = normalizeV2({ knowledge: { enabled: false, repos: [{ repository: "org/kb", enabled: true }] } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].configEnabled, false);
  assert.equal(getSourceHealth(sources[0], { status: "ready", searched: true }).status, "disabled");
});
t("accepts a knowledge block directly", () => assert.equal(normalizeV2({ repos: [{ url: "https://x/y.git" }] }).sources[0].repository, "https://x/y.git"));
t("canonicalizes GitHub shorthand and URL identities", () => {
  const result = normalizeV2({
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
  const result = normalizeV2({ knowledge: { repos: [{ repository: "org/kb", local_path: "/old" }], sources: [{ id: "patterns.kb", kind: "patterns", repository: "https://org/kb.git", local_path: "/new", scope: "project" }] } });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "patterns.kb");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("disabled explicit v2 source outranks narrower legacy source", () => {
  const result = normalizeV2({
    sources: [
      { id: "patterns.kb", repository: "org/kb", scope: "team", enabled: false },
      { id: "patterns.kb-enabled", repository: "git@github.com:org/kb.git", scope: "project", enabled: true },
    ],
    repos: [{ repository: "https://github.com/org/kb.git", scope: "project", enabled: true }],
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "patterns.kb");
  assert.equal(result.sources[0].enabled, false);
  assert.equal(getSourceHealth(result.sources[0], { searched: true }).status, "disabled");
});
t("explicit IDs conflict with matching legacy-generated IDs", () => {
  const result = normalizeV2({ sources: [{ id: "one-kb--cfceedae", repository: "other/repo" }], repos: [{ repository: "one/kb" }] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "one-kb--cfceedae");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("preserves unknown source fields", () => assert.equal(normalizeV2({ sources: [{ repository: "a/b", future_flag: { x: 1 } }] }).sources[0].future_flag.x, 1));
t("does not create colliding generated IDs", () => {
  const sources = normalizeV2({ repos: [{ repository: "one/kb" }, { repository: "two/kb" }] }).sources;
  assert.equal(new Set(sources.map((source) => source.id)).size, 2);
});
t("keeps colliding generated v2 slugs as distinct sources", () => {
  const sources = normalizeV2({ sources: [{ repository: "one/a-b" }, { repository: "one/a/b" }] }).sources;
  assert.equal(sources.length, 2);
  assert.equal(new Set(sources.map((source) => source.id)).size, 2);
});
t("generates order-independent IDs from canonical identity", () => {
  const forward = normalizeV2({ repos: [{ repository: "one/kb" }, { repository: "two/kb" }] }).sources.map(({ repository, id }) => [repository, id]);
  const reverse = normalizeV2({ repos: [{ repository: "two/kb" }, { repository: "one/kb" }] }).sources.map(({ repository, id }) => [repository, id]);
  assert.deepEqual(Object.fromEntries(forward), Object.fromEntries(reverse));
  assert.deepEqual(Object.fromEntries(forward), { "one/kb": "one-kb--cfceedae", "two/kb": "two-kb--f6da22b6" });
});
t("keeps a legacy ID stable when another colliding slug is configured", () => {
  const alone = normalizeV2({ repos: [{ repository: "one/kb" }] }).sources[0].id;
  const withOther = normalizeV2({ repos: [{ repository: "one/kb" }, { repository: "one-kb" }] }).sources[0].id;
  assert.equal(withOther, alone);
});
t("keeps a generated ID stable when a colliding slug is added later", () => {
  const alone = normalizeV2({ sources: [{ repository: "one/a-b" }] }).sources[0].id;
  const together = normalizeV2({ sources: [{ repository: "one/a-b" }, { repository: "one/a/b" }] }).sources;
  assert.equal(together.find((source) => source.repository === "one/a-b").id, alone);
  assert.match(alone, /^learnings\.one-a-b--[0-9a-f]{8}$/);
});
t("uses local paths as bindings even when repositories are present", () => {
  const result = normalizeV2({
    sources: [{ id: "project.kb", repository: "one/kb", local_path: "/work/shared", scope: "project" }],
    repos: [{ repository: "two/kb", local_path: "/work/./shared/" }],
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "project.kb");
  assert.equal(result.sources[0].scope, "project");
  assert.ok(result.errors.some((entry) => entry.includes("conflicting-binding")));
});
t("removes every collided record without stale id mappings", () => {
  const result = normalizeV2({ sources: [
    { id: "shared", repository: "one/a" },
    { id: "shared", repository: "two/b" },
    { id: "narrow", repository: "git@github.com:two/b.git", scope: "project" },
  ] });
  assert.equal(result.sources.length, 0);
  assert.equal(new Set(result.sources.map((source) => source.id)).size, result.sources.length);
});
t("excludes every identity that claims a reused explicit ID", () => {
  const result = normalizeV2({ sources: [
    { id: "shared", repository: "one/a" },
    { id: "shared", repository: "two/b" },
    { id: "narrow", repository: "two/b", scope: "project" },
    { id: "shared", repository: "three/c" },
  ] });
  assert.deepEqual(result.sources.map((source) => source.id), []);
  assert.ok(result.errors.some((entry) => entry.includes("explicit id is claimed by multiple source identities")));
});
t("keeps conflict-excluded project identities blocked from broader re-entry", () => {
  const result = normalizeV2({
    sources: [
      { id: "shared", repository: "a/b", scope: "project" },
      { id: "shared", repository: "c/d", scope: "team" },
      { id: "broader", repository: "https://github.com/a/b.git", scope: "team" },
    ],
    repos: [{ repository: "a/b" }],
  });
  assert.equal(result.sources.some((source) => source.repository?.includes("a/b")), false);
  assert.ok(result.errors.filter((entry) => entry.includes("source identity is blocked")).length >= 2);
});
t("does not broaden project scope", () => {
  const result = normalizeV2({ sources: [{ repository: "a/b", scope: "project" }], repos: [{ repository: "a/b" }] });
  assert.equal(result.sources[0].scope, "project");
  assert.ok(!result.sources.some((source) => source.scope === "team"));
});
t("finalizes explicit v2 scope without widening project declarations", () => {
  const result = normalizeV2({ sources: [
    { id: "project", repository: "a/b", scope: "project" },
    { id: "disabled-default", repository: "https://github.com/a/b.git", enabled: false },
  ] });
  assert.equal(result.sources[0].scope, "project");
});
t("keeps explicitly declared v2 team scope", () => {
  const result = normalizeV2({ sources: [{ repository: "team/kb", scope: "team" }] });
  assert.equal(result.sources[0].scope, "team");
});
t("keeps the legacy-only default scope", () => {
  const result = normalizeV2({ repos: [{ repository: "legacy/kb" }] });
  assert.equal(result.sources[0].scope, "team");
});
t("keeps explicit v2 project scope with additional legacy identities", () => {
  const result = normalizeV2({
    sources: [{ repository: "project/kb", scope: "project" }],
    repos: [
      { repository: "https://github.com/project/kb.git" },
      { repository: "git@github.com:project/kb.git" },
    ],
  });
  assert.equal(result.sources[0].scope, "project");
});
t("allows explicit project downgrade", () => assert.equal(normalizeV2({ repos: [{ repository: "a/b" }], sources: [{ repository: "a/b", scope: "project" }] }).sources[0].scope, "project"));
t("rejects a later explicit team definition that would broaden project scope", () => {
  const result = normalizeV2({ sources: [
    { id: "restricted", repository: "a/b", scope: "project" },
    { id: "broad", repository: "https://github.com/a/b", scope: "team" },
  ] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "restricted");
  assert.equal(result.sources[0].scope, "project");
});
t("reports malformed definitions", () => assert.ok(normalizeV2({ sources: [{}] }).errors.length > 0));
t("rejects malformed permissions and capabilities", () => {
  const result = normalizeV2({ sources: [{ repository: "a/b", agent_read: "yes", activate_skills: 1, capabilities: ["browse", 2] }] });
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors.length, 3);
});
t("rejects malformed string, publication, adapter, classification, and path fields", () => {
  const result = normalizeV2({ sources: [{
    repository: "a/b", kind: 1, adapter: {}, scope: "global", sensitivity: [],
    classification: false, publication: 2, content_paths: ["docs", 3],
  }] });
  assert.equal(result.sources.length, 0);
  for (const field of ["kind", "adapter", "scope", "sensitivity", "classification", "publication", "content-paths"]) {
    assert.ok(result.errors.some((entry) => entry.includes(`invalid-${field}`)), field);
  }
});
t("preserves valid v2 adapter, classification, and content paths", () => {
  const source = normalizeV2({ sources: [{ repository: "a/b", adapter: "git", classification: "curated", content_paths: ["docs/**"] }] }).sources[0];
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

// --- September 20 circuit-breaker: v2 definitions gated, enabled flags fail closed ---

t("v2 explicit definitions are ignored by default with a diagnostic", () => {
  const { sources, errors } = normalizeSources({ knowledge: { sources: [{ id: "v2src", repository: "org/kb", scope: "project" }], repos: [{ repository: "org/legacy" }] } });
  assert.equal(sources.length, 1);
  assert.ok(sources[0].id.startsWith("org-legacy--"));
  assert.ok(!sources.some((s) => s.id === "v2src"));
  assert.ok(errors.some((e) => e.includes("v2-definitions-disabled")));
});

t("v2 opt-in flag restores explicit definition processing", () => {
  const { sources, errors } = normalizeV2({ knowledge: { sources: [{ id: "v2src", repository: "org/kb", scope: "project" }] } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "v2src");
  assert.equal(sources[0].scope, "project");
  assert.ok(!errors.some((e) => e.includes("v2-definitions-disabled")));
});

t("malformed knowledge.enabled fails closed with diagnostic", () => {
  const { sources, errors } = normalizeSources({ knowledge: { enabled: "false", repos: [{ repository: "org/kb" }] } });
  assert.ok(errors.some((e) => e.includes("invalid-enabled")));
  assert.equal(sources[0].configEnabled, false);
});

t("malformed source-level enabled excludes the source", () => {
  const { sources, errors } = normalizeSources({ knowledge: { repos: [{ repository: "org/kb", enabled: "yes" }, { repository: "org/other" }] } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].repository, "org/other");
  assert.ok(errors.some((e) => e.includes("invalid-enabled")));
});

t("boolean disabled controls still work end to end", () => {
  const { sources, errors } = normalizeSources({ knowledge: { enabled: false, repos: [{ repository: "org/kb" }] } });
  assert.ok(errors.length === 0 || !errors.some((e) => e.includes("invalid-enabled")));
  assert.equal(sources[0].configEnabled, false);
});

t("gated v2 project+disabled restrictions bind legacy reappearance", () => {
  const { sources } = normalizeSources({ knowledge: {
    sources: [{ repository: "org/kb", scope: "project", enabled: false }],
    repos: [{ repository: "org/kb" }],
  } });
  assert.ok(!sources.some((s) => s.repository === "org/kb" && s.scope === "team" && s.enabled !== false));
});

t("gated v2 disabled identity emits legacy source as disabled project", () => {
  const { sources, errors } = normalizeSources({ knowledge: {
    sources: [{ repository: "org/kb", scope: "project", enabled: false }],
    repos: [{ repository: "org/kb", scope: "project" }],
  } });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].scope, "project");
  assert.equal(sources[0].enabled, false);
  assert.ok(!errors.some((e) => e.includes("scope-broadening")));
});

t("malformed enabled flag on any definition binds identity disabled (fail closed)", () => {
  const { sources } = normalizeSources({ knowledge: {
    sources: [{ repository: "org/kb", enabled: "no" }],
    repos: [{ repository: "org/kb", scope: "project" }],
  } });
  assert.ok(sources.every((s) => s.enabled === false));
});

t("health searched requires completed search, capability alone is not searched", () => {
  assert.equal(getSourceHealth({}, { searchable: true }).searched, false);
  assert.equal(getSourceHealth({}, { searched: false, searchable: true }).searched, false);
  assert.equal(getSourceHealth({}, { searched: true }).searched, true);
});

t("remote repository and local path are distinct identity namespaces for gated restrictions", () => {
  const { sources } = normalizeSources({ knowledge: {
    sources: [{ repository: "org/kb", scope: "project", enabled: false }],
    repos: [{ local_path: "/kb" }],
  } });
  assert.equal(sources.length, 1);
  assert.notEqual(sources[0].enabled, false);
});

t("explicit opt-in winners inherit identity-level disabled marks", () => {
  const { sources } = normalizeV2({ knowledge: {
    sources: [{ repository: "org/kb", scope: "project" }, { repository: "org/kb", scope: "project", enabled: false, id: "kb2" }],
    repos: [],
  } });
  assert.ok(sources.every((s) => s.enabled === false));
});

t("aliases declared by gated v2 defs propagate restrictions to legacy entries", () => {
  const { sources } = normalizeSources({ knowledge: {
    sources: [{ repository: "org/kb", scope: "project", enabled: false }, { repository: "org/kb", local_path: "/cache/kb" }],
    repos: [{ local_path: "/cache/kb" }],
  } });
  assert.ok(!sources.some((s) => s.scope === "team" && s.enabled !== false));
});

console.log(`✓ ${n} knowledge source tests passed`);
