// SQL source control through coop-sql-source-control (master plan SQ12).
//
// A client SQL repository that holds an `sqlsc.yml` is under source control:
// every object is a file, `sqlsc status` says what differs between the dev
// database and the repo, and a checkout in the shared lock table tells the
// team (and coop) who is editing what. coop drives the `coop-sqlsc` CLI
// through the `sql_source` tool and never commits: it checks out as
// `coop-agent:<the person's git e-mail>`, makes the change (live in dev, then
// `script` writes the files; or in the files, then `get_latest` applies them to
// dev), and the person reviews it and checks it in. sqlsc counts a checkout
// held by `coop-agent:<you>` as yours, so their Check in commits and releases it.
//
// Where no `sqlsc.yml` exists, or the CLI is not installed, the tool says so and
// coop works as it always has. This module builds the argv and the text; the
// extension runs the process, so the rules are tested without Pi.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectYamlScalar, repositoryNames } from "./project-contract.mjs";

export const SQLSC_BIN = "coop-sqlsc";
export const AGENT_PREFIX = "coop-agent:";
export const SQL_SOURCE_COMMANDS = ["status", "diff", "locks", "checkout", "release", "script", "get_latest", "migrations"];
const READ_COMMANDS = new Set(["status", "diff", "locks", "migrations"]);
const NEEDS_OBJECTS = new Set(["checkout", "release"]);
const REPO_ROLES = new Set(["sql", "mixed"]);
// Object names as sqlsc reads them: `dbo.Customer`, `[sales].[v Odd]`, `Customer`.
const OBJECT_NAME = /^[^\s-][^\r\n\0]{0,255}$/;
const MAX_OBJECTS = 50;
const OBJECT_TYPES = new Set(["schema", "table", "view", "function", "procedure", "trigger"]);
const MAX_NOTE = 200;
// The one target coop changes: sqlsc's `dev`, which inside a coop project is
// the contract's sql_targets dev entry. sqlsc itself never lets get-latest
// touch prod; test stays a person's call.
export const WRITE_TARGET = "dev";

function isTodo(value) {
  return !value || String(value).trim().toUpperCase().startsWith("TODO");
}

/** The nearest `sqlsc.yml` walking up from cwd, else the one in the project's
 *  only `sql`/`mixed` repository (its `local_path`), else null. */
export function findSqlscConfig(cwd, contractPath = null) {
  let dir = resolve(cwd || ".");
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "sqlsc.yml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!contractPath || !existsSync(contractPath)) return null;
  let text = "";
  try { text = readFileSync(contractPath, "utf8"); } catch { return null; }
  const root = dirname(dirname(contractPath));
  const found = [];
  for (const name of repositoryNames(text)) {
    const role = (projectYamlScalar(text, ["repositories", name, "role"]) || "").trim().toLowerCase().replace(/-/g, "_");
    const localPath = projectYamlScalar(text, ["repositories", name, "local_path"]);
    if (!REPO_ROLES.has(role) || isTodo(localPath)) continue;
    const expanded = localPath.trim().replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "~");
    const candidate = join(resolve(root, expanded), "sqlsc.yml");
    if (existsSync(candidate)) found.push(candidate);
  }
  return found.length === 1 ? found[0] : null;
}

/** The name coop checks out as: `coop-agent:<the person>`. */
export function agentIdentity(personEmail) {
  const who = String(personEmail || "").trim();
  return who ? `${AGENT_PREFIX}${who}` : "";
}

/** Validated tool input, or { error }. */
export function sqlSourceInput(params) {
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const command = p.command === undefined ? "status" : String(p.command);
  if (!SQL_SOURCE_COMMANDS.includes(command)) return { error: `command must be one of ${SQL_SOURCE_COMMANDS.join(", ")}` };
  const raw = p.objects === undefined ? [] : p.objects;
  if (!Array.isArray(raw) || raw.length > MAX_OBJECTS) return { error: `objects must be a list of at most ${MAX_OBJECTS} names` };
  const objects = raw.map((o) => String(o).trim()).filter(Boolean);
  const bad = objects.find((o) => !OBJECT_NAME.test(o));
  if (bad !== undefined) return { error: `'${bad.slice(0, 80)}' is not an object name` };
  if (NEEDS_OBJECTS.has(command) && !objects.length) return { error: `${command} needs objects (for example dbo.Customer)` };
  const note = p.note === undefined ? "" : String(p.note).replace(/[\r\n]+/g, " ").trim().slice(0, MAX_NOTE);
  const apply = p.apply === true;
  const type = p.type === undefined ? "" : String(p.type);
  if (type && !OBJECT_TYPES.has(type)) return { error: `type must be one of ${[...OBJECT_TYPES].join(", ")}` };
  if (type && command !== "checkout") return { error: "type is only for checkout (an object about to be created)" };
  if (apply && command !== "get_latest") return { error: "apply is only for get_latest" };
  const environment = p.environment === undefined ? "" : String(p.environment);
  if (environment && !["dev", "test", "prod"].includes(environment)) return { error: "environment must be dev, test or prod" };
  if (environment && !READ_COMMANDS.has(command)) return { error: `environment is only for reads (${[...READ_COMMANDS].join(", ")}); ${command} works on dev` };
  return { command, objects, note, apply, environment, type };
}

/** The coop-sqlsc argv for a validated input. Never commit, checkin, deploy,
 *  --force, guard or data: those stay a person's. */
export function sqlSourceArgs(input, config, agent) {
  const args = ["--json", "--config", config];
  const as = ["--as", agent];
  const target = input.environment ? ["--target", input.environment] : [];
  const names = input.objects.length ? ["--", ...input.objects] : [];
  switch (input.command) {
    case "status": return [...args, "status", ...target, ...as];
    case "diff": return [...args, "diff", ...target, ...names];
    case "locks": return [...args, "locks", ...as];
    case "migrations": return [...args, "migrations", ...target];
    case "checkout": return [...args, "checkout", ...as, ...(input.note ? ["--message", input.note] : []), ...(input.type ? ["--type", input.type] : []), ...names];
    case "release": return [...args, "unlock", ...as, ...names];
    case "script": return [...args, "script", "--target", WRITE_TARGET, ...names];
    case "get_latest": return [...args, "get-latest", "--target", WRITE_TARGET, ...(input.apply ? [] : ["--dry-run"]), ...names];
    default: throw new Error(`unknown command ${input.command}`);
  }
}

const SETUP_HINT = "Work as usual: change dev with approval and leave the commit to a person.";
export const NOT_SET_UP_TEXT = `sql_source: no sqlsc.yml in this repository or the project's SQL repository, so SQL source control is not set up here. ${SETUP_HINT} A person sets it up with \`sqlsc init\` in the client SQL repository.`;
export const NOT_INSTALLED_TEXT = `sql_source: the coop-sqlsc command is not installed on this machine. ${SETUP_HINT} To use it, install the coop-sql-source-control wheel with pipx (see its release page).`;
export const NO_USER_TEXT = "sql_source: git has no user.email in this repository, so coop cannot check out on the person's behalf. Ask them to set it (git config user.email) or work without a checkout.";

function name(item) {
  return String(item?.object ?? `${item?.schema ?? ""}.${item?.name ?? ""}`);
}

function changeLine(c) {
  const side = c.origin && c.origin !== "unknown" ? `, changed in ${c.origin}` : "";
  const lock = c.locked_by ? `, checked out by ${c.mine ? "coop (you)" : c.locked_by}` : "";
  return `- ${c.action} ${c.type} ${name(c)}${side}${lock}`;
}

/** The model-facing summary of one sqlsc JSON answer: { head, lines }. */
export function sqlSourceText(input, out) {
  if (!out || typeof out !== "object") return { head: "sql_source: coop-sqlsc returned no JSON.", lines: [] };
  if (out.ok === false && out.error) {
    return { head: `sql_source ${input.command} failed (${out.error.kind}): ${out.error.message}`, lines: [] };
  }
  const t = out.target ? `${out.target.name} (${out.target.kind} ${out.target.database})` : "";
  const lines = [];
  switch (input.command) {
    case "status": {
      const changes = Array.isArray(out.changes) ? out.changes : [];
      for (const c of changes) lines.push(changeLine(c));
      const pending = Array.isArray(out.migrations?.pending) ? out.migrations.pending.length : 0;
      if (pending) lines.push(`- ${pending} migration script(s) not yet run on ${t}`);
      const s = out.sides || {};
      const head = changes.length
        ? `sql_source status on ${t}: ${changes.length} difference(s): ${s.to_commit ?? 0} changed in the database (a person commits them), ${s.to_get ?? 0} in the repo (get_latest applies them), ${s.conflicts ?? 0} on both sides (show the diff and ask).`
        : `sql_source status on ${t}: the database and the repo match.`;
      return { head, lines };
    }
    case "diff": {
      for (const c of Array.isArray(out.changes) ? out.changes : []) {
        lines.push(changeLine(c));
        for (const l of String(c.diff || "").split("\n")) if (l) lines.push(l);
      }
      return { head: `sql_source diff on ${t}:`, lines };
    }
    case "locks": {
      for (const l of Array.isArray(out.locks) ? out.locks : []) lines.push(`- ${l.object} by ${l.locked_by} since ${l.locked_at}${l.note ? ` (${l.note})` : ""}`);
      return { head: `sql_source locks: ${lines.length} checkout(s).`, lines };
    }
    case "migrations": {
      for (const m of Array.isArray(out.migrations) ? out.migrations : []) lines.push(`- ${m.id ?? m.path}: ${m.state}`);
      return { head: `sql_source migrations on ${t}:`, lines };
    }
    case "checkout": {
      for (const c of Array.isArray(out.conflicts) ? out.conflicts : []) {
        lines.push(`- ${c.object} is checked out by ${c.locked_by} since ${c.locked_at}${c.note ? ` (${c.note})` : ""}`);
      }
      const got = (Array.isArray(out.checked_out) ? out.checked_out : []).map(name);
      const head = lines.length
        ? `sql_source checkout: STOP. Someone else is editing ${lines.length} of these objects. Do not change them; tell the user who has them.${got.length ? ` Checked out for coop: ${got.join(", ")}.` : ""}`
        : `sql_source checkout: ${got.join(", ")} checked out for coop as ${out.user}. When the change is done, the user checks it in (Check in in the SSMS window, or sqlsc checkin); coop never commits.`;
      return { head, lines };
    }
    case "release": {
      const done = (Array.isArray(out.released) ? out.released : []).map(name);
      for (const r of Array.isArray(out.refused) ? out.refused : []) lines.push(`- ${r.object} belongs to ${r.locked_by}; left alone`);
      return { head: `sql_source release: released ${done.length ? done.join(", ") : "nothing"}.`, lines };
    }
    case "script": {
      for (const f of Array.isArray(out.files) ? out.files : []) lines.push(`- ${f.action} ${f.path}`);
      return { head: `sql_source script: wrote ${lines.length} file(s) from ${t}. Show the user the diff; they commit or check in.`, lines };
    }
    case "get_latest": {
      for (const s of Array.isArray(out.steps) ? out.steps : []) lines.push(`- ${s.action} ${name(s)}`);
      for (const k of Array.isArray(out.kept) ? out.kept : []) lines.push(`- kept ${name(k)}: ${k.reason}`);
      for (const h of Array.isArray(out.held_back) ? out.held_back : []) lines.push(`- held back ${name(h)}: ${(h.notes || []).join("; ")}`);
      for (const f of Array.isArray(out.failed) ? out.failed : []) lines.push(`- failed ${f.object}: ${f.error}`);
      if (!input.apply) {
        if (out.script) lines.push("script:", ...String(out.script).split("\n"));
        return { head: `sql_source get_latest (dry run) on ${t}: ${(out.steps || []).length} step(s). Show the user the script; apply=true runs it on dev after their approval.`, lines };
      }
      return { head: `sql_source get_latest on ${t}: ${out.applied ? "applied" : "not applied"}${out.transaction ? " in one transaction" : ""}.`, lines };
    }
    default:
      return { head: `sql_source ${input.command}: done.`, lines };
  }
}
