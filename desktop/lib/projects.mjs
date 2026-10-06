// The project picker (master plan D1m): the folders the window has opened
// before, each with the client its committed project file names, the Git
// branch and whether the team's copy of the file is in step. The picker is
// the front door when the installed window starts from its icon with no
// folder; "open this one next time" skips it. Pure where it can be: the
// readers are injected so the gate lane tests it without a repository.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { findProjectContract } from "../../lib/standards.mjs";
import { projectYamlScalar } from "../../lib/project-contract.mjs";
import { teamFileStatus } from "../../lib/project-share.mjs";
import { readBranch } from "./git.mjs";

/** How many folders the picker remembers. */
export const MAX_PROJECTS = 12;

const CLEAN = (value) => (typeof value === "string" && !/[\0\r\n]/.test(value) ? value.slice(0, 1024) : "");

/** Case-insensitive on Windows, where the shell hands folders in either case. */
export function sameFolder(a, b, platform = process.platform) {
  const x = resolve(a), y = resolve(b);
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The settings with `folder` first in the remembered list (newest first, deduplicated). */
export function rememberProject(settings, folder, platform = process.platform) {
  const clean = CLEAN(folder);
  if (!clean) return settings;
  const rest = (settings.projects || []).filter((known) => !sameFolder(known, clean, platform));
  return { ...settings, projects: [clean, ...rest].slice(0, MAX_PROJECTS) };
}

/** The settings without `folder`; a forgotten folder is no longer the one opened next time. */
export function forgetProject(settings, folder, platform = process.platform) {
  const projects = (settings.projects || []).filter((known) => !sameFolder(known, folder, platform));
  const openNextTime = settings.openNextTime && sameFolder(settings.openNextTime, folder, platform) ? "" : settings.openNextTime;
  return { ...settings, projects, openNextTime };
}

/** The folder to open straight away when the icon starts the window, or "" to ask. */
export function startFolder(settings, exists = existsSync) {
  const folder = CLEAN(settings.openNextTime);
  return folder && exists(folder) ? folder : "";
}

function within(root, path, platform = process.platform) {
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const rel = relative(fold(resolve(root)), fold(resolve(path)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The team state of a project file in one word for the picker, from a
 *  teamFileStatus result taken without a fetch (the picker never waits on the network). */
export function teamWord(status) {
  if (!status) return "";
  switch (status.state) {
    case "not-shared": return "Not shared yet";
    case "no-remote": return status.localExists ? "Not shared yet" : "";
    case "team-newer": return "The team has a newer file";
    case "team-has-it": return "The team has a project file you do not have yet";
    default: return "";
  }
}

const defaultReaders = {
  exists: existsSync,
  contractFor: (folder) => findProjectContract(folder),
  readText: (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } },
  branch: (folder) => readBranch(folder),
  team: (root) => { try { return teamFileStatus(root, { fetch: false }); } catch { return null; } },
};

/**
 * One picker entry for a folder: its name, the client from the project file
 * coop would read there (above the folder, or in the client home repository
 * beside it), where that file lives, the branch and the team word. `exists`
 * false means the folder is gone (a moved clone); the picker drops it.
 */
export function describeProject(folder, readers = {}) {
  const r = { ...defaultReaders, ...readers };
  const path = resolve(folder);
  const entry = { path, name: basename(path) || path, exists: r.exists(path), contract: "", root: "", client: "", home: false, branch: "", team: "" };
  if (!entry.exists) return entry;
  entry.branch = r.branch(path) || "";
  const contract = r.contractFor(path);
  if (!contract) return entry;
  entry.contract = contract;
  entry.root = resolve(contract, "..", "..");
  entry.client = projectYamlScalar(r.readText(contract), ["profile", "client"]) || "";
  // The file lives in the client home repository beside this folder, not above it.
  entry.home = !within(entry.root, path);
  entry.team = teamWord(r.team(entry.root));
  return entry;
}

/** The picker's rows, newest first, folders that still exist only. */
export function projectEntries(settings, readers = {}) {
  return (settings.projects || []).map((folder) => describeProject(folder, readers)).filter((entry) => entry.exists);
}

/** The window title: the client and the folder when a project file names one. */
export function windowTitle(entry) {
  const folder = entry.name || entry.path;
  return entry.client ? `coop - ${entry.client} · ${folder}` : `coop - ${folder}`;
}
