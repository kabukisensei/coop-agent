// The text of Word, Excel and PowerPoint files as Markdown, read straight
// from the XML inside them (zip.mjs, xml.mjs). Only what coop needs to read
// the document: words, headings, lists and tables, sheet by sheet and slide
// by slide. Styling, images, charts and macros are left out.
import { readZip, ZipError } from "./zip.mjs";
import { walk } from "./xml.mjs";

export const OFFICE_KINDS = Object.freeze({ ".docx": "Word", ".xlsx": "Excel", ".pptx": "PowerPoint" });
export const SHEET_ROWS = 5000;
export const SHEET_COLUMNS = 64;

export class OfficeError extends Error {}

function cell(text) {
  return String(text).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** Rows (arrays of strings) as a Markdown table; the first row is the header. */
export function markdownTable(rows) {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => { const out = row.map(cell); while (out.length < width) out.push(""); return out; };
  const lines = [`| ${pad(rows[0]).join(" | ")} |`, `|${" --- |".repeat(width)}`];
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(" | ")} |`);
  return lines.join("\n");
}

function relationships(xml) {
  const map = new Map();
  walk(xml, { open(name, attrs) { if (name === "Relationship") { const a = attrs(); if (a.Id && a.Target) map.set(a.Id, { target: a.Target, type: a.Type || "" }); } } });
  return map;
}

/** An OPC part path from a relationship target, relative to the part that holds the .rels. */
export function partPath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

function relId(a) {
  return a["r:id"] || Object.entries(a).find(([key]) => /:id$/i.test(key))?.[1] || "";
}

function appCounts(zip) {
  const xml = zip.text("docProps/app.xml");
  const counts = {};
  if (!xml) return counts;
  let field = "";
  walk(xml, {
    open(name) { field = name; },
    close() { field = ""; },
    text(text) { if (["Pages", "Words", "Slides", "Paragraphs"].includes(field)) counts[field] = Number(text) || 0; },
  });
  return counts;
}

// --- Word -------------------------------------------------------------------

export function wordText(zip) {
  const xml = zip.text("word/document.xml");
  if (xml === null) throw new OfficeError("not a Word document");
  const out = [];
  let para = null;
  let inText = false;
  let tableDepth = 0;
  let rows = [];
  let row = null;
  let cellLines = null;
  let paragraphs = 0;
  const emit = (line) => {
    if (cellLines) { if (line) cellLines.push(line); return; }
    if (!line && out[out.length - 1] === "") return;
    out.push(line);
  };
  const lineOf = (p) => {
    const text = p.text.replace(/[ \t]+$/gm, "").trim();
    if (!text) return "";
    paragraphs++;
    if (cellLines) return text;
    const heading = /^Heading(\d)$/.exec(p.style);
    if (heading) return `${"#".repeat(Math.min(6, Number(heading[1])))} ${text}`;
    if (p.style === "Title") return `# ${text}`;
    if (p.list) return `- ${text}`;
    return text;
  };
  walk(xml, {
    open(name, attrs) {
      switch (name) {
        case "w:p": para = { style: "", list: false, text: "" }; break;
        case "w:pStyle": if (para) para.style = attrs()["w:val"] || ""; break;
        case "w:numPr": if (para) para.list = true; break;
        case "w:t": inText = true; break;
        case "w:tab": if (para) para.text += "\t"; break;
        case "w:br": case "w:cr": if (para) para.text += "\n"; break;
        case "w:drawing": case "w:pict": if (para) para.text += "[image]"; break;
        case "w:tbl": tableDepth++; if (tableDepth === 1) rows = []; break;
        case "w:tr": if (tableDepth === 1) row = []; break;
        case "w:tc": if (tableDepth === 1) cellLines = []; break;
        default: break;
      }
    },
    close(name) {
      switch (name) {
        case "w:t": inText = false; break;
        case "w:p": if (para) { emit(lineOf(para)); para = null; } break;
        case "w:tc": if (tableDepth === 1 && row && cellLines) { row.push(cellLines.join(" ")); cellLines = null; } break;
        case "w:tr": if (tableDepth === 1 && row) { rows.push(row); row = null; } break;
        case "w:tbl":
          if (tableDepth === 1) { out.push(markdownTable(rows), ""); rows = []; }
          tableDepth = Math.max(0, tableDepth - 1);
          break;
        default: break;
      }
    },
    text(text) { if (inText && para) para.text += text; },
  });
  const counts = appCounts(zip);
  const detail = counts.Pages ? `${counts.Pages} page${counts.Pages === 1 ? "" : "s"}` : `${paragraphs} paragraph${paragraphs === 1 ? "" : "s"}`;
  return { text: out.join("\n").trim(), detail };
}

// --- Excel ------------------------------------------------------------------

const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function sharedStrings(xml) {
  const strings = [];
  let current = null;
  let depth = 0;
  let skip = 0;
  walk(xml, {
    open(name) {
      if (name === "si") { current = ""; depth = 0; }
      else if (current !== null) { depth++; if (name === "rPh") skip = depth; }
    },
    close(name) {
      if (name === "si") { strings.push(current); current = null; }
      else if (current !== null) { if (skip === depth) skip = 0; depth--; }
    },
    text(text) { if (current !== null && !skip) current += text; },
  });
  return strings;
}

/** The cellXfs indexes whose number format is a date or a time. */
export function dateStyles(xml) {
  const custom = new Set();
  const styles = new Set();
  let inXfs = false;
  let index = 0;
  walk(xml, {
    open(name, attrs) {
      if (name === "numFmt") {
        const a = attrs();
        const code = String(a.formatCode || "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
        if (/[dmyhs]/i.test(code) && !/general/i.test(code)) custom.add(Number(a.numFmtId));
      } else if (name === "cellXfs") { inXfs = true; index = 0; }
      else if (name === "xf" && inXfs) {
        const id = Number(attrs().numFmtId || 0);
        if (DATE_FORMATS.has(id) || custom.has(id)) styles.add(index);
        index++;
      }
    },
    close(name) { if (name === "cellXfs") inXfs = false; },
  });
  return styles;
}

/** An Excel serial date as ISO text (1900 date system); a time of day when under one. */
export function excelDate(serial) {
  if (!Number.isFinite(serial)) return String(serial);
  const ms = Math.round((serial - 25569) * 86400000);
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (serial < 1) return time;
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return Number.isInteger(serial) ? day : `${day} ${time}`;
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml, strings, dates, { rows: maxRows, columns: maxColumns }) {
  const rows = [];
  let row = null;
  let col = null;
  let value = "";
  let field = "";
  let inlineDepth = 0;
  let truncated = false;
  let wide = false;
  walk(xml, {
    open(name, attrs) {
      if (name === "row") { row = rows.length < maxRows ? [] : null; if (!row) truncated = true; }
      else if (name === "c" && row) { const a = attrs(); col = { index: columnIndex(a.r || ""), type: a.t || "n", style: Number(a.s || 0) }; value = ""; }
      else if (col && (name === "v" || name === "t")) field = name;
      else if (col && name === "is") inlineDepth = 1;
    },
    close(name) {
      if (name === "v" || name === "t") field = "";
      else if (name === "is") inlineDepth = 0;
      else if (name === "c" && col && row) {
        let text = value;
        if (col.type === "s") text = strings[Number(value)] ?? "";
        else if (col.type === "b") text = value === "1" ? "TRUE" : "FALSE";
        else if (col.type === "n" && value !== "" && dates.has(col.style)) text = excelDate(Number(value));
        if (col.index >= 0 && col.index < maxColumns) { while (row.length < col.index) row.push(""); row[col.index] = text; }
        else if (col.index >= maxColumns && text !== "") wide = true;
        col = null;
      } else if (name === "row" && row) {
        if (row.some((text) => text !== "")) rows.push(row);
        row = null;
      }
    },
    text(text) { if (col && (field === "v" || (field === "t" && inlineDepth))) value += text; },
  });
  return { rows, truncated, wide };
}

export function excelText(zip, limits = { rows: SHEET_ROWS, columns: SHEET_COLUMNS }) {
  const workbook = zip.text("xl/workbook.xml");
  if (workbook === null) throw new OfficeError("not an Excel workbook");
  const rels = relationships(zip.text("xl/_rels/workbook.xml.rels") || "");
  const sheets = [];
  walk(workbook, { open(name, attrs) { if (name === "sheet") { const a = attrs(); sheets.push({ name: a.name || `Sheet${sheets.length + 1}`, rel: relId(a), hidden: a.state === "hidden" || a.state === "veryHidden" }); } } });
  const strings = sharedStrings(zip.text("xl/sharedStrings.xml") || "");
  const dates = dateStyles(zip.text("xl/styles.xml") || "");
  const out = [];
  for (const sheet of sheets) {
    const rel = rels.get(sheet.rel);
    const xml = rel ? zip.text(partPath("xl/workbook.xml", rel.target)) : null;
    out.push(`## Sheet: ${sheet.name}${sheet.hidden ? " (hidden)" : ""}`, "");
    if (xml === null) { out.push("(sheet not found in the file)", ""); continue; }
    const { rows, truncated, wide } = sheetRows(xml, strings, dates, limits);
    if (!rows.length) { out.push("(empty)", ""); continue; }
    out.push(markdownTable(rows));
    if (truncated) out.push("", `(only the first ${limits.rows} rows with values are shown)`);
    if (wide) out.push("", `(only the first ${limits.columns} columns are shown)`);
    out.push("");
  }
  return { text: out.join("\n").trim(), detail: `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}` };
}

// --- PowerPoint ---------------------------------------------------------------

function slideShapes(xml) {
  const shapes = [];
  let shape = null;
  let para = null;
  let inText = false;
  let table = null;
  let row = null;
  let cellText = null;
  walk(xml, {
    open(name, attrs) {
      switch (name) {
        case "p:sp": shape = { title: false, number: false, lines: [] }; break;
        case "p:ph": if (shape) { const type = attrs().type || ""; shape.title = /title/i.test(type); shape.number = type === "sldNum"; } break;
        case "a:tbl": table = []; break;
        case "a:tr": if (table) row = []; break;
        case "a:tc": if (row) cellText = []; break;
        case "a:p": para = ""; break;
        case "a:t": inText = true; break;
        case "a:br": if (para !== null) para += "\n"; break;
        default: break;
      }
    },
    close(name) {
      switch (name) {
        case "a:t": inText = false; break;
        case "a:p":
          if (para !== null) {
            const text = para.trim();
            if (cellText) { if (text) cellText.push(text); }
            else if (shape) shape.lines.push(text);
            para = null;
          }
          break;
        case "a:tc": if (row && cellText) { row.push(cellText.join(" ")); cellText = null; } break;
        case "a:tr": if (table && row) { table.push(row); row = null; } break;
        case "a:tbl": if (table) { shapes.push({ table }); table = null; } break;
        case "p:sp": if (shape) { shapes.push(shape); shape = null; } break;
        default: break;
      }
    },
    text(text) { if (inText && para !== null) para += text; },
  });
  return shapes;
}

function shapeLines(shapes, { headings = true } = {}) {
  const out = [];
  for (const shape of shapes) {
    if (shape.table) { out.push(markdownTable(shape.table), ""); continue; }
    if (shape.number) continue;
    const lines = shape.lines.filter(Boolean);
    if (!lines.length) continue;
    if (shape.title && headings) out.push(`### ${lines.join(" ")}`, "");
    else out.push(...lines, "");
  }
  return out;
}

export function powerPointText(zip) {
  const presentation = zip.text("ppt/presentation.xml");
  if (presentation === null) throw new OfficeError("not a PowerPoint presentation");
  const rels = relationships(zip.text("ppt/_rels/presentation.xml.rels") || "");
  const ids = [];
  walk(presentation, { open(name, attrs) { if (name === "p:sldId") ids.push(relId(attrs())); } });
  const out = [];
  let number = 0;
  for (const id of ids) {
    const rel = rels.get(id);
    const part = rel ? partPath("ppt/presentation.xml", rel.target) : "";
    const xml = part ? zip.text(part) : null;
    number++;
    out.push(`## Slide ${number}`, "");
    if (xml === null) { out.push("(slide not found in the file)", ""); continue; }
    out.push(...shapeLines(slideShapes(xml)));
    const slideRels = relationships(zip.text(partPath(part, `_rels/${part.split("/").pop()}.rels`)) || "");
    const notesRel = [...slideRels.values()].find((r) => /\/notesSlide$/.test(r.type));
    const notes = notesRel ? zip.text(partPath(part, notesRel.target)) : null;
    if (notes) {
      const lines = shapeLines(slideShapes(notes), { headings: false }).filter(Boolean);
      if (lines.length) out.push("Notes:", ...lines.map((line) => `> ${line}`), "");
    }
  }
  return { text: out.join("\n").trim(), detail: `${number} slide${number === 1 ? "" : "s"}` };
}

// --- Entry ------------------------------------------------------------------

/**
 * The Markdown text of one Office file: { text, detail, truncated }. ext is
 * the lower-case extension; maxChars cuts the text with a note.
 */
export function officeText(buffer, ext, { maxChars = 1_500_000 } = {}) {
  let zip;
  try { zip = readZip(buffer); } catch (error) {
    throw new OfficeError(error instanceof ZipError ? `not a ${OFFICE_KINDS[ext] || "Office"} file (${error.message})` : error.message);
  }
  const result = ext === ".docx" ? wordText(zip) : ext === ".xlsx" ? excelText(zip) : ext === ".pptx" ? powerPointText(zip) : null;
  if (!result) throw new OfficeError(`${ext} is not a Word, Excel or PowerPoint file`);
  let { text } = result;
  let truncated = false;
  if (text.length > maxChars) { text = `${text.slice(0, maxChars)}\n\n[The text stops here: the file is longer than coop keeps for one attachment.]`; truncated = true; }
  return { text, detail: result.detail, truncated };
}
