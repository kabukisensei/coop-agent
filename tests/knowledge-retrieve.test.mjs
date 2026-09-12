// Tests for lib/knowledge-retrieve.mjs — retrieval journey contract:
// authorization before read, semantic ranking when an embedder works,
// degraded lexical-only labeling otherwise, citations bound to source+revision.
import { strict as assert } from "node:assert";
import { retrieveKnowledge } from "../lib/knowledge-retrieve.mjs";

const DOCS = {
  "fabric-refresh": "# Semantic model refresh runbook\n\nRefresh the TEST semantic model first. Never touch PROD without explicit approval.",
  "guardrails": "# Guardrails\n\nRead-only first. Plan and approve before any mutation.",
  "sales": "# Sales pipeline\n\nQuarterly pipeline review checklist for the sales team.",
};
const provider = {
  async listFiles(source) { return source.paths.filter((k) => DOCS[k]).map((k) => `${k}.md`); },
  async readFiles(source) {
    return source.paths.filter((k) => DOCS[k]).map((k) => ({ path: `${k}.md`, text: DOCS[k], revision: `rev-${k}` }));
  },
};
// One-hot-ish stub embedder: each keyword dimension is deterministic.
const DIMS = ["refresh", "test", "prod", "approval", "read", "mutation", "sales", "pipeline", "guardrail", "semantic"];
const stubEmbed = (texts) => texts.map((t) => {
  const toks = t.toLowerCase().match(/[a-z]+/g) || [];
  return DIMS.map((d) => toks.filter((x) => x.includes(d)).length);
});

const sources = [
  { id: "kb-team", scope: "team", sensitivity: "internal", paths: ["fabric-refresh", "guardrails"] },
  { id: "kb-project", scope: "tenant", sensitivity: "restricted", paths: ["sales"] },
];
const teamSession = (s) => s.scope === "team" || s.sensitivity === "internal";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

await t("authorization happens BEFORE any read (unauthorized source's provider never touched)", async () => {
  let projectRead = false;
  const spyProvider = {
    async listFiles(source) { if (source.id === "kb-project") projectRead = true; return provider.listFiles(source); },
    async readFiles(source) { if (source.id === "kb-project") projectRead = true; return provider.readFiles(source); },
  };
  const r = await retrieveKnowledge({
    query: "how do I refresh a semantic model safely?", sources, authorize: teamSession,
    embedder: { embed: stubEmbed }, readProvider: spyProvider,
  });
  assert.equal(projectRead, false);
  assert.ok(r.exclusions.some((e) => e.source === "kb-project" && e.reason === "not-authorized"));
  assert.ok(r.results.every((x) => x.document.source !== "kb-project"));
});

await t("semantic retrieval finds the applicable note for a paraphrased question", async () => {
  const r = await retrieveKnowledge({
    query: "how do I refresh a semantic model safely?", sources, authorize: teamSession,
    embedder: { embed: stubEmbed }, readProvider: provider,
  });
  assert.equal(r.mode, "semantic");
  assert.equal(r.degraded, false);
  assert.equal(r.results[0].document.path, "fabric-refresh.md");
  assert.ok(r.results[0].score > r.results[r.results.length - 1].score);
});

await t("result cites the same source and revision the read adapter bound", async () => {
  const r = await retrieveKnowledge({
    query: "what are the guardrails?", sources, authorize: teamSession,
    embedder: { embed: stubEmbed }, readProvider: provider,
  });
  const top = r.results[0].document;
  assert.equal(top.citations.length, 1);
  assert.equal(top.citations[0].source, top.source);
  assert.equal(top.citations[0].revision, top.revision);
  assert.equal(top.citations[0].path, top.path);
  assert.equal(top.citations[0].revision, "rev-guardrails");
});

await t("no embedder → degraded lexical-only, explicitly labeled", async () => {
  const r = await retrieveKnowledge({
    query: "guardrails read-only approval", sources, authorize: teamSession, readProvider: provider,
  });
  assert.equal(r.mode, "lexical-only");
  assert.equal(r.degraded, true);
  assert.ok(r.warnings.some((w) => w.startsWith("no-embedder")));
  assert.ok(r.results.length > 0, "lexical fallback still returns results");
});

await t("embedder throwing → degraded lexical-only with warning, never silent semantic", async () => {
  const r = await retrieveKnowledge({
    query: "guardrails", sources, authorize: teamSession,
    embedder: { embed: async () => { throw new Error("endpoint down"); } }, readProvider: provider,
  });
  assert.equal(r.mode, "lexical-only");
  assert.equal(r.degraded, true);
  assert.ok(r.warnings.some((w) => w.startsWith("embedder-failed")));
});

await t("embedder malformed output → degraded with warning", async () => {
  const r = await retrieveKnowledge({
    query: "guardrails", sources, authorize: teamSession,
    embedder: { embed: async () => ["not-a-vector"] }, readProvider: provider,
  });
  assert.equal(r.mode, "lexical-only");
  assert.ok(r.warnings.some((w) => w.startsWith("embedder-malformed-output")));
});

await t("authorize throwing → source excluded with reason, no crash", async () => {
  const r = await retrieveKnowledge({
    query: "guardrails", sources,
    authorize: (s) => { if (s.id === "kb-team") throw new Error("policy engine down"); return true; },
    embedder: { embed: stubEmbed }, readProvider: provider,
  });
  assert.ok(r.exclusions.some((e) => e.source === "kb-team" && e.reason.startsWith("authorize-threw")));
});

await t("truthful empty when nothing is authorized", async () => {
  const r = await retrieveKnowledge({
    query: "anything", sources, authorize: () => false, readProvider: provider,
  });
  assert.deepEqual(r.results, []);
  assert.equal(r.exclusions.length, 2);
  assert.equal(r.errors.length, 0);
});

await t("malformed inputs → diagnostics, no crash", async () => {
  for (const bad of [{ query: "" }, { query: "x", sources: "nope" }, { query: "x", sources: null, authorize: null }]) {
    const r = await retrieveKnowledge({ ...bad, authorize: bad.authorize || (() => true), readProvider: provider });
    assert.ok(r.errors.length > 0);
    assert.equal(r.results.length, 0);
  }
  const empty = await retrieveKnowledge({ query: "x", sources: [], authorize: () => true, readProvider: provider });
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.errors, []);
});

await t("malformed embeddings never claim semantic success (F1)", async () => {
  // Single-document source: embed request is [query, doc] = 2 texts, matching
  // the two-vector fixtures, so malformed CONTENT reaches the validator
  // (count-mismatch alone must not be what rejects them — reviewer round 2
  // mutation-tested this).
  const oneDoc = [{ id: "kb-team", scope: "team", agent_read: true, sensitivity: "internal", paths: ["fabric-refresh"] }];
  const base = { query: "guardrails", sources: oneDoc, authorize: teamSession, readProvider: provider };
  for (const [label, out] of [
    ["non-numeric", [["oops"], ["oops"]]],
    ["ragged", [[1, 0], [1]]],
    ["NaN", [[NaN], [1]]],
    ["Infinity", [[Infinity], [1]]],
    ["sparse-crash", Array(2)],
  ]) {
    const r = await retrieveKnowledge({ ...base, embedder: { embed: async () => out } });
    assert.equal(r.mode, "lexical-only", `${label}: must not claim semantic`);
    assert.equal(r.degraded, true, `${label}: must be degraded`);
    assert.ok(r.warnings.some((w) => w.startsWith("embedder-malformed-output")), `${label}: malformed warning`);
  }
});

await t("malformed args container and limit return diagnostics, never crash (F2)", async () => {
  for (const bad of [undefined, null, 42, "nope"]) {
    const r = await retrieveKnowledge(bad);
    assert.ok(r.errors.some((e) => e.startsWith("invalid-args")), `args=${String(bad)}`);
  }
  for (const bad of ["oops", 1.5, -1]) {
    const r = await retrieveKnowledge({ query: "guardrails", sources, authorize: teamSession, readProvider: provider, limit: bad });
    assert.ok(r.errors.some((e) => e.startsWith("invalid-limit")), `limit=${String(bad)}`);
    assert.equal(r.results.length, 0);
  }
  const limited = await retrieveKnowledge({ query: "guardrails", sources, authorize: teamSession, readProvider: provider, limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.errors.length, 0);
});

console.log(`  ${n} knowledge-retrieve tests passed`);
