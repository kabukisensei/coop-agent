// Presentation-neutral projection for the workspace-first Desktop landing view.
// The runtime contracts remain authoritative; this model only summarizes them.
(function installMissionControlModel(root) {
  "use strict";

  const HEALTH_RANK = Object.freeze({
    ready: 0,
    healthy: 0,
    configured: 0,
    authenticated: 0,
    clean: 0,
    "not-run": 1,
    unavailable: 1,
    unknown: 1,
    "not-configured": 1,
    warning: 2,
    partial: 2,
    expired: 2,
    "read-only": 2,
    override: 2,
    error: 3,
    failed: 3,
    broken: 3,
  });

  function text(value, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function healthState(value, fallback = "unknown") {
    return typeof value === "string" && Object.hasOwn(HEALTH_RANK, value) ? value : fallback;
  }

  function overall(states) {
    let chosen = "ready";
    let rank = 0;
    for (const raw of states) {
      const state = healthState(raw);
      const next = HEALTH_RANK[state] ?? 1;
      if (next > rank) { chosen = state; rank = next; }
    }
    return chosen;
  }

  function sessions(chats, activeSid) {
    const rows = Array.isArray(chats) ? chats : [];
    return {
      state: rows.some((chat) => chat.status === "exited") ? "warning" : "ready",
      total: rows.length,
      busy: rows.filter((chat) => chat.busy === true).length,
      crashed: rows.filter((chat) => chat.status === "exited").length,
      readOnly: rows.filter((chat) => chat.workspaceAccess?.mode === "read-only").length,
      activeSid: text(activeSid, null),
    };
  }

  function workspace(access, fallbackCwd) {
    const mode = text(access?.access?.mode, "unknown");
    const repository = access?.repository || null;
    return {
      state: mode === "write" ? "ready" : mode === "read-only" ? "read-only" : mode === "override" ? "override" : "unknown",
      cwd: text(fallbackCwd, text(access?.access?.workspacePath, text(repository?.workspacePath, "Workspace unavailable"))),
      accessMode: mode,
      git: repository?.git === true,
      worktree: repository?.isWorktree === true,
      managedWorktreeId: access?.managedWorktreeId || null,
    };
  }

  function changes(value) {
    if (!value || value.ok === false) return { state: "unavailable", count: null, truncated: false, detail: "Git changes could not be inspected." };
    if (value.git !== true) return { state: "unavailable", count: null, truncated: false, detail: "Git is unavailable for this workspace." };
    if (value.repo !== true) return { state: "unavailable", count: null, truncated: false, detail: "This workspace is not a Git repository." };
    const count = Array.isArray(value.files) ? value.files.length : 0;
    return {
      state: count ? "warning" : "clean",
      count,
      truncated: value.truncated === true,
      detail: count ? `${count}${value.truncated === true ? "+" : ""} changed file${count === 1 ? "" : "s"}.` : "Working tree is clean.",
    };
  }

  function capabilitySummary(value) {
    const rows = Array.isArray(value?.capabilities) ? value.capabilities : [];
    const counts = { available: 0, unknown: 0, unavailable: 0 };
    for (const capability of rows) {
      const state = capability?.runtime?.state;
      if (state === "available") counts.available++;
      else if (state === "unavailable") counts.unavailable++;
      else counts.unknown++;
    }
    return {
      state: rows.length === 0 ? "unknown" : counts.unavailable ? "partial" : counts.unknown ? "warning" : "ready",
      total: rows.length,
      ...counts,
      platform: text(value?.platform?.os, "unknown"),
      versions: value?.versions || {},
    };
  }

  function knowledge(value) {
    if (!value) return { state: "not-configured", current: 0, history: 0, complete: false, sources: 0 };
    const current = Array.isArray(value.current) ? value.current.length : 0;
    const history = Array.isArray(value.history) ? value.history.length : 0;
    const sources = Array.isArray(value.sources) ? value.sources.length : 0;
    return {
      state: sources === 0 ? "not-configured" : value.complete === true ? "ready" : "partial",
      current,
      history,
      complete: value.complete === true,
      sources,
    };
  }

  function build({ activeSid, chats, fallbackCwd, access, git, capabilities, health, knowledge: knowledgeModel, failures = [] } = {}) {
    const projected = {
      workspace: workspace(access, fallbackCwd),
      sessions: sessions(chats, activeSid),
      changes: changes(git),
      health: {
        state: healthState(health?.state, "unavailable"),
        checkedAt: health?.checkedAt || null,
        sections: Array.isArray(health?.sections) ? health.sections.length : 0,
      },
      knowledge: knowledge(knowledgeModel),
      capabilities: capabilitySummary(capabilities),
      engineering: {
        reviews: { state: "not-run", detail: "Run Review changes when the current diff needs deterministic SQL, DAX, or BPA checks." },
        lineage: { state: "not-run", detail: "Open Lineage or Impact to inspect current evidence before a change." },
      },
      failures: Array.isArray(failures) ? failures.map((failure) => ({ id: text(failure?.id, "unknown"), message: text(failure?.message, "Contract unavailable.") })) : [],
    };
    const states = [
      projected.workspace.state,
      projected.sessions.state,
      projected.changes.state,
      projected.health.state,
      projected.knowledge.state,
      projected.capabilities.state,
      ...projected.failures.map(() => "warning"),
    ];
    projected.state = overall(states);
    projected.ready = projected.state === "ready";
    return projected;
  }

  root.CoopMissionControl = Object.freeze({ build, overall });
})(globalThis);
