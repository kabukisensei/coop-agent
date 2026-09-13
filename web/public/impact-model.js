(function installImpactModel(root) {
  "use strict";

  const CHANGE_INTENTS = new Set(["add", "remove", "rename", "retype", "redefine", "move", "deprecate", "investigate"]);
  const text = (value) => typeof value === "string" ? value : "";
  const list = (value) => Array.isArray(value) ? value : [];

  function build(envelope) {
    const artifact = envelope?.results?.data;
    if (envelope?.schemaVersion !== 1 || envelope.capabilityId !== "coop.impact.guided" || artifact?.schemaVersion !== 1) return null;
    const sources = new Map(list(artifact.evidenceSources).map((source) => [source.id, source]));
    const resolveSources = (ids) => list(ids).map((id) => sources.get(id) || { id, kind: "unknown", label: "Unknown evidence source", status: "failed", reference: null });
    const projectRef = (item) => ({
      id: text(item?.id),
      name: text(item?.name),
      type: text(item?.type),
      path: text(item?.path),
      classification: text(item?.classification) || "unknown",
      evidence: resolveSources(item?.evidenceSourceIds),
      raw: item,
    });
    const impactGroups = {};
    for (const key of ["upstream", "downstream", "reports", "apps", "rls", "refresh", "consumers"]) {
      impactGroups[key] = list(artifact.impacts?.[key]).map(projectRef);
    }
    const evidenceStatus = envelope.evidenceStatus === "complete" && artifact.evidenceStatus === "complete"
      ? "complete"
      : envelope.evidenceStatus === "failed" || artifact.evidenceStatus === "failed"
        ? "failed"
        : "partial";
    return Object.freeze({
      analysisId: text(artifact.analysisId),
      generatedAt: text(artifact.generatedAt),
      evidenceStatus,
      complete: evidenceStatus === "complete",
      target: { ...artifact.target },
      evidenceSources: list(artifact.evidenceSources).map((source) => ({ ...source })),
      paths: list(artifact.paths).map((path) => ({
        ...path,
        nodes: list(path.nodes).map(projectRef),
        evidence: resolveSources(path.evidenceSourceIds),
      })),
      impacts: impactGroups,
      evidenceGaps: list(artifact.evidenceGaps).map((gap) => ({ ...gap })),
      risk: { ...artifact.risk, drivers: list(artifact.risk?.drivers) },
      saferAlternatives: list(artifact.saferAlternatives).map((item) => ({ ...item })),
      plan: { ...artifact.plan, steps: list(artifact.plan?.steps).map((step) => ({ ...step, affectedObjects: list(step.affectedObjects) })) },
      approval: { ...artifact.approval },
      raw: artifact,
    });
  }

  function guidedPrompt(input) {
    const target = text(input?.target).trim();
    const changeIntent = text(input?.changeIntent).trim();
    const intendedOutcome = text(input?.intendedOutcome).trim();
    if (!target) throw new TypeError("Choose an exact target object.");
    if (!CHANGE_INTENTS.has(changeIntent)) throw new TypeError("Choose a supported change type.");
    if (!intendedOutcome) throw new TypeError("Describe the intended outcome.");
    const environment = text(input?.environment).trim() || "not specified";
    const deploymentScope = text(input?.deploymentScope).trim() || "not specified";
    return [
      "Use the power-bi-impact-analysis skill under coop-workflow for this read-only analysis.",
      `Target object: ${target}`,
      `Change intent: ${changeIntent}`,
      `Intended outcome: ${intendedOutcome}`,
      `Environment: ${environment}`,
      `Deployment scope: ${deploymentScope}`,
      `Refresh Data Doc graph if needed: ${input?.refreshLineage === true ? "yes; this checkbox is the user's approval for that analysis-output refresh only" : "no"}`,
      `Live Fabric/Power BI reads permitted: ${input?.allowLiveReads === true ? "yes, read-only" : "no; use local evidence only"}`,
      "Identify upstream and downstream paths, reports/apps/consumers, RLS and refresh implications, evidence gaps, risk, safer alternatives, and a proposed plan.",
      "Cite every path and impacted object to Data Doc, MCP/source evidence, or clearly labeled agent inference.",
      "Finish by calling impact_analysis_result with the validated impact-analysis.v1 artifact. Do not edit source or treat the artifact as implementation approval.",
    ].join("\n");
  }

  root.CoopImpact = Object.freeze({ build, guidedPrompt });
})(globalThis);
