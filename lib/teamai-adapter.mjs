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
// PR paths across supported providers (GitHub /pull/N, GitLab /merge_requests/N).
const PR_PATH = /^\/[^/]+\/[^/]+\/(?:pull|merge_requests)\/\d+$/;
const ok = (value) => ({ ok: true, value });
const diag = (reason, detail = null) => ({ ok: false, reason, detail });

/** Strict PR-identity validation: candidate must parse as an https URL whose
 *  hostname is a real dotted domain (every DNS label valid) and whose path is
 *  a provider-shaped PR path. Fabricated hosts like "." must NOT pass. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export function parsePrIdentity(stdout) {
  if (typeof stdout !== "string" || !/Contributed via PR:/.test(stdout)) return null;
  const candidate = stdout.match(/https:\/\/\S+/);
  if (!candidate) return null;
  let url;
  try { url = new URL(candidate[0]); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const labels = url.hostname.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => DNS_LABEL.test(label))) return null;
  if (!/^[a-z]{2,}$/i.test(labels[labels.length - 1])) return null;
  if (!PR_PATH.test(url.pathname)) return null;
  return url.toString();
}

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

// Single-repo (PR) mode only. Only ROOT-level (zero-indent), non-comment
// lines may declare the mode. ANY root mode-like declaration that is not
// exactly 'mode: self' — nested keys, inline comments, duplicates, malformed
// values — causes refusal. Ambiguity never resolves to authorization: a clean
// 'mode: self' cannot mask a conflicting declaration, because unrecognized
// mode-like lines are counted as declarations and then fail the strict check.
function assertPrMode(config) {
  const marker = join(config.worktree, ".teamai", "teamai.yaml");
  if (!existsSync(marker)) return diag("unavailable", `TeamAI is not initialized in the isolated checkout (${config.worktree}); refusing to guess a contribution mode.`);
  const declarations = readFileSync(marker, "utf8").split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .filter((line) => !/^\s/.test(line)) // root level only
    .map((line) => line.trim())
    .filter((line) => /^mode\s*:/i.test(line));
  if (declarations.length !== 1 || !/^mode\s*:\s*self\s*$/.test(declarations[0])) {
    return diag("unsafe-mode", "Checkout root mode declarations are not exactly one clean 'mode: self'; direct-push contribution against an approved branch is refused.");
  }
  return ok(true);
}

/** Contribute an approved record through the TeamAI PR/review path.
 *  Evidence rule: ok requires PR identity (branch + PR URL) in the CLI output. */
export async function contributeTeamaiKnowledge(configInput, { file, title }, { execFileImpl = (c, a, o) => execFileSync(c, a, o) } = {}) {
  const config = configInput.ok ? configInput.value : null;
  if (!config) return diag(configInput.reason, configInput.detail);
  if (typeof file !== "string" || !file) return diag("invalid", "file is required.");
  const mode = assertPrMode(config);
  if (!mode.ok) return mode;
  let stdout;
  try {
    stdout = runCli(config, ["contribute", "--file", resolve(file), "--title", String(title || "coop knowledge record")], { cwd: config.worktree, execFileImpl });
  } catch (error) {
    return diag("cli-failed", String(error.stderr || error.message).slice(0, 2000));
  }
  const prUrl = parsePrIdentity(stdout);
  if (!prUrl) return diag("publication-unverified", "CLI did not report a valid PR identity (https URL, provider pull path); publication is not inferred from exit code or prose.");
  return ok({ branch: `teamai/push/<user>/${config.repo}`, prUrl, stdout: stdout.trim().slice(-2000) });
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
