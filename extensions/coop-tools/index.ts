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
 * It ALSO bridges coop-data-doc's single authoritative setup questionnaire over
 * strict JSONL so users can establish lineage docs without leaving the agent. Pi
 * dialogs render the native wizard's prompt events and return its answers when the
 * user deliberately runs /setup-docs or chooses the data-doc action from /start.
 *
 * Older coop-data-doc versions stop with upgrade guidance; there is no reduced
 * local fallback questionnaire.
 *
 * Project configuration is likewise available without leaving Coop: /setup-project
 * creates or edits .coop/project.yml, and /start exposes the same native-dialog
 * wizard alongside common tasks. Normal startup goes straight to the prompt.
 * Everything here is feature-detected and try/catch-wrapped so it can never crash pi.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

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

interface DataDocSetupPrefill extends Partial<DataDocSettings> {
  sourceMode?: "both" | "sql" | "powerbi" | "none";
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
export function parseExisting(text: string): DataDocSetupPrefill {
  const out: DataDocSetupPrefill = {};
  const lines = text.split("\n");
  for (const { i, key } of classifyManagedLines(text)) {
    const v = scalarValue(lines[i].slice(lines[i].indexOf(":") + 1));
    if (key === "project_name") out.projectName = v;
    else if (key === "sql_path") out.sqlPath = v;
    else if (key === "powerbi_path") out.pbiPath = v;
    else if (key === "output_dir") out.outputDir = v;
    else if (key === "output_site_dir") out.siteDir = v;
  }
  out.sourceMode = out.sqlPath && out.pbiPath ? "both" : out.sqlPath ? "sql" : out.pbiPath ? "powerbi" : "none";
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

/* --- Project-contract scoping (.coop/project.yml → review paths) -------------
 * The contract's `repositories.*.local_path` answers "which paths matter"; when
 * the model calls sql_review/dax_review without explicit paths, scope the review
 * to those repos instead of blind-scanning the cwd (coop-sql-review's own docs
 * warn against bare full-tree `check` runs). Explicit paths always win. */

/** Nearest .coop/project.yml walking up from cwd (mirror of the wrapper's
 *  coop_find_project_yml, WITHOUT its bundled-template fallback — the bundled
 *  template is all TODO placeholders and must never scope a review). */
export function findProjectYml(cwd: string): string | null {
  let dir = resolve(cwd || ".");
  for (;;) {
    const cand = join(dir, ".coop", "project.yml");
    if (existsSync(cand)) return cand;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Pull `repositories.<name>.local_path` values out of a project.yml (block-style,
 *  best-effort — same spirit as classifyManagedLines). TODO/blank placeholders are
 *  returned in `todo` so the caller can note-and-skip rather than scan them. */
export function contractRepoPaths(text: string): { paths: string[]; todo: string[] } {
  const lines = text.split("\n");
  const paths: string[] = [];
  const todo: string[] = [];
  let inRepos = false;
  let repoIndent: number | null = null;
  let repo: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inRepos = body === "repositories:";
      repoIndent = null;
      repo = null;
      continue;
    }
    if (!inRepos) continue;
    if (repoIndent === null) repoIndent = indent; // first nested key sets the repo level
    if (indent === repoIndent) {
      repo = body.endsWith(":") ? body.slice(0, -1).trim() : null;
      continue;
    }
    if (indent > repoIndent && repo && body.startsWith("local_path:")) {
      const v = scalarValue(body.slice(body.indexOf(":") + 1));
      if (!v || /^TODO\b/i.test(v)) todo.push(repo);
      else paths.push(v);
    }
  }
  return { paths, todo };
}

export interface ContractScope {
  /** Absolute, existing repo paths declared by the contract (empty = no usable contract). */
  paths: string[];
  /** Repo names whose local_path is still a TODO placeholder (skipped, noted). */
  skippedTodo: string[];
  /** Declared local_paths that don't exist on this machine (skipped, noted). */
  skippedMissing: string[];
  /** The contract file that was read, or null when none was found. */
  contract: string | null;
}

/** Resolve the contract's declared repo paths against the contract's own repo root
 *  (the dir containing .coop/), keeping only paths that exist on this machine. */
export function contractReviewScope(cwd: string): ContractScope {
  const empty: ContractScope = { paths: [], skippedTodo: [], skippedMissing: [], contract: null };
  try {
    const file = findProjectYml(cwd);
    if (!file) return empty;
    const text = safeRead(file);
    if (!text) return { ...empty, contract: file };
    const { paths, todo } = contractRepoPaths(text);
    const base = resolve(file, "..", "..");
    const ok: string[] = [];
    const missing: string[] = [];
    for (const p of paths) {
      const abs = isAbsolute(p) ? p : resolve(base, p);
      if (existsSync(abs)) ok.push(abs);
      else missing.push(p);
    }
    return { paths: ok, skippedTodo: todo, skippedMissing: missing, contract: file };
  } catch {
    return empty; // scoping is an aid — never let it break a review call
  }
}

export interface TeConfig {
  enabled: boolean;
  exe: string;
  rules: string;
  models: string[];
}

export function contractTeConfig(text: string): TeConfig {
  const lines = text.split("\n");
  let exe = "", rules = "";
  let enabled = false;
  const models: string[] = [];
  
  let inTe = false;
  let inPbi = false;
  let inSm = false;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 2 && body.startsWith("tabular_editor_cli:")) { inTe = true; continue; }
    if (indent <= 2 && inTe && !body.startsWith("tabular_editor_cli:")) inTe = false;

    if (inTe) {
      if (body.startsWith("enabled:")) enabled = scalarValue(body.slice(body.indexOf(":") + 1)) === "true";
      if (body.startsWith("executable_path:")) exe = scalarValue(body.slice(body.indexOf(":") + 1));
      if (body.startsWith("bpa_rules_path:")) rules = scalarValue(body.slice(body.indexOf(":") + 1));
    }

    if (indent === 0 && body.startsWith("power_bi:")) { inPbi = true; continue; }
    if (indent === 0 && inPbi && !body.startsWith("power_bi:")) inPbi = false;

    if (inPbi && indent === 2 && body.startsWith("semantic_models:")) { inSm = true; continue; }
    if (inPbi && indent <= 2 && inSm && !body.startsWith("semantic_models:")) inSm = false;

    if (inSm && (body.startsWith("path:") || body.startsWith("- path:"))) {
      const v = scalarValue(body.substring(body.indexOf("path:") + 5));
      if (v && !/^TODO/i.test(v)) models.push(v);
    }
  }
  return { enabled, exe, rules, models };
}

function parseBpaOutput(stdout: string): any {
  const findings = [];
  const summary = { error: 0, warning: 0, info: 0 };
  
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^(.*?):\s*\[(.*?)\]\s*\((\w+)\)(?:\s+(.*))?$/);
    if (m) {
      const [, object, rule, sevRaw, message] = m;
      let severity = sevRaw.toLowerCase();
      if (!["error", "warning", "info"].includes(severity)) severity = "info";
      findings.push({
        rule: rule.trim(),
        severity,
        file: "", 
        object: object.trim(),
        message: (message || "").trim()
      });
      (summary as any)[severity]++;
    }
  }
  return { findings, summary };
}

/** Render a minimal, valid coop-data-doc.yml. Scalars/arrays JSON-encoded (valid YAML). */
export function renderMinimalConfig(s: DataDocSettings): string {
  const j = (v: unknown) => JSON.stringify(v);
  return `# coop-data-doc configuration — generated by coop /setup-docs.
# Point the tool at your repos, then run \`coop-data-doc build\`.
# All relative paths resolve against the folder containing THIS file.
# Re-run the same authoritative wizard with /setup-docs or \`coop data-doc setup\`.

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

# The authoritative setup wizard configures these; empty = defaults.
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
  notify(ctx, `Build failed (exit ${res.code}): ${tail}  — fix it, or re-run setup: coop data-doc setup`, "error");
  return false;
}

// --- JSONL wizard bridge ---------------------------------------------------
// When the installed coop-data-doc ships `setup --transport jsonl`, drive the
// REAL wizard from inside the agent: spawn it, forward each prompt through Pi's
// native dialogs, and stream the answers back. There is no duplicate wizard
// logic here — the terminal and in-agent flows share the one definition in
// coop-data-doc. Older versions stop with actionable upgrade guidance; there is
// deliberately no second, reduced questionnaire.

interface JsonlChoice {
  label: string;
  value: string;
  checked?: boolean;
}
interface JsonlPrompt {
  type: "prompt";
  id: string;
  kind: "text" | "path" | "confirm" | "select" | "checkbox";
  message: string;
  default?: unknown;
  choices?: JsonlChoice[];
}
type JsonlEvent =
  | JsonlPrompt
  | { type: "hello"; protocol_version?: string }
  | { type: "notice" | "progress" | "complete" | "error" | "cancelled"; id?: string; message?: string; data?: unknown };

export class JsonlLineDecoder {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  constructor(private readonly maxLine = 1024 * 1024) {}
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.buffer.length > this.maxLine && !this.buffer.includes("\n")) throw new Error("JSONL line exceeds 1 MiB");
    const out: string[] = [];
    for (;;) {
      const i = this.buffer.indexOf("\n");
      if (i < 0) break;
      let line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > this.maxLine) throw new Error("JSONL line exceeds 1 MiB");
      out.push(line);
    }
    return out;
  }
  finish(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.length) throw new Error("JSONL stream ended with a partial line");
  }
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}

function nearestExistingDirectory(cwd: string, value: string): string {
  let current = resolve(cwd, expandHomePath(value || "."));
  while (!isDirectory(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
  return current;
}

function childDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(path, entry.name))))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch { return []; }
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel || ".";
}

/** Browse real folders with Pi's fuzzy selector. Typing filters the discovered
 *  children, Enter opens one, and the returned path is relative to the config
 *  folder where possible. Manual paste remains available as an escape hatch. */
export async function renderPathPrompt(ctx: any, p: JsonlPrompt): Promise<string | null> {
  const def = typeof p.default === "string" ? p.default : "";
  if (typeof ctx.ui?.select !== "function") {
    if (typeof ctx.ui?.input !== "function") return null;
    const raw = await ctx.ui.input(`${p.message}  ·  Enter = ${def || "(blank)"}`, def);
    if (raw === null || raw === undefined) return null;
    return String(raw).trim() || def;
  }

  const cwd = typeof ctx.cwd === "string" && ctx.cwd ? resolve(ctx.cwd) : process.cwd();
  const defaultAbs = resolve(cwd, expandHomePath(def || "."));
  const defaultExists = isDirectory(defaultAbs);
  let current = nearestExistingDirectory(cwd, def);
  const MANUAL = "⌨ Type or paste a path…";

  for (;;) {
    const options: Array<{ label: string; path?: string; answer?: string }> = [];
    if (def && !defaultExists) options.push({ label: `↩ Keep suggested path (not found): ${def}`, answer: def });
    options.push({ label: `✓ Use this folder: ${displayPath(current, cwd)}`, path: current });
    const parent = dirname(current);
    if (parent !== current) options.push({ label: `↑ Parent: ${displayPath(parent, cwd)}`, path: parent });
    for (const name of childDirectories(current)) {
      const path = join(current, name);
      options.push({ label: `📁 ${name}`, path });
    }
    options.push({ label: MANUAL });

    const picked = await ctx.ui.select(`${p.message}  ·  Type to filter folders; Enter opens`, options.map((o) => o.label));
    if (picked === null || picked === undefined) return null;
    const selected = options.find((o) => o.label === picked);
    if (!selected) continue;
    if (selected.answer !== undefined) return selected.answer;
    if (selected.label === MANUAL) {
      if (typeof ctx.ui?.input !== "function") continue;
      const raw = await ctx.ui.input(p.message, def);
      if (raw === null || raw === undefined) return null;
      return String(raw).trim() || def;
    }
    if (selected.label.startsWith("✓ ") && selected.path) {
      if (isAbsolute(def)) return selected.path;
      return relative(cwd, selected.path) || ".";
    }
    if (selected.path) current = selected.path;
  }
}

/** Feature-detect `setup --transport jsonl` (cached per process). */
let jsonlSupported: boolean | null = null;
async function supportsJsonlTransport(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  if (jsonlSupported !== null) return jsonlSupported;
  try {
    const res = await pi.exec("coop-data-doc", ["setup", "--help"], { cwd: ctx.cwd, signal: ctx.signal });
    jsonlSupported = /--transport/.test(`${res.stdout}\n${res.stderr}`);
  } catch {
    jsonlSupported = false;
  }
  return jsonlSupported;
}

/** Render one wizard prompt via Pi's native dialogs; return the answer (any JSON
 *  value) or null when the user cancelled (Esc). Exported for tests. */
export async function renderPrompt(ctx: any, p: JsonlPrompt): Promise<unknown> {
  if (p.kind === "confirm") {
    if (typeof ctx.ui?.confirm !== "function") return null;
    return await ctx.ui.confirm("coop-data-doc setup", p.message);
  }
  if (p.kind === "select") {
    if (typeof ctx.ui?.select !== "function") return null;
    const choices = [...(p.choices || [])];
    if (typeof p.default === "string") {
      choices.sort((a, b) => Number(b.value === p.default) - Number(a.value === p.default));
    }
    const labels = choices.map((c) => c.label);
    const picked = await ctx.ui.select(p.message, labels);
    if (picked === null || picked === undefined) return null;
    const match = choices.find((c) => c.label === picked);
    return match ? match.value : picked;
  }
  if (p.kind === "checkbox") {
    if (typeof ctx.ui?.select !== "function") return null;
    return await askCheckbox(ctx, p);
  }
  if (p.kind === "path") return await renderPathPrompt(ctx, p);
  // text
  if (typeof ctx.ui?.input !== "function") return null;
  const def = typeof p.default === "string" ? p.default : "";
  const raw = await ctx.ui.input(`${p.message}  ·  Enter = ${def || "(blank)"}`, def);
  if (raw === null || raw === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const v = String(raw).replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return v || def;
}

/** Pi has no native multi-select: render a checkbox toggle loop over the wizard's
 *  authoritative choices. Returns the selected values, or null on cancel.
 *  Exported for tests. */
export async function askCheckbox(ctx: any, p: JsonlPrompt): Promise<string[] | null> {
  const choices = p.choices || [];
  if (!choices.length) return [];
  const selected = new Set(choices.filter((c) => c.checked).map((c) => c.value));
  const DONE = "✓ Done";
  const labelOf = (c: JsonlChoice): string => (selected.has(c.value) ? `☑ ${c.label}` : `☐ ${c.label}`);
  for (;;) {
    const options = [...choices.map(labelOf), DONE];
    const picked = await ctx.ui.select(p.message, options);
    if (picked === null || picked === undefined) return null; // Esc / cancel
    if (picked === DONE) return [...selected];
    const target = choices.find((c) => labelOf(c) === picked);
    if (target) {
      if (selected.has(target.value)) selected.delete(target.value);
      else selected.add(target.value);
    }
  }
}

export function resolveDataDocExecutable(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== "win32") return "coop-data-doc";
  const pathValue = env.PATH || env.Path || "";
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const exe = join(dir, "coop-data-doc.exe");
    if (existsSync(exe)) return exe;
  }
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, "coop-data-doc.cmd")) || existsSync(join(dir, "coop-data-doc.bat"))) {
      throw new Error("Found only an unsafe .cmd/.bat shim. Reinstall coop-data-doc with pipx so coop-data-doc.exe is on PATH.");
    }
  }
  throw new Error("coop-data-doc.exe was not found on PATH. Run `coop install`.");
}

/** Drive the authoritative JSONL wizard. Terminal event and exit code must agree. */
export async function runJsonlSetup(_pi: ExtensionAPI, ctx: any, prefill: DataDocSetupPrefill = {}): Promise<boolean> {
  let executable: string;
  try { executable = resolveDataDocExecutable(); }
  catch (e: any) { notify(ctx, errMsg(e), "error"); return false; }
  const child = spawn(executable, ["setup", "--transport", "jsonl"], { cwd: ctx.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stderrTail = "", terminal: "complete" | "cancelled" | "error" | null = null, protocolError = "";
  let helloSeen = false;
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
  child.stdin?.on("error", (e) => { protocolError ||= `wizard input closed: ${errMsg(e)}`; });
  const decoder = new JsonlLineDecoder();
  let chain = Promise.resolve();
  const send = async (payload: object): Promise<void> => {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("coop-data-doc closed before it accepted the wizard answer");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(JSON.stringify(payload) + "\n", (error) => error ? rejectWrite(error) : resolveWrite());
    });
  };
  const accept = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let evt: JsonlEvent;
    try { evt = JSON.parse(line); } catch { throw new Error("malformed JSONL from coop-data-doc"); }
    if (!evt || typeof evt !== "object" || !("type" in evt)) throw new Error("invalid JSONL event");
    if (evt.type === "hello") {
      // Handshake: required before the first prompt/terminal event; the wire
      // protocol is 1.x — a future major means the bridge must be upgraded.
      if (helloSeen) throw new Error("duplicate hello event");
      const v = typeof (evt as any).protocol_version === "string" ? (evt as any).protocol_version : "";
      if (!/^1\./.test(v)) throw new Error(`unsupported coop-data-doc protocol version '${v || "(none)"}' (bridge supports 1.x; requires coop-data-doc 1.1.1+)`);
      helloSeen = true;
      return;
    }
    if (evt.type === "prompt") {
      if (!helloSeen) throw new Error("missing hello handshake before first prompt (requires coop-data-doc 1.1.1+)");
      if (terminal) throw new Error("prompt received after terminal event");
      const prompt = { ...evt } as JsonlPrompt;
      if (prompt.id === "project_name" && prefill.projectName) prompt.default = prefill.projectName;
      if (prompt.id === "local_sources" && prefill.sourceMode) prompt.default = prefill.sourceMode;
      if (prompt.kind === "path" && /SQL repo path/i.test(prompt.message) && prefill.sqlPath) prompt.default = prefill.sqlPath;
      if (prompt.kind === "path" && /Power BI repo path/i.test(prompt.message) && prefill.pbiPath) prompt.default = prefill.pbiPath;
      const answer = await renderPrompt(ctx, prompt);
      if (answer === null) {
        await send({ id: evt.id, cancelled: true });
        return;
      }
      await send({ id: evt.id, answer });
    } else if (evt.type === "notice" || evt.type === "progress") {
      if (evt.message) notify(ctx, evt.message, "info");
    } else if (evt.type === "complete" || evt.type === "cancelled" || evt.type === "error") {
      if (!helloSeen) throw new Error(`missing hello handshake before ${evt.type} event (requires coop-data-doc 1.1.1+)`);
      if (terminal) throw new Error(`duplicate terminal event (${terminal}, ${evt.type})`);
      terminal = evt.type;
      if (evt.message) notify(ctx, evt.message, evt.type === "error" ? "error" : "info");
    } else throw new Error(`unknown JSONL event type: ${(evt as any).type}`);
  };
  child.stdout?.on("data", (chunk) => {
    try {
      for (const line of decoder.push(chunk)) chain = chain.then(() => accept(line));
      chain = chain.catch((e) => { protocolError = errMsg(e); try { child.kill(); } catch { /* best effort */ } });
    } catch (e: any) { protocolError = errMsg(e); try { child.kill(); } catch { /* best effort */ } }
  });
  const code = await new Promise<number | null>((resolveCode) => {
    child.once("error", (e) => { protocolError = `spawn failed: ${errMsg(e)}`; resolveCode(null); });
    child.once("close", resolveCode);
  });
  await chain;
  try { decoder.finish(); } catch (e: any) { protocolError ||= errMsg(e); }
  if (protocolError) { notify(ctx, `setup protocol failed: ${protocolError}`, "error"); return false; }
  if (code === 0 && terminal === "complete") return true;
  if (code === 130 && terminal === "cancelled") return false;
  if (code !== 0 && code !== 130 && terminal === "error") return false;
  const tail = stderrTail.trim() ? ` — ${stderrTail.trim().split("\n").slice(-2).join("  ")}` : "";
  notify(ctx, `setup protocol contradiction (exit ${code ?? "?"}, event ${terminal ?? "none"})${tail}`, "error");
  return false;
}

/** Use the project contract to prefill data-doc without making users type repo paths twice. */
export function dataDocPrefillFromProject(cwd: string): DataDocSetupPrefill {
  const contract = findProjectYml(cwd);
  if (!contract) return {};
  const text = safeRead(contract);
  const projectRoot = resolve(contract, "..", "..");
  let sqlPath = "", pbiPath = "";
  let sql = false, powerbi = false;
  const fromRoot = (raw: string): string => {
    const absolute = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
    // project.yml and coop-data-doc.yml are portable contracts, so keep their
    // relative paths stable when the same project is opened on Windows.
    return relative(cwd, absolute).replace(/\\/g, "/") || ".";
  };
  for (const name of repositoryNames(text)) {
    const role = projectYamlScalar(text, ["repositories", name, "role"]) || "generic";
    const raw = projectYamlScalar(text, ["repositories", name, "local_path"]);
    if (!raw || /^TODO\b/i.test(raw)) continue;
    if ((role === "sql" || role === "mixed") && !sqlPath) { sqlPath = fromRoot(raw); sql = true; }
    if ((role === "powerbi" || role === "mixed") && !pbiPath) { pbiPath = fromRoot(raw); powerbi = true; }
  }
  const sourceMode = sql && powerbi ? "both" : sql ? "sql" : powerbi ? "powerbi" : "none";
  return {
    sourceMode,
    ...(sqlPath ? { sqlPath } : {}),
    ...(pbiPath ? { pbiPath } : {}),
    projectName: projectYamlScalar(text, ["profile", "client"]),
  };
}

/** Run the one authoritative coop-data-doc wizard; no local fallback exists. */
async function runQuickSetup(pi: ExtensionAPI, ctx: any, prefill: DataDocSetupPrefill): Promise<boolean> {
  if (!(await supportsJsonlTransport(pi, ctx))) {
    notify(ctx, "Your coop-data-doc does not support the native JSONL setup wizard. Run `coop update` (requires coop-data-doc 1.1.1+), then retry /setup-docs.", "error");
    return false;
  }
  const ok = await runJsonlSetup(pi, ctx, { ...dataDocPrefillFromProject(ctx.cwd), ...prefill });
  if (ok) {
    if (await askConfirm(ctx, "Build now?", "Build the lineage docs now? (you can also run `coop data-doc build` later)")) await runBuild(pi, ctx);
    else notify(ctx, "Build them whenever you're ready with `coop data-doc build`.", "info");
  }
  return ok;
}

// --- Project contract wizard (.coop/project.yml) ----------------------------
// This is the in-Coop counterpart to `coop init`: newcomers discover it from the
// startup menu or /setup-project, and existing contracts can be safely edited
// without replacing fields the wizard does not own. The text patcher deliberately
// touches only scalar paths exposed below; comments, custom sections, policies,
// and future/unknown keys stay byte-for-byte intact.
export interface ProjectRepositorySettings {
  name: string;
  description: string;
  role: "sql" | "powerbi" | "mixed" | "generic";
  localPath: string;
  remoteName: string;
  defaultBranch: string;
  isNew?: boolean;
}

export interface ProjectWizardSettings {
  organization: string;
  client: string;
  timezone: string;
  defaultBranch: string;
  repositories: ProjectRepositorySettings[];
  fabricEnabled: boolean;
  tenantId: string;
  fabricWorkspaceName: string;
  fabricWorkspaceId: string;
  powerBiWorkspaceName: string;
  powerBiWorkspaceId: string;
  tabularEditorEnabled: boolean;
  tabularEditorPath: string;
  bpaRulesPath: string;
}

export type EstateMode = "discovery" | "partial" | "connected";

/** Derive the engagement's current local-source coverage from wizard repo roles. */
export function estateMode(repositories: ProjectRepositorySettings[]): EstateMode {
  if (!repositories.length) return "discovery";
  const roles = new Set(repositories.map((repo) => repo.role));
  return roles.has("mixed") || (roles.has("sql") && roles.has("powerbi")) ? "connected" : "partial";
}

function coverageFor(repositories: ProjectRepositorySettings[], role: "sql" | "powerbi"): string {
  if (repositories.some((repo) => repo.role === role || repo.role === "mixed")) return "available";
  return repositories.some((repo) => repo.role === "generic") ? "unknown" : "not_available_yet";
}

function yamlLineKey(raw: string): string | null {
  const body = raw.trim();
  if (!body || body.startsWith("#") || body.startsWith("-")) return null;
  const m = /^(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_.-]+))\s*:/.exec(body);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/''/g, "'");
  if (m[2] !== undefined) {
    try { return JSON.parse(`"${m[2]}"`); } catch { return m[2]; }
  }
  return m[3];
}

function yamlIndent(raw: string): number {
  return raw.length - raw.trimStart().length;
}

function yamlBlockEnd(lines: string[], line: number, indent: number): number {
  let i = line + 1;
  for (; i < lines.length; i++) {
    const body = lines[i].trim();
    if (!body || body.startsWith("#")) continue;
    if (yamlIndent(lines[i]) <= indent) break;
  }
  return i;
}

function findYamlKey(lines: string[], key: string, start: number, end: number, indent: number): number {
  for (let i = start; i < end; i++) {
    if (yamlIndent(lines[i]) === indent && yamlLineKey(lines[i]) === key) return i;
  }
  return -1;
}

/** Read a scalar at a simple mapping path. Exported for contract-wizard tests. */
export function projectYamlScalar(text: string, path: string[]): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const hit = findYamlKey(lines, path[depth], start, end, indent);
    if (hit < 0) return "";
    const body = lines[hit].trim();
    if (depth === path.length - 1) return scalarValue(body.slice(body.indexOf(":") + 1));
    start = hit + 1;
    end = yamlBlockEnd(lines, hit, indent);
    indent += 2;
  }
  return "";
}

function yamlQuoted(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : yamlQuoted(value);
}

/** Update or insert one scalar mapping path while preserving every unrelated line. */
export function upsertProjectYamlScalar(text: string, path: string[], value: string | boolean): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rendered = typeof value === "boolean" ? String(value) : yamlQuoted(value);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth];
    const hit = findYamlKey(lines, key, start, end, indent);
    if (hit >= 0) {
      if (depth === path.length - 1) {
        lines[hit] = `${" ".repeat(indent)}${yamlKey(key)}: ${rendered}`;
        return lines.join("\n");
      }
      // A scalar/flow value cannot contain child mappings; convert only this
      // parent line to a block mapping before inserting the wizard-owned child.
      const after = lines[hit].trim().slice(lines[hit].trim().indexOf(":") + 1).trim();
      if (after && !after.startsWith("#")) lines[hit] = `${" ".repeat(indent)}${yamlKey(key)}:`;
      start = hit + 1;
      end = yamlBlockEnd(lines, hit, indent);
      indent += 2;
      continue;
    }

    const addition: string[] = [];
    for (let j = depth; j < path.length; j++) {
      const pad = " ".repeat(indent + (j - depth) * 2);
      addition.push(j === path.length - 1
        ? `${pad}${yamlKey(path[j])}: ${rendered}`
        : `${pad}${yamlKey(path[j])}:`);
    }
    // Keep top-level sections visually separated, but never disturb the current
    // section's existing content when adding a nested value.
    if (depth === 0 && lines.length && lines[lines.length - 1].trim()) lines.push("");
    const at = depth === 0 ? lines.length : end;
    lines.splice(at, 0, ...addition);
    return lines.join("\n");
  }
  return lines.join("\n");
}

function repositoryNames(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const repos = findYamlKey(lines, "repositories", 0, lines.length, 0);
  if (repos < 0) return [];
  const end = yamlBlockEnd(lines, repos, 0);
  const names: string[] = [];
  for (let i = repos + 1; i < end; i++) {
    if (yamlIndent(lines[i]) !== 2) continue;
    const key = yamlLineKey(lines[i]);
    if (key) names.push(key);
  }
  return names;
}

function boolValue(value: string, fallback = false): boolean {
  if (/^(true|yes|1|on)$/i.test(value)) return true;
  if (/^(false|no|0|off)$/i.test(value)) return false;
  return fallback;
}

export interface DailyLogRequirement {
  contractPath: string;
  projectRoot: string;
  logPath: string;
  displayPath: string;
  date: string;
  timezone: string;
}

function dateInTimezone(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
    const year = value("year"), month = value("month"), day = value("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    /* invalid timezone: fall back to the workstation's local date */
  }
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Resolve today's required daily-log file from the nearest project contract. */
export function requiredDailyLog(cwd: string, now = new Date()): DailyLogRequirement | null {
  try {
    const contractPath = findProjectYml(cwd);
    if (!contractPath) return null;
    const text = safeRead(contractPath);
    if (!boolValue(projectYamlScalar(text, ["logging", "require_task_log"]), false)) return null;
    const projectRoot = resolve(contractPath, "..", "..");
    const timezone = projectYamlScalar(text, ["profile", "timezone"])
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || "UTC";
    const date = dateInTimezone(now, timezone);
    const template = projectYamlScalar(text, ["logging", "daily_log_path"])
      || "docs/agent/logs/daily/{yyyy-mm-dd}.md";
    const rendered = template
      .replace(/\{yyyy-mm-dd\}/gi, date)
      .replace(/YYYY-MM-DD/g, date);
    const logPath = isAbsolute(rendered) ? resolve(rendered) : resolve(projectRoot, rendered);
    const rel = relative(projectRoot, logPath);
    const displayPath = (!rel.startsWith("..") && !isAbsolute(rel) ? rel || basename(logPath) : logPath)
      .replace(/\\/g, "/");
    return { contractPath, projectRoot, logPath, displayPath, date, timezone };
  } catch {
    return null; // contract guidance must never break an agent turn
  }
}

/** Per-turn instruction injected when logging.require_task_log is enabled. */
export function dailyLogSystemInstruction(requirement: DailyLogRequirement): string {
  return [
    "Cooptimize required daily-log postcondition:",
    "The nearest .coop/project.yml sets logging.require_task_log: true.",
    "For meaningful project work in this turn—implementation or configuration changes, source/docs edits, reviews, validation, generated documentation, or decisions/open questions—the daily log is a NON-SKIPPABLE completion postcondition.",
    `Before your final response, explicitly use the daily-logger skill and append an accurate entry to ${requirement.displayPath} for ${requirement.date}, creating it if needed.`,
    "The contract flag is standing authorization for this log append, so do not ask again merely to update the log. Do not log ordinary read-only Q&A or status checks, and respect an explicit user request to skip logging for a particular task.",
    "Never put secrets in the log. Logging does not authorize git commit or push.",
  ].join(" ");
}

export type DailyLogToolEffect = "none" | "meaningful" | "log";

function samePath(a: string, b: string): boolean {
  const aa = resolve(a).replace(/\\/g, "/");
  const bb = resolve(b).replace(/\\/g, "/");
  return process.platform === "win32" ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

function shellMentionsPath(command: string, cwd: string, logPath: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  const absolute = resolve(logPath).replace(/\\/g, "/");
  const rel = relative(cwd, logPath).replace(/\\/g, "/");
  return normalized.includes(absolute) || (rel && normalized.includes(rel.replace(/^\.\//, "")));
}

/** Deliberate per-task escape hatch; avoid broad matches such as "didn't log". */
export function dailyLogOptOut(prompt: string): boolean {
  return /\b(?:do not|don't|dont)\s+(?:(?:write|update|append|create)\s+(?:to\s+)?(?:the\s+)?(?:daily\s+)?log|log\s+(?:this(?:\s+(?:task|work|one))?|the\s+task|anything))\b/i.test(prompt)
    || /\bskip\s+(?:the\s+)?(?:daily\s+)?(?:log|logging)\b/i.test(prompt)
    || /\b(?:no|without)\s+(?:a\s+|the\s+)?(?:daily\s+)?log\b/i.test(prompt);
}

/** Classify successful tool calls for the quiet end-of-task logging verifier. */
export function dailyLogToolEffect(toolName: string, input: Record<string, unknown>, cwd: string, logPath: string): DailyLogToolEffect {
  if (toolName === "edit" || toolName === "write") {
    const rawPath = typeof input.path === "string" ? input.path : "";
    if (!rawPath) return "none";
    const target = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    return samePath(target, logPath) ? "log" : "meaningful";
  }
  if (toolName === "sql_review" || toolName === "dax_review" || toolName === "bpa_review") return "meaningful";
  if (toolName === "data_doc") return input.command === "lineage" ? "none" : "meaningful";
  if (toolName === "bash" || toolName === "powershell") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return "none";
    const mayWrite = /(?:apply_patch|(?:^|[;&|]\s*)(?:sed\s+-i|perl\s+-pi|tee|touch|cp|mv)\b|(?:^|\s)(?:>|>>)(?:\s|$))/i;
    if (shellMentionsPath(command, cwd, logPath) && mayWrite.test(command)) return "log";
    const mutationOrValidation = /(?:apply_patch|(?:^|[;&|]\s*)(?:sed\s+-i|perl\s+-pi|tee|touch|mkdir|cp|mv)\b|(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bdotnet\s+test\b|\bbash\s+tests\/|\bscripts\/check[^\s]*|\bgit\s+(?:commit|push)\b|(?:^|\s)(?:>|>>)(?:\s|$))/i;
    return mutationOrValidation.test(command) ? "meaningful" : "none";
  }
  return "none";
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Parse the wizard-owned subset; unknown project fields are intentionally ignored. */
export function parseProjectWizardSettings(text: string, projectRoot: string): ProjectWizardSettings {
  const defaultBranch = projectYamlScalar(text, ["profile", "default_branch"]) || "main";
  const repositories = repositoryNames(text).map((name): ProjectRepositorySettings => ({
    name,
    description: projectYamlScalar(text, ["repositories", name, "description"]) || "Project source and docs",
    role: (projectYamlScalar(text, ["repositories", name, "role"]) as ProjectRepositorySettings["role"]) || "generic",
    localPath: projectYamlScalar(text, ["repositories", name, "local_path"]) || ".",
    remoteName: projectYamlScalar(text, ["repositories", name, "remote_name"]) || "origin",
    defaultBranch: projectYamlScalar(text, ["repositories", name, "default_branch"]) || defaultBranch,
  }));
  const fabricFlag = projectYamlScalar(text, ["tools", "fabric_cli", "enabled"]);
  const teFlag = projectYamlScalar(text, ["tools", "tabular_editor_cli", "enabled"]);
  return {
    organization: projectYamlScalar(text, ["profile", "organization"]) || "Cooptimize",
    client: projectYamlScalar(text, ["profile", "client"]),
    timezone: projectYamlScalar(text, ["profile", "timezone"]) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    defaultBranch,
    repositories: repositories.length || text.trim() ? repositories : [{
      name: basename(projectRoot) || "project",
      description: "Project source and docs",
      role: "generic",
      localPath: ".",
      remoteName: "origin",
      defaultBranch,
      isNew: true,
    }],
    fabricEnabled: boolValue(fabricFlag, Boolean(projectYamlScalar(text, ["fabric", "tenant_id"]))),
    tenantId: projectYamlScalar(text, ["fabric", "tenant_id"]),
    fabricWorkspaceName: projectYamlScalar(text, ["fabric", "default_workspace_name"]),
    fabricWorkspaceId: projectYamlScalar(text, ["fabric", "default_workspace_id"]),
    powerBiWorkspaceName: projectYamlScalar(text, ["power_bi", "default_workspace_name"]),
    powerBiWorkspaceId: projectYamlScalar(text, ["power_bi", "default_workspace_id"]),
    tabularEditorEnabled: boolValue(teFlag, false),
    tabularEditorPath: projectYamlScalar(text, ["tools", "tabular_editor_cli", "executable_path"]) || "te",
    bpaRulesPath: projectYamlScalar(text, ["tools", "tabular_editor_cli", "bpa_rules_path"]),
  };
}

function safeRepositoryBlock(repo: ProjectRepositorySettings): string[] {
  return [
    `  ${yamlKey(repo.name)}:`,
    `    description: ${yamlQuoted(repo.description)}`,
    `    role: ${yamlQuoted(repo.role)}`,
    `    local_path: ${yamlQuoted(repo.localPath)}`,
    `    remote_name: ${yamlQuoted(repo.remoteName)}`,
    `    default_branch: ${yamlQuoted(repo.defaultBranch)}`,
    "    agent_allowed_to_commit:",
    "      - 'docs/**'",
    "      - 'site/**'",
    "      - 'docs/agent/logs/**'",
    "      - 'docs/agent/diagrams/**'",
    "    agent_never_commit:",
    "      - '**/*.sql'",
    "      - '**/*.py'",
    "      - '**/*.ipynb'",
    "      - '**/*.pbip'",
    "      - '**/*.pbir'",
    "      - '**/*.bim'",
    "      - '**/*.tmdl'",
    "      - '**/*.dax'",
    "      - '**/*.rdl'",
    "      - '**/*.SemanticModel/**'",
    "      - '**/*.Report/**'",
  ];
}

function appendNewRepository(text: string, repo: ProjectRepositorySettings): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let repos = findYamlKey(lines, "repositories", 0, lines.length, 0);
  if (repos < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push("");
    lines.push("repositories:", ...safeRepositoryBlock(repo), "");
    return lines.join("\n");
  }
  const end = yamlBlockEnd(lines, repos, 0);
  lines.splice(end, 0, ...safeRepositoryBlock(repo));
  return lines.join("\n");
}

/** Apply wizard answers to an existing contract without replacing unknown fields. */
export function applyProjectWizardSettings(text: string, settings: ProjectWizardSettings): string {
  let out = text;
  const set = (path: string[], value: string | boolean) => { out = upsertProjectYamlScalar(out, path, value); };
  set(["profile", "organization"], settings.organization);
  set(["profile", "client"], settings.client);
  set(["profile", "timezone"], settings.timezone);
  set(["profile", "default_branch"], settings.defaultBranch);
  set(["profile", "work_mode"], "consultant_review_first");
  set(["estate", "mode"], estateMode(settings.repositories));
  set(["estate", "local_source_coverage", "sql"], coverageFor(settings.repositories, "sql"));
  set(["estate", "local_source_coverage", "power_bi"], coverageFor(settings.repositories, "powerbi"));
  set(["estate", "live_discovery", "dev_test_metadata"], "read_only_allowed");
  set(["estate", "live_discovery", "dev_test_rows"], "ask_first");
  set(["estate", "live_discovery", "production_metadata"], "ask_first");
  set(["estate", "live_discovery", "production_rows"], "explicit_scope_and_approval");
  for (const repo of settings.repositories) {
    if (repo.isNew && !repositoryNames(out).includes(repo.name)) out = appendNewRepository(out, repo);
    else {
      set(["repositories", repo.name, "description"], repo.description);
      set(["repositories", repo.name, "role"], repo.role);
      set(["repositories", repo.name, "local_path"], repo.localPath);
      set(["repositories", repo.name, "remote_name"], repo.remoteName);
      set(["repositories", repo.name, "default_branch"], repo.defaultBranch);
    }
  }
  set(["tools", "fabric_cli", "enabled"], settings.fabricEnabled);
  set(["tools", "fabric_cicd", "enabled"], settings.fabricEnabled);
  set(["mcp", "fabric", "enabled"], settings.fabricEnabled);
  set(["mcp", "powerbi", "enabled"], settings.fabricEnabled);
  if (settings.fabricEnabled) {
    set(["fabric", "tenant_id"], settings.tenantId);
    set(["fabric", "default_workspace_name"], settings.fabricWorkspaceName);
    set(["fabric", "default_workspace_id"], settings.fabricWorkspaceId);
    set(["power_bi", "default_workspace_name"], settings.powerBiWorkspaceName);
    set(["power_bi", "default_workspace_id"], settings.powerBiWorkspaceId);
  }
  set(["tools", "tabular_editor_cli", "enabled"], settings.tabularEditorEnabled);
  if (settings.tabularEditorEnabled) {
    set(["tools", "tabular_editor_cli", "executable_path"], settings.tabularEditorPath);
    set(["tools", "tabular_editor_cli", "bpa_rules_path"], settings.bpaRulesPath);
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Render a complete safe contract for first-time setup. */
export function renderProjectWizardSettings(settings: ProjectWizardSettings): string {
  const lines = [
    "# Cooptimize agent — project contract (.coop/project.yml)",
    "# Generated by Coop's in-app /setup-project wizard.",
    "",
    "profile:",
    `  organization: ${yamlQuoted(settings.organization)}`,
    `  client: ${yamlQuoted(settings.client)}`,
    `  timezone: ${yamlQuoted(settings.timezone)}`,
    `  default_branch: ${yamlQuoted(settings.defaultBranch)}`,
    "  work_mode: 'consultant_review_first'",
    "",
    "estate:",
    `  mode: ${yamlQuoted(estateMode(settings.repositories))}`,
    "  local_source_coverage:",
    `    sql: ${yamlQuoted(coverageFor(settings.repositories, "sql"))}`,
    `    power_bi: ${yamlQuoted(coverageFor(settings.repositories, "powerbi"))}`,
    "  live_discovery:",
    "    dev_test_metadata: 'read_only_allowed'",
    "    dev_test_rows: 'ask_first'",
    "    production_metadata: 'ask_first'",
    "    production_rows: 'explicit_scope_and_approval'",
    "",
    settings.repositories.length ? "repositories:" : "repositories: {}",
  ];
  for (const repo of settings.repositories) lines.push(...safeRepositoryBlock(repo));
  if (settings.fabricEnabled) lines.push(
    "",
    "fabric:",
    `  tenant_id: ${yamlQuoted(settings.tenantId)}`,
    `  default_workspace_name: ${yamlQuoted(settings.fabricWorkspaceName)}`,
    `  default_workspace_id: ${yamlQuoted(settings.fabricWorkspaceId)}`,
    "  lakehouse_names: []",
    "  warehouse_names: []",
    "  # Warehouse / Lakehouse workspace for each deployment environment.",
    "  environment_names:",
    "    dev: ''",
    "    test: ''",
    "    prod: ''",
    "",
    "power_bi:",
    `  default_workspace_name: ${yamlQuoted(settings.powerBiWorkspaceName)}`,
    `  default_workspace_id: ${yamlQuoted(settings.powerBiWorkspaceId)}`,
    "  # Semantic-model workspace for each deployment environment.",
    "  environment_names:",
    "    dev: ''",
    "    test: ''",
    "    prod: ''",
    "  semantic_models: []",
    "  reports: []",
  );
  lines.push(
    "",
    "tools:",
    "  fabric_cli:",
    "    command: 'fab'",
    `    enabled: ${settings.fabricEnabled}`,
    "    default_mode: 'read_only_first'",
    "  fabric_cicd:",
    "    library: 'fabric_cicd'",
    "    injected_into: 'ms-fabric-cli'",
    `    enabled: ${settings.fabricEnabled}`,
    "    default_mode: 'validate_only'",
    "  tabular_editor_cli:",
    `    enabled: ${settings.tabularEditorEnabled}`,
  );
  if (settings.tabularEditorEnabled) lines.push(
    `    executable_path: ${yamlQuoted(settings.tabularEditorPath)}`,
    `    bpa_rules_path: ${yamlQuoted(settings.bpaRulesPath)}`,
  );
  lines.push(
    "  coop_data_doc:",
    "    command: 'coop-data-doc'",
    "    enabled: true",
    "    default_command: 'build'",
    "    machine_outputs: ['graph.json', 'manifest.json']",
    "  coop_sql_review:",
    "    command: 'coop-sql-review'",
    "    enabled: true",
    "    invoke: 'check {paths} --format json'",
    "    advisory_only: true",
    "  coop_dax_review:",
    "    command: 'coop-dax-review'",
    "    enabled: true",
    "    invoke: 'check {paths} --format json'",
    "    advisory_only: true",
    "",
    "mcp:",
    "  fabric:",
    `    enabled: ${settings.fabricEnabled}`,
    "    allowed_default_actions: ['list', 'read', 'inspect']",
    "    requires_approval_actions: ['create', 'update', 'delete', 'deploy']",
    "  powerbi:",
    `    enabled: ${settings.fabricEnabled}`,
    "    readonly_flag: true",
    "    allowed_default_actions: ['list', 'read', 'inspect']",
    "    requires_approval_actions: ['create', 'update', 'delete', 'publish']",
    "  microsoft_learn:",
    "    enabled: true",
    "  context_mode:",
    "    enabled: true",
    "",
    "memory:",
    "  extension: 'pi-hermes-memory'",
    "  enabled: true",
    "  secret_scanning: true",
    "",
    "microsoft_skills:",
    "  source: 'https://github.com/microsoft/skills'",
    "  load_dir: 'skills/_microsoft'",
    "  allow:",
    "    - 'kql'",
    "    - 'microsoft-docs'",
    "",
    "fabric_skills:",
    "  source: 'https://github.com/microsoft/skills-for-fabric'",
    "  load_dir: 'skills/_microsoft_fabric'",
    "  allow: []",
    "",
    "standards:",
    "  sql: 'docs/standards/sql-standards.md'",
    "  dax: 'docs/standards/dax-standards.md'",
    "  documentation: 'docs/standards/documentation-standards.md'",
    "  fabric: 'docs/standards/fabric-standards.md'",
    "",
    "backup:",
    "  root: '.backups'",
    "  timestamp_format: '%Y%m%d_%H%M%S'",
    "  naming_pattern: '{original_name}.{timestamp}.bak'",
    "  required_before_edit: true",
    "",
    "logging:",
    "  daily_log_path: 'docs/agent/logs/daily/{yyyy-mm-dd}.md'",
    "  weekly_log_path: 'docs/agent/logs/weekly/{yyyy}-W{ww}.md'",
    "  require_task_log: true",
    "",
    "documentation:",
    "  agent_docs_root: 'docs/agent'",
    "  human_site_root: 'site'",
    "  glossary_path: 'docs/agent/glossary/index.md'",
    "  diagrams_path: 'docs/agent/diagrams'",
    "  source_of_truth: 'markdown_first_html_generated'",
    "  use_coop_data_doc: true",
    "",
    "workflow:",
    "  skill: 'coop-workflow'",
    "  steps:",
    "    - 'Read .coop/project.yml and the relevant standards'",
    "    - 'Identify upstream and downstream impact before edits'",
    "    - 'Write a short plan and get approval before editing'",
    "    - 'Create backups before changing source files'",
    "    - 'Make the smallest safe edit and run the applicable review'",
    "    - 'Show the diff, update documentation, and append to the work log'",
    "    - 'Commit docs/logs/site only with approval; never commit source'",
    "",
    "approval_policy:",
    "  always_allowed:",
    "    - 'read files'",
    "    - 'git status / git diff / git pull'",
    "    - 'create backups'",
    "    - 'run advisory Coop review and documentation tools'",
    "    - 'MCP dev/test metadata / schema / artifact-code list / read / inspect'",
    "    - 'update markdown docs, html site, logs'",
    "  ask_first:",
    "    - 'read actual rows from a live environment'",
    "    - 'read production metadata or artifact code'",
    "    - 'read production rows with target / columns / filters / limit'",
    "    - 'delete files'",
    "    - 'deploy or publish'",
    "    - 'change production workspace'",
    "    - 'commit documentation changes'",
    "  never_without_explicit_instruction:",
    "    - 'commit SQL/DAX/model/report source changes'",
    "    - 'push to remote'",
    "    - 'deploy to test/prod'",
    "    - 'MCP create/update/delete/deploy/publish'",
    "    - 'print secrets, tokens, connection strings, or .env contents'",
    "",
    "tests:",
    "  live_data:",
    "    enabled: false",
    "    between_slices: true",
    "    command: ''",
    "    workspace: 'dev'",
    "    require_approval: true",
    "",
  );
  return lines.join("\n");
}

function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd || ".");
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function writeProjectContract(path: string, text: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.bak`;
    copyFileSync(path, backup);
    writeFileSync(path, text, "utf8");
  } else {
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  }
  return backup;
}

async function chooseRole(ctx: any, label: string, current: ProjectRepositorySettings["role"]): Promise<ProjectRepositorySettings["role"] | null> {
  if (typeof ctx.ui?.select !== "function") return null;
  const choices = [
    { label: "SQL / Warehouse", value: "sql" as const },
    { label: "Power BI / Semantic models", value: "powerbi" as const },
    { label: "SQL + Power BI / mixed", value: "mixed" as const },
    { label: "General project", value: "generic" as const },
  ];
  const ordered = [...choices.filter((c) => c.value === current), ...choices.filter((c) => c.value !== current)];
  const picked = await ctx.ui.select(label, ordered.map((c) => c.label));
  if (picked === null || picked === undefined) return null;
  return ordered.find((c) => c.label === picked)?.value || current;
}

async function editRepository(ctx: any, root: string, repo: ProjectRepositorySettings, askName: boolean): Promise<ProjectRepositorySettings | null> {
  let name = repo.name;
  if (askName) {
    const raw = await askText(ctx, "Repository short name", name);
    if (raw === null) return null;
    name = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || name;
  }
  const description = await askText(ctx, `${name}: description`, repo.description);
  if (description === null) return null;
  const role = await chooseRole(ctx, `${name}: what kind of repository is this?`, repo.role);
  if (role === null) return null;
  const localPath = await renderPathPrompt({ ...ctx, cwd: root }, {
    type: "prompt", id: `repo-${name}`, kind: "path", message: `${name}: choose its local folder`, default: repo.localPath,
  });
  if (localPath === null) return null;
  const remoteName = await askText(ctx, `${name}: Git remote name`, repo.remoteName);
  if (remoteName === null) return null;
  const defaultBranch = await askText(ctx, `${name}: default branch`, repo.defaultBranch);
  if (defaultBranch === null) return null;
  return { ...repo, name, description, role, localPath, remoteName, defaultBranch };
}

/** Native UI project setup/edit flow. Returns true only after a contract write. */
export async function runProjectWizard(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  if (!ctx.hasUI || typeof ctx.ui?.input !== "function" || typeof ctx.ui?.confirm !== "function") {
    notify(ctx, "Project setup needs an interactive Coop UI. In a shell, run: coop init", "warning");
    return false;
  }
  const existing = findProjectYml(ctx.cwd);
  const root = existing ? resolve(existing, "..", "..") : (findGitRoot(ctx.cwd) || resolve(ctx.cwd));
  const original = existing ? safeRead(existing) : "";
  const settings = parseProjectWizardSettings(original, root);
  const title = existing ? "Edit this Coop project" : "Set up this Coop project";
  notify(ctx, `${title}. Press Esc at any prompt to cancel without changing files.`, "info");

  const organization = await askText(ctx, "Organization", settings.organization);
  if (organization === null) return false;
  const client = await askText(ctx, "Client / engagement", settings.client);
  if (client === null) return false;
  const timezone = await askText(ctx, "Timezone", settings.timezone);
  if (timezone === null) return false;
  const defaultBranch = await askText(ctx, "Project default branch", settings.defaultBranch);
  if (defaultBranch === null) return false;
  settings.organization = organization;
  settings.client = client;
  settings.timezone = timezone;
  settings.defaultBranch = defaultBranch;

  if (!existing) {
    const hasLocalSource = await askConfirm(
      ctx,
      "Local source folders",
      "Do you have any local SQL, warehouse, Power BI, or project source folders to connect now? Choose No to start in discovery mode; you can add them later with /setup-project.",
    );
    if (!hasLocalSource) settings.repositories = [];
  }

  const editedRepos: ProjectRepositorySettings[] = [];
  for (const repo of settings.repositories) {
    const shouldEdit = repo.isNew || await askConfirm(ctx, `Repository: ${repo.name}`, `Edit ${repo.name}'s path, role, and branch?`);
    if (!shouldEdit) { editedRepos.push(repo); continue; }
    const edited = await editRepository(ctx, root, repo, Boolean(repo.isNew));
    if (!edited) return false;
    editedRepos.push(edited);
  }
  while (await askConfirm(ctx, "Repositories", "Add another repository to this project?")) {
    const seed: ProjectRepositorySettings = {
      name: `repo${editedRepos.length + 1}`,
      description: "Project source and docs",
      role: "generic",
      localPath: ".",
      remoteName: "origin",
      defaultBranch,
      isNew: true,
    };
    const added = await editRepository(ctx, root, seed, true);
    if (!added) return false;
    if (editedRepos.some((r) => r.name === added.name)) {
      notify(ctx, `A repository named ${added.name} already exists; choose a unique short name.`, "error");
      continue;
    }
    editedRepos.push(added);
  }
  settings.repositories = editedRepos;

  settings.fabricEnabled = await askConfirm(ctx, "Microsoft Fabric / Power BI", "Does this project use Microsoft Fabric or Power BI?");
  if (settings.fabricEnabled) {
    const tenant = await askText(ctx, "Azure tenant ID (optional)", settings.tenantId);
    if (tenant === null) return false;
    const fwName = await askText(ctx, "Default Fabric workspace name (optional)", settings.fabricWorkspaceName);
    if (fwName === null) return false;
    const fwId = await askText(ctx, "Default Fabric workspace ID (optional)", settings.fabricWorkspaceId);
    if (fwId === null) return false;
    const pbiName = await askText(ctx, "Default Power BI workspace name (optional)", settings.powerBiWorkspaceName || fwName);
    if (pbiName === null) return false;
    const pbiId = await askText(ctx, "Default Power BI workspace ID (optional)", settings.powerBiWorkspaceId);
    if (pbiId === null) return false;
    Object.assign(settings, { tenantId: tenant, fabricWorkspaceName: fwName, fabricWorkspaceId: fwId, powerBiWorkspaceName: pbiName, powerBiWorkspaceId: pbiId });
  }

  settings.tabularEditorEnabled = await askConfirm(ctx, "Tabular Editor", "Use the Tabular Editor CLI for semantic-model BPA reviews?");
  if (settings.tabularEditorEnabled) {
    const te = await askText(ctx, "Tabular Editor CLI command or path", settings.tabularEditorPath || "te");
    if (te === null) return false;
    const rules = await askText(ctx, "BPA rules file path (optional)", settings.bpaRulesPath);
    if (rules === null) return false;
    settings.tabularEditorPath = te;
    settings.bpaRulesPath = rules;
  }

  const mode = estateMode(settings.repositories);
  const repoSummary = settings.repositories.length
    ? settings.repositories.map((r) => `${r.name} (${r.role}: ${r.localPath})`).join("\n")
    : "No local source yet (discovery mode)";
  const confirmed = await askConfirm(ctx, title, `${existing ? "Update" : "Create"} .coop/project.yml for ${client || "this project"}?\n\nMode: ${mode}\n${repoSummary}`);
  if (!confirmed) { notify(ctx, "Project setup cancelled — no files changed.", "info"); return false; }
  const output = existing ? applyProjectWizardSettings(original, settings) : renderProjectWizardSettings(settings);
  const path = existing || join(root, ".coop", "project.yml");
  const backup = writeProjectContract(path, output);
  notify(ctx, `Project contract ${existing ? "updated" : "created"}: ${path}${backup ? ` (backup: ${backup})` : ""}`, "info");
  notify(ctx, "Run /new or restart Coop before governed work so the guardrails load the updated contract.", "info");

  if (!settings.repositories.length) {
    notify(ctx, "Discovery mode is ready. Coop can inspect dev/test metadata read-only; row data and production access still ask first.", "info");
  }
  return true;
}

// --- "Start Here" menu (on demand via /start) --------------------------------
// A guided menu of common Cooptimize tasks for people who want it. Normal Coop
// startup goes straight to the prompt; this menu opens only when the user runs
// /start. Everything is best-effort so it can never break a session.
const MENU_TITLE = "Welcome to coop 👋  What would you like to do?";
const MENU_HELP = 'Pick an option — or choose "I\'ll type it myself" to just start chatting.';
const TYPE_IT = "Something else — I'll type it myself";

const MODEL_LOGIN_COMMAND = "/login openai-codex";

/** Path used by the Pi process currently hosting this extension. */
export function modelLoginAuthPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured && configured.trim()) return join(configured, "auth.json");
  if (/^(1|true|yes|on)$/i.test(process.env.COOP_NO_ISOLATE || "")) {
    return join(homedir(), ".pi", "agent", "auth.json");
  }
  const coopAgent = process.env.COOP_AGENT_DIR;
  return join(coopAgent && coopAgent.trim() ? coopAgent : join(homedir(), ".coop", "agent"), "auth.json");
}

/** Only an explicit launcher handoff may replace the user's empty editor. */
export function shouldPrimeModelLogin(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.hasUI && ctx.mode === "tui" && /^(1|true|yes|on)$/i.test(process.env.COOP_PRIME_MODEL_LOGIN || "");
}

/**
 * Put Pi's real built-in login command in the editor. Pi does not execute slash
 * commands supplied as CLI arguments; those become model prompts instead. During
 * installer login-only mode, watch for Pi to persist credentials and then return
 * control to the installer so its final doctor check can run.
 */
function primeModelLogin(ctx: ExtensionContext): boolean {
  if (!shouldPrimeModelLogin(ctx)) return false;
  ctx.ui.setEditorText(MODEL_LOGIN_COMMAND);
  notify(ctx, "Final setup: press Enter to sign in with your Cooptimize OpenAI account.", "info");
  delete process.env.COOP_PRIME_MODEL_LOGIN;

  if (/^(1|true|yes|on)$/i.test(process.env.COOP_LOGIN_ONLY || "")) {
    const authPath = modelLoginAuthPath();
    let credentialSeenAt = 0;
    const timer = setInterval(() => {
      try {
        if (!existsSync(authPath) || statSync(authPath).size === 0) return;
        if (!credentialSeenAt) credentialSeenAt = Date.now();
        // Fresh login selects OpenAI's default model after credentials are saved.
        // Prefer that positive readiness signal; the timeout covers a preselected
        // model, where Pi intentionally keeps the existing choice after login.
        const modelReady = ctx.model?.provider === "openai-codex";
        if (!modelReady && Date.now() - credentialSeenAt < 3000) return;
        clearInterval(timer);
        notify(ctx, "Model sign-in complete. Finishing Coop setup…", "info");
        setTimeout(() => ctx.shutdown(), 250);
      } catch {
        // The auth file can be atomically replaced while Pi saves it; retry.
      }
    }, 300);
    timer.unref?.();
  }
  return true;
}

interface MenuItem {
  label: string;
  run: (pi: ExtensionAPI, ctx: any) => Promise<void>;
}

/** "Document my data" choice: set up (no config), build (not built yet), else explore. */
async function documentDataFlow(pi: ExtensionAPI, ctx: any): Promise<void> {
  const cwd: string = ctx.cwd;
  const ymlPath = join(cwd, DATADOC_CONFIG);
  if (!existsSync(ymlPath)) {
    await runQuickSetup(pi, ctx, {});
    return;
  }
  const cfg = parseExisting(safeRead(ymlPath));
  const outAbs = resolveRel(cwd, cfg.outputDir || DEFAULT_OUTPUT_DIR);
  if (!isBuilt(outAbs)) {
    await runBuild(pi, ctx, cfg.outputDir);
    return;
  }
  pi.sendUserMessage(
    "Give me a plain-language tour of my data estate from the lineage docs: the main data sources, the key tables and semantic models, and how they flow downstream. Flag anything that looks undocumented or risky. Use the data_doc tool.",
  );
}

/** The task menu — wired to tools/skills coop already ships. Each choice sends a
 *  friendly, first-person request AS the user (the menu just pre-writes the prompt
 *  a newcomer would otherwise have to compose); the agent then asks for specifics. */
export function buildStartMenu(): MenuItem[] {
  return [
    { label: "⚙️  Set up or edit this Coop project", run: runProjectWizard },
    { label: "📚  Document the data sources I have", run: documentDataFlow },
    {
      label: "🔎  Review SQL against our standards",
      run: async (pi) => {
        pi.sendUserMessage(
          "I'd like to review some T-SQL / Fabric Warehouse SQL against our Cooptimize standards. Ask me which file or folder to check, then run sql_review and summarize the findings by severity with file and line references.",
        );
      },
    },
    {
      label: "📊  Review DAX or a semantic model",
      run: async (pi) => {
        pi.sendUserMessage(
          "I'd like to review DAX / a semantic model against our Cooptimize standards. Ask me for the file or folder, then run dax_review and walk me through the findings by severity in plain language.",
        );
      },
    },
    {
      label: "🧭  Impact check — what breaks if I change something?",
      run: async (pi) => {
        pi.sendUserMessage(
          "Before I change something, I want to see its impact. Ask me which SQL object, table, measure, or semantic model I'm about to touch, then use the data_doc lineage to show me what's upstream and downstream and what could break.",
        );
      },
    },
    {
      label: "🏛️  Review a Fabric workspace or architecture",
      run: async (pi) => {
        pi.sendUserMessage(
          "Help me review a Microsoft Fabric workspace or data architecture against best practices. Ask me what to look at — a workspace, or the files in this folder — then walk me through what you find in plain language.",
        );
      },
    },
    {
      label: "📝  Write my work log (daily or weekly)",
      run: async (pi) => {
        pi.sendUserMessage(
          "Help me write my work log. Ask whether it's a daily or weekly entry, then help me capture what I worked on and turn it into a clean log entry.",
        );
      },
    },
  ];
}

/** Render the on-demand Start Here menu and dispatch the choice. */
async function showStartMenu(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (typeof ctx?.ui?.select !== "function") {
    notify(ctx, "This coop build has no menu UI here — just type what you'd like to do.", "info");
    return;
  }
  const items = buildStartMenu();
  const options = [...items.map((i) => i.label), TYPE_IT];
  const choice = await ctx.ui.select(`${MENU_TITLE}\n${MENU_HELP}`, options);
  if (!choice || choice === TYPE_IT) return; // Esc / dismiss / "type it myself" → normal blank prompt
  const item = items.find((i) => i.label === choice);
  if (item) await item.run(pi, ctx);
}

export default function coopTools(pi: ExtensionAPI) {
  const runReview = async (
    bin: string,
    params: ReviewParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => {
    // Scope: explicit model-supplied paths always win. Otherwise read the nearest
    // .coop/project.yml and review the contract's declared repos
    // (repositories.*.local_path) instead of blind-scanning the cwd; fall back to
    // ["."] only when there is no usable contract (absent, or all TODO/missing).
    let rawPaths: string[];
    let scope: string;
    let scopeNotes = "";
    if (params.paths && params.paths.length) {
      rawPaths = params.paths;
      scope = "explicit paths";
    } else {
      const c = contractReviewScope(ctx.cwd);
      const notes: string[] = [];
      if (c.skippedTodo.length) notes.push(`skipped TODO local_path: ${c.skippedTodo.join(", ")}`);
      if (c.skippedMissing.length) notes.push(`skipped missing local_path: ${c.skippedMissing.join(", ")}`);
      scopeNotes = notes.length ? ` (${notes.join("; ")})` : "";
      if (c.paths.length) {
        rawPaths = c.paths;
        scope = `project contract (${c.contract})`;
      } else {
        rawPaths = ["."];
        scope = "current directory";
      }
    }
    // Neutralize argument injection: a model-supplied path starting with "-" would be
    // read as a CLI flag by the review tool. Prefix "./" so it stays a positional path.
    const paths = rawPaths.map((p) => (String(p).startsWith("-") ? "./" + p : p));
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
    const scopeLine = `Scope: ${scope}${scopeNotes} — ${paths.join(", ")}`;
    return {
      content: [{ type: "text" as const, text: `${summarizeReview(bin, parsed, res.stdout, res.code)}\n${scopeLine}` }],
      details: { tool: bin, args, scope, scopeNotes, exitCode: res.code, report: parsed ?? res.stdout, stderr: res.stderr },
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
    name: "bpa_review",
    label: "Tabular Editor BPA",
    description:
      "Run Tabular Editor BPA against semantic-model files and return findings as JSON. Advisory only — reports deviations from Cooptimize BPA standards and never edits or blocks.",
    promptSnippet: "Lint Semantic Models against Cooptimize BPA standards (advisory, JSON output)",
    promptGuidelines: [
      "Use bpa_review to check semantic models before proposing or reviewing changes.",
      "Treat results as advisory; summarize findings by severity.",
    ],
    parameters: REVIEW_PARAMS,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const contract = findProjectYml(ctx.cwd);
      if (!contract) return { content: [{ type: "text" as const, text: "No .coop/project.yml found." }] };
      const cfg = contractTeConfig(safeRead(contract));
      if (!cfg.enabled) return { content: [{ type: "text" as const, text: "Tabular Editor CLI is not enabled in .coop/project.yml." }] };
      if (!cfg.exe || !cfg.rules) return { content: [{ type: "text" as const, text: "Tabular Editor executable_path or bpa_rules_path is missing in .coop/project.yml." }] };

      let models = cfg.models;
      const p = params as ReviewParams;
      if (p.paths && p.paths.length) models = p.paths;
      if (!models.length) return { content: [{ type: "text" as const, text: "No semantic models to review (none in project.yml power_bi.semantic_models or passed explicitly)." }] };

      const allFindings: any[] = [];
      const allSummary = { error: 0, warning: 0, info: 0 };
      let finalCode = 0;
      let allStdout = "";

      for (const model of models) {
        let absModel = isAbsolute(model) ? model : resolve(resolve(contract, "..", ".."), model);
        let absRules = isAbsolute(cfg.rules) ? cfg.rules : resolve(resolve(contract, "..", ".."), cfg.rules);
        const args = [absModel, "-A", absRules, "-V"];
        let res;
        try {
          res = await pi.exec(cfg.exe, args, { cwd: ctx.cwd, signal });
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Failed to run Tabular Editor: ${errMsg(e)}` }] };
        }
        allStdout += res.stdout + "\n";
        if (res.code !== 0) finalCode = res.code;
        const { findings, summary } = parseBpaOutput(res.stdout);
        allFindings.push(...findings);
        allSummary.error += summary.error;
        allSummary.warning += summary.warning;
        allSummary.info += summary.info;
      }

      const report = { findings: allFindings, summary: allSummary };
      const scopeLine = `Scope: ${models.join(", ")}`;
      return {
        content: [{ type: "text" as const, text: `${summarizeReview("bpa_review", report, allStdout, finalCode)}\n${scopeLine}` }],
        details: { tool: "bpa_review", args: ["..."], report, exitCode: finalCode, stdout: allStdout },
      };
    },
  });

  pi.registerTool({
    name: "data_doc",
    label: "Data Documentation",
    description:
      "Understand and document whatever SQL and/or Power BI source is currently available with coop-data-doc. Commands: 'scan' (default) writes the lineage graph (graph.json, read-only); 'build' also writes Markdown docs (per-object docs + lineage) and a searchable portal, indexed by manifest.json; 'check' is a CI staleness gate; 'lineage' returns ONE object's upstream inputs + downstream dependents + relationships as JSON from the built graph. Use 'lineage' (or read the object's <slug>.md via manifest.json) BEFORE analyzing or changing any object so you know its up/downstream consequences. No source, one side, partial folders, and both sides are valid stages. If the folder has no coop-data-doc.yml or built graph, these degrade gracefully — the docs are an aid, not a requirement; you can proceed without them and optionally suggest /setup-docs. Documentation outputs are committable; source is never touched.",
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
        // Options first, then `--` so a model-supplied object that starts with `-`
        // is treated as a positional name, not parsed as a coop-data-doc flag.
        const args = ["lineage"];
        if (p.depth && p.depth > 0) args.push("--depth", String(Math.floor(p.depth)));
        args.push("--", p.object.trim());
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
      const tail = String(res.stdout || "").split("\n").slice(-25).join("\n");
      // No coop-data-doc.yml yet → point at the in-agent setup wizard (but it's optional).
      const missingConfig = /Config file not found|No coop-data-doc\.yml/i.test(res.stderr + res.stdout);
      const setupHint = missingConfig
        ? `\n\nThis folder has no coop-data-doc.yml — suggest /setup-docs or \`coop data-doc setup\` (the same native wizard) to create it. You can still work without lineage docs.`
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

  // Normal sessions start at the prompt. The only automatic handoff is the model
  // provider login required when a fresh install has no credentials yet.
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    primeModelLogin(ctx);
  });

  // --- Native lineage awareness + required daily-log postcondition ----------
  // Once per folder, if BUILT coop-data-doc outputs exist, inject an (agent-visible,
  // human-hidden) note so coop consults the lineage for up/downstream impact before
  // touching an object. Every turn whose project contract requires a daily task log
  // also gets a system-prompt postcondition. Silent when neither applies; wrapped so
  // contract/logging guidance can never break a turn.
  const announcedCwds = new Set<string>();
  let dailyRun: {
    requirement: DailyLogRequirement;
    baselineMtime: number;
    meaningful: boolean;
    logTouched: boolean;
  } | null = null;
  const pendingDailyEffects = new Map<string, DailyLogToolEffect>();
  const missedLogAt = new Map<string, number>();

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    try {
      const cwd: string = ctx.cwd;
      pendingDailyEffects.clear();
      const requirement = requiredDailyLog(cwd);
      dailyRun = requirement && !dailyLogOptOut(event.prompt || "")
        ? { requirement, baselineMtime: fileMtime(requirement.logPath), meaningful: false, logTouched: false }
        : null;

      if (!requirement) {
        try { ctx.ui.setStatus("coop-daily-log", undefined); } catch { /* best effort */ }
      }

      if (requirement) {
        const warnedAt = missedLogAt.get(requirement.logPath);
        if (warnedAt && fileMtime(requirement.logPath) > warnedAt) {
          missedLogAt.delete(requirement.logPath);
          try { ctx.ui.setStatus("coop-daily-log", undefined); } catch { /* best effort */ }
        }
      }

      let message: any;
      if (!announcedCwds.has(cwd)) {
        const ymlPath = join(cwd, DATADOC_CONFIG);
        if (existsSync(ymlPath)) {
          const cfg = parseExisting(safeRead(ymlPath));
          const outAbs = resolveRel(cwd, cfg.outputDir || DEFAULT_OUTPUT_DIR);
          if (isBuilt(outAbs)) {
            announcedCwds.add(cwd);
            const relOut = relative(cwd, outAbs) || ".";
            message = {
              customType: "coop-lineage",
              display: false,
              content:
                `Cooptimize lineage docs ARE available for this estate (coop-data-doc outputs under ${relOut}: graph.json, manifest.json, per-object Markdown). ` +
                `Use them: BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, look up its up/downstream impact via the data_doc tool (command="lineage", object="<name>"), and read that object's doc (located via manifest.json) plus its immediate neighbors — don't re-derive lineage by hand. If the docs look stale, run data_doc (build) to refresh.`,
              details: { outputDir: relOut },
            };
          }
        }
      }

      if (!message && !requirement) return;
      return {
        ...(message ? { message } : {}),
        ...(requirement
          ? { systemPrompt: `${event.systemPrompt}\n\n${dailyLogSystemInstruction(requirement)}` }
          : {}),
      };
    } catch {
      return; // never break a turn
    }
  });

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    if (!dailyRun) return;
    const effect = dailyLogToolEffect(event.toolName, event.input || {}, ctx.cwd, dailyRun.requirement.logPath);
    if (effect !== "none") pendingDailyEffects.set(event.toolCallId, effect);
  });

  pi.on("tool_result", async (event: any) => {
    if (!dailyRun) return;
    const effect = pendingDailyEffects.get(event.toolCallId);
    pendingDailyEffects.delete(event.toolCallId);
    if (!effect || event.isError) return;
    if (effect === "log") dailyRun.logTouched = true;
    if (effect === "meaningful") dailyRun.meaningful = true;
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    try {
      if (!dailyRun) return;
      const run = dailyRun;
      dailyRun = null;
      pendingDailyEffects.clear();
      const logUpdated = run.logTouched || fileMtime(run.requirement.logPath) > run.baselineMtime;
      if (logUpdated) {
        missedLogAt.delete(run.requirement.logPath);
        try { ctx.ui.setStatus("coop-daily-log", undefined); } catch { /* best effort */ }
        return;
      }
      if (!run.meaningful) return;
      const warning = `Required daily log wasn't updated: ${run.requirement.displayPath}. Ask Coop to finish the log or run /daily-log.`;
      missedLogAt.set(run.requirement.logPath, Date.now());
      try { ctx.ui.setStatus("coop-daily-log", `daily log missing · ${run.requirement.date}`); } catch { /* best effort */ }
      notify(ctx, warning, "warning");
    } catch {
      /* a verifier warning must never break the session */
    }
  });

  pi.registerCommand("start", {
    description: 'Open the coop "Start Here" menu of common tasks',
    handler: async (_args, ctx) => {
      try {
        await showStartMenu(pi, ctx);
      } catch (e: any) {
        notify(ctx, `Couldn't open the menu: ${errMsg(e)}. Just type what you'd like to do.`, "error");
      }
    },
  });

  pi.registerCommand("setup-project", {
    description: "Set up or edit this folder's .coop/project.yml (interactive wizard)",
    handler: async (_args, ctx) => {
      try {
        await runProjectWizard(pi, ctx);
      } catch (e: any) {
        notify(ctx, `Project setup failed: ${errMsg(e)}. No source files were changed.`, "error");
      }
    },
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
        const prefill = existsSync(ymlPath) ? parseExisting(safeRead(ymlPath)) : {};
        await runQuickSetup(pi, ctx, prefill);
      } catch (e: any) {
        notify(ctx, `setup-docs failed: ${errMsg(e)}. You can run the same wizard in a shell: coop data-doc setup`, "error");
      }
    },
  });
}
