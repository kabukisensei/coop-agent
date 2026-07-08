// A stub `pi --mode rpc` for tests/webbridge.test.mjs: speaks just enough of the
// JSONL protocol to exercise the bridge. Emits a select dialog + a notify at
// startup (like coop's Start Here menu), then answers every `prompt` command with
// a streamed "polo:<message>" text delta.
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

out({
  type: "extension_ui_request",
  id: "stub-dialog-1",
  method: "select",
  title: "Welcome to coop 👋  What would you like to do?",
  options: ["Option A", "Option B", "Something else — I'll type it myself"],
});
out({ type: "extension_ui_request", id: "stub-notify-1", method: "notify", message: "stub ready", notifyType: "info" });
// Extension-UI methods beyond the four dialogs (M4). setStatus carries an ANSI SGR
// color (stripped client-side); holo_display is an UNKNOWN method (renders a fallback
// card AND registers as one deduped protocol-drift line per stub child — expected).
out({ type: "extension_ui_request", id: "stub-status-1", method: "setStatus", statusKey: "stub", statusText: "stub status \x1b[32mgreen\x1b[0m" });
out({ type: "extension_ui_request", id: "stub-widget-1", method: "setWidget", widgetKey: "w1", widgetLines: ["line one", "line two"] });
out({ type: "extension_ui_request", id: "stub-title-1", method: "setTitle", title: "Stub Title" });
out({ type: "extension_ui_request", id: "stub-editor-1", method: "set_editor_text", text: "prefilled" });
out({ type: "extension_ui_request", id: "stub-mystery-1", method: "holo_display", title: "unknown method" });

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    // Test escape hatch: inject an arbitrary raw line straight through the real
    // stdout pipe (no agent_start, so the bridge's `busy` is untouched). The drift
    // integration tests use this to provoke unknown / shape-mismatched events.
    if (cmd.type === "prompt" && typeof cmd.message === "string" && cmd.message.startsWith("emit:")) {
      process.stdout.write(cmd.message.slice(5) + "\n");
      continue;
    }
    // Simulate a pi crash — the bridge must CONTAIN it to this chat (M5), not exit.
    if (cmd.type === "prompt" && cmd.message === "__crash__") process.exit(3);
    // Exercise the delete-on-absent contract end-to-end: setStatus with NO statusText
    // clears the "stub" segment (M4).
    if (cmd.type === "prompt" && cmd.message === "clear-status") {
      out({ type: "extension_ui_request", id: "stub-status-2", method: "setStatus", statusKey: "stub" });
    }
    if (cmd.type === "prompt") {
      out({ type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `polo:${cmd.message}` } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
      // Also stream a tool call — Pi 0.80.x's AssistantMessageEvent union includes
      // toolcall_start/delta/end (delta = partial-JSON args as a string). Every real
      // tool call produces these; exercising them here guards the contract's
      // toolcall_* members against the end-of-suite no-drift assertion.
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCallId: "stub-tc-1", toolName: "read" } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"n' } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1 } });
      out({ type: "agent_end", messages: [] });
    } else if (cmd.type === "extension_ui_response") {
      out({ type: "response", command: "extension_ui_response", success: true });
    } else if (cmd.type === "abort") {
      out({ type: "response", command: "abort", success: true });
      out({ type: "agent_end", messages: [] });
    } else if (cmd.type === "get_state") {
      out({ id: cmd.id, type: "response", command: "get_state", success: true,
        data: { model: { id: "stub-1", provider: "stub", name: "Stub One" }, thinkingLevel: "medium", isStreaming: false } });
    } else if (cmd.type === "get_available_models") {
      out({ id: cmd.id, type: "response", command: "get_available_models", success: true,
        data: { models: [ { id: "stub-1", provider: "stub", name: "Stub One" }, { id: "stub-2", provider: "stub", name: "Stub Two" } ] } });
    } else if (cmd.type === "set_model") {
      out({ id: cmd.id, type: "response", command: "set_model", success: true,
        data: { id: cmd.modelId, provider: cmd.provider, name: cmd.modelId } });
    } else if (cmd.type === "set_thinking_level") {
      out({ id: cmd.id, type: "response", command: "set_thinking_level", success: true });
    } else if (cmd.type === "new_session") {
      out({ id: cmd.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
    } else if (cmd.type === "get_messages") {
      out({ id: cmd.id, type: "response", command: "get_messages", success: true,
        data: { messages: [
          { role: "user", content: [{ type: "text", text: "old question" }] },
          { role: "assistant", content: [{ type: "text", text: "old answer" }, { type: "toolCall", id: "t1", name: "sql_review", arguments: {} }] },
        ] } });
    } else if (cmd.type === "compact") {
      const reply = { id: cmd.id, type: "response", command: "compact", success: true,
        data: { summary: "stub summary", tokensBefore: 50000, estimatedTokensAfter: 8000 } };
      // COOP_STUB_COMPACT_DELAY_MS lets a test make compact slow (an LLM round-trip), to
      // exercise the bridge's per-command /rpc timeout without a real long wait.
      const delay = Number(process.env.COOP_STUB_COMPACT_DELAY_MS) || 0;
      if (delay > 0) setTimeout(() => out(reply), delay); else out(reply);
    } else if (cmd.type === "get_session_stats") {
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true,
        data: {
          sessionFile: "stub.jsonl", sessionId: "test-session",
          userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, total: 1540 },
          cost: 0.01,
          contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
        } });
    } else if (cmd.type === "set_session_name") {
      out({ id: cmd.id, type: "response", command: "set_session_name", success: true });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
