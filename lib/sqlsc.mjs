// SQL source control through coop-sql-source-control (master plan SQ12).
//
// A client SQL repository that holds an `sqlsc.yml` is under source control:
// every object is a file, `sqlsc status` says what differs between the dev
// database and the repo, and a checkout in the shared lock table tells the
// team (and coop) who is editing what. coop drives the `coop-sqlsc` CLI
// through the `sql_source` tool: it checks out as `coop-agent:<the person's git
// e-mail>`, makes the change (live in dev, then `script` writes the files; or in
// the files, then `get_latest` applies them to dev), shows the person the diff
// and, with their approval for that one commit, commits the scripted files
// (`commit`; Aaron, 2026-10-20: "2..commit is fine"), then releases its own
// checkouts of the committed objects, like a person's Check in (Aaron,
// 2026-10-21). It never pushes and never forces: a push, a check-in for someone
// else and a release to production stay a person's. sqlsc counts a checkout
// held by `coop-agent:<you>` as yours, so their Check in also commits and
// releases it.
//
// Nothing is lost between SSMS and the files: sqlsc's sync record says which
// side changed each object since the last sync (`origin`: database, repo, both,
// unknown). `script` never overwrites a file whose object changed on both sides
// (scriptConflicts refuses them and coop asks which side wins), sqlsc's own
// get-latest keeps objects changed in the database, and commit holds back
// objects the repo changed. coop never passes --force: an object changed on
// both sides is the person's to settle in their own terminal.
//
// Where no `sqlsc.yml` exists, or the CLI is not installed, the tool says so and
// coop works as it always has. This module builds the argv and the text; the
// extension runs the process, so the rules are tested without Pi.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { configPath as coopConfigPath } from "./paths.mjs";
import { projectYamlList, projectYamlScalar, repositoryNames } from "./project-contract.mjs";

export const SQLSC_BIN = "coop-sqlsc";
export const AGENT_PREFIX = "coop-agent:";
// Lean on purpose (Aaron, 2026-10-20: "I dont want to bloat coop"): status
// already names every checkout and pending migration, so there is no locks or
// migrations verb; schema_compare, sql_impact and data_doc keep their jobs.
export const SQL_SOURCE_COMMANDS = ["status", "diff", "checkout", "release", "script", "get_latest", "commit", "deploy", "init"];
const READ_COMMANDS = new Set(["status", "diff"]);
// The environments coop may release a commit to (Aaron, 2026-10-20: "can coop
// be allowed to deploy in dev or test only?"). Production stays a person's
// command: sqlsc deploy against prod is refused here and hard-blocked from the shell.
export const DEPLOY_ENVIRONMENTS = new Set(["dev", "test"]);
const MAX_REF = 200;
// A git ref sqlsc may release: a tag, branch, or commit; never an option.
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const NEEDS_OBJECTS = new Set(["checkout", "release"]);
const REPO_ROLES = new Set(["sql", "mixed"]);
// Object names as sqlsc reads them: `dbo.Customer`, `[sales].[v Odd]`, `Customer`.
const OBJECT_NAME = /^[^\s-][^\r\n\0]{0,255}$/;
const MAX_OBJECTS = 50;
// A schema filter for init (sqlsc 1.0.2 writes it into sqlsc.yml): plain names.
const SCHEMA_NAME = /^[^\[\]\x00-\x1f;'"-][^\[\]\x00-\x1f;'"]{0,127}$/;
const OBJECT_TYPES = new Set(["schema", "table", "view", "function", "procedure", "trigger"]);
const MAX_NOTE = 200;
const MAX_MESSAGE = 300;
// A commit message: one line, no option-looking start.
const COMMIT_MESSAGE = /^[^\s-][^\r\n\0]{0,299}$/;
// The one target coop changes: sqlsc's `dev`, which inside a coop project is
// the contract's sql_targets dev entry. sqlsc itself never lets get-latest
// touch prod; test stays a person's call.
export const WRITE_TARGET = "dev";

// --- The per-user switch ----------------------------------------------------
// sqlsc ships with coop but starts OFF for every Windows user (Aaron,
// 2026-10-20: "not the client turns it on but the user"). `/sql-source on`
// inside coop (or `coop sql-source on` in a terminal) records it in the user's
// ~/.coop/config (`sql_source_control.enabled`), beside client.platform and the
// knowledge block, so it holds across sessions and clients; `/sql-source off`
// turns it back off. The shell guardrails for sqlsc hold either way.
export const SWITCH_KEY = "sql_source_control";

/** Read the user's switch from ~/.coop/config (or `file`): true only when it says so. */
export function sqlSourceEnabled(file = coopConfigPath()) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw?.[SWITCH_KEY]?.enabled === true;
  } catch {
    return false;
  }
}

/** Write the switch into ~/.coop/config (or `file`), keeping every other key.
 *  Returns the state written. Throws when the file cannot be written. */
export function setSqlSourceEnabled(on, file = coopConfigPath(), now = new Date()) {
  let raw = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { raw = {}; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  }
  raw[SWITCH_KEY] = { enabled: on === true, changed_at: now.toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return on === true;
}

/** The one-line state for /sql-source, the /start menu and doctor. */
export function sqlSourceSwitchText(on) {
  return on
    ? "SQL source control (sqlsc) is ON for this Windows user: coop checks objects out and scripts its changes where the SQL repository has sqlsc.yml. /sql-source off turns it off."
    : "SQL source control (sqlsc) is OFF for this Windows user (the default). /sql-source on turns it on; coop then checks objects out and scripts its changes where the SQL repository has sqlsc.yml.";
}

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
  const found = sqlRepositories(contractPath).map((r) => join(r.dir, "sqlsc.yml")).filter((c) => existsSync(c));
  return found.length === 1 ? found[0] : null;
}

/** The project file's `sql`/`mixed` repositories with a local_path: { name, dir, text }. */
export function sqlRepositories(contractPath) {
  if (!contractPath || !existsSync(contractPath)) return [];
  let text = "";
  try { text = readFileSync(contractPath, "utf8"); } catch { return []; }
  const root = dirname(dirname(contractPath));
  const out = [];
  for (const name of repositoryNames(text)) {
    const role = (projectYamlScalar(text, ["repositories", name, "role"]) || "").trim().toLowerCase().replace(/-/g, "_");
    const localPath = projectYamlScalar(text, ["repositories", name, "local_path"]);
    if (!REPO_ROLES.has(role) || isTodo(localPath)) continue;
    const expanded = localPath.trim().replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "~");
    out.push({ name, dir: resolve(root, expanded), text });
  }
  return out;
}

// --- Setting up (sql_source init) --------------------------------------------
// Aaron, 2026-10-20/21: coop sets a client SQL repository up itself: git init
// when the folder is not a repository yet, then `sqlsc init` (sqlsc.yml,
// .gitattributes, .gitignore; the lock table in dev comes with the first
// checkout), one approval for the lot; then status, script and the baseline
// commit, each as usual.

/** Where init sets up: the project's only SQL repository folder, else the git
 *  repository holding cwd. { root } or { error }. */
export function sqlscInitRoot(cwd, contractPath = null) {
  const repos = sqlRepositories(contractPath).filter((r) => existsSync(r.dir));
  if (repos.length === 1) return { root: repos[0].dir, name: repos[0].name };
  if (repos.length > 1) {
    const here = resolve(cwd || ".");
    const inside = repos.find((r) => { const rel = relative(r.dir, here); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
    if (inside) return { root: inside.dir, name: inside.name };
    return { error: `the project file names ${repos.length} SQL repositories; open coop in the one to set up` };
  }
  let dir = resolve(cwd || ".");
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".git"))) return { root: dir, name: "" };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { error: "no SQL repository here: the project file names none (role sql with a local_path) and this folder is not in a git repository" };
}

function globRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") { re += "/?"; i++; } }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The project-file line that lets coop commit sqlsc's files, and whether it is
 *  there: { line, covered }. The guardrails decide (sqlscCommitRefusal); this
 *  only names the line for the person (Aaron, 2026-10-21). */
export function commitLine(configFile, contractPath = null) {
  const folder = sqlscFolder(configFile);
  const dir = dirname(configFile);
  const repo = sqlRepositories(contractPath).find((r) => r.dir === dir);
  const line = `agent_allowed_to_commit: ["${folder}/**"] under repositories.${repo ? repo.name : "<name>"} in .coop/project.yml`;
  if (!repo) return { line, covered: false };
  const globs = [
    ...projectYamlList(repo.text, ["repositories", repo.name, "agent_allowed_to_commit"]),
    ...projectYamlList(repo.text, ["approval_policy", "agent_allowed_to_commit"]),
  ];
  const sample = `${folder}/dbo/Tables/Sample.sql`;
  return { line, covered: globs.some((g) => { try { return globRegex(String(g).trim()).test(sample); } catch { return false; } }) };
}

/** The repo folder sqlsc writes object files into (`folder:` in sqlsc.yml,
 *  default `database`), relative to the sqlsc.yml folder, forward slashes. */
export function sqlscFolder(configFile) {
  let text = "";
  try { text = readFileSync(configFile, "utf8"); } catch { return "database"; }
  const m = /^folder\s*:\s*(.+?)\s*$/m.exec(text);
  const raw = m ? m[1].trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "") : "";
  const folder = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return folder || "database";
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
  const environment = p.environment === undefined ? "" : String(p.environment);
  if (environment && !["dev", "test", "prod"].includes(environment)) return { error: "environment must be dev, test or prod" };
  if (command === "deploy") {
    if (!DEPLOY_ENVIRONMENTS.has(environment)) return { error: "deploy needs environment dev or test; a release to production is a person's command (sqlsc deploy --confirm prod in their own terminal)" };
    if (objects.length) return { error: "deploy releases a whole commit; it takes no objects" };
  } else if (environment && !READ_COMMANDS.has(command)) {
    return { error: `environment is only for reads (${[...READ_COMMANDS].join(", ")}) and deploy; ${command} works on dev` };
  }
  if (apply && command !== "get_latest" && command !== "deploy") return { error: "apply is only for get_latest and deploy" };
  const ref = p.ref === undefined ? "" : String(p.ref).trim().slice(0, MAX_REF);
  if (ref && command !== "deploy") return { error: "ref is only for deploy" };
  if (ref && !GIT_REF.test(ref)) return { error: `'${ref.slice(0, 80)}' is not a commit, branch or tag name` };
  const message = p.message === undefined ? "" : String(p.message).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
  if (message && command !== "commit") return { error: "message is only for commit" };
  if (command === "commit") {
    if (!message) return { error: "commit needs a message that says what changed and why (the user approves each commit)" };
    if (!COMMIT_MESSAGE.test(message)) return { error: "message must be one line that does not start with a dash" };
  }
  const filter = {};
  for (const key of ["schemas", "exclude"]) {
    const v = p[key] === undefined ? [] : p[key];
    if (!Array.isArray(v) || v.length > MAX_OBJECTS || v.some((n) => typeof n !== "string" || !SCHEMA_NAME.test(n.trim()))) return { error: `${key} must be a list of schema names` };
    if (v.length && command !== "init") return { error: `${key} is only for init` };
    filter[key] = v.map((n) => n.trim());
  }
  if (command === "init" && objects.length) return { error: "init takes no objects" };
  return { command, objects, note, apply, environment, type, ref: command === "deploy" ? ref || "HEAD" : "", message, schemas: filter.schemas, exclude: filter.exclude };
}

/** The coop-sqlsc argv for a validated input. Never checkin, --push, a deploy
 *  to production, --force, --allow-drops, guard or data: those stay a person's. */
export function sqlSourceArgs(input, config, agent) {
  const args = ["--json", "--config", config];
  const as = ["--as", agent];
  const target = input.environment ? ["--target", input.environment] : [];
  const names = input.objects.length ? ["--", ...input.objects] : [];
  switch (input.command) {
    case "status": return [...args, "status", ...target, ...as];
    case "diff": return [...args, "diff", ...target, ...names];
    case "checkout": return [...args, "checkout", ...as, ...(input.note ? ["--message", input.note] : []), ...(input.type ? ["--type", input.type] : []), ...names];
    case "release": return [...args, "unlock", ...as, ...names];
    case "script": return [...args, "script", "--target", WRITE_TARGET, ...names];
    case "get_latest": return [...args, "get-latest", "--target", WRITE_TARGET, ...(input.apply ? [] : ["--dry-run"]), ...names];
    // The scripted files of dev's changes, committed as coop-agent:<user>; sqlsc
    // itself holds back objects someone else has checked out or the repo changed
    // (no --force), and nothing is pushed (no --push).
    case "commit": return [...args, "commit", "--target", WRITE_TARGET, ...as, "--message", input.message, ...names];
    // A release of one commit to dev or test; never --allow-drops or --confirm (prod).
    case "deploy": return [...args, "deploy", "--target", input.environment, "--ref", input.ref || "HEAD", ...(input.apply ? [] : ["--dry-run"])];
    // sqlsc.yml for this repository, its dev target from the project file;
    // never --force over an existing one. The schema filter needs sqlsc 1.0.2.
    case "init": return [...args, "init", ...(input.schemas || []).flatMap((s) => ["--schema", s]), ...(input.exclude || []).flatMap((s) => ["--exclude-schema", s])];
    default: throw new Error(`unknown command ${input.command}`);
  }
}

const SETUP_HINT = "Work as usual: change dev with approval; there is no repository history to keep.";
export const OFF_TEXT = `sql_source: SQL source control is switched off for this Windows user. ${SETUP_HINT} The user turns it on with /sql-source on (it stays on until /sql-source off).`;
export const NOT_SET_UP_TEXT = `sql_source: no sqlsc.yml in this repository or the project's SQL repository, so SQL source control is not set up here. ${SETUP_HINT} coop sets it up with sql_source init (the user approves it).`;
export const NOT_INSTALLED_TEXT = `sql_source: the coop-sqlsc command is not installed on this machine. ${SETUP_HINT} It ships with the coop window package; run coop update, or coop doctor for the row that names it.`;
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
    case "checkout": {
      for (const c of Array.isArray(out.conflicts) ? out.conflicts : []) {
        lines.push(`- ${c.object} is checked out by ${c.locked_by} since ${c.locked_at}${c.note ? ` (${c.note})` : ""}`);
      }
      const got = (Array.isArray(out.checked_out) ? out.checked_out : []).map(name);
      const head = lines.length
        ? `sql_source checkout: STOP. Someone else is editing ${lines.length} of these objects. Do not change them; tell the user who has them.${got.length ? ` Checked out for coop: ${got.join(", ")}.` : ""}`
        : `sql_source checkout: ${got.join(", ")} checked out for coop as ${out.user}. When the change is done: script (after a live dev change) or get_latest (after a file edit), show the diff, then commit with a message (the user approves it; the commit releases coop's checkout).`;
      return { head, lines };
    }
    case "release": {
      const done = (Array.isArray(out.released) ? out.released : []).map(name);
      for (const r of Array.isArray(out.refused) ? out.refused : []) lines.push(`- ${r.object} belongs to ${r.locked_by}; left alone`);
      return { head: `sql_source release: released ${done.length ? done.join(", ") : "nothing"}.`, lines };
    }
    case "script": {
      for (const f of Array.isArray(out.files) ? out.files : []) lines.push(`- ${f.action} ${f.path}`);
      return { head: `sql_source script: wrote ${lines.length} file(s) from ${t}. Show the user the diff, then sql_source commit with a message (they approve the commit).`, lines };
    }
    case "get_latest": {
      for (const s of Array.isArray(out.steps) ? out.steps : []) lines.push(`- ${s.action} ${name(s)}`);
      for (const k of Array.isArray(out.kept) ? out.kept : []) lines.push(`- kept ${name(k)}: ${k.reason} (the user settles it in their own terminal; coop never forces)`);
      for (const h of Array.isArray(out.held_back) ? out.held_back : []) lines.push(`- held back ${name(h)}: ${(h.notes || []).join("; ")}`);
      for (const f of Array.isArray(out.failed) ? out.failed : []) lines.push(`- failed ${f.object}: ${f.error}`);
      if (!input.apply) {
        if (out.script) lines.push("script:", ...String(out.script).split("\n"));
        return { head: `sql_source get_latest (dry run) on ${t}: ${(out.steps || []).length} step(s). Show the user the script; apply=true runs it on dev after their approval.`, lines };
      }
      return { head: `sql_source get_latest on ${t}: ${out.applied ? "applied" : "not applied"}${out.transaction ? " in one transaction" : ""}.`, lines };
    }
    case "commit": {
      for (const f of Array.isArray(out.files) ? out.files : []) lines.push(`- ${f.action} ${f.path}`);
      for (const s of Array.isArray(out.skipped) ? out.skipped : []) lines.push(`- left ${name(s)}: checked out by ${s.locked_by}`);
      for (const h of Array.isArray(out.held_back) ? out.held_back : []) lines.push(`- left ${name(h)}: ${h.reason}`);
      if (out.push_error) lines.push(`- ${out.push_error}`);
      const sha = out.commit ? String(out.commit).slice(0, 12) : "";
      const head = sha
        ? `sql_source commit: committed ${(out.files || []).length} file(s) as ${sha} on the repository's current branch (not pushed; the user pushes).`
        : `sql_source commit: nothing committed; the repo already matches the database${lines.length ? " apart from the objects left below" : ""}.`;
      return { head, lines };
    }
    case "init": {
      return { head: `sql_source init: wrote ${out.config || "sqlsc.yml"} (object files go in ${out.folder || "database"}/, target ${out.target || "dev"}). Next, in this task: sql_source status, then script the whole dev database and commit it with the message "baseline from dev" (the user approves the commit).`, lines };
    }
    case "deploy": {
      for (const s of Array.isArray(out.steps) ? out.steps : []) lines.push(`- ${s.action} ${name(s)}`);
      for (const h of Array.isArray(out.held_back) ? out.held_back : []) lines.push(`- held back ${name(h)}: ${(h.notes || []).join("; ")}`);
      for (const f of Array.isArray(out.failed) ? out.failed : []) lines.push(`- failed ${f.object}: ${f.error}`);
      const what = `${input.ref || "HEAD"}${out.commit ? ` (${String(out.commit).slice(0, 12)})` : ""} to ${t}`;
      if (!input.apply) {
        if (out.script) lines.push("script:", ...String(out.script).split("\n"));
        return { head: `sql_source deploy (dry run) of ${what}: ${(out.steps || []).length} step(s). Show the user the script; apply=true releases it after their approval. Production is released by a person.`, lines };
      }
      return { head: `sql_source deploy of ${what}: ${out.applied ? "released" : "not released"}${out.transaction ? " in one transaction" : ""}; sqlsc recorded it in sqlsc.Deployment.`, lines };
    }
    default:
      return { head: `sql_source ${input.command}: done.`, lines };
  }
}

// --- Nothing lost between SSMS and the files ---------------------------------
// `sqlsc script` writes the database's version of every differing object into
// the files, including one that changed in the repo too since the last sync
// (origin "both"): a file edit nobody applied would be overwritten. Before
// coop scripts, it reads `status` and refuses those objects; the person sees
// both diffs and says which side wins (then applies the files with get_latest,
// or scripts the object by name after deciding). Objects that changed in the
// database only, or that sync never saw (a baseline), script as asked.
const CONFLICT_ORIGINS = new Set(["both"]);

function sameObject(a, b) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[\[\]]/g, "").trim();
  return norm(a) === norm(b) || norm(a) === norm(String(b).split(".").pop());
}

/** The status changes `script` must not overwrite: changed on both sides,
 *  limited to the requested objects when any were named. */
export function scriptConflicts(statusOut, objects = []) {
  const changes = Array.isArray(statusOut?.changes) ? statusOut.changes : [];
  const wanted = Array.isArray(objects) ? objects.filter(Boolean) : [];
  return changes.filter((c) => c && CONFLICT_ORIGINS.has(String(c.origin || "").toLowerCase()))
    .filter((c) => !wanted.length || wanted.some((o) => sameObject(o, name(c))));
}

/** script's preflight (issue #414): the status read must have exited 0 and
 *  answered `ok: true` with a `changes` list, or nothing proves the conflict
 *  check ran, so script does not run. { ok: true, out } or { ok: false, reason }. */
export function scriptPreflight(res) {
  let out = null;
  try { out = JSON.parse(String(res?.stdout ?? "")); } catch { /* not JSON */ }
  const message = out && typeof out === "object" && out.error && typeof out.error === "object" ? String(out.error.message || out.error.kind || "").slice(0, 200) : "";
  let reason = "";
  if (res?.killed) reason = "the status read was stopped before it finished";
  else if (res?.code !== 0) reason = `status exited ${res?.code ?? "without a code"}${message ? `: ${message}` : ""}`;
  else if (!out || typeof out !== "object" || Array.isArray(out)) reason = "status did not answer with JSON";
  else if (out.ok !== true) reason = `status did not succeed${message ? `: ${message}` : ""}`;
  else if (!Array.isArray(out.changes)) reason = "status gave no list of changes";
  return reason ? { ok: false, reason } : { ok: true, out };
}

/** The refusal text for script when its preflight failed: nothing was written. */
export function scriptPreflightText(reason) {
  return `sql_source script: STOP. The status check that protects objects changed on both sides did not complete (${reason}), so coop did not script anything. Run sql_source status, fix what it reports, then script again.`;
}

/** The refusal text for script when conflicts exist. coop applies neither
 *  side (Aaron, 2026-10-21): get_latest keeps the object, script refuses it,
 *  and the person picks the winner with their own sqlsc command. */
export function scriptConflictText(conflicts) {
  const lines = conflicts.map((c) => `- ${c.type} ${name(c)}: changed in the database and in the repo since the last sync`);
  return {
    head: `sql_source script: STOP. ${conflicts.length} object(s) changed on both sides, so scripting would overwrite a file edit. coop cannot apply either side (get_latest keeps the object, script refuses it). Show the user sql_source diff for each; they choose and run it in their own terminal: \`sqlsc get-latest -t dev --force <object>\` keeps the file's version, \`sqlsc script -t dev <object>\` keeps the database's. Then run sql_source status again.`,
    lines,
  };
}

/** The objects a commit result committed, for coop to release its own
 *  checkouts of them afterwards (a teammate's never: sqlsc refuses those). */
export function committedObjects(out) {
  if (!out || !out.commit) return [];
  return (Array.isArray(out.files) ? out.files : []).filter((f) => f && (f.object || f.name)).map(name);
}

/** The lines a commit adds after releasing coop's checkouts (`unlock`'s JSON,
 *  or null when it did not answer). */
export function commitReleaseLines(objects, out) {
  if (!out || (out.ok === false && out.error)) {
    return [`- the checkout of ${objects.join(", ")} stays (${out?.error?.message || "coop-sqlsc did not answer"}); run sql_source release for them`];
  }
  const lines = [];
  const done = (Array.isArray(out.released) ? out.released : []).map(name);
  if (done.length) lines.push(`- released coop's checkout of ${done.join(", ")}`);
  for (const r of Array.isArray(out.refused) ? out.refused : []) lines.push(`- ${r.object} stays checked out by ${r.locked_by}`);
  return lines;
}

// --- Where a write really goes ------------------------------------------------
// A target named `dev` or `test` in sqlsc.yml can point anywhere, so a name is
// never trusted on its own. Before coop applies files (get_latest) or releases a
// commit (deploy), the guardrails read `sqlsc targets --json`, take the target's
// real server and database, and classify it with the project file's labels, the
// way every other write is classified: it must be the contract's ready
// `sql_targets` entry of that name (same server and database, or discovered
// from the contract's own Fabric ids), never protected, never named like
// production. Unlabelled or conflicting counts as production, and production
// is a person's command. Pure: the guardrails pass what they resolved.
/**
 * @param {object} args
 * @param {string} args.environment the target name coop asked for (dev or test)
 * @param {Array<object>} args.targets the `targets` rows sqlsc returned
 * @param {Record<string, {server: string, database: string, kind: string}>|undefined} args.entries the contract's ready sql_targets entries by name
 * @param {(values: string[]) => boolean} args.namesProduction true when a value is something the contract labels production
 * @returns {{ ok: boolean, reason: string, server: string, database: string, kind: string }}
 */
export function classifySqlscWrite({ environment, targets, entries, namesProduction }) {
  const env = String(environment || "").toLowerCase();
  const refuse = (reason, row = null) => ({ ok: false, reason, server: String(row?.server || ""), database: String(row?.database || ""), kind: String(row?.kind || "") });
  if (!DEPLOY_ENVIRONMENTS.has(env)) return refuse(`'${env || "(none)"}' is not dev or test; production is released by a person`);
  const rows = Array.isArray(targets) ? targets : [];
  const row = rows.find((r) => r && String(r.name || "").toLowerCase() === env);
  if (!row) return refuse(`sqlsc has no target named ${env}`);
  if (row.problem) return refuse(`sqlsc target ${env} is not ready: ${row.problem}`, row);
  const server = String(row.server || "").trim().toLowerCase();
  const database = String(row.database || "").trim();
  if (row.protected === true) return refuse(`sqlsc marks target ${env} as protected`, row);
  if (/(^|[^a-z0-9])(prod|production|prd|live)([^a-z0-9]|$)/i.test(`${server} ${database}`)) return refuse(`target ${env} (${server || "?"} / ${database || "?"}) is named like production`, row);
  if (typeof namesProduction === "function" && namesProduction([server, database])) return refuse(`target ${env} (${server || "?"} / ${database || "?"}) is a production server or database in the project file`, row);
  const entry = entries && typeof entries === "object" ? entries[env] : null;
  if (!entry) return refuse(`the project file has no ready sql_targets.${env} entry, so target ${env} is unlabelled and counts as production`, row);
  if (database.toLowerCase() !== String(entry.database || "").trim().toLowerCase()) return refuse(`sqlsc target ${env} is database ${database || "?"}, the project file's ${env} entry is ${entry.database}: conflicting, so it counts as production`, row);
  if (entry.server) {
    if (server !== String(entry.server).trim().toLowerCase()) return refuse(`sqlsc target ${env} is server ${server || "?"}, the project file's ${env} entry is ${entry.server}: conflicting, so it counts as production`, row);
  } else if (!/coop project\.yml/i.test(String(row.source || "")) || /sqlsc\.yml/i.test(String(row.source || ""))) {
    // A Fabric entry the contract names by workspace and item id: coop can only
    // vouch for it when sqlsc took it from the contract, not from an sqlsc.yml override.
    return refuse(`sqlsc target ${env} is set in sqlsc.yml, not taken from the project file's Fabric ids: conflicting, so it counts as production`, row);
  }
  return { ok: true, reason: "", server, database, kind: String(row.kind || entry.kind || "") };
}

// Pull before commit (Aaron, 2026-10-20: "Yes pull first"). A team shares one
// private client SQL repository, so a teammate may have pushed since this copy
// last pulled. Before `sql_source commit`, coop fetches the branch's upstream
// and fast-forwards onto it; a branch that cannot fast-forward (local commits
// diverge, or a pulled file collides with an uncommitted one) stops the commit
// and the user pulls by hand. A repository with no upstream (local only, or
// not yet pushed) commits as before. Git never prompts for a credential here
// (credential.interactive=never; there is no terminal, so a stored sign-in
// works and a missing one fails fast). `exec(bin, args, {cwd})` resolves to
// `{code, stdout, stderr}` like pi.exec.
//
// Two steps so the guardrails can stop BEFORE asking the user: `checkUpstream`
// only fetches (remote-tracking refs; the working tree is untouched) and says
// whether the branch can fast-forward; `pullBeforeCommit` fast-forwards after
// the approval, right before sqlsc commits.
function gitRunner(exec, repoDir) {
  return async (...args) => {
    try { return await exec("git", ["-C", repoDir, "-c", "credential.interactive=never", ...args], { cwd: repoDir }); }
    catch (e) { return { code: 127, stdout: "", stderr: String(e && e.message || e) }; }
  };
}

const firstLine = (res) => (res.stderr || res.stdout).trim().split("\n").filter(Boolean).slice(-1)[0] || "";

export async function checkUpstream(exec, repoDir) {
  const git = gitRunner(exec, repoDir);
  const up = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (up.code !== 0) return { ok: true, upstream: "", behind: 0, note: "no upstream branch: the commit stays local" };
  const upstream = up.stdout.trim();
  const remote = upstream.split("/")[0] || "origin";
  const fetched = await git("fetch", "--quiet", remote);
  if (fetched.code !== 0) return { ok: false, upstream, behind: 0, reason: `could not fetch ${remote} (${firstLine(fetched).slice(0, 160)}); the user pulls by hand, then coop commits` };
  const count = await git("rev-list", "--count", "HEAD..@{u}");
  const behind = count.code === 0 ? parseInt(count.stdout.trim(), 10) || 0 : 0;
  if (!behind) return { ok: true, upstream, behind: 0, note: `up to date with ${upstream}` };
  const ancestor = await git("merge-base", "--is-ancestor", "HEAD", "@{u}");
  if (ancestor.code !== 0) return { ok: false, upstream, behind, reason: `${behind} commit(s) behind ${upstream} and the branch cannot fast-forward (local commits diverge); the user pulls or rebases by hand, then coop commits` };
  return { ok: true, upstream, behind, note: `pulls ${behind} commit(s) from ${upstream} first (fast-forward)` };
}

export async function pullBeforeCommit(exec, repoDir) {
  const check = await checkUpstream(exec, repoDir);
  if (!check.ok || !check.behind) return { ...check, pulled: 0 };
  const pulled = await gitRunner(exec, repoDir)("pull", "--ff-only", "--quiet");
  if (pulled.code !== 0) {
    return { ok: false, upstream: check.upstream, behind: check.behind, pulled: 0, reason: `${check.behind} commit(s) behind ${check.upstream} and the pull did not fast-forward (${firstLine(pulled).slice(0, 160)}); the user pulls by hand, then coop commits` };
  }
  return { ok: true, upstream: check.upstream, behind: check.behind, pulled: check.behind, note: `pulled ${check.behind} commit(s) from ${check.upstream} first` };
}

export function pullRefusalText(result) {
  return `sql_source commit: not committed; ${result.reason}. Nothing was changed in the database or the files.`;
}
