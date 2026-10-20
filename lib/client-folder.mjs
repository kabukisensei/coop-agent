// The client folder (master plan F1; Aaron, 2026-10-20). coop's folder model is
// three places: this machine (%ProgramData%\coop), this client
// (%USERPROFILE%\.coop: one Windows user is one client) and the repository
// (<repo>\.coop). One client is one folder, the client folder, holding all of
// its repositories (the home repository with the team's project file, the sql
// repository, the powerbi repository...). coop always opens in the client
// folder, finds the one project file from there and edits in whichever
// repository the task names. The record is `<profile dir>/client.json`:
//   { schema_version: 1, client, root, project_file }
// It replaces `home-project.json`, which a profile may still have: a record
// read from the old file alone is `carried` (the launcher writes client.json
// once and says so). Mirrors Get-CoopClientRecord, Get-CoopClientRootFor and
// Save-CoopClientRecord in lib/common.ps1; the two are tested on the same fixtures.
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { profileDir } from "./paths.mjs";
import { projectYamlScalar, repositoryNames } from "./project-contract.mjs";

export function clientRecordPath(env = process.env) {
  return join(profileDir(env), "client.json");
}

export function homeProjectRecordPath(env = process.env) {
  return join(profileDir(env), "home-project.json");
}

function readText(file) {
  try { return readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return ""; }
}

/** The client a project file names (`profile.client`), or "". */
export function contractClientName(projectFile) {
  const value = projectYamlScalar(readText(projectFile), ["profile", "client"]) || "";
  return /^TODO\b/i.test(value) ? "" : value;
}

/** True when the project file's `repositories` list points to siblings (a local_path starting `..`). */
function listsSiblings(projectFile) {
  const text = readText(projectFile);
  return repositoryNames(text).some((name) => /^\.\.(?:[\\/]|$)/.test(projectYamlScalar(text, ["repositories", name, "local_path"]) || ""));
}

const fold = (path, platform) => (platform === "win32" ? path.toLowerCase() : path);

/** True when `path` is `root` or inside it. */
function inside(root, path, platform = process.platform) {
  const r = fold(resolve(root), platform), p = fold(resolve(path), platform);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Where the client folder is for a project file: the one rule, the same as
 * Get-CoopClientRootFor in lib/common.ps1. `startDir` is the launch folder
 * whose search found the file ("" when carrying an old record over, or when
 * the user chose the folder):
 *   - found at or above the launch folder: the repository, or its parent when
 *     the file's `repositories` list points to siblings;
 *   - found in the home repository beside the launch folder's repository: that parent;
 *   - found in a repository inside the launch folder: the launch folder.
 */
function clientRootForRaw(projectFile, startDir, platform) {
  const repo = resolve(projectFile, "..", "..");
  const parent = dirname(repo);
  if (startDir) {
    const start = resolve(startDir);
    if (!inside(repo, start, platform)) return inside(start, repo, platform) ? start : parent;
  }
  return listsSiblings(projectFile) ? parent : repo;
}

/** The rule above, except that the user folder is never the client folder: a
 *  shortcut launch starts there, and a repository sitting directly in it holds
 *  the client, not the profile. `home` is injectable for tests. */
export function clientRootFor(projectFile, startDir = "", platform = process.platform, home = homedir()) {
  const same = (a, b) => (platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
  let root = clientRootForRaw(projectFile, startDir, platform);
  if (home && same(root, home)) {
    root = clientRootForRaw(projectFile, "", platform);
    if (same(root, home)) root = resolve(projectFile, "..", "..");
  }
  return root;
}

/**
 * The client record: `{ client, root, project_file, carried, exists }`. Reads
 * client.json; with only the old home-project.json it carries that over in
 * memory (`carried: true`; nothing is written here) with the root the rule
 * gives without a launch folder. `exists` is false when neither file is there.
 */
export function clientRecord(env = process.env) {
  const empty = { client: "", root: "", project_file: "", carried: false, exists: false };
  const text = readText(clientRecordPath(env));
  const str = (value) => (typeof value === "string" ? value : "");
  if (text) {
    try {
      const doc = JSON.parse(text);
      return { client: str(doc.client), root: str(doc.root), project_file: str(doc.project_file), carried: false, exists: true };
    } catch { return empty; }
  }
  const old = readText(homeProjectRecordPath(env));
  if (!old) return empty;
  let file = "";
  try { file = str(JSON.parse(old).project_file); } catch { return empty; }
  if (!file) return empty;
  return { client: contractClientName(file), root: clientRootFor(file), project_file: file, carried: true, exists: true };
}

/** Write client.json (`root` is the client folder; `project_file` may be "" when none is found yet). Returns what was written. */
export function saveClientRecord({ client = "", root, project_file = "" }, env = process.env) {
  if (!root) throw new Error("the client folder is required");
  const file = clientRecordPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const doc = { schema_version: 1, client: String(client || ""), root: resolve(root), project_file: project_file ? resolve(project_file) : "" };
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(doc) + "\n");
  renameSync(temp, file);
  return doc;
}
