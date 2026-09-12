// A stub `pi --mode rpc` for tests/webbridge.test.mjs: speaks just enough of the
// JSONL protocol to exercise the bridge. Emits a select dialog + a notify at
// startup to simulate an on-demand Start Here card, then answers every `prompt` command with
// a streamed "polo:<message>" text delta.
import { readFileSync } from "node:fs";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const impactFixture = JSON.parse(readFileSync(new URL("./fixtures/impact/impact-analysis-v1.json", import.meta.url), "utf8"));

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
let currentLeaf = "a1";
let currentSessionFile = process.argv.includes("--session") ? process.argv[process.argv.indexOf("--session") + 1] : process.env.COOP_STUB_SESSION_FILE || "stub.jsonl";
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
    if (cmd.type === "prompt" && cmd.message === "__crash__") {
      const delay = Math.max(0, Math.min(5000, Number(process.env.COOP_STUB_CRASH_DELAY_MS) || 0));
      if (!delay) process.exit(3);
      setTimeout(() => process.exit(3), delay);
      continue;
    }
    if (cmd.type === "prompt" && cmd.message === "__domain_tool__") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      out({ type: "tool_execution_start", toolCallId: "domain-sql-1", toolName: "sql_review", args: { paths: ["sample.sql"] } });
      out({ type: "tool_execution_update", toolCallId: "domain-sql-1", toolName: "sql_review", args: { paths: ["sample.sql"] }, partialResult: { content: [{ type: "text", text: "checking" }] } });
      out({
        type: "tool_execution_end",
        toolCallId: "domain-sql-1",
        toolName: "sql_review",
        isError: false,
        result: {
          content: [{ type: "text", text: "SQL review found one issue." }],
          details: {
            report: {
              tool: "coop-sql-review",
              version: "0.15.2",
              schema_version: 4,
              coverage: { parser: { status: "partial", attempted: 2, parsed: 1 } },
              summary: { error: 1, warning: 0, info: 0 },
              findings: [{ rule_id: "SQL-STUB", severity: "error", file: "sample.sql", line: 1, fingerprint: "stub" }],
              agent_review: [],
              diagnostics: [{ severity: "error", message: "one file did not parse" }],
              verdict: { clean: false, highest_severity: "error" },
            },
          },
        },
      });
      continue;
    }
    if (cmd.type === "prompt" && cmd.message === "__lineage_tool__") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      out({ type: "tool_execution_start", toolCallId: "domain-lineage-1", toolName: "data_doc", args: { command: "lineage", object: "dbo.fact_sales" } });
      out({
        type: "tool_execution_end",
        toolCallId: "domain-lineage-1",
        toolName: "data_doc",
        isError: false,
        result: {
          content: [{ type: "text", text: "Focused lineage ready." }],
          details: {
            lineage: {
              schema_version: 1,
              query: "dbo.fact_sales",
              depth: 1,
              evidence_status: "partial",
              object: { id: "gold_table:dbo.fact_sales", name: "dbo.fact_sales", type: "gold_table", source_file: "sample.sql", doc: "gold_table/fact-sales.md", doc_path: "data-docs/gold_table/fact-sales.md", trust: {} },
              upstream: [{ id: "stored_proc:dbo.load_fact_sales", name: "dbo.load_fact_sales", type: "stored_proc", source_file: "load.sql", doc: "stored_proc/load.md", doc_path: "data-docs/stored_proc/load.md", trust: { dynamic_sql_untraced: true } }],
              downstream: [],
              edges: [{ source_id: "stored_proc:dbo.load_fact_sales", target_id: "gold_table:dbo.fact_sales", type: "writes", evidence: "INSERT INTO dbo.fact_sales", flow: { upstream_id: "stored_proc:dbo.load_fact_sales", downstream_id: "gold_table:dbo.fact_sales" } }],
              relationships: [],
            },
          },
        },
      });
      continue;
    }
    if (cmd.type === "prompt" && cmd.message === "__impact_tool__") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      out({ type: "tool_execution_start", toolCallId: "domain-impact-1", toolName: "impact_analysis_result", args: { analysis: { analysisId: impactFixture.analysisId } } });
      out({
        type: "tool_execution_end",
        toolCallId: "domain-impact-1",
        toolName: "impact_analysis_result",
        isError: false,
        result: {
          content: [{ type: "text", text: "Impact analysis ready." }],
          details: { version: "1", report: impactFixture },
        },
      });
      continue;
    }
    if (cmd.type === "prompt" && typeof cmd.message === "string" && cmd.message.startsWith("/coop-runtime-shutdown ")) {
      let request;
      try { request = JSON.parse(Buffer.from(cmd.message.slice("/coop-runtime-shutdown ".length), "base64url").toString("utf8")); }
      catch { request = null; }
      if (!request || request.bridgeSecret !== process.env.COOP_RUNTIME_CONTROL_SECRET) {
        out({ id: cmd.id, type: "response", command: "prompt", success: false, error: "runtime control authentication failed" });
        continue;
      }
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      setTimeout(() => process.exit(0), 5);
      continue;
    }
    // Pi 0.84.3 has no direct navigate_tree RPC command. The real Coop extension
    // handles this authenticated slash command through its public navigateTree()
    // context action and reports a correlated internal setStatus result.
    if (cmd.type === "prompt" && typeof cmd.message === "string" && cmd.message.startsWith("/coop-tree-navigate ")) {
      let request;
      try { request = JSON.parse(Buffer.from(cmd.message.slice("/coop-tree-navigate ".length), "base64url").toString("utf8")); }
      catch { request = null; }
      if (!request || request.bridgeSecret !== process.env.COOP_TREE_NAVIGATION_SECRET) {
        out({ id: cmd.id, type: "response", command: "prompt", success: true });
        continue;
      }
      const previousLeafId = currentLeaf;
      const cancelled = request.targetId === "cancel";
      const error = request.targetId === "missing" ? "Entry missing not found" : undefined;
      if (!cancelled && !error) currentLeaf = request.summarize ? `summary-${request.targetId}` : request.targetId;
      const result = {
        requestId: request.requestId,
        targetId: request.targetId,
        cancelled,
        previousLeafId,
        currentLeafId: currentLeaf,
        ...(request.targetId === "u1" && !cancelled && !error ? { editorText: "old question" } : {}),
        ...(error ? { error } : {}),
      };
      out({
        type: "extension_ui_request",
        id: `stub-${request.requestId}`,
        method: "setStatus",
        statusKey: `coop-tree-navigate:${request.requestId}`,
        statusText: JSON.stringify(result),
      });
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      continue;
    }
    // Exercise the delete-on-absent contract end-to-end: setStatus with NO statusText
    // clears the "stub" segment (M4).
    if (cmd.type === "prompt" && cmd.message === "clear-status") {
      out({ type: "extension_ui_request", id: "stub-status-2", method: "setStatus", statusKey: "stub" });
    }
    if (cmd.type === "prompt") {
      out({ type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }, ...(cmd.images || [])] } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "start" } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `polo:${cmd.message}` } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: `polo:${cmd.message}` } });
      // Also stream a tool call — Pi 0.84.3's AssistantMessageEvent union includes
      // toolcall_start/delta/end (delta = partial-JSON args as a string). Every real
      // tool call produces these; exercising them here guards the contract's
      // toolcall_* members against the end-of-suite no-drift assertion.
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "stub-tc-1", toolName: "read" } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"n' } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "stub-tc-1", name: "read", arguments: { path: "notes.md" } } } });
      out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "done", reason: "toolUse", message: { role: "assistant", content: [] } } });
      out({ type: "agent_end", messages: [], willRetry: false });
      // Source-derived 0.84.3 lifecycle events that this stub does not otherwise
      // need. They must pass through without false protocol-drift warnings.
      out({ type: "entry_appended", entry: {} });
      out({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "stub" });
      out({ type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" });
      out({ type: "summarization_retry_finished" });
      out({ type: "bash_execution_update", id: "stub-bash", delta: "stub" });
      out({ type: "agent_settled" });
    } else if (cmd.type === "extension_ui_response") {
      out({ type: "response", command: "extension_ui_response", success: true });
    } else if (cmd.type === "abort") {
      out({ type: "response", command: "abort", success: true });
      out({ type: "agent_end", messages: [], willRetry: false });
    } else if (cmd.type === "get_state") {
      out({ id: cmd.id, type: "response", command: "get_state", success: true,
        data: {
          model: { id: "stub-1", provider: "stub", name: "Stub One" },
          thinkingLevel: "medium", isStreaming: false, isCompacting: false,
          steeringMode: "all", followUpMode: "one-at-a-time",
          sessionFile: currentSessionFile, sessionId: "test-session",
          autoCompactionEnabled: true, messageCount: 2, pendingMessageCount: 0,
        } });
    } else if (cmd.type === "get_available_models") {
      out({ id: cmd.id, type: "response", command: "get_available_models", success: true,
        data: { models: [ { id: "stub-1", provider: "stub", name: "Stub One" }, { id: "stub-2", provider: "stub", name: "Stub Two" } ] } });
    } else if (cmd.type === "set_model") {
      out({ id: cmd.id, type: "response", command: "set_model", success: true,
        data: { id: cmd.modelId, provider: cmd.provider, name: cmd.modelId } });
    } else if (cmd.type === "cycle_model") {
      out({ id: cmd.id, type: "response", command: "cycle_model", success: true,
        data: { model: { id: "stub-2", provider: "stub", name: "Stub Two" }, thinkingLevel: "high", isScoped: false } });
    } else if (cmd.type === "set_thinking_level") {
      out({ id: cmd.id, type: "response", command: "set_thinking_level", success: true });
    } else if (cmd.type === "cycle_thinking_level") {
      out({ id: cmd.id, type: "response", command: "cycle_thinking_level", success: true, data: { level: "high" } });
    } else if (cmd.type === "get_available_thinking_levels") {
      out({ id: cmd.id, type: "response", command: "get_available_thinking_levels", success: true,
        data: { levels: ["off", "minimal", "low", "medium", "high"] } });
    } else if (cmd.type === "steer" || cmd.type === "follow_up") {
      out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      out({ type: "queue_update", action: "enqueue", queueType: cmd.type === "steer" ? "steering" : "followUp", message: cmd.message });
    } else if (cmd.type === "set_steering_mode" || cmd.type === "set_follow_up_mode" ||
               cmd.type === "set_auto_compaction" || cmd.type === "set_auto_retry" || cmd.type === "abort_retry") {
      out({ id: cmd.id, type: "response", command: cmd.type, success: true });
    } else if (cmd.type === "new_session") {
      out({ id: cmd.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
    } else if (cmd.type === "get_messages") {
      out({ id: cmd.id, type: "response", command: "get_messages", success: true,
        data: { messages: [
          { role: "user", content: [{ type: "text", text: "old question" }] },
          { role: "assistant", content: [{ type: "thinking", thinking: "old reasoning" }, { type: "text", text: "old answer" }, { type: "toolCall", id: "t1", name: "sql_review", arguments: { path: "query.sql" } }] },
          { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "Command aborted" }], isError: true },
        ] } });
    } else if (cmd.type === "compact") {
      if (cmd.customInstructions === "__hold_until_exit__") {
        out({ type: "compaction_start", reason: "fixture-hold-until-exit" });
        continue;
      }
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
    } else if (cmd.type === "export_html") {
      out({ id: cmd.id, type: "response", command: "export_html", success: true, data: { path: "/tmp/stub-session.html" } });
    } else if (cmd.type === "switch_session") {
      currentSessionFile = cmd.sessionPath;
      out({ id: cmd.id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
    } else if (cmd.type === "fork") {
      out({ id: cmd.id, type: "response", command: "fork", success: true,
        data: { text: cmd.entryId === "cancel" ? "" : "fork point", cancelled: cmd.entryId === "cancel" } });
    } else if (cmd.type === "clone") {
      currentSessionFile = process.env.COOP_STUB_CLONE_SESSION_FILE || currentSessionFile;
      out({ id: cmd.id, type: "response", command: "clone", success: true, data: { cancelled: false } });
    } else if (cmd.type === "get_fork_messages") {
      out({ id: cmd.id, type: "response", command: "get_fork_messages", success: true,
        data: { messages: [{ entryId: "u1", text: "old question" }] } });
    } else if (cmd.type === "get_entries") {
      out({ id: cmd.id, type: "response", command: "get_entries", success: true,
        data: (() => {
          if (cmd.since !== undefined && process.argv.includes("--session")) {
            try {
              const entries = readFileSync(currentSessionFile, "utf8").trim().split("\n").map(JSON.parse).filter(e => e.type !== "session" && e.id);
              return { entries: [], leafId: entries.some(e => e.id === "a2") ? "a2" : entries.at(-1)?.id ?? null };
            } catch { return { entries: [], leafId: "missing" }; }
          }
          return { entries: [{ type: "message", id: "u1", parentId: null }], leafId: "a1" };
        })() });
    } else if (cmd.type === "get_tree") {
      out({ id: cmd.id, type: "response", command: "get_tree", success: true,
        data: { tree: [{ entry: { type: "message", id: "u1", parentId: null }, children: [] }], leafId: currentLeaf } });
    } else if (cmd.type === "get_last_assistant_text") {
      out({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "old answer" } });
    } else if (cmd.type === "set_session_name") {
      out({ id: cmd.id, type: "response", command: "set_session_name", success: true });
    } else if (cmd.type === "get_commands") {
      out({ id: cmd.id, type: "response", command: "get_commands", success: true,
        data: { commands: [{ name: "impact-analysis", description: "Trace impact", source: "skill",
          sourceInfo: { type: "skill", path: "/skills/power-bi-impact-analysis/SKILL.md" } }] } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
