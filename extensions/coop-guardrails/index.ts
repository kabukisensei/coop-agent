/**
 * coop-guardrails — runtime ENFORCEMENT of Cooptimize's governance rules.
 *
 * `docs/guardrails.md` is the advisory system prompt (it asks the model to behave).
 * This extension hooks the agent's tool calls and actually ENFORCES the
 * non-negotiables the model could slip on:
 *
 *   1. NEVER commit source — block `git commit` from the agent whenever the commit
 *      would include anything outside the allow-listed docs / logs / site paths. This
 *      covers staged files, `git commit -a/-am` (which auto-stages tracked changes),
 *      `git -C <dir> commit`, and `git commit <pathspec>` (which commits working-tree
 *      content ignoring the index). The agent may commit docs/logs/site (with
 *      approval); a human commits source.
 *   2. Destructive commands — confirm before `rm -rf`, `git push --force` (incl. a
 *      `+refspec` force push), `git reset --hard`, `git clean -f`, and `DROP`/
 *      `TRUNCATE` SQL. All git detectors tolerate `git -C <dir>` and interspersed
 *      flags, and match case-insensitively.
 *   3. Secret files — confirm before read/edit/write of `.env`, private keys, or
 *      credential files, AND before a bash command that touches one (`cat .env`
 *      etc.). The agent must never expose secrets.
 *   4. Mutating MCP actions — confirm before Fabric/Power BI/MCP tool calls whose
 *      names look like create/update/delete/deploy/publish (best-effort; MCP tool
 *      names vary, so this complements — not replaces — Pi's tool approval).
 *
 * It is the coop-native replacement for the third-party @aliou/pi-guardrails (which
 * was pinned to the old @mariozechner Pi). It enforces the AGENT's tool calls — your
 * own shell is never intercepted. Everything is **fail-open** (a bug here must never
 * block legitimate work; the system prompt still guides) and feature-detected so it
 * can never crash pi. Disable entirely with COOP_NO_GUARDRAILS=1.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Paths the agent MAY commit; everything else counts as source. The .coop/project.yml
// `approval_policy.agent_allowed_to_commit` globs are merged in on top of these.
const DEFAULT_ALLOWED_PREFIXES = [
  "docs/",
  "site/",
  "data-docs/",
  "data-docs-site/",
  ".coop/",
];

/** Find the nearest .coop/project.yml walking up from `cwd` (bounded). */
function findProjectYml(cwd: string): string | null {
  let d = cwd;
  for (let i = 0; i < 8; i++) {
    const p = join(d, ".coop", "project.yml");
    if (existsSync(p)) return p;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** Parse the `agent_allowed_to_commit` globs out of project.yml text — handling BOTH
 *  YAML flow form (`agent_allowed_to_commit: ["docs/**", ...]`) AND block form
 *
 *      agent_allowed_to_commit:
 *        - "docs/**"
 *        - reports/generated/**
 *
 *  across every occurrence (project.yml defines the key per-repository). The shipped
 *  .coop/project.example.yml uses block form, so a flow-only regex silently ignored a
 *  user's customizations — and diverged from the bash side (lib/_yaml.py reads both). */
export function parseAllowedGlobs(text: string): string[] {
  const globs: string[] = [];
  const add = (raw: string) => {
    const g = raw.trim().replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (g) globs.push(g);
  };
  // Flow form (all occurrences).
  const flow = /agent_allowed_to_commit\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = flow.exec(text))) {
    for (const raw of m[1].split(",")) add(raw);
  }
  // Block form: the key on its own line, then more-indented `- item` entries.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)agent_allowed_to_commit\s*:\s*(#.*)?$/.exec(lines[i]);
    if (!head) continue;
    const baseIndent = head[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].trim();
      if (!body || body.startsWith("#")) continue;
      const indent = lines[j].length - lines[j].trimStart().length;
      const item = /^-\s+(.*)$/.exec(body);
      if (indent > baseIndent && item) add(item[1]);
      else break; // dedent / non-list sibling → end of this block
    }
  }
  return globs;
}

/** Allowed-to-commit path prefixes: defaults + best-effort read of the project contract. */
function allowedPrefixes(cwd: string): string[] {
  const out = new Set(DEFAULT_ALLOWED_PREFIXES);
  try {
    const proj = findProjectYml(cwd);
    if (proj) {
      for (const glob of parseAllowedGlobs(readFileSync(proj, "utf8"))) {
        const prefix = glob.replace(/\*+.*$/, ""); // "docs/**" -> "docs/"
        if (prefix) out.add(prefix);
      }
    }
  } catch {
    /* defaults are fine */
  }
  return [...out];
}

/** A committed path is allowed if it's a doc file anywhere, or under an allowed prefix. */
function isAllowedCommitPath(file: string, prefixes: string[]): boolean {
  if (/\.(md|markdown)$/i.test(file)) return true; // documentation anywhere
  return prefixes.some((p) => file === p.replace(/\/$/, "") || file.startsWith(p));
}

/** `git`, optionally followed by global options (`-C <dir>`, `-c k=v`, `--no-pager`),
 *  as a regex-source fragment shared by every git detector so `git -C <dir> <subcmd>`
 *  and interspersed flags match consistently. */
const GIT_PREFIX = String.raw`\bgit\b(?:\s+-{1,2}[A-Za-z][\w-]*(?:[=\s]\S+)?)*`;

/** A `git commit` invocation, tolerant of global options between `git` and `commit`
 *  (`git -C <dir> commit`, `git -c k=v commit`, `git --no-pager commit`). The old
 *  `\bgit\s+commit\b` missed all of those, so the source-commit block was bypassable.
 *  Case-insensitive: on macOS/Windows (case-insensitive filesystems) `GIT COMMIT`
 *  resolves to the real binary, so the block must match it too. */
export const GIT_COMMIT_RE = new RegExp(GIT_PREFIX + String.raw`\s+commit\b`, "i");

/** Split a command string into tokens, honoring single/double quotes. */
export function tokenizeArgs(s: string): string[] {
  const toks: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) toks.push(m[1] ?? m[2] ?? m[3] ?? "");
  return toks;
}

// git-commit options that consume a SEPARATE following token (so that token is the
// option's value, not a pathspec). `--opt=value` forms are self-contained.
const COMMIT_VALUE_OPTS = new Set([
  "-m", "-F", "-C", "-c", "-t", "--message", "--file", "--reuse-message",
  "--reedit-message", "--fixup", "--squash", "--template", "--author", "--date",
  "--cleanup", "--gpg-sign", "--trailer", "--pathspec-from-file",
]);

/** Explicit pathspec arguments of `git commit <pathspec>` — the files it commits
 *  straight from the WORKING TREE, ignoring the index. Everything after `--` is a
 *  pathspec; otherwise bare (non-flag) tokens that aren't option values. Over-
 *  inclusion is harmless (a non-path token yields an empty diff); under-inclusion is
 *  the bypass we're closing, so we err toward including. */
export function explicitCommitPathspecs(cmd: string): string[] {
  const m = GIT_COMMIT_RE.exec(cmd);
  if (!m) return [];
  // Only the `git commit …` segment — stop at a shell separator so a chained
  // command's args aren't swallowed.
  const rest = cmd.slice(m.index + m[0].length).split(/[;&|]/)[0];
  const toks = tokenizeArgs(rest);
  const specs: string[] = [];
  let dashDash = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (dashDash) { if (t) specs.push(t); continue; }
    if (t === "--") { dashDash = true; continue; }
    if (t.startsWith("-")) {
      if (COMMIT_VALUE_OPTS.has(t) && i + 1 < toks.length) i++; // skip its value token
      continue;
    }
    if (t) specs.push(t);
  }
  return specs;
}

/** The shell segment (top-level, split on ; && || | &) that contains string index
 *  `idx`, plus everything before it — positions are on the ORIGINAL string so callers
 *  can slice exactly. Not quote-aware for the separators (matches the pragmatic split
 *  explicitCommitPathspecs already uses); over-splitting only ever narrows the window a
 *  detector looks at, it never opens a bypass. */
function segmentAround(cmd: string, idx: number): { segment: string; before: string } {
  const sep = /&&|\|\||[;&|]/g;
  let start = 0, end = cmd.length;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(cmd))) {
    const s = m.index, e = m.index + m[0].length;
    if (e <= idx) start = e;               // separator fully before idx → next segment starts here
    else if (s >= idx) { end = s; break; } // first separator at/after idx → segment ends here
  }
  return { segment: cmd.slice(start, end), before: cmd.slice(0, start) };
}

/** The directory of the LAST `cd <dir>` / `pushd <dir>` in a command prefix, or null.
 *  Quote-aware (reuses tokenizeArgs). `cd` with no arg or an option arg (`cd -`) is
 *  ignored — it can't be resolved to a concrete repo, so we fall back to cwd there. */
export function leadingCdDir(before: string): string | null {
  let dir: string | null = null;
  for (const seg of before.split(/&&|\|\||[;&|]/)) {
    const toks = tokenizeArgs(seg.trim());
    if ((toks[0] === "cd" || toks[0] === "pushd") && toks[1] && !toks[1].startsWith("-")) {
      dir = toks[1];
    }
  }
  return dir;
}

function resolveDir(dir: string, cwd: string): string {
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

/** The effective git repo dir for a `git commit` command, resolved to an absolute path:
 *  git's own `-C <dir>` global option if present (scanned ONLY in the `git … commit`
 *  prefix, so a sibling command's `-C` like `tar -C /tmp` and a `commit -C <ref>`
 *  reuse-message are never misread as the repo); else a leading `cd`/`pushd` target from
 *  an earlier shell segment (`cd /other && git commit …` — the chained-cd bypass); else
 *  the caller's cwd. So the staged-files check runs against the repo the commit actually
 *  targets, not always ctx.cwd. */
export function gitRepoDir(cmd: string, cwd: string): string {
  const gc = GIT_COMMIT_RE.exec(cmd);
  // git's global -C lives BETWEEN `git` and `commit` — i.e. inside the match itself.
  const prefix = gc ? gc[0] : cmd;
  const re = /(?:^|\s)-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  let dir: string | null = null;
  while ((m = re.exec(prefix))) dir = m[1] ?? m[2] ?? m[3] ?? dir;
  if (dir) return resolveDir(dir, cwd);
  if (gc) {
    const cd = leadingCdDir(segmentAround(cmd, gc.index).before);
    if (cd) return resolveDir(cd, cwd);
  }
  return cwd;
}

/** True when a `cd`/`pushd` precedes the `git commit` segment (`cd /other && git commit
 *  …`) — the chained-cd shape whose target repo the staged-file check may not be able to
 *  reach. Used to prompt instead of silently allowing when the check can't determine. */
export function commitHasLeadingCd(cmd: string): boolean {
  const gc = GIT_COMMIT_RE.exec(cmd);
  if (!gc) return false;
  return leadingCdDir(segmentAround(cmd, gc.index).before) !== null;
}

/** Will this `git commit` auto-stage tracked changes (-a / --all / a short-flag
 *  cluster containing 'a', e.g. -am / -av)? Those files aren't in the index when the
 *  hook fires, so a `--cached` check alone misses them — the classic `git commit -am`
 *  source-commit bypass. */
export function commitStagesAll(cmd: string): boolean {
  if (/(?:^|\s)--all\b/.test(cmd)) return true;
  const clusters = cmd.match(/(?<=\s)-[A-Za-z]+/g) || []; // short-flag clusters only
  return clusters.some((c) => /a/i.test(c.slice(1)));
}

/** Committed paths that are NOT docs/logs/site, or null if it can't be determined
 *  (fail-open). Covers staged files AND, when the command auto-stages (-a/-am), the
 *  tracked modifications `-a` will stage at commit time. */
async function offendingCommitPaths(pi: ExtensionAPI, cwd: string, cmd: string): Promise<string[] | null> {
  const repoDir = gitRepoDir(cmd, cwd);
  const diff = async (extra: string[]): Promise<string[] | null> => {
    let res: { stdout: string; code: number };
    try {
      res = await pi.exec("git", ["-C", repoDir, ...extra], { cwd });
    } catch {
      return null; // not a repo / git missing → don't block
    }
    if (!res || res.code !== 0) return null;
    return String(res.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  };
  const staged = await diff(["diff", "--cached", "--name-only"]);
  if (staged === null) return null; // can't determine → fail open (old behavior)
  const files = [...staged];
  if (commitStagesAll(cmd)) {
    const modified = await diff(["diff", "--name-only"]); // -a will stage these
    if (modified) for (const f of modified) if (!files.includes(f)) files.push(f);
  }
  // `git commit <pathspec>` commits the WORKING-TREE content of the named paths,
  // ignoring the index — so a --cached-only check misses them entirely (the classic
  // pathspec bypass). Diff those paths vs HEAD to learn what the commit will include.
  const pathspecs = explicitCommitPathspecs(cmd);
  if (pathspecs.length) {
    const named =
      (await diff(["diff", "--name-only", "HEAD", "--", ...pathspecs])) ??
      (await diff(["diff", "--name-only", "--", ...pathspecs]));
    if (named) for (const f of named) if (!files.includes(f)) files.push(f);
  }
  if (!files.length) return null;
  const prefixes = allowedPrefixes(repoDir);
  return files.filter((f) => !isAllowedCommitPath(f, prefixes));
}

// MCP tools carry no server-enforced read-only flag for Fabric (unlike powerbi's
// --readonly), and this hook can't see whether a given MCP call mutates. As a
// best-effort layer we CONFIRM tool calls whose names look like a mutating
// Fabric/Power BI/MCP action. Heuristic + fail-open: MCP governance still also relies
// on Pi's own tool approval and the advisory system prompt (docs/guardrails.md).
const MCP_TOOLISH =
  /(^|[_\-.:/])(mcp|fabric|powerbi|pbi|pbip|adx|kusto|eventhouse|onelake|lakehouse|warehouse|workspace|dataset|semanticmodel|report|pipeline|notebook|dataflow|capacity)([_\-.:/]|$)/i;
const MCP_WRITE_VERB =
  /(^|[_\-.:/])(create|update|delete|remove|deploy|publish|drop|write|patch|overwrite|rename|truncate|grant|revoke|provision)([_\-.:/A-Z]|$)/i;

/** Label a tool call that looks like a MUTATING MCP/Fabric/Power BI action, or null.
 *  Requires BOTH an MCP-ish name and a write verb, so reads (list/get/inspect) pass. */
export function mcpMutationLabel(toolName: string): string | null {
  const name = String(toolName || "");
  if (!name || name === "bash" || name === "read" || name === "edit" || name === "write") return null;
  if (!MCP_TOOLISH.test(name) || !MCP_WRITE_VERB.test(name)) return null;
  return name;
}

/** Label a destructive bash command, or null. Conservative — only clearly risky ops. */
function dangerLabel(cmd: string): string | null {
  // rm with BOTH recursive and force flags (single-file rm is fine). Case-insensitive
  // so `RM -rf` on a case-insensitive filesystem (macOS/Windows) is caught too.
  if (/\brm\b/i.test(cmd)) {
    // Collect just the dash-prefixed flag tokens (NOT the literal "rm"), so the
    // "r"/"f" tests don't match the "r" in the "rm" command name itself.
    const flagTokens = cmd.match(/(?<=\s)-\S+/g) || [];
    // Short-flag clusters (e.g. -rf, -fr) carry their letters after a single dash.
    const shortFlags = flagTokens.filter((t) => !t.startsWith("--")).join("");
    const longFlags = flagTokens.filter((t) => t.startsWith("--")).join(" ");
    const recursive = /r/i.test(shortFlags) || /--recursive\b/i.test(longFlags);
    const force = /f/i.test(shortFlags) || /--force\b/i.test(longFlags);
    if (recursive && force) return "rm -rf";
  }
  // Every git detector tolerates global options (`git -C <dir> …`) and flags between
  // the subcommand and its dangerous flag (`git reset -q --hard`), like GIT_COMMIT_RE.
  if (new RegExp(GIT_PREFIX + String.raw`\s+push\b[^;&|]*?(?:--force\b|--force-with-lease\b|(?:^|\s)-[A-Za-z]*f[A-Za-z]*\b|(?:^|\s)\+[^\s:]+(?::|\s|$))`, "i").test(cmd)) return "git push --force";
  if (new RegExp(GIT_PREFIX + String.raw`\s+reset\b[^;&|]*?--hard\b`, "i").test(cmd)) return "git reset --hard";
  if (new RegExp(GIT_PREFIX + String.raw`\s+clean\b[^;&|]*?(?:\s-[A-Za-z]*f|--force\b)`, "i").test(cmd)) return "git clean -f";
  if (/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER|SEQUENCE|TYPE)\b/i.test(cmd)) return "destructive SQL (DROP/TRUNCATE)";
  return null;
}

/** Does this path look like a secret (private key / credential / .env) the agent
 *  shouldn't read or write? Public keys (.pub) and *.example/.sample are excluded. */
export function isSecretPath(p: string): boolean {
  const base = (p.split(/[/\\]/).pop() || "").toLowerCase();
  if (base.endsWith(".pub")) return false; // public keys are fine
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(base)) return true;
  if (/^(\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials)$/.test(base)) return true;
  if (/(^|[._-])secrets?([._-]|$)/.test(base) && /\.(ya?ml|json|env|txt|conf|ini)$/.test(base)) return true;
  return false;
}

/** First secret-looking path token in a bash command, or null. Mirrors the
 *  read/edit/write secret gate so bash isn't an unguarded exfil path
 *  (`cat .env`, `cp .env /tmp`, `curl -F f=@.env`, `base64 .env`, `>.env`). */
export function bashSecretCmdPath(cmd: string): string | null {
  for (let t of tokenizeArgs(cmd)) {
    t = t.replace(/^[<>]+/, "");         // strip redirection operators (>.env, <.env)
    const at = t.lastIndexOf("@");       // curl -F field=@.env / scp x@host — take the tail
    const cand = at >= 0 ? t.slice(at + 1) : t;
    if (cand && isSecretPath(cand)) return cand;
  }
  return null;
}

// --- Audit trail ----------------------------------------------------------------
// An append-only JSONL record of what the guardrails blocked/confirmed, WHEN, and in
// WHICH repo. For a governed, review-first practice this is direct client-trust value
// and the fastest way to debug a false positive (e.g. the git -C / pathspec / cd family
// that has needed several rounds of fixes). SECRETS ARE NEVER WRITTEN — the secret gate
// logs only the matched path, never file contents; commands are truncated. Every write is
// wrapped so a logging failure can never block work or crash pi (the extension's prime
// directive is fail-open).
const AUDIT_MAX_BYTES = 1_000_000;
function auditDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".coop", "agent");
}
function auditPath(): string {
  return join(auditDir(), "guardrails-audit.jsonl");
}
type AuditEntry = {
  ts?: string;     // set by audit() on write; present on every read
  cwd: string;
  kind: "commit-block" | "danger-confirm" | "secret-confirm" | "mcp-confirm";
  tool: string;
  decision: "blocked" | "allowed" | "declined";
  label: string;   // the short subject (offending path, danger label, tool name)
  detail: string;  // paths (commit, first 8) or the command truncated to 200 chars — NEVER secrets
};
function audit(entry: AuditEntry): void {
  try {
    appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* fail-open — a logging failure must never block legitimate work */
  }
}
// Best-effort size cap: on load, roll a >1 MB log to .jsonl.1 so it can't grow unbounded.
function rotateAuditIfLarge(): void {
  try {
    const p = auditPath();
    if (existsSync(p) && statSync(p).size > AUDIT_MAX_BYTES) renameSync(p, p + ".1");
  } catch {
    /* best-effort */
  }
}
// The last `n` audit entries (newest last), parsed. Empty on any read/parse trouble.
function readAuditTail(n: number): AuditEntry[] {
  try {
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter((l) => l.trim());
    return lines.slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export default function coopGuardrails(pi: ExtensionAPI) {
  const enabled = () => process.env.COOP_NO_GUARDRAILS !== "1";
  rotateAuditIfLarge();

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    try {
      if (!enabled()) return;
      const tool = event?.toolName;

      // 0. Secret-file access (read / edit / write) → confirm.
      if (tool === "read" || tool === "edit" || tool === "write") {
        const path = String(event?.input?.path ?? "");
        if (path && isSecretPath(path) && ctx.hasUI && typeof ctx.ui?.confirm === "function") {
          const verb = tool === "read" ? "read" : "write to";
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `Secret-looking file (${verb}):\n  ${path}\ncoop never exposes secrets (tokens, keys, .env). Proceed?`,
          );
          audit({ cwd: ctx.cwd, kind: "secret-confirm", tool, decision: ok ? "allowed" : "declined", label: path, detail: path });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked ${tool} of the secret-looking file ${path} (you declined). Reference an env var / vault instead of reading or writing secrets.` };
          }
        }
        return;
      }

      // 0b. Mutating MCP / Fabric / Power BI action → confirm (best-effort; MCP has no
      //     server-enforced read-only for Fabric, so add a runtime prompt). Fail-open:
      //     no UI → allow (Pi's tool approval + the advisory prompt still apply).
      if (tool !== "bash") {
        const mcp = mcpMutationLabel(tool ?? "");
        if (mcp && ctx.hasUI && typeof ctx.ui?.confirm === "function") {
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `This looks like a MUTATING MCP action (create/update/delete/deploy/publish):\n  ${mcp}\ncoop treats MCP as read-only (list / read / inspect). Run it?`,
          );
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: String(tool), decision: ok ? "allowed" : "declined", label: mcp, detail: mcp });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked the MCP action ${mcp} (you declined). MCP is read-only by default — list / read / inspect only; make changes with explicit approval or in the Fabric / Power BI UX.` };
          }
        }
        return;
      }

      const cmd = String(event?.input?.command ?? "").trim();
      if (!cmd) return;

      // 1a. Secret-file access via bash (cat / cp / curl / base64 / redirection) →
      //     confirm, mirroring the read/edit/write secret gate so bash isn't an
      //     unguarded exfil path. Fail-open with no UI, like the other confirm gates.
      const secretPath = bashSecretCmdPath(cmd);
      if (secretPath && ctx.hasUI && typeof ctx.ui?.confirm === "function") {
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `This command touches a secret-looking file:\n  ${secretPath}\ncoop never exposes secrets (tokens, keys, .env). Run it?`,
        );
        // Log the matched PATH only — never the command (it may embed the secret's value).
        audit({ cwd: ctx.cwd, kind: "secret-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: secretPath, detail: secretPath });
        if (!ok) {
          return { block: true, reason: `coop guardrails: blocked a command touching the secret-looking file ${secretPath} (you declined). Reference an env var / vault instead of reading or writing secrets.` };
        }
      }

      // 1. Never commit source (incl. `git commit -a/-am` auto-staging, `git -C <dir>`,
      //    `git commit <pathspec>`, and `cd <dir> && git commit` — the staged check runs
      //    against the repo the commit actually targets, see gitRepoDir).
      if (GIT_COMMIT_RE.test(cmd)) {
        const offending = await offendingCommitPaths(pi, ctx.cwd, cmd);
        if (offending && offending.length) {
          const shown = offending.slice(0, 8).join(", ");
          const more = offending.length > 8 ? ` (+${offending.length - 8} more)` : "";
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: "blocked", label: "git commit", detail: offending.slice(0, 8).join(", ") });
          return {
            block: true,
            reason:
              `coop guardrails: never commit source. These staged paths aren't docs/logs/site: ${shown}${more}. ` +
              `Unstage them (\`git restore --staged <file>\`), show the diff, and let a human commit. ` +
              `You may commit docs / logs / site / diagrams / glossary.`,
          };
        }
        // Defense in depth: a `cd <dir> && git commit …` whose target repo we couldn't
        // read (offending === null) is the known bypass shape — confirm rather than
        // silently allow. Fail-open when there's no UI (headless agent), like the other
        // confirm gates; a plain non-cd commit stays fully silent as before.
        if (offending === null && commitHasLeadingCd(cmd) && ctx.hasUI && typeof ctx.ui?.confirm === "function") {
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `Can't verify what this commit would include in the cd'd-into repo:\n  ${cmd.slice(0, 200)}\n` +
              `The agent may only commit docs / logs / site — a human commits source. Proceed?`,
          );
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: ok ? "allowed" : "declined", label: "cd && git commit", detail: cmd.slice(0, 200) });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked a \`cd … && git commit\` whose target repo couldn't be verified (you declined). Let a human commit source; the agent may commit docs / logs / site.` };
          }
        }
      }

      // 2. Destructive command → confirm (interactive only; no UI = let it through,
      //    the system prompt still applies).
      const danger = dangerLabel(cmd);
      if (danger && ctx.hasUI && typeof ctx.ui?.confirm === "function") {
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `Destructive command (${danger}):\n  ${cmd.slice(0, 200)}\nRun it?`,
        );
        audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: danger, detail: cmd.slice(0, 200) });
        if (!ok) {
          return { block: true, reason: `coop guardrails: blocked the ${danger} command (you declined). Propose a safer approach.` };
        }
      }
    } catch {
      /* fail-open — never block legitimate work on a guardrails bug */
    }
  });

  pi.registerCommand("coop-guardrails", {
    description: "Show what coop's runtime guardrails enforce (and whether they're on)",
    handler: async (_args, ctx) => {
      const lines = [
        `coop-guardrails: ${enabled() ? "ON" : "OFF (COOP_NO_GUARDRAILS=1)"}`,
        "Enforced on the agent's tool calls (your own shell is never intercepted):",
        "  • never commit source — blocks `git commit` (incl. -a/-am, `git -C`, `git commit <path>`, and `cd <dir> && git commit`) of anything outside docs/logs/site",
        "  • destructive commands — confirms rm -rf / git push --force (incl. +refspec) / reset --hard / git clean -f / DROP·TRUNCATE",
        "  • secret files — confirms read/edit/write AND bash access (cat .env etc.) of .env / keys / credentials",
        "  • mutating MCP actions — confirms create/update/delete/deploy/publish-looking Fabric/Power BI/MCP tool calls (best-effort)",
        "Advisory rules live in docs/guardrails.md. Disable with COOP_NO_GUARDRAILS=1.",
        "",
        `Audit log (append-only; secrets/file contents never written): ${auditPath()}`,
      ];
      const recent = readAuditTail(10);
      if (recent.length) {
        lines.push(`Last ${recent.length} decision(s):`);
        for (const e of recent) {
          lines.push(`  ${e.ts || "?"}  ${e.kind}/${e.decision}  ${e.label}${e.detail && e.detail !== e.label ? `  (${e.detail})` : ""}`);
        }
      } else {
        lines.push("No guardrail decisions recorded yet.");
      }
      try {
        if (typeof ctx.ui?.notify === "function") ctx.ui.notify(lines.join("\n"), "info");
      } catch {
        /* ignore */
      }
    },
  });
}
