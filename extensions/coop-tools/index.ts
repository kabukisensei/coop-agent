/**
 * coop-tools — native, LLM-callable Cooptimize tools for Pi.
 *
 * Registers three read-only / advisory tools that shell out to the standalone
 * Coop CLIs and return machine-readable JSON the model can reason over:
 *
 *   sql_review  -> coop-sql-review check <paths> --format json   (advisory; never edits/blocks)
 *   dax_review  -> coop-dax-review check <paths> --format json   (advisory; never edits/blocks)
 *   data_doc    -> coop-data-doc <scan|build|check|lineage>      (lineage graph + manifest.json;
 *                                                                lineage = one object's up/downstream)
 *
 * These let the agent call the review/documentation tools directly instead of
 * asking the user to run them. They are advisory: they never modify source.
 *
 * It ALSO hosts coop-data-doc's first-run setup so the user can establish lineage
 * docs WITHOUT leaving the agent. Pi's pi.exec / bash run children
 * non-interactively (no TTY), so coop-data-doc's own questionary wizard can't be
 * driven from inside a session. Instead we render a quick wizard with Pi's native
 * dialogs (ctx.ui.input/confirm/select), write/patch coop-data-doc.yml, and build:
 *
 *   • on session_start, if the cwd has no coop-data-doc.yml (and no skip marker),
 *     offer to set it up — Yes / Not now / "Don't ask again" (only the last writes
 *     .coop-data-doc.skip, so an accidental dismissal never silences setup forever)
 *   • /setup-docs runs (or re-runs) that wizard anytime — on a re-run it patches
 *     ONLY the fields it manages, IN PLACE, so the full wizard's layers / branding /
 *     mappings / dialect / globs survive
 *
 * The full, richer wizard (folders/layers/branding/mappings) still lives in the
 * tool itself and runs in a real shell: `coop data-doc setup`.
 * Everything here is feature-detected and try/catch-wrapped so it can never crash pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const SEVERITY = Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]);

const REVIEW_PARAMS = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Files or directories to check. Defaults to the current directory.",
    }),
  ),
  min_severity: Type.Optional(SEVERITY),
  strict: Type.Optional(
    Type.Boolean({ description: "Exit non-zero if findings remain (CI gate). Default false." }),
  ),
});

const DATADOC_PARAMS = Type.Object({
  command: Type.Optional(
    Type.Union(
      [Type.Literal("scan"), Type.Literal("build"), Type.Literal("check"), Type.Literal("lineage")],
      {
        description:
          "coop-data-doc subcommand. 'scan' (default) builds the lineage graph (read-only); 'build' also writes Markdown docs + portal; 'check' is a CI staleness gate; 'lineage' returns ONE object's upstream/downstream + relationships as JSON from the built graph — call it BEFORE touching that object.",
      },
    ),
  ),
  object: Type.Optional(
    Type.String({
      description:
        "For command='lineage': the object to look up (e.g. 'dbo.fact_sales', or a table/measure name). Ambiguous names return candidates to choose from.",
    }),
  ),
  depth: Type.Optional(
    Type.Number({ description: "For command='lineage': hops up/downstream to include (default 1)." }),
  ),
});

interface ReviewParams {
  paths?: string[];
  min_severity?: "error" | "warning" | "info";
  strict?: boolean;
}

function summarizeReview(bin: string, parsed: any, stdout: string, code: number): string {
  if (!parsed || typeof parsed !== "object") {
    return `${bin}: could not parse JSON (exit ${code}).\n${stdout.slice(0, 2000)}`;
  }
  const findings: any[] = parsed.findings || parsed.results || [];
  const sev = { error: 0, warning: 0, info: 0 } as Record<string, number>;
  for (const f of findings) {
    const s = String(f.severity || "").toLowerCase();
    if (s in sev) sev[s]++;
  }
  return (
    `${bin}: ${findings.length} finding(s) — ` +
    `${sev.error} error, ${sev.warning} warning, ${sev.info} info (exit ${code}). ` +
    `Full structured report is in this tool result's details.`
  );
}

// --- coop-data-doc setup wizard (native Pi dialogs) --------------------------
// Defaults mirror coop-data-doc/src/coop_data_doc/config.py (render_config_yaml /
// _CONFIG_TEMPLATE / DEFAULT_*). If that schema changes, mirror it here. We emit
// only a SUBSET of known keys — safe because Config uses extra="forbid" (only
// UNKNOWN keys are rejected) and every omitted field has a default.
const DATADOC_CONFIG = "coop-data-doc.yml";
const SKIP_MARKER = ".coop-data-doc.skip";
const DEFAULT_SQL_INCLUDE = ["**/*.sql"];
const DEFAULT_SQL_EXCLUDE = ["**/archive/**"];
const DEFAULT_PBI_INCLUDE = ["**/*.tmdl", "**/*.bim", "**/report.json", "**/visual.json", "**/page.json", "**/*.pbix"];
const DEFAULT_PBI_EXCLUDE: string[] = [];
const DEFAULT_OUTPUT_DIR = "./data-docs";

interface DataDocSettings {
  projectName: string;
  sqlPath: string;
  pbiPath: string;
  outputDir: string;
  siteDir: string;
}

const errMsg = (e: any): string => (e && e.message ? e.message : String(e));

function notify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, type);
  } catch {
    /* never break pi */
  }
}

/** Prompt for text; Enter (blank) accepts `def`; returns null when cancelled.
 *  Strips control chars (incl. DEL/C1) that PyYAML's safe_load would later reject. */
async function askText(ctx: any, label: string, def: string): Promise<string | null> {
  if (typeof ctx?.ui?.input !== "function") return null;
  const raw = await ctx.ui.input(`${label}  ·  Enter = ${def || "(blank)"}`, def);
  if (raw === undefined || raw === null) return null; // Esc / cancel
  // eslint-disable-next-line no-control-regex
  const v = String(raw).replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return v || def;
}

/** Yes/no dialog. Throws if no confirm UI is available (caller decides fallback). */
async function askConfirm(ctx: any, title: string, message: string): Promise<boolean> {
  if (typeof ctx?.ui?.confirm !== "function") throw new Error("no confirm UI");
  return await ctx.ui.confirm(title, message);
}

/** A first-run OFFER with an explicit Not-now vs Never. Esc/dismiss == "later"
 *  (never permanently suppresses), so an accidental keypress can't silence setup
 *  forever — only the explicit "Don't ask again" writes the skip marker.
 *  Throws if no select UI is available (caller decides fallback). */
async function askOffer(ctx: any, title: string, message: string, yesLabel: string): Promise<"yes" | "later" | "never"> {
  if (typeof ctx?.ui?.select !== "function") throw new Error("no select UI");
  const NEVER = "Don't ask again in this folder";
  const choice = await ctx.ui.select(`${title}\n${message}`, [yesLabel, "Not now", NEVER]);
  if (choice === yesLabel) return "yes";
  if (choice === NEVER) return "never";
  return "later"; // "Not now" or Esc/dismiss
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function resolveRel(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Markdown output dir holds built docs (mirrors what `coop-data-doc build` writes). */
function isBuilt(outAbs: string): boolean {
  return existsSync(join(outAbs, "manifest.json")) || existsSync(join(outAbs, "index.md"));
}

function withinOrEqual(inner: string, outer: string): boolean {
  // Separator-aware (path.relative), so nesting is detected on Windows too — a
  // hardcoded "/" prefix test misses C:\a\b inside C:\a. Mirrors config.py's
  // Path.relative_to. Empty rel = same dir; ".."/absolute rel = not inside.
  const rel = relative(resolve(outer), resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Mirror config.py output_dirs_conflict: site must not equal/nest the markdown dir. */
export function outputDirsConflict(outAbs: string, siteAbs: string): boolean {
  return withinOrEqual(siteAbs, outAbs) || withinOrEqual(outAbs, siteAbs);
}

/** Mirror wizard._sibling_site: an HTML dir that sits NEXT TO the markdown dir. */
export function siblingSite(outputDir: string): string {
  const trimmed = outputDir.replace(/[/\\]+$/, "") || DEFAULT_OUTPUT_DIR;
  return `${trimmed}-site`;
}

function writeSkip(skipPath: string): void {
  try {
    writeFileSync(
      skipPath,
      "coop-data-doc: setup declined here. Delete this file (or run /setup-docs) to be asked again.\n",
      "utf8",
    );
  } catch {
    /* best effort */
  }
}

/** Read just the scalar value off a `key: value` line, quote- and comment-aware.
 *  Handles double-quote backslash escapes and single-quote '' → ' the way YAML
 *  does, and only treats '#' as a comment when it's whitespace-preceded. */
export function scalarValue(afterColon: string): string {
  const s = afterColon.trim();
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") {
        out += s[i + 1] ?? "";
        i++;
        continue;
      }
      if (s[i] === '"') break;
      out += s[i];
    }
    return out;
  }
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      out += s[i];
    }
    return out;
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

type ManagedKey = "project_name" | "sql_path" | "powerbi_path" | "output_dir" | "output_site_dir";

/** Locate the lines for the 5 fields the native wizard manages — robust to 2- or
 *  4-space indentation, extra repo keys (e.g. a third `staging:`), and nested
 *  mappings. Block-style YAML only (best-effort), matching what coop-data-doc emits. */
export function classifyManagedLines(text: string): Array<{ i: number; key: ManagedKey }> {
  const lines = text.split("\n");
  const found: Array<{ i: number; key: ManagedKey }> = [];
  let section: "repos" | "output" | null = null;
  let repo: "sql" | "powerbi" | null = null;
  let repoIndent: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, "  ");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      section = null;
      repo = null;
      repoIndent = null;
      const ci = body.indexOf(":");
      const key = ci >= 0 ? body.slice(0, ci) : body;
      if (key === "repos") section = "repos";
      else if (key === "output") section = "output";
      else if (key === "project_name" && ci >= 0) found.push({ i, key: "project_name" });
      continue;
    }
    if (section === "repos") {
      if (repoIndent === null) repoIndent = indent; // first nested key sets the repo level
      if (indent === repoIndent) {
        repo = body.startsWith("sql:") ? "sql" : body.startsWith("powerbi:") ? "powerbi" : null;
      } else if (indent > repoIndent && repo && body.startsWith("path:")) {
        found.push({ i, key: repo === "sql" ? "sql_path" : "powerbi_path" });
      }
    } else if (section === "output") {
      if (body.startsWith("dir:")) found.push({ i, key: "output_dir" });
      else if (body.startsWith("site_dir:")) found.push({ i, key: "output_site_dir" });
    }
  }
  return found;
}

/** Best-effort prefill: pull the few scalars we manage from an existing yml. */
export function parseExisting(text: string): Partial<DataDocSettings> {
  const out: Partial<DataDocSettings> = {};
  const lines = text.split("\n");
  for (const { i, key } of classifyManagedLines(text)) {
    const v = scalarValue(lines[i].slice(lines[i].indexOf(":") + 1));
    if (key === "project_name") out.projectName = v;
    else if (key === "sql_path") out.sqlPath = v;
    else if (key === "powerbi_path") out.pbiPath = v;
    else if (key === "output_dir") out.outputDir = v;
    else if (key === "output_site_dir") out.siteDir = v;
  }
  return out;
}

/** The trailing ` # comment` of a post-colon remainder (outside quotes), or "". */
export function trailingComment(rest: string): string {
  let q: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) {
      if (c === q && !(q === '"' && rest[i - 1] === "\\")) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === "#" && i > 0 && /\s/.test(rest[i - 1])) return "  " + rest.slice(i);
  }
  return "";
}

/** Surgically rewrite ONLY the 5 managed scalars in an existing yml, preserving
 *  everything else (medallion layers, branding, schema mappings, include/exclude
 *  globs, sql_dialect, comments). This is what makes a /setup-docs re-run SAFE —
 *  regenerating from 5 fields would silently clobber all of that. */
export function updateConfigText(text: string, s: DataDocSettings): string {
  const lines = text.split("\n");
  const value: Record<ManagedKey, string> = {
    project_name: s.projectName,
    sql_path: s.sqlPath,
    powerbi_path: s.pbiPath,
    output_dir: s.outputDir,
    output_site_dir: s.siteDir,
  };
  for (const { i, key } of classifyManagedLines(text)) {
    const ci = lines[i].indexOf(":");
    lines[i] = `${lines[i].slice(0, ci + 1)} ${JSON.stringify(value[key])}${trailingComment(lines[i].slice(ci + 1))}`;
  }
  return lines.join("\n");
}

/** Render a minimal, valid coop-data-doc.yml. Scalars/arrays JSON-encoded (valid YAML). */
export function renderMinimalConfig(s: DataDocSettings): string {
  const j = (v: unknown) => JSON.stringify(v);
  return `# coop-data-doc configuration — generated by coop /setup-docs.
# Point the tool at your repos, then run \`coop-data-doc build\`.
# All relative paths resolve against the folder containing THIS file.
# Re-run /setup-docs in the agent, or \`coop data-doc setup\` in a shell for the
# full wizard (folders, medallion layers, branding, schema->model mappings).

project_name: ${j(s.projectName)}

repos:
  sql:
    path: ${j(s.sqlPath)}
    include: ${j(DEFAULT_SQL_INCLUDE)}
    exclude: ${j(DEFAULT_SQL_EXCLUDE)}
  powerbi:
    path: ${j(s.pbiPath)}
    include: ${j(DEFAULT_PBI_INCLUDE)}
    exclude: ${j(DEFAULT_PBI_EXCLUDE)}

# Configure these with the full wizard (\`coop data-doc setup\`); empty = defaults.
schema_mappings: []
layers: {}
ignore_schemas: []
branding: {}

output:
  dir: ${j(s.outputDir)}        # markdown docs (for agents)
  site_dir: ${j(s.siteDir)}     # html portal (for humans)

sql_dialect: "tsql"
`;
}

/** Run `coop-data-doc build` and report the outcome. Returns true on exit 0. */
async function runBuild(pi: ExtensionAPI, ctx: any, outputDir?: string): Promise<boolean> {
  notify(ctx, "Building data docs… (this can take a moment on a large estate)", "info");
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await pi.exec("coop-data-doc", ["build"], { cwd: ctx.cwd, signal: ctx.signal });
  } catch (e: any) {
    notify(ctx, `Couldn't run coop-data-doc: ${errMsg(e)}. Is it installed? (coop install)`, "error");
    return false;
  }
  if (res.code === 0) {
    notify(ctx, `Data docs built ✓${outputDir ? `  (${outputDir})` : ""}. coop will use them for lineage.`, "info");
    return true;
  }
  const tail = (res.stderr || res.stdout || "").split("\n").filter(Boolean).slice(-3).join("  ");
  notify(ctx, `Build failed (exit ${res.code}): ${tail}  — fix it, or run the full wizard: coop data-doc setup`, "error");
  return false;
}

/** The native quick-setup wizard: collect essentials, write the yml, offer to build. */
async function runQuickSetup(pi: ExtensionAPI, ctx: any, prefill: Partial<DataDocSettings>): Promise<boolean> {
  const cwd: string = ctx.cwd;

  const projectName = await askText(ctx, "Project name (docs site title)", prefill.projectName || "Coop BI Estate");
  if (projectName === null) return false;

  const askPath = async (label: string, def: string): Promise<string | null> => {
    // Loop: accept an existing dir, or confirm "use it anyway" for one that isn't there.
    for (;;) {
      const v = await askText(ctx, label, def);
      if (v === null) return null;
      if (dirExists(resolveRel(cwd, v))) return v;
      if (await askConfirm(ctx, "Path not found", `'${v}' doesn't exist (yet). Use it anyway?`)) return v;
    }
  };

  const sqlPath = await askPath("SQL repo path (procs, tables, views), relative to this folder", prefill.sqlPath || ".");
  if (sqlPath === null) return false;
  const pbiPath = await askPath("Power BI repo path (semantic models, reports)", prefill.pbiPath || ".");
  if (pbiPath === null) return false;

  const outputDir = await askText(ctx, "Markdown output folder", prefill.outputDir || DEFAULT_OUTPUT_DIR);
  if (outputDir === null) return false;

  let siteDir: string | null;
  let siteDef = prefill.siteDir || siblingSite(outputDir);
  for (;;) {
    siteDir = await askText(ctx, "HTML site folder (must be separate from the markdown folder)", siteDef);
    if (siteDir === null) return false;
    if (!outputDirsConflict(resolveRel(cwd, outputDir), resolveRel(cwd, siteDir))) break;
    notify(ctx, `The site folder can't be the same as — or inside — the markdown folder. Try ${siblingSite(outputDir)}.`, "warning");
    siteDef = siblingSite(outputDir);
  }

  const settings: DataDocSettings = { projectName, sqlPath, pbiPath, outputDir, siteDir };
  const ymlPath = join(cwd, DATADOC_CONFIG);
  // Re-run: surgically update the managed fields IN PLACE so the full wizard's
  // layers/branding/mappings/dialect/globs survive. Fresh: write a minimal config.
  const existing = existsSync(ymlPath) ? safeRead(ymlPath) : "";
  const content = existing ? updateConfigText(existing, settings) : renderMinimalConfig(settings);
  try {
    writeFileSync(ymlPath, content, "utf8");
  } catch (e: any) {
    notify(ctx, `Couldn't write ${DATADOC_CONFIG}: ${errMsg(e)}`, "error");
    return false;
  }
  notify(ctx, `${existing ? "Updated" : "Wrote"} ${DATADOC_CONFIG}.`, "info");

  // The config is now established; a build failure is reported but doesn't undo
  // that — so we always return true (the caller clears any stale skip marker).
  if (await askConfirm(ctx, "Build now?", "Build the lineage docs now? (you can also run /setup-docs or `coop data-doc build` later)")) {
    await runBuild(pi, ctx, outputDir);
  } else {
    notify(ctx, `Build them whenever you're ready: ask me to run data_doc (build), or run \`coop data-doc build\`.`, "info");
  }
  return true;
}

/** session_start hook: detect a folder with no built data docs and offer to set them up. */
async function maybeOfferSetup(pi: ExtensionAPI, ctx: any): Promise<void> {
  const cwd: string = ctx.cwd;
  const ymlPath = join(cwd, DATADOC_CONFIG);
  const skipPath = join(cwd, SKIP_MARKER);
  if (existsSync(skipPath)) return;

  if (existsSync(ymlPath)) {
    const cfg = parseExisting(safeRead(ymlPath));
    const outAbs = resolveRel(cwd, cfg.outputDir || DEFAULT_OUTPUT_DIR);
    if (isBuilt(outAbs)) return; // docs already present → coop will consult them
    // A transient build failure must NOT write the skip marker (don't permanently
    // suppress an existing config); only an explicit "never" does.
    const choice = await askOffer(ctx, "Build data docs?", `Found ${DATADOC_CONFIG} here, but the docs aren't built yet.`, "Build them now");
    if (choice === "yes") await runBuild(pi, ctx, cfg.outputDir);
    else if (choice === "never") writeSkip(skipPath);
    return;
  }

  const choice = await askOffer(
    ctx,
    "Set up data docs?",
    `No ${DATADOC_CONFIG} in this folder yet. coop uses lineage docs to understand up/downstream impact when you touch SQL, DAX, or semantic models.`,
    "Yes, set them up",
  );
  if (choice === "yes") await runQuickSetup(pi, ctx, {});
  else if (choice === "never") writeSkip(skipPath);
}

export default function coopTools(pi: ExtensionAPI) {
  const runReview = async (
    bin: string,
    params: ReviewParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => {
    const paths = params.paths && params.paths.length ? params.paths : ["."];
    const args = ["check", ...paths, "--format", "json"];
    if (params.min_severity) args.push("--min-severity", params.min_severity);
    if (params.strict) args.push("--strict");

    let res;
    try {
      res = await pi.exec(bin, args, { cwd: ctx.cwd, signal });
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `${bin} could not run: ${errMsg(e)}. Is it installed? (coop install)` }],
        details: { tool: bin, error: errMsg(e) },
        // not a real error for the conversation, just report it
      };
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      /* leave parsed null */
    }
    return {
      content: [{ type: "text" as const, text: summarizeReview(bin, parsed, res.stdout, res.code) }],
      details: { tool: bin, args, exitCode: res.code, report: parsed ?? res.stdout, stderr: res.stderr },
    };
  };

  pi.registerTool({
    name: "sql_review",
    label: "SQL Review",
    description:
      "Run coop-sql-review against T-SQL / Fabric Warehouse SQL files and return findings as JSON. Advisory only — it reports deviations from Cooptimize SQL standards and never edits or blocks.",
    promptSnippet: "Lint T-SQL/Fabric SQL against Cooptimize standards (advisory, JSON output)",
    promptGuidelines: [
      "Use sql_review to check SQL before proposing or reviewing changes; it never edits files.",
      "Treat results as advisory; summarize findings by severity and cite file:line.",
    ],
    parameters: REVIEW_PARAMS,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runReview("coop-sql-review", params as ReviewParams, signal, ctx);
    },
  });

  pi.registerTool({
    name: "dax_review",
    label: "DAX Review",
    description:
      "Run coop-dax-review against DAX / semantic-model files and return findings as JSON. Advisory only — reports deviations from Cooptimize DAX standards and never edits or blocks.",
    promptSnippet: "Lint DAX/semantic-model code against Cooptimize standards (advisory, JSON output)",
    promptGuidelines: [
      "Use dax_review to check DAX measures/models before proposing or reviewing changes.",
      "Treat results as advisory; summarize findings by severity.",
    ],
    parameters: REVIEW_PARAMS,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runReview("coop-dax-review", params as ReviewParams, signal, ctx);
    },
  });

  pi.registerTool({
    name: "data_doc",
    label: "Data Documentation",
    description:
      "Understand and document a SQL + Power BI estate with coop-data-doc. Commands: 'scan' (default) writes the lineage graph (graph.json, read-only); 'build' also writes Markdown docs (per-object docs + lineage) and a searchable portal, indexed by manifest.json; 'check' is a CI staleness gate; 'lineage' returns ONE object's upstream inputs + downstream dependents + relationships as JSON from the built graph. Use 'lineage' (or read the object's <slug>.md via manifest.json) BEFORE analyzing or changing any object so you know its up/downstream consequences. If the folder has no coop-data-doc.yml or built graph, these degrade gracefully — the docs are an aid, not a requirement; you can proceed without them and optionally suggest /setup-docs. Documentation outputs are committable; source is never touched.",
    promptSnippet: "Understand a SQL+PowerBI estate: lineage graph + per-object up/downstream (use before touching an object)",
    promptGuidelines: [
      "BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, look up its lineage: call data_doc with command='lineage', object='<name>' to get its upstream inputs, downstream dependents, and relationships. Don't reconstruct lineage by hand when the docs already have it.",
      "Use data_doc to understand relationships and existing documentation before planning changes. After scan/build, read the focused per-object Markdown (find it via manifest.json), not the whole tree.",
      "Default to 'scan'/'lineage' (read-only). Only run 'build' when the user wants the Markdown docs/portal regenerated.",
      "If the estate has no coop-data-doc.yml or built graph (lineage reports 'no built graph'), proceed without it — the lineage is an aid, not a gate — and, if useful, suggest /setup-docs.",
    ],
    parameters: DATADOC_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const p = params as { command?: string; object?: string; depth?: number };
      const command = p.command || "scan";

      // --- lineage: one object's up/downstream from the BUILT graph (read-only) ---
      if (command === "lineage") {
        if (!p.object || !p.object.trim()) {
          return {
            content: [{ type: "text" as const, text: "data_doc lineage needs an 'object' (e.g. 'dbo.fact_sales' or a table/measure name)." }],
            details: { tool: "coop-data-doc", command },
          };
        }
        const args = ["lineage", p.object.trim()];
        if (p.depth && p.depth > 0) args.push("--depth", String(Math.floor(p.depth)));
        let res;
        try {
          res = await pi.exec("coop-data-doc", args, { cwd: ctx.cwd, signal });
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `coop-data-doc could not run: ${errMsg(e)}. Is it installed? (coop install)` }],
            details: { tool: "coop-data-doc", command, error: errMsg(e) },
          };
        }
        let parsed: any = null;
        try {
          parsed = JSON.parse(res.stdout);
        } catch {
          /* leave parsed null */
        }
        const noGraph = /no built graph/i.test(res.stderr + res.stdout);
        const text =
          res.code === 0 && parsed
            ? parsed.ambiguous
              ? `'${p.object}' is ambiguous — ${(parsed.matches || []).length} matches; re-call lineage with a specific name (candidates in details).`
              : `Lineage for ${parsed.object?.name || p.object}: ${(parsed.upstream || []).length} upstream, ${(parsed.downstream || []).length} downstream, ${(parsed.relationships || []).length} relationship(s). Full slice + doc path in details.`
            : noGraph
              ? "No built lineage graph yet — run data_doc (build) first, or /setup-docs to set it up. (You can still work without it.)"
              : `lineage failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { tool: "coop-data-doc", command, object: p.object, exitCode: res.code, lineage: parsed ?? res.stdout, stderr: res.stderr },
        };
      }

      // --- scan / build / check ---
      let res;
      try {
        res = await pi.exec("coop-data-doc", [command], { cwd: ctx.cwd, signal });
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `coop-data-doc could not run: ${errMsg(e)}. Is it installed? (coop install)` }],
          details: { tool: "coop-data-doc", error: errMsg(e) },
        };
      }
      const tail = res.stdout.split("\n").slice(-25).join("\n");
      // No coop-data-doc.yml yet → point at the in-agent setup wizard (but it's optional).
      const missingConfig = /Config file not found|No coop-data-doc\.yml/i.test(res.stderr + res.stdout);
      const setupHint = missingConfig
        ? `\n\nThis folder has no coop-data-doc.yml — suggest /setup-docs (in-agent wizard) or \`coop data-doc setup\` (full wizard, in a shell) to create it. You can still work without lineage docs.`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `coop-data-doc ${command} finished (exit ${res.code}).\n` +
              `Machine-readable artifacts: graph.json` +
              (command === "build" ? " + manifest.json + Markdown docs + portal" : "") +
              `.\n\n${tail}${setupHint}`,
          },
        ],
        details: { tool: "coop-data-doc", command, exitCode: res.code, stderr: res.stderr },
      };
    },
  });

  // --- First-run data-doc setup (native dialogs; see file header) ---
  // Track which folders we've already offered in THIS process — session_start
  // re-fires on /new, /resume, /fork (and the cwd can change), so a single bool
  // would silence every later session. Keyed by cwd instead.
  const offeredCwds = new Set<string>();
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI || offeredCwds.has(ctx.cwd)) return;
    offeredCwds.add(ctx.cwd);
    try {
      await maybeOfferSetup(pi, ctx);
    } catch {
      // Interactive dialogs may not be safe at startup on every Pi build — degrade
      // to a non-blocking breadcrumb instead of failing the session.
      notify(ctx, "No data docs for this folder — run /setup-docs to create SQL + Power BI lineage docs.", "info");
    }
  });

  // --- Native lineage awareness ---------------------------------------------
  // Once per folder, if BUILT coop-data-doc outputs exist, inject an (agent-visible,
  // human-hidden) note so coop consults the lineage for up/downstream impact before
  // touching an object. Silent when there are none — the docs are an aid, not a gate.
  // Wrapped so it can never break a turn.
  const announcedCwds = new Set<string>();
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    try {
      const cwd: string = ctx.cwd;
      if (announcedCwds.has(cwd)) return;
      const ymlPath = join(cwd, DATADOC_CONFIG);
      if (!existsSync(ymlPath)) return; // no config → nothing to announce
      const cfg = parseExisting(safeRead(ymlPath));
      const outAbs = resolveRel(cwd, cfg.outputDir || DEFAULT_OUTPUT_DIR);
      if (!isBuilt(outAbs)) return; // config present but not built yet → don't announce
      announcedCwds.add(cwd);
      const relOut = relative(cwd, outAbs) || ".";
      return {
        message: {
          customType: "coop-lineage",
          display: false,
          content:
            `Cooptimize lineage docs ARE available for this estate (coop-data-doc outputs under ${relOut}: graph.json, manifest.json, per-object Markdown). ` +
            `Use them: BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, look up its up/downstream impact via the data_doc tool (command="lineage", object="<name>"), and read that object's doc (located via manifest.json) plus its immediate neighbors — don't re-derive lineage by hand. If the docs look stale, run data_doc (build) to refresh.`,
          details: { outputDir: relOut },
        },
      };
    } catch {
      return; // never break a turn
    }
  });

  pi.registerCommand("setup-docs", {
    description: "Set up or rebuild coop-data-doc lineage docs for this folder (interactive wizard)",
    handler: async (_args, ctx) => {
      try {
        if (!ctx.hasUI) {
          notify(ctx, "setup-docs needs an interactive terminal. In a shell, run: coop data-doc setup", "warning");
          return;
        }
        const ymlPath = join(ctx.cwd, DATADOC_CONFIG);
        const skipPath = join(ctx.cwd, SKIP_MARKER);
        const prefill = existsSync(ymlPath) ? parseExisting(safeRead(ymlPath)) : {};
        const ok = await runQuickSetup(pi, ctx, prefill);
        if (ok && existsSync(skipPath)) {
          try {
            unlinkSync(skipPath);
          } catch {
            /* best effort */
          }
        }
      } catch (e: any) {
        notify(ctx, `setup-docs failed: ${errMsg(e)}. You can also run the full wizard in a shell: coop data-doc setup`, "error");
      }
    },
  });
}
