// Draws one timeline item. Called again for an item whenever Pi changes it.
import { el, icon } from "./ui.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { parseEditDiff, diffStats } from "./diff.mjs";
import { toolSummary, formatTokens } from "./timeline.mjs";

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

function statusIcon(status) {
  if (status === "running" || status === "pending") return el("span", { class: "spinner", "aria-label": "Running" });
  if (status === "error") return icon("close", "Failed");
  return icon("check", "Done");
}

function argsView(name, args, argsText) {
  if (name === "bash" && args && typeof args.command === "string") return el("pre", { class: "output command" }, el("code", { text: `$ ${args.command}` }));
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
    if (tool.partial && status === "running") body.append(outputBlock(tool.partial, "partial", state));
    if (tool.result && tool.result.text && !(rows.length && !tool.isError)) body.append(outputBlock(tool.result.text, tool.isError ? "error" : "", state));
    card.append(body);
  }
  return card;
}

function assistantView(item, tl, prefs) {
  const node = el("article", { class: `msg assistant ${item.streaming ? "streaming" : ""}`, dataset: { id: item.id } });
  const blocks = item.blocks.filter(Boolean);
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      if (!block.text.trim()) return;
      const key = `${item.id}:${index}`;
      const remembered = prefs.thinkingOpen.get(key);
      const open = remembered !== undefined ? remembered : prefs.showThinking || (item.streaming && index === blocks.length - 1);
      const details = el("details", { class: "thinking", open },
        el("summary", { text: item.streaming && index === blocks.length - 1 ? "Thinking..." : "Thinking" }),
        el("div", { class: "thinking-text", text: block.text }));
      details.addEventListener("toggle", () => prefs.thinkingOpen.set(key, details.open));
      node.append(details);
    } else if (block.type === "text") {
      if (block.text) node.append(markdown(block.text));
    } else if (block.type === "tool") {
      node.append(toolCard(block, tl, prefs));
    }
  });
  if (item.streaming && !blocks.length) node.append(el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Working" })));
  if (item.stopReason === "error" || item.errorMessage) {
    node.append(el("div", { class: "notice error" }, icon("warn"), el("span", { text: item.errorMessage || "The model stopped with an error." })));
  } else if (item.stopReason === "aborted") {
    node.append(el("div", { class: "notice muted", text: "Stopped." }));
  }
  const answer = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
  if (!item.streaming && answer.trim()) {
    node.append(el("div", { class: "msg-actions" }, copyButton(answer, "Copy answer"), item.model ? el("span", { class: "msg-meta", text: item.model }) : null));
  }
  return node;
}

function standardsView(item) {
  const label = item.sources.length
    ? item.sources.map((source) => `${source.domain.toUpperCase()}${source.authority ? `, ${source.authority.replace(/_/g, " ")}` : ""}${source.state && source.state !== "canonical" ? ` (${source.state})` : ""}`).join("; ")
    : item.domains.join(", ").toUpperCase();
  return el("details", { class: "standards", dataset: { id: item.id } },
    el("summary", {}, icon("shield"), el("span", { text: `Standards applied: ${label || "Cooptimize"}` })),
    el("pre", { class: "output standards-text" }, el("code", { text: item.content })));
}

/** One timeline item as DOM. */
export function renderItem(item, tl, prefs) {
  switch (item.kind) {
    case "user":
      // Typed prompts keep their line breaks; a prompt with a code fence (or a
      // report an extension sent as a user message) renders as Markdown.
      return el("article", { class: "msg user", dataset: { id: item.id } },
        /^\s*```/m.test(item.text || "") ? el("div", { class: "bubble rich" }, markdown(item.text)) : el("div", { class: "bubble", text: item.text || (item.images ? "" : " ") }),
        item.images ? el("div", { class: "msg-meta", text: item.images === 1 ? "1 image" : `${item.images} images` }) : null);
    case "assistant":
      return assistantView(item, tl, prefs);
    case "standards":
      return standardsView(item);
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
      if (item.markdown) return el("div", { class: `notice report ${item.level}`, dataset: { id: item.id } }, markdown(item.text));
      return el("div", { class: `notice ${item.level}`, dataset: { id: item.id } }, item.level === "error" || item.level === "warning" ? icon("warn") : null, el("span", { text: item.text }));
    default:
      return el("div");
  }
}
