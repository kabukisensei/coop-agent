import { serviceExtensionForTool } from "./service-extensions.mjs";

export const EXECUTION_ENVELOPE_SCHEMA_VERSION = 1;

const EVIDENCE_STATES = new Set(["complete", "partial", "failed", "not-applicable"]);

function textSummary(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  return text || null;
}

function coverageStates(value, states = []) {
  if (!value || typeof value !== "object") return states;
  if (typeof value.status === "string" && EVIDENCE_STATES.has(value.status)) states.push(value.status);
  for (const nested of Object.values(value)) coverageStates(nested, states);
  return states;
}

function evidenceStatus({ isError, report, details }) {
  if (isError) return "failed";
  const explicit = details?.evidenceStatus || details?.evidence_status;
  if (EVIDENCE_STATES.has(explicit)) return explicit;
  const reportExplicit = report?.evidenceStatus || report?.evidence_status;
  if (EVIDENCE_STATES.has(reportExplicit)) return reportExplicit;
  const states = coverageStates(report?.coverage);
  if (states.includes("failed")) return "failed";
  if (states.includes("partial")) return "partial";
  if (states.length && states.every((state) => state === "not-applicable")) return "not-applicable";
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  if (diagnostics.some((diagnostic) => diagnostic?.severity === "error")) return "partial";
  // Data Doc releases before the focused-lineage v1 response did not include
  // edge evidence or trust markers. Keep them usable, but never interpret a
  // successful legacy query as complete proof that no other dependency exists.
  if (details?.lineage && report?.ambiguous !== true && (report?.schema_version !== 1 || !Array.isArray(report?.edges))) return "partial";
  return "complete";
}

function verdict({ isError, report }) {
  if (isError) return "failed";
  if (typeof report?.verdict === "string" && report.verdict) return report.verdict;
  if (report?.verdict?.clean === true) return "pass";
  if (report?.verdict?.clean === false) return "findings";
  if (Array.isArray(report?.findings) && report.findings.length) return "findings";
  return "pass";
}

export function capabilityForTool(toolName) {
  return serviceExtensionForTool(toolName)?.capabilityId || null;
}

export function buildExecutionEnvelope(event, { runId, artifactId } = {}) {
  const capabilityId = capabilityForTool(event?.toolName);
  if (!capabilityId || typeof runId !== "string" || !runId || typeof artifactId !== "string" || !artifactId) return null;
  const result = event?.result && typeof event.result === "object" ? event.result : {};
  const details = result.details && typeof result.details === "object" ? result.details : {};
  const report = details.report && typeof details.report === "object"
    ? details.report
    : details.lineage && typeof details.lineage === "object"
      ? details.lineage
      : {};
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const agentReview = Array.isArray(report.agent_review) ? report.agent_review : [];
  const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  return {
    schemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
    runId,
    capabilityId,
    capabilityVersion: String(report.version || details.version || "unknown"),
    executionStatus: event.isError ? "failed" : "completed",
    evidenceStatus: evidenceStatus({ isError: event.isError === true, report, details }),
    verdict: verdict({ isError: event.isError === true, report }),
    coverage: report.coverage && typeof report.coverage === "object" ? report.coverage : {},
    results: {
      summary: report.summary && typeof report.summary === "object" ? report.summary : {},
      findings,
      agentReview,
      data: event.toolName === "data_doc" || event.toolName === "impact_analysis_result" ? report : {},
    },
    diagnostics,
    artifacts: [{ id: artifactId, kind: "raw-tool-output", mediaType: "application/json" }],
    markdownSummary: textSummary(result),
  };
}
