// coop web — the Files panel: a read-only browser for the working folder, next to
// the chat. It LISTS files (/files) and PREVIEWS them (/file) — markdown, code
// (line-numbered), and tabular data (csv/tsv/json/jsonl) as a sortable table.
// It never writes. Everything the panel receives is escaped before it touches the
// DOM (same escape-first rule as the chat), and the server jails every path to
// the working folder, so a symlink or ../ can't read outside it.
//
// It exposes window.coopFiles for app.js to call: attachTarget() (the file to
// wrap the next prompt with, or "") and onAgentEnd() (refresh after a turn, since
// the agent may have written files). No inline styles/scripts — CSP-clean.
"use strict";
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Route reads to the ACTIVE chat's working folder. Guard on a non-empty string so we
  // never interpolate an unset value into the literal "undefined" (which the bridge
  // would 400); before the first __hello the un-sid'd request works via single-chat.
  const withSid = (url) => (typeof window.coopSid === "string" && window.coopSid)
    ? url + (url.includes("?") ? "&" : "?") + "sid=" + encodeURIComponent(window.coopSid) : url;

  const panel = $("#files"), treeEl = $("#fileTree"), previewEl = $("#preview");
  const previewHead = $("#previewHead"), previewName = $("#previewName"), attachChk = $("#attachChk");
  const filesBtn = $("#filesBtn");

  let open = false;
  let selectedPath = ""; // relative path of the previewed file, or ""
  let loadedTree = false;
  let expanded = new Set(); // dir rel-paths the user has opened

  // markdown rendering is owned by app.js; reuse it when present, else escape.
  const renderMd = (src) => (window.renderMarkdown ? window.renderMarkdown(src) : `<pre>${esc(src)}</pre>`);

  function toggle() {
    open = !open;
    panel.hidden = !open;
    filesBtn.classList.toggle("on", open);
    if (open && !loadedTree) loadTree();
  }

  async function loadTree() {
    // Preserve scroll across a refresh (the tree re-fetches every turn, since the
    // agent may have written files) so a mid-tree position doesn't jump to the top.
    const prevScroll = treeEl.scrollTop;
    try {
      const r = await fetch(withSid("/files"));
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      loadedTree = true;
      renderTree(data.tree || [], data.clipped);
      treeEl.scrollTop = prevScroll;
    } catch {
      treeEl.textContent = "";
      const p = document.createElement("div");
      p.className = "files-empty";
      p.textContent = "Couldn't list files in this folder.";
      treeEl.appendChild(p);
    }
  }

  function renderTree(tree, clipped) {
    treeEl.textContent = "";
    if (!tree.length) {
      const p = document.createElement("div");
      p.className = "files-empty";
      p.textContent = "This folder is empty (or only hidden files).";
      treeEl.appendChild(p);
      return;
    }
    for (const node of tree) treeEl.appendChild(nodeEl(node, 0));
    if (clipped) {
      const p = document.createElement("div");
      p.className = "files-empty";
      p.textContent = "⚠ Large folder — some files are not shown.";
      treeEl.appendChild(p);
    }
  }

  function nodeEl(node, depth) {
    if (node.type === "dir") {
      const wrap = document.createElement("div");
      const row = document.createElement("div");
      row.className = "fnode dir";
      row.style.paddingLeft = 8 + depth * 14 + "px";
      const isOpen = expanded.has(node.path);
      row.textContent = (isOpen ? "▾ " : "▸ ") + node.name;
      const kids = document.createElement("div");
      kids.hidden = !isOpen;
      if (isOpen && node.children) for (const c of node.children) kids.appendChild(nodeEl(c, depth + 1));
      row.onclick = () => {
        const nowOpen = kids.hidden;
        kids.hidden = !nowOpen;
        row.textContent = (nowOpen ? "▾ " : "▸ ") + node.name;
        if (nowOpen) {
          expanded.add(node.path);
          if (!kids.childElementCount && node.children) for (const c of node.children) kids.appendChild(nodeEl(c, depth + 1));
        } else {
          expanded.delete(node.path);
        }
      };
      wrap.append(row, kids);
      return wrap;
    }
    const row = document.createElement("div");
    row.className = "fnode file" + (node.path === selectedPath ? " active" : "");
    row.style.paddingLeft = 8 + depth * 14 + 14 + "px";
    row.textContent = node.name;
    row.dataset.path = node.path;
    row.onclick = () => openFile(node.path, row);
    return row;
  }

  async function openFile(rel, row) {
    selectedPath = rel;
    for (const el of treeEl.querySelectorAll(".fnode.file.active")) el.classList.remove("active");
    if (row) row.classList.add("active");
    previewHead.hidden = false;
    previewName.textContent = rel.split("/").pop();
    previewName.title = rel;
    previewEl.hidden = false;
    previewEl.textContent = "Loading…";
    try {
      const r = await fetch(withSid("/file?p=" + encodeURIComponent(rel)));
      const data = await r.json();
      if (!r.ok || !data.ok) { previewEl.textContent = (data && data.error) || "Can't preview this file."; return; }
      renderPreview(data);
    } catch {
      previewEl.textContent = "Couldn't read that file.";
    }
  }

  function renderPreview(data) {
    previewEl.textContent = "";
    if (data.kind === "binary") {
      const p = document.createElement("div");
      p.className = "files-empty";
      p.textContent = "Binary file — no preview.";
      previewEl.appendChild(p);
      return;
    }
    if (data.kind === "markdown") {
      const md = document.createElement("div");
      md.className = "bubble"; // reuse the chat's markdown styling
      md.innerHTML = renderMd(data.content);
      previewEl.appendChild(md);
    } else if (data.kind === "sheet") {
      previewEl.appendChild(tableFromDelimited(data.content, data.ext === ".tsv" ? "\t" : ","));
    } else if (data.kind === "data") {
      previewEl.appendChild(tableFromData(data));
    } else {
      previewEl.appendChild(codeBlock(data.content));
    }
    if (data.truncated) {
      const p = document.createElement("div");
      p.className = "files-empty";
      p.textContent = "⚠ File truncated for preview.";
      previewEl.appendChild(p);
    }
  }

  // Line-numbered code (escape-first; no highlighting — keeps us dependency-free).
  function codeBlock(text) {
    const pre = document.createElement("pre");
    pre.className = "code-preview";
    const lines = String(text).split("\n");
    const gutter = String(lines.length).length;
    pre.textContent = lines.map((l, i) => String(i + 1).padStart(gutter, " ") + "  " + l).join("\n");
    return pre;
  }

  // --- tabular preview (sortable) -------------------------------------------------
  // Numbers sort numerically, text case-insensitively, blanks last — the same
  // natural order the Hephaestus spreadsheet view uses.
  function naturalCompare(a, b, dir) {
    if (a === "" && b === "") return 0;
    if (a === "") return 1;
    if (b === "") return -1;
    const na = Number(a), nb = Number(b);
    const bothNum = a !== "" && b !== "" && !isNaN(na) && !isNaN(nb);
    const cmp = bothNum ? na - nb : a.localeCompare(b, undefined, { sensitivity: "base" });
    return dir === "asc" ? cmp : -cmp;
  }

  const MAX_ROWS = 1000, MAX_COLS = 60;

  // Minimal RFC-4180-ish CSV/TSV parse: quoted fields, doubled "" escapes, and
  // newlines inside quotes. Good enough for a preview; not a full CSV engine.
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = "", inQ = false;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; if (rows.length > MAX_ROWS + 1) break; }
      else if (c === "\r") { /* swallow CR */ }
      else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function tableFromDelimited(text, delim) {
    const rows = parseDelimited(text, delim);
    if (!rows.length) return emptyNote("Empty file.");
    const header = rows[0].slice(0, MAX_COLS);
    const body = rows.slice(1, MAX_ROWS + 1).map((r) => r.slice(0, MAX_COLS));
    return sortableTable(header, body);
  }

  function tableFromData(data) {
    // .json (array of objects) or .jsonl/.ndjson (one object per line) -> table.
    const text = String(data.content);
    let objects = [];
    if (data.ext === ".json") {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) objects = parsed.filter((o) => o && typeof o === "object" && !Array.isArray(o));
      } catch { return codeBlock(text); } // not array-of-objects JSON — show raw
      if (!objects.length) return codeBlock(text);
    } else {
      for (const line of text.split("\n")) {
        if (!line.trim() || objects.length >= MAX_ROWS) continue;
        try { const o = JSON.parse(line); if (o && typeof o === "object" && !Array.isArray(o)) objects.push(o); } catch { /* skip */ }
      }
      if (!objects.length) return codeBlock(text);
    }
    const cols = [];
    const seen = new Set();
    for (const o of objects) for (const k of Object.keys(o)) if (!seen.has(k) && cols.length < MAX_COLS) { seen.add(k); cols.push(k); }
    const cell = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    const body = objects.slice(0, MAX_ROWS).map((o) => cols.map((k) => cell(o[k])));
    return sortableTable(cols, body);
  }

  function sortableTable(header, body) {
    const wrap = document.createElement("div");
    wrap.className = "sheet-scroll";
    const table = document.createElement("table");
    table.className = "sheet-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    let sortCol = -1, sortDir = null;
    header.forEach((h, c) => {
      const th = document.createElement("th");
      th.textContent = h;
      th.className = "sortable";
      th.onclick = () => {
        if (sortCol !== c) { sortCol = c; sortDir = "asc"; }
        else if (sortDir === "asc") sortDir = "desc";
        else { sortCol = -1; sortDir = null; }
        paint();
        for (const x of htr.children) x.classList.remove("asc", "desc");
        if (sortDir) th.classList.add(sortDir);
      };
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    const tbody = document.createElement("tbody");
    const paint = () => {
      const rows = sortDir && sortCol >= 0
        ? [...body].sort((a, b) => naturalCompare(a[sortCol] || "", b[sortCol] || "", sortDir))
        : body;
      tbody.textContent = "";
      for (const r of rows) {
        const tr = document.createElement("tr");
        for (let c = 0; c < header.length; c++) {
          const td = document.createElement("td");
          td.textContent = r[c] != null ? r[c] : "";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    };
    paint();
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function emptyNote(msg) {
    const p = document.createElement("div");
    p.className = "files-empty";
    p.textContent = msg;
    return p;
  }

  // --- public surface for app.js --------------------------------------------------
  window.coopFiles = {
    // The absolute-ish path to wrap the next prompt with, or "" when nothing is
    // eligible (panel closed, no selection, or attach unchecked). app.js turns a
    // non-empty value into a viewing-context block + 📎 chip.
    attachTarget() {
      if (!open || !selectedPath || !attachChk.checked) return "";
      const base = (window.coopCwd || "").replace(/[/\\]+$/, "");
      return base ? base + "/" + selectedPath : selectedPath;
    },
    // Called after agent_end / folder change: the tree may be stale (files written)
    // and the previewed file may have changed. Refresh both if the panel is open.
    onAgentEnd() {
      if (!open) { loadedTree = false; return; } // reload lazily next time it opens
      loadTree();
      if (selectedPath) {
        const row = treeEl.querySelector(`.fnode.file[data-path="${cssEscape(selectedPath)}"]`);
        openFile(selectedPath, row);
      }
    },
  };

  // Attribute-selector-safe escaping for the data-path lookup above.
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  filesBtn.onclick = toggle;
  $("#filesClose").onclick = toggle;
  $("#filesRefresh").onclick = loadTree;
})();
