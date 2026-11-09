// "Open in editor" for the changes panel: which program opens a changed file,
// worked out from the file alone. SQL opens in SSMS, a semantic model's files
// (TMDL, model.bim, .dax) open in Tabular Editor by default or Power BI
// Desktop when the person picks it, and anything else in Windows' own app for
// the file. coop never edits here: the person edits in that program, and the
// changes panel shows the result from git when it refreshes. Nothing here
// runs a program; main.mjs does, from the plan this returns.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DAX_EDITORS = Object.freeze(["tabular-editor", "power-bi"]);
export const DAX_EDITOR_LABELS = Object.freeze({ "tabular-editor": "Tabular Editor", "power-bi": "Power BI Desktop" });

/** "sql", "model" (a semantic model's file) or "other", from the path alone. */
export function editorKind(path) {
  const p = String(path || "").replace(/\\/g, "/");
  const name = basename(p).toLowerCase();
  if (name.endsWith(".sql")) return "sql";
  if (name.endsWith(".tmdl") || name.endsWith(".dax") || name.endsWith(".bim")) return "model";
  if (/\.semanticmodel\//i.test(p) && !/\.pbir$/i.test(name)) return "model";
  return "other";
}

// Where the programs install on Windows, newest first. SSMS 21 moved to
// Program Files; 18-20 are 32-bit. Tabular Editor 3 is 64-bit, 2 is 32-bit.
export function ssmsCandidates(env = process.env) {
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    `${pf}\\Microsoft SQL Server Management Studio 22\\Release\\Common7\\IDE\\SSMS.exe`,
    `${pf}\\Microsoft SQL Server Management Studio 21\\Release\\Common7\\IDE\\SSMS.exe`,
    `${pf86}\\Microsoft SQL Server Management Studio 20\\Common7\\IDE\\Ssms.exe`,
    `${pf86}\\Microsoft SQL Server Management Studio 19\\Common7\\IDE\\Ssms.exe`,
    `${pf86}\\Microsoft SQL Server Management Studio 18\\Common7\\IDE\\Ssms.exe`,
  ];
}

export function tabularEditorCandidates(env = process.env) {
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || "";
  return [
    `${pf}\\Tabular Editor 3\\TabularEditor3.exe`,
    ...(local ? [`${local}\\Programs\\Tabular Editor 3\\TabularEditor3.exe`] : []),
    `${pf86}\\Tabular Editor\\TabularEditor.exe`,
    `${pf}\\Tabular Editor\\TabularEditor.exe`,
    ...(local ? [`${local}\\Programs\\Tabular Editor\\TabularEditor.exe`] : []),
  ];
}

/**
 * What Tabular Editor opens for a model file: the TMDL folder (the one holding
 * database.tmdl), else the model.bim beside it, else the file itself. Looks
 * upward from the file, never above `stop`.
 */
export function modelTarget(file, stop, exists = existsSync) {
  const top = String(stop || "");
  let dir = dirname(file);
  for (let i = 0; i < 8; i += 1) {
    if (exists(join(dir, "database.tmdl"))) return dir;
    if (exists(join(dir, "model.bim"))) return join(dir, "model.bim");
    if (!top || dir === top || dirname(dir) === dir || !dir.startsWith(top)) break;
    dir = dirname(dir);
  }
  return file;
}

/**
 * The Power BI project (.pbip) a model file belongs to: `<Name>.pbip` beside
 * its `<Name>.SemanticModel` folder, else the only .pbip there; "" when none.
 */
export function pbipFor(file, { exists = existsSync, list = readdirSync } = {}) {
  let dir = dirname(file);
  for (let i = 0; i < 8; i += 1) {
    const name = basename(dir);
    if (/\.semanticmodel$/i.test(name)) {
      const parent = dirname(dir);
      const same = join(parent, `${name.replace(/\.semanticmodel$/i, "")}.pbip`);
      if (exists(same)) return same;
      let entries = [];
      try { entries = list(parent).filter((entry) => /\.pbip$/i.test(String(entry))); } catch { entries = []; }
      return entries.length === 1 ? join(parent, String(entries[0])) : "";
    }
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return "";
}

/**
 * How to open `file` (absolute): { kind, editor, exe, args, target, warn }.
 * `exe` set means run that program with `args`; otherwise main opens `target`
 * with Windows' own app for it (shell.openPath). `fallback` names the program
 * that was wanted but is not installed, so the person can be told.
 * `daxEditor` is the window setting ("tabular-editor" by default).
 */
export function editorPlan(file, { daxEditor = "tabular-editor", root = "", env = process.env, exists = existsSync, list = readdirSync, platform = process.platform } = {}) {
  const kind = editorKind(file);
  const find = (candidates) => (platform === "win32" ? candidates.find((path) => exists(path)) || "" : "");
  if (kind === "sql") {
    const exe = find(ssmsCandidates(env));
    return exe ? { kind, editor: "SSMS", exe, args: [file], target: file } : { kind, editor: "the default app", exe: "", args: [], target: file, fallback: "SSMS" };
  }
  if (kind === "model") {
    if (daxEditor === "power-bi") {
      const pbip = pbipFor(file, { exists, list });
      // Power BI Desktop opens the whole project and does not notice changes on
      // disk, so an open copy would save over coop's edit.
      if (pbip) return { kind, editor: "Power BI Desktop", exe: "", args: [], target: pbip, warn: "Power BI Desktop opens the whole project. If it is already open, close it first without saving, or its next save replaces coop's change." };
      return { kind, editor: "the default app", exe: "", args: [], target: file, fallback: "Power BI Desktop (no .pbip project found for this file)" };
    }
    const exe = find(tabularEditorCandidates(env));
    const target = modelTarget(file, root, exists);
    return exe ? { kind, editor: "Tabular Editor", exe, args: [target], target } : { kind, editor: "the default app", exe: "", args: [], target: file, fallback: "Tabular Editor" };
  }
  return { kind, editor: "the default app", exe: "", args: [], target: file };
}
