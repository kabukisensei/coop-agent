(function installKnowledgeModel(root) {
  "use strict";

  const CURRENT = new Set(["approved"]);
  const HISTORY = new Set(["proposed", "rejected", "deprecated", "superseded"]);
  const text = (value) => typeof value === "string" ? value : "";
  const list = (value) => Array.isArray(value) ? value : [];

  function build(catalog, { now = Date.now(), staleAfterDays = 365 } = {}) {
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.records)) return null;
    const rows = catalog.records.map((entry) => {
      const record = entry.record || {};
      const reviewedAt = record.review?.reviewedAt;
      const reviewedTime = reviewedAt ? Date.parse(reviewedAt) : NaN;
      const stale = Number.isFinite(reviewedTime) && now - reviewedTime > staleAfterDays * 86400000;
      return Object.freeze({
        id: text(entry.id),
        title: text(entry.title),
        scope: text(entry.scope),
        kind: text(entry.kind),
        confidence: text(entry.confidence),
        status: text(record.status),
        sensitivity: text(record.sensitivity),
        tags: list(entry.tags).map(text),
        appliesTo: list(entry.appliesTo).map(text),
        sourceId: text(entry.sourceId),
        relativePath: text(entry.relativePath),
        reviewedAt: text(reviewedAt),
        reviewedBy: text(record.review?.reviewedBy),
        stale,
        current: CURRENT.has(record.status),
        historical: HISTORY.has(record.status),
        canUse: record.status === "approved",
        canApprove: record.status === "proposed",
        canReject: record.status === "proposed",
        canDeprecate: record.status === "approved",
        canSupersede: record.status === "approved" || record.status === "deprecated",
        record,
      });
    }).sort((a, b) => Number(b.current) - Number(a.current) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return Object.freeze({
      status: text(catalog.status),
      complete: catalog.coverage?.complete === true,
      coverage: { ...(catalog.coverage || {}) },
      sources: list(catalog.sources).map((source) => ({ ...source })),
      diagnostics: list(catalog.diagnostics).map((diagnostic) => ({ ...diagnostic })),
      current: rows.filter((row) => row.current),
      history: rows.filter((row) => row.historical),
      rows,
    });
  }

  function filter(model, { query = "", scopes = [], statuses = [] } = {}) {
    if (!model) return [];
    const needle = text(query).trim().toLocaleLowerCase("en-US");
    const scopeSet = new Set(scopes);
    const statusSet = new Set(statuses);
    return model.rows.filter((row) => {
      if (scopeSet.size && !scopeSet.has(row.scope)) return false;
      if (statusSet.size && !statusSet.has(row.status)) return false;
      if (!needle) return true;
      return [row.id, row.title, row.kind, ...row.tags, ...row.appliesTo].join(" ").toLocaleLowerCase("en-US").includes(needle);
    });
  }

  function usePrompt(row) {
    if (!row?.canUse) throw new TypeError("Only approved current knowledge can be used in a session.");
    return `Use approved Coop knowledge ${row.id} from ${row.sourceId}:${row.relativePath} in this session. Read the source record, cite it by ID/path, and call out if the current project evidence conflicts with it.`;
  }

  root.CoopKnowledge = Object.freeze({ build, filter, usePrompt });
})(globalThis);
