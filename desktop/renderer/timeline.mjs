// The conversation as the window shows it, built from Pi's RPC events
// (docs/json.md) and from saved messages (get_messages). Pure: no DOM, so the
// tests replay a recorded session through it. Every item has a stable id and
// applyEvent() returns the ids that changed so the view redraws only those.

let nextId = 0;
const newId = (prefix) => `${prefix}${++nextId}`;

export function createTimeline() {
  return {
    items: [],
    byId: new Map(),
    tools: new Map(), // toolCallId -> { name, args, status, partial, result, isError }
    toolOwner: new Map(), // toolCallId -> item id
    activeBash: null, // the `!command` item that is running
    compactionNotice: null,
    retryNotice: null,
    current: null, // the assistant item that is streaming
    busy: false,
    queue: { steering: [], followUp: [] },
    sessionName: undefined,
    thinkingLevel: undefined,
  };
}

function push(tl, item) {
  tl.items.push(item);
  tl.byId.set(item.id, item);
  return item.id;
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function imageCount(content) {
  return Array.isArray(content) ? content.filter((block) => block && block.type === "image").length : 0;
}

function blocksFrom(content, tl, itemId) {
  if (!Array.isArray(content)) return typeof content === "string" && content ? [{ type: "text", text: content }] : [];
  const blocks = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text") blocks.push({ type: "text", text: String(block.text || "") });
    else if (block.type === "thinking") blocks.push({ type: "thinking", text: String(block.thinking || "") });
    else if (block.type === "toolCall") {
      const id = String(block.id || "");
      blocks.push({ type: "tool", toolCallId: id, name: String(block.name || "tool"), args: block.arguments, argsText: "" });
      if (id) {
        tl.toolOwner.set(id, itemId);
        if (!tl.tools.has(id)) tl.tools.set(id, { name: String(block.name || "tool"), args: block.arguments, status: "pending" });
      }
    }
  }
  return blocks;
}

function standardsItem(message) {
  const details = message.details && typeof message.details === "object" ? message.details : {};
  const records = Array.isArray(details.records) ? details.records : [];
  const sources = records.map((record) => {
    const r = record && record.resolution ? record.resolution : {};
    return { domain: String(r.domain || ""), authority: String(r.authority_class || ""), state: String(r.state || "") };
  }).filter((source) => source.domain);
  const domains = Array.isArray(details.domains) ? details.domains.map(String) : sources.map((source) => source.domain);
  return { id: newId("s"), kind: "standards", domains, sources, content: textOf(message.content) };
}

function userItem(message) {
  return { id: newId("u"), kind: "user", text: textOf(message.content), images: imageCount(message.content), timestamp: message.timestamp };
}

function assistantItem(tl, message, streaming) {
  const id = newId("a");
  const item = { id, kind: "assistant", blocks: [], streaming, model: message.model || "", provider: message.provider || "" };
  item.blocks = blocksFrom(message.content, tl, id);
  finishAssistant(item, message);
  return item;
}

function finishAssistant(item, message) {
  if (message.stopReason) item.stopReason = message.stopReason;
  if (message.errorMessage) item.errorMessage = String(message.errorMessage);
  if (message.usage) item.usage = message.usage;
  if (message.model) item.model = message.model;
}

function setToolResult(tl, toolCallId, toolName, result, isError) {
  const tool = tl.tools.get(toolCallId) || { name: toolName || "tool" };
  tool.status = isError ? "error" : "done";
  tool.isError = Boolean(isError);
  tool.result = { text: textOf(result && result.content), details: result && result.details ? result.details : {} };
  tool.partial = undefined;
  tl.tools.set(toolCallId, tool);
  return tl.toolOwner.get(toolCallId);
}

/** Add one saved or live message; returns the id it changed, if any. */
function addMessage(tl, message, { streaming = false } = {}) {
  if (!message || typeof message !== "object") return null;
  switch (message.role) {
    case "user":
      return push(tl, userItem(message));
    case "assistant": {
      const item = assistantItem(tl, message, streaming);
      if (streaming) tl.current = item.id;
      return push(tl, item);
    }
    case "toolResult":
      return setToolResult(tl, String(message.toolCallId || ""), message.toolName, message, message.isError);
    case "custom":
      if (message.customType === "coop-standards") return push(tl, standardsItem(message));
      if (message.display === false) return null;
      return push(tl, { id: newId("c"), kind: "custom", customType: String(message.customType || ""), text: textOf(message.content) });
    case "bashExecution":
      return push(tl, {
        id: newId("b"), kind: "bash", command: String(message.command || ""), output: String(message.output || ""),
        exitCode: message.exitCode, cancelled: Boolean(message.cancelled), truncated: Boolean(message.truncated),
        excluded: Boolean(message.excludeFromContext), running: false,
      });
    case "compactionSummary":
      return push(tl, { id: newId("k"), kind: "compaction", summary: String(message.summary || ""), tokensBefore: message.tokensBefore });
    case "branchSummary":
      return push(tl, { id: newId("r"), kind: "branch", summary: String(message.summary || "") });
    default:
      return null; // system prompts and unknown roles are not shown
  }
}

/** Rebuild from a saved conversation (get_messages after a load or switch). */
export function loadMessages(tl, messages) {
  const fresh = createTimeline();
  fresh.sessionName = tl.sessionName;
  fresh.thinkingLevel = tl.thinkingLevel;
  Object.assign(tl, fresh);
  for (const message of Array.isArray(messages) ? messages : []) addMessage(tl, message);
  return tl;
}

export function notice(tl, level, text, { markdown = false } = {}) {
  return push(tl, { id: newId("n"), kind: "notice", level, text: String(text), markdown });
}

function ensureBlock(item, index, type) {
  if (!Number.isInteger(index) || index < 0 || index > 10_000) return null;
  let block = item.blocks[index];
  if (!block || block.type !== type) {
    block = type === "tool" ? { type, toolCallId: "", name: "tool", argsText: "" } : { type, text: "" };
    item.blocks[index] = block;
  }
  return block;
}

function applyAssistantEvent(tl, item, event) {
  const index = event.contentIndex;
  switch (event.type) {
    case "text_start": ensureBlock(item, index, "text"); break;
    case "text_delta": { const b = ensureBlock(item, index, "text"); if (b) b.text += String(event.delta || ""); break; }
    case "text_end": { const b = ensureBlock(item, index, "text"); if (b && typeof event.content === "string") b.text = event.content; break; }
    case "thinking_start": ensureBlock(item, index, "thinking"); break;
    case "thinking_delta": { const b = ensureBlock(item, index, "thinking"); if (b) b.text += String(event.delta || ""); break; }
    case "thinking_end": { const b = ensureBlock(item, index, "thinking"); if (b && typeof event.content === "string") b.text = event.content; break; }
    case "toolcall_start": {
      const b = ensureBlock(item, index, "tool");
      if (!b) break;
      b.toolCallId = String(event.id || "");
      b.name = String(event.toolName || "tool");
      if (b.toolCallId) {
        tl.toolOwner.set(b.toolCallId, item.id);
        if (!tl.tools.has(b.toolCallId)) tl.tools.set(b.toolCallId, { name: b.name, status: "pending" });
      }
      break;
    }
    case "toolcall_delta": { const b = ensureBlock(item, index, "tool"); if (b) b.argsText += String(event.delta || ""); break; }
    case "toolcall_end": {
      const b = ensureBlock(item, index, "tool");
      const call = event.toolCall || {};
      if (!b) break;
      b.toolCallId = String(call.id || b.toolCallId);
      b.name = String(call.name || b.name);
      b.args = call.arguments;
      if (b.toolCallId) {
        tl.toolOwner.set(b.toolCallId, item.id);
        const tool = tl.tools.get(b.toolCallId) || { status: "pending" };
        tool.name = b.name;
        tool.args = call.arguments;
        tl.tools.set(b.toolCallId, tool);
      }
      break;
    }
    case "error":
      item.errorMessage = String((event.error && event.error.errorMessage) || event.reason || "The model stopped with an error");
      break;
    default:
      break;
  }
}

/**
 * Apply one Pi event. Returns { changed: ids that need a redraw, status: true
 * when busy/queue/name/level changed }.
 */
export function applyEvent(tl, event) {
  const changed = [];
  let status = false;
  const mark = (id) => { if (id) changed.push(id); };
  if (!event || typeof event !== "object") return { changed, status };
  switch (event.type) {
    case "agent_start":
      tl.busy = true; status = true; break;
    case "agent_settled":
      tl.busy = false; status = true;
      if (tl.current) { const item = tl.byId.get(tl.current); if (item) { item.streaming = false; mark(item.id); } tl.current = null; }
      break;
    case "message_start": {
      const message = event.message || {};
      if (message.role === "assistant") mark(addMessage(tl, message, { streaming: true }));
      else if (message.role !== "toolResult") mark(addMessage(tl, message));
      break;
    }
    case "message_update": {
      const item = tl.current && tl.byId.get(tl.current);
      if (item && event.assistantMessageEvent) { applyAssistantEvent(tl, item, event.assistantMessageEvent); if (event.usage) item.usage = event.usage; mark(item.id); }
      break;
    }
    case "message_end": {
      const message = event.message || {};
      if (message.role === "assistant") {
        const item = tl.current && tl.byId.get(tl.current);
        if (item) {
          item.blocks = blocksFrom(message.content, tl, item.id);
          item.streaming = false;
          finishAssistant(item, message);
          tl.current = null;
          mark(item.id);
        } else {
          mark(addMessage(tl, message));
        }
      } else if (message.role === "toolResult") {
        mark(setToolResult(tl, String(message.toolCallId || ""), message.toolName, message, message.isError));
      }
      break;
    }
    case "tool_execution_start": {
      const id = String(event.toolCallId || "");
      const tool = tl.tools.get(id) || {};
      Object.assign(tool, { name: String(event.toolName || tool.name || "tool"), args: event.args !== undefined ? event.args : tool.args, status: "running" });
      tl.tools.set(id, tool);
      mark(tl.toolOwner.get(id));
      break;
    }
    case "tool_execution_update": {
      const id = String(event.toolCallId || "");
      const tool = tl.tools.get(id);
      if (tool) { tool.partial = textOf(event.partialResult && event.partialResult.content); mark(tl.toolOwner.get(id)); }
      break;
    }
    case "tool_execution_end":
      mark(setToolResult(tl, String(event.toolCallId || ""), event.toolName, event.result, event.isError));
      break;
    case "queue_update":
      tl.queue = {
        steering: Array.isArray(event.steering) ? event.steering.map(String) : [],
        followUp: Array.isArray(event.followUp) ? event.followUp.map(String) : [],
      };
      status = true;
      break;
    case "session_info_changed":
      tl.sessionName = typeof event.name === "string" ? event.name : undefined; status = true; break;
    case "thinking_level_changed":
      tl.thinkingLevel = String(event.level || ""); status = true; break;
    case "compaction_start":
      tl.compactionNotice = notice(tl, "info", event.reason === "manual" ? "Compacting the conversation..." : "The context is nearly full; compacting the conversation...");
      mark(tl.compactionNotice);
      break;
    case "compaction_end": {
      const text = event.result
        ? `Compacted the conversation: about ${formatTokens(event.result.tokensBefore)} tokens down to ${formatTokens(event.result.estimatedTokensAfter)}.`
        : event.aborted ? "Compaction stopped." : `Compaction failed: ${event.errorMessage || "unknown error"}`;
      const item = tl.compactionNotice && tl.byId.get(tl.compactionNotice);
      if (item) { item.text = text; item.level = event.result || event.aborted ? "info" : "error"; mark(item.id); }
      else mark(notice(tl, event.result ? "info" : "error", text));
      tl.compactionNotice = null;
      break;
    }
    case "auto_retry_start":
      tl.retryNotice = notice(tl, "warning", `The model call failed (${event.errorMessage || "error"}); retrying, attempt ${event.attempt} of ${event.maxAttempts}.`);
      mark(tl.retryNotice);
      break;
    case "auto_retry_end": {
      const item = tl.retryNotice && tl.byId.get(tl.retryNotice);
      if (item) {
        item.text = event.success ? `Retry worked on attempt ${event.attempt}.` : `Retries ran out: ${event.finalError || "the model call failed"}`;
        item.level = event.success ? "info" : "error";
        mark(item.id);
      }
      tl.retryNotice = null;
      break;
    }
    case "extension_error":
      mark(notice(tl, "error", `An extension failed (${shortPath(event.extensionPath)}, ${event.event || "event"}): ${event.error || "unknown error"}`));
      break;
    case "bash_execution_update": {
      // Pi runs one `!command` at a time; its output streams here.
      const item = tl.activeBash && tl.byId.get(tl.activeBash);
      if (item) { item.output += String(event.delta || ""); mark(item.id); }
      break;
    }
    default:
      break;
  }
  return { changed, status };
}

/** A `!command` the user ran: shown at once, filled by bash_execution_update. */
export function startBash(tl, command, excluded) {
  const id = push(tl, { id: newId("b"), kind: "bash", command, output: "", running: true, excluded: Boolean(excluded) });
  tl.activeBash = id;
  return id;
}

export function finishBash(tl, itemId, result) {
  const item = tl.byId.get(itemId);
  if (tl.activeBash === itemId) tl.activeBash = null;
  if (!item) return null;
  item.running = false;
  if (result && typeof result.output === "string" && result.output.length >= item.output.length) item.output = result.output;
  if (result) Object.assign(item, { exitCode: result.exitCode, cancelled: Boolean(result.cancelled), truncated: Boolean(result.truncated), fullOutputPath: result.fullOutputPath });
  return itemId;
}

export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function shortPath(path) {
  const text = String(path || "extension");
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || text;
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function pathOf(args) {
  const a = args && typeof args === "object" ? args : {};
  return String(a.path || a.file_path || a.filePath || "");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One line for a run of tool calls and thinking: "Read vSales.sql, ran 2
 * commands, edited report.sql", or the live step while the last one runs.
 * blocks are the run's blocks in order; tools is the timeline's tool map.
 */
export function activitySummary(blocks, tools, { live = false } = {}) {
  const read = []; const ran = []; const edited = []; const searched = []; const other = [];
  let thinking = 0; let failed = 0;
  const toolOf = (block) => tools.get(block.toolCallId) || { status: "pending" };
  for (const block of blocks) {
    if (block.type === "thinking") { if (block.text && block.text.trim()) thinking++; continue; }
    if (block.type !== "tool") continue;
    const tool = toolOf(block);
    const name = block.name || tool.name || "tool";
    const args = block.args !== undefined ? block.args : tool.args;
    if (tool.status === "error") failed++;
    if (name === "read") read.push(fileName(pathOf(args)));
    else if (name === "bash") ran.push(String((args && args.command) || "").split("\n")[0]);
    else if (name === "edit" || name === "write") edited.push(fileName(pathOf(args)));
    else if (name === "grep" || name === "find" || name === "ls") searched.push(name);
    else other.push(name);
  }
  const last = blocks[blocks.length - 1];
  if (live && last) {
    if (last.type === "thinking") return "Thinking...";
    if (last.type === "tool") {
      const tool = toolOf(last);
      if (tool.status === "pending" || tool.status === "running") {
        const name = last.name || tool.name || "tool";
        const args = last.args !== undefined ? last.args : tool.args;
        const target = name === "bash" ? String((args && args.command) || "").split("\n")[0].slice(0, 60) : fileName(pathOf(args));
        if (name === "read") return `Reading ${target || "a file"}...`;
        if (name === "bash") return `Running ${target || "a command"}...`;
        if (name === "edit" || name === "write") return `Editing ${target || "a file"}...`;
        if (name === "grep" || name === "find" || name === "ls") return "Searching the folder...";
        return `Using ${name}...`;
      }
    }
  }
  const parts = [];
  if (read.length) parts.push(`read ${read.length === 1 && read[0] ? read[0] : plural(read.length, "file")}`);
  if (ran.length) parts.push(`ran ${ran.length === 1 && ran[0] ? ran[0].slice(0, 60) : plural(ran.length, "command")}`);
  if (edited.length) parts.push(`edited ${edited.length === 1 && edited[0] ? edited[0] : plural(edited.length, "file")}`);
  if (searched.length) parts.push(searched.length === 1 ? "searched the folder" : `searched ${searched.length} times`);
  if (other.length) parts.push(`used ${[...new Set(other)].join(", ")}`);
  if (!parts.length) parts.push(thinking ? "thought it through" : "worked");
  let text = parts.join(", ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (failed) text += ` (${plural(failed, "step")} failed)`;
  return text;
}

/**
 * One turn as the window shows it: a run of assistant messages with nothing
 * else between them (the model answers, calls tools, answers again) is one
 * answer, so its tool calls fold across the message boundaries. Returns the
 * consecutive assistant items around the item with this id (the item alone
 * for anything else).
 */
export function turnOf(items, id) {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return [];
  if (items[at].kind !== "assistant") return [items[at]];
  let start = at;
  while (start > 0 && items[start - 1].kind === "assistant") start--;
  let end = at;
  while (end + 1 < items.length && items[end + 1].kind === "assistant") end++;
  return items.slice(start, end + 1);
}

/** Every item, with each run of assistant messages grouped as one turn. */
export function turns(items) {
  const out = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "assistant" && last && last[0].kind === "assistant") last.push(item);
    else out.push([item]);
  }
  return out;
}

/** One line that says what a tool call does, for its collapsed header. */
export function toolSummary(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const path = a.path || a.file_path || a.filePath || "";
  switch (name) {
    case "bash": return String(a.command || "").split("\n")[0];
    case "read": return path + (a.offset ? ` from line ${a.offset}` : "");
    case "edit": return `${path}${Array.isArray(a.edits) && a.edits.length > 1 ? ` (${a.edits.length} edits)` : ""}`;
    case "write": return path;
    case "grep": return `${a.pattern || ""}${path ? ` in ${path}` : ""}`;
    case "find": case "ls": return String(a.pattern || path || ".");
    default: {
      const first = Object.entries(a).find(([, value]) => typeof value === "string" && value.length);
      return first ? `${first[0]}: ${first[1]}`.split("\n")[0] : "";
    }
  }
}
