// The shared project file (master plan C1, the design in the project's
// demo/c1-shared-contract-design.md): every client has one committed
// .coop/project.yml in a repository the whole team clones. This module is the
// one place coop touches Git for that file, so nobody needs to know Git:
//
//   teamFileStatus   how the local file compares with the team's copy on origin
//   getTeamContract  "Get the team's project file": a fast-forward pull when the
//                    checkout is clean and on the default branch, else only the
//                    file's content from origin (nothing else moves)
//   shareContract    "Share with the team": stage .coop/project.yml alone, commit
//                    it with a fixed message, push the current branch; audited
//   createHomeRepository  the client home repository `<client>-coop` beside the
//                    client's repositories (folder, `git init`, README)
//
// Sharing is the one Git write coop performs on its own, after the user's yes
// (Aaron, 2026-10-05); it never stages or commits any other file. Used by
// coop-tools (/project-share, /project-get, the session-start check), the window's
// Project pane and `coop project <status|get|share>` through the CLI at the bottom.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, userProfilePath } from "./paths.mjs";
import { clientSlug, findGitRoot, writeProjectContract } from "./project-contract.mjs";

export const CONTRACT_FILE = ".coop/project.yml";
export const FETCH_MAX_AGE_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;

function git(root, args, { timeout = GIT_TIMEOUT_MS, env = process.env } = {}) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error ? String(r.error.message || r.error) : "" };
}

function ok(result) {
  return result.code === 0 && !result.error;
}

/** The last non-empty line of git's stderr, with URLs and tokens kept out. */
function reasonLine(result) {
  const lines = `${result.stderr}\n${result.error}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines[lines.length - 1] || "git failed";
  return line.replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z0-9_-]{30,}/g, "<token>").slice(0, 200);
}

/** The contract's repository root for a contract path, or null outside Git. */
export function contractRepository(contractPath) {
  const root = resolve(contractPath, "..", "..");
  const gitRoot = findGitRoot(root);
  return gitRoot === root ? root : gitRoot;
}

export function currentBranch(root) {
  const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return ok(r) ? r.stdout.trim() : "";
}

/** origin's default branch ("main"), from origin/HEAD, else the first of
 *  origin/main and origin/master that exists, else "". */
export function defaultBranch(root) {
  const head = git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (ok(head) && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (ok(git(root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`]))) return name;
  }
  return "";
}

export function hasOrigin(root) {
  return ok(git(root, ["remote", "get-url", "origin"]));
}

/** `git fetch origin`, at most once per FETCH_MAX_AGE_MS per repository (the
 *  throttle coop's standards sync uses too). Network failures are not errors:
 *  the comparison then uses what the last fetch brought. */
export function fetchOrigin(root, { maxAgeMs = FETCH_MAX_AGE_MS, now = Date.now(), env, timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    const stamp = join(root, ".git", "FETCH_HEAD");
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < maxAgeMs) return { fetched: false, fresh: true };
  } catch { /* fetch anyway */ }
  const r = git(root, ["fetch", "--quiet", "origin"], { env, timeout });
  return { fetched: ok(r), fresh: ok(r), reason: ok(r) ? "" : reasonLine(r) };
}

function blob(root, ref) {
  const r = git(root, ["show", `${ref}:${CONTRACT_FILE}`]);
  return ok(r) ? r.stdout : null;
}

// Git for Windows checks text files out with CRLF (core.autocrlf=true by
// default) while the blob keeps LF, so the comparison ignores line endings.
function sameText(a, b) {
  return a !== null && b !== null && a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

function cleanTree(root) {
  const r = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return ok(r) && !r.stdout.trim();
}

/**
 * How the local project file compares with the team's copy.
 * state: no-git | no-remote | none | team-has-it | not-shared | shared | team-newer
 *   none         neither here nor on origin
 *   team-has-it  origin has the file, this checkout does not
 *   not-shared   the local file differs from origin's (or origin has none) and
 *                carries local edits: offer "Share with the team"
 *   shared       identical to origin's copy
 *   team-newer   the local file is unmodified but origin's copy moved: offer
 *                "Get the team's version"
 */
export function teamFileStatus(root, { fetch = true, env, now, fetchTimeout } = {}) {
  const repo = findGitRoot(root);
  const localPath = join(resolve(root), CONTRACT_FILE);
  let localText = null;
  try { localText = readFileSync(localPath, "utf8"); } catch { localText = null; }
  if (!repo || repo !== resolve(root)) return { state: "no-git", root: resolve(root), path: localPath, localExists: localText !== null };
  if (!hasOrigin(repo)) return { state: "no-remote", root: repo, path: localPath, localExists: localText !== null, branch: currentBranch(repo) };
  const fetched = fetch ? fetchOrigin(repo, { env, now, ...(fetchTimeout ? { timeout: fetchTimeout } : {}) }) : { fetched: false, fresh: false };
  const def = defaultBranch(repo);
  const originText = def ? blob(repo, `origin/${def}`) : null;
  const headText = blob(repo, "HEAD");
  const branch = currentBranch(repo);
  const base = { root: repo, path: localPath, branch, defaultBranch: def, localExists: localText !== null, originExists: originText !== null, fetched: fetched.fetched, fetchReason: fetched.reason || "" };
  if (localText === null && originText === null) return { ...base, state: "none" };
  if (localText === null) return { ...base, state: "team-has-it" };
  if (originText === null) return { ...base, state: "not-shared" };
  if (sameText(localText, originText)) return { ...base, state: "shared" };
  if (sameText(localText, headText)) return { ...base, state: "team-newer" };
  return { ...base, state: "not-shared" };
}

/** "Get the team's project file": the fast-forward pull when nothing else would
 *  move (clean checkout on the default branch, HEAD an ancestor of origin), else
 *  only the file's content from origin, written with a backup. */
export function getTeamContract(root, { env, now } = {}) {
  const status = teamFileStatus(root, { env, now });
  if (status.state === "no-git" || status.state === "no-remote") return { ok: false, state: status.state, reason: status.state === "no-git" ? "this folder is not a Git repository" : "this repository has no origin remote" };
  if (!status.originExists) return { ok: false, state: status.state, reason: "origin has no .coop/project.yml yet" };
  if (status.state === "shared") return { ok: true, state: "shared", method: "none", path: status.path };
  const repo = status.root;
  const ref = `origin/${status.defaultBranch}`;
  if (status.branch === status.defaultBranch && cleanTree(repo) && ok(git(repo, ["merge-base", "--is-ancestor", "HEAD", ref]))) {
    const pull = git(repo, ["pull", "--ff-only", "--quiet", "origin", status.defaultBranch], { env });
    if (ok(pull)) return { ok: true, state: "got", method: "pull", path: status.path, backup: null };
  }
  const text = blob(repo, ref);
  if (text === null) return { ok: false, state: status.state, reason: "could not read origin's copy" };
  const backup = writeProjectContract(status.path, text);
  return { ok: true, state: "got", method: "file", path: status.path, backup };
}

/** The name the share commit carries: the local coop profile's name, else
 *  git's user.name, else "coop". */
export function sharerName(root, env = process.env) {
  try {
    const profile = JSON.parse(readFileSync(userProfilePath(env), "utf8"));
    if (profile && typeof profile.name === "string" && profile.name.trim()) return profile.name.trim();
  } catch { /* no profile */ }
  const r = git(root, ["config", "user.name"]);
  if (ok(r) && r.stdout.trim()) return r.stdout.trim();
  return "coop";
}

/** One row in the guardrails audit (same file and shape as coop-guardrails),
 *  so `/coop-guardrails` lists every share beside the other governed actions. */
export function shareAudit({ cwd, decision, detail }, env = process.env) {
  try {
    const path = join(agentDir(env), "guardrails-audit.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), cwd, kind: "project-share", tool: "project-share", decision, label: CONTRACT_FILE, detail, pid: process.pid }) + "\n");
  } catch { /* a logging failure never blocks the share */ }
}

/**
 * "Share with the team": after the user's yes, stage .coop/project.yml alone,
 * commit it with the fixed message, push the current branch. Nothing else is
 * staged or committed (`git commit -- <path>` commits that path only). On a
 * branch that is not the default the caller asks first (`force` pushes anyway);
 * a refused push is reported, never retried.
 * @returns {{ ok: boolean, state: "shared" | "already-shared" | "other-branch" | "push-refused" | "nothing" | "no-git" | "no-remote", ... }}
 */
export function shareContract(root, { name = "", force = false, env = process.env, now } = {}) {
  const status = teamFileStatus(root, { env, now });
  if (status.state === "no-git" || status.state === "no-remote") {
    return { ok: false, state: status.state, reason: status.state === "no-git" ? "this folder is not a Git repository: the team's project file belongs in a repository the team clones" : "this repository has no origin remote to share to" };
  }
  if (!status.localExists) return { ok: false, state: "nothing", reason: "there is no .coop/project.yml here to share" };
  if (status.state === "shared") return { ok: true, state: "already-shared", branch: status.branch };
  const repo = status.root;
  if (status.branch !== status.defaultBranch && !force) {
    return { ok: false, state: "other-branch", branch: status.branch, defaultBranch: status.defaultBranch, reason: `this checkout is on ${status.branch}, not ${status.defaultBranch || "the default branch"}: the team reads the project file from ${status.defaultBranch || "the default branch"}` };
  }
  const who = name || sharerName(repo, env);
  const add = git(repo, ["add", "--", CONTRACT_FILE]);
  if (!ok(add)) { shareAudit({ cwd: repo, decision: "blocked", detail: `add: ${reasonLine(add)}` }, env); return { ok: false, state: "push-refused", reason: reasonLine(add) }; }
  const committed = git(repo, ["commit", "--quiet", "-m", `coop: project file updated by ${who}`, "--", CONTRACT_FILE], { env });
  // "nothing to commit" is fine when the file is committed but not yet pushed.
  const push = git(repo, ["push", "--quiet", "origin", "HEAD"], { env });
  if (!ok(push)) {
    shareAudit({ cwd: repo, decision: "blocked", detail: `push ${status.branch}: ${reasonLine(push)}` }, env);
    return { ok: false, state: "push-refused", branch: status.branch, committed: ok(committed), reason: reasonLine(push) };
  }
  shareAudit({ cwd: repo, decision: "allowed", detail: `push ${status.branch}` }, env);
  const head = git(repo, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, state: "shared", branch: status.branch, commit: ok(head) ? head.stdout.trim() : "", by: who };
}

/** The client home repository README coop ships. */
export const HOME_TEMPLATE_DIR = join(process.env.COOP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."), "templates", "client-home");

/** Create the client home repository `<client>-coop` at `root` (the folder,
 *  `git init` when it is not a repository yet, a README from the template).
 *  Idempotent: an existing repository is left as it is. */
export function createHomeRepository(root, client, { templateDir = HOME_TEMPLATE_DIR } = {}) {
  const result = { root, created: false, initialized: false, readme: false };
  if (!existsSync(root)) { mkdirSync(root, { recursive: true }); result.created = true; }
  if (!existsSync(join(root, ".git"))) {
    const init = git(root, ["init", "--quiet"]);
    if (!ok(init)) return { ...result, error: reasonLine(init) };
    result.initialized = true;
  }
  const readme = join(root, "README.md");
  if (!existsSync(readme)) {
    let text = "";
    try { text = readFileSync(join(templateDir, "README.md"), "utf8").replace(/\r\n/g, "\n"); } catch { text = `# ${basename(root)}\n\nThe coop client home repository for ${client}.\n`; }
    writeFileSync(readme, text.replace(/<client>/g, client || basename(root).replace(/-coop$/, "")).replace(/<slug>/g, clientSlug(client || basename(root))), "utf8");
    result.readme = true;
  }
  return result;
}

// --- CLI: node lib/project-share.mjs <status|get|share> [--root R] [--name N] [--force]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] || "" : ""; };
  const root = resolve(opt("--root") || ".");
  let out;
  if (command === "status") out = teamFileStatus(root);
  else if (command === "get") out = getTeamContract(root);
  else if (command === "share") out = shareContract(root, { name: opt("--name"), force: args.includes("--force") });
  else out = { ok: false, reason: `unknown command ${command}` };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(out.ok === false ? 1 : 0);
}
