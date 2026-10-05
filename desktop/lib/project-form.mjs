// The project form's back end (master plan D1b2): .coop/project.yml as a form,
// written only through the /setup-project writer in lib/project-contract.mjs.
// The window's answers are untrusted: settingsFromForm rebuilds wizard
// settings field by field from an allowlist, with the wizard's own cleaning and
// checks, so the same answers write the same file as /setup-project, unowned
// fields are kept and the old file is backed up. The form never sees or sends
// the fields nothing reads (estate.live_discovery, the mcp.* action lists).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { findProjectContract } from "../../lib/standards.mjs";
import { contractRepository, createHomeRepository, getTeamContract, hasOrigin, shareContract, teamFileStatus } from "../../lib/project-share.mjs";
import { userProfilePath } from "../../lib/paths.mjs";
import { effectiveProfile } from "../../lib/user-profile.mjs";
import {
  FABRIC_LAYOUTS,
  PROJECT_MESSAGES,
  SQL_ENDPOINT_TYPES,
  TABLE_MAPPING_RULES,
  projectYamlMapping,
  SQL_TARGET_DISCOVERED_KINDS,
  SQL_TARGET_KINDS,
  cleanAnswer,
  clientPlatform,
  contractCreatedNote,
  contractLocationNote,
  estateMode,
  findGitRoot,
  isSavableProfileName,
  proposeContractRoot,
  siblingRepositoryEntries,
  parseProjectWizardSettings,
  projectContractText,
  projectSettingsProblems,
  projectYamlList,
  proposedSqlTargetKind,
  repositoryShortName,
  saveUserProfileName,
  writeProjectContract,
} from "../../lib/project-contract.mjs";
import { unifiedDiff } from "./text-diff.mjs";

export const ROLES = Object.freeze(["sql", "powerbi", "mixed", "generic"]);
const MAX_FIELD = 2000;
const MAX_REPOS = 50;

/** Fields the guardrails read (docs/guardrails-reference.md): the form marks them. */
export const GUARDRAIL_FIELDS = Object.freeze(["client", "tenantId", "sqlTargetKind", "sqlTargetServer", "sqlTargetDatabase", "repositories.localPath", "commitLists"]);

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** The contract the form edits for a folder, as /setup-project finds it. An
 *  existing contract (above cwd, or in the client home repository beside it) is
 *  edited in place; a new one goes in this repository, or, beside several, in
 *  the client home repository `<client>-coop`, named once the client is known. */
export function locateProject(cwd, { client = "" } = {}) {
  const existing = findProjectContract(cwd);
  const where = proposeContractRoot(cwd, { existing, client });
  return { existing, root: where.root, path: where.path, kind: where.kind, pending: Boolean(where.pending), repos: where.repos || [], parent: where.parent || "", note: contractLocationNote(where) };
}

/** How the project file compares with the team's copy, for the pane's status
 *  line and buttons: null when there is no Git repository or no origin. */
export function teamStatus(cwd, { env } = {}) {
  const existing = findProjectContract(cwd, env);
  const repo = existing ? contractRepository(existing) : findGitRoot(cwd);
  if (!repo || !hasOrigin(repo)) return null;
  const status = teamFileStatus(repo, { env, fetchTimeout: 8_000 });
  return { state: status.state, repo, branch: status.branch || "", defaultBranch: status.defaultBranch || "", originExists: Boolean(status.originExists) };
}

/** "Get the team's project file" for the pane. */
export function getTeamProject(cwd, { env } = {}) {
  const existing = findProjectContract(cwd, env);
  const repo = existing ? contractRepository(existing) : findGitRoot(cwd);
  if (!repo) return { ok: false, reason: "this folder is not in a Git repository" };
  return getTeamContract(repo, { env });
}

/** "Share with the team" for the pane: the one-file commit and push. */
export function shareProject(cwd, { env, force = false } = {}) {
  const existing = findProjectContract(cwd, env);
  if (!existing) return { ok: false, state: "nothing", reason: "there is no .coop/project.yml to share yet" };
  const repo = contractRepository(existing);
  if (!repo) return { ok: false, state: "no-git", reason: "the project file is not in a Git repository" };
  return shareContract(repo, { env, force });
}

function readOriginal(where) {
  return where.existing ? readFileSync(where.existing, "utf8") : "";
}

function commitLists(text, names) {
  return {
    top: projectYamlList(text, ["agent_allowed_to_commit"]),
    repositories: Object.fromEntries(names.map((name) => [name, {
      allowed: projectYamlList(text, ["repositories", name, "agent_allowed_to_commit"]),
      never: projectYamlList(text, ["repositories", name, "agent_never_commit"]),
    }])),
  };
}

// The window's environment plus coop's (spec.env): where user.json and the
// machine's client platform live, so a redirected sandbox profile is honoured.
const profileFile = (env) => userProfilePath(env || process.env);
// The name question is asked only when neither the per-user file nor the
// machine-level profile (master plan P1) supplies a name.
const profileMissing = (env) => !effectiveProfile(env || process.env).profile;

/** Everything the form shows: the wizard-owned settings and read-only context. */
export function loadProject(cwd, { env } = {}) {
  const where = locateProject(cwd);
  const original = readOriginal(where);
  const settings = parseProjectWizardSettings(original, where.root);
  const platform = clientPlatform((env || process.env).COOP_DIR || undefined);
  const existingNames = settings.repositories.filter((repo) => !repo.isNew).map((repo) => repo.name);
  return {
    exists: Boolean(where.existing),
    path: where.path,
    root: where.root,
    kind: where.kind,
    locationNote: where.note,
    folder: basename(where.root) || where.root,
    settings,
    commitLists: commitLists(original, existingNames),
    // power_bi.table_mapping.overrides is hand-edited in the file (C2): the form shows it read-only.
    mappingOverrides: projectYamlMapping(original, ["power_bi", "table_mapping", "overrides"]),
    layouts: [...FABRIC_LAYOUTS],
    mappingRules: [...TABLE_MAPPING_RULES],
    profileMissing: profileMissing(env),
    platform,
    proposedKind: { fabric: proposedSqlTargetKind(platform, true), noFabric: proposedSqlTargetKind(platform, false) },
    kinds: [...SQL_TARGET_KINDS],
    discoveredKinds: [...SQL_TARGET_DISCOVERED_KINDS],
    endpointTypes: [...SQL_ENDPOINT_TYPES],
    roles: [...ROLES],
    guardrailFields: [...GUARDRAIL_FIELDS],
    token: hash(original),
  };
}

function field(input, key) {
  const value = input && typeof input === "object" ? input[key] : undefined;
  if (value === undefined || value === null) return undefined;
  return cleanAnswer(String(value).slice(0, MAX_FIELD));
}

/**
 * Wizard settings from the form's answers, the way /setup-project collects
 * them: required fields keep their current value when left blank, optional
 * ones may be blank, Fabric, Tabular Editor and SQL target details count only
 * when that part is switched on, existing repositories keep their names, and
 * the target kind and server are lowercased.
 */
export function settingsFromForm(input, base, existingNames) {
  const s = { ...base, repositories: base.repositories.map((repo) => ({ ...repo })) };
  const keep = (key) => { const v = field(input, key); if (v) s[key] = v; };
  const take = (key) => { const v = field(input, key); if (v !== undefined) s[key] = v; };
  keep("organization");
  take("client");
  keep("timezone");
  keep("defaultBranch");

  const repos = Array.isArray(input && input.repositories) ? input.repositories.slice(0, MAX_REPOS) : null;
  if (repos) {
    const known = new Map(s.repositories.map((repo) => [repo.name, repo]));
    const next = [];
    repos.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const name = field(raw, "name") || "";
      const current = existingNames.includes(name) ? known.get(name) : null;
      const repo = current ? { ...current } : {
        name: repositoryShortName(name, `repo${index + 1}`),
        description: "Project source and docs",
        role: "generic",
        localPath: ".",
        remoteName: "origin",
        defaultBranch: s.defaultBranch,
        isNew: true,
      };
      for (const key of ["description", "localPath", "remoteName", "defaultBranch"]) {
        const v = field(raw, key);
        if (v) repo[key] = v;
      }
      if (ROLES.includes(raw.role)) repo.role = raw.role;
      next.push(repo);
    });
    // The writer cannot remove a repository, so the ones already in the file stay.
    for (const name of existingNames) if (!next.some((repo) => repo.name === name)) next.push(known.get(name));
    s.repositories = next;
  }

  if (typeof input.fabricEnabled === "boolean") s.fabricEnabled = input.fabricEnabled;
  if (s.fabricEnabled) {
    for (const key of ["tenantId", "fabricWorkspaceName", "fabricWorkspaceId", "sqlEndpointItemType", "sqlEndpointItemName", "sqlEndpointItemId", "sqlEndpointPropertiesId", "powerBiWorkspaceName", "powerBiWorkspaceId", "fabricLayout", "tableMappingRule", "tableMappingSchema", "tableMappingPrefix"]) take(key);
    // The wizard lowercases the layout and the rule and keeps the prefix only for a prefix rule.
    s.fabricLayout = (s.fabricLayout || "").toLowerCase();
    s.tableMappingRule = (s.tableMappingRule || "same_name").toLowerCase();
    s.tableMappingSchema = s.tableMappingSchema || "dbo";
    if (s.tableMappingRule !== "prefix") s.tableMappingPrefix = "";
  }

  const kind = field(input, "sqlTargetKind");
  if (kind !== undefined) s.sqlTargetKind = kind.toLowerCase();
  if (s.sqlTargetKind) {
    if (!SQL_TARGET_DISCOVERED_KINDS.has(s.sqlTargetKind)) take("sqlTargetServer");
    take("sqlTargetDatabase");
  }

  if (typeof input.tabularEditorEnabled === "boolean") s.tabularEditorEnabled = input.tabularEditorEnabled;
  if (s.tabularEditorEnabled) {
    keep("tabularEditorPath");
    take("bpaRulesPath");
  }
  return s;
}

function prepare(cwd, input, options) {
  const where = locateProject(cwd, { client: field(input, "client") || "" });
  const original = readOriginal(where);
  const base = parseProjectWizardSettings(original, where.root);
  // A new home-repo contract starts with the repositories beside the home.
  if (!where.existing && where.kind === "home-repo" && !base.repositories.length) base.repositories = siblingRepositoryEntries(where.repos, base.defaultBranch);
  const existingNames = base.repositories.filter((repo) => !repo.isNew).map((repo) => repo.name);
  const settings = settingsFromForm(input || {}, base, existingNames);
  const problems = projectSettingsProblems(settings);
  if (!where.existing && where.kind === "home-repo" && where.pending) problems.push({ field: "client", message: "The client name is needed first: it names the client home repository <client>-coop beside the repositories." });
  const profileName = field(input, "profileName") || "";
  const missing = profileMissing(options.env);
  if (missing && profileName && !isSavableProfileName(profileName)) problems.push({ field: "profileName", message: PROJECT_MESSAGES.profileName });
  // The wizard lowercases the server only after checking it.
  if (settings.sqlTargetServer) settings.sqlTargetServer = settings.sqlTargetServer.toLowerCase();
  const text = problems.length ? original : projectContractText(original, settings);
  return { where, original, settings, problems, text, profileName: missing ? profileName : "" };
}

/**
 * What saving would do, without writing: { problems } when an answer fails
 * the wizard's checks, else { diff, changed, mode, path, exists, token }.
 */
export function previewProject(cwd, input, options = {}) {
  const p = prepare(cwd, input, options);
  if (p.problems.length) return { problems: p.problems };
  return {
    problems: [],
    path: p.where.path,
    exists: Boolean(p.where.existing),
    mode: estateMode(p.settings.repositories),
    changed: p.text !== p.original,
    diff: unifiedDiff(p.original, p.text),
    token: hash(p.original),
  };
}

/**
 * Write the contract through the /setup-project writer: { path, backup,
 * created, profileSaved }. `token` is the preview's: a file changed on disk
 * since the preview is not overwritten.
 */
export function saveProject(cwd, input, token, options = {}) {
  const p = prepare(cwd, input, options);
  if (p.problems.length) return { problems: p.problems };
  if (hash(p.original) !== token) throw new Error(".coop/project.yml changed on disk since you reviewed it. Review the changes again.");
  let home = null;
  if (!p.where.existing && p.where.kind === "home-repo") {
    home = createHomeRepository(p.where.root, p.settings.client);
    if (home.error) throw new Error(`Could not create the client home repository ${p.where.root}: ${home.error}. No files were changed.`);
  }
  const backup = writeProjectContract(p.where.path, p.text);
  const profileSaved = p.profileName ? saveUserProfileName(p.profileName, profileFile(options.env)) : null;
  const team = teamStatus(cwd, options);
  return { problems: [], path: p.where.path, backup, created: !p.where.existing, profileSaved, home, next: p.where.existing ? "" : contractCreatedNote(p.where.root), team };
}
