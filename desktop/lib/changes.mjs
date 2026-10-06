// The changes panel's data (master plan D1b2): the working folder's changes
// against the last commit, read with git and never written. The list comes
// first (name-status and numstat); one file's diff is read when the panel
// shows it, so a large change set never crosses IPC at once. Paths are
// relative to the working folder with "/" separators, like Pi's edit paths.
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { childRepositories, findGitRoot } from "../../lib/project-contract.mjs";

// fsmonitor would run a configured hook; no-optional-locks keeps git from
// refreshing the index file. Output stays plain and paths unquoted.
const GIT = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false", "--no-optional-locks"];
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--relative", "-M"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const LIMITS = Object.freeze({ files: 2000, untracked: 500, diffBytes: 4 * 1024 * 1024, newFileBytes: 512 * 1024 });

function git(cwd, args, { execFileImpl = execFile, maxBuffer = LIMITS.diffBytes } = {}) {
  return new Promise((resolve) => {
    execFileImpl("git", [...GIT, ...args], { cwd, windowsHide: true, timeout: 20_000, maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, tooLarge: Boolean(error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const STATUS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflicted" };

/** `git diff --name-status -z` output as [{ status, path, oldPath? }]. */
export function parseNameStatus(text) {
  const parts = String(text).split("\0");
  const out = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const code = parts[i][0];
    if (code === "R" || code === "C") {
      out.push({ status: STATUS[code], oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      out.push({ status: STATUS[code] || "modified", path: parts[i + 1] });
      i += 2;
    }
  }
  return out.filter((entry) => typeof entry.path === "string" && entry.path);
}

/** `git diff --numstat -z` output as a Map of path -> { added, removed, binary }. */
export function parseNumstat(text) {
  const parts = String(text).split("\0");
  const out = new Map();
  for (let i = 0; i < parts.length && parts[i]; ) {
    const [added, removed, path] = parts[i].split("\t");
    const binary = added === "-" && removed === "-";
    const counts = { added: binary ? 0 : Number(added) || 0, removed: binary ? 0 : Number(removed) || 0, binary };
    // A rename: an empty path field, then the old and new paths.
    if (path === "") { out.set(parts[i + 2], counts); i += 3; } else { out.set(path, counts); i += 1; }
  }
  return out;
}

async function base(cwd, options) {
  const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], options);
  return head.ok && head.stdout.trim() ? "HEAD" : EMPTY_TREE;
}

/**
 * The folder's changes: { repo: false } outside a git repository, otherwise
 * { repo: true, files: [{ path, oldPath?, status, added, removed, binary }],
 * truncated }. Untracked files that git does not ignore are listed as "new".
 */
export async function listChanges(cwd, options = {}) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], options);
  if (!top.ok) return { repo: false, files: [], truncated: false };
  const against = await base(cwd, options);
  const [names, counts, others] = await Promise.all([
    git(cwd, ["diff", ...DIFF, "--name-status", "-z", against, "--", "."], options),
    git(cwd, ["diff", ...DIFF, "--numstat", "-z", against, "--", "."], options),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], options),
  ]);
  const stats = parseNumstat(counts.stdout);
  const files = parseNameStatus(names.stdout).map((entry) => ({ ...entry, ...(stats.get(entry.path) || { added: 0, removed: 0, binary: false }) }));
  const untracked = others.stdout.split("\0").filter(Boolean);
  for (const path of untracked.slice(0, LIMITS.untracked)) files.push({ status: "new", path, added: 0, removed: 0, binary: false });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = files.length > LIMITS.files || untracked.length > LIMITS.untracked || names.tooLarge || counts.tooLarge;
  return { repo: true, files: files.slice(0, LIMITS.files), truncated };
}

/**
 * The repositories the changes panel can show for the folder coop was opened
 * on: the folder's own repository (id "") when it is in one, then each
 * repository directly inside it (id = its folder name), the same one level
 * down lookup the project file uses. [{ id, label, dir }]; [] when there is
 * no repository at all.
 */
export function changeRepos(cwd) {
  const root = resolve(cwd || ".");
  const repos = [];
  if (findGitRoot(root)) repos.push({ id: "", label: basename(root) || root, dir: root });
  for (const name of childRepositories(root)) repos.push({ id: name, label: name, dir: join(root, name) });
  return repos;
}

/**
 * The repository to show when the panel has no choice yet: the open folder's
 * own, else the first repository one level down with changes, else the first.
 */
export async function defaultChangeRepo(repos, options = {}) {
  if (!repos.length) return null;
  if (repos[0].id === "") return repos[0];
  for (const repo of repos) {
    const result = await listChanges(repo.dir, options);
    if (result.files.length) return repo;
  }
  return repos[0];
}

/** A new file's text as a diff that adds every line. */
export function newFileDiff(text) {
  const lines = String(text).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return "";
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

/**
 * One listed file's diff as unified text: { diff, binary?, tooLarge? }.
 * `entry` must come from the last listChanges result (main.mjs checks that).
 */
export async function fileDiff(cwd, entry, options = {}) {
  if (entry.status === "new") {
    const full = join(cwd, entry.path);
    let stat;
    try { stat = await lstat(full); } catch { return { diff: "", gone: true }; }
    if (!stat.isFile()) return { diff: "", binary: true };
    if (stat.size > LIMITS.newFileBytes) return { diff: "", tooLarge: true };
    const bytes = await (options.readFileImpl || readFile)(full);
    if (bytes.includes(0)) return { diff: "", binary: true };
    return { diff: newFileDiff(bytes.toString("utf8")) };
  }
  const against = await base(cwd, options);
  const paths = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
  const result = await git(cwd, ["diff", ...DIFF, against, "--", ...paths], options);
  if (result.tooLarge) return { diff: "", tooLarge: true };
  if (!result.ok) return { diff: "", error: result.stderr.trim().split("\n").pop() || "git diff failed" };
  return { diff: result.stdout, binary: /^Binary files .* differ$/m.test(result.stdout) };
}
