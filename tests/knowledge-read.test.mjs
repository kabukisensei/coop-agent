import { strict as assert } from "node:assert";
import { readSourceDocuments } from "../lib/knowledge-read.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };
const source = { id: "team-kb", scope: "team", sensitivity: "internal", agent_read: true };

await t("reads and normalizes markdown documents", async () => {
  const result = await readSourceDocuments(source, {
    async listFiles() { return ["getting-started.md"]; },
    async readFiles() { return [{ path: "getting-started.md", text: "# Getting Started\nHello", revision: "r7" }]; },
  });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.documents[0], {
    id: result.documents[0].id,
    title: "Getting Started",
    path: "getting-started.md",
    revision: "r7",
    source: "team-kb",
    scope: "team",
    sensitivity: "internal",
    text: "# Getting Started\nHello",
    citations: [{ source: "team-kb", path: "getting-started.md", revision: "r7" }],
  });
});

await t("uses filename and unknown revision without fabricating provenance", async () => {
  const { documents } = await readSourceDocuments(source, {
    async listFiles() { return ["docs/notes.md"]; },
    async readFiles() { return [{ path: "docs/notes.md", text: "plain markdown" }]; },
  });
  assert.equal(documents[0].title, "notes.md");
  assert.equal(documents[0].revision, "unknown");
  assert.equal(documents[0].citations[0].revision, "unknown");
});

await t("produces stable IDs from source and path", async () => {
  const provider = { async listFiles() { return ["a.md"]; }, async readFiles() { return [{ path: "a.md", text: "a" }]; } };
  const first = (await readSourceDocuments(source, provider)).documents[0].id;
  const second = (await readSourceDocuments({ ...source, scope: "project" }, provider)).documents[0].id;
  assert.equal(first, second);
  assert.notEqual(first, (await readSourceDocuments({ ...source, id: "other" }, provider)).documents[0].id);
});

await t("reports provider failures as failures with no documents", async () => {
  const result = await readSourceDocuments(source, {
    async listFiles() { return ["a.md"]; },
    async readFiles() { throw new Error("backend unavailable"); },
  });
  assert.deepEqual(result.documents, []);
  assert.match(result.errors[0], /read-files-failed/);
});

await t("reports incomplete reads as failures with no documents", async () => {
  const result = await readSourceDocuments(source, {
    async listFiles() { return ["a.md", "b.md"]; },
    async readFiles() { return [{ path: "a.md", text: "A" }]; },
  });
  assert.deepEqual(result.documents, []);
  assert.match(result.errors[0], /incomplete-read-files/);
  assert.match(result.errors[0], /b\.md/);
});

await t("checks the permission gate before provider calls", async () => {
  let calls = 0;
  const result = await readSourceDocuments({ ...source, agent_read: false }, {
    async listFiles() { calls++; return ["a.md"]; },
    async readFiles() { calls++; return []; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.documents, []);
  assert.match(result.errors[0], /agent-read-denied/);
});

await t("skips malformed files with per-file diagnostics", async () => {
  const result = await readSourceDocuments(source, {
    async listFiles() { return ["good.md"]; },
    async readFiles() { return [
      { path: "good.md", text: "# Good" },
      { path: "bad.md", text: 42 },
      { text: "missing path" },
    ]; },
  });
  assert.deepEqual(result.documents.map((document) => document.path), ["good.md"]);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((error) => error.includes("bad.md")));
  assert.ok(result.errors.some((error) => error.includes("invalid-file")));
});

await t("finds the first real H1 without consuming newlines or changing literal hashes", async () => {
  const { documents } = await readSourceDocuments(source, {
    async listFiles() { return ["heading.md"]; },
    async readFiles() { return [{ path: "heading.md", text: "```md\n# Fenced\n```\n# Real#\nNext" }]; },
  });
  assert.equal(documents[0].title, "Real#");
});

await t("returns a truthful empty result for an empty source", async () => {
  const result = await readSourceDocuments(source, {
    async listFiles() { return []; },
    async readFiles() { throw new Error("must not be called"); },
  });
  assert.deepEqual(result, { documents: [], errors: [] });
});

console.log(`✓ ${n} knowledge-read tests passed`);
