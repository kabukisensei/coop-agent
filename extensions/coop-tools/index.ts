/**
 * coop-tools — native, LLM-callable Cooptimize tools for Pi.
 *
 * Registers three read-only / advisory tools that shell out to the standalone
 * Coop CLIs and return machine-readable JSON the model can reason over:
 *
 *   sql_review  -> coop-sql-review check <paths> --format json   (advisory; never edits/blocks)
 *   dax_review  -> coop-dax-review check <paths> --format json   (advisory; never edits/blocks)
 *   data_doc    -> coop-data-doc <scan|build|check>              (lineage + manifest.json)
 *
 * These let the agent call the review/documentation tools directly instead of
 * asking the user to run them. They are advisory: they never modify source.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const SEVERITY = Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]);

const REVIEW_PARAMS = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Files or directories to check. Defaults to the current directory.",
    }),
  ),
  min_severity: Type.Optional(SEVERITY),
  strict: Type.Optional(
    Type.Boolean({ description: "Exit non-zero if findings remain (CI gate). Default false." }),
  ),
});

const DATADOC_PARAMS = Type.Object({
  command: Type.Optional(
    Type.Union([Type.Literal("scan"), Type.Literal("build"), Type.Literal("check")], {
      description:
        "coop-data-doc subcommand. 'scan' (default) builds the lineage graph (read-only); 'build' also writes Markdown docs + portal; 'check' is a CI staleness gate.",
    }),
  ),
});

interface ReviewParams {
  paths?: string[];
  min_severity?: "error" | "warning" | "info";
  strict?: boolean;
}

function summarizeReview(bin: string, parsed: any, stdout: string, code: number): string {
  if (!parsed || typeof parsed !== "object") {
    return `${bin}: could not parse JSON (exit ${code}).\n${stdout.slice(0, 2000)}`;
  }
  const findings: any[] = parsed.findings || parsed.results || [];
  const sev = { error: 0, warning: 0, info: 0 } as Record<string, number>;
  for (const f of findings) {
    const s = String(f.severity || "").toLowerCase();
    if (s in sev) sev[s]++;
  }
  return (
    `${bin}: ${findings.length} finding(s) — ` +
    `${sev.error} error, ${sev.warning} warning, ${sev.info} info (exit ${code}). ` +
    `Full structured report is in this tool result's details.`
  );
}

export default function coopTools(pi: ExtensionAPI) {
  const runReview = async (
    bin: string,
    params: ReviewParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => {
    const paths = params.paths && params.paths.length ? params.paths : ["."];
    const args = ["check", ...paths, "--format", "json"];
    if (params.min_severity) args.push("--min-severity", params.min_severity);
    if (params.strict) args.push("--strict");

    let res;
    try {
      res = await pi.exec(bin, args, { cwd: ctx.cwd, signal });
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `${bin} could not run: ${e?.message || e}. Is it installed? (coop install)` }],
        details: { tool: bin, error: String(e?.message || e) },
        // not a real error for the conversation, just report it
      };
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      /* leave parsed null */
    }
    return {
      content: [{ type: "text" as const, text: summarizeReview(bin, parsed, res.stdout, res.code) }],
      details: { tool: bin, args, exitCode: res.code, report: parsed ?? res.stdout, stderr: res.stderr },
    };
  };

  pi.registerTool({
    name: "sql_review",
    label: "SQL Review",
    description:
      "Run coop-sql-review against T-SQL / Fabric Warehouse SQL files and return findings as JSON. Advisory only — it reports deviations from Cooptimize SQL standards and never edits or blocks.",
    promptSnippet: "Lint T-SQL/Fabric SQL against Cooptimize standards (advisory, JSON output)",
    promptGuidelines: [
      "Use sql_review to check SQL before proposing or reviewing changes; it never edits files.",
      "Treat results as advisory; summarize findings by severity and cite file:line.",
    ],
    parameters: REVIEW_PARAMS,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runReview("coop-sql-review", params as ReviewParams, signal, ctx);
    },
  });

  pi.registerTool({
    name: "dax_review",
    label: "DAX Review",
    description:
      "Run coop-dax-review against DAX / semantic-model files and return findings as JSON. Advisory only — reports deviations from Cooptimize DAX standards and never edits or blocks.",
    promptSnippet: "Lint DAX/semantic-model code against Cooptimize standards (advisory, JSON output)",
    promptGuidelines: [
      "Use dax_review to check DAX measures/models before proposing or reviewing changes.",
      "Treat results as advisory; summarize findings by severity.",
    ],
    parameters: REVIEW_PARAMS,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runReview("coop-dax-review", params as ReviewParams, signal, ctx);
    },
  });

  pi.registerTool({
    name: "data_doc",
    label: "Data Documentation",
    description:
      "Run coop-data-doc to document SQL + Power BI estates and build lineage. 'scan' (default) writes the lineage graph (graph.json); 'build' also writes Markdown docs and a searchable portal (manifest.json). Documentation outputs are committable; source is never touched.",
    promptSnippet: "Build/scan SQL + Power BI documentation and lineage (graph.json / manifest.json)",
    promptGuidelines: [
      "Use data_doc to read lineage and existing documentation (workflow step 3) before planning changes.",
      "Default to 'scan' (read-only). Only run 'build' when the user wants docs/portal regenerated.",
    ],
    parameters: DATADOC_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const command = (params as { command?: string }).command || "scan";
      let res;
      try {
        res = await pi.exec("coop-data-doc", [command], { cwd: ctx.cwd, signal });
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `coop-data-doc could not run: ${e?.message || e}. Is it installed? (coop install)` }],
          details: { tool: "coop-data-doc", error: String(e?.message || e) },
        };
      }
      const tail = res.stdout.split("\n").slice(-25).join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `coop-data-doc ${command} finished (exit ${res.code}).\n` +
              `Machine-readable artifacts: graph.json` +
              (command === "build" ? " + manifest.json + Markdown docs + portal" : "") +
              `.\n\n${tail}`,
          },
        ],
        details: { tool: "coop-data-doc", command, exitCode: res.code, stderr: res.stderr },
      };
    },
  });
}
