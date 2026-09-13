// Presentation-neutral projection for SQL Review, DAX Review, BPA, and future
// deterministic finding envelopes. Original values remain available as `raw`.
(function installFindingsModel(root) {
  "use strict";

  const SEVERITIES = Object.freeze(["error", "warning", "info"]);
  const EVIDENCE = new Set(["complete", "partial", "failed", "not-applicable"]);

  function text(value) { return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value); }
  function severity(value) { const normalized = text(value).toLowerCase(); return SEVERITIES.includes(normalized) ? normalized : "info"; }
  function first(value, paths) {
    for (const path of paths) {
      let cursor = value;
      for (const key of path.split(".")) cursor = cursor && typeof cursor === "object" ? cursor[key] : undefined;
      if (cursor !== undefined && cursor !== null && cursor !== "") return cursor;
    }
    return null;
  }
  function normalizeFinding(value, index, kind = "deterministic") {
    const raw = value && typeof value === "object" ? value : { message: text(value) };
    const ruleId = text(first(raw, ["rule_id", "ruleId", "rule", "id"]));
    const file = text(first(raw, ["file", "path", "location.file", "location.path"]));
    const lineValue = first(raw, ["line", "line_number", "location.line"]);
    const fingerprint = text(first(raw, ["fingerprint"]));
    const object = text(first(raw, ["object", "object_name", "measure", "column", "table"]));
    const context = Object.fromEntries(["model", "table", "measure", "column", "report", "page", "visual"].map((field) => [field, text(first(raw, [field, `context.${field}`]))]).filter(([, value]) => value));
    return {
      id: fingerprint || `${kind}:${ruleId || "item"}:${file}:${lineValue ?? ""}:${index}`,
      kind,
      severity: severity(raw.severity),
      ruleId,
      message: text(first(raw, ["message", "note", "description", "title"])),
      remediation: text(first(raw, ["remediation", "suggestion", "recommendation", "fix"])),
      standardRef: text(first(raw, ["standard_ref", "standardRef"])),
      file,
      line: Number.isFinite(Number(lineValue)) ? Number(lineValue) : null,
      column: Number.isFinite(Number(first(raw, ["column_number", "location.column"]))) ? Number(first(raw, ["column_number", "location.column"])) : null,
      object,
      context,
      code: text(first(raw, ["code", "snippet", "source_context", "location.context"])),
      fingerprint,
      suppressed: first(raw, ["suppressed", "is_suppressed"]) === true,
      raw,
    };
  }
  function counts(findings) {
    const result = { error: 0, warning: 0, info: 0, total: findings.length };
    for (const finding of findings) result[finding.severity]++;
    return result;
  }
  function options(findings, field) { return [...new Set(findings.map((item) => item[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }

  function build(envelope, { toolName = "" } = {}) {
    if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.capabilityId !== "string") return null;
    const deterministic = Array.isArray(envelope.results?.findings) ? envelope.results.findings.map((item, index) => normalizeFinding(item, index)) : [];
    const agentReview = Array.isArray(envelope.results?.agentReview) ? envelope.results.agentReview.map((item, index) => normalizeFinding(item, index, "agent-review")) : [];
    const evidenceStatus = EVIDENCE.has(envelope.evidenceStatus) ? envelope.evidenceStatus : "failed";
    return {
      runId: envelope.runId,
      capabilityId: envelope.capabilityId,
      capabilityVersion: text(envelope.capabilityVersion),
      toolName,
      executionStatus: envelope.executionStatus,
      evidenceStatus,
      verdict: text(envelope.verdict),
      complete: evidenceStatus === "complete",
      coverage: envelope.coverage && typeof envelope.coverage === "object" ? envelope.coverage : {},
      summary: envelope.results?.summary && typeof envelope.results.summary === "object" ? envelope.results.summary : {},
      findings: deterministic,
      agentReview,
      diagnostics: Array.isArray(envelope.diagnostics) ? envelope.diagnostics : [],
      artifacts: Array.isArray(envelope.artifacts) ? envelope.artifacts : [],
      counts: counts(deterministic),
      filters: { severities: SEVERITIES, rules: options(deterministic, "ruleId"), files: options(deterministic, "file"), objects: options(deterministic, "object") },
      raw: envelope,
    };
  }

  function filter(model, criteria = {}) {
    const changed = criteria.changedFiles instanceof Set ? criteria.changedFiles : null;
    const values = model.findings.filter((item) =>
      (!criteria.severity || item.severity === criteria.severity) &&
      (!criteria.ruleId || item.ruleId === criteria.ruleId) &&
      (!criteria.file || item.file === criteria.file) &&
      (!criteria.object || item.object === criteria.object) &&
      (!criteria.changedOnly || (changed && changed.has(item.file)))
    );
    return { ...model, visibleFindings: values, visibleCounts: counts(values) };
  }

  function identity(item) { return item.fingerprint || `${item.ruleId}\u0000${item.file}\u0000${item.line ?? ""}\u0000${item.object}\u0000${item.message}`; }
  function compare(current, previous) {
    if (!previous) return { new: current.findings, persisting: [], fixed: [] };
    const before = new Map(previous.findings.map((item) => [identity(item), item]));
    const after = new Map(current.findings.map((item) => [identity(item), item]));
    return {
      new: current.findings.filter((item) => !before.has(identity(item))),
      persisting: current.findings.filter((item) => before.has(identity(item))),
      fixed: previous.findings.filter((item) => !after.has(identity(item))),
    };
  }

  root.CoopFindings = Object.freeze({ build, compare, filter, normalizeFinding, severities: SEVERITIES });
})(globalThis);
