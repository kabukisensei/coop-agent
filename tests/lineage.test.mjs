// Tests for the data_doc tool's `lineage` branch and the before_agent_start
// lineage note in extensions/coop-tools. Drives the REAL registered tool and
// handler with a fake pi (exec is faked; no coop-data-doc binary is needed).
// Imports the bundled extension (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
// before_agent_start may refresh standards; keep that storage in a fixture, never
// the developer's real ~/.coop/standards (#87). Roots are real paths: macOS keeps
// tmpdir() under the /var -> /private/var symlink, which the storage check rejects.
const standardsFixture = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-standards-")));
process.env.COOP_STANDARDS_ROOT = join(standardsFixture, "canonical");
process.env.COOP_STANDARDS_STATE = join(standardsFixture, "status.json");
process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(standardsFixture, "snapshots");
const { default: coopTools } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

/** Boot the extension with a fake pi; `execResult(bin, args)` answers pi.exec. */
function boot(execResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const tools = new Map();
  const handlers = new Map();
  const execs = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage: () => {},
    exec: async (bin, args, opts) => {
      execs.push({ bin, args, cwd: opts?.cwd });
      const r = execResult(bin, args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  coopTools(pi);
  return { tools, handlers, execs };
}

const ctxFor = (cwd) => ({
  cwd,
  hasUI: true,
  mode: "tui",
  ui: { notify: () => {}, setStatus: () => {} },
});

const lineage = (tools, params, cwd = "/estate") =>
  tools.get("data_doc").execute("call-1", params, undefined, () => {}, ctxFor(cwd));

const SLICE = {
  object: { name: "dbo.fact_sales", kind: "table" },
  upstream: [{ name: "dbo.stg_sales" }, { name: "dbo.dim_date" }],
  downstream: [{ name: "Sales.Total Sales" }],
  relationships: [{ from: "dbo.fact_sales", to: "dbo.dim_date" }],
};

await t("lineage without an object asks for one and never runs coop-data-doc", async () => {
  const { tools, execs } = boot();
  const r = await lineage(tools, { command: "lineage" });
  assert.match(r.content[0].text, /needs an 'object'/);
  assert.deepEqual(r.details, { tool: "coop-data-doc", command: "lineage" });
  const blank = await lineage(tools, { command: "lineage", object: "   " });
  assert.match(blank.content[0].text, /needs an 'object'/);
  assert.deepEqual(execs, []);
});

await t("lineage runs `coop-data-doc lineage [--depth N] -- <object>` in the session cwd and summarizes the slice", async () => {
  const { tools, execs } = boot(() => ({ code: 0, stdout: JSON.stringify(SLICE), stderr: "" }));
  const r = await lineage(tools, { command: "lineage", object: " dbo.fact_sales ", depth: 2.7 }, "/work/estate");
  assert.deepEqual(execs, [{ bin: "coop-data-doc", args: ["lineage", "--depth", "2", "--", "dbo.fact_sales"], cwd: "/work/estate" }]);
  assert.equal(r.content[0].text, "Observed lineage for dbo.fact_sales: 2 upstream, 1 downstream, 1 relationship(s). Evidence confidence: unknown; states: unknown. Empty results do not prove zero impact. Coverage, trust, provenance, full slice and doc path in details.");
  assert.equal(r.details.tool, "coop-data-doc");
  assert.equal(r.details.command, "lineage");
  assert.equal(r.details.exitCode, 0);
  assert.deepEqual(r.details.lineage, SLICE, "the parsed slice travels in details");
});

await t("lineage passes an object that starts with '-' after `--`, never as a flag", async () => {
  const { tools, execs } = boot(() => ({ code: 0, stdout: JSON.stringify(SLICE), stderr: "" }));
  await lineage(tools, { command: "lineage", object: "--depth", depth: 0 });
  assert.deepEqual(execs[0].args, ["lineage", "--", "--depth"]);
});

await t("lineage reports an ambiguous name and keeps the candidates in details", async () => {
  const out = { ambiguous: true, matches: [{ name: "Sales.Total" }, { name: "Finance.Total" }] };
  const { tools } = boot(() => ({ code: 0, stdout: JSON.stringify(out), stderr: "" }));
  const r = await lineage(tools, { command: "lineage", object: "Total" });
  assert.match(r.content[0].text, /'Total' is ambiguous — 2 matches/);
  assert.deepEqual(r.details.lineage, out);
});

await t("lineage with no built graph degrades to the /setup-docs hint", async () => {
  const { tools } = boot(() => ({ code: 1, stdout: "", stderr: "error: no built graph at ./data-docs/graph.json\n" }));
  const r = await lineage(tools, { command: "lineage", object: "dbo.fact_sales" });
  assert.match(r.content[0].text, /^No built lineage graph yet/);
  assert.match(r.content[0].text, /\/setup-docs/);
  assert.match(r.content[0].text, /still work without it/);
  assert.equal(r.details.exitCode, 1);
  assert.equal(r.details.lineage, "", "unparseable stdout is passed through raw");
});

await t("other lineage failures surface the exit code and the tool's message", async () => {
  const { tools } = boot(() => ({ code: 2, stdout: "", stderr: "Error: config invalid\n" }));
  const r = await lineage(tools, { command: "lineage", object: "dbo.fact_sales" });
  assert.equal(r.content[0].text, "lineage failed (exit 2): Error: config invalid");
  assert.equal(r.details.stderr, "Error: config invalid\n");
});

await t("lineage explains a coop-data-doc that cannot run", async () => {
  const { tools } = boot(() => new Error("spawn coop-data-doc ENOENT"));
  const r = await lineage(tools, { command: "lineage", object: "dbo.fact_sales" });
  assert.match(r.content[0].text, /^coop-data-doc could not run: spawn coop-data-doc ENOENT/);
  assert.match(r.content[0].text, /coop install/);
  assert.equal(r.details.error, "spawn coop-data-doc ENOENT");
});

// --- before_agent_start: the agent-visible, human-hidden lineage note ----------

function estate(built, outputDir = "./data-docs") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-estate-")));
  writeFileSync(join(root, "coop-data-doc.yml"), `project_name: "x"\nrepos:\n  sql:\n    path: "./sql"\noutput:\n  dir: "${outputDir}"\n`);
  if (built) {
    mkdirSync(join(root, outputDir), { recursive: true });
    writeFileSync(join(root, outputDir, "manifest.json"), "{}");
    writeFileSync(join(root, outputDir, "graph.json"), "{}");
  }
  return root;
}

const before = (handlers, cwd) => handlers.get("before_agent_start")({ systemPrompt: "BASE", prompt: "hi" }, ctxFor(cwd));
const lineageNote = (r) => (r?.message?.customType === "coop-lineage" ? r.message : null);

await t("built docs inject one hidden lineage note per folder that points at data_doc lineage", async () => {
  const root = estate(true, "./docs/lineage");
  const { handlers } = boot();
  const first = await before(handlers, root);
  const note = lineageNote(first);
  assert.ok(note, `expected a coop-lineage message, got ${JSON.stringify(first)}`);
  assert.equal(note.display, false, "agent-visible, human-hidden");
  assert.match(note.content, /^An observed lineage graph is available/);
  assert.ok(note.content.includes(`under ${join("docs", "lineage")}:`), "names the output dir relative to cwd");
  assert.match(note.content, /data_doc tool \(command="lineage", object="<name>"\)/);
  assert.match(note.content, /BEFORE analyzing or changing any SQL object, DAX measure, or semantic model/);
  assert.deepEqual(note.details, { outputDir: join("docs", "lineage") });
  const again = await before(handlers, root);
  assert.equal(lineageNote(again), null, "announced once per session folder");
  assert.ok(!(again?.message?.content || "").includes("lineage docs ARE available"));
});

await t("a config without built docs, or no config at all, injects no lineage note", async () => {
  const unbuilt = estate(false);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-bare-")));
  const { handlers } = boot();
  for (const cwd of [unbuilt, bare]) {
    const r = await before(handlers, cwd);
    assert.equal(lineageNote(r), null, `no coop-lineage message for ${cwd}`);
    assert.ok(!(r?.message?.content || "").includes("lineage docs ARE available"));
  }
  // The same folder is retried: once docs are built, the note appears.
  mkdirSync(join(unbuilt, "data-docs"), { recursive: true });
  writeFileSync(join(unbuilt, "data-docs", "index.md"), "# docs");
  assert.equal(lineageNote(await before(handlers, unbuilt)), null, "index-only output never claims graph availability");
  writeFileSync(join(unbuilt, "data-docs", "graph.json"), "{}");
  const r = await before(handlers, unbuilt);
  const note = lineageNote(r);
  assert.doesNotMatch(note.content, /manifest.json/);
  assert.ok(note, "an unbuilt folder is not marked as announced");
  assert.deepEqual(note.details, { outputDir: "data-docs" });
});

console.log(`  ${n} lineage tests passed`);
