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
    if (cmd.type === "prompt") {
      out({ type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `polo:${cmd.message}` } });
      out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
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
      out({ id: cmd.id, type: "response", command: "compact", success: true,
        data: { summary: "stub summary", tokensBefore: 50000, estimatedTokensAfter: 8000 } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
