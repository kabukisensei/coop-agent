/**
 * coop-guardrails — runtime ENFORCEMENT of Cooptimize's governance rules.
 *
 * `docs/guardrails.md` is the advisory system prompt (it asks the model to behave).
 * This extension hooks the agent's tool calls and actually ENFORCES the
 * non-negotiables the model could slip on:
 *
 *   1. NEVER commit source — block `git commit` from the agent whenever the commit
 *      would include anything outside the allow-listed docs / logs / site paths. This
 *      covers staged files, `git commit -a/-am` (which auto-stages tracked changes),
 *      `git -C <dir> commit`, and `git commit <pathspec>` (which commits working-tree
 *      content ignoring the index). The agent may commit docs/logs/site (with
 *      approval); a human commits source.
 *   2. Destructive commands — confirm before `rm -rf`, `git push --force` (incl. a
 *      `+refspec` force push), `git reset --hard`, `git clean -f`, and `DROP`/
 *      `TRUNCATE` SQL. All git detectors tolerate `git -C <dir>` and interspersed
 *      flags, and match case-insensitively.
 *   3. Secret files — confirm before read/edit/write of `.env`, private keys, or
 *      credential files, AND before a bash command that touches one (`cat .env`
 *      etc.). The agent must never expose secrets.
 *   4. Live data reads — dev/test metadata is allowed read-only; one plain bounded
 *      SELECT against the resolved dev target runs unprompted; other row-level
 *      reads and any production access require explicit approval; a production
 *      WRITE is blocked outright (G1), unless a human unlocked it from their own
 *      terminal for a bounded time.
 *   5. Mutating MCP actions — confirm before Fabric/Power BI/MCP tool calls whose
 *      names look like create/update/delete/deploy/publish (best-effort; MCP tool
 *      names vary. This extension is the approval layer: Pi itself does not
 *      prompt per tool call).
 *
 * It is the coop-native replacement for the third-party @aliou/pi-guardrails (which
 * was pinned to the old @mariozechner Pi). It enforces the AGENT's tool calls — your
 * own shell is never intercepted. Approval-required actions fail closed when no UI is
 * available; enforcement exceptions block the affected call without exposing error
 * details or crashing Pi. Optional display/logging failures remain best-effort. Disable
 * entirely with COOP_NO_GUARDRAILS=1.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { agentDir as coopAgentDir, profileDir as coopProfileDir } from "../../lib/paths.mjs";
import { editGateDecision } from "../../lib/lineage-context.mjs";

declare const Buffer: { from(value: string, encoding: "base64url"): { length: number; toString(encoding: "utf8" | "base64url"): string } };

// Paths the agent MAY commit; everything else counts as source. The .coop/project.yml
// `approval_policy.agent_allowed_to_commit` globs are merged in on top of these.
const DEFAULT_ALLOWED_GLOBS = [
  "docs/**",
  "site/**",
  "data-docs/**",
  "data-docs-site/**",
];

/** Find the nearest .coop/project.yml walking up from `cwd` (bounded), else the
 *  contract the launcher resolved (COOP_PROJECT_YML: the client home repository
 *  beside this one, C1), so the trusted snapshot is the file every other part
 *  of coop reads. */
function findProjectYml(cwd: string, exists: (path: string) => boolean = existsSync): string | null {
  let d = cwd;
  for (let i = 0; i < 8; i++) {
    const p = join(d, ".coop", "project.yml");
    if (exists(p)) return p;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const launched = process.env.COOP_PROJECT_YML;
  return launched && exists(launched) ? launched : null;
}

/** A committed path is allowed only after explicit deny rules have been checked. */
function isAllowedCommitPath(file: string, allowedGlobs: string[], deniedGlobs: string[]): boolean {
  if (deniedGlobs.some((g) => matchGlob(file, g))) return false;
  if (/\.(md|markdown)$/i.test(file)) return true; // documentation anywhere, unless denied
  return allowedGlobs.some((g) => matchGlob(file, g));
}

/** Very small glob matcher for the patterns we use in project.yml: `**` matches any
 *  number of path segments; `*` matches within a segment; `?` matches one char. */
function matchGlob(path: string, glob: string): boolean {
  const re = globToRegex(glob);
  return re.test(path);
}

function globToRegex(glob: string): RegExp {
  let s = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      s += ".*";
      i += 2;
      if (glob[i] === "/") { s += "\\/?"; i++; }
    } else if (c === "*") { s += "[^/]*"; i++; }
    else if (c === "?") { s += "[^/]"; i++; }
    else if (/[A-Za-z0-9_\-./]/.test(c)) { s += c.replace(/[.]/g, "\\$&"); i++; }
    else { s += "\\" + c; i++; }
  }
  return new RegExp("^" + s + "$", "i");
}

export type RepoCommitPolicy = { allowed: string[]; denied: string[] };

/** One `repositories:` entry of project.yml with its `local_path` resolved
 *  against the contract's project dir and its commit globs. */
export type RepoPolicyEntry = { name: string; path: string; allowed: string[]; denied: string[] };

/** Parse EVERY repositories: entry into resolved policy entries. This is the input
 *  to the trusted per-session governance snapshot — it is read once, never per commit. */
export function parseRepoEntries(text: string, projectDir: string): RepoPolicyEntry[] {
  const entries: RepoPolicyEntry[] = [];
  const lines = text.split("\n");
  let inRepos = false;
  let repoBaseIndent = 0;
  let currentName: string | null = null;
  let currentLocalPath: string | null = null;
  let currentAllowed: string[] = [];
  let currentDenied: string[] = [];
  let currentBaseIndent = 0;

  function flush(): void {
    if (!currentName || !currentLocalPath) return;
    const resolved = isAbsolute(currentLocalPath)
      ? currentLocalPath
      : resolve(projectDir, currentLocalPath);
    entries.push({ name: currentName, path: resolve(resolved), allowed: [...currentAllowed], denied: [...currentDenied] });
    currentName = null;
    currentLocalPath = null;
    currentAllowed = [];
    currentDenied = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^repositories\s*:\s*(#.*)?$/.test(trimmed)) {
      inRepos = true;
      repoBaseIndent = indent;
      continue;
    }
    if (!inRepos) continue;

    // End of repositories section: a key at or before repoBaseIndent that isn't a repo name.
    if (indent <= repoBaseIndent && !trimmed.startsWith("-")) {
      flush();
      inRepos = false;
      continue;
    }

    // A repository entry name is a key exactly one indent deeper than `repositories:`.
    const repoKey = /^(?:'((?:[^']|'')+)'|"([^"]+)"|([A-Za-z0-9_\-]+))\s*:\s*(#.*)?$/.exec(trimmed);
    if (indent === repoBaseIndent + 2 && repoKey && !trimmed.startsWith("-")) {
      flush();
      currentName = (repoKey[1] || repoKey[2] || repoKey[3]).replace(/''/g, "'");
      currentLocalPath = null;
      currentAllowed = [];
      currentDenied = [];
      currentBaseIndent = indent;
      continue;
    }

    // Properties inside a repository entry.
    if (currentName && indent > currentBaseIndent) {
      const kv = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (kv) {
        const k = kv[1];
        const v = kv[2].trim().replace(/\s+#.*$/, "");
        if (k === "local_path") {
          currentLocalPath = v.replace(/^["']|["']$/g, "");
        } else if (k === "agent_allowed_to_commit" && v.startsWith("[")) {
          // Flow form on a single line.
          for (const raw of v.slice(1, -1).split(",")) {
            const g = raw.trim().replace(/^["']|["']$/g, "");
            if (g) currentAllowed.push(g);
          }
        } else if (k === "agent_never_commit" && v.startsWith("[")) {
          for (const raw of v.slice(1, -1).split(",")) {
            const g = raw.trim().replace(/^["']|["']$/g, "");
            if (g) currentDenied.push(g);
          }
        }
      }
      const item = /^-\s+(.*)$/.exec(trimmed);
      if (item && indent > currentBaseIndent + 2) {
        const parentKey = findParentKey(lines, i, currentBaseIndent + 2);
        // Same cleanup as the scalar branch: a trailing `  # note` is a comment, not part of the glob.
        const g = item[1].trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
        if (g) {
          if (parentKey === "agent_allowed_to_commit") currentAllowed.push(g);
          else if (parentKey === "agent_never_commit") currentDenied.push(g);
        }
      }
    }
  }
  if (inRepos) flush();
  return entries;
}

function findParentKey(lines: string[], idx: number, parentIndent: number): string | null {
  for (let j = idx - 1; j >= 0; j--) {
    const raw = lines[j];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indent === parentIndent) {
      const kv = /^([A-Za-z0-9_\-]+)\s*:/.exec(trimmed);
      return kv ? kv[1] : null;
    }
    if (indent < parentIndent) return null;
  }
  return null;
}

/** The contract's dev Fabric workspace (`fabric.default_workspace_id`), named in the
 *  Rayfin (Fabric Apps, FA1) deploy prompt; "" when absent or not a GUID. */
export type SessionGovernance = { loaded: boolean; entries: RepoPolicyEntry[]; sqlContract: ContractSqlScope | null; devWorkspaceId: string };

// The TRUSTED policy snapshot: read once per session, then frozen. Editing
// .coop/project.yml mid-session can never weaken the active guardrails.
let sessionGovernance: SessionGovernance = { loaded: false, entries: [], sqlContract: null, devWorkspaceId: "" };

/** Read the session's project contract once into an immutable governance snapshot. */
export function buildSessionGovernance(sessionCwd: string): SessionGovernance {
  const entries: RepoPolicyEntry[] = [];
  let sqlContract: ContractSqlScope | null = null;
  let devWorkspaceId = "";
  try {
    const proj = findProjectYml(sessionCwd);
    if (proj) {
      const projectRoot = dirname(dirname(proj));
      const text = readFileSync(proj, "utf8");
      entries.push(...parseRepoEntries(text, projectRoot));
      sqlContract = parseContractSqlScope(text);
      devWorkspaceId = parseDevWorkspaceId(text);
    }
  } catch {
    /* conservative defaults are fine */
  }
  return { loaded: true, entries, sqlContract, devWorkspaceId };
}

/** Forget the snapshot so the next governed call re-reads the contract (new session / tests). */
export function resetSessionGovernance(): void {
  sessionGovernance = { loaded: false, entries: [], sqlContract: null, devWorkspaceId: "" };
}

// --- sql_targets: the contract's SQL scope (SQ3) ------------------------------------
// lib/sql_targets.py is the authority on the section; this is the same validation
// ported to the trusted snapshot so the live-read prompt describes exactly what
// lib/sql_query.py will connect to. Anything the port cannot vouch for resolves to
// null, which means "ask on every call" (never a grant).
export type ContractSqlTarget = {
  environment: "dev" | "test";
  kind: string;
  database: string;
  server: string;
  workspaceId: string;
  itemId: string;
  sqlEndpointId: string;
};
/** `configured` mirrors lib/sql_query.py: once the section exists, the executor
 *  uses it (or fails closed) and never falls back to the managed Fabric target. */
export type ContractSqlScope = { configured: boolean; client: string; tenant: string; target: ContractSqlTarget | null };

const SQL_HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const SQL_TARGET_KINDS: Record<string, { host: RegExp; discovered: boolean }> = {
  fabric_warehouse: { host: new RegExp(`^${SQL_HOST_LABEL}(?:\\.${SQL_HOST_LABEL})*\\.datawarehouse\\.fabric\\.microsoft\\.com$`), discovered: true },
  fabric_lakehouse: { host: new RegExp(`^${SQL_HOST_LABEL}(?:\\.${SQL_HOST_LABEL})*\\.datawarehouse\\.fabric\\.microsoft\\.com$`), discovered: true },
  fabric_sql_database: { host: new RegExp(`^${SQL_HOST_LABEL}(?:\\.${SQL_HOST_LABEL})*\\.database\\.fabric\\.microsoft\\.com$`), discovered: false },
  azure_sql: { host: new RegExp(`^${SQL_HOST_LABEL}(?:\\.${SQL_HOST_LABEL})*\\.database\\.windows\\.net$`), discovered: false },
  synapse_serverless: { host: new RegExp(`^${SQL_HOST_LABEL}-ondemand(?:\\.${SQL_HOST_LABEL})*\\.sql\\.azuresynapse\\.net$`), discovered: false },
};
const SQL_TARGET_KEYS = new Set(["kind", "server", "database", "workspace_id", "item_id", "sql_endpoint_id", "read_scale_replicas"]);
const SQL_SAFE_DATABASE = /^[A-Za-z0-9][A-Za-z0-9 ._@&'()+-]{0,159}$/;
const SQL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A YAML scalar as lib/_yaml.py reads it: quotes stripped, trailing comment dropped. */
function yamlScalar(raw: string): string {
  const v = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$|^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(v);
  if (quoted) return quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, "$1") : quoted[2].replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "").trim();
}

/** The top-level `section:` block of a contract as nested string maps (two levels:
 *  `section.key: scalar` and `section.key.subkey: scalar`). Deeper nesting, lists
 *  and flow collections are not what sql_targets uses, so they read as "". */
function yamlSection(text: string, section: string): Record<string, string | Record<string, string>> | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${section}\\s*:\\s*(?:#.*)?$`).test(line));
  if (start < 0) return null;
  const out: Record<string, string | Record<string, string>> = {};
  let current: string | null = null;
  let currentIndent = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    const kv = /^([A-Za-z0-9_]+)\s*:(?:\s+(.*))?$/.exec(body);
    if (!kv) { current = null; continue; }
    const [, key, rawValue] = kv;
    if (current !== null && indent > currentIndent) {
      const nested = out[current];
      if (typeof nested === "object") nested[key] = rawValue === undefined ? "" : yamlScalar(rawValue);
      continue;
    }
    currentIndent = indent;
    if (rawValue === undefined || rawValue.trim() === "" || rawValue.trim().startsWith("#")) { out[key] = {}; current = key; }
    else { out[key] = yamlScalar(rawValue); current = null; }
  }
  return out;
}

function sqlPlaceholder(value: string): boolean { return !value || value.toUpperCase().startsWith("TODO"); }

/** One `sql_targets` entry, or null unless it is exactly ready (lib/sql_targets.py's
 *  "ready" state): placeholders, unknown or credential keys, a host that does not
 *  match its kind, ids for a direct kind, a hand-written host for a discovered kind. */
function readySqlTarget(environment: "dev" | "test", raw: unknown): ContractSqlTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, string>;
  if (Object.keys(entry).some((key) => !SQL_TARGET_KEYS.has(key))) return null;
  const kind = (entry.kind || "").trim().toLowerCase();
  const spec = SQL_TARGET_KINDS[kind];
  const database = (entry.database || "").trim();
  if (!spec || sqlPlaceholder(database) || !SQL_SAFE_DATABASE.test(database)) return null;
  const server = (entry.server || "").trim().toLowerCase();
  const workspaceId = (entry.workspace_id || "").trim().toLowerCase();
  const itemId = (entry.item_id || "").trim().toLowerCase();
  const sqlEndpointId = (entry.sql_endpoint_id || "").trim().toLowerCase();
  if (entry.read_scale_replicas !== undefined && (kind !== "azure_sql" || !/^(true|false)$/i.test(entry.read_scale_replicas.trim()))) return null;
  if (spec.discovered) {
    if (server || !SQL_UUID.test(workspaceId) || !SQL_UUID.test(itemId)) return null;
    if (kind === "fabric_lakehouse" ? !SQL_UUID.test(sqlEndpointId) : sqlEndpointId) return null;
    return { environment, kind, database, server: "", workspaceId, itemId, sqlEndpointId };
  }
  if (workspaceId || itemId || sqlEndpointId || sqlPlaceholder(server) || !spec.host.test(server)) return null;
  return { environment, kind, database, server, workspaceId: "", itemId: "", sqlEndpointId: "" };
}

/** `fabric.default_workspace_id` as a lower-case GUID, or "" (absent, TODO, typo). */
export function parseDevWorkspaceId(text: string): string {
  const ws = yamlSection(text, "fabric")?.default_workspace_id;
  return typeof ws === "string" && SQL_UUID.test(ws.trim()) ? ws.trim().toLowerCase() : "";
}

/** The contract's SQL scope source: profile.client, fabric.tenant_id and the ready
 *  default `sql_targets` entry. `target` is null when the default is prod, missing,
 *  unconfigured or invalid, so a contract-driven read then asks on every call. */
export function parseContractSqlScope(text: string): ContractSqlScope | null {
  const section = yamlSection(text, "sql_targets");
  if (section === null) return null;
  const profile = yamlSection(text, "profile") || {};
  const fabric = yamlSection(text, "fabric") || {};
  const client = typeof profile.client === "string" ? profile.client : "";
  const tenant = typeof fabric.tenant_id === "string" ? fabric.tenant_id.trim().toLowerCase() : "";
  const envs = ["dev", "test", "prod"];
  if (Object.keys(section).some((key) => key !== "default_environment" && !envs.includes(key))) return { configured: true, client, tenant, target: null };
  const rawDefault = typeof section.default_environment === "string" ? section.default_environment.trim().toLowerCase() : "";
  const environment = rawDefault === "" ? "dev" : rawDefault;
  if (environment !== "dev" && environment !== "test") return { configured: true, client, tenant, target: null };
  return { configured: true, client, tenant, target: readySqlTarget(environment, section[environment]) };
}

function ensureSessionGovernance(sessionCwd: string): SessionGovernance {
  if (!sessionGovernance.loaded) sessionGovernance = buildSessionGovernance(sessionCwd);
  return sessionGovernance;
}

/** Resolve commit policy for exactly the repository whose local_path matches,
 *  using ONLY the trusted snapshot — the working tree is never re-read here.
 *  An unmatched repository receives conservative built-ins only; repository-
 *  specific allowlists never leak across sibling repositories. */
export function commitPolicy(repoDir: string, governance?: SessionGovernance): RepoCommitPolicy {
  const snap = governance?.loaded ? governance : ensureSessionGovernance(repoDir);
  const result: RepoCommitPolicy = { allowed: [...DEFAULT_ALLOWED_GLOBS], denied: [] };
  const hit = snap.entries.find((e) => e.path === resolve(repoDir));
  if (hit) {
    result.allowed.push(...hit.allowed);
    result.denied.push(...hit.denied);
  }
  return result;
}

/** Split a command string into tokens, honoring single/double quotes. */
export function tokenizeArgs(s: string): string[] {
  const toks: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) toks.push(m[1] ?? m[2] ?? m[3] ?? "");
  return toks;
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Split a shell command on unquoted shell separators, including LF/CRLF.
 *  Quote/escape-aware: separators inside quotes or escaped with backslash do not split. */
function splitShellSegments(cmd: string): { segment: string; start: number }[] {
  const segs: { segment: string; start: number }[] = [];
  let current = "";
  let start = 0;
  let inDquote = false, inSquote = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"' && !inSquote && !isEscapedAt(cmd, i)) { inDquote = !inDquote; current += ch; continue; }
    if (ch === "'" && !inDquote && !isEscapedAt(cmd, i)) { inSquote = !inSquote; current += ch; continue; }
    if (!inDquote && !inSquote && !isEscapedAt(cmd, i)) {
      const two = cmd.slice(i, i + 2);
      const one = ch;
      const sep = two === "&&" || two === "||" || two === "\r\n" ? two : one === ";" || one === "|" || one === "&" || one === "\n" || one === "\r" ? one : null;
      if (sep) {
        segs.push({ segment: current, start });
        current = "";
        i += sep.length - 1;
        start = i + 1;
        continue;
      }
    }
    current += ch;
  }
  segs.push({ segment: current, start });
  return segs;
}

/** A parsed Git invocation inside one shell segment. */
export type ParsedGitCommand = {
  segment: string;
  segmentStart: number;
  cwdOverride?: string;
  subcommand?: string;
  args: string[];
  pathspecs: string[];
};

// git-commit options that consume a SEPARATE following token (so that token is the
// option's value, not a pathspec). `--opt=value` forms are self-contained.
const COMMIT_VALUE_OPTS = new Set([
  "-m", "-F", "-C", "-c", "-t", "--message", "--file", "--reuse-message",
  "--reedit-message", "--fixup", "--squash", "--template", "--author", "--date",
  "--cleanup", "--gpg-sign", "--trailer", "--pathspec-from-file",
]);

// Git global options that take a value and should be consumed before the subcommand.
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--config-env", "--attr-source",
]);

/** Parse one quote-aware Git invocation from a shell command segment, or null.
 *  The caller supplies the segment so sibling commands (and their flags) are never
 *  mixed into the Git parse. */
/** Remove quote characters that are glued onto word characters ("git" -> git,
 *  "gi"t -> git) while leaving space-delimited quoted strings untouched so prose
 *  like "some docs about git" never looks like a Git command word. */
function stripGluedQuotes(s: string): string {
  return s.replace(/(['"])(?=\S)/g, "").replace(/(?<=\S)(['"])/g, "");
}

/** Walk a shell segment's words and find the word that resolves to the COMMAND
 *  position, skipping grouping punctuation, reserved words (then/do/else/!),
 *  VAR=value assignments, and supported wrappers (command/builtin/exec/time/env
 *  with their flags and env value flags). Returns null when the command word is
 *  anything other than git — mentioning git as an ARGUMENT (grep git README.md)
 *  does not make a command a Git invocation. Quote-glued names count: bash
 *  executes "git" and "gi"t exactly like unquoted git. */
function findGitAtCommandPosition(segment: string): { charOffset: number } | null {
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  let inWrapper = false;
  let envValuePending = false;
  while ((m = wordRe.exec(segment))) {
    const w = m[0];
    const core = w.replace(/^[({]+/, "");
    const charOffset = m.index + (w.length - core.length);
    if (core === "") continue; // pure grouping token
    if (envValuePending) { envValuePending = false; continue; } // consumed env flag value
    if (inWrapper) {
      if (core.startsWith("-")) {
        // env flags that take a separate value (-u NAME, -S STR, -C DIR)
        if (/^-(u|S|C)$|^--split-string$/.test(core)) envValuePending = true;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(core)) continue; // env VAR=val
      inWrapper = false; // wrapper arguments ended — this word is the command
    }
    const bare = core.replace(/['"]/g, "").toLowerCase();
    if (bare === "git") return { charOffset };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(core)) continue; // assignment prefix
    if (/^(then|do|else|!)$/.test(bare)) continue; // reserved words
    if (/^(command|builtin|exec|time|env)$/.test(bare)) { inWrapper = true; continue; }
    return null; // command position resolves to something else — not a Git command
  }
  return null;
}

/** Parse one Git invocation whose command word resolves to git. Shapes the walker
 *  cannot safely attribute are classified as ambiguous by hasAmbiguousGitInvocation()
 *  and fail closed at runtime. */
function parseGitSegment(segment: string, segmentStart: number): ParsedGitCommand | null {
  const loc = findGitAtCommandPosition(segment);
  if (!loc) return null;
  segmentStart += loc.charOffset;
  const rawTail = segment.slice(loc.charOffset);
  let toks = tokenizeArgs(rawTail);
  if (toks.length === 0) return null;
  if (toks[0].toLowerCase() !== "git") {
    // Split-quote command name ("gi"t): tokenizeArgs keeps it in pieces, so parse
    // the de-glued tail instead. Whole-word quotes ("git") already tokenize to git.
    const degluedFirst = stripGluedQuotes(rawTail).split(/\s+/)[0]?.replace(/['"]/g, "").toLowerCase();
    if (degluedFirst !== "git") return null;
    segment = rawTail;
    toks = tokenizeArgs(stripGluedQuotes(rawTail));
  } else {
    segment = rawTail;
  }

  let i = 1;
  let cwdOverride: string | undefined;
  while (i < toks.length) {
    const t = toks[i];
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      const opt = eq >= 0 ? t.slice(0, eq) : t;
      if (GIT_GLOBAL_VALUE_OPTS.has(opt)) {
        if (eq >= 0) {
          if (opt === "-C") cwdOverride = t.slice(eq + 1);
          i++;
          continue;
        }
        if (i + 1 < toks.length) {
          if (opt === "-C") cwdOverride = toks[i + 1];
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }
    break; // first non-option token is the subcommand
  }

  const subcommand = toks[i]?.toLowerCase();
  if (!subcommand) return { segment, segmentStart, cwdOverride, args: [], pathspecs: [] };
  i++;

  const args: string[] = [];
  const pathspecs: string[] = [];
  let dashDash = false;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (dashDash) { pathspecs.push(t); continue; }
    if (t === "--") { dashDash = true; continue; }
    if (t.startsWith("-")) {
      args.push(t);
      if (subcommand === "commit") {
        // Long-form `--opt value` consumes the next token.
        if (COMMIT_VALUE_OPTS.has(t) && i + 1 < toks.length) {
          i++;
          args.push(toks[i]);
          continue;
        }
        // Short-flag cluster like `-am x`: if the cluster ends with a value-taking
        // letter (m/F/C/c/t), the next token is that value, not a pathspec.
        if (/^-[A-Za-z]+$/.test(t)) {
          const last = t[t.length - 1];
          if (["m", "F", "C", "c", "t"].includes(last) && i + 1 < toks.length) {
            i++;
            args.push(toks[i]);
          }
        }
      }
      continue;
    }
    if (subcommand === "commit") {
      pathspecs.push(t);
    } else {
      args.push(t);
    }
  }
  return { segment, segmentStart, cwdOverride, subcommand, args, pathspecs };
}

/** Find every Git invocation in a command, quote-aware and segment-scoped. */
export function parseGitCommands(cmd: string): ParsedGitCommand[] {
  const out: ParsedGitCommand[] = [];
  for (const { segment, start } of splitShellSegments(cmd)) {
    const leading = segment.length - segment.trimStart().length;
    const parsed = parseGitSegment(segment.trim(), start + leading);
    if (parsed) out.push(parsed);
  }
  return out;
}

function unquotedText(text: string): string {
  let out = "", single = false, double = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !double && !isEscapedAt(text, i)) { single = !single; out += " "; }
    else if (ch === '"' && !single && !isEscapedAt(text, i)) { double = !double; out += " "; }
    else out += single || double ? " " : ch;
  }
  return out;
}

export function hasAmbiguousGitInvocation(cmd: string): boolean {
  return splitShellSegments(cmd).some(({ segment, start }) => {
    // Git mentioned anywhere (prose-blanked or glue-stripped views)?
    const mentioned = /\bgit\b/i.test(unquotedText(segment)) || /\bgit\b/i.test(stripGluedQuotes(segment));
    if (!mentioned) return false;
    // Real Git command word we cannot safely parse -> fail closed.
    if (findGitAtCommandPosition(segment) && parseGitSegment(segment.trim(), start) === null) return true;
    // Command substitution/backticks containing git execute it out of view.
    if (/\$\(/.test(segment) || segment.includes("`")) return true;
    return false;
  });
}

/** Backwards-compatible first-invocation helper. Runtime enforcement uses all. */
export function parseGitCommand(cmd: string): ParsedGitCommand | null {
  return parseGitCommands(cmd)[0] ?? null;
}

/** Explicit pathspec arguments of `git commit <pathspec>` — the files it commits
 *  straight from the WORKING TREE, ignoring the index. */
export function explicitCommitPathspecs(cmd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): string[] {
  if (!parsed || parsed.subcommand !== "commit") return [];
  return parsed.pathspecs;
}

/** What the index-changing Git segments BEFORE a commit in the same command put
 *  into the index: `git add` / `git stage` pathspecs (expanded against HEAD and the
 *  untracked files at check time), `git rm` / `git mv` paths (named as given, since
 *  they are unchanged in the working tree when the check runs), and the whole
 *  working tree for `add -A`, `add .`, `add -u` and forms whose paths the
 *  guardrail cannot read (`-i`, `-p`, `--pathspec-from-file`). Only segments that
 *  target the commit's repository count (#282: `git add src/x && git commit` used
 *  to pass on an empty index). A dry run stages nothing. */
export function precedingStagingPlan(cmd: string, cwd: string, commit: ParsedGitCommand): { everything: boolean; tracked: boolean; pathspecs: string[]; literal: string[] } | null {
  const repoDir = gitRepoDir(cmd, cwd, commit);
  const plan = { everything: false, tracked: false, pathspecs: [] as string[], literal: [] as string[] };
  let found = false;
  for (const seg of parseGitCommands(cmd)) {
    if (seg.segmentStart >= commit.segmentStart) continue;
    if (!["add", "stage", "rm", "mv"].includes(seg.subcommand || "")) continue;
    if (gitRepoDir(cmd, cwd, seg) !== repoDir) continue;
    if (seg.args.some((a) => a === "-n" || a === "--dry-run" || /^-[A-Za-z]*n[A-Za-z]*$/.test(a))) continue;
    found = true;
    const paths = [...seg.args.filter((a) => !a.startsWith("-")), ...seg.pathspecs];
    if (seg.subcommand === "rm" || seg.subcommand === "mv") { plan.literal.push(...paths); continue; }
    const flags = seg.args.filter((a) => a.startsWith("-"));
    const short = (letter: string) => flags.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
    if (flags.some((a) => a === "--all" || a === "--no-ignore-removal" || a === "--interactive" || a === "--patch" || a === "--edit" || a.startsWith("--pathspec-from-file"))
        || short("A") || short("i") || short("p") || short("e")
        || paths.some((p) => p === "." || p === ":/" || p === "*" || p === "./")) {
      plan.everything = true;
      continue;
    }
    if (flags.includes("--update") || short("u")) { plan.tracked = true; continue; }
    plan.pathspecs.push(...paths);
  }
  return found ? plan : null;
}

/** The directory of the LAST `cd <dir>` / `pushd <dir>` in a command prefix, or null.
 *  Quote-aware (reuses tokenizeArgs). `cd` with no arg or an option arg (`cd -`) is
 *  ignored — it can't be resolved to a concrete repo, so we fall back to cwd there. */
export function leadingCdDir(before: string): string | null {
  let dir: string | null = null;
  for (const seg of before.split(/&&|\|\||[;&|]/)) {
    const toks = tokenizeArgs(seg.trim());
    if ((toks[0] === "cd" || toks[0] === "pushd") && toks[1] && !toks[1].startsWith("-")) {
      dir = toks[1];
    }
  }
  return dir;
}

function isAbsoluteOrWinAbsolute(dir: string): boolean {
  return isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir);
}

function resolveDir(dir: string, cwd: string): string {
  return isAbsoluteOrWinAbsolute(dir) ? dir : resolve(cwd, dir);
}

/** The effective git repo dir for a `git commit` command, resolved to an absolute path:
 *  git's own `-C <dir>` global option if present; else a leading `cd`/`pushd` target
 *  from an earlier shell segment (`cd /other && git commit …` — the chained-cd bypass);
 *  else the caller's cwd. Uses the quote-aware parser so sibling commands and quoted
 *  paths are handled correctly. */
export function gitRepoDir(cmd: string, cwd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): string {
  if (parsed?.cwdOverride) return resolveDir(parsed.cwdOverride, cwd);
  if (parsed?.subcommand) {
    const cd = leadingCdDir(cmd.slice(0, parsed.segmentStart));
    if (cd) return resolveDir(cd, cwd);
  }
  return cwd;
}

/** True when a `cd`/`pushd` precedes the `git commit` segment (`cd /other && git commit`
 *  …`) — the chained-cd shape whose target repo the staged-file check may not be able to
 *  reach. Used to prompt instead of silently allowing when the check can't determine. */
export function commitHasLeadingCd(cmd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): boolean {
  if (!parsed) return false;
  return leadingCdDir(cmd.slice(0, parsed.segmentStart)) !== null;
}

/** Will this `git commit` auto-stage tracked changes (-a / --all / a short-flag
 *  cluster containing 'a', e.g. -am / -av)? Uses the parsed command so flags in a sibling
 *  segment (like `grep -a`) are never misread. */
export function commitStagesAll(cmd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): boolean {
  if (!parsed || parsed.subcommand !== "commit") return false;
  if (parsed.args.includes("--all")) return true;
  return parsed.args.some((a) => /^-[A-Za-z]*a[A-Za-z]*$/.test(a));
}

/** Committed paths that are NOT docs/logs/site, or null if it can't be determined
 *  (fail-open). Covers staged files AND, when the command auto-stages (-a/-am), the
 *  tracked modifications `-a` will stage at commit time. */
async function offendingCommitPaths(pi: ExtensionAPI, cwd: string, cmd: string, parsed: ParsedGitCommand, governance: SessionGovernance): Promise<string[] | null> {
  const repoDir = gitRepoDir(cmd, cwd, parsed);
  const diff = async (extra: string[]): Promise<string[] | null> => {
    let res: { stdout: string; code: number };
    try {
      res = await pi.exec("git", ["-C", repoDir, ...extra], { cwd });
    } catch {
      return null; // not a repo / git missing → don't block
    }
    if (!res || res.code !== 0) return null;
    return String(res.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  };
  const staged = await diff(["diff", "--cached", "--name-only"]);
  if (staged === null) return null; // can't determine → fail open (old behavior)
  const files = [...staged];
  if (commitStagesAll(cmd, parsed)) {
    const modified = await diff(["diff", "--name-only"]); // -a will stage these
    if (modified) for (const f of modified) if (!files.includes(f)) files.push(f);
  }
  // `git commit <pathspec>` commits the WORKING-TREE content of the named paths,
  // ignoring the index — so a --cached-only check misses them entirely (the classic
  // pathspec bypass). Diff those paths vs HEAD to learn what the commit will include.
  const pathspecs = explicitCommitPathspecs(cmd, parsed);
  if (pathspecs.length) {
    const named =
      (await diff(["diff", "--name-only", "HEAD", "--", ...pathspecs])) ??
      (await diff(["diff", "--name-only", "--", ...pathspecs]));
    if (named) for (const f of named) if (!files.includes(f)) files.push(f);
  }
  // An earlier `git add` in the SAME command changes the index before the commit
  // runs, so the cached diff above is not the index the commit will see. Fold in
  // what that staging will add; when it cannot be established, name the whole
  // tree so the commit is refused rather than guessed (#282).
  const staging = precedingStagingPlan(cmd, cwd, parsed);
  if (staging) {
    const add = (list: string[] | null, fallback: string) => {
      if (list === null) { files.push(fallback); return; }
      for (const f of list) if (!files.includes(f)) files.push(f);
    };
    if (staging.everything || staging.tracked) {
      add(await diff(["diff", "--name-only", "HEAD"]), "<every tracked change>");
      if (staging.everything) add(await diff(["ls-files", "--others", "--exclude-standard"]), "<every untracked file>");
    }
    if (staging.pathspecs.length) {
      add(await diff(["diff", "--name-only", "HEAD", "--", ...staging.pathspecs]), staging.pathspecs.join(" "));
      add(await diff(["ls-files", "--others", "--exclude-standard", "--", ...staging.pathspecs]), staging.pathspecs.join(" "));
    }
    for (const f of staging.literal) if (!files.includes(f)) files.push(f);
  }
  if (!files.length) return null;
  const { allowed, denied } = commitPolicy(repoDir, governance);
  return files.filter((f) => !isAllowedCommitPath(f, allowed, denied));
}

// Fabric's MCP has no server-enforced read-only flag, and this hook can't see
// whether a given MCP call mutates (Power BI Modeling calls are classified by
// their operation instead; see below). As a best-effort layer we CONFIRM tool calls whose names look like a mutating
// Fabric/Power BI/MCP action (a refresh counts: it reprocesses a dataset or model on
// the client tenant). Approval-required mutations fail closed headlessly;
// this complements Pi approval and server-side read-only flags.
const MCP_TOOLISH =
  /(^|[_\-.:/])(mcp|fabric|powerbi|pbi|pbip|adx|kusto|eventhouse|onelake|lakehouse|warehouse|workspace|dataset|semanticmodel|report|pipeline|notebook|dataflow|capacity)([_\-.:/]|$)/i;
// A bare run/execute stays out: SQL run/execute tools are row reads that the
// live-read rules below govern. Running a pipeline, job, notebook, dataflow or
// Spark job changes the client tenant, so that pair counts as a write (#154).
const MCP_WRITE_VERB =
  /(^|[_\-.:/])(create|update|delete|remove|deploy|publish|drop|write|patch|overwrite|rename|truncate|grant|revoke|provision|refresh|upload|modify|reset|upsert|insert|merge|move|import|restore|cancel|assign|(?:run|trigger|start|execute)[_\-.:/]?(?:pipeline|job|notebook|dataflow|spark))([_\-.:/A-Z]|$)/i;
const DATA_SERVER = /(^|[_\-.:/])(fabric|powerbi|pbi|sql|database|db|warehouse|lakehouse|onelake|kusto|adx|eventhouse)([_\-.:/]|$)/i;
const ROW_READ_VERB = /(^|[_\-.:/])(query|execute|evaluate|run_sql|runsql|sql_query|dax_query|preview|sample|row|rows|record|records|data|export|download)([_\-.:/]|$)/i;
const PRODUCTION_WORD = /(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i;

// --- Production writes need a human's explicit permit (master plan G1) -----------
// G1 shipped a production WRITE as a hard block. Aaron, 2026-10-07: production
// writes may run when he explicitly permits them, through the human unlock he
// designed for it. So a production write never runs on the model's say-so: it is
// blocked unless a human unlock (`coop unlock-prod <client> --minutes <n>` in the
// person's own terminal, `<profile dir>/prod-unlock.json`) covers this session's
// client, and then each write is a yes/no at the desk (the phone never answers a
// PRODUCTION card). Every attempt is audited, allowed or refused, naming the grant.
// Never a session-wide approval, never headless. The model can neither run
// `coop unlock-prod` nor write the unlock file. Production READS keep the
// explicit-scope-plus-approval rule.
export const PROD_UNLOCK_FILE = "prod-unlock.json";
export type ProdUnlock = { id: string; client: string; expiresAt: number };

/** Parse the unlock file. Anything malformed, expired or over-long is no unlock. */
export function parseProdUnlock(text: string, now = Date.now()): ProdUnlock | null {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || raw.schema_version !== 1) return null;
    const id = typeof raw.id === "string" && /^[A-Za-z0-9-]{4,40}$/.test(raw.id) ? raw.id : "";
    const client = typeof raw.client === "string" ? raw.client.trim().slice(0, 160) : "";
    const expiresAt = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
    if (!id || !client || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
    // A grant is at most eight hours from when it was written; a longer one is refused.
    const createdAt = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
    if (!Number.isFinite(createdAt) || expiresAt - createdAt > 8 * 60 * 60 * 1000 || createdAt > now + 5 * 60 * 1000) return null;
    return { id, client, expiresAt };
  } catch {
    return null;
  }
}

/** The unlock covers this session when it names the contract's client (case-insensitive)
 *  or when the session has no contract client to compare, and when it still holds. */
export function prodUnlockApplies(unlock: ProdUnlock | null, contractClient: string, now = Date.now()): boolean {
  if (!unlock || unlock.expiresAt <= now) return false;
  const client = (contractClient || "").trim();
  if (!client) return true;
  return unlock.client.toLocaleLowerCase() === client.toLocaleLowerCase();
}

function readProdUnlock(): ProdUnlock | null {
  try {
    const p = join(coopProfileDir(), PROD_UNLOCK_FILE);
    if (!existsSync(p)) return null;
    return parseProdUnlock(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const prodUnlockMinutesLeft = (unlock: ProdUnlock, now = Date.now()) => Math.max(1, Math.ceil((unlock.expiresAt - now) / 60_000));
const PROD_WRITE_HEADLESS = "coop guardrails: blocked a production write. Production changes run only when a person confirms each one at the desk under their unlock, and this session cannot ask. Work on the dev target instead.";
const PROD_WRITE_LOCKED = "coop guardrails: blocked a production write. Production changes run only while a person has unlocked production with `coop unlock-prod <client>` in their own terminal, and then each write still asks at the desk. Work on the dev target, or ask the person to unlock production.";
const PROD_WRITE_DECLINED = "coop guardrails: blocked the production write (not permitted). Coop changes production only when you confirm that write yourself; work on the dev target, or ask again and confirm it when coop asks.";

export type ProductionVerdict = { decision: "allowed" | "declined" | "blocked-headless" | "blocked"; detail: string; reason: string };

/** Ask a person to permit one production write (G1). Desk-only: every message
 *  says PRODUCTION, which the phone companion never answers. Only under a human
 *  unlock that covers this session, and then a yes/no for each write; without
 *  one it is blocked with no prompt. */
export async function askProductionWrite(ctx: any, what: string, unlock: ProdUnlock | null, now = Date.now()): Promise<ProductionVerdict> {
  const shown = what.length > 300 ? `${what.slice(0, 300)}…` : what;
  if (unlock) {
    if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") return { decision: "blocked-headless", detail: `prod-unlock:${unlock.id}`, reason: PROD_WRITE_HEADLESS };
    const ok = await ctx.ui.confirm(
      "coop guardrails",
      `PRODUCTION write under unlock ${unlock.id} (${prodUnlockMinutesLeft(unlock, now)} min left):\n  ${shown}\nIt changes production now. Run it once?`,
    );
    return ok ? { decision: "allowed", detail: `prod-unlock:${unlock.id}`, reason: "" } : { decision: "declined", detail: `prod-unlock:${unlock.id}`, reason: PROD_WRITE_DECLINED };
  }
  return { decision: "blocked", detail: "no-unlock", reason: PROD_WRITE_LOCKED };
}

/** A shell command that grants or edits the production unlock: never from a session. */
export function touchesProdUnlock(cmd: string): boolean {
  return /\bunlock-prod\b/i.test(cmd) || /prod-unlock\.json/i.test(cmd);
}
const PROD_UNLOCK_SELF_BLOCK = "coop guardrails: blocked. Only a person grants the production unlock, with `coop unlock-prod` in their own terminal; a session never runs it or touches its file.";
const SQL_ENDPOINT_TOOL = /(^|[_\-.:/])(executeSQL|execute_query|fabric-sqlendpoint-execute_query|fabric_sqlendpoint_execute_query)([_\-.:/]|$)/i;
const MANAGED_SQL_SERVER = "fabric-sqlendpoint";
const FABRIC_SQL_FALLBACK_TOOL = "fabric_sql_query";
const SQL_IMPACT_TOOL = "sql_impact";
const CATALOG_SNAPSHOT_TOOL = "catalog_snapshot";
const SQL_MUTATION_VERB = /\b(ALTER|CREATE|DELETE|DENY|DROP|EXEC|EXECUTE|GRANT|INSERT|MERGE|RENAME|REPLACE|REVOKE|TRUNCATE|UPDATE|UPSERT)\b/i;
const SQL_MUTATING_INTO = /\b(?:SELECT|COPY)\b[\s\S]*?\bINTO\b/i;

function sqlWithoutComments(sql: string, preserveBracketIdentifiers = false): string {
  // Lex rather than regex-replace: comment delimiters inside SQL strings and
  // quoted identifiers are data, not comments. Literal/identifier contents are
  // blanked too, so words such as 'DELETE' do not create false mutations.
  let out = "";
  let i = 0;
  let state: "normal" | "single" | "double" | "bracket" | "line" | "block" = "normal";
  let blockDepth = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] || "";
    if (state === "normal") {
      if (ch === "-" && next === "-") { state = "line"; out += "  "; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; blockDepth = 1; out += "  "; i += 2; continue; }
      if (ch === "'") { state = "single"; out += " "; i += 1; continue; }
      if (ch === '"') { state = "double"; out += " "; i += 1; continue; }
      if (ch === "[") {
        state = "bracket";
        // Scope checks need an opaque identifier token so [db].[schema].[table]
        // cannot disappear before cross-database detection. Never retain its text.
        out += preserveBracketIdentifiers ? "__coop_bracket_identifier__" : " ";
        i += 1; continue;
      }
      out += ch; i += 1; continue;
    }
    if (state === "line") {
      if (ch === "\r" || ch === "\n") { state = "normal"; out += ch; } else out += " ";
      i += 1; continue;
    }
    if (state === "block") {
      if (ch === "/" && next === "*") { blockDepth += 1; out += "  "; i += 2; continue; }
      if (ch === "*" && next === "/") {
        blockDepth -= 1; out += "  "; i += 2;
        if (blockDepth === 0) state = "normal";
        continue;
      }
      out += ch === "\r" || ch === "\n" ? ch : " "; i += 1; continue;
    }
    const closing = state === "single" ? "'" : state === "double" ? '"' : "]";
    if (ch === closing && next === closing) { out += "  "; i += 2; continue; }
    if (ch === closing) { state = "normal"; out += " "; i += 1; continue; }
    out += ch === "\r" || ch === "\n" ? ch : " "; i += 1;
  }
  return out;
}

type MutationTarget = { outerTool: string; innerTool?: string; server?: string };

// --- Fabric MCP namespace routers (#171) -----------------------------------------
// coop runs @microsoft/fabric-mcp with `--mode namespace`, which exposes four router
// tools. Each takes {intent, command, parameters, learn}, and `command` is what runs.
// Checked against 1.3.0 and 1.4.0 offline on 2026-09-30 (tools/list and each
// router's learn=true command list): a router runs a command only on an exact
// match of one of its own commands, and never with learn=true; any other call
// returns its command list. Kebab-case names are 1.4.0's spelling of the same
// tools; 1.4.0 also lists the routers only when coop names their namespaces.
const FABRIC_ROUTERS = new Set(["docs", "onelake", "core", "datafactory"]);
const fabricCommandKey = (command: string) => command.trim().toLowerCase().replace(/-/g, "_");
/** Lookup key → the listed name, which becomes the inner tool the other rules see. */
function fabricCommands(names: string[]): Map<string, string> {
  return new Map(names.map((name) => [fabricCommandKey(name), name]));
}
const FABRIC_READ_COMMANDS = fabricCommands([
  "core_search-catalog", "datafactory_execute-query", "datafactory_get-pipeline", "datafactory_list-dataflows",
  "datafactory_list-pipelines", "docs_api-examples", "docs_best-practices", "docs_item-api-spec", "docs_item-definitions",
  "docs_list-item-types", "docs_platform-api-spec", "docs_workload-api-spec", "docs_workloads", "onelake_download-file",
  "onelake_get-data-access-role", "onelake_get-settings", "onelake_get-shortcut", "onelake_get-table",
  "onelake_get-principal-access", "onelake_get-table-config", "onelake_get-table-namespace",
  "onelake_list-data-access-roles", "onelake_list-files", "onelake_list-items", "onelake_list-items-dfs",
  "onelake_list-shortcuts", "onelake_list-table-namespaces", "onelake_list-tables", "onelake_list-workspaces",
]);
const FABRIC_WRITE_COMMANDS = fabricCommands([
  "core_create-item", "datafactory_create-dataflow", "datafactory_create-pipeline", "datafactory_run-pipeline",
  "onelake_create-directory", "onelake_create-or-update-data-access-role", "onelake_create-shortcut-adls-gen2",
  "onelake_create-shortcut-amazon-s3", "onelake_create-shortcut-azure-blob", "onelake_create-shortcut-dataverse",
  "onelake_create-shortcut-gcs", "onelake_create-shortcut-onedrive-sharepoint", "onelake_create-shortcut-onelake",
  "onelake_create-shortcut-s3-compatible", "onelake_delete-data-access-role", "onelake_delete-directory",
  "onelake_delete-file", "onelake_delete-shortcut", "onelake_modify-diagnostics", "onelake_modify-immutability-policy",
  "onelake_reset-shortcut-cache", "onelake_upload-file",
]);

type FabricRouted = { router: string; command: string; learn: boolean };

/** Point a Fabric router call's target at the command it runs. A known command
 * becomes the inner tool, so the name-based and live-read rules see the real
 * operation; an unknown one keeps the router's name and is classified below. */
function fabricRouted(call: { target: MutationTarget; args: any; proxy: boolean }):
  { target: MutationTarget; args: any; proxy: boolean; fabric?: FabricRouted } {
  const { server, innerTool } = call.target;
  if (!innerTool || !FABRIC_ROUTERS.has(innerTool) || (server !== undefined && server !== "fabric")) return call;
  const raw = call.args?.command;
  const command = typeof raw === "string" ? raw : "";
  const learn = call.args?.learn === true;
  const key = fabricCommandKey(command);
  const known = !learn && (FABRIC_READ_COMMANDS.get(key) || FABRIC_WRITE_COMMANDS.get(key));
  const target = known ? { ...call.target, innerTool: known } : call.target;
  return { ...call, target, fabric: { router: innerTool, command, learn } };
}

/** A Fabric router call's command and class, or null for any other call. Reads,
 * learn=true and calls without a command pass; a known write is an edit, except
 * deletes, which always ask; an unknown command always asks. */
function fabricRouterCall(event: any): { router: string; command: string; kind: ModelingOperationClass } | null {
  const routed = normalizeMcpCall(event).fabric;
  if (!routed) return null;
  const shown = routed.command.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (routed.learn || !routed.command) return { router: routed.router, command: shown, kind: "read" };
  const key = fabricCommandKey(routed.command);
  if (FABRIC_READ_COMMANDS.has(key)) return { router: routed.router, command: shown, kind: "read" };
  if (FABRIC_WRITE_COMMANDS.has(key) && !DESTRUCTIVE_VERB.test(key)) return { router: routed.router, command: shown, kind: "edit" };
  return { router: routed.router, command: shown, kind: "always-ask" };
}

// pi-mcp-adapter can also register every server tool directly (`directTools` on a
// server entry, which its /mcp-adapter panel can switch on) as `<server>_<tool>`.
// Those calls carry no {server, tool, args} envelope, so without this mapping a
// direct `fabric_onelake {command: onelake_create-directory}` or
// `azure-devops_wit_work_item_write` looked like an unknown tool and never reached
// the Fabric router or name-based mutation labels. Coop's generated config turns
// directTools off; this keeps the gate when a user turns it back on.
// Longer names first so `fabric-sqlendpoint_…` is not read as server `fabric`.
const DIRECT_TOOL_SERVERS = ["fabric-sqlendpoint", "powerbi-modeling-mcp", "microsoft-learn", "azure-devops", "fabric"];
function directToolServer(outerTool: string): string | null {
  if (outerTool === FABRIC_SQL_FALLBACK_TOOL) return null; // coop's own native tool
  for (const server of DIRECT_TOOL_SERVERS) {
    if (outerTool.length > server.length + 1 && outerTool.startsWith(server + "_")) return server;
  }
  return null;
}

/** Match the adapter's two dispatch shapes. Namespace wrappers bind their server
 * in the registered tool name; input.server cannot override that binding. Keep
 * unknown namespaces verbatim rather than guessing which underscores were hyphens. */
function normalizeMcpCall(event: any): { target: MutationTarget; args: any; proxy: boolean; fabric?: FabricRouted } {
  const outerTool = String(event?.toolName ?? "");
  const input = event?.input;
  const namespace = /^mcp__([A-Za-z0-9_]+)$/.exec(outerTool)?.[1];
  // Direct MCP tools may also start with mcp__; only an actual {tool, args}
  // envelope carries a dispatched inner operation. Otherwise retain direct args.
  const proxy = (outerTool === "mcp" || !!namespace) && typeof input?.tool === "string";
  if (!proxy) {
    const direct = directToolServer(outerTool);
    if (!direct) return { target: { outerTool }, args: input, proxy: false };
    const args = input && typeof input === "object" && !Array.isArray(input) ? input : undefined;
    return fabricRouted({ target: { outerTool, innerTool: outerTool.slice(direct.length + 1), server: direct }, args, proxy: false });
  }
  const server = namespace
    ? (namespace === "fabric_sqlendpoint" ? MANAGED_SQL_SERVER : namespace)
    : typeof input?.server === "string" ? input.server : undefined;
  const innerTool = typeof input?.tool === "string" ? input.tool : undefined;
  // Both dispatch paths ultimately use the adapter's object/JSON normalization.
  // Outer query/sql/arguments fields are not dispatched and must never shadow args.
  let args = input?.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = undefined;
  return fabricRouted({ target: innerTool ? { outerTool, innerTool, server } : { outerTool }, args, proxy: true });
}

/** The same target/argument normalization feeds mutation, SQL and grant checks. */
export function effectiveMutationTarget(event: any): MutationTarget {
  return normalizeMcpCall(event).target;
}

function callSqlText(event: any): string {
  const call = normalizeMcpCall(event);
  if (call.proxy && call.args) {
    const texts = ["sql", "query", "statement", "command"]
      .map((key) => call.args[key]).filter((value) => typeof value === "string");
    // Multiple SQL aliases cannot hide a mutation behind a benign first field.
    if (texts.length > 1) return texts.join(";\n");
  }
  return extractSqlText(call.args);
}

function mutationName(target: { outerTool: string; innerTool?: string; server?: string }): string {
  if (!target.innerTool) return target.outerTool;
  const prefix = target.server ? `${target.server}/` : "";
  return `${prefix}${target.innerTool}`;
}

/** Fixed labels prevent attacker-controlled server/tool strings from entering audit. */
function fixedLiveReadLabel(event: any): string {
  const target = effectiveMutationTarget(event);
  const name = `${target.server || ""} ${target.innerTool || target.outerTool}`;
  if (/powerbi|pbi/i.test(name)) return "Power BI governed read";
  if (/fabric|warehouse|lakehouse|sql/i.test(name)) return "Fabric governed read";
  return "governed live read";
}

/** Label a tool call that looks like a MUTATING MCP/Fabric/Power BI action, or null.
 *  Accepts either a raw tool name (for direct calls) or an effective target
 *  (for proxied `mcp` calls). Requires BOTH an MCP-ish name and a write verb,
 *  so reads (list/get/inspect) pass. */
export function mcpMutationLabel(toolName: string | { outerTool: string; innerTool?: string; server?: string }): string | null {
  const target = typeof toolName === "string" ? { outerTool: toolName } : toolName;
  const name = target.innerTool || target.outerTool;
  if (!name || (!target.innerTool && ["bash", "read", "edit", "write", "mcp"].includes(name))) return null;
  if (!MCP_WRITE_VERB.test(name)) return null;
  // A proxied call's server identity proves this is MCP; remote tool names need not
  // repeat a Fabric/Power BI noun (e.g. azure-devops/create_work_item).
  const viaAdapter = target.outerTool === "mcp" || target.outerTool.startsWith("mcp__") || !!directToolServer(target.outerTool);
  if (viaAdapter && target.innerTool && target.server) return mutationName(target);
  if (!MCP_TOOLISH.test(name)) return null;
  return mutationName(target);
}

// --- Power BI Modeling MCP operations (#159) ------------------------------------
// The Power BI Modeling (Authoring) MCP names its tools by object
// (`measure_operations`, `table_operations`, …) and carries the write in the
// argument `request.operation`, so the verb-in-the-name check never sees it.
// Classify the operation instead: reads pass, edits ask (a session approval can
// cover them), and deletes, imports over the model, deploys and unknown operations
// ask on every call. Checked against the 1.0.0 tool list.
const PBI_MODELING_TOOL =
  /(?:^|[_\-.:/])(measure|partition|perspective|transaction|relationship|trace|connection|object_translation|table|database|security_role|column|calendar|model|calculation_group|dax_query|named_expression|query_group|function|user_hierarchy|culture)_operations$/i;
const PBI_MODELING_SERVER = /powerbi[_\-]?modeling|powerbi[_\-]?authoring/i;
// Operations that change nothing in the model or on disk. Trace capture and
// connection handling are the server's own read-only tools.
const PBI_MODELING_READ = new Set([
  "help", "find", "exporttmdl", "exporttmsl", "validate", "report",
  "begin", "rollback",
  "connect", "connectfabric", "connectfolder", "connectbimfile", "disconnect",
  "start", "stop", "pause", "resume", "clear",
  "checkstatusofrefreshwithapi",
]);
// Operations that remove model objects, replace the whole model, or publish it.
const PBI_MODELING_ALWAYS_ASK = /^(delete|deploytofabric|importfromtmdlfolder|importfrombimfile)/;
// Operations that edit the model, a local file, or the server's cache.
const PBI_MODELING_EDIT =
  /^(create|update|rename|move|activate|deactivate|add|remove|reorder|refresh|cancelrefresh|markasdatetable|commit|clearcache|export(?:to|json))/;

export type ModelingOperationClass = "read" | "edit" | "always-ask";

/** The Power BI Modeling MCP tool this call targets, or null for any other call. */
function pbiModelingTool(target: MutationTarget): string | null {
  const name = target.innerTool || target.outerTool;
  if (!name || !PBI_MODELING_TOOL.test(name)) return null;
  // Another named server's `*_operations` tool is not this one; a call with no
  // server (bare or prefixed name) is classified, which can only add prompts.
  const server = target.server || /^mcp__([A-Za-z0-9_]+)$/.exec(target.outerTool)?.[1] || "";
  if (server && !PBI_MODELING_SERVER.test(server)) return null;
  return name;
}

/** Classify one Power BI Modeling operation. Unknown or missing operations ask
 * every time; `dax_query_operations` Execute is a row read (the live-read rules). */
export function classifyModelingOperation(tool: string, operation: unknown): ModelingOperationClass {
  const op = typeof operation === "string" ? operation.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
  if (!op) return "always-ask";
  if (/(^|_)dax_query_operations$/i.test(tool) && op === "execute") return "read";
  if (PBI_MODELING_ALWAYS_ASK.test(op)) return "always-ask";
  if (PBI_MODELING_READ.has(op) || /^(get|list)/.test(op)) return "read";
  if (PBI_MODELING_EDIT.test(op)) return "edit";
  return "always-ask";
}

/** A Power BI Modeling call's tool, operation and class, or null for other calls. */
function modelingCall(event: any): { tool: string; operation: string; kind: ModelingOperationClass } | null {
  const call = normalizeMcpCall(event);
  const tool = pbiModelingTool(call.target);
  if (!tool) return null;
  let request = call.args?.request;
  if (typeof request === "string") {
    try { request = JSON.parse(request); } catch { request = undefined; }
  }
  const raw = request && typeof request === "object" ? request.operation : call.args?.operation;
  const operation = typeof raw === "string" ? raw.replace(/[^A-Za-z]/g, "").slice(0, 40) : "";
  return { tool, operation, kind: classifyModelingOperation(tool, raw) };
}

/** Label a call that edits through an MCP server, or null for reads. Name-based
 * mutations come first; Power BI Modeling calls are classified by operation. */
export function mcpEditLabel(event: any): string | null {
  const target = effectiveMutationTarget(event);
  const byName = mcpMutationLabel(target);
  if (byName) return byName;
  const fabric = fabricRouterCall(event);
  if (fabric) return fabric.kind === "read" ? null : `fabric/${fabric.router} ${fabric.command || "(no command)"}`;
  const modeling = modelingCall(event);
  if (!modeling || modeling.kind === "read") return null;
  return `${mutationName(target)} ${modeling.operation || "(no operation)"}`;
}

/** True for a Power BI Modeling call that edits (asks), false for reads and other calls. */
export function isModelingEdit(event: any): boolean {
  const modeling = modelingCall(event);
  return !!modeling && modeling.kind !== "read";
}

/** True when a Power BI Modeling connection call names prod/production in any
 * argument (workspace, model, connection string). Later edits name only a
 * connection, so the session treats every model edit after it as production. */
export function modelingConnectsProduction(event: any): boolean {
  const call = normalizeMcpCall(event);
  const tool = pbiModelingTool(call.target);
  if (!tool || !/(^|_)connection_operations$/i.test(tool)) return false;
  let inputText = "";
  try { inputText = JSON.stringify(call.args || {}); } catch { return true; }
  return PRODUCTION_WORD.test(inputText);
}

export type LiveReadRisk = {
  label: string;
  kind: "row-data" | "production-metadata";
  environment: "production" | "dev/test/unspecified";
};

/** Classify approval-required live reads without retaining or logging arguments.
 * Dev/test/unspecified metadata calls (list/get/describe/schema/inspect) return null.
 * Query/execute/sample/export-style calls can return actual rows and always ask.
 * Any read whose tool identity or arguments explicitly name prod/production asks,
 * even when it appears metadata-only. Mutations are handled by mcpMutationLabel. */
export function mcpLiveReadRisk(event: any): LiveReadRisk | null {
  const target = effectiveMutationTarget(event);
  if (mcpEditLabel(event)) return null;
  const name = target.innerTool || target.outerTool;
  if (!name || ["bash", "read", "edit", "write", "mcp"].includes(name)) return null;
  const isDataRemote = DATA_SERVER.test(target.server || "") || MCP_TOOLISH.test(name);
  if (!isDataRemote) return null;
  let inputText = "";
  try { inputText = JSON.stringify(normalizeMcpCall(event).args || {}); } catch { inputText = ""; }
  const production = PRODUCTION_WORD.test(`${name} ${target.server || ""} ${inputText}`);
  const rows = ROW_READ_VERB.test(name);
  if (!production && !rows) return null;
  return {
    label: fixedLiveReadLabel(event),
    kind: rows ? "row-data" : "production-metadata",
    environment: production ? "production" : "dev/test/unspecified",
  };
}

export type SqlMcpRisk = {
  label: string;
  kind: "ddl-dml-destructive" | "ambiguous-sql" | "row-data";
};

function extractSqlText(input: any): string {
  if (!input || typeof input !== "object") return "";
  const direct = input.sql ?? input.query ?? input.statement ?? input.command;
  if (typeof direct === "string") return direct;
  const args = input.arguments ?? input.args ?? input.params?.arguments ?? input.params;
  if (typeof args === "string") {
    try { return extractSqlText(JSON.parse(args)); } catch { return ""; }
  }
  if (args && typeof args === "object") return extractSqlText(args);
  return "";
}

export type SqlOperation = "read" | "mutation" | "ambiguous";

/** Classify one SQL statement without treating quoted/comment text as executable SQL.
 * Only SELECT/CTE reads are recognized. EXEC, write verbs, SELECT/COPY INTO, and
 * multi-statement batches stay on the separate per-call gate; malformed or unfamiliar
 * syntax is ambiguous. Raw SQL is returned nowhere and is never grant state. */
export function classifySqlOperation(sql: string): SqlOperation {
  if (!sql || typeof sql !== "string") return "ambiguous";
  const masked = sqlWithoutComments(sql);
  // An unclosed quote/comment is not a recognizable read. The masker preserves the
  // opening delimiter as a blank, so validate closure independently and cheaply.
  let state: "normal" | "single" | "double" | "bracket" | "line" | "block" = "normal";
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1] || "";
    if (state === "normal") {
      if (ch === "-" && next === "-") { state = "line"; i++; }
      else if (ch === "/" && next === "*") { state = "block"; depth = 1; i++; }
      else if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "[") state = "bracket";
    } else if (state === "line") {
      if (ch === "\n" || ch === "\r") state = "normal";
    } else if (state === "block") {
      if (ch === "/" && next === "*") { depth++; i++; }
      else if (ch === "*" && next === "/") { depth--; i++; if (!depth) state = "normal"; }
    } else {
      const close = state === "single" ? "'" : state === "double" ? '"' : "]";
      if (ch === close && next === close) i++;
      else if (ch === close) state = "normal";
    }
  }
  if (state === "line") state = "normal";
  if (state !== "normal") return "ambiguous";
  if (SQL_MUTATION_VERB.test(masked) || SQL_MUTATING_INTO.test(masked)) return "mutation";
  if (/^\s*GO\s*$/im.test(masked)) return "ambiguous";
  const withoutTrailingTerminator = masked.trim().replace(/;\s*$/, "");
  if (withoutTrailingTerminator.includes(";")) return "mutation";
  if (!/^\s*(?:SELECT|WITH)\b/i.test(withoutTrailingTerminator)) return "ambiguous";
  return "read";
}

/** Warehouse SQL endpoint MCP calls are approval-gated even for SELECT. Mutating
 * SQL is classified before generic row-read handling and raw SQL is never logged. */
export function sqlMcpRisk(event: any): SqlMcpRisk | null {
  const target = effectiveMutationTarget(event);
  const name = target.innerTool || target.outerTool;
  const server = target.server || "";
  if (name !== FABRIC_SQL_FALLBACK_TOOL && !SQL_ENDPOINT_TOOL.test(name) && server !== MANAGED_SQL_SERVER) return null;
  const operation = classifySqlOperation(callSqlText(event));
  return {
    label: "COOP managed Warehouse SQL",
    kind: operation === "mutation" ? "ddl-dml-destructive" : operation === "ambiguous" ? "ambiguous-sql" : "row-data",
  };
}

export type LiveReadScope = {
  client: string;
  tenant: string;
  principal: string;
  environment: string;
  targets: string[];
  operationClass: string;
  resultLimit: number;
  timeoutMs: number;
  /** Prompt label when the scope came from the contract's sql_targets (SQ3). */
  label?: string;
};

export type LiveReadGrant = { scope: LiveReadScope; grantedAt: number };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FORBIDDEN_RESOLVED_TEXT = /(?:\bTODO\b|\bBearer\s+|(?:password|pwd|accountkey|access[_-]?token)\s*=|(?:jdbc|odbc):|Server\s*=.*;)/i;
const SAFE_DISPLAY_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._@&'()+-]{0,159}$/;
const PINNED_MCP_REQUEST_TIMEOUT_MS = 60_000;

function strictResolvedText(value: any, max = 160): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > max || !SAFE_DISPLAY_TEXT.test(v) || FORBIDDEN_RESOLVED_TEXT.test(v)) return null;
  return v;
}

/** Only the adapter's real proxy shape can reuse approval. */
function reusableSqlSurface(event: any): boolean {
  const target = effectiveMutationTarget(event);
  const call = normalizeMcpCall(event);
  const operation = (target.innerTool || "").replace(/-/g, "_");
  const prefixed = ["fabric_sqlendpoint_execute_query", "fabric_sqlendpoint_executeSQL"].includes(operation);
  const managedProxy = call.proxy && (target.server === MANAGED_SQL_SERVER
    || (target.outerTool === "mcp" && !target.server && prefixed));
  if (managedProxy && (prefixed || ["executeSQL", "execute_query"].includes(operation))) {
    const args = call.args;
    // Unknown execution controls cannot silently inherit a grant. The adapter's
    // target IDs are checked against trusted config below; model scope is ignored.
    return !!args && Object.keys(args).every((key) => ["sql", "query", "statement", "command",
      "workspaceId", "itemId", "coopLiveReadScope"].includes(key))
      && ["sql", "query", "statement", "command"].filter((key) => typeof args[key] === "string").length === 1;
  }
  if (target.outerTool !== FABRIC_SQL_FALLBACK_TOOL || target.innerTool) return false;
  const input = event?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return Object.keys(input).every((key) => key === "query" || key === "maximum_rows")
    && (input.maximum_rows === undefined || (Number.isInteger(input.maximum_rows) && input.maximum_rows >= 1 && input.maximum_rows <= 1000));
}

/** Admit one plain, literal-TOP SELECT, including bracket-delimited identifiers. */
export function boundedSelectLimit(sql: string): number | null {
  // Double-quote semantics depend on session settings; keep that syntax per-call.
  if (classifySqlOperation(sql) !== "read" || /"/.test(sql)) return null;
  const masked = sqlWithoutComments(sql, true).trim().replace(/;\s*$/, "");
  if (masked.includes("]")) return null; // unmatched closing identifier delimiter
  if (masked.includes(";") || (masked.match(/\bSELECT\b/gi) || []).length !== 1) return null;
  if (/\b(WITH|UNION|INTERSECT|EXCEPT|APPLY|EXEC(?:UTE)?|OPENROWSET|OPENQUERY|OPENDATASOURCE|BACKUP|RESTORE|DBCC|WAITFOR|USE|SET|DECLARE|BEGIN|COMMIT|ROLLBACK|SAVE|TRANSACTION|PRINT|RAISERROR|THROW|KILL|SHUTDOWN|BULK|OPTION|FOR|PERCENT)\b/i.test(masked)) return null;
  if (/\b[A-Za-z_][\w$#]*\s*\.\s*(?:[A-Za-z_][\w$#]*\s*)?\.\s*[A-Za-z_][\w$#]*\b/i.test(masked)) return null;
  const match = /^SELECT\s+(?:(?:ALL|DISTINCT)\s+)?TOP\s*(?:\(\s*([1-9]\d*)\s*\)|([1-9]\d*))\s+/i.exec(masked);
  const limit = match ? Number(match[1] || match[2]) : NaN;
  return Number.isSafeInteger(limit) ? limit : null;
}

/** The managed MCP config this Pi loaded: the launch folder's own copy that
 *  coop passed as --mcp-config (COOP_MCP_CONFIG, a `<agent dir>/mcp/<12 hex>.json`
 *  file), else the shared mcp-adapter.json. Anything else in the variable is
 *  ignored, so it can only ever point at coop's own generated files. */
export function managedMcpConfigPath(agentDir: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const configured = typeof env.COOP_MCP_CONFIG === "string" ? env.COOP_MCP_CONFIG : "";
  const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (configured && /^[0-9a-f]{12}\.json$/.test(basename(configured)) && same(resolve(dirname(configured)), resolve(agentDir, "mcp"))) return configured;
  return join(agentDir, "mcp-adapter.json");
}

export type LiveReadResolverDeps = {
  readText: (path: string) => string;
  agentDir: string;
  token: () => string | undefined;
  /** The trusted snapshot's `sql_targets` scope source (SQ3); absent means no section. */
  contract?: () => ContractSqlScope | null;
};

function launchIdentity(token: string | undefined): { tenant: string; principal: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const decoded = parts.map((part) => Buffer.from(part, "base64url"));
    if (decoded.some((part, index) => part.length === 0 || part.toString("base64url") !== parts[index])) return null;
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(decoded[1] as any)));
    const tenant = strictResolvedText(claims?.tid)?.toLowerCase();
    const principal = strictResolvedText(claims?.oid) || strictResolvedText(claims?.sub);
    return tenant && UUID.test(tenant) && principal ? { tenant, principal } : null;
  } catch { return null; }
}

/** Resolve grant identity only from COOP-owned config and the launch bearer. */
export function resolveLiveReadScope(event: any, deps: LiveReadResolverDeps): LiveReadScope | null {
  if (!reusableSqlSurface(event)) return null;
  if (event?.toolName === FABRIC_SQL_FALLBACK_TOOL) {
    const root = process.env.COOP_ROOT;
    if (!root || !existsSync(join(root, "lib", "sql_query.py"))) return null;
    // A contract with sql_targets drives lib/sql_query.py (SQ2), so its scope
    // comes from the trusted snapshot, never from the managed Fabric entry.
    const contract = deps.contract?.() ?? null;
    if (contract?.configured) return contractLiveReadScope(event, contract, deps);
  }
  let mcp: any;
  try { mcp = JSON.parse(deps.readText(managedMcpConfigPath(deps.agentDir))); } catch { return null; }
  // The adapter normalizes hyphens in server namespaces. An ambiguous namespace
  // must not acquire a grant using the managed server's otherwise valid metadata.
  const aliases = Object.keys(mcp?.mcpServers || {}).filter((name) => name.replace(/-/g, "_") === "fabric_sqlendpoint");
  if (aliases.length !== 1 || aliases[0] !== MANAGED_SQL_SERVER) return null;
  const managed = Array.isArray(mcp?._coop?.managed_servers) && mcp._coop.managed_servers.includes(MANAGED_SQL_SERVER);
  const entry = mcp?.mcpServers?.[MANAGED_SQL_SERVER];
  const target = entry?._coop_target;
  const client = strictResolvedText(target?.client);
  const tenant = strictResolvedText(target?.tenant_id)?.toLowerCase();
  const environment = strictResolvedText(target?.environment)?.toLowerCase();
  const itemName = strictResolvedText(target?.item_name);
  const workspaceId = typeof target?.workspace_id === "string" ? target.workspace_id.toLowerCase() : "";
  const itemId = typeof target?.item_id === "string" ? target.item_id.toLowerCase() : "";
  const identity = launchIdentity(deps.token());
  if (!managed || !entry || target?.scope !== "item" || !client || !tenant || !UUID.test(tenant)
      || !["dev", "test", "production"].includes(environment || "") || !itemName
      || !UUID.test(workspaceId) || !UUID.test(itemId) || !identity || identity.tenant !== tenant) return null;
  const args = normalizeMcpCall(event).args;
  if ((args?.workspaceId !== undefined && (typeof args.workspaceId !== "string" || args.workspaceId.toLowerCase() !== workspaceId))
      || (args?.itemId !== undefined && (typeof args.itemId !== "string" || args.itemId.toLowerCase() !== itemId))) return null;
  const expectedUrl = `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/${workspaceId}/items/${itemId}/sqlEndpoint`;
  const root = (globalThis as any).process?.env?.COOP_ROOT;
  const headerCommand = entry.requestHeadersCommand;
  const exactEntry = entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).sort().join(",") === "_coop_target,auth,lifecycle,requestHeadersCommand,requestTimeoutMs,url";
  const exactHeaderCommand = root && headerCommand && typeof headerCommand === "object" && !Array.isArray(headerCommand)
    && Object.keys(headerCommand).sort().join(",") === "args,command,timeoutMs"
    && headerCommand.command === "node"
    && Array.isArray(headerCommand.args) && headerCommand.args.length === 2
    && headerCommand.args[0] === join(root, "lib", "fabric_request_headers.mjs")
    && headerCommand.args[1] === expectedUrl
    && headerCommand.timeoutMs === 10000;
  if (!exactEntry || entry.url !== expectedUrl || entry.auth !== false || entry.lifecycle !== "lazy"
      || entry.requestTimeoutMs !== PINNED_MCP_REQUEST_TIMEOUT_MS || !exactHeaderCommand
  ) return null;
  let resultLimit = boundedSelectLimit(callSqlText(event));
  if (!resultLimit) return null;
  if (event?.toolName === FABRIC_SQL_FALLBACK_TOOL && Number.isInteger(event?.input?.maximum_rows)) {
    resultLimit = Math.min(resultLimit, event.input.maximum_rows);
  }
  return {
    client,
    tenant,
    principal: identity.principal,
    environment: environment!,
    targets: [`${workspaceId}/${itemId}/${itemName}`],
    operationClass: "sql-read",
    resultLimit,
    timeoutMs: PINNED_MCP_REQUEST_TIMEOUT_MS,
  };
}

/** Scope for a contract-driven read: the ready dev/test default entry, the
 *  contract's client, and the launch identity (whose tenant the contract's
 *  fabric.tenant_id must match when it names one). Targets are
 *  `kind/host/database` for direct kinds and `workspace/item/database` for
 *  discovered ones, so a Warehouse named both ways shares one grant. */
function contractLiveReadScope(event: any, contract: ContractSqlScope, deps: LiveReadResolverDeps): LiveReadScope | null {
  const target = contract.target;
  const client = strictResolvedText(contract.client);
  const identity = launchIdentity(deps.token());
  if (!target || !client || !identity) return null;
  if (contract.tenant && (!UUID.test(contract.tenant) || contract.tenant !== identity.tenant)) return null;
  const database = strictResolvedText(target.database);
  if (!database) return null;
  let resultLimit = boundedSelectLimit(callSqlText(event));
  if (!resultLimit) return null;
  if (Number.isInteger(event?.input?.maximum_rows)) resultLimit = Math.min(resultLimit, event.input.maximum_rows);
  const discovered = SQL_TARGET_KINDS[target.kind]?.discovered;
  const endpointId = target.kind === "fabric_lakehouse" ? target.sqlEndpointId : target.itemId;
  return {
    client,
    tenant: identity.tenant,
    principal: identity.principal,
    environment: target.environment,
    targets: [discovered ? `${target.workspaceId}/${endpointId}/${database}` : `${target.kind}/${target.server}/${database}`],
    operationClass: "sql-read",
    resultLimit,
    timeoutMs: PINNED_MCP_REQUEST_TIMEOUT_MS,
    label: `COOP contract SQL target (${target.kind}, ${target.environment})`,
  };
}

export type SqlImpactDecision = { action: "allow" | "prompt" | "block"; environment: string; reason: string };

/** sql_impact (SQ4) reads catalog metadata for one object on the executor's target.
 *  Dev/test metadata is read-only by default (guardrail 5), so it runs without a
 *  prompt when the trusted snapshot resolves a dev or test target: the contract's
 *  ready default entry, or the managed Fabric entry's environment when the
 *  contract has no sql_targets. Anything else asks once per call; a call that
 *  carries any field beyond `object` is blocked outright. */
export function decideSqlImpact(event: any, deps: LiveReadResolverDeps): SqlImpactDecision {
  const input = event?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).join(",") !== "object" || typeof input.object !== "string") {
    return { action: "block", environment: "", reason: "accepts exactly one field, object" };
  }
  return decideLiveMetadataRead(deps);
}

/** catalog_snapshot (SQ9) reads the whole catalog of the executor's dev/test
 *  target and writes it as files under the contract's snapshot folder. `status`
 *  reads only that folder and never connects, so it always runs; `snapshot` is
 *  the same live metadata read as sql_impact and follows the same rule. Any
 *  other field or command is blocked outright. */
export function decideCatalogSnapshot(event: any, deps: LiveReadResolverDeps): SqlImpactDecision {
  const input = event?.input ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { action: "block", environment: "", reason: "accepts only the field command" };
  }
  const keys = Object.keys(input);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "command")) {
    return { action: "block", environment: "", reason: "accepts only the field command" };
  }
  const command = keys.length ? input.command : "status";
  if (command === "status") return { action: "allow", environment: "", reason: "status reads the snapshot folder only" };
  if (command !== "snapshot") return { action: "block", environment: "", reason: "command must be status or snapshot" };
  return decideLiveMetadataRead(deps);
}

/** The target rule both live metadata tools share: a resolved dev or test target
 *  runs without a prompt, anything else asks. */
function decideLiveMetadataRead(deps: LiveReadResolverDeps): SqlImpactDecision {
  const contract = deps.contract?.() ?? null;
  if (contract?.configured) {
    if (contract.target) return { action: "allow", environment: contract.target.environment, reason: "contract sql_targets default" };
    return { action: "prompt", environment: "unresolved", reason: "the contract's sql_targets default is not a ready dev or test entry" };
  }
  const environment = managedSqlEnvironment(deps);
  if (environment === "dev" || environment === "test") return { action: "allow", environment, reason: "managed Fabric target" };
  return { action: "prompt", environment: environment || "unresolved", reason: environment === "production" ? "production target" : "no dev or test target resolved" };
}

/** The environment a SQL write would land in, from coop's trusted sources only
 *  (G1): the contract's ready `sql_targets` default for the native executor when
 *  the contract configures one (`unresolved` when its default is not a ready dev
 *  or test entry, which the executor refuses anyway), else the managed Fabric
 *  entry's environment. The call's own words never feed this. */
export function trustedWriteEnvironment(event: any, deps: LiveReadResolverDeps, contract: ContractSqlScope | null): string {
  const target = effectiveMutationTarget(event);
  const name = target.innerTool || target.outerTool;
  if (name === FABRIC_SQL_FALLBACK_TOOL && contract?.configured) return contract.target ? contract.target.environment : "unresolved";
  return managedSqlEnvironment(deps);
}

/** The environment coop's own managed-server config gives the Warehouse SQL
 *  endpoint (`_coop_target.environment` of the one `fabric-sqlendpoint` entry), or
 *  "" when the entry is absent, ambiguous or not managed. Tool arguments and SQL
 *  text never feed this: a production write without the word "prod" in it is
 *  still a production write (#283). */
export function managedSqlEnvironment(deps: LiveReadResolverDeps): string {
  try {
    const mcp = JSON.parse(deps.readText(managedMcpConfigPath(deps.agentDir)));
    const aliases = Object.keys(mcp?.mcpServers || {}).filter((name) => name.replace(/-/g, "_") === "fabric_sqlendpoint");
    if (aliases.length !== 1 || aliases[0] !== MANAGED_SQL_SERVER) return "";
    const managed = Array.isArray(mcp?._coop?.managed_servers) && mcp._coop.managed_servers.includes(MANAGED_SQL_SERVER);
    const environment = managed ? (strictResolvedText(mcp.mcpServers[MANAGED_SQL_SERVER]?._coop_target?.environment)?.toLowerCase() || "") : "";
    return ["dev", "test", "production"].includes(environment) ? environment : "";
  } catch { return ""; }
}

export function createLiveReadGrant(scope: LiveReadScope, now = Date.now()): LiveReadGrant {
  return { scope: { ...scope, targets: [...scope.targets] }, grantedAt: now };
}

function sameIdentity(a: string, b: string): boolean { return a.toLocaleLowerCase() === b.toLocaleLowerCase(); }

export function liveReadGrantMatches(grant: LiveReadGrant | null, requested: LiveReadScope): boolean {
  if (!grant) return false;
  const approved = grant.scope;
  if (!["client", "tenant", "principal", "environment", "operationClass"].every(
    (key) => sameIdentity((approved as any)[key], (requested as any)[key]),
  )) return false;
  const approvedTargets = new Set(approved.targets.map((t) => t.toLocaleLowerCase()));
  return requested.targets.every((t) => approvedTargets.has(t.toLocaleLowerCase()))
    && requested.resultLimit <= approved.resultLimit
    && requested.timeoutMs <= approved.timeoutMs;
}

export type LiveReadDecision = {
  action: "none" | "allow-grant" | "allow-dev" | "prompt-once" | "prompt-and-grant" | "separate-gate";
  label?: string;
  kind?: SqlMcpRisk["kind"] | LiveReadRisk["kind"];
  environment?: string;
  scope?: LiveReadScope;
};

/** The caller supplies only a runtime-resolved scope; tool arguments are never scope. */
export function decideLiveRead(event: any, grant: LiveReadGrant | null, resolvedScope: LiveReadScope | null = null): LiveReadDecision {
  const sql = sqlMcpRisk(event);
  const read = mcpLiveReadRisk(event);
  if (!sql && !read) return { action: "none" };
  const label = (sql?.kind === "row-data" && resolvedScope?.label) || sql?.label || read!.label;
  const kind = sql?.kind || read!.kind;
  const environment = resolvedScope?.environment || read?.environment;
  const targetName = (effectiveMutationTarget(event).innerTool || effectiveMutationTarget(event).outerTool).toLowerCase();
  if (sql && sql.kind !== "row-data") return { action: "separate-gate", label, kind, environment };
  if (/export|download/.test(targetName)) return { action: "separate-gate", label, kind, environment };
  if (!resolvedScope || resolvedScope.operationClass !== "sql-read") return { action: "prompt-once", label, kind, environment };
  // A provably read-only call (one plain SELECT with a literal TOP, the only shape
  // that resolves a scope) against a target the trusted config says is dev needs
  // no approval. Test and production, unbounded or ambiguous SQL, and every
  // mutation keep their gates.
  if (resolvedScope.environment === "dev") return { action: "allow-dev", label, kind, environment, scope: resolvedScope };
  if (liveReadGrantMatches(grant, resolvedScope)) return { action: "allow-grant", label, kind, environment, scope: resolvedScope };
  return { action: "prompt-and-grant", label, kind, environment, scope: resolvedScope };
}

// --- Session edit approvals (#156) ---------------------------------------------
// Approving an edit can cover the rest of the session for that MCP server, so a
// multi-step change asks once. Deletes and drops, anything that names production,
// and destructive or multi-statement Warehouse SQL still ask on every call.
const DESTRUCTIVE_VERB = /(^|[_\-.:/])(delete|remove|drop|truncate|purge|destroy|revoke)([_\-.:/A-Z]|$)/i;
const SQL_DESTRUCTIVE = /\b(DELETE|DROP|TRUNCATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE|DENY|RENAME)\b/i;

/** A single dev/test SQL write a session approval may cover: one INSERT, UPDATE,
 * CREATE or ALTER statement, with no delete, drop, truncate, merge, execute or
 * permission change anywhere in it. Quoted text and comments are not SQL. */
export function sqlWriteIsSessionApprovable(sql: string): boolean {
  if (classifySqlOperation(sql) !== "mutation") return false;
  const masked = sqlWithoutComments(sql).trim().replace(/;\s*$/, "");
  if (!masked || masked.includes(";") || /^\s*GO\s*$/im.test(masked)) return false;
  if (SQL_DESTRUCTIVE.test(masked) || SQL_MUTATING_INTO.test(masked)) return false;
  return /^\s*(?:INSERT|UPDATE|CREATE|ALTER)\b/i.test(masked);
}

/** The server a session approval covers for this edit, or null when the call must
 * ask every time: a delete or drop, anything naming prod/production, or Warehouse
 * SQL that a session approval never covers. Reads return null (they are not edits). */
export function sessionApprovalKey(event: any, environment?: string): string | null {
  const call = normalizeMcpCall(event);
  const target = call.target;
  const name = target.innerTool || target.outerTool;
  if (!name) return null;
  let inputText = "";
  try { inputText = JSON.stringify(call.proxy ? call.args || {} : event?.input || {}); } catch { inputText = ""; }
  if (environment === "production" || PRODUCTION_WORD.test(`${name} ${target.server || ""} ${inputText}`)) return null;
  const sql = sqlMcpRisk(event);
  if (sql) {
    if (sql.kind !== "ddl-dml-destructive" || !sqlWriteIsSessionApprovable(callSqlText(event))) return null;
    return `sql:${MANAGED_SQL_SERVER}`;
  }
  const fabric = fabricRouterCall(event);
  if (fabric) return fabric.kind === "edit" ? "mcp:fabric" : null;
  const modeling = modelingCall(event);
  if (modeling) {
    if (modeling.kind !== "edit") return null;
  } else if (!mcpMutationLabel(target) || DESTRUCTIVE_VERB.test(name)) return null;
  const namespace = /^mcp__([A-Za-z0-9_]+)$/.exec(target.outerTool)?.[1];
  return `mcp:${target.server || namespace || target.outerTool}`;
}

/** The words a production-write decision reads for an MCP mutation: server, tool
 *  and arguments, exactly what sessionApprovalKey reads. Never logged. */
function mutationCallText(event: any, target: MutationTarget): string {
  const call = normalizeMcpCall(event);
  const name = target.innerTool || target.outerTool || "";
  let inputText = "";
  try { inputText = JSON.stringify(call.proxy ? call.args || {} : event?.input || {}); } catch { inputText = ""; }
  return `${name} ${target.server || ""} ${inputText}`;
}

/** Human label for an approval key: the server name without its kind prefix. */
export function sessionApprovalLabel(key: string): string {
  return key.replace(/^(?:mcp|sql):/, "");
}

export type EditApprovalChoice = "once" | "session" | "declined";
export const APPROVE_ONCE = "Allow once";
export const APPROVE_DECLINE = "Decline";
export const approveSessionOption = (key: string) => `Allow ${sessionApprovalLabel(key)} edits for this session (deletes still ask; production always asks)`;

/** Ask for an edit. With an approvable key and a select dialog, offer once / this
 * session / decline; otherwise a plain yes/no that approves once. */
export async function askEditApproval(ctx: any, title: string, message: string, key: string | null): Promise<EditApprovalChoice> {
  if (key && typeof ctx?.ui?.select === "function") {
    const picked = await ctx.ui.select(`${title}\n${message}`, [APPROVE_ONCE, approveSessionOption(key), APPROVE_DECLINE]);
    if (picked === APPROVE_ONCE) return "once";
    if (picked === approveSessionOption(key)) return "session";
    return "declined";
  }
  return (await ctx.ui.confirm(title, message)) ? "once" : "declined";
}

/** Hard-block reasons for commit forms whose contents cannot be policy-checked:
 *  --amend rewrites an existing commit; pathspec-file forms commit paths the
 *  guardrail deliberately does not read. */
export function usesCommitPathspecFile(git: ParsedGitCommand): boolean {
  return git.args.some(
    (a) => a === "--pathspec-from-file" || a === "--pathspec-file-nul" || a.startsWith("--pathspec-from-file="),
  );
}

export function commitHardBlockReason(git: ParsedGitCommand): string | null {
  if (git.args.some((a) => a === "--amend")) return "git commit --amend";
  if (usesCommitPathspecFile(git)) return "git commit --pathspec-from-file";
  return null;
}

/** Label a destructive bash command, or null. Conservative — only clearly risky ops. */
function dangerLabel(cmd: string): string | null {
  for (const git of parseGitCommands(cmd)) {
    const args = git.args;
    if (git.subcommand === "push" && args.some((a) => a === "--force" || a === "--force-with-lease" || /^-[A-Za-z]*f[A-Za-z]*$/.test(a) || a.startsWith("+"))) return "git push --force";
    if (git.subcommand === "reset" && args.includes("--hard")) return "git reset --hard";
    if (git.subcommand === "clean" && args.some((a) => a === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(a))) return "git clean -f";
  }
  // rm with BOTH recursive and force flags (single-file rm is fine), SEGMENT-SCOPED:
  // flags from sibling commands (`rm x && grep -rf y .`) must never classify as rm.
  for (const { segment } of splitShellSegments(cmd)) {
    const toks = tokenizeArgs(segment);
    if (!toks.some((t) => t.replace(/['"]/g, "").split("/").pop()?.toLowerCase() === "rm")) continue;
    // Dash-prefixed tokens of THIS segment only (never the literal "rm" itself).
    const flagTokens = toks.filter((t) => t.startsWith("-"));
    // Short-flag clusters (e.g. -rf, -fr) carry their letters after a single dash.
    const shortFlags = flagTokens.filter((t) => !t.startsWith("--")).join("");
    const longFlags = flagTokens.filter((t) => t.startsWith("--")).join(" ");
    const recursive = /r/i.test(shortFlags) || /--recursive\b/i.test(longFlags);
    const force = /f/i.test(shortFlags) || /--force\b/i.test(longFlags);
    if (recursive && force) return "rm -rf";
  }
  if (/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER|SEQUENCE|TYPE)\b/i.test(cmd)) return "destructive SQL (DROP/TRUNCATE)";
  return null;
}

/** Fabric CLI subcommands that create, change, or delete tenant state. `ls`, `get`,
 *  `exists`, `export` (writes local files), `open` and `auth` are reads or local. */
const FAB_WRITE_SUBCOMMANDS = new Set([
  "deploy", "mkdir", "rm", "cp", "mv", "set", "import", "assign", "unassign",
  "job", "acl", "label", "start", "stop", "ln",
]);
const HTTP_READ_METHODS = new Set(["get", "head", "options"]);

/** Rayfin (Fabric Apps) `up` subcommands that only read or switch local state;
 *  every other `up` form deploys to Fabric. Bare `up` creates the Fabric app item
 *  and can create a workspace or assign capacity. */
const RAYFIN_UP_READS = new Set(["status", "list", "switch"]);

/** Label a Rayfin CLI write to Fabric, or null. `toks[i]` is the program. Reads and
 *  local work (`init`, `dev`, `env`, `docs`, `connector search|inspect|add`, `login`,
 *  `up --dry-run`, `up status|list|switch`, `secret list`) pass. */
function rayfinWriteLabel(toks: string[], i: number): string | null {
  const sub = (toks[i + 1] || "").toLowerCase();
  const rest = toks.slice(i + 2);
  const sub2 = rest.find((t) => !t.startsWith("-"))?.toLowerCase() || "";
  if (sub === "up") {
    const nested = rest[0] && !rest[0].startsWith("-") ? rest[0].toLowerCase() : "";
    if (!nested) return rest.some((t) => t === "-n" || t === "--dry-run") ? null : "rayfin up";
    if (RAYFIN_UP_READS.has(nested)) return null;
    return `rayfin up ${nested}`;
  }
  if ((sub === "secret" || sub === "secrets") && sub2 !== "list" && sub2 !== "") return `rayfin secret ${sub2}`;
  return null;
}

/** Index of the Rayfin program in `toks` (after `npx [-y]`, `npm exec [--]`,
 *  `pnpm [exec|dlx]`, `yarn [dlx]`, `bunx`), or -1. */
function rayfinProgramIndex(toks: string[], i: number): number {
  const base = (t: string) => (t || "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|exe|ps1)$/, "") || "";
  let j = i;
  const launcher = base(toks[j]);
  if (launcher === "npx" || launcher === "bunx") j++;
  else if (launcher === "npm" && (toks[j + 1] === "exec" || toks[j + 1] === "x")) j += 2;
  else if ((launcher === "pnpm" || launcher === "yarn") && (toks[j + 1] === "exec" || toks[j + 1] === "dlx")) j += 2;
  else if (launcher === "pnpm" || launcher === "yarn") j++;
  while (j < toks.length && /^(-y|--yes|--)$/.test(toks[j])) j++;
  const prog = base(toks[j]).replace(/@[^@/]+$/, "");
  return prog === "rayfin" || prog === "rayfin-cli" ? j : -1;
}

/** The deploy prompt's target line: the contract's dev workspace and what the
 *  command targets, with a warning when they differ. */
export function rayfinTargetNote(cmd: string, devWorkspaceId: string): string {
  const target = rayfinWorkspaceTarget(cmd);
  const line = `Contract dev workspace: ${devWorkspaceId || "(not set)"}; command targets: ${target || "its recorded deployment, or a new workspace"}.\n`;
  return devWorkspaceId && target && target.toLowerCase() !== devWorkspaceId ? `${line}WARNING: that is not the contract's dev workspace.\n` : line;
}

/** The workspace a `rayfin` command names (`--workspace-id`, `--workspace`,
 *  `--workspace-uri`), or null when it relies on its recorded deployment. */
export function rayfinWorkspaceTarget(cmd: string): string | null {
  for (const { segment } of splitShellSegments(cmd)) {
    const toks = tokenizeArgs(segment.trim()).map((t) => t.replace(/^['"]|['"]$/g, ""));
    const value = optionValue(toks, ["--workspace-id", "--workspace", "--workspace-uri"]);
    if (value) return value;
  }
  return null;
}

/** Value of a `--flag value` / `--flag=value` / `-X value` option, or null. */
function optionValue(toks: string[], names: string[]): string | null {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].replace(/^['"]|['"]$/g, "");
    for (const n of names) {
      if (t === n) return i + 1 < toks.length ? toks[i + 1].replace(/^['"]|['"]$/g, "") : null;
      if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return null;
}

/** Label a Fabric / Azure REST write issued from the shell, or null. The official
 *  Microsoft Fabric skills drive item create/update/deploy/delete with
 *  `az rest --method post|patch|put|delete`, `fab api -X post ...` and `fab deploy`;
 *  none of those are MCP calls, so the MCP mutation gate never sees them. Rayfin
 *  (`npx rayfin up`, Fabric Apps) deploys the same way. Reads (`--method get`,
 *  `fab api <path>`, `fab ls`, `rayfin up --dry-run`) pass. Segment-scoped and quote-aware:
 *  `echo "az rest --method post"` is one quoted token, not a command. */
export function fabricWriteLabel(cmd: string): string | null {
  for (const { segment } of splitShellSegments(cmd)) {
    const toks = tokenizeArgs(segment.trim()).map((t) => t.replace(/^['"]|['"]$/g, ""));
    // Skip env assignments and `sudo`/`command` prefixes to reach the program name.
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || toks[i] === "sudo" || toks[i] === "command")) i++;
    const prog = (toks[i] || "").split("/").pop()?.toLowerCase() || "";
    const sub = (toks[i + 1] || "").toLowerCase();
    const rest = toks.slice(i + 2);
    if (prog === "az" && sub === "rest") {
      const method = (optionValue(rest, ["--method", "-m"]) || "get").toLowerCase();
      if (!HTTP_READ_METHODS.has(method)) return `az rest ${method.toUpperCase()}`;
    } else if (prog === "fab" || prog === "fab.exe") {
      if (sub === "api") {
        const method = (optionValue(rest, ["-X", "--method"]) || "get").toLowerCase();
        if (!HTTP_READ_METHODS.has(method)) return `fab api ${method.toUpperCase()}`;
      } else if (FAB_WRITE_SUBCOMMANDS.has(sub)) {
        return `fab ${sub}`;
      }
    } else {
      const r = rayfinProgramIndex(toks, i);
      const label = r >= 0 ? rayfinWriteLabel(toks, r) : null;
      if (label) return label;
    }
  }
  return null;
}

// --- Power BI Desktop reload guard (S31) ------------------------------------------
// The Desktop Bridge's `reload` discards unsaved Desktop edits unconditionally (its
// README says so), and the Report Authoring CLI's `preview` reloads the live window
// through the same bridge. Until now coop's only protection was the skill text
// ("run status first; stop on hasUnsavedChanges"). This gate enforces it: before a
// reload runs, coop reads `powerbi-desktop status` itself and asks (fails closed
// headlessly) when the targeted instance has unsaved changes, and blocks when the
// instance cannot be verified at all. Status output is read, never the command.

/** A Desktop reload found in a bash command: which instance it targets (by `--pid`
 *  or by the preview's `.Report` folder), or null when nothing reloads Desktop. */
export type DesktopReloadTarget = { label: string; pid: string | null; folder: string | null };

const PREVIEW_NON_RELOAD_FLAGS = new Set(["--status", "--close", "--close-all", "--list-hosts", "--screenshot"]);

export function desktopReloadTarget(cmd: string): DesktopReloadTarget | null {
  for (const { segment } of splitShellSegments(cmd)) {
    const toks = tokenizeArgs(segment.trim()).map((t) => t.replace(/^['"]|['"]$/g, ""));
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || toks[i] === "sudo" || toks[i] === "command" || toks[i] === "npx" || (toks[i - 1] === "npx" && /^(-y|--yes)$/.test(toks[i])))) i++;
    const prog = (toks[i] || "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|exe|ps1)$/, "") || "";
    const sub = (toks[i + 1] || "").toLowerCase();
    const rest = toks.slice(i + 2);
    if (prog === "powerbi-desktop" && sub === "reload") {
      return { label: "powerbi-desktop reload", pid: optionValue(rest, ["--pid"]), folder: null };
    }
    if (prog === "powerbi-report-author" && sub === "preview") {
      if (rest.some((t) => PREVIEW_NON_RELOAD_FLAGS.has(t) || [...PREVIEW_NON_RELOAD_FLAGS].some((f) => t.startsWith(`${f}=`)))) continue;
      if ((optionValue(rest, ["--host"]) || "desktop").toLowerCase() !== "desktop") continue;
      let folder: string | null = null;
      for (let j = 0; j < rest.length; j++) {
        const t = rest[j];
        if (t.startsWith("-")) { if (!t.includes("=") && /^--(host|group|dataset|scale)$/.test(t)) j++; continue; }
        folder = t;
        break;
      }
      const flag = rest.includes("--reload-with-model") ? " --reload-with-model" : rest.includes("--reload") ? " --reload" : "";
      return { label: `powerbi-report-author preview${flag}`, pid: null, folder };
    }
  }
  return null;
}

/** The `.Report` folder name that identifies a report, lower-cased: from a `.Report`
 *  folder path or a `.pbip`/`.pbix` file path (trailing separators ignored). */
function reportKey(path: string): string {
  const base = (path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "").toLowerCase();
  return base.replace(/\.(pbip|pbix)$/, ".report");
}

/** How to run `powerbi-desktop status` through `pi.exec` (which spawns without a
 *  shell). The npm global install on Windows is a `powerbi-desktop.cmd` shim that
 *  a shell-less spawn cannot start, so locate the shim's package on PATH and run
 *  its `dist/cli.js` with the node that runs Pi. Elsewhere the shim is a script. */
export function desktopStatusCommand(
  pid: string | null,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  exists: (path: string) => boolean = existsSync,
  node: string = process.execPath,
): { bin: string; args: string[] } {
  const args = ["status", ...(pid ? ["--pid", pid] : [])];
  if (platform !== "win32") return { bin: "powerbi-desktop", args };
  const dirs = String(env.PATH || env.Path || "").split(";").map((d) => d.trim()).filter(Boolean);
  for (const dir of dirs) {
    if (!exists(join(dir, "powerbi-desktop.cmd"))) continue;
    const cli = join(dir, "node_modules", "@microsoft", "powerbi-desktop-bridge-cli", "dist", "cli.js");
    if (exists(cli)) return { bin: node, args: [cli, ...args] };
  }
  return { bin: "powerbi-desktop", args };
}

export type DesktopReloadDecision =
  | { action: "allow"; pid: string }
  | { action: "ask"; pid: string; file: string }
  | { action: "block"; reason: string };

/** Decide a Desktop reload from `powerbi-desktop status` output. Fails closed: an
 *  unreadable status, a missing or unconnected instance, or an unstated unsaved
 *  flag blocks; `hasUnsavedChanges: true` asks; only a connected, clean instance
 *  passes. Without `--pid` the preview's `.Report` folder picks the instance; when
 *  nothing identifies one, every connected instance must be clean. */
export function decideDesktopReload(statusJson: string, target: DesktopReloadTarget): DesktopReloadDecision {
  let parsed: any;
  try { parsed = JSON.parse(statusJson); } catch { return { action: "block", reason: "`powerbi-desktop status` printed no readable JSON" }; }
  const instances: any[] = Array.isArray(parsed?.instances) ? parsed.instances : [];
  const connected = instances.filter((x) => x && x.bridgeStatus === "connected");
  const judge = (inst: any): DesktopReloadDecision => {
    const pid = String(inst.pid);
    const file = String(inst.currentFilePath || inst.reportDir || "");
    if (inst.hasUnsavedChanges === true) return { action: "ask", pid, file };
    if (inst.hasUnsavedChanges === false) return { action: "allow", pid };
    return { action: "block", reason: `Desktop instance ${pid} did not report its unsaved-changes state` };
  };
  if (target.pid) {
    const inst = instances.find((x) => x && String(x.pid) === String(target.pid));
    if (!inst) return { action: "block", reason: `no Desktop Bridge instance with pid ${target.pid}` };
    if (inst.bridgeStatus !== "connected") return { action: "block", reason: `Desktop instance ${target.pid} is ${inst.bridgeStatus || "not connected"}` };
    return judge(inst);
  }
  if (!connected.length) return { action: "block", reason: "no connected Power BI Desktop instance" };
  if (target.folder) {
    const want = reportKey(target.folder);
    const matches = connected.filter((x) => reportKey(String(x.reportDir || "")) === want || reportKey(String(x.currentFilePath || "")) === want);
    if (matches.length === 1) return judge(matches[0]);
  }
  const dirty = connected.map(judge).find((d) => d.action !== "allow");
  return dirty || { action: "allow", pid: connected.map((x) => String(x.pid)).join(",") };
}

/** Does this path look like a secret (private key / credential / .env) the agent
 *  shouldn't read or write? Public keys (.pub) and *.example/.sample are excluded. */
export function isSecretPath(p: string): boolean {
  const base = (p.split(/[/\\]/).pop() || "").toLowerCase();
  if (base.endsWith(".pub")) return false; // public keys are fine
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(base)) return true;
  if (/^(\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials)$/.test(base)) return true;
  if (base === PROD_UNLOCK_FILE) return true; // the human-only production unlock (G1)
  if (/(^|[._-])secrets?([._-]|$)/.test(base) && /\.(ya?ml|json|env|txt|conf|ini)$/.test(base)) return true;
  return false;
}

/** First secret-looking path token in a bash command, or null. Mirrors the
 *  read/edit/write secret gate so bash isn't an unguarded exfil path
 *  (`cat .env`, `cp .env /tmp`, `curl -F f=@.env`, `base64 .env`, `>.env`). */
export function bashSecretCmdPath(cmd: string): string | null {
  for (let t of tokenizeArgs(cmd)) {
    t = t.replace(/^\d*[<>&]+/, "");         // strip redirection operators (>.env, <.env, 2>.env, &>.env)
    const at = t.lastIndexOf("@");       // curl -F field=@.env / scp x@host — take the tail
    const cand = at >= 0 ? t.slice(at + 1) : t;
    if (cand && isSecretPath(cand)) return cand;
  }
  return null;
}

// --- Audit trail ----------------------------------------------------------------
// An append-only JSONL record of what the guardrails blocked/confirmed, WHEN, and in
// WHICH repo. For a governed, review-first practice this is direct client-trust value
// and the fastest way to debug a false positive (e.g. the git -C / pathspec / cd family
// that has needed several rounds of fixes). The secret gate logs only the matched path,
// never file contents; command gates record fixed classifications, never command text.
// Logging is best-effort and cannot change the enforcement decision.
const AUDIT_MAX_BYTES = 1_000_000;
function auditDir(): string {
  // The agent dir Pi actually loads (the one chain in lib/paths.mjs).
  return coopAgentDir();
}
function auditPath(): string {
  return join(auditDir(), "guardrails-audit.jsonl");
}
type AuditEntry = {
  ts?: string;     // set by audit() on write; present on every read
  cwd: string;
  // project-share rows are written by lib/project-share.mjs ("Share with the team", C1).
  kind: "commit-block" | "danger-confirm" | "secret-confirm" | "mcp-confirm" | "project-share" | "lineage-gate";
  tool: string;
  decision: "blocked" | "blocked-headless" | "allowed" | "declined";
  label: string;   // the short subject (offending path, danger label, tool name)
  detail: string;  // offending paths (commit, first 8) or a fixed classification; never command text
  pid?: number;    // the coop process that decided: each window tab runs its own, so this tells tabs apart
};
// Older versions persisted command text in these records. Minimize both new writes
// and displayed history without rewriting or deleting the existing audit file.
function withoutCommandDetail(entry: AuditEntry): AuditEntry {
  const commandDetail = entry.kind === "danger-confirm" || (entry.kind === "commit-block" &&
    ["git commit --amend", "git commit --pathspec-from-file", "unverifiable git commit"].includes(entry.label));
  return commandDetail ? { ...entry, detail: entry.label } : entry;
}
function audit(entry: AuditEntry): void {
  try {
    appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), ...withoutCommandDetail(entry), pid: process.pid }) + "\n");
  } catch {
    /* fail-open — a logging failure must never block legitimate work */
  }
}
// Best-effort size cap: on load, roll a >1 MB log to .jsonl.1 so it can't grow unbounded.
function rotateAuditIfLarge(): void {
  try {
    const p = auditPath();
    if (existsSync(p) && statSync(p).size > AUDIT_MAX_BYTES) renameSync(p, p + ".1");
  } catch {
    /* best-effort */
  }
}
// The last `n` audit entries (newest last), parsed. Empty on any read/parse trouble.
function readAuditTail(n: number): AuditEntry[] {
  try {
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter((l) => l.trim());
    return lines.slice(-n).map((l) => withoutCommandDetail(JSON.parse(l)));
  } catch {
    return [];
  }
}

export default function coopGuardrails(pi: ExtensionAPI) {
  const enabled = () => process.env.COOP_NO_GUARDRAILS !== "1";
  const showUpstreamUpdates = () => process.env.COOP_SHOW_UPSTREAM_UPDATE_NOTICES === "1";
  // Closure-owned: one extension instance can hold one grant for its current Pi
  // session. Nothing is serialized into messages, disk, config, or audit output.
  let liveReadGrant: LiveReadGrant | null = null;
  // Session edit approvals (#156): server keys only, never arguments or SQL.
  const editApprovals = new Set<string>();
  // Set once the session connects the Power BI Modeling MCP to anything naming
  // production; from then on every model edit asks (#159).
  let modelingProduction = false;
  const liveReadDeps: LiveReadResolverDeps = {
    readText: (path) => readFileSync(path, "utf8"),
    agentDir: auditDir(),
    token: () => (globalThis as any).process?.env?.COOP_FABRIC_MCP_TOKEN,
  };
  rotateAuditIfLarge();
  // G1: the human unlock, re-read on every production write (it expires on its
  // own and `coop unlock-prod --revoke` deletes it); matched to the trusted
  // contract's client so one client's grant never covers another's session.
  const activeProdUnlock = (ctx: ExtensionContext): ProdUnlock | null => {
    const unlock = readProdUnlock();
    return prodUnlockApplies(unlock, ensureSessionGovernance(ctx.cwd).sqlContract?.client || "") ? unlock : null;
  };
  // G1: one production write, permitted by a person (a yes/no under their unlock)
  // and audited either way. Null when it may run.
  const permitProductionWrite = async (ctx: ExtensionContext, kind: string, tool: string, what: string) => {
    const verdict = await askProductionWrite(ctx, what, activeProdUnlock(ctx));
    // Shell records keep no detail of their own (it could carry command text), so the permit rides the label there.
    audit({ cwd: ctx.cwd, kind, tool, decision: verdict.decision, label: kind === "danger-confirm" ? `production write (${verdict.detail})` : "production write", detail: verdict.detail });
    return verdict.decision === "allowed" ? null : { block: true, reason: verdict.reason };
  };
  // One Pi process can serve multiple sessions (/new, /resume, /fork fire
  // session_shutdown + session_start without reloading this module). Drop the
  // stale governance snapshot so THIS session's project contract is re-read on
  // its next governed call — never carry policy across session switches.
  pi.on("session_start", async () => {
    resetSessionGovernance();
    liveReadGrant = null;
    editApprovals.clear();
    modelingProduction = false;
  });
  pi.on("session_shutdown", async () => {
    liveReadGrant = null;
    editApprovals.clear();
    modelingProduction = false;
  });

  /** The SQ8 edit gate: a live target is one sql_impact would answer on without
   *  a prompt (the contract's sql_targets, or a managed dev/test Fabric entry). */
  function decideSqlEditGate(path: string, content: string, ctx: ExtensionContext): { action: "allow" | "block"; object?: string; reason?: string } {
    try {
      const contract = ensureSessionGovernance(ctx.cwd).sqlContract;
      const managed = managedSqlEnvironment(liveReadDeps);
      const liveTarget = Boolean(contract?.configured) || managed === "dev" || managed === "test";
      return editGateDecision(ctx.cwd, isAbsolute(path) ? path : resolve(ctx.cwd, path), content, { liveTarget });
    } catch {
      return { action: "allow" };
    }
  }

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    try {
      if (!enabled()) return;
      const tool = event?.toolName;

      // 0a. pi-mcp-adapter's mcpScript runs JavaScript that calls MCP tools inside
      // the adapter, where this hook never sees them, so no MCP mutation or
      // Warehouse SQL check could apply. Coop's generated MCP config turns it off;
      // block it too in case a project or user config turns it back on.
      if (tool === "mcpScript") {
        audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "mcpScript", decision: "blocked", label: "MCP script", detail: "script-mode" });
        return { block: true, reason: "coop guardrails: blocked mcpScript. Its MCP calls run inside the adapter where coop's read-only MCP checks cannot see them. Call MCP tools one at a time with the mcp tool instead." };
      }

      // 0a'. Pi's optional `powershell` tool is off by default, but a user's settings,
      // a trusted project's settings or --tools can turn it on. The shell checks
      // below parse bash, so none of them (secret files, git commits, destructive
      // commands) would see a PowerShell command. Show each one and ask; fail
      // closed headlessly (#166). The audit records a fixed label, never the command.
      if (tool === "powershell") {
        const command = String(event?.input?.command ?? "");
        if (touchesProdUnlock(command)) {
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool, decision: "blocked", label: "production unlock", detail: "prod-unlock-self" });
          return { block: true, reason: PROD_UNLOCK_SELF_BLOCK };
        }
        if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool, decision: "blocked-headless", label: "PowerShell command", detail: "powershell" });
          return { block: true, reason: "coop guardrails: blocked a PowerShell command. coop's shell checks cover bash only, and approval is unavailable in headless mode. Use the bash tool." };
        }
        const shown = command.length > 600 ? `${command.slice(0, 600)}…` : command;
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `Run this PowerShell command?\n  ${shown}\ncoop's shell checks (secret files, git commits, destructive commands) cover bash only, so every PowerShell command asks.`,
        );
        audit({ cwd: ctx.cwd, kind: "danger-confirm", tool, decision: ok ? "allowed" : "declined", label: "PowerShell command", detail: "powershell" });
        if (!ok) return { block: true, reason: "coop guardrails: blocked the PowerShell command (you declined). Use the bash tool, which coop's shell checks cover." };
        return;
      }

      // 0. Secret-file access (read / edit / write) → confirm.
      if (tool === "read" || tool === "edit" || tool === "write") {
        const path = String(event?.input?.path ?? "");
        // G1: the production unlock is a person's grant; a session never writes it.
        if ((tool === "edit" || tool === "write") && (path.split(/[/\\]/).pop() || "").toLowerCase() === PROD_UNLOCK_FILE) {
          audit({ cwd: ctx.cwd, kind: "secret-confirm", tool, decision: "blocked", label: "production unlock", detail: "prod-unlock-self" });
          return { block: true, reason: PROD_UNLOCK_SELF_BLOCK };
        }
        if (path && isSecretPath(path)) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "secret-confirm", tool, decision: "blocked-headless", label: path, detail: path });
            return { block: true, reason: `coop guardrails: blocked ${tool} of secret-looking file ${path}; approval is unavailable in headless mode.` };
          }
          const verb = tool === "read" ? "read" : "write to";
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `Secret-looking file (${verb}):\n  ${path}\ncoop never exposes secrets (tokens, keys, .env). Proceed?`,
          );
          audit({ cwd: ctx.cwd, kind: "secret-confirm", tool, decision: ok ? "allowed" : "declined", label: path, detail: path });
          if (!ok) return { block: true, reason: `coop guardrails: blocked ${tool} of the secret-looking file ${path} (you declined). Reference an env var / vault instead.` };
        }
        // 0'. SQL edits (SQ8): the lookup happens before the edit. coop-tools fills
        // the session's lineage context from the snapshot and the built docs in its
        // own tool_call hook (it loads first); when no source holds the object and
        // a live target could still answer, the edit waits for sql_impact.
        if ((tool === "edit" || tool === "write") && /\.sql$/i.test(path)) {
          const gate = decideSqlEditGate(path, tool === "write" ? String(event?.input?.content ?? "") : "", ctx);
          if (gate.action === "block") {
            audit({ cwd: ctx.cwd, kind: "lineage-gate", tool, decision: "blocked", label: path, detail: "lineage-not-held" });
            return { block: true, reason: `coop guardrails: blocked ${tool} of ${path}: ${gate.reason}` };
          }
        }
        return;
      }

      // 0b. Mutating MCP / Fabric / Power BI action → explicit approval. Proxied
      // calls use the adapter's server/tool identity; approval fails closed headlessly.
      if (tool !== "bash") {
        // 0b'. sql_impact (SQ4): catalog metadata for one object on the executor's
        // dev/test target runs without a prompt; anything else asks or is blocked.
        if (tool === SQL_IMPACT_TOOL || tool === CATALOG_SNAPSHOT_TOOL) {
          const deps = { ...liveReadDeps, contract: () => ensureSessionGovernance(ctx.cwd).sqlContract };
          const impact = tool === SQL_IMPACT_TOOL ? decideSqlImpact(event, deps) : decideCatalogSnapshot(event, deps);
          const auditTool = tool === SQL_IMPACT_TOOL ? "governed-sql-impact" : "governed-catalog-snapshot";
          const label = tool === SQL_IMPACT_TOOL ? "live metadata read" : "live catalog snapshot";
          if (impact.action === "block") {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: auditTool, decision: "blocked", label, detail: "input-invalid" });
            return { block: true, reason: `coop guardrails: blocked ${tool}; it ${impact.reason}.` };
          }
          if (impact.action === "allow") {
            // A snapshot status reads a folder, not a target: nothing to audit.
            if (impact.environment) audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: auditTool, decision: "allowed", label, detail: impact.environment });
            return;
          }
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: auditTool, decision: "blocked-headless", label, detail: impact.environment });
            return { block: true, reason: `coop guardrails: blocked ${tool} (${impact.reason}); explicit approval is unavailable in headless mode.` };
          }
          const ok = await ctx.ui.confirm(
            "coop live-data guardrail",
            `Live catalog metadata read (${tool}) on a target that is not a resolved dev/test entry:\n  environment: ${impact.environment} (${impact.reason})\nDev/test metadata is read-only by default; production and unresolved targets ask. Read it once?`,
          );
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: auditTool, decision: ok ? "allowed" : "declined", label, detail: impact.environment });
          if (!ok) return { block: true, reason: `coop guardrails: blocked ${tool} (you declined).` };
          return;
        }
        const target = effectiveMutationTarget(event);
        if (modelingConnectsProduction(event)) modelingProduction = true;
        const mcp = mcpEditLabel(event);
        // G1: a production write waits for a person's permit before any other approval path. The signal is
        // the call's own words (server, tool, arguments naming prod) or the session's
        // production Modeling connection; the Warehouse SQL path below uses coop's
        // trusted config for the same decision.
        const mcpProductionWrite = Boolean(mcp) && (
          (modelingProduction && isModelingEdit(event)) || PRODUCTION_WORD.test(mutationCallText(event, target)));
        // The permit is this call's approval: it is not asked twice below.
        let productionPermitted = false;
        if (mcpProductionWrite) {
          const refused = await permitProductionWrite(ctx, "mcp-confirm", "governed-mcp", mcp);
          if (refused) return refused;
          productionPermitted = true;
        }
        const editKey = mcp ? sessionApprovalKey(event, modelingProduction && isModelingEdit(event) ? "production" : undefined) : null;
        if (productionPermitted) {
          // asked and audited above
        } else if (mcp && editKey && editApprovals.has(editKey)) {
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-mcp", decision: "allowed", label: "managed MCP mutation", detail: "session-approval" });
        } else if (mcp) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-mcp", decision: "blocked-headless", label: "managed MCP mutation", detail: "mutation" });
            return { block: true, reason: `coop guardrails: blocked mutating MCP action ${mcp}; approval is unavailable in headless mode.` };
          }
          const choice = await askEditApproval(
            ctx,
            "coop guardrails",
            `This looks like a MUTATING MCP action (create/update/delete/deploy/publish):\n  ${mcp}\ncoop treats MCP as read-only (list / read / inspect). Run it?`,
            editKey,
          );
          const ok = choice !== "declined";
          if (choice === "session" && editKey) editApprovals.add(editKey);
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-mcp", decision: ok ? "allowed" : "declined", label: "managed MCP mutation", detail: choice === "session" ? "session-approval-granted" : "mutation" });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked the MCP action ${mcp} (you declined). MCP is read-only by default — list / read / inspect only; make changes with explicit approval or in the Fabric / Power BI UX.` };
          }
        }
        const resolvedScope = resolveLiveReadScope(event, { ...liveReadDeps, contract: () => ensureSessionGovernance(ctx.cwd).sqlContract });
        const decision = decideLiveRead(event, liveReadGrant, resolvedScope);
        if (decision.action === "allow-dev") {
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-live-read", decision: "allowed", label: "live read", detail: "dev-read-only" });
          return;
        }
        if (decision.action !== "none" && decision.action !== "allow-grant") {
          // A single dev/test Warehouse INSERT/UPDATE/CREATE/ALTER can ride a session
          // approval (#156); destructive SQL, batches and production always ask. The
          // environment is the trusted config's, resolved for the write itself: a
          // mutation never resolves a read scope, so without this a production
          // target whose SQL does not say "prod" offered the session option (#283).
          const trustedSqlEnvironment = decision.kind === "ddl-dml-destructive" ? managedSqlEnvironment(liveReadDeps) : "";
          const sqlEditKey = decision.kind === "ddl-dml-destructive" && (trustedSqlEnvironment === "dev" || trustedSqlEnvironment === "test")
            ? sessionApprovalKey(event, trustedSqlEnvironment)
            : null;
          // A write is recorded as a write: "live read" on an approved CREATE/ALTER
          // misread the audit trail (SQ live acceptance, 2026-10-03).
          const auditLabel = decision.kind === "ddl-dml-destructive" ? "Warehouse SQL write" : "live read";
          // G1: a production Warehouse write runs only on a person's permit. Coop's own
          // trusted config decides; the call's words decide only when that config
          // resolves no dev or test target (a dev Warehouse may hold a schema named
          // prod_staging, and a production write without the word "prod" is still
          // a production write, #283). An active unlock falls back to asking.
          const writeEnvironment = decision.kind === "ddl-dml-destructive"
            ? trustedWriteEnvironment(event, liveReadDeps, ensureSessionGovernance(ctx.cwd).sqlContract)
            : "";
          const production = decision.environment === "production" || decision.scope?.environment === "production" || writeEnvironment === "production";
          // A write on a target coop's config cannot confirm as dev or test (the global
          // endpoint, blank environment_names with no matching sql_targets ids) may be
          // production, so it needs the same permit (Aaron, 2026-10-07: he had written
          // to production through such a target with only the ordinary approval).
          const unconfirmedWrite = decision.kind === "ddl-dml-destructive" && writeEnvironment !== "dev" && writeEnvironment !== "test";
          const sqlProductionWrite = decision.kind === "ddl-dml-destructive" && (
            unconfirmedWrite || decision.scope?.environment === "production");
          if (sqlProductionWrite) {
            // Permitted once above for the same call, or asked now; never a session approval.
            if (productionPermitted) return;
            const what = writeEnvironment === "production" || decision.environment === "production" || decision.scope?.environment === "production"
              ? decision.label || "Warehouse SQL write"
              : `${decision.label || "Warehouse SQL write"} (target not confirmed as dev or test; treated as production)`;
            const refused = await permitProductionWrite(ctx, "mcp-confirm", "governed-live-read", what);
            return refused || undefined;
          }
          if (sqlEditKey && editApprovals.has(sqlEditKey)) {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-live-read", decision: "allowed", label: auditLabel, detail: "session-approval" });
            return;
          }
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-live-read", decision: "blocked-headless", label: auditLabel, detail: decision.kind || "live-read" });
            return { block: true, reason: `coop guardrails: blocked ${decision.kind || "live-read"} access through ${decision.label || "the governed tool"}; explicit approval is unavailable in headless mode.` };
          }
          const sessionGrant = decision.action === "prompt-and-grant";
          const scopeSummary = decision.scope ? [
            "Resolved bounded session scope:",
            `  client: ${decision.scope.client}`,
            `  tenant: ${decision.scope.tenant}`,
            `  principal: ${decision.scope.principal}`,
            `  environment: ${decision.scope.environment}`,
            `  target(s): ${decision.scope.targets.join(", ")}`,
            `  operation: ${decision.scope.operationClass}`,
            `  row limit: ${decision.scope.resultLimit}`,
            `  time limit: ${decision.scope.timeoutMs} ms`,
          ].join("\n") : "";
          const prompt = decision.kind === "ddl-dml-destructive"
            ? sqlEditKey
              ? `Warehouse SQL write (one INSERT, UPDATE, CREATE or ALTER):\n  ${decision.label}\nDeletes, drops, merges, EXEC, batches and production always ask. Run it?`
              : `${production ? "PRODUCTION " : ""}Warehouse SQL mutation/DDL call:\n  ${decision.label}\nDDL, DML, destructive SQL, EXEC, and batches require separate explicit approval. Run it?`
            : decision.kind === "ambiguous-sql"
              ? `Ambiguous Warehouse SQL call:\n  ${decision.label}\nOnly one plain SELECT with a literal TOP bound can use a session grant. Run this call once?`
              : decision.kind === "production-metadata"
                ? `Production metadata/code read:\n  ${decision.label}\nDev/test metadata is read-only by default; production always asks.${sessionGrant ? " Approve this exact bounded scope for this session?" : " Read it once?"}`
                : `${production ? "PRODUCTION " : ""}row-level data read:\n  ${decision.label}\n${scopeSummary ? `${scopeSummary}\n` : ""}${sessionGrant ? "Approve this exact bounded scope for this session?" : "Read these rows once?"}`;
          const choice = await askEditApproval(ctx, "coop live-data guardrail", prompt, sqlEditKey);
          const ok = choice !== "declined";
          if (choice === "session" && sqlEditKey) editApprovals.add(sqlEditKey);
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: "governed-live-read", decision: ok ? "allowed" : "declined", label: auditLabel, detail: choice === "session" ? "session-approval-granted" : decision.kind || "live-read" });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked ${decision.kind || "live-read"} access through ${decision.label || "the governed tool"} (you declined).` };
          }
          if (sessionGrant && decision.scope) liveReadGrant = createLiveReadGrant(decision.scope);
        }
        return;
      }

      const cmd = String(event?.input?.command ?? "").trim();
      if (!cmd) return;
      if (hasAmbiguousGitInvocation(cmd)) {
        return { block: true, reason: "coop guardrails: blocked an ambiguous Git wrapper/segment that cannot be safely inspected. Run Git directly or use a supported env/command/group wrapper." };
      }

      // 1a'. G1: `coop unlock-prod` and its file belong to a person's own terminal.
      if (touchesProdUnlock(cmd)) {
        audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "blocked", label: "production unlock", detail: "prod-unlock-self" });
        return { block: true, reason: PROD_UNLOCK_SELF_BLOCK };
      }

      // 1a. Secret-file access via bash mirrors the read/edit/write gate and fails
      // closed when approval UI is unavailable.
      const secretPath = bashSecretCmdPath(cmd);
      if (secretPath) {
        if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
          audit({ cwd: ctx.cwd, kind: "secret-confirm", tool: "bash", decision: "blocked-headless", label: secretPath, detail: secretPath });
          return { block: true, reason: `coop guardrails: blocked command touching ${secretPath}; approval is unavailable in headless mode.` };
        }
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `This command touches a secret-looking file:\n  ${secretPath}\ncoop never exposes secrets (tokens, keys, .env). Run it?`,
        );
        // Log the matched PATH only — never the command (it may embed the secret's value).
        audit({ cwd: ctx.cwd, kind: "secret-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: secretPath, detail: secretPath });
        if (!ok) {
          return { block: true, reason: `coop guardrails: blocked a command touching the secret-looking file ${secretPath} (you declined). Reference an env var / vault instead of reading or writing secrets.` };
        }
      }

      // 1. Never commit source (incl. `git commit -a/-am` auto-staging, `git -C <dir>`,
      //    `git commit <pathspec>`, and `cd <dir> && git commit` — the staged check runs
      //    against the repo the commit actually targets, see gitRepoDir).
      //    Policy comes from the TRUSTED SESSION SNAPSHOT (read once at first governed
      //    call) — in-session edits to .coop/project.yml cannot weaken it, and the
      //    contract is resolved from the session directory so sibling repositories
      //    inherit their configured policies.
      //    Hard-blocked first: --amend (rewrites history) and pathspec-file forms
      //    (commits paths the guardrail deliberately does not read) — no approval path.
      const governance = ensureSessionGovernance(ctx.cwd);
      for (const git of parseGitCommands(cmd).filter((g) => g.subcommand === "commit")) {
        const hard = commitHardBlockReason(git);
        if (hard) {
          // Inside this loop every entry is a commit; explain WHICH hard block fired.
          const why = hard.includes("--amend")
            ? "amend rewrites an existing commit"
            : "the guardrail does not read pathspec files";
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: "blocked", label: hard, detail: hard });
          return { block: true, reason: `coop guardrails: ${hard} is never permitted — ${why}. Let a human run it.` };
        }
        const offending = await offendingCommitPaths(pi, ctx.cwd, cmd, git, governance);
        if (offending && offending.length) {
          const shown = offending.slice(0, 8).join(", ");
          const more = offending.length > 8 ? ` (+${offending.length - 8} more)` : "";
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: "blocked", label: "git commit", detail: shown });
          return { block: true, reason: `coop guardrails: never commit source. These paths aren't docs/logs/site: ${shown}${more}. Unstage them and let a human commit source.` };
        }
        if (offending === null && commitHasLeadingCd(cmd, git)) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            return { block: true, reason: "coop guardrails: blocked an unverifiable commit because approval is unavailable in headless mode." };
          }
          const ok = await ctx.ui.confirm("coop guardrails", `Can't verify what this commit would include:\n  ${git.segment.slice(0, 200)}\nProceed?`);
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: ok ? "allowed" : "declined", label: "unverifiable git commit", detail: "unverifiable git commit" });
          if (!ok) return { block: true, reason: "coop guardrails: blocked an unverifiable commit (you declined)." };
        }
      }

      // 2. Destructive command → explicit approval; fail closed without UI.
      const danger = dangerLabel(cmd);
      if (danger) {
        if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "blocked-headless", label: danger, detail: danger });
          return { block: true, reason: `coop guardrails: blocked ${danger}; approval is unavailable in headless mode.` };
        }
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `Destructive command (${danger}):\n  ${cmd.slice(0, 200)}\nRun it?`,
        );
        audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: danger, detail: danger });
        if (!ok) {
          return { block: true, reason: `coop guardrails: blocked the ${danger} command (you declined). Propose a safer approach.` };
        }
      }

      // 2b. Fabric / Azure REST write from the shell (`az rest --method post`,
      // `fab api -X post`, `fab deploy`, ...) → explicit approval, the same rule as
      // a mutating MCP call. The official Microsoft skills issue item create /
      // update / deploy / delete this way; fail closed without UI.
      const fabricWrite = fabricWriteLabel(cmd);
      const rayfin = fabricWrite !== null && fabricWrite.startsWith("rayfin ");
      if (fabricWrite) {
        // G1: a Fabric write whose command names prod is a production write: it runs
        // only on a person's permit, which is that call's one approval.
        if (PRODUCTION_WORD.test(cmd)) {
          const refused = await permitProductionWrite(ctx, "danger-confirm", "bash", `${fabricWrite}: ${cmd.slice(0, 200)}`);
          if (refused) return refused;
        } else {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "blocked-headless", label: fabricWrite, detail: fabricWrite });
            return { block: true, reason: `coop guardrails: blocked ${fabricWrite}; approval is unavailable in headless mode.` };
          }
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `Fabric / Azure write from the shell (${fabricWrite}):\n  ${cmd.slice(0, 200)}\n` +
              (rayfin ? rayfinTargetNote(cmd, governance.devWorkspaceId) : "") +
              `coop treats Fabric item create/update/deploy/delete as approval-gated, like a mutating MCP call. Run it?`,
          );
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: fabricWrite, detail: fabricWrite });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked the ${fabricWrite} command (you declined). Fabric writes need explicit approval; read with \`--method get\` or make the change in the Fabric UX.` };
          }
        }
      }

      // 2c. Power BI Desktop reload (S31) → read `powerbi-desktop status` first; ask
      // when the targeted instance has unsaved changes (the bridge would discard
      // them), block when it cannot be verified; fail closed without UI.
      const reload = desktopReloadTarget(cmd);
      if (reload) {
        let decision: DesktopReloadDecision;
        try {
          const status = desktopStatusCommand(reload.pid);
          const res = await pi.exec(status.bin, status.args, { cwd: ctx.cwd });
          decision = res && res.code === 0 ? decideDesktopReload(String(res.stdout || ""), reload) : { action: "block", reason: `\`powerbi-desktop status\` exited ${res ? res.code : "without a result"}` };
        } catch {
          decision = { action: "block", reason: "`powerbi-desktop status` could not run" };
        }
        if (decision.action === "block") {
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "blocked", label: "Desktop reload", detail: "status-unverified" });
          return { block: true, reason: `coop guardrails: blocked ${reload.label}; ${decision.reason}. A reload discards unsaved Desktop edits, so coop only reloads an instance whose status it can read. Run \`powerbi-desktop status\`, pick the right --pid, and retry.` };
        }
        if (decision.action === "ask") {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "blocked-headless", label: "Desktop reload", detail: "unsaved-changes" });
            return { block: true, reason: `coop guardrails: blocked ${reload.label}; Desktop instance ${decision.pid} has unsaved changes and approval is unavailable in headless mode. Ask the user to save or discard in Power BI Desktop first.` };
          }
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `Power BI Desktop instance ${decision.pid} has unsaved changes${decision.file ? `:\n  ${decision.file}` : ""}\n  ${cmd.slice(0, 200)}\nA reload discards them. Save or discard in Desktop first, then retry. (Desktop 2.157.627.0 reports a false positive on untouched files.) Reload anyway?`,
          );
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: "Desktop reload", detail: "unsaved-changes" });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked ${reload.label} (you declined); Desktop instance ${decision.pid} has unsaved changes. Ask the user to save or discard in Power BI Desktop, then retry.` };
          }
        } else {
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "allowed", label: "Desktop reload", detail: "clean" });
        }
      }
    } catch {
      // An approval/policy failure is not permission. Never forward exception text:
      // it can contain command arguments, credentials, or private tool payloads.
      return { block: true, reason: "coop guardrails: unable to verify this tool call because an enforcement check failed; the action was blocked. Retry after resolving the guardrail or approval UI failure." };
    }
  });

  pi.registerCommand("coop-live-read", {
    description: "Show or revoke this session's bounded live-read grant",
    handler: async (args: any, ctx: ExtensionContext) => {
      const action = (Array.isArray(args) ? args.join(" ") : String(args || "")).trim().toLowerCase() || "status";
      let message: string;
      if (action === "revoke") {
        liveReadGrant = null;
        message = "coop live-read grant: revoked for this session.";
      } else if (action !== "status") {
        message = "Usage: /coop-live-read status|revoke";
      } else if (!liveReadGrant) {
        message = "coop live-read grant: none active for this session.";
      } else {
        const s = liveReadGrant.scope;
        // Closed, non-secret scope only: never show SQL, arguments, credentials,
        // transport, or results. Targets are explicit consent identifiers.
        message = [
          "coop live-read grant: active for this session",
          `  client/tenant/principal: ${s.client} / ${s.tenant} / ${s.principal}`,
          `  environment/operation: ${s.environment} / ${s.operationClass}`,
          `  targets: ${s.targets.join(", ")}`,
          `  bounds: ${s.resultLimit} result rows; ${s.timeoutMs} ms`,
        ].join("\n");
      }
      try { if (typeof ctx.ui?.notify === "function") ctx.ui.notify(message, "info"); } catch { /* ignore */ }
    },
  });

  pi.registerCommand("coop-approvals", {
    description: "Show or revoke this session's edit approvals (/coop-approvals status|revoke)",
    handler: async (args: any, ctx: ExtensionContext) => {
      const action = (Array.isArray(args) ? args.join(" ") : String(args || "")).trim().toLowerCase() || "status";
      let message: string;
      if (action === "revoke") {
        editApprovals.clear();
        message = "coop edit approvals: revoked for this session. The next edit asks again.";
      } else if (action !== "status") {
        message = "Usage: /coop-approvals status|revoke";
      } else if (!editApprovals.size) {
        message = "coop edit approvals: none active. Each edit asks; pick \"for this session\" to approve a server once.";
      } else {
        message = [
          "coop edit approvals: active for this session",
          ...[...editApprovals].sort().map((key) => `  • ${sessionApprovalLabel(key)}${key.startsWith("sql:") ? " (single INSERT/UPDATE/CREATE/ALTER statements)" : ""}`),
          "Deletes and drops still ask every time; production writes run only under a human unlock and ask each time. Ends at /new or exit; /coop-approvals revoke ends it now.",
        ].join("\n");
      }
      if (action === "status") {
        const unlock = activeProdUnlock(ctx);
        message += unlock
          ? `\nPRODUCTION WRITES UNLOCKED by a human for ${unlock.client} (grant ${unlock.id}, ${prodUnlockMinutesLeft(unlock)} min left): each production write asks yes/no at the desk and is audited.`
          : "\nProduction writes: blocked until a person runs `coop unlock-prod <client>` in their own terminal; then each one asks at the desk; never for the whole session.";
      }
      try { if (typeof ctx.ui?.notify === "function") ctx.ui.notify(message, "info"); } catch { /* ignore */ }
    },
  });

  pi.registerCommand("coop-guardrails", {
    description: "Show what coop's runtime guardrails enforce (and whether they're on)",
    handler: async (_args, ctx) => {
      const lines = [
        `coop-guardrails: ${enabled() ? "ON" : "OFF (COOP_NO_GUARDRAILS=1)"}`,
        `coop update policy: ${showUpstreamUpdates() ? "UPSTREAM NOTICES ENABLED (maintainer mode)" : "ON — Pi self-update prompts suppressed; use coop update"}`,
        "Enforced on the agent's tool calls (your own shell is never intercepted):",
        "  • never commit source — blocks `git commit` (incl. -a/-am, `git -C`, `git commit <path>`, and `cd <dir> && git commit`) of anything outside docs/logs/site",
        "  • destructive commands — confirms rm -rf / git push --force (incl. +refspec) / reset --hard / git clean -f / DROP·TRUNCATE",
        "  • secret files — confirms read/edit/write AND bash access (cat .env etc.) of .env / keys / credentials",
        `  • live data — allows dev/test metadata and one plain bounded SELECT on the dev target; elsewhere bounded matching reads may reuse one session grant (${liveReadGrant ? "active" : "none"}; /coop-live-read status|revoke)`,
        "  • mutating MCP actions — confirms create/update/delete/deploy/publish-looking Fabric/Power BI/MCP tool calls (best-effort)",
        `  • production writes — SQL on a production target, model edits after a production connection, Fabric writes naming prod: blocked unless a human unlock is active, then each asks at the desk and is audited; never session-wide (${activeProdUnlock(ctx) ? "unlock active" : "no unlock active"})`,
        "  • Power BI Desktop reloads — reads `powerbi-desktop status` before `powerbi-desktop reload` / `powerbi-report-author preview`; asks on unsaved changes, blocks when the instance can't be verified",
        `  • edit approvals — approving an edit can cover that server for the session; deletes and drops still ask (${editApprovals.size ? `${editApprovals.size} active` : "none"}; /coop-approvals status|revoke)`,
        "Advisory rules live in docs/guardrails.md. Disable with COOP_NO_GUARDRAILS=1.",
        "",
        `Audit log (append-only; secrets/file contents never written): ${auditPath()}`,
      ];
      const recent = readAuditTail(10);
      if (recent.length) {
        lines.push(`Last ${recent.length} decision(s):`);
        for (const e of recent) {
          lines.push(`  ${e.ts || "?"}  ${e.kind}/${e.decision}  ${e.label}${e.detail && e.detail !== e.label ? `  (${e.detail})` : ""}`);
        }
      } else {
        lines.push("No guardrail decisions recorded yet.");
      }
      try {
        if (typeof ctx.ui?.notify === "function") ctx.ui.notify(lines.join("\n"), "info");
      } catch {
        /* ignore */
      }
    },
  });
}
