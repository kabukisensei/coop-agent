// Live acceptance for the data_doc wrapper and /setup-docs against the REAL
// coop-data-doc (master plan row 11a, DD4: "UTF-8 JSONL stdin/stdout works
// through Windows pipes"). Everything runs through real child processes and pipes:
//   - /setup-docs, the registered command, drives `coop-data-doc setup --transport
//     jsonl` over stdin/stdout, then builds through Pi's exec
//   - the data_doc tool runs scan, check, lineage and impact through Pi's exec
// against a synthetic mixed estate (SQL + Power BI TMDL) whose folder, file,
// schema, table, column, measure and project names are non-ASCII. No client
// data, network or credentials.
//
// Pi's exec is the real one when COOP_TEST_PI_ROOT names an installed
// @earendil-works/pi-coding-agent; otherwise a copy of its spawn contract.
// Skips cleanly when coop-data-doc (>= 1.3.0) is not on PATH; set
// COOP_TEST_DATADOC_REQUIRED=1 (the Windows data-doc CI job) to turn a skip, a
// pin mismatch or a missing Pi into a failure.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
if (!dist) { console.error("COOP_TEST_DIST not set"); process.exit(1); }
const required = process.env.COOP_TEST_DATADOC_REQUIRED === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = (why) => {
  if (required) { console.error(`  ✗ ${why}`); process.exit(1); }
  console.log(`  – ${why}; skipping live data_doc acceptance`);
  process.exit(0);
};

// Standards refresh hooks must never touch the real ~/.coop (#87).
const standardsFixture = realpathSync(mkdtempSync(join(tmpdir(), "coop-datadoc-standards-")));
process.env.COOP_STANDARDS_ROOT = join(standardsFixture, "canonical");
process.env.COOP_STANDARDS_STATE = join(standardsFixture, "status.json");
process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(standardsFixture, "snapshots");
const { default: coopTools, resolveDataDocExecutable } = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

// --- the installed companion ----------------------------------------------------
let exe;
try { exe = resolveDataDocExecutable(process.platform, process.env); }
catch (e) { skip(`coop-data-doc not usable: ${e.message}`); }
const version = await new Promise((done) => {
  const p = spawn(exe, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.once("error", () => done(""));
  p.once("close", () => done((out.match(/(\d+)\.(\d+)\.(\d+)/) || [""])[0]));
});
if (!version) skip("coop-data-doc not on PATH");
const pinned = JSON.parse(readFileSync(join(root, "config", "release-manifest.json"), "utf8")).python_tools["coop-data-doc"];
const [maj, min] = version.split(".").map(Number);
if (maj < 1 || (maj === 1 && min < 3)) skip(`coop-data-doc ${version} predates the 1.3.0 evidence contract`);
if (required && version !== pinned) skip(`coop-data-doc ${version} is installed, but release-manifest.json pins ${pinned}`);

// --- Pi's exec ------------------------------------------------------------------
let execCommand;
if (process.env.COOP_TEST_PI_ROOT) {
  const execJs = join(process.env.COOP_TEST_PI_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "exec.js");
  if (!existsSync(execJs)) skip(`Pi's exec not found at ${execJs}`);
  ({ execCommand } = await import(pathToFileURL(execJs).href));
} else if (required) {
  skip("COOP_TEST_PI_ROOT must name an installed Pi for the required run");
} else {
  // Pi 0.87.1 core/exec.js: shell-free spawn, inherited env, chunks decoded one by one.
  execCommand = (command, args, cwd, options) => new Promise((done) => {
    const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.once("error", () => done({ stdout, stderr, code: 1, killed: false }));
    proc.once("close", (code) => done({ stdout, stderr, code: code ?? 0, killed: false }));
  });
}

// --- synthetic mixed estate with non-ASCII names ----------------------------------
const work = join(realpathSync(mkdtempSync(join(tmpdir(), "coop-datadoc-live-"))), "Données Clientes Ü");
const sqlDir = join(work, "Entrepôt SQL");
const pbiDir = join(work, "Rapports Power BI");
const model = join(pbiDir, "Modèle Ventes.SemanticModel", "definition");
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, "utf8"); };
write(join(sqlDir, "bronze", "Kunden_Übersicht.sql"), [
  "CREATE TABLE bronze.[Kunden_Übersicht] (",
  "    [KundenNr] INT NOT NULL,",
  "    [Größe] DECIMAL(10, 2) NULL,",
  "    [Région] NVARCHAR(50) NULL",
  ");",
  "",
].join("\n"));
write(join(sqlDir, "ventes", "Résumé_Été.sql"), [
  "CREATE VIEW ventes.[Résumé_Été] AS",
  "SELECT k.[KundenNr], k.[Größe], k.[Région]",
  "FROM bronze.[Kunden_Übersicht] AS k;",
  "",
].join("\n"));
write(join(model, "model.tmdl"), "model Model\n\tculture: fr-FR\n");
write(join(model, "tables", "Résumé Été.tmdl"), [
  "table 'Résumé Été'",
  "",
  "\tmeasure 'Total Größe' = SUM('Résumé Été'[Größe])",
  "",
  "\tcolumn KundenNr",
  "\t\tdataType: int64",
  "\t\tsourceColumn: KundenNr",
  "",
  "\tcolumn Größe",
  "\t\tdataType: decimal",
  "\t\tsourceColumn: Größe",
  "",
  "\tcolumn Région",
  "\t\tdataType: string",
  "\t\tsourceColumn: Région",
  "",
  "\tpartition 'Résumé Été' = m",
  "\t\tmode: import",
  "\t\tsource =",
  "\t\t\t\tlet",
  "\t\t\t\t    Source = Sql.Database(\"srv\", \"db\"),",
  "\t\t\t\t    Data = Source{[Schema=\"ventes\",Item=\"Résumé_Été\"]}[Data]",
  "\t\t\t\tin",
  "\t\t\t\t    Data",
  "",
].join("\n"));
const PROJECT = "Domaine Ünïcode – Été";

// --- boot the extension with Pi's real exec ------------------------------------------
const tools = new Map();
const commands = new Map();
const execs = [];
const pi = {
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand: (name, command) => commands.set(name, command),
  on: () => {},
  sendUserMessage: () => {},
  getThinkingLevel: () => "off",
  exec: (command, args, options) => {
    execs.push([command, ...args].join(" "));
    return execCommand(command, args, options?.cwd ?? work, options);
  },
};
coopTools(pi);

let failures = 0;
const ok = (cond, name, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
};
// Mojibake from a UTF-8/cp1252 mismatch: "é" read back as "Ã©", or U+FFFD.
const garbled = (text) => /Ã|Â|�/.test(text);

// --- /setup-docs: the JSONL wizard over real pipes, then "Build now?" ----------------
let rerun = false;
const notices = [];
const prompts = [];
const seen = new Map();
const sqlRel = relative(work, sqlDir).replace(/\\/g, "/");
const pbiRel = relative(work, pbiDir).replace(/\\/g, "/");
const ui = {
  notify: (message, type) => notices.push({ message: String(message), type }),
  confirm: async (title, message) => { prompts.push(`confirm: ${message}`); return true; },
  input: async (message, def) => {
    prompts.push(`input: ${message}`);
    if (/SQL repo path/i.test(message)) return sqlRel;
    if (/Power BI repo path/i.test(message)) return pbiRel;
    // First run types the name; the re-run takes the prefilled default, which
    // coop read back from the YAML coop-data-doc wrote.
    if (/project name/i.test(message)) return rerun ? def : PROJECT;
    return def ?? "";
  },
  select: async (message, options) => {
    prompts.push(`select: ${message}`);
    const key = `${message}|${options.join("|")}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 6) throw new Error(`runaway wizard prompt: ${message}`);
    // Repo paths are typed, never browsed.
    const manual = options.find((o) => o.startsWith("⌨ "));
    if (manual && /repo path/i.test(message)) return manual;
    // Checkbox loops toggle one entry per call: document every folder and model,
    // put bronze and ventes in their layers, keep every other preselection.
    if (options.includes("✓ Done")) {
      if (process.env.COOP_DATADOC_TRACE) console.error(`TRACE ${message}\n  ${options.join("\n  ")}`);
      const wanted = /pick the folders|Semantic models to include/i.test(message) ? () => true
        : /^Bronze layer/i.test(message) ? (o) => /\bbronze\b/.test(o)
        : /^Gold layer/i.test(message) ? (o) => /\bventes\b/.test(o)
        : () => false;
      const next = options.find((o) => o.startsWith("☐ ") && !/manual|type /i.test(o) && wanted(o));
      return next || "✓ Done";
    }
    return options[0]; // the wizard's default is always rendered first
  },
};
const ctx = { cwd: work, hasUI: true, ui, signal: undefined };
const setupDocs = commands.get("setup-docs");
assert.ok(setupDocs, "setup-docs command registered");
await setupDocs.handler("", ctx);

const errors = notices.filter((n) => n.type === "error");
ok(errors.length === 0, "/setup-docs reported no errors", errors.map((n) => n.message).join(" | "));
ok(execs.some((c) => / setup --help$/.test(c)), "/setup-docs feature-detected the JSONL transport through Pi's exec");
const configPath = join(work, "coop-data-doc.yml");
ok(existsSync(configPath), "the wizard wrote coop-data-doc.yml in the non-ASCII project folder");
const showConfig = async () => {
  const r = await execCommand("coop-data-doc", ["show-config"], work, {});
  try { return JSON.parse(r.stdout); } catch { return { unparsed: `${r.stdout}${r.stderr}`.slice(0, 300) }; }
};
const saved = await showConfig();
ok(saved.project_name === PROJECT, "the non-ASCII project name round-tripped through the JSONL pipes", JSON.stringify(saved).slice(0, 300));
ok(/Entrepôt SQL$/.test(String(saved.repos?.sql?.path || "")), "the non-ASCII SQL repo path round-tripped", JSON.stringify(saved.repos || saved).slice(0, 300));
ok(!garbled(existsSync(configPath) ? readFileSync(configPath, "utf8") : ""), "coop-data-doc.yml carries no mojibake");
ok(execs.some((c) => / build$/.test(c)), "\"Build now?\" ran coop-data-doc build through Pi's exec");
const built = join(work, "data-docs", "graph.json");
ok(existsSync(built), "the build published graph.json");
ok(!notices.some((n) => /Build failed/.test(n.message)), "the build reported success", notices.map((n) => n.message).join(" | "));
if (existsSync(built)) {
  const graph = readFileSync(built, "utf8");
  ok(/Résumé|r\\u00e9sum\\u00e9|résumé/i.test(graph) && !garbled(graph), "graph.json keeps the non-ASCII object names");
}

// --- /setup-docs again: coop prefills from the YAML it reads back ------------------------
rerun = true;
notices.length = 0;
await setupDocs.handler("", ctx);
ok(!notices.some((n) => n.type === "error"), "the /setup-docs re-run reported no errors", notices.filter((n) => n.type === "error").map((n) => n.message).join(" | "));
const resaved = await showConfig();
ok(resaved.project_name === PROJECT, "the re-run kept the non-ASCII project name coop prefilled from coop-data-doc.yml", JSON.stringify(resaved).slice(0, 300));

// --- the data_doc tool through Pi's exec ----------------------------------------------
const dataDoc = tools.get("data_doc");
assert.ok(dataDoc, "data_doc tool registered");
const run = async (params) => {
  const result = await dataDoc.execute("live", params, undefined, undefined, { cwd: work });
  return { text: result.content.map((c) => c.text).join("\n"), details: result.details };
};

for (const command of ["scan", "build", "check"]) {
  const r = await run({ command });
  ok(r.details.exitCode === 0, `data_doc ${command} exits 0`, `${r.text.slice(0, 400)} | stderr: ${String(r.details.stderr || "").slice(-400)}`);
  ok(!garbled(r.text), `data_doc ${command} output has no mojibake`, r.text.slice(0, 400));
}

const lineage = await run({ command: "lineage", object: "ventes.Résumé_Été" });
ok(lineage.details.exitCode === 0, "data_doc lineage resolves a non-ASCII object name passed through argv", lineage.text.slice(0, 400));
ok(/Résumé Été/i.test(lineage.text), "lineage names the Power BI table downstream", lineage.text.slice(0, 600));
ok(/Kunden_Übersicht/i.test(lineage.text), "lineage names the bronze table upstream", lineage.text.slice(0, 600));
ok(!garbled(lineage.text), "lineage text has no mojibake", lineage.text.slice(0, 400));
ok(/evidence|coverage/i.test(lineage.text), "lineage keeps its coverage/evidence qualification", lineage.text.slice(0, 600));

const changed = join(sqlDir, "ventes", "Résumé_Été.sql");
const impact = await run({ command: "impact", files: [relative(work, changed)] });
ok(impact.details.exitCode === 0, "data_doc impact accepts a changed file with a non-ASCII path", impact.text.slice(0, 400));
ok(/Résumé Été/i.test(impact.text), "impact lists the Power BI table the changed view feeds", impact.text.slice(0, 600));
ok(!garbled(impact.text), "impact text has no mojibake", impact.text.slice(0, 400));

console.log(failures === 0
  ? `  ✓ live data_doc acceptance passed (coop-data-doc ${version}, ${prompts.length} wizard prompts, ${process.env.COOP_TEST_PI_ROOT ? "Pi's exec" : "exec copy"})`
  : `  ✗ live data_doc acceptance FAILED (${failures})\n    wizard prompts: ${prompts.join(" | ").slice(0, 1500)}\n    notices: ${notices.map((n) => `${n.type}: ${n.message}`).join(" | ").slice(0, 1500)}`);
process.exit(failures === 0 ? 0 : 1);
