/** TeamAI adapter — config-gated bridge behind the existing knowledge contracts.
 *
 * Default OFF. Explicitly enabled but missing required config, access or
 * tooling reports { ok:false, reason:"unavailable", ... } — never a silent
 * integration success. When enabled, this module:
 *
 *   recall    — reads ONLY from an adapter-controlled checkout pinned to the
 *               APPROVED remote revision (the TeamAI machine-local mirror is
 *               never authoritative: upstream indexes proposed, unapproved
 *               learnings locally before a PR merges).
 *   contribute — uses the TeamAI PR/review path only (single-repo/self mode).
 *               Multi-repo mode (pushRepoDirectly to the approved branch) is
 *               refused. Publication is never inferred from exit code or
 *               prose: a contribution claim REQUIRES parseable PR identity
 *               (URL + branch) in the CLI output.
 *
 * Containment: every spawn runs with an isolated HERMES_HOME (upstream init
 * injects hooks into the real Hermes home otherwise) and GIT_TERMINAL_PROMPT=0.
 * No second knowledge system: results normalize into the existing knowledge
 * record/scope shapes at the caller boundary.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /https?:\/\/\S+\/pull\/\d+/i;
const ok = (value) => ({ ok: true, value });
const diag = (reason, detail = null) => ({ ok: false, reason, detail });

export function resolveTeamaiConfig(env = process.env) {
  const enabled = /^(1|true|yes|on)$/i.test(env.COOP_TEAMAI_ENABLED || "");
  if (!enabled) return diag("disabled", "COOP_TEAMAI_ENABLED is not set — TeamAI integration is off by default.");
  const repo = (env.COOP_TEAMAI_REPO || "").trim();
  if (!REPO.test(repo)) return diag("unavailable", "COOP_TEAMAI_REPO must be in owner/repo form (e.g. cooptimize/coop-team-knowledge).");
  const worktree = resolve(env.COOP_TEAMAI_WORKTREE || join(env.COOP_DIR || "", "teamai-knowledge"));
  const cli = (env.COOP_TEAMAI_CLI || "teamai").trim();
  const hermesHome = resolve(env.COOP_TEAMAI_HERMES_HOME || join(worktree, ".hermes-home"));
  if (!cli) return diag("unavailable", "COOP_TEAMAI_CLI resolved empty.");
  return ok({ enabled: true, repo, worktree, cli, hermesHome });
}

// Minimal child env: no whole-parent-environment copying; git auth comes from
// the user's normal git credential plumbing, not from env inheritance.
function childEnv(config, extra = {}) {
  const env = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || process.env.USERPROFILE || "",
    HERMES_HOME: config.hermesHome,
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramData"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runCli(config, args, { cwd, execFileImpl }) {
  return execFileImpl(config.cli, args, { cwd, env: childEnv(config), encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
}

// Single-repo (PR) mode only: the checkout must declare mode: self, which is
// the path whose contribute opens a PR instead of pushing to the approved
// branch directly.
function assertPrMode(config, { execFileImpl }) {
  const marker = join(config.worktree, ".teamai", "teamai.yaml");
  if (!existsSync(marker)) return diag("unavailable", `TeamAI is not initialized in the isolated checkout (${config.worktree}); refusing to guess a contribution mode.`);
  const text = readFileSync(marker, "utf8");
  if (!/mode:\s*self\b/.test(text)) return diag("unsafe-mode", "Checkout is not single-repo/PR mode; direct-push contribution against an approved branch is refused.");
  return ok(true);
}

/** Contribute an approved record through the TeamAI PR/review path.
 *  Evidence rule: ok requires PR identity (branch + PR URL) in the CLI output. */
export async function contributeTeamaiKnowledge(configInput, { file, title }, { execFileImpl = (c, a, o) => execFileSync(c, a, o) } = {}) {
  const config = configInput.ok ? configInput.value : null;
  if (!config) return diag(configInput.reason, configInput.detail);
  if (typeof file !== "string" || !file) return diag("invalid", "file is required.");
  const mode = assertPrMode(config, { execFileImpl });
  if (!mode.ok) return mode;
  let stdout;
  try {
    stdout = runCli(config, ["contribute", "--file", resolve(file), "--title", String(title || "coop knowledge record")], { cwd: config.worktree, execFileImpl });
  } catch (error) {
    return diag("cli-failed", String(error.stderr || error.message).slice(0, 2000));
  }
  const pr = PR_URL.exec(stdout);
  const contributed = /Contributed via PR:/.test(stdout);
  if (!contributed || !pr) return diag("publication-unverified", "CLI did not report PR identity; publication is not inferred from exit code or prose.");
  return ok({ branch: `teamai/push/<user>/${config.repo}`, prUrl: pr[0], stdout: stdout.trim().slice(-2000) });
}

/** Recall from the APPROVED revision only. The adapter fetches the checkout
 *  itself and records the approved source revision as evidence; the TeamAI
 *  machine-local mirror (which can hold pre-approval drafts) is never read. */
export async function recallTeamaiKnowledge(configInput, query, { execFileImpl = (c, a, o) => execFileSync(c, a, o), limit = 8 } = {}) {
  const config = configInput.ok ? configInput.value : null;
  if (!config) return diag(configInput.reason, configInput.detail);
  if (typeof query !== "string" || !query.trim()) return diag("invalid", "query is required.");
  if (!existsSync(join(config.worktree, ".teamai"))) return diag("unavailable", "TeamAI checkout is not initialized; recall cannot establish an approved revision.");
  let revision;
  try {
    revision = execFileImpl("git", ["-C", config.worktree, "rev-parse", "HEAD"], { encoding: "utf8", env: childEnv(config), stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return diag("unavailable", `Approved revision unavailable: ${String(error.message).slice(0, 300)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) return diag("unavailable", "Approved revision is not a valid 40-hex SHA.");
  let stdout;
  try {
    stdout = runCli(config, ["recall", ...query.trim().split(/\s+/).slice(0, 24), "--depth", "context"], { cwd: config.worktree, execFileImpl });
  } catch (error) {
    return diag("cli-failed", String(error.stderr || error.message).slice(0, 2000));
  }
  // TeamAI recall prints file hits; normalize into bounded excerpts. Scope
  // filtering happens HERE, before content can reach model context.
  const items = stdout.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).slice(0, limit)
    .map((block, i) => ({ rank: i + 1, excerpt: block.slice(0, 1200), source: `teamai:${config.repo}@${revision.slice(0, 12)}`, approvedRevision: revision, scope: "team" }));
  return ok({ query: query.trim(), approvedRevision: revision, items });
}
