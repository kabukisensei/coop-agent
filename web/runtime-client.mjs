// Shell-neutral client for Coop Runtime's HTTP adapter. It exposes named methods
// instead of a general command escape hatch and preserves every raw Pi response
// beside a small stable result envelope for Desktop/Web consumers.

export class RuntimeClientError extends Error {
  constructor(message, { status = 0, response = null } = {}) {
    super(message);
    this.name = "RuntimeClientError";
    this.status = status;
    this.response = response;
  }
}

export class CoopRuntimeClient {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = "", sid = null } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sid = sid;
  }

  withSession(sid) {
    return new CoopRuntimeClient({ fetchImpl: this.fetch, baseUrl: this.baseUrl, sid });
  }

  async post(path, body) {
    const payload = this.sid && body.sid === undefined ? { ...body, sid: this.sid } : body;
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-coop-csrf": "1" },
      body: JSON.stringify(payload),
    });
    let raw = null;
    try { raw = await response.json(); } catch { /* surfaced below */ }
    if (!response.ok) throw new RuntimeClientError(raw?.error || `runtime request failed (${response.status})`, { status: response.status, response: raw });
    return raw;
  }

  async get(path, fields = {}) {
    const params = new URLSearchParams();
    const values = this.sid && fields.sid === undefined ? { ...fields, sid: this.sid } : fields;
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const query = params.size ? `?${params}` : "";
    const response = await this.fetch(`${this.baseUrl}${path}${query}`);
    let raw = null;
    try { raw = await response.json(); } catch { /* surfaced below */ }
    if (!response.ok) throw new RuntimeClientError(raw?.error || `runtime request failed (${response.status})`, { status: response.status, response: raw });
    return raw;
  }

  async rpc(type, fields = {}) {
    const raw = await this.post("/rpc", { type, ...fields });
    return { command: type, success: raw.success === true, data: raw.data, error: raw.error, raw };
  }

  prompt(message, { images } = {}) { return this.post("/prompt", { message, images }); }
  steer(message, { images } = {}) { return this.rpc("steer", { message, images }); }
  followUp(message, { images } = {}) { return this.rpc("follow_up", { message, images }); }
  newSession() { return this.rpc("new_session"); }
  getState() { return this.rpc("get_state"); }
  setModel(provider, modelId) { return this.rpc("set_model", { provider, modelId }); }
  cycleModel() { return this.rpc("cycle_model"); }
  getAvailableModels() { return this.rpc("get_available_models"); }
  setThinkingLevel(level) { return this.rpc("set_thinking_level", { level }); }
  cycleThinkingLevel() { return this.rpc("cycle_thinking_level"); }
  getAvailableThinkingLevels() { return this.rpc("get_available_thinking_levels"); }
  setSteeringMode(mode) { return this.rpc("set_steering_mode", { mode }); }
  setFollowUpMode(mode) { return this.rpc("set_follow_up_mode", { mode }); }
  compact(customInstructions) { return this.rpc("compact", customInstructions ? { customInstructions } : {}); }
  setAutoCompaction(enabled) { return this.rpc("set_auto_compaction", { enabled }); }
  setAutoRetry(enabled) { return this.rpc("set_auto_retry", { enabled }); }
  abortRetry() { return this.rpc("abort_retry"); }
  getSessionStats() { return this.rpc("get_session_stats"); }
  exportHtml() { return this.rpc("export_html"); }
  switchSession(sessionPath) { return this.rpc("switch_session", { sessionPath }); }
  fork(entryId) { return this.rpc("fork", { entryId }); }
  clone() { return this.rpc("clone"); }
  getForkMessages() { return this.rpc("get_fork_messages"); }
  getEntries(since) { return this.rpc("get_entries", since ? { since } : {}); }
  getTree() { return this.rpc("get_tree"); }
  async navigateTree(entryId, options = {}) {
    const raw = await this.post("/tree-navigate", { entryId, ...options });
    return { command: "navigate_tree", success: raw.success === true, data: raw.data, error: raw.error, raw };
  }
  terminalHandoff(mode) { return this.post("/terminal-handoff", { mode }); }
  getWorkspaceAccess() { return this.get("/workspace/access"); }
  createChat({ cwd, workspaceAccess = "write", approved = false } = {}) { return this.post("/chat-new", { cwd, workspaceAccess, approved }); }
  removeManagedWorktree(id) { return this.post("/worktree/remove", { id, approved: true }); }
  getLastAssistantText() { return this.rpc("get_last_assistant_text"); }
  setSessionName(name) { return this.rpc("set_session_name", { name }); }
  getCommands() { return this.rpc("get_commands"); }
  getRuntimeEvents(since = 0) { return this.get("/runtime-events-poll", { since }); }
  getRuntimeArtifact(id) { return this.get("/runtime-artifact", { id }); }
  listWorkflows() { return this.get("/workflows"); }
  getWorkflowRun(runId) { return this.get("/workflow/run", { runId }); }
  startWorkflow(workflowId, input = {}) { return this.post("/workflow/start", { workflowId, input }); }
  transitionWorkflow(runId, operation, fields = {}) { return this.post("/workflow/transition", { runId, operation, ...fields }); }
  getDoctor() { return this.get("/doctor"); }
  getAuthProviders() { return this.get("/auth/providers"); }
  getUserProfile() { return this.get("/profile"); }
  applyUserProfile(profile) { return this.post("/profile/apply", { profile, approved: true }); }
  discoverEnvironment(kind, fields = {}) { return this.post("/discovery", { kind, ...fields }); }
  getProjectSetupState(capabilityId) { return this.get("/setup/state", capabilityId ? { capabilityId } : {}); }
  getProjectConfig() { return this.get("/config/current"); }
  proposeProjectConfig(candidate) { return this.post("/config/proposal", { candidate }); }
  applyProjectConfig(proposalId) { return this.post("/config/apply", { proposalId, approved: true }); }
  getKnowledgeCatalog() { return this.get("/knowledge/catalog"); }
  searchKnowledge(query, scope) { return this.get("/knowledge/search", scope ? { q: query, scope } : { q: query }); }
  previewKnowledgeCreate(sourceId, record) { return this.post("/knowledge/preview", { action: "create", sourceId, record }); }
  previewKnowledgeTransition(sourceId, recordId, record) { return this.post("/knowledge/preview", { action: "transition", sourceId, recordId, record }); }
  applyKnowledgeProposal(proposalId) { return this.post("/knowledge/apply", { proposalId, approved: true }); }
}
