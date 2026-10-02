/**
 * coop-tools — native, LLM-callable Cooptimize tools for Pi.
 *
 * Registers read-only / advisory tools that shell out to the standalone Coop
 * CLIs and return machine-readable JSON the model can reason over:
 *
 *   data_doc    -> coop-data-doc <scan|build|check|lineage|impact> (lineage graph + manifest.json;
 *                                                                lineage = one object's up/downstream,
 *                                                                impact = what changed files feed)
 *   bpa_review  -> Tabular Editor BPA over semantic-model files  (advisory; never edits/blocks)
 *
 * These let the agent call the documentation/model-check tools directly instead
 * of asking the user to run them. They are advisory: they never modify source.
 * SQL and DAX standards are applied while coop writes (lib/standards.mjs feeds
 * the coop-standards wiki articles into every task); the former coop-sql-review /
 * coop-dax-review wrappers were retired (master plan ST1).
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
import { accessSync, constants, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStandardsContext,
  findProjectContract,
  provenanceText,
  sourceStatus,
} from "../../lib/standards.mjs";
import { agentDir as coopAgentDir, configPath as coopConfigPath, userProfilePath as coopUserProfilePath } from "../../lib/paths.mjs";
// The /setup-project contract writer and the /setup-docs wizard driver live in
// lib/ so the coop window's forms run the same code (master plan D1b2).
import {
  CANONICAL_UUID,
  PROJECT_MESSAGES,
  SQL_TARGET_DISCOVERED_KINDS,
  SQL_TARGET_KINDS,
  applyProjectWizardSettings,
  boolValue,
  canonicalProjectUuid,
  cleanAnswer,
  clientPlatform,
  estateMode,
  findGitRoot,
  isServerHost,
  parseProjectWizardSettings,
  projectSqlEndpointType,
  projectYamlScalar,
  proposedSqlTargetKind,
  renderProjectWizardSettings,
  repositoryShortName,
  saveUserProfileName,
  scalarValue,
  writeProjectContract,
} from "../../lib/project-contract.mjs";
import {
  DATADOC_CONFIG,
  DEFAULT_OUTPUT_DIR,
  dataDocPrefillFromProject,
  driveJsonlSetup,
  expandHomePath,
  findDataDocConfig,
  isHomeFolder,
  parseExisting,
  resolveDataDocExecutable,
  samePath,
} from "../../lib/data-doc-setup.mjs";
// Re-exported unchanged: the extension's tests and callers keep importing them from here.
export {
  SQL_TARGET_DISCOVERED_KINDS,
  SQL_TARGET_KINDS,
  applyProjectWizardSettings,
  clientPlatform,
  estateMode,
  parseProjectWizardSettings,
  projectYamlScalar,
  proposedSqlTargetKind,
  renderProjectWizardSettings,
  saveUserProfileName,
  scalarValue,
  sqlTargetsBlock,
  upsertProjectYamlScalar,
} from "../../lib/project-contract.mjs";
export {
  JsonlLineDecoder,
  classifyManagedLines,
  dataDocPrefillFromProject,
  findDataDocConfig,
  parseExisting,
  resolveDataDocExecutable,
} from "../../lib/data-doc-setup.mjs";

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
      [Type.Literal("scan"), Type.Literal("build"), Type.Literal("check"), Type.Literal("lineage"), Type.Literal("impact")],
      {
        description:
          "coop-data-doc subcommand. 'scan' (default) builds the lineage graph (read-only); 'build' also writes Markdown docs + portal; 'check' is a CI staleness gate; 'lineage' lists ONE object's upstream/downstream + relationships from the built graph — call it BEFORE touching that object; 'impact' lists every downstream object fed by changed source files — call it before presenting a change.",
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
  files: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "For command='impact': the changed SQL/DAX/model source files (relative to the current folder, absolute, or relative to a documented repo root).",
    }),
  ),
  against: Type.Optional(
    Type.String({
      description:
        "For command='impact': a git ref (e.g. 'main') whose committed graph.json is the baseline, to diff a rebuilt graph against it. Omit to use the current built graph with `files`.",
    }),
  ),
});

const SQL_IMPACT_PARAMS = Type.Object({
  object: Type.String({ description: "One SQL object: `schema.name` or `name` (dbo assumed); brackets allowed. Bound as a parameter, never spliced into SQL." }),
});

const FABRIC_SQL_QUERY_PARAMS = Type.Object({
  query: Type.String({ description: "One plain SELECT with a literal TOP bound. Sent to the helper over stdin, never argv." }),
  maximum_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Optional result cap at or below the query's TOP bound." })),
});

interface FabricSqlInvocation { bin: string; args: string[]; env?: Record<string, string> }

export function fabricSqlPythonResolverInvocation(
  root = process.env.COOP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  platform = process.platform,
): FabricSqlInvocation {
  // One resolver, lib/common.ps1's Get-CoopFabricPython, on every platform
  // (master plan S1: coop has no bash runtime). Windows PowerShell 5.1 on Windows,
  // PowerShell 7 (pwsh) on a macOS/Linux developer box.
  return {
    bin: platform === "win32" ? "powershell.exe" : "pwsh",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ". (Join-Path (Join-Path $env:COOP_ROOT 'lib') 'common.ps1'); $py = Get-CoopFabricPython; if (-not $py) { exit 65 }; [Console]::Out.WriteLine($py)"],
    env: { COOP_ROOT: root },
  };
}

export type SqlHelper = "sql_query.py" | "sql_impact.py";

export function fabricSqlHelperInvocation(
  python: string,
  root = process.env.COOP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  helper: SqlHelper = "sql_query.py",
): FabricSqlInvocation {
  return { bin: python, args: [join(root, "lib", helper)] };
}

async function resolveFabricSqlPython(signal: AbortSignal | undefined): Promise<{ python?: string; state?: string }> {
  if (signal?.aborted) return { state: "aborted" };
  const invocation = fabricSqlPythonResolverInvocation();
  return await new Promise((done) => {
    const child = spawn(invocation.bin, invocation.args, {
      stdio: ["ignore", "pipe", "ignore"], shell: false,
      env: { ...process.env, ...invocation.env },
    });
    let stdout = "", finished = false, stopState = "";
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { python?: string; state?: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer); clearTimeout(forceTimer); clearTimeout(reapTimer);
      signal?.removeEventListener("abort", onAbort);
      done(value);
    };
    const stop = (state: string) => {
      if (stopState) return;
      stopState = state;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 250);
      reapTimer = setTimeout(() => finish({ state }), 1_000);
    };
    const onAbort = () => stop("aborted");
    const timeoutTimer = setTimeout(() => stop("python_resolver_timeout"), 30_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (data: any) => {
      if (stopState) return;
      if (data.length > 4_096 - stdout.length) return stop("selected_python_unavailable");
      stdout += data.toString();
    });
    child.on("error", () => finish({ state: stopState || "selected_python_unavailable" }));
    child.on("close", (code: number | null) => {
      if (stopState) return finish({ state: stopState });
      if (code !== 0) return finish({ state: "selected_python_unavailable" });
      const python = stdout.replace(/\r?\n$/, "");
      if (!python || python !== python.trim() || /[\r\n]/.test(python) || !isAbsolute(python)) {
        return finish({ state: "selected_python_unavailable" });
      }
      try {
        if (!statSync(python).isFile()) throw new Error("not a file");
        if (process.platform !== "win32") accessSync(python, constants.X_OK);
      } catch {
        return finish({ state: "selected_python_unavailable" });
      }
      finish({ python });
    });
  });
}

async function runFabricSqlHelper(params: any, signal: AbortSignal | undefined, cwd: string, helper: SqlHelper = "sql_query.py"): Promise<any> {
  if (signal?.aborted) return { ok: false, state: "aborted" };
  const selected = await resolveFabricSqlPython(signal);
  if (!selected.python) return { ok: false, state: selected.state || "selected_python_unavailable" };
  if (signal?.aborted) return { ok: false, state: "aborted" };
  const invocation = fabricSqlHelperInvocation(selected.python, undefined, helper);
  return await new Promise((done) => {
    const child = spawn(invocation.bin, invocation.args, { cwd, stdio: ["pipe", "pipe", "ignore"], shell: false });
    let stdout = "", finished = false, stopState = "";
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: any) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        clearTimeout(reapTimer);
        signal?.removeEventListener("abort", onAbort);
        done(value);
      }
    };
    const stop = (state: string) => {
      if (stopState) return;
      stopState = state;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 250);
      reapTimer = setTimeout(() => finish({ ok: false, state }), 1_000);
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), 60_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (data: any) => {
      if (stopState) return;
      if (data.length > 2_000_000 - stdout.length) return stop("helper_output_invalid");
      stdout += data.toString();
    });
    child.on("error", () => finish({ ok: false, state: stopState || "helper_launch_failed" }));
    child.on("close", (code: number | null) => {
      if (stopState) return finish({ ok: false, state: stopState });
      try {
        const parsed = JSON.parse(stdout);
        finish(parsed && typeof parsed === "object" ? parsed : { ok: false, state: "helper_output_invalid" });
      } catch { finish({ ok: false, state: "helper_output_invalid" }); }
    });
    child.stdin?.on("error", () => { /* child exited before consuming input */ });
    child.stdin?.end(JSON.stringify(params));
  });
}

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
    `${sev.error} error, ${sev.warning} warning, ${sev.info} info (exit ${code}).`
  );
}

// --- Model-visible results ----------------------------------------------------
// Pi hands the model a tool's `content` text only; `details` reach the UI and the
// session log, never the model (pi-ai's provider adapters serialize toolResult
// content, not details). So the names, rows and findings the model must act on
// are rendered into the text, capped so one call cannot flood the context; the
// full structured payload stays in details for the human.
export const MODEL_TEXT_CAP = 12_000;

/** `head`, then as many `lines` as fit in `cap` characters; a last line says how
 *  many were left out and what to do about it. */
export function modelText(head: string, lines: string[], omittedHint: string, cap = MODEL_TEXT_CAP): string {
  let out = head;
  let shown = 0;
  for (const line of lines) {
    if (out.length + 1 + line.length > cap) break;
    out += `\n${line}`;
    shown++;
  }
  const left = lines.length - shown;
  return left > 0 ? `${out}\n… ${left} more line(s) not shown: ${omittedHint}` : out;
}

/** "name (type)" for a coop-data-doc node reference (or a bare id). */
function refLabel(ref: any): string {
  if (ref === null || typeof ref !== "object") return String(ref);
  const name = ref.name || ref.id || "?";
  return ref.type ? `${name} (${ref.type})` : String(name);
}

function evidenceText(evidence: any): string {
  return `Evidence confidence: ${evidence?.state || "unknown"}; states: ${(evidence?.states || ["unknown"]).join(", ")}. Empty results do not prove zero impact.`;
}

/** The model-facing text for one `coop-data-doc lineage` slice. */
export function lineageText(parsed: any, query: string): string {
  if (parsed?.ambiguous) {
    const matches: any[] = parsed.matches || [];
    return modelText(
      `'${query}' is ambiguous — ${matches.length} matches; re-call lineage with one of these names:`,
      matches.map((m) => `- ${refLabel(m)}`),
      "use a more specific name",
    );
  }
  const up: any[] = parsed?.upstream || [];
  const down: any[] = parsed?.downstream || [];
  const rels: any[] = parsed?.relationships || [];
  const head =
    `Observed lineage for ${refLabel(parsed?.object || query)}: ${up.length} upstream, ${down.length} downstream, ${rels.length} relationship(s). ` +
    evidenceText(parsed?.evidence) +
    (parsed?.object?.doc ? `\nDoc: ${parsed.object.doc}` : "");
  const lines: string[] = [];
  for (const [label, items] of [["Upstream", up], ["Downstream", down]] as const) {
    lines.push(items.length ? `${label}:` : `${label}: none observed`);
    for (const item of items) lines.push(`- ${refLabel(item)}`);
  }
  if (rels.length) {
    lines.push("Relationships:");
    for (const rel of rels) lines.push(`- ${typeof rel === "string" ? rel : JSON.stringify(rel)}`);
  }
  return modelText(head, lines, "read the object's doc page, or re-call with a smaller depth");
}

/** The model-facing text for `coop-data-doc impact --evidence --format json`. */
export function impactText(parsed: any, seededBy: string): string {
  const impacts: Record<string, string[]> = parsed?.impacts && typeof parsed.impacts === "object" ? parsed.impacts : {};
  const seeds = Object.keys(impacts);
  if (!seeds.length) {
    return (
      `No documented object matched ${seededBy}. The built graph records each object's source file relative to its repo root, ` +
      "so check the paths; a new object, or a graph built before these edits, needs data_doc (build) first. " +
      evidenceText(parsed?.evidence)
    );
  }
  const reached = new Set<string>();
  for (const seed of seeds) for (const d of impacts[seed] || []) reached.add(d);
  const lines: string[] = [];
  for (const seed of seeds) {
    const down = impacts[seed] || [];
    lines.push(down.length ? `- ${seed} feeds ${down.length}:` : `- ${seed}: no observed downstream`);
    for (const d of down) lines.push(`  - ${d}`);
  }
  return modelText(
    `Observed downstream impact of ${seededBy}: ${seeds.length} changed object(s) feed ${reached.size} downstream object(s). ${evidenceText(parsed?.evidence)}`,
    lines,
    "call data_doc lineage for the objects that matter most",
  );
}

/** The `--files` values for `coop-data-doc impact`: each path as given (POSIX
 *  separators) plus its form relative to every documented repo root it sits in,
 *  since the graph records source files relative to their repo root. */
export function impactFileArgs(files: string[], cwd: string, env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  const roots: string[] = [];
  const ymlPath = findDataDocConfig(cwd, env);
  if (ymlPath && existsSync(ymlPath)) {
    const cfg = parseExisting(safeRead(ymlPath));
    for (const repo of [cfg.sqlPath, cfg.pbiPath]) if (repo) roots.push(resolveRel(dirname(ymlPath), repo));
  }
  for (const file of files) {
    const given = file.trim();
    if (!given) continue;
    out.add(given.replace(/\\/g, "/").replace(/^\.\//, ""));
    const abs = resolveRel(cwd, given);
    for (const root of roots) {
      const rel = relative(root, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) out.add(rel.replace(/\\/g, "/"));
    }
  }
  return [...out];
}

/** The model-facing lines for sql_impact's three catalog sections. */
export function sqlImpactLines(details: any): string[] {
  const lines: string[] = [];
  for (const name of ["downstream", "upstream", "columns"]) {
    const part = details?.[name];
    const label = name[0].toUpperCase() + name.slice(1);
    if (!part || typeof part !== "object") continue;
    if (part.state !== "ok") {
      lines.push(`${label}: unavailable (${part.reason || "not reported"})`);
      continue;
    }
    lines.push(`${label} (${part.count}${part.truncated ? "+, capped" : ""}):`);
    for (const item of part.items || []) {
      if (name === "columns") {
        lines.push(`- ${item.name} ${item.type}${item.nullable ? " NULL" : " NOT NULL"}`);
        continue;
      }
      const qualified = [item.server, item.database, item.schema, item.name].filter(Boolean).join(".");
      const flags = item.resolved === false
        ? `, unresolved${item.mentioned_in_definition === false ? ", not named in the definition" : ""}`
        : "";
      lines.push(`- ${qualified} (${item.type || "unknown"}${flags})`);
    }
  }
  return lines;
}

/** The model-facing lines for fabric_sql_query: the column names, then one JSON array per row. */
export function sqlRowLines(details: any): string[] {
  const lines = [`Columns: ${JSON.stringify(details?.columns || [])}`];
  for (const row of details?.rows || []) lines.push(JSON.stringify(row));
  return lines;
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** The model-facing lines for bpa_review findings, errors first. */
export function bpaFindingLines(findings: any[], multipleModels: boolean): string[] {
  return [...findings]
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
    .map((f) => `- [${f.severity}] ${f.rule}: ${f.message} (${f.object}${multipleModels && f.file ? ` in ${basename(f.file)}` : ""})`);
}

// --- coop-data-doc setup wizard (JSONL bridge to the companion) ---------------
// coop never writes coop-data-doc.yml itself: `coop-data-doc setup --transport
// jsonl` owns the config (runJsonlSetup below). coop only READS the few scalars it
// needs (parseExisting) to prefill the wizard and to find the built docs. Keys and
// defaults mirror coop-data-doc/src/coop_data_doc/config.py; if that schema
// changes, mirror it here.
const NO_GRAPH_TEXT = "No built lineage graph yet — run data_doc (build) first, or /setup-docs to set it up. (You can still work without it.)";

interface DataDocSettings {
  projectName: string;
  sqlPath: string;
  pbiPath: string;
  outputDir: string;
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
  return cleanAnswer(raw) || def;
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

/** Markdown output dir holds built docs (mirrors what `coop-data-doc build` writes). */
function isBuilt(outAbs: string): boolean {
  return existsSync(join(outAbs, "manifest.json")) || existsSync(join(outAbs, "index.md"));
}

/** The output dir holding the built lineage graph (graph.json, what `data_doc
 *  lineage` reads) for the companion's config (environment, then this folder or
 *  a parent; output.dir resolves against the config's folder), or null. One
 *  detection for the session-start note and sql_impact's lineage hint. */
export function builtLineageDir(cwd: string, env: Record<string, string | undefined> = process.env): string | null {
  try {
    const ymlPath = findDataDocConfig(cwd, env);
    if (!ymlPath || !existsSync(ymlPath)) return null;
    const cfg = parseExisting(safeRead(ymlPath));
    const outAbs = resolveRel(dirname(ymlPath), cfg.outputDir || DEFAULT_OUTPUT_DIR);
    return existsSync(join(outAbs, "graph.json")) ? outAbs : null;
  } catch {
    return null;
  }
}

/* --- Project-contract scoping (.coop/project.yml → review paths) -------------
 * The contract's `repositories.*.local_path` answers "which paths matter"; when
 * the model calls bpa_review without explicit paths, scope the review to those
 * repos instead of blind-scanning the cwd. Explicit paths always win. */

/** Nearest .coop/project.yml walking up from cwd — lib/standards.mjs's
 *  findProjectContract, with no bundled-template fallback (the bundled template
 *  is all TODO placeholders and must never scope a review). */
export function findProjectYml(cwd: string): string | null {
  return findProjectContract(cwd);
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
  if (/^(null|~)$/i.test(rules)) rules = "";
  return { enabled, exe, rules, models };
}

function parseBpaOutput(stdout: string, legacy: boolean): any {
  const findings = [];
  const summary = { error: 0, warning: 0, info: 0 };

  if (!legacy) {
    const report = JSON.parse(stdout);
    if (!report || !Array.isArray(report.results) ||
        !Number.isInteger(report.violations) || report.violations !== report.results.length ||
        !Number.isInteger(report.ruleErrors) || report.ruleErrors < 0) {
      throw new Error("TE returned an invalid BPA JSON report.");
    }
    for (const result of report.results) {
      const severity = String(result?.severityLabel).toLowerCase();
      if (!result || typeof result.ruleId !== "string" || typeof result.ruleName !== "string" ||
          typeof result.objectName !== "string" || !["error", "warning", "info"].includes(severity)) {
        throw new Error("TE returned an invalid BPA finding.");
      }
      findings.push({ rule: result.ruleId, severity, file: "", object: result.objectName, message: result.ruleName });
      (summary as any)[severity]++;
    }
    return { findings, summary, ruleErrors: report.ruleErrors };
  }
  
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

/** `coop-data-doc build`'s error for a configured repo folder that doesn't exist. */
const MISSING_REPO_PATH = /Repo '([^']+)' path does not exist: (.+?)(?: \(configured in (.+)\))?\s*$/m;

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
  const missing = MISSING_REPO_PATH.exec(`${res.stderr || ""}\n${res.stdout || ""}`);
  if (missing && typeof ctx?.ui?.select === "function") {
    notify(ctx, `Build failed (exit ${res.code}): ${tail}`, "error");
    await offerMissingRepoFix(pi, ctx, missing[1], missing[2], missing[3] || join(ctx.cwd, DATADOC_CONFIG));
    return false;
  }
  notify(ctx, `Build failed (exit ${res.code}): ${tail}  — fix it, or re-run setup: coop data-doc setup`, "error");
  return false;
}

/** A build stopped on a missing repo folder: offer the two direct fixes (#102). */
async function offerMissingRepoFix(pi: ExtensionAPI, ctx: any, repo: string, path: string, configPath: string): Promise<void> {
  const RERUN = "Re-run setup (/setup-docs) and choose the right folder";
  const OPEN = `Open ${basename(configPath)} and fix the path`;
  const LATER = "Not now";
  const picked = await ctx.ui.select(`The ${repo} repo folder doesn't exist: ${path}. How do you want to fix it?`, [RERUN, OPEN, LATER]);
  if (picked === RERUN) await runSetupDocs(pi, ctx);
  else if (picked === OPEN) await editDataDocConfig(ctx, configPath);
  else notify(ctx, `When you're ready, run /setup-docs or fix the path in ${configPath}, then build with \`coop data-doc build\`.`, "info");
}

/** Open coop-data-doc.yml in Pi's editor (a text box in an RPC host) and save the edit. */
async function editDataDocConfig(ctx: any, configPath: string): Promise<void> {
  const before = safeRead(configPath);
  if (!before || typeof ctx?.ui?.editor !== "function") {
    notify(ctx, `Open ${configPath} in your editor, fix the repo path, then build with \`coop data-doc build\`.`, "info");
    return;
  }
  const edited = await ctx.ui.editor(`${configPath}: fix the repo path, then save`, before);
  if (edited === undefined || edited === null || String(edited) === before) {
    notify(ctx, `No changes saved to ${configPath}.`, "info");
    return;
  }
  try {
    const temp = `${configPath}.tmp-${process.pid}`;
    writeFileSync(temp, String(edited), "utf8");
    renameSync(temp, configPath);
  } catch (e: any) {
    notify(ctx, `Couldn't save ${configPath}: ${errMsg(e)}`, "error");
    return;
  }
  notify(ctx, `Saved ${configPath}. Build the docs with /start > Document the data sources I have, or \`coop data-doc build\`.`, "info");
}

/** /setup-docs and /start > Document never write coop-data-doc.yml into the home
 *  folder (the desktop shortcuts start coop there). Stop and say how to open coop
 *  in the project folder instead (#102). Returns true when it stopped. */
function stopInHomeFolder(ctx: any): boolean {
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
  if (!isHomeFolder(cwd)) return false;
  notify(ctx, [
    `coop didn't set up lineage docs: this session is open in your home folder (${resolve(cwd)}), and coop-data-doc.yml belongs in a project folder, so nothing was written.`,
    "Open coop in the project folder, then run /setup-docs (or /start > Document the data sources I have) again:",
    "- Terminal: cd \"<project folder>\", then run coop",
    "- coop chat window: click the folder name at the top of the window and choose the project folder",
  ].join("\n"), "warning");
  return true;
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

/** A sibling Git checkout under `folder` (the session folder itself excluded). */
function hasNearbyRepo(folder: string, cwd: string): boolean {
  return childDirectories(folder).some((name) => {
    const path = join(folder, name);
    return !samePath(path, cwd) && existsSync(join(path, ".git"));
  });
}

/** Browse real folders with Pi's fuzzy selector. Typing filters the discovered
 *  children, Enter opens one, and the returned path is relative to the config
 *  folder where possible. Manual paste remains available as an escape hatch.
 *  A suggested folder that doesn't exist (coop-data-doc's `../pbi-repo`
 *  placeholder) is never an answer and never preselects a folder (#102): Enter
 *  opens "Type or paste the folder path" until the user opens a folder. Browsing
 *  starts beside the suggestion only when a real repo sits there, otherwise in
 *  the session folder, never the home folder's parent. */
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
  const nearest = nearestExistingDirectory(cwd, def);
  let current = defaultExists || hasNearbyRepo(nearest, cwd) ? nearest : cwd;
  // Enter uses a folder only when it is the (existing) suggestion or one the user opened.
  let opened = defaultExists;
  const MANUAL = "⌨ Type or paste the folder path";

  for (;;) {
    const options: Array<{ label: string; path?: string }> = [];
    if (!opened) options.push({ label: MANUAL });
    options.push({ label: `✓ Use this folder: ${displayPath(current, cwd)}`, path: current });
    const parent = dirname(current);
    if (parent !== current) options.push({ label: `↑ Parent: ${displayPath(parent, cwd)}`, path: parent });
    for (const name of childDirectories(current)) {
      const path = join(current, name);
      options.push({ label: `📁 ${name}`, path });
    }
    if (opened) options.push({ label: MANUAL });

    const picked = await ctx.ui.select(`${p.message}  ·  Type to filter folders; Enter opens`, options.map((o) => o.label));
    if (picked === null || picked === undefined) return null;
    const selected = options.find((o) => o.label === picked);
    if (!selected) continue;
    if (selected.label === MANUAL) {
      if (typeof ctx.ui?.input !== "function") continue;
      const raw = await ctx.ui.input(p.message, defaultExists ? def : undefined);
      if (raw === null || raw === undefined) return null;
      const typed = String(raw).trim();
      if (typed) return typed;
      if (defaultExists) return def;
      continue; // nothing typed and no real suggestion: back to the folders
    }
    if (selected.label.startsWith("✓ ") && selected.path) {
      if (isAbsolute(def)) return selected.path;
      return relative(cwd, selected.path) || ".";
    }
    if (selected.path) { current = selected.path; opened = true; }
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
    // Pi's confirm has no default: its TUI lists Yes first (Enter = Yes) and coop
    // web shows Yes as the first button. Render the wizard's default first
    // instead, so "Use it anyway?" (default No) answers No on Enter (#102).
    // Esc answers No, as Pi's confirm does.
    if (typeof p.default === "boolean" && typeof ctx.ui?.select === "function") {
      const picked = await ctx.ui.select(p.message, p.default ? ["Yes", "No"] : ["No", "Yes"]);
      return picked === "Yes";
    }
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
  return cleanAnswer(raw) || def;
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

/** What a completed setup reported beyond success; filled in by runJsonlSetup. */
export interface JsonlSetupOutcome {
  /** The wizard's reason the saved config can't build yet, when it said so. */
  notRunnable?: string;
}

/** Drive the authoritative JSONL wizard (lib/data-doc-setup.mjs), one prompt
 *  per Pi dialog. Terminal event and exit code must agree. */
export async function runJsonlSetup(_pi: ExtensionAPI, ctx: any, prefill: DataDocSetupPrefill = {}, outcome: JsonlSetupOutcome = {}): Promise<boolean> {
  let executable: string;
  try { executable = resolveDataDocExecutable(); }
  catch (e: any) { notify(ctx, errMsg(e), "error"); return false; }
  const selectedConfig = findDataDocConfig(ctx.cwd);
  const configBase = selectedConfig ? dirname(selectedConfig) : ctx.cwd;
  return await driveJsonlSetup({
    executable,
    cwd: ctx.cwd,
    env: process.env,
    prefill,
    outcome,
    ask: (prompt: JsonlPrompt) => renderPrompt({ ...ctx, cwd: configBase }, prompt),
    notify: (message: string, level: "info" | "warning" | "error") => notify(ctx, message, level),
  });
}

/** Run the one authoritative coop-data-doc wizard; no local fallback exists. */
async function runQuickSetup(pi: ExtensionAPI, ctx: any, prefill: DataDocSetupPrefill): Promise<boolean> {
  if (!(await supportsJsonlTransport(pi, ctx))) {
    notify(ctx, "Your coop-data-doc does not support the native JSONL setup wizard. Run `coop update` (requires coop-data-doc 1.1.1+), then retry /setup-docs.", "error");
    return false;
  }
  const outcome: JsonlSetupOutcome = {};
  const ok = await runJsonlSetup(pi, ctx, { ...dataDocPrefillFromProject(dirname(findDataDocConfig(ctx.cwd) || join(ctx.cwd, DATADOC_CONFIG))), ...prefill }, outcome);
  if (ok && outcome.notRunnable !== undefined) {
    // A saved config that can't build is a warning, never an automatic build (#102).
    const reason = outcome.notRunnable || "the saved config doesn't validate";
    notify(ctx, `Not building yet: ${reason}. Run /setup-docs again and choose a folder that exists (or fix the path in ${DATADOC_CONFIG}), then build with \`coop data-doc build\`.`, "warning");
    return ok;
  }
  if (ok) {
    if (await askConfirm(ctx, "Build now?", "Build the lineage docs now? (you can also run `coop data-doc build` later)")) await runBuild(pi, ctx);
    else notify(ctx, "Build them whenever you're ready with `coop data-doc build`.", "info");
  }
  return ok;
}

/** /setup-docs: run (or re-run) the wizard for this folder, prefilled from its config. */
async function runSetupDocs(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  if (stopInHomeFolder(ctx)) return false;
  const ymlPath = findDataDocConfig(ctx.cwd) || join(ctx.cwd, DATADOC_CONFIG);
  const prefill = existsSync(ymlPath) ? parseExisting(safeRead(ymlPath)) : {};
  return await runQuickSetup(pi, ctx, prefill);
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
  sqlEndpointItemType?: string;
  sqlEndpointItemName?: string;
  sqlEndpointItemId?: string;
  sqlEndpointPropertiesId?: string;
  powerBiWorkspaceName: string;
  powerBiWorkspaceId: string;
  tabularEditorEnabled: boolean;
  tabularEditorPath: string;
  bpaRulesPath: string;
  /** sql_targets.dev (master plan SQ1): blank kind = no sql_targets block. */
  sqlTargetKind: string;
  sqlTargetServer: string;
  sqlTargetDatabase: string;
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
    `At the first point meaningful work must be logged, explicitly use the daily-logger skill and check whether ${requirement.displayPath} exists. If absent, create it from the daily-logger template with the first entry; if present, append without overwriting prior entries.`,
    "Do not check for or create the log at startup, and do not create it for ordinary read-only Q&A or status work.",
    "The contract flag is standing authorization for this log append, so do not ask again merely to update the log. Do not log ordinary read-only Q&A or status checks, and respect an explicit user request to skip logging for a particular task.",
    "Never put secrets in the log. Logging does not authorize git commit or push.",
  ].join(" ");
}

export type DailyLogToolEffect = "none" | "meaningful" | "log";

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
  if (toolName === "bpa_review") return "meaningful";
  if (toolName === "data_doc") return input.command === "lineage" || input.command === "impact" ? "none" : "meaningful";
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
    name = repositoryShortName(raw, name);
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

  // The one onboarding question the launch no longer asks (master plan FR1): the
  // name coop calls the user by. Asked only while the local profile is missing;
  // Enter on a blank answer skips it, and it is never written into project.yml.
  if (!existsSync(coopUserProfilePath())) {
    const name = await askText(ctx, "What should coop call you? (your local profile, not the project)", "");
    if (name === null) return false;
    if (name) {
      const saved = saveUserProfileName(name);
      if (saved) notify(ctx, `Saved your profile name (${saved}). Coop will use it from the next session.`, "info");
      else notify(ctx, PROJECT_MESSAGES.profileName, "warning");
    }
  }

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
      notify(ctx, PROJECT_MESSAGES.repoName(added.name), "error");
      continue;
    }
    editedRepos.push(added);
  }
  settings.repositories = editedRepos;

  // The install-time client platform only shapes the question; the answer (and
  // the contract it writes) decides per repository.
  const platform = clientPlatform();
  const platformHint = platform === "azure_sql"
    ? " This machine is set up as an Azure SQL client, so No is the usual answer."
    : platform === "both" || platform === "fabric"
      ? ` This machine is set up as a ${platform === "both" ? "Fabric and Azure SQL" : "Fabric"} client.`
      : "";
  settings.fabricEnabled = await askConfirm(ctx, "Microsoft Fabric / Power BI", `Does this project use Microsoft Fabric or Power BI?${platformHint}`);
  if (settings.fabricEnabled) {
    const tenant = await askText(ctx, "Azure tenant ID (optional)", settings.tenantId);
    if (tenant === null) return false;
    const fwName = await askText(ctx, "Default Fabric workspace name (optional)", settings.fabricWorkspaceName);
    if (fwName === null) return false;
    const fwId = await askText(ctx, "Default Fabric workspace ID (optional)", settings.fabricWorkspaceId);
    if (fwId === null) return false;
    const endpointType = await askText(ctx, "Default SQL endpoint item type: Warehouse or Lakehouse (optional)", settings.sqlEndpointItemType || "");
    if (endpointType === null) return false;
    if (endpointType && endpointType !== "Warehouse" && endpointType !== "Lakehouse") {
      notify(ctx, PROJECT_MESSAGES.endpointType, "error");
      return false;
    }
    const endpointName = await askText(ctx, "Default SQL endpoint item name (optional)", settings.sqlEndpointItemName || "");
    if (endpointName === null) return false;
    const endpointId = await askText(ctx, "Default SQL endpoint item ID (canonical UUID; optional)", settings.sqlEndpointItemId || "");
    if (endpointId === null) return false;
    const endpointPropertiesId = await askText(ctx, "Lakehouse sqlEndpointProperties.id (canonical UUID; required for Lakehouse)", settings.sqlEndpointPropertiesId || "");
    if (endpointPropertiesId === null) return false;
    if ([fwId, endpointId, endpointPropertiesId].some((id) => id && !CANONICAL_UUID.test(id))) {
      notify(ctx, PROJECT_MESSAGES.uuids, "error");
      return false;
    }
    if (endpointType === "Lakehouse" && !endpointPropertiesId) {
      notify(ctx, PROJECT_MESSAGES.lakehouseId, "error");
      return false;
    }
    const pbiName = await askText(ctx, "Default Power BI workspace name (optional)", settings.powerBiWorkspaceName || fwName);
    if (pbiName === null) return false;
    const pbiId = await askText(ctx, "Default Power BI workspace ID (optional)", settings.powerBiWorkspaceId);
    if (pbiId === null) return false;
    Object.assign(settings, {
      tenantId: tenant,
      fabricWorkspaceName: fwName,
      fabricWorkspaceId: fwId,
      sqlEndpointItemType: endpointType,
      sqlEndpointItemName: endpointName,
      sqlEndpointItemId: endpointId,
      sqlEndpointPropertiesId: endpointPropertiesId,
      powerBiWorkspaceName: pbiName,
      powerBiWorkspaceId: pbiId,
    });
  }

  // SQL connection target for the dev environment (sql_targets:, SQ1). Enter keeps
  // the proposal; blank means no sql_targets block (today's fabric:-only contract).
  const kindDefault = settings.sqlTargetKind || proposedSqlTargetKind(platform, settings.fabricEnabled);
  const kind = await askText(ctx, `Dev SQL target kind (${SQL_TARGET_KINDS.join(", ")}; blank = none)`, kindDefault);
  if (kind === null) return false;
  const kindValue = kind.trim().toLowerCase();
  if (kindValue && !(SQL_TARGET_KINDS as readonly string[]).includes(kindValue)) {
    notify(ctx, PROJECT_MESSAGES.targetKind, "error");
    return false;
  }
  settings.sqlTargetKind = kindValue;
  if (kindValue) {
    if (!SQL_TARGET_DISCOVERED_KINDS.has(kindValue)) {
      const server = await askText(ctx, "Dev SQL server host (for example contoso-dev.database.windows.net)", settings.sqlTargetServer);
      if (server === null) return false;
      if (!isServerHost(server)) {
        notify(ctx, PROJECT_MESSAGES.serverHost, "error");
        return false;
      }
      settings.sqlTargetServer = server.toLowerCase();
    }
    const database = await askText(ctx, "Dev database name", settings.sqlTargetDatabase || settings.sqlEndpointItemName || "");
    if (database === null) return false;
    settings.sqlTargetDatabase = database;
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

/** Path used by the Pi process currently hosting this extension (the one agent-dir
 *  chain in lib/paths.mjs: PI_CODING_AGENT_DIR, COOP_NO_ISOLATE, COOP_AGENT_DIR, default). */
export function modelLoginAuthPath(): string {
  return join(coopAgentDir(), "auth.json");
}

/**
 * True when auth.json holds at least one stored provider credential. Pi writes an
 * empty `{}` on startup, so a non-empty file is not proof of a login (#167).
 */
export function authHasCredential(authPath: string): boolean {
  try {
    if (!existsSync(authPath) || statSync(authPath).size === 0) return false;
    const data = JSON.parse(readFileSync(authPath, "utf8").replace(/^\uFEFF/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    return Object.values(data).some((v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0);
  } catch {
    return false;
  }
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
        if (!authHasCredential(authPath)) return;
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
  if (stopInHomeFolder(ctx)) return;
  const cwd: string = ctx.cwd;
  const ymlPath = findDataDocConfig(cwd) || join(cwd, DATADOC_CONFIG);
  if (!existsSync(ymlPath)) {
    await runQuickSetup(pi, ctx, {});
    return;
  }
  const cfg = parseExisting(safeRead(ymlPath));
  const outAbs = resolveRel(dirname(ymlPath), cfg.outputDir || DEFAULT_OUTPUT_DIR);
  if (!isBuilt(outAbs)) {
    await runBuild(pi, ctx, cfg.outputDir);
    return;
  }
  pi.sendUserMessage(
    "Give me a plain-language tour of my data estate from the lineage docs: the main data sources, the key tables and semantic models, and how they flow downstream. Flag anything that looks undocumented or risky. Use the data_doc tool.",
  );
}

/**
 * Return the team-knowledge note string if at least one configured knowledge repo clone exists,
 * or null otherwise.
 */
export function teamKnowledgeNote(coopDir?: string, homeDir?: string): string | null {
  // coopDir is the PARENT of .coop (the COOP_DIR meaning); the default is the
  // profile dir from lib/paths.mjs.
  const home = homeDir || process.env.HOME || homedir();
  const cfgPath = coopDir ? join(coopDir, ".coop", "config") : coopConfigPath();
  if (!existsSync(cfgPath)) return null;
  try {
    const raw = readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg?.knowledge?.enabled || !Array.isArray(cfg?.knowledge?.repos)) return null;
    const paths: string[] = [];
    for (const r of cfg.knowledge.repos) {
      if (!r || typeof r.local_path !== "string" || !r.local_path.trim()) continue;
      let p = r.local_path.trim();
      if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
        p = join(home, p.slice(1).replace(/^[/\\]/, ""));
      }
      if (existsSync(p)) {
        paths.push(p);
      }
    }
    if (paths.length === 0) return null;
    return `Team knowledge available at ${paths.join(", ")}; see the team-knowledge skill for design and change work (a simple read or status check needs no knowledge search)`;
  } catch {
    return null;
  }
}

/** Fabric target(s) the nearest project contract already pins. Returned as an
 *  agent-visible, human-hidden note so a simple read (one bounded SELECT, a
 *  table or workspace listing, a connection check) goes straight to the
 *  `fabric-sqlendpoint` tool with the contract ids instead of rediscovering
 *  them through team-knowledge searches, memory, skills, or Fabric catalog
 *  calls. Null when the contract has no usable Warehouse/Lakehouse target.
 *  The approval prompt before Warehouse SQL is unchanged — this only removes
 *  the detour, never the gate. */
export function fabricTargetNote(cwd: string): { contractPath: string; content: string } | null {
  try {
    const contractPath = findProjectYml(cwd);
    if (!contractPath) return null;
    const text = safeRead(contractPath);
    const workspaceId = canonicalProjectUuid(projectYamlScalar(text, ["fabric", "default_workspace_id"]));
    const itemType = projectSqlEndpointType(projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_type"]));
    const itemId = canonicalProjectUuid(projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_id"]));
    const endpointId = itemType === "Lakehouse"
      ? canonicalProjectUuid(projectYamlScalar(text, ["fabric", "default_sql_endpoint", "sqlEndpointProperties", "id"]))
      : itemId;
    if (!workspaceId || !itemType || !itemId || !endpointId) return null;
    const itemName = projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_name"]) || itemType;
    const workspaceName = projectYamlScalar(text, ["fabric", "default_workspace_name"]);
    let environment = "";
    for (const env of ["dev", "test", "prod"]) {
      const name = projectYamlScalar(text, ["fabric", "environment_names", env]);
      if (name && workspaceName && name === workspaceName) { environment = env; break; }
    }
    const rel = relative(cwd, contractPath).replace(/\\/g, "/") || contractPath;
    const workspaceLabel = workspaceName ? `"${workspaceName}" (${workspaceId})` : workspaceId;
    const envLabel = environment ? `, environment ${environment}` : "";
    const content =
      `Fabric target from the project contract (${rel}): workspace ${workspaceLabel}${envLabel}; ` +
      `${itemType} "${itemName}" item ${itemId}` +
      (endpointId !== itemId ? ` (SQL endpoint ${endpointId})` : "") + `. ` +
      `For a SIMPLE READ — one bounded SELECT TOP (n), a table or column listing, a connection check — call the ` +
      `fabric-sqlendpoint execute_query tool DIRECTLY with workspaceId ${workspaceId} and itemId ${endpointId}. ` +
      `Do not search team knowledge, memory, or the Fabric catalog, load skills, or discover tools first: these ids are the answer, ` +
      `and the guardrails' approval prompt before Warehouse SQL still applies. ` +
      `Save team knowledge, lineage, and standards for design or change work.`;
    return { contractPath, content };
  } catch {
    return null; // contract guidance must never break a turn
  }
}

export interface ShareLearningSessionSignals {
  knowledgeAvailable: boolean;
  /** Distinct failed tool results observed this session (isError tool_results). */
  toolFailures?: number;
  alreadySuggested?: boolean;
}

/**
 * Heuristic for suggesting /share-learning at turn settle. The ONLY runtime
 * signal wired today is repeated tool failures (>= 2 distinct failed
 * tool_result events with knowledge configured and not already suggested this
 * session). Automatic user-correction/steer/retry-specific detection is
 * DEFERRED — manual /share-learning still covers corrections and discoveries.
 * Do not read this predicate as implementing correction detection.
 */
export function shouldSuggestShareLearning(signals: ShareLearningSessionSignals): boolean {
  if (!signals.knowledgeAvailable) return false;
  if (signals.alreadySuggested) return false;
  const failures = signals.toolFailures ?? 0;
  return failures >= 2;
}

/** The seven common workflows (master plan FR1, section 9), each wired to a prompt,
 *  skill or native wizard coop already ships. A choice either runs a native wizard
 *  or sends a friendly, first-person request AS the user (the menu just pre-writes
 *  the prompt a newcomer would otherwise have to compose); the agent then asks for
 *  specifics. The retired `sql-review` / `dax-review` tools are the standards
 *  self-check now (ST1), so item 1 asks for that. */
export function buildStartMenu(): MenuItem[] {
  return [
    {
      label: "🔎  Check SQL, DAX or a model against our standards",
      run: async (pi) => {
        pi.sendUserMessage(
          "I'd like to check some T-SQL / Fabric Warehouse SQL, DAX, or a semantic model against our Cooptimize standards. Ask me which file or folder to check, read it, compare it with the standards articles you were given for that domain, and walk me through what does not meet them (with file and line references and the standard section each one comes from). For a semantic model, also run bpa_review when Tabular Editor is configured.",
        );
      },
    },
    {
      label: "🧭  Trace the impact of a change",
      run: async (pi) => {
        pi.sendUserMessage(
          "Before I change something, I want to see its impact. Ask me which SQL object, table, measure, or semantic model I'm about to touch. For a live SQL object run sql_impact first, then use the data_doc lineage for the same object, and show me what's upstream and downstream and what could break.",
        );
      },
    },
    {
      label: "🛠️  Fix or edit an object on dev, with approval",
      run: async (pi) => {
        pi.sendUserMessage(
          "I want to fix or edit a SQL object, a DAX measure or a semantic model on the dev target. Follow the Cooptimize workflow: ask me what to change and why, write a short spec with /spec-first and wait for my approval before editing anything, then work it one slice at a time with /slice-next, asking for approval before every write and verifying each slice with data on dev.",
        );
      },
    },
    { label: "📚  Document a warehouse or semantic model", run: documentDataFlow },
    { label: "🏗️  Start a client project (set up or edit this Coop project)", run: runProjectWizard },
    {
      label: "📝  Write today's log or a handoff",
      run: async (pi) => {
        pi.sendUserMessage(
          "Help me write up my work. Ask whether it's today's log (/daily-log), a weekly log (/weekly-log) or a handoff for whoever picks this up next (/handoff), then help me capture what I worked on and turn it into a clean entry.",
        );
      },
    },
    {
      label: "🔐  Sign in or check health",
      run: async (pi) => {
        pi.sendUserMessage(
          "Check that this machine is ready: run `coop doctor` and explain anything that is not green in plain language, with the exact command to fix it. If Azure sign-in is missing for this project's tenant, give me the `az login --tenant <id> --allow-no-subscriptions` command to run. If `coop doctor` says my COOP profile is missing, tell me to pick \"Start a client project\" from /start (it asks my name) or run `coop onboard`.",
        );
      },
    },
  ];
}

/** True when this Pi process should open the Start Here menu once at startup: the
 *  launcher sets COOP_FIRST_RUN=1 on the first interactive launch per profile dir
 *  (master plan FR1). Only a dialog-capable TUI can show it. */
export function shouldOpenFirstRunMenu(
  ctx: Pick<ExtensionContext, "hasUI" | "mode">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ctx.hasUI && ctx.mode === "tui" && /^(1|true|yes|on)$/i.test(env.COOP_FIRST_RUN || "");
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

// ---------------------------------------------------------------------------
// Compaction over the chosen transport (issue #236)
//
// Pi 0.87.1 (and still 1.0.0) builds its compaction request without the session's
// `transport` setting: `AgentSession._runDefaultCompaction()` calls `compact()` with
// no transport, so the OpenAI Codex provider falls back to "auto" and opens a
// WebSocket for the summary request even when `/settings` says `sse`. On a large
// context that request can sit silent until `WebSocket idle timeout after 300000ms`,
// for manual `/compact` and threshold/overflow compaction alike.
//
// Bounded workaround until upstream forwards the transport: when the effective Pi
// settings say `transport: "sse"` and the model is one whose provider reads
// `transport` (Codex), coop answers `session_before_compact` with a compaction it
// generated through Pi's own exported `compact()`, passing a stream function that
// forwards `transport` and the idle timeout. Every other transport, model, or
// error on the way in returns `undefined`, so Pi's default path is untouched. A
// provider failure DURING the SSE summary propagates: Pi reports
// `session_compact_failed` (fromExtension) and keeps the session history intact.

/** Pi `settings.json` keys this hook reads (global agent dir only; `transport` is global-only). */
export interface PiTransportSettings {
  transport: "auto" | "sse" | "websocket" | "websocket-cached";
  /** HTTP/WebSocket idle timeout Pi would apply (`retry.provider.timeoutMs`, else `httpIdleTimeoutMs`, else 300000). */
  timeoutMs: number;
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
}

const PI_DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300000;
const PI_DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60000;
/** Provider APIs whose stream options honour `transport` (Pi 0.87.1: only Codex). */
export const TRANSPORT_AWARE_APIS = new Set(["openai-codex-responses"]);

function timeoutSetting(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value === 0 ? 2147483647 : Math.floor(value);
}

/** Read the transport-related keys of `<agentDir>/settings.json` the way Pi resolves them. */
export function readPiTransportSettings(dir: string = coopAgentDir()): PiTransportSettings {
  let raw: any = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== "object") raw = {};
  let transport: PiTransportSettings["transport"] = "auto";
  if (raw.transport === "sse" || raw.transport === "websocket" || raw.transport === "websocket-cached") transport = raw.transport;
  else if (!("transport" in raw) && typeof raw.websockets === "boolean") transport = raw.websockets ? "websocket" : "sse";
  const retry = raw.retry && typeof raw.retry === "object" ? raw.retry : {};
  const provider = retry.provider && typeof retry.provider === "object" ? retry.provider : {};
  const timeoutMs =
    timeoutSetting(provider.timeoutMs) ?? timeoutSetting(raw.httpIdleTimeoutMs) ?? PI_DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  return {
    transport,
    timeoutMs,
    retry: {
      enabled: typeof retry.enabled === "boolean" ? retry.enabled : true,
      maxRetries: typeof retry.maxRetries === "number" ? retry.maxRetries : 3,
      baseDelayMs: typeof retry.baseDelayMs === "number" ? retry.baseDelayMs : 2000,
      maxAgentDelayMs: typeof retry.maxAgentDelayMs === "number" ? retry.maxAgentDelayMs : PI_DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
    },
  };
}

/** Seams for tests; production loads Pi's own `compact()` and pi-ai's `streamSimple()` lazily. */
export interface CompactionTransportDeps {
  readSettings: () => PiTransportSettings;
  loadCompact: () => Promise<(...args: any[]) => Promise<any>>;
  loadStreamSimple: () => Promise<(model: any, context: any, options?: any) => any>;
  /** Session thinking level when the event context carries none (`pi.getThinkingLevel`). */
  getThinkingLevel?: () => unknown;
}

const defaultCompactionTransportDeps: CompactionTransportDeps = {
  readSettings: () => readPiTransportSettings(),
  loadCompact: async () => (await import("@earendil-works/pi-coding-agent")).compact,
  loadStreamSimple: async () => (await import("@earendil-works/pi-ai")).streamSimple,
};

/**
 * `session_before_compact` handler. Returns `{ compaction }` only when coop ran the
 * summary itself over the configured SSE transport; `undefined` leaves Pi's default.
 */
export function createCompactionTransportHandler(deps: CompactionTransportDeps = defaultCompactionTransportDeps) {
  return async (event: any, ctx: any): Promise<{ compaction: any } | undefined> => {
    let settings: PiTransportSettings;
    let compact: (...args: any[]) => Promise<any>;
    let streamSimple: (model: any, context: any, options?: any) => any;
    let auth: any;
    const model = ctx?.model;
    try {
      settings = deps.readSettings();
      if (settings.transport !== "sse") return undefined;
      if (!model || !TRANSPORT_AWARE_APIS.has(String(model.api))) return undefined;
      if (!event?.preparation) return undefined;
      compact = await deps.loadCompact();
      streamSimple = await deps.loadStreamSimple();
      auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
    } catch {
      return undefined; // seam unavailable on this Pi: keep Pi's own compaction
    }
    if (!auth || auth.ok === false) return undefined;
    const headers: Record<string, string> | undefined = auth.headers
      ? Object.fromEntries(Object.entries(auth.headers).filter(([, v]) => typeof v === "string") as [string, string][])
      : undefined;
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    let thinkingLevel = ctx.thinkingLevel;
    if (thinkingLevel === undefined && deps.getThinkingLevel) {
      try { thinkingLevel = deps.getThinkingLevel(); } catch { thinkingLevel = undefined; }
    }
    const streamFn = (m: any, context: any, options: any = {}) =>
      streamSimple(m, context, {
        ...options,
        transport: settings.transport,
        timeoutMs: options.timeoutMs ?? settings.timeoutMs,
        maxRetries: options.maxRetries ?? settings.retry.maxRetries,
        maxRetryDelayMs: options.maxRetryDelayMs ?? settings.retry.maxAgentDelayMs,
      });
    const compaction = await compact(
      event.preparation,
      requestModel,
      auth.apiKey,
      headers,
      event.customInstructions,
      event.signal,
      thinkingLevel,
      streamFn,
      auth.env,
      settings.retry,
      undefined, // retry callbacks: Pi's spinner is not reachable from here
      undefined, // sessionId: a fresh routing id, as Pi's own compaction uses
    );
    return { compaction };
  };
}

export default function coopTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sql_impact",
    label: "SQL impact (live catalog trace)",
    description: "Read-only live impact trace of ONE SQL object on the contract's default dev/test sql_targets entry: three fixed, parameterized catalog queries (never free text) for downstream dependents, upstream references and columns. A section marked unavailable means the target could not be asked; an empty list means 'no dependents', never 'could not look'. Accepts only `object`.",
    promptSnippet: "Live catalog trace of one SQL object's dependents, references and columns",
    promptGuidelines: [
      "Before planning or editing a live SQL object, call sql_impact with its name, then data_doc lineage for the same object when built docs exist, and report drift between them. Metadata only: use fabric_sql_query for rows.",
    ],
    parameters: SQL_IMPACT_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const details = await runFabricSqlHelper(params, signal, ctx.cwd, "sql_impact.py");
      const docsHint = builtLineageDir(ctx.cwd) ? " Built lineage docs exist here: call data_doc (command=\"lineage\") for the same object to cover the rest of the estate." : "";
      const section = (name: string) => {
        const part = details?.[name];
        if (!part || typeof part !== "object") return `${name}: ?`;
        return part.state === "ok" ? `${name}: ${part.count}${part.truncated ? "+" : ""}` : `${name}: unavailable`;
      };
      const text = details?.ok
        ? modelText(
          `sql_impact: ${details.object?.schema}.${details.object?.name} (${details.object?.type}) on ${details.target?.kind} ${details.target?.environment}: ${["downstream", "upstream", "columns"].map(section).join(", ")}.${docsHint}`,
          sqlImpactLines(details),
          "query sys.dm_sql_referencing_entities or INFORMATION_SCHEMA.COLUMNS with fabric_sql_query for the rest",
        )
        : `sql_impact unavailable: ${String(details?.state || "internal_error")}.`;
      return { content: [{ type: "text" as const, text }], details };
    },
  });

  pi.registerTool({
    name: "fabric_sql_query",
    label: "Fabric SQL Query (pyodbc fallback)",
    description: "Governed pyodbc read of one bounded SELECT against the contract's default sql_targets entry (Azure SQL, Fabric SQL database, Synapse serverless, Fabric Warehouse/Lakehouse), or the canonical Fabric SQL target without sql_targets. When a managed fabric-sqlendpoint MCP tool exists, attempt it first and call fabric_sql_query only after that actual attempt fails (unavailable/missing, authentication, timeout, connection, transport). Never use it for SQL/business/query rejection. Accepts no target, server, credential, or token fields.",
    promptSnippet: "Post-MCP-failure pyodbc fallback for one approval-gated bounded Fabric SELECT TOP read",
    promptGuidelines: [
      "With a managed fabric-sqlendpoint MCP server, attempt it first; only after an actual unavailable/authentication/timeout/connection/transport/tool-missing failure may you call fabric_sql_query; never fallback before MCP or for SQL/business/query rejection, and never cascade automatically. Direct sql_targets kinds (Azure SQL, Fabric SQL database, Synapse) have no MCP server: fabric_sql_query is the live read route.",
      "Use only one plain SELECT with a literal TOP bound; mutations, batches, cross-database names, and unbounded reads are rejected before authentication or connection.",
    ],
    parameters: FABRIC_SQL_QUERY_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const details = await runFabricSqlHelper(params, signal, ctx.cwd);
      const text = details?.ok
        ? modelText(
          `fabric_sql_query: ${details.row_count} row(s) returned${details.truncated ? " (capped)" : ""}.`,
          sqlRowLines(details),
          "narrow the SELECT (fewer columns or a smaller TOP) to see them",
        )
        : `fabric_sql_query unavailable: ${String(details?.state || "internal_error")}.`;
      return { content: [{ type: "text" as const, text }], details };
    },
  });

  pi.registerTool({
    name: "bpa_review",
    label: "Tabular Editor BPA",
    description:
      "Run Tabular Editor BPA against semantic-model files using built-in or configured rules and return findings as JSON. Advisory only — never edits model files.",
    promptSnippet: "Check semantic models with Tabular Editor BPA (advisory, JSON output)",
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
      if (!cfg.exe) return { content: [{ type: "text" as const, text: "Tabular Editor executable_path is missing in .coop/project.yml." }] };
      const legacy = /^TabularEditor(?:\.exe)?$/i.test(cfg.exe.replace(/\\/g, "/").split("/").pop() || "");
      if (legacy && !cfg.rules) return { content: [{ type: "text" as const, text: "Legacy TabularEditor.exe requires bpa_rules_path. Configure the cross-platform te CLI to use built-in rules." }] };

      let models = cfg.models;
      const p = params as ReviewParams;
      if (p.paths && p.paths.length) models = p.paths;
      if (!models.length) return { content: [{ type: "text" as const, text: "No semantic models to review (none in project.yml power_bi.semantic_models or passed explicitly)." }] };

      const allFindings: any[] = [];
      const allSummary = { error: 0, warning: 0, info: 0 };
      let finalCode = 0;
      let allStdout = "";
      let allStderr = "";
      let ruleErrors = 0;
      const invocations: string[][] = [];

      for (const model of models) {
        const projectRoot = resolve(contract, "..", "..");
        const absModel = isAbsolute(model) ? model : resolve(projectRoot, model);
        const absRules = cfg.rules ? resolve(projectRoot, cfg.rules) : "";
        const args = legacy ? [absModel, "-A", absRules, "-V"] :
          ["bpa", "run", "--model", absModel, "--output-format", "json", "--non-interactive", ...(absRules ? ["--rules", absRules] : [])];
        invocations.push(args);
        let res;
        try {
          res = await pi.exec(cfg.exe, args, { cwd: ctx.cwd, signal });
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to run Tabular Editor: ${errMsg(e)}` }],
            details: { tool: "bpa_review", analysisFailed: true, invocations },
          };
        }
        allStdout += res.stdout + "\n";
        allStderr += (res.stderr || "") + "\n";
        if (res.code !== 0) finalCode = res.code;
        let parsed;
        try {
          parsed = parseBpaOutput(res.stdout, legacy);
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `BPA results could not be read (exit ${res.code}): ${errMsg(e)}` }],
            details: { tool: "bpa_review", analysisFailed: true, invocations, exitCode: res.code, reportRejected: true, stdout: allStdout, stderr: allStderr },
          };
        }
        const { findings, summary } = parsed;
        ruleErrors += parsed.ruleErrors || 0;
        allFindings.push(...findings.map((finding: any) => ({ ...finding, file: absModel })));
        allSummary.error += summary.error;
        allSummary.warning += summary.warning;
        allSummary.info += summary.info;
        if (res.code !== 0 && !(res.code === 1 && findings.length > 0 && !parsed.ruleErrors)) {
          return {
            content: [{ type: "text" as const, text: `Tabular Editor BPA did not complete successfully (exit ${res.code}). See details for diagnostics and any partial findings.` }],
            details: { tool: "bpa_review", analysisFailed: true, invocations, exitCode: res.code, report: { findings: allFindings, summary: allSummary, ruleErrors }, stdout: allStdout, stderr: allStderr },
          };
        }
      }

      const report = { findings: allFindings, summary: allSummary, ruleErrors };
      const scopeLine = `Scope: ${models.join(", ")}`;
      return {
        content: [{
          type: "text" as const,
          text: modelText(
            `${summarizeReview("bpa_review", report, allStdout, finalCode)}\n${scopeLine}${ruleErrors ? `\nBPA could not evaluate ${ruleErrors} rule(s); results are incomplete.` : ""}`,
            bpaFindingLines(allFindings, models.length > 1),
            "fix the errors shown, then re-run bpa_review",
          ),
        }],
        details: { tool: "bpa_review", analysisFailed: ruleErrors > 0, invocations, report, exitCode: finalCode, stdout: allStdout, stderr: allStderr },
      };
    },
  });

  // Pi reads error overrides from tool_result hooks, not from execute's result.
  pi.on("tool_result", async (event: any) => {
    if (event.toolName === "bpa_review" && event.details?.analysisFailed === true) return { isError: true };
  });

  pi.registerTool({
    name: "data_doc",
    label: "Data Documentation",
    description:
      "Understand and document whatever SQL and/or Power BI source is available with coop-data-doc. Commands: 'scan' (default) writes the lineage graph (graph.json); 'build' also writes per-object Markdown docs and a portal, indexed by manifest.json; 'check' is a CI staleness gate; 'lineage' lists ONE object's upstream inputs, downstream dependents and relationships from the built graph; 'impact' lists every downstream object that changed source files feed. No source, one side, partial folders and both sides are valid stages. Without a coop-data-doc.yml or built graph, proceed without it (an aid, not a gate) and optionally suggest /setup-docs. Outputs are committable; source is never touched.",
    promptSnippet: "Understand a SQL+PowerBI estate: lineage graph, one object's up/downstream, and what a change feeds",
    promptGuidelines: [
      "BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, call data_doc with command='lineage', object='<name>' for its upstream inputs, downstream dependents, and relationships. Don't reconstruct lineage by hand.",
      "After editing SQL, DAX or model source files and before presenting the change, call data_doc with command='impact', files=[the changed paths] and report every downstream object it lists.",
      "Default to 'scan', 'lineage' and 'impact' (read-only); run 'build' only when the user wants the docs regenerated. Read the focused per-object Markdown via manifest.json, not the whole tree.",
      "Without a coop-data-doc.yml or built graph ('no built graph'), proceed without it and, if useful, suggest /setup-docs.",
    ],
    parameters: DATADOC_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const p = params as { command?: string; object?: string; depth?: number; files?: string[]; against?: string };
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
            ? lineageText(parsed, p.object)
            : noGraph
              ? NO_GRAPH_TEXT
              : `lineage failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { tool: "coop-data-doc", command, object: p.object, exitCode: res.code, lineage: parsed ?? res.stdout, stderr: res.stderr },
        };
      }

      // --- impact: every downstream object the changed files feed (read-only) ---
      if (command === "impact") {
        const files = (p.files || []).map((f) => String(f).trim()).filter(Boolean);
        const against = String(p.against || "").trim();
        if (!files.length && !against) {
          return {
            content: [{ type: "text" as const, text: "data_doc impact needs `files` (the changed source files) or `against` (a git ref whose committed graph.json is the baseline)." }],
            details: { tool: "coop-data-doc", command },
          };
        }
        if (against && (against.startsWith("-") || !/^[\w./~^@{}-]+$/.test(against))) {
          return {
            content: [{ type: "text" as const, text: `data_doc impact: '${against}' is not a git ref name.` }],
            details: { tool: "coop-data-doc", command, against },
          };
        }
        // `--opt=value` keeps a value that starts with '-' from being read as a flag.
        const args = ["impact", "--format=json", "--evidence"];
        if (against) args.push(`--git=${against}`);
        else {
          // Without a ref the current built graph is its own baseline: the
          // changed files seed the impact, and their objects' downstream is read
          // from the graph as built.
          const graphDir = builtLineageDir(ctx.cwd);
          if (!graphDir) {
            return { content: [{ type: "text" as const, text: NO_GRAPH_TEXT }], details: { tool: "coop-data-doc", command } };
          }
          args.push(`--baseline=${join(graphDir, "graph.json")}`);
        }
        for (const file of impactFileArgs(files, ctx.cwd)) args.push(`--files=${file}`);
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
        const seededBy = files.length
          ? `${files.length} changed file(s)${against ? ` against ${against}` : ""}`
          : `the rebuilt graph against ${against}`;
        const text =
          res.code === 0 && parsed
            ? impactText(parsed, seededBy)
            : /no built graph/i.test(res.stderr + res.stdout)
              ? NO_GRAPH_TEXT
              : `impact failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { tool: "coop-data-doc", command, files, against, args, exitCode: res.code, impact: parsed ?? res.stdout, stderr: res.stderr },
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
              (res.code === 0 && (command === "scan" || command === "build")
                ? `Machine-readable artifacts: graph.json${command === "build" ? " + manifest.json + Markdown docs + portal" : ""}.\n`
                : "") +
              `\n${tail}${setupHint}`,
          },
        ],
        details: { tool: "coop-data-doc", command, exitCode: res.code, stderr: res.stderr },
      };
    },
  });

  // Normal sessions start at the prompt. The only automatic handoff is the model
  // provider login required when a fresh install has no credentials yet.
  // #236: honour `transport: "sse"` for manual and automatic compaction.
  pi.on(
    "session_before_compact",
    createCompactionTransportHandler({ ...defaultCompactionTransportDeps, getThinkingLevel: () => pi.getThinkingLevel() }),
  );

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    // Learning-nudge lifecycle is per SESSION: reset the failure tally, the
    // dedupe set, and the once-only flags so a fresh session can be nudged
    // again. Turns within one session accumulate (two failures across two
    // turns can trigger the nudge).
    sessionToolFailures = 0;
    seenToolErrorIds.clear();
    learningNudgeAnnounced = false;
    announcedTeamKnowledge = false;
    const primedLogin = primeModelLogin(ctx);
    // First launch (master plan FR1): the common-workflows menu, once per profile
    // dir. The flag is cleared first so `/new` in the same process never reopens it.
    if (shouldOpenFirstRunMenu(ctx)) {
      delete process.env.COOP_FIRST_RUN;
      try {
        if (primedLogin) {
          notify(ctx, "After you sign in, run /start for the menu of common workflows.", "info");
        } else {
          await showStartMenu(pi, ctx);
        }
      } catch (e: any) {
        notify(ctx, `Couldn't open the menu: ${errMsg(e)}. Run /start any time, or just type what you'd like to do.`, "error");
      }
    }
  });

  // --- Native lineage awareness + required daily-log postcondition ----------
  // Once per folder, if BUILT coop-data-doc outputs exist, inject an (agent-visible,
  // human-hidden) note so coop consults the lineage for up/downstream impact before
  // touching an object. Every turn whose project contract requires a daily task log
  // also gets a system-prompt postcondition. Silent when neither applies; wrapped so
  // contract/logging guidance can never break a turn.
  const announcedCwds = new Set<string>();
  const announcedFabricTargets = new Set<string>();
  let announcedTeamKnowledge = false;
  let sessionToolFailures = 0;
  // Distinct failed tool_result events (dedupe by toolCallId so a replayed
  // result is never counted twice).
  const seenToolErrorIds = new Set<string>();
  let learningNudgeAnnounced = false;
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
      const standardsContext = buildStandardsContext(event.prompt || "", { cwd });
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
        const outAbs = builtLineageDir(cwd);
        if (outAbs) {
          announcedCwds.add(cwd);
          const relOut = relative(cwd, outAbs) || ".";
          message = {
            customType: "coop-lineage",
            display: false,
            content:
              `An observed lineage graph is available under ${relOut}: graph.json${existsSync(join(outAbs, "manifest.json")) ? ", manifest.json" : ""}. Its coverage may be partial or unknown; empty lineage does not prove zero impact. ` +
              `BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, look up its observed up/downstream impact via the data_doc tool (command="lineage", object="<name>"). ${existsSync(join(outAbs, "manifest.json")) ? "Read available object docs via manifest.json and its immediate neighbors. " : "Run data_doc (build) to generate object docs. "}If the graph looks stale, run data_doc (build) to refresh.`,
            details: { outputDir: relOut },
          };
        }
      }

      // Once per contract: hand the agent the Warehouse target the contract
      // already pins so a simple read skips the discovery detour.
      const fabricTarget = fabricTargetNote(cwd);
      if (fabricTarget && !announcedFabricTargets.has(fabricTarget.contractPath)) {
        announcedFabricTargets.add(fabricTarget.contractPath);
        if (message) {
          message.content = `${message.content}\n\n${fabricTarget.content}`;
        } else {
          message = {
            customType: "coop-fabric-target",
            display: false,
            content: fabricTarget.content,
            details: { contractPath: fabricTarget.contractPath },
          };
        }
      }

      if (!announcedTeamKnowledge) {
        const tk = teamKnowledgeNote();
        if (tk) {
          announcedTeamKnowledge = true;
          if (message) {
            message.content = `${message.content}\n\n${tk}`;
          } else {
            message = {
              customType: "coop-team-knowledge",
              display: false,
              content: tk,
            };
          }
        }
      }

      if (standardsContext.records.length) {
        const content = [
          "Cooptimize standards apply automatically to this task. Follow: identify domain → resolve authority → use only the relevant sections below → perform work → validate SQL/DAX with the same immutable authority record.",
          ...standardsContext.records.map((record: any) => provenanceText(record)),
          ...standardsContext.patterns.map((pattern: any) => {
            const snippets = pattern.sections.map((section: any) => `### ${section.heading} (${section.path})\n${section.content}`).join("\n\n");
            return `[semantic_model] optional authority=${pattern.authority_class} source=${pattern.source} root=${pattern.source_root} selective=true (relevant Incremental BI excerpts only; not mandatory)${snippets ? `\n${snippets}` : ""}`;
          }),
        ].join("\n\n");
        if (message) message.content = `${message.content}\n\n${content}`;
        else message = {
          customType: "coop-standards",
          display: false,
          content,
          // Pi message details cross a structured-clone boundary: expose data only,
          // never the executable resolver.
          details: {
            domains: standardsContext.domains,
            records: standardsContext.records,
            patterns: standardsContext.patterns,
          },
        };
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
    if (event.isError) {
      // Count DISTINCT failed calls: a replayed delivery of the same
      // toolCallId must never increment the tally twice.
      const id = event.toolCallId;
      if (id === undefined || id === null) {
        sessionToolFailures++;
      } else if (!seenToolErrorIds.has(id)) {
        seenToolErrorIds.add(id);
        sessionToolFailures++;
      }
    }
    if (!dailyRun) return;
    const effect = pendingDailyEffects.get(event.toolCallId);
    pendingDailyEffects.delete(event.toolCallId);
    if (!effect || event.isError) return;
    if (effect === "log") dailyRun.logTouched = true;
    if (effect === "meaningful") dailyRun.meaningful = true;
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    try {
      if (!learningNudgeAnnounced) {
        const kbNote = teamKnowledgeNote();
        if (
          kbNote &&
          shouldSuggestShareLearning({
            knowledgeAvailable: true,
            toolFailures: sessionToolFailures,
            alreadySuggested: false,
          })
        ) {
          learningNudgeAnnounced = true;
          notify(ctx, "This session may be worth a team learning — run /share-learning", "info");
        }
      }

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
        await runSetupDocs(pi, ctx);
      } catch (e: any) {
        notify(ctx, `setup-docs failed: ${errMsg(e)}. You can run the same wizard in a shell: coop data-doc setup`, "error");
      }
    },
  });

  pi.registerCommand("standards-status", {
    description: "Show effective standards and independent source states",
    handler: async (_args: string, ctx: ExtensionContext) => {
      try {
        const status = sourceStatus({ cwd: ctx.cwd });
        notify(ctx, `Canonical remote: ${status.canonical_remote}. See the JSON status in the conversation.`, "info");
        pi.sendUserMessage(`Standards status (read-only):\n\n\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\``);
      } catch (e: any) {
        notify(ctx, `Standards status unavailable: ${errMsg(e)}`, "warning");
      }
    },
  });
}
