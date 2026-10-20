// The client folder in the window (master plan F1): the folder the icon opens
// without asking is this Windows user's recorded client folder
// (~/.coop/client.json, lib/client-folder.mjs); the one question
// (desktop/renderer/picker.html) records it. The window title and header name
// the client from the project file coop reads in that folder. Pure where it
// can be: the readers are injected so the gate lane tests it without a repository.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { findProjectContract } from "../../lib/standards.mjs";
import { clientRecord } from "../../lib/client-folder.mjs";
import { projectYamlScalar } from "../../lib/project-contract.mjs";
import { teamFileStatus } from "../../lib/project-share.mjs";
import { readBranch } from "./git.mjs";

const CLEAN = (value) => (typeof value === "string" && !/[\0\r\n]/.test(value) ? value.slice(0, 1024) : "");

/** The folder to open straight away when the icon starts the window (the
 *  recorded client folder, when it still exists), or "" to ask the one question. */
export function startFolder(record = clientRecord(), exists = existsSync) {
  const folder = CLEAN(record && record.root);
  return folder && exists(folder) ? folder : "";
}

function within(root, path, platform = process.platform) {
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const rel = relative(fold(resolve(root)), fold(resolve(path)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The team state of a project file in one word, from a teamFileStatus result
 *  taken without a fetch (the window never waits on the network for it). */
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
 * One description of a folder: its name, the client from the project file
 * coop would read there (above the folder, in the client home repository
 * beside it, or the recorded one), where that file lives, the branch and the
 * team word. `exists` false means the folder is gone (a moved clone).
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

/** The window title: the client and the folder when a project file names one. */
export function windowTitle(entry) {
  const folder = entry.name || entry.path;
  return entry.client ? `coop - ${entry.client} · ${folder}` : `coop - ${folder}`;
}
