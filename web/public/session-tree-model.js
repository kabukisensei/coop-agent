// UI-neutral projection of Pi's SessionTreeNode[] contract. Kept dependency-free
// and attached to globalThis so the existing no-build SPA and Node tests consume
// the exact same tree/leaf/forkability logic.
(function installSessionTreeModel(root) {
  "use strict";

  function entryText(entry) {
    if (!entry || typeof entry !== "object") return "Unknown session entry";
    if (entry.type === "message" && entry.message) {
      const role = entry.message.role || "message";
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      const text = content.filter((part) => part && part.type === "text").map((part) => part.text || "").join(" ").trim();
      const images = content.filter((part) => part && part.type === "image").length;
      const summary = text || (images ? `${images} image${images === 1 ? "" : "s"}` : "(no text)");
      return `${role}: ${summary}`;
    }
    if (entry.type === "compaction") return `compaction: ${entry.summary || "context summary"}`;
    if (entry.type === "branch_summary") return `branch summary: ${entry.summary || "summary"}`;
    if (entry.type === "model_change") return `model: ${entry.provider || ""}/${entry.modelId || ""}`;
    if (entry.type === "thinking_level_change") return `thinking: ${entry.thinkingLevel || "unknown"}`;
    return String(entry.type || "entry").replaceAll("_", " ");
  }

  function buildRows(nodes, { leafId = null, forkMessages = [], maxRows = 1000 } = {}) {
    const rows = [];
    const seen = new Set();
    const forkable = new Set(forkMessages.map((item) => item && item.entryId).filter((id) => typeof id === "string"));
    function visit(children, depth) {
      if (!Array.isArray(children) || depth > 100 || rows.length >= maxRows) return;
      for (const node of children) {
        const entry = node && node.entry;
        if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
        seen.add(entry.id);
        rows.push({
          node,
          entry,
          depth,
          summary: entryText(entry),
          isCurrent: entry.id === leafId,
          forkable: forkable.has(entry.id),
        });
        visit(node.children, depth + 1);
        if (rows.length >= maxRows) break;
      }
    }
    visit(nodes, 0);
    return rows;
  }

  root.CoopSessionTree = Object.freeze({ buildRows, entryText });
})(globalThis);
