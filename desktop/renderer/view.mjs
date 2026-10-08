// Draws one timeline item. Called again for an item whenever Pi changes it.
import { el, icon } from "./ui.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { parseEditDiff, diffStats } from "./diff.mjs";
import { toolSummary, activitySummary, formatTokens, codemodeCalls } from "./timeline.mjs";
import { splitAttachmentNote } from "./attach-note.mjs";

const MAX_LINES = 80;
const MAX_CHARS = 12_000;

export function codeBlock(doc, lang, text) {
  return el("div", { class: "code-block" },
    el("div", { class: "code-head" },
      el("span", { class: "code-lang", text: lang || "text" }),
      copyButton(text, "Copy code")),
    el("pre", {}, el("code", { text })));
}

export function copyButton(text, label = "Copy") {
  const button = el("button", { type: "button", class: "btn icon copy", title: label, "aria-label": label }, icon("copy"));
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const result = await window.coop.copy(typeof text === "function" ? text() : text);
    if (result && result.success) {
      button.classList.add("done");
      button.replaceChildren(icon("check"));
      setTimeout(() => { button.classList.remove("done"); button.replaceChildren(icon("copy")); }, 1400);
    }
  });
  return button;
}

function markdown(text, className = "md") {
  const box = el("div", { class: className });
  renderMarkdown(document, text, box, { codeBlock });
  return box;
}

function clipped(text, open) {
  const value = String(text || "");
  const lines = value.split("\n");
  const long = lines.length > MAX_LINES || value.length > MAX_CHARS;
  if (!long || open.all) return { text: value, more: false };
  return { text: lines.slice(0, MAX_LINES).join("\n").slice(0, MAX_CHARS), more: true, hidden: lines.length - MAX_LINES };
}

function outputBlock(text, kind, state) {
  const shown = clipped(text, state);
  const pre = el("pre", { class: `output ${kind || ""}` }, el("code", { text: shown.text }));
  if (!shown.more) return pre;
  return el("div", { class: "output-wrap" }, pre, el("button", {
    type: "button", class: "btn link", text: "Show all output",
    onclick: (event) => { event.stopPropagation(); state.all = true; state.redraw(); },
  }));
}

function diffView(rows) {
  return el("div", { class: "diff", role: "table", "aria-label": "Changes" }, rows.map((row) => el("div", { class: `diff-row ${row.kind}`, role: "row" },
    el("span", { class: "diff-num", text: row.line }),
    el("span", { class: "diff-sign", text: row.kind === "add" ? "+" : row.kind === "del" ? "-" : " " }),
    el("span", { class: "diff-text", text: row.text }))));
}

// Where a tool call's file opens in the side pane: the project form for the
// contract, the docs pane for the docs config, else the changes panel.
const PROJECT_FILE = /(^|[\\/])\.coop[\\/]project\.ya?ml$/i;
const DOCS_FILE = /(^|[\\/])coop-data-doc\.ya?ml$/i;

export function paneLinksForTool(name, args, status) {
  const a = args && typeof args === "object" ? args : {};
  const path = String(a.path || a.file_path || a.filePath || "");
  const links = [];
  if (name === "data_doc") links.push({ pane: "docs", label: "Lineage docs", options: {} });
  if ((name === "edit" || name === "write") && path && status !== "error") {
    if (PROJECT_FILE.test(path)) links.push({ pane: "project", label: "Project settings", options: {} });
    else if (DOCS_FILE.test(path)) links.push({ pane: "docs", label: "Lineage docs", options: {} });
    links.push({ pane: "changes", label: "View in Changes", options: { path } });
  }
  return links;
}

/** Side-pane links for a notice that points at /setup-project or /setup-docs. */
export function paneLinksForText(text) {
  const value = String(text || "");
  const links = [];
  if (/\/setup-project\b/.test(value)) links.push({ pane: "project", label: "Open the project form", options: {} });
  if (/\/setup-docs\b/.test(value)) links.push({ pane: "docs", label: "Open the docs setup", options: {} });
  return links;
}

function paneButtons(links, prefs) {
  if (!links.length || !prefs.openPane) return null;
  return el("div", { class: "pane-links" }, links.map((link) => el("button", {
    type: "button",
    class: "btn link",
    text: link.label,
    onclick: (event) => { event.stopPropagation(); prefs.openPane(link.pane, link.options); },
  })));
}

function statusIcon(status) {
  if (status === "running" || status === "pending") return el("span", { class: "spinner", "aria-label": "Running" });
  if (status === "error") return icon("close", "Failed");
  return icon("check", "Done");
}

function argsView(name, args, argsText) {
  if (name === "bash" && args && typeof args.command === "string") return el("pre", { class: "output command" }, el("code", { text: `$ ${args.command}` }));
  if (name === "codemode" && args && typeof args.code === "string") return el("pre", { class: "output command" }, el("code", { text: args.code }));
  if (name === "write" && args && typeof args.content === "string") {
    return el("div", {}, el("div", { class: "tool-label", text: `New content for ${args.path || "the file"}` }), outputBlock(args.content, "", { all: false, redraw: () => {} }));
  }
  if (args !== undefined) return el("pre", { class: "output args" }, el("code", { text: JSON.stringify(args, null, 2) }));
  if (argsText) return el("pre", { class: "output args" }, el("code", { text: argsText }));
  return null;
}

function toolCard(block, tl, prefs) {
  const tool = tl.tools.get(block.toolCallId) || { status: "pending" };
  const name = block.name || tool.name || "tool";
  const args = block.args !== undefined ? block.args : tool.args;
  const status = tool.status || "pending";
  const rows = tool.result && tool.result.details ? parseEditDiff(tool.result.details.diff) : [];
  const stats = rows.length ? diffStats(rows) : null;
  const key = block.toolCallId || `${name}:${block.argsText}`;
  const remembered = prefs.toolOpen.get(key);
  const open = remembered !== undefined ? remembered : (prefs.expandTools || status === "error" || rows.length > 0);
  const card = el("div", { class: `tool ${status}`, dataset: { tool: name } });
  const head = el("button", { type: "button", class: "tool-head", "aria-expanded": open ? "true" : "false" },
    el("span", { class: "tool-status" }, statusIcon(status)),
    el("span", { class: "tool-name", text: name }),
    el("span", { class: "tool-summary", text: toolSummary(name, args) }),
    stats ? el("span", { class: "tool-stats" }, el("span", { class: "add", text: `+${stats.added}` }), el("span", { class: "del", text: `-${stats.removed}` })) : null,
    icon("chevron"));
  head.addEventListener("click", () => { prefs.toolOpen.set(key, !open); prefs.redrawOwner(block.toolCallId); });
  card.append(head);
  if (open) {
    const body = el("div", { class: "tool-body" });
    if (rows.length) body.append(diffView(rows));
    else {
      const view = argsView(name, args, block.argsText);
      if (view) body.append(view);
    }
    const state = prefs.outputState(key);
    // A codemode script lists the tool calls it made, each checked by coop on its own.
    const calls = name === "codemode" ? codemodeCalls(status === "running" ? tool.partialDetails : tool.result && tool.result.details) : [];
    if (calls.length) {
      body.append(el("div", { class: "tool-label", text: `Tool calls in this script (${calls.length})` }),
        el("ul", { class: "codemode-calls" }, calls.map((call) => el("li", { class: call.status },
          el("span", { class: "tool-status" }, statusIcon(call.status === "ok" ? "done" : call.status === "running" ? "running" : "error")),
          el("code", { text: call.name }),
          call.status === "ok" || call.status === "running" ? null : el("span", { class: "chip bad", text: call.status })))));
    }
    if (tool.partial && status === "running") body.append(outputBlock(tool.partial, "partial", state));
    if (tool.result && tool.result.text && !(rows.length && !tool.isError)) body.append(outputBlock(tool.result.text, tool.isError ? "error" : "", state));
    if (status !== "running" && status !== "pending") {
      const links = paneButtons(paneLinksForTool(name, args, status), prefs);
      if (links) body.append(links);
    }
    card.append(body);
  }
  return card;
}

function thinkingView(block, index, item, blocks, prefs) {
  const key = `${item.id}:${index}`;
  const remembered = prefs.thinkingOpen.get(key);
  const open = remembered !== undefined ? remembered : prefs.showThinking || (item.streaming && index === blocks.length - 1);
  const details = el("details", { class: "thinking", open },
    el("summary", { text: item.streaming && index === blocks.length - 1 ? "Thinking..." : "Thinking" }),
    el("div", { class: "thinking-text", text: block.text }));
  details.addEventListener("toggle", () => prefs.thinkingOpen.set(key, details.open));
  return details;
}

// A run of tool calls and thinking between two pieces of prose folds into one
// line: what coop did, or the step running now. Open it for the tool cards
// (Ctrl+O opens them all). A failed step keeps the line folded and marks it
// with the red cross; opening it shows the failed card already open. The
// session file keeps everything either way.
function activityView(entries, tl, prefs, { last }) {
  const key = `${entries[0].item.id}:${entries[0].index}`;
  const run = entries.map((entry) => entry.block);
  const failed = run.some((block) => block.type === "tool" && (tl.tools.get(block.toolCallId) || {}).status === "error");
  // The step running now: the model's message has ended by the time its tool
  // runs, so look at the tool, not at streaming; a thinking block is live
  // only while its message streams. Nothing runs once the agent has settled.
  const running = last && tl.busy && (() => {
    const tail = entries[entries.length - 1];
    if (tail.block.type === "thinking") return tail.item.streaming;
    const tool = tl.tools.get(tail.block.toolCallId) || { status: "pending" };
    return tool.status === "pending" || tool.status === "running";
  })();
  const remembered = prefs.activityOpen.get(key);
  const open = remembered !== undefined ? remembered : prefs.expandTools;
  const steps = run.filter((block) => block.type === "tool").length;
  const details = el("details", { class: `activity ${running ? "running" : ""} ${failed ? "failed" : ""}`, open },
    el("summary", { class: "activity-head" },
      el("span", { class: "activity-status" }, running ? el("span", { class: "spinner" }) : failed ? icon("close", "A step failed") : icon("check", "Done")),
      el("span", { class: "activity-text", text: activitySummary(run, tl.tools, { live: running }) }),
      steps ? el("span", { class: "activity-count", text: `${steps} ${steps === 1 ? "step" : "steps"}` }) : null,
      icon("chevron")),
    el("div", { class: "activity-body" }, entries.map(({ block, index, item, blocks }) => (block.type === "thinking" ? (block.text.trim() ? thinkingView(block, index, item, blocks, prefs) : null) : toolCard(block, tl, prefs)))));
  details.addEventListener("toggle", () => prefs.activityOpen.set(key, details.open));
  return details;
}

/**
 * One turn: a run of assistant messages with nothing else between them, drawn
 * as one answer. Prose stays as it is; everything between two pieces of prose,
 * across the message boundaries too, is one activity line.
 */
function assistantView(items, tl, prefs) {
  const last = items[items.length - 1];
  const streaming = items.some((item) => item.streaming);
  const node = el("article", { class: `msg assistant ${streaming ? "streaming" : ""}`, dataset: { id: items[0].id, ids: items.map((item) => item.id).join(" ") } });
  const entries = [];
  for (const item of items) {
    const blocks = item.blocks.filter(Boolean);
    blocks.forEach((block, index) => entries.push({ block, index, item, blocks }));
  }
  const groups = [];
  for (const entry of entries) {
    const { block, item } = entry;
    if (block.type === "text") { groups.push({ kind: "text", block }); continue; }
    if (block.type === "thinking" && !block.text.trim() && !item.streaming) continue;
    const tail = groups[groups.length - 1];
    if (tail && tail.kind === "activity") tail.entries.push(entry);
    else groups.push({ kind: "activity", entries: [entry] });
  }
  groups.forEach((group, g) => {
    if (group.kind === "text") { if (group.block.text) node.append(markdown(group.block.text)); return; }
    if (!prefs.activityFold) { for (const { block, index, item, blocks } of group.entries) node.append(block.type === "thinking" ? thinkingView(block, index, item, blocks, prefs) : toolCard(block, tl, prefs)); return; }
    node.append(activityView(group.entries, tl, prefs, { last: g === groups.length - 1 }));
  });
  if (last.streaming && !last.blocks.filter(Boolean).length) node.append(el("div", { class: "working", title: "Working" }, el("span", { class: "spinner" })));
  if (last.stopReason === "error" || last.errorMessage) {
    node.append(el("div", { class: "notice error" }, icon("warn"), el("span", { text: last.errorMessage || "The model stopped with an error." })));
  } else if (last.stopReason === "aborted") {
    node.append(el("div", { class: "notice muted", text: "Stopped." }));
  }
  const answer = entries.filter(({ block }) => block.type === "text").map(({ block }) => block.text).join("\n\n");
  if (!streaming && answer.trim()) {
    node.append(el("div", { class: "msg-actions" }, copyButton(answer, "Copy answer"), last.model ? el("span", { class: "msg-meta", text: last.model }) : null));
  }
  return node;
}

/** A run of consecutive assistant items (see timeline.mjs turnOf) as one node. */
export function renderTurn(items, tl, prefs) {
  return assistantView(items, tl, prefs);
}

function standardsView(item, prefs) {
  const label = item.sources.length
    ? item.sources.map((source) => `${source.domain.toUpperCase()}${source.authority ? `, ${source.authority.replace(/_/g, " ")}` : ""}${source.state && source.state !== "canonical" ? ` (${source.state})` : ""}`).join("; ")
    : item.domains.join(", ").toUpperCase();
  return el("details", { class: "standards", dataset: { id: item.id } },
    el("summary", {}, icon("shield"), el("span", { text: `Standards applied: ${label || "Cooptimize"}` })),
    paneButtons([{ pane: "standards", label: "Read them in the side pane", options: { domain: (item.sources[0] && item.sources[0].domain) || item.domains[0] || "" } }], prefs),
    el("pre", { class: "output standards-text" }, el("code", { text: item.content })));
}

/** One timeline item as DOM. */
export function renderItem(item, tl, prefs) {
  switch (item.kind) {
    case "user":
      // Typed prompts keep their line breaks; a prompt with a code fence (or a
      // report an extension sent as a user message) renders as Markdown.
      // The files a message attached show as chips under it; the note that
      // names them for coop stays in the session text.
      const { text, files } = splitAttachmentNote(item.text || "");
      return el("article", { class: "msg user", dataset: { id: item.id } },
        /^\s*```/m.test(text) ? el("div", { class: "bubble rich" }, markdown(text)) : el("div", { class: "bubble", text: text || (item.images || files.length ? "" : " ") }),
        files.length ? el("div", { class: "msg-files" }, files.map((file) => el("span", { class: "msg-file", title: file.ref }, icon("file"), el("span", { class: "msg-file-name", text: file.name }), file.detail ? el("span", { class: "msg-file-detail", text: file.detail }) : null))) : null,
        item.images ? el("div", { class: "msg-meta", text: item.images === 1 ? "1 image" : `${item.images} images` }) : null);
    case "assistant":
      return assistantView([item], tl, prefs);
    case "standards":
      return standardsView(item, prefs);
    case "custom":
      return el("article", { class: "msg custom", dataset: { id: item.id } }, el("div", { class: "custom-type", text: item.customType }), markdown(item.text));
    case "bash": {
      const state = prefs.outputState(item.id);
      return el("article", { class: `shell ${item.running ? "running" : ""}`, dataset: { id: item.id } },
        el("div", { class: "shell-head" },
          item.running ? el("span", { class: "spinner" }) : null,
          el("code", { text: `$ ${item.command}` }),
          item.excluded ? el("span", { class: "chip", text: "kept out of the model's context" }) : null,
          item.exitCode !== undefined && item.exitCode !== null && !item.running ? el("span", { class: `chip ${item.exitCode === 0 ? "ok" : "bad"}`, text: `exit ${item.exitCode}` }) : null,
          item.cancelled ? el("span", { class: "chip bad", text: "stopped" }) : null),
        item.output ? outputBlock(item.output, "", state) : null,
        item.truncated && item.fullOutputPath ? el("div", { class: "msg-meta", text: `Full output: ${item.fullOutputPath}` }) : null);
    }
    case "compaction":
      return el("details", { class: "divider", dataset: { id: item.id } },
        el("summary", { text: `Conversation compacted${item.tokensBefore ? ` (was about ${formatTokens(item.tokensBefore)} tokens)` : ""}` }),
        markdown(item.summary));
    case "branch":
      return el("details", { class: "divider", dataset: { id: item.id } }, el("summary", { text: "Summary of the other branch" }), markdown(item.summary));
    case "notice":
      if (item.markdown) return el("div", { class: `notice report ${item.level}`, dataset: { id: item.id } }, markdown(item.text), paneButtons(paneLinksForText(item.text), prefs));
      return el("div", { class: `notice ${item.level}`, dataset: { id: item.id } }, item.level === "error" || item.level === "warning" ? icon("warn") : null, el("span", { text: item.text }), paneButtons(paneLinksForText(item.text), prefs));
    default:
      return el("div");
  }
}
