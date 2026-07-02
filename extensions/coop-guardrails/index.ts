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
 *      and `git -C <dir> commit`. The agent may commit docs/logs/site (with approval);
 *      a human commits source.
 *   2. Destructive commands — confirm before `rm -rf`, `git push --force`,
 *      `git reset --hard`, `git clean -f`, and `DROP`/`TRUNCATE` SQL.
 *   3. Secret files — confirm before read/edit/write of `.env`, private keys, or
 *      credential files (the agent must never expose secrets).
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** A `git commit` invocation, tolerant of global options between `git` and `commit`
 *  (`git -C <dir> commit`, `git -c k=v commit`, `git --no-pager commit`). The old
 *  `\bgit\s+commit\b` missed all of those, so the source-commit block was bypassable. */
export const GIT_COMMIT_RE = /\bgit\b(?:\s+-{1,2}[A-Za-z][\w-]*(?:[=\s]\S+)?)*\s+commit\b/;

/** The effective git repo dir for a command: its `-C <dir>` value (last wins, like
 *  git; quote-aware), else the caller's cwd. So the staged-files check runs against
 *  the repo the commit actually targets, not always ctx.cwd. */
export function gitRepoDir(cmd: string, cwd: string): string {
  const re = /(?:^|\s)-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  let dir: string | null = null;
  while ((m = re.exec(cmd))) dir = m[1] ?? m[2] ?? m[3] ?? dir;
  return dir || cwd;
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
  // rm with BOTH recursive and force flags (single-file rm is fine)
  if (/\brm\b/.test(cmd)) {
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
  if (/\bgit\s+push\b[^;&|]*?(--force\b|--force-with-lease\b|(?:\s|=)-f\b)/i.test(cmd)) return "git push --force";
  if (/\bgit\s+reset\s+--hard\b/i.test(cmd)) return "git reset --hard";
  if (/\bgit\s+clean\b[^;&|]*?(?:\s-[a-z]*f|\s--force\b)/i.test(cmd)) return "git clean -f";
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

export default function coopGuardrails(pi: ExtensionAPI) {
  const enabled = () => process.env.COOP_NO_GUARDRAILS !== "1";

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
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked the MCP action ${mcp} (you declined). MCP is read-only by default — list / read / inspect only; make changes with explicit approval or in the Fabric / Power BI UX.` };
          }
        }
        return;
      }

      const cmd = String(event?.input?.command ?? "").trim();
      if (!cmd) return;

      // 1. Never commit source (incl. `git commit -a/-am` auto-staging and `git -C`).
      if (GIT_COMMIT_RE.test(cmd)) {
        const offending = await offendingCommitPaths(pi, ctx.cwd, cmd);
        if (offending && offending.length) {
          const shown = offending.slice(0, 8).join(", ");
          const more = offending.length > 8 ? ` (+${offending.length - 8} more)` : "";
          return {
            block: true,
            reason:
              `coop guardrails: never commit source. These staged paths aren't docs/logs/site: ${shown}${more}. ` +
              `Unstage them (\`git restore --staged <file>\`), show the diff, and let a human commit. ` +
              `You may commit docs / logs / site / diagrams / glossary.`,
          };
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
        "  • never commit source — blocks `git commit` (incl. -a/-am and `git -C`) of anything outside docs/logs/site",
        "  • destructive commands — confirms rm -rf / git push --force / reset --hard / git clean -f / DROP·TRUNCATE",
        "  • secret files — confirms read/edit/write of .env / keys / credentials",
        "  • mutating MCP actions — confirms create/update/delete/deploy/publish-looking Fabric/Power BI/MCP tool calls (best-effort)",
        "Advisory rules live in docs/guardrails.md. Disable with COOP_NO_GUARDRAILS=1.",
      ];
      try {
        if (typeof ctx.ui?.notify === "function") ctx.ui.notify(lines.join("\n"), "info");
      } catch {
        /* ignore */
      }
    },
  });
}
