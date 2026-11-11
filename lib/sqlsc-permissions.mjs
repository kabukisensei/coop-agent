// The project-file lines coop needs before it may commit sqlsc's files, found
// and added on the person's say-so (Aaron, 2026-11-11). A client project that
// allowed only `database/**` made its baseline, then the strict commit check
// (11-05) also asked for the setup files sqlsc writes beside sqlsc.yml; nothing
// in coop wrote them, so every client found it by hand.
//
// The rules: lib/sqlsc.mjs sqlscCommitCheck (the guard's own check) says what is
// missing; this module plans the smallest change, to the one repositories entry
// whose local_path is the sqlsc.yml folder in the project file the guard trusts
// this session, and writes it only after the person approved the exact diff,
// with a backup outside the repository. It never removes or narrows a deny rule,
// never grants anything beyond sqlscRequiredGlobs, never touches another entry
// or the top-level policy, and runs nothing: no SQL, no sqlsc, no git.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { appendProjectYamlListItems, findSiblingContract, projectYamlList, projectYamlScalar, repositoryNames as repositoryNamesIn, writeProjectContract } from "./project-contract.mjs";
import { repositoryEntriesAt, sqlscCommitCheck, sqlscFolder, sqlscFolderFiles, sqlscRequiredGlobs } from "./sqlsc.mjs";
import { findProjectContract, rememberedProjectFile } from "./standards.mjs";

const ALLOW = "agent_allowed_to_commit";
const DENY = "agent_never_commit";

/** Plan the contract change that lets coop commit the sqlsc files of
 *  `configFile` (a sqlsc.yml), in `contractPath` (the project file the session's
 *  guard reads). `folder` overrides sqlsc.yml (init's question, before the file
 *  exists). Returns { state, contract, repository, folder, add, conflicts,
 *  reason, text, newText, diff }. States: `ok` (nothing to do), `missing` (newText
 *  adds `add`), `conflict` (a deny rule is in the way: no change offered),
 *  `no_contract`, `no_repository`, `ambiguous` (several entries share the
 *  folder), `unsupported` (the list is written in a shape this cannot extend). */
export function sqlscPermissionPlan({ configFile, contractPath, folder: forced = "" }) {
  const dir = resolve(dirname(configFile));
  const folder = forced || sqlscFolder(configFile);
  const base = { contract: contractPath || "", repository: "", folder, dir, add: [], conflicts: [], reason: "", text: "", newText: "", diff: "" };
  if (!contractPath || !existsSync(contractPath)) {
    return { ...base, state: "no_contract", reason: "there is no .coop/project.yml for this session; /setup-project creates one" };
  }
  const text = readFileSync(contractPath, "utf8");
  const entries = repositoryEntriesAt(contractPath, text, dir);
  if (!entries.length) {
    return { ...base, text, state: "no_repository", reason: `no repositories entry in ${contractPath} has local_path ${dir}; add the SQL repository with /setup-project or the Project pane first` };
  }
  if (entries.length > 1) {
    return { ...base, text, state: "ambiguous", reason: `${entries.length} repositories entries (${entries.map((e) => e.name).join(", ")}) point at ${dir}; keep one, then run this again` };
  }
  const repository = entries[0].name;
  const allowed = projectYamlList(text, ["repositories", repository, ALLOW]).filter(Boolean);
  const denied = projectYamlList(text, ["repositories", repository, DENY]).filter(Boolean);
  const check = sqlscCommitCheck({ folder, allowed, denied, files: sqlscFolderFiles(dir, folder) });
  const planned = { ...base, text, repository };
  if (check.ok) return { ...planned, state: "ok" };
  if (check.conflicts.length) {
    return { ...planned, state: "conflict", conflicts: check.conflicts, reason: `repositories.${repository}.${DENY} has ${check.conflicts.join(", ")}, which covers files sqlsc commits; coop never removes a deny rule, so the user narrows it by hand (for example to the folders that are not SQL source control), then runs this again` };
  }
  const add = check.missing;
  const newText = appendProjectYamlListItems(text, ["repositories", repository, ALLOW], add);
  if (newText === null) {
    return { ...planned, state: "unsupported", add, reason: `repositories.${repository}.${ALLOW} is written in a shape coop does not edit; add ${add.join(", ")} to it by hand` };
  }
  // The change must satisfy the same check the guard runs, or nothing is offered.
  const after = sqlscCommitCheck({ folder, allowed: projectYamlList(newText, ["repositories", repository, ALLOW]).filter(Boolean), denied, files: sqlscFolderFiles(dir, folder) });
  if (!after.ok) return { ...planned, state: "unsupported", add, reason: after.reason };
  return { ...planned, state: "missing", add, newText, diff: lineDiff(text, newText) };
}

/** A small unified-style diff of an insert-only change: the changed lines with
 *  two lines of context and their line numbers. */
export function lineDiff(before, after) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let tail = 0;
  while (tail < a.length - top && tail < b.length - top && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = Math.max(0, top - 2);
  const out = [`@@ line ${top + 1} @@`];
  for (let i = from; i < top; i++) out.push(`  ${a[i]}`);
  for (let i = top; i < a.length - tail; i++) out.push(`- ${a[i]}`);
  for (let i = top; i < b.length - tail; i++) out.push(`+ ${b[i]}`);
  for (let i = b.length - tail; i < Math.min(b.length, b.length - tail + 2); i++) out.push(`  ${b[i]}`);
  return out.join("\n");
}

/** Write a planned change: only when the file still reads exactly as planned
 *  (the diff the person approved), after a backup in this client's backups
 *  folder outside the repository. { ok, backup } or { ok: false, reason }. */
export function applySqlscPermissionPlan(plan, { env = process.env, now = new Date() } = {}) {
  if (!plan || plan.state !== "missing" || !plan.newText) return { ok: false, reason: "nothing to change" };
  let current = "";
  try { current = readFileSync(plan.contract, "utf8"); } catch { return { ok: false, reason: `${plan.contract} could not be read` }; }
  if (current !== plan.text) return { ok: false, reason: `${plan.contract} changed after the change was shown; nothing was written, run it again` };
  const backup = writeProjectContract(plan.contract, plan.newText, { env, now });
  return { ok: true, backup };
}

/** The other project files that also list the SQL repository folder (the
 *  repository's own `.coop/project.yml`, the client home project file beside it,
 *  the remembered one): named so the person knows which one was not changed. */
export function otherContractsFor(dir, chosen, { cwd = dir, env = process.env } = {}) {
  const seen = new Set([chosen ? resolve(chosen) : ""]);
  const out = [];
  const candidates = [findProjectContract(dir, env), join(dir, ".coop", "project.yml"), env && env.COOP_PROJECT_YML, rememberedProjectFile(env), findSiblingContract(dir), findSiblingContract(cwd)];
  for (const raw of candidates) {
    if (!raw) continue;
    const path = resolve(raw);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    if (repositoryEntriesAt(path, text, dir).length) out.push(path);
  }
  return out;
}

/** The person's view of a plan: what changes where, or why nothing does. */
export function permissionPlanText(plan, others = []) {
  const lines = [];
  if (plan.state === "ok") lines.push(`SQL source control commits are already allowed for repositories.${plan.repository} in ${plan.contract} (folder ${plan.folder}/). Nothing to change.`);
  else if (plan.state === "missing") {
    lines.push(`To let coop commit sqlsc's files (each commit still asks you, and coop never pushes), ${plan.contract} needs ${plan.add.join(", ")} under repositories.${plan.repository}.agent_allowed_to_commit (scripts folder ${plan.folder}/ from sqlsc.yml). Nothing else in the file changes:`, "", plan.diff);
  } else lines.push(`No change: ${plan.reason}.`);
  if (others.length) lines.push("", `Not changed (another project file that also lists this repository): ${others.join(", ")}. It applies when coop starts from there; run this from there to update it.`);
  return lines.join("\n");
}

/** Required globs for a folder (re-exported for the readiness lines). */
export { sqlscRequiredGlobs };

export const RELOAD_NOTE = "Run /new (or restart coop) so the guardrails use the updated project file: this session keeps the one it started with.";

/** `/sql-source permissions`: show the plan, ask once, write on yes. `confirm`
 *  is (title, message) => Promise<boolean>, or null when no one can be asked
 *  (headless): then nothing is written. Returns { state, text, wrote, backup }. */
export async function sqlscPermissionsCommand({ cwd, configFile, contractPath, confirm, env = process.env, now = new Date() }) {
  if (!configFile) return { state: "not_set_up", wrote: false, text: "No sqlsc.yml here or in the project's SQL repository: SQL source control is not set up, so there is nothing to allow yet (ask coop to set it up with sql_source init)." };
  const plan = sqlscPermissionPlan({ configFile, contractPath });
  const others = otherContractsFor(plan.dir, contractPath, { cwd, env });
  const text = permissionPlanText(plan, others);
  if (plan.state !== "missing") return { state: plan.state, wrote: false, text, plan };
  if (typeof confirm !== "function") return { state: "headless", wrote: false, plan, text: `${text}\n\nNo change made: this needs your approval in an interactive coop session (/sql-source permissions).` };
  let yes = false;
  try { yes = await confirm("Allow SQL source control commits?", `${text}\n\nA backup of the project file is kept outside the repository. Make this change?`); } catch { yes = false; }
  if (!yes) return { state: "declined", wrote: false, plan, text: "No change made to the project file." };
  const done = applySqlscPermissionPlan(plan, { env, now });
  if (!done.ok) return { state: "failed", wrote: false, plan, text: `No change made: ${done.reason}.` };
  return { state: "written", wrote: true, plan, backup: done.backup, text: `Updated ${plan.contract}: added ${plan.add.join(", ")} under repositories.${plan.repository}.agent_allowed_to_commit${done.backup ? `. Backup (this client): ${done.backup}` : ""}. ${RELOAD_NOTE}` };
}

/** Read-only readiness for the window's Project pane: for each repositories
 *  entry with a sqlsc.yml at its local_path, whether coop may commit sqlsc's
 *  files there (the guard's own check) and the one-line fix. { [name]: { state,
 *  folder, add, conflicts, note } }. */
export function sqlSourceReadiness(contractPath, text) {
  const out = {};
  if (!contractPath || !text) return out;
  const root = dirname(dirname(contractPath));
  for (const name of repositoryNamesIn(text)) {
    const dir = localPathDir(root, text, name);
    if (!dir) continue;
    const config = join(dir, "sqlsc.yml");
    if (!existsSync(config)) continue;
    const plan = sqlscPermissionPlan({ configFile: config, contractPath });
    if (plan.repository !== name && plan.state !== "ambiguous") continue;
    const note = plan.state === "ok" ? `coop can commit SQL source control files here (folder ${plan.folder}/; each commit still asks).`
      : plan.state === "missing" ? `coop cannot commit SQL source control files here yet: needs ${plan.add.join(", ")}. Run /sql-source permissions to see the change and approve it.`
      : `coop cannot commit SQL source control files here: ${plan.reason}.`;
    out[name] = { state: plan.state, folder: plan.folder, add: plan.add, conflicts: plan.conflicts, note };
  }
  return out;
}

function localPathDir(root, text, name) {
  const localPath = projectYamlScalar(text, ["repositories", name, "local_path"]);
  if (!localPath || /^todo/i.test(localPath.trim())) return "";
  return isAbsolute(localPath) ? resolve(localPath) : resolve(root, localPath);
}
