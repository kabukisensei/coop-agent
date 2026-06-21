/**
 * coop-guardrails — runtime ENFORCEMENT of Cooptimize's governance rules.
 *
 * `docs/guardrails.md` is the advisory system prompt (it asks the model to behave).
 * This extension hooks the agent's tool calls and actually ENFORCES the two
 * non-negotiables the model could slip on:
 *
 *   1. NEVER commit source — block `git commit` from the agent whenever staged files
 *      include anything outside the allow-listed docs / logs / site paths. The agent
 *      may commit docs/logs/site (with approval); a human commits source.
 *   2. Destructive commands — confirm before `rm -rf`, `git push --force`,
 *      `git reset --hard`, `git clean -f`, and `DROP`/`TRUNCATE` SQL.
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

/** Allowed-to-commit path prefixes: defaults + best-effort read of the project contract. */
function allowedPrefixes(cwd: string): string[] {
  const out = new Set(DEFAULT_ALLOWED_PREFIXES);
  try {
    const proj = findProjectYml(cwd);
    if (proj) {
      const text = readFileSync(proj, "utf8");
      // agent_allowed_to_commit: ["docs/**", "site/**", "docs/agent/logs/**", ...]
      const m = text.match(/agent_allowed_to_commit\s*:\s*\[([^\]]*)\]/);
      if (m) {
        for (const raw of m[1].split(",")) {
          const glob = raw.trim().replace(/^["']|["']$/g, "");
          const prefix = glob.replace(/\*+.*$/, ""); // "docs/**" -> "docs/"
          if (prefix) out.add(prefix);
        }
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

/** Staged files that are NOT docs/logs/site, or null if it can't be determined (fail-open). */
async function stagedSourceFiles(pi: ExtensionAPI, cwd: string): Promise<string[] | null> {
  let res: { stdout: string; code: number };
  try {
    res = await pi.exec("git", ["diff", "--cached", "--name-only"], { cwd });
  } catch {
    return null; // not a repo / git missing → don't block
  }
  if (!res || res.code !== 0) return null;
  const files = String(res.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!files.length) return null;
  const prefixes = allowedPrefixes(cwd);
  return files.filter((f) => !isAllowedCommitPath(f, prefixes));
}

/** Label a destructive bash command, or null. Conservative — only clearly risky ops. */
function dangerLabel(cmd: string): string | null {
  // rm with BOTH recursive and force flags (single-file rm is fine)
  if (/\brm\b/.test(cmd)) {
    const flagRuns = cmd.match(/\brm\s+(?:-\S+\s*)+/g);
    if (flagRuns) {
      const flags = flagRuns.join(" ");
      if (/r/.test(flags) && /f/.test(flags)) return "rm -rf";
    }
  }
  if (/\bgit\s+push\b[\s\S]*?(--force\b|--force-with-lease\b|(?:\s|=)-f\b)/i.test(cmd)) return "git push --force";
  if (/\bgit\s+reset\s+--hard\b/i.test(cmd)) return "git reset --hard";
  if (/\bgit\s+clean\s+-\S*f/i.test(cmd)) return "git clean -f";
  if (/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|VIEW)\b/i.test(cmd)) return "destructive SQL (DROP/TRUNCATE)";
  return null;
}

export default function coopGuardrails(pi: ExtensionAPI) {
  const enabled = () => process.env.COOP_NO_GUARDRAILS !== "1";

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    try {
      if (!enabled()) return;
      if (event?.toolName !== "bash") return;
      const cmd = String(event?.input?.command ?? "").trim();
      if (!cmd) return;

      // 1. Never commit source.
      if (/\bgit\s+commit\b/.test(cmd)) {
        const offending = await stagedSourceFiles(pi, ctx.cwd);
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
        "  • never commit source — blocks `git commit` of anything outside docs/logs/site",
        "  • destructive commands — confirms rm -rf / git push --force / reset --hard / git clean -f / DROP·TRUNCATE",
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
