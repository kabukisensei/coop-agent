// A small Markdown reader for model answers. parseMarkdown() is pure (the
// tests run it in Node); renderMarkdown() builds DOM nodes with textContent
// only, so nothing a model writes is ever parsed as HTML. Remote images are
// shown as links: the window never loads anything from the network.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") { cell += "|"; i += 1; continue; }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function isBlockStart(line, next) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line)
    || (line.includes("|") && next !== undefined && TABLE_SEP.test(next));
}

/** Parse Markdown into a small block tree. */
export function parseMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines, depth) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (or end of a still-streaming answer)
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2] || "") });
      i += 1;
      continue;
    }
    if (HR.test(line)) { blocks.push({ type: "hr" }); i += 1; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && !isBlockStart(lines[i], lines[i + 1]) && body.length))) {
        const m = QUOTE.exec(lines[i]);
        body.push(m ? m[1] : lines[i]);
        i += 1;
      }
      blocks.push({ type: "blockquote", children: depth < 8 ? parseBlocks(body, depth + 1) : [{ type: "paragraph", children: [{ type: "text", text: body.join("\n") }] }] });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(splitRow(lines[i])); i += 1; }
      blocks.push({
        type: "table",
        align: header.map((_, c) => align[c] || ""),
        header: header.map(parseInline),
        rows: rows.map((row) => header.map((_, c) => parseInline(row[c] || ""))),
      });
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const [block, used] = parseList(lines, i, depth);
      blocks.push(block);
      i = used;
      continue;
    }
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) { para.push(lines[i]); i += 1; }
    blocks.push({ type: "paragraph", children: parseInline(para.map((l, n) => (n < para.length - 1 && / {2,}$/.test(l) ? `${l.trimEnd()}\u0000br` : l.trim())).join("\n")) });
  }
  return blocks;
}

function parseList(lines, start, depth) {
  const first = LIST.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const block = { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i += 1;
    // Continuation lines: indented further than the marker, or a lazy line.
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        const next = lines[i + 1];
        if (next !== undefined && next.trim() && leading(next) > indent) { body.push(""); i += 1; continue; }
        break;
      }
      const sub = LIST.exec(line);
      if (sub && sub[1].length <= indent) break;
      if (!sub && leading(line) <= indent && isBlockStart(line, lines[i + 1])) break;
      body.push(line.slice(Math.min(leading(line), indent + 2)));
      i += 1;
    }
    let text = body.join("\n");
    let checked = null;
    const task = /^\[([ xX])\][ \t]+/.exec(text);
    if (task) { checked = task[1] !== " "; text = text.slice(task[0].length); }
    const children = depth < 8 ? parseBlocks(text.split("\n"), depth + 1) : [{ type: "paragraph", children: [{ type: "text", text }] }];
    block.items.push({ checked, children });
  }
  return [block, i];
}

function leading(line) {
  return line.length - line.replace(/^ +/, "").length;
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Parse inline Markdown: code, emphasis, strike, links and line breaks. */
export function parseInline(source) {
  const text = String(source || "");
  const out = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\u0000" && text.startsWith("\u0000br", i)) { flush(); out.push({ type: "br" }); i += 3; continue; }
    if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) { buffer += text[i + 1]; i += 2; continue; }
    if (ch === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks += 1;
      const fence = "`".repeat(ticks);
      const end = text.indexOf(fence, i + ticks);
      if (end > 0) {
        flush();
        let code = text.slice(i + ticks, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push({ type: "code", text: code });
        i = end + ticks;
        continue;
      }
      buffer += fence; i += ticks; continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      const link = readLink(text, i + 1);
      if (link) { flush(); out.push({ type: "link", href: link.href, children: [{ type: "text", text: link.label || link.href }] }); i = link.end; continue; }
    }
    if (ch === "[") {
      const link = readLink(text, i);
      if (link) { flush(); out.push({ type: "link", href: link.href, children: parseInline(link.label) }); i = link.end; continue; }
    }
    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) { flush(); out.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1] }] }); i += auto[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(text.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const bare = /^https?:\/\/[^\s<>)\]]+/i.exec(text.slice(i));
      if (bare) {
        const href = bare[0].replace(/[.,;:!?'"]+$/, "");
        flush(); out.push({ type: "link", href, children: [{ type: "text", text: href }] }); i += href.length; continue;
      }
    }
    if ((ch === "*" || ch === "_" || ch === "~") && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2 && !/\s/.test(text[i + 2]) && !/\s/.test(text[end - 1])) {
        flush();
        out.push({ type: ch === "~" ? "del" : "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] && !/\s/.test(text[i + 1])) {
      // _ inside a word (snake_case) is not emphasis.
      if (!(ch === "_" && i > 0 && /\w/.test(text[i - 1]))) {
        let end = i + 1;
        while ((end = text.indexOf(ch, end)) > 0) {
          if (!/\s/.test(text[end - 1]) && text[end + 1] !== ch && !(ch === "_" && /\w/.test(text[end + 1] || ""))) break;
          end += 1;
        }
        if (end > i + 1) {
          flush();
          out.push({ type: "em", children: parseInline(text.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

function readLink(text, open) {
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "\\") { i += 1; continue; }
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  if (close < 0 || text[close + 1] !== "(") return null;
  const end = text.indexOf(")", close + 2);
  if (end < 0) return null;
  const href = text.slice(close + 2, end).trim().split(/\s+/)[0].replace(/^<|>$/g, "");
  return { label: text.slice(open + 1, close), href, end: end + 1 };
}

/** True for links the window can offer to open in the browser. */
export function isSafeLink(href) {
  return typeof href === "string" && SAFE_LINK.test(href);
}

// --- DOM ----------------------------------------------------------------------

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInline(doc, nodes, parent, opts = {}) {
  for (const node of nodes) {
    switch (node.type) {
      case "text": parent.append(doc.createTextNode(node.text)); break;
      case "br": parent.append(doc.createElement("br")); break;
      case "code": parent.append(el(doc, "code", "", node.text)); break;
      case "strong": case "em": case "del": {
        const child = doc.createElement(node.type);
        renderInline(doc, node.children, child, opts);
        parent.append(child);
        break;
      }
      case "link": {
        if (isSafeLink(node.href)) {
          const a = el(doc, "a", "md-link");
          a.setAttribute("href", node.href);
          a.dataset.href = node.href;
          a.title = node.href;
          renderInline(doc, node.children, a, opts);
          parent.append(a);
        } else if (opts.localLink && opts.localLink(node.href)) {
          // A page the view itself can open (the docs pane's own Markdown).
          const a = el(doc, "a", "md-local");
          a.dataset.local = node.href;
          a.tabIndex = 0;
          a.title = node.href;
          renderInline(doc, node.children, a, opts);
          parent.append(a);
        } else {
          // Relative links and file paths: show the text, never navigate.
          const span = el(doc, "span", "md-link-text");
          renderInline(doc, node.children, span, opts);
          parent.append(span);
        }
        break;
      }
      default: break;
    }
  }
}

/**
 * Build DOM for parsed blocks. codeBlock(doc, lang, text) may return a custom
 * node for fenced code (the app adds copy buttons there).
 */
export function renderBlocks(doc, blocks, parent, opts = {}) {
  const { codeBlock } = opts;
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": { const p = doc.createElement("p"); renderInline(doc, block.children, p, opts); parent.append(p); break; }
      case "heading": { const h = doc.createElement(`h${Math.min(6, block.level + 1)}`); renderInline(doc, block.children, h, opts); parent.append(h); break; }
      case "hr": parent.append(doc.createElement("hr")); break;
      case "code": {
        if (codeBlock) { parent.append(codeBlock(doc, block.lang, block.text)); break; }
        const pre = doc.createElement("pre");
        pre.append(el(doc, "code", "", block.text));
        parent.append(pre);
        break;
      }
      case "blockquote": { const q = doc.createElement("blockquote"); renderBlocks(doc, block.children, q, opts); parent.append(q); break; }
      case "list": {
        const list = doc.createElement(block.ordered ? "ol" : "ul");
        if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
        for (const item of block.items) {
          const li = doc.createElement("li");
          if (item.checked !== null) { li.className = "task"; li.append(el(doc, "span", "task-box", item.checked ? "[x]" : "[ ]")); }
          // Tight lists: a single paragraph renders inline.
          if (item.children.length === 1 && item.children[0].type === "paragraph") renderInline(doc, item.children[0].children, li, opts);
          else renderBlocks(doc, item.children, li, opts);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case "table": {
        const wrap = el(doc, "div", "md-table");
        const table = doc.createElement("table");
        const thead = doc.createElement("thead");
        const tr = doc.createElement("tr");
        block.header.forEach((cell, c) => { const th = doc.createElement("th"); if (block.align[c]) th.dataset.align = block.align[c]; renderInline(doc, cell, th, opts); tr.append(th); });
        thead.append(tr);
        const tbody = doc.createElement("tbody");
        for (const row of block.rows) {
          const r = doc.createElement("tr");
          row.forEach((cell, c) => { const td = doc.createElement("td"); if (block.align[c]) td.dataset.align = block.align[c]; renderInline(doc, cell, td, opts); r.append(td); });
          tbody.append(r);
        }
        table.append(thead, tbody);
        wrap.append(table);
        parent.append(wrap);
        break;
      }
      default: break;
    }
  }
  return parent;
}

export function renderMarkdown(doc, source, parent, options) {
  return renderBlocks(doc, parseMarkdown(source), parent, options);
}
