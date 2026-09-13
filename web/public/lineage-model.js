// Presentation-neutral projection of Coop Data Doc's focused lineage response.
// It preserves Data Doc IDs, evidence, trust markers, and the original payload;
// it never reconstructs lineage from source files or authored edge direction.
(function installLineageModel(root) {
  "use strict";

  const EVIDENCE = new Set(["complete", "partial", "failed", "not-applicable"]);
  const text = (value) => typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

  function normalizeNode(value, direction = "candidate") {
    const raw = value && typeof value === "object" ? value : {};
    const trust = raw.trust && typeof raw.trust === "object" && !Array.isArray(raw.trust) ? raw.trust : {};
    return {
      id: text(raw.id),
      name: text(raw.name || raw.id),
      type: text(raw.type),
      schema: text(raw.schema),
      layer: text(raw.layer),
      sourceFile: text(raw.source_file),
      sourcePath: text(raw.source_path),
      doc: text(raw.doc),
      docPath: text(raw.doc_path),
      trust,
      direction,
      raw,
    };
  }

  function normalizeEdge(value) {
    const raw = value && typeof value === "object" ? value : {};
    return {
      sourceId: text(raw.source_id),
      targetId: text(raw.target_id),
      type: text(raw.type || raw.edge_type),
      evidence: text(raw.evidence),
      upstreamId: text(raw.flow?.upstream_id),
      downstreamId: text(raw.flow?.downstream_id),
      raw,
    };
  }

  function build(envelope) {
    if (!envelope || envelope.schemaVersion !== 1 || envelope.capabilityId !== "coop.lineage.explorer") return null;
    const data = envelope.results?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const evidenceStatus = EVIDENCE.has(envelope.evidenceStatus)
      ? envelope.evidenceStatus
      : EVIDENCE.has(data.evidence_status) ? data.evidence_status : "failed";
    if (data.ambiguous === true) {
      return {
        runId: envelope.runId,
        ambiguous: true,
        query: text(data.query),
        matches: Array.isArray(data.matches) ? data.matches.map((item) => normalizeNode(item)) : [],
        evidenceStatus,
        complete: false,
        artifacts: Array.isArray(envelope.artifacts) ? envelope.artifacts : [],
        diagnostics: Array.isArray(envelope.diagnostics) ? envelope.diagnostics : [],
        raw: envelope,
      };
    }
    const focus = normalizeNode(data.object, "focus");
    const upstream = Array.isArray(data.upstream) ? data.upstream.map((item) => normalizeNode(item, "upstream")) : [];
    const downstream = Array.isArray(data.downstream) ? data.downstream.map((item) => normalizeNode(item, "downstream")) : [];
    const nodes = [focus, ...upstream, ...downstream].filter((item, index, values) => item.id && values.findIndex((other) => other.id === item.id) === index);
    const nodeIds = new Set(nodes.map((item) => item.id));
    const edges = (Array.isArray(data.edges) ? data.edges : []).map(normalizeEdge);
    return {
      runId: envelope.runId,
      ambiguous: false,
      query: text(data.query || focus.name),
      depth: Number.isInteger(data.depth) && data.depth > 0 ? data.depth : 1,
      evidenceStatus,
      complete: evidenceStatus === "complete",
      focus,
      upstream,
      downstream,
      nodes,
      edges,
      danglingEdges: edges.filter((edge) => !nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)),
      relationships: Array.isArray(data.relationships) ? data.relationships : [],
      coverage: envelope.coverage && typeof envelope.coverage === "object" ? envelope.coverage : {},
      diagnostics: Array.isArray(envelope.diagnostics) ? envelope.diagnostics : [],
      artifacts: Array.isArray(envelope.artifacts) ? envelope.artifacts : [],
      raw: envelope,
    };
  }

  function search(model, query) {
    const needle = text(query).trim().toLowerCase();
    if (!needle) return model.nodes || model.matches || [];
    return (model.nodes || model.matches || []).filter((node) =>
      [node.id, node.name, node.type, node.schema, node.layer, node.sourceFile, node.sourcePath].some((value) => text(value).toLowerCase().includes(needle))
    );
  }

  root.CoopLineage = Object.freeze({ build, normalizeEdge, normalizeNode, search });
})(globalThis);
