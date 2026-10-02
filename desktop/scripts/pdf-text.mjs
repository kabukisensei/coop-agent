#!/usr/bin/env node
// The text of a PDF through pdf.js (pdfjs-dist, the window runtime's second
// package next to Electron). The window runs this as its own node process with
// a time limit, so a huge or hostile file cannot stall the window; JavaScript
// inside the PDF never runs (isEvalSupported off, no rendering). Prints one
// JSON line: { pages, text, truncated } or { error }.
//
// usage: node pdf-text.mjs <pdfjs-dist dir> <file.pdf> [maxChars]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/**
 * Text items of one page (pdf.js getTextContent) as lines: a new line at
 * each item marked hasEOL and at each jump in the baseline; items that
 * continue where the last one ended join without a space.
 */
export function pageLines(items) {
  const lines = [];
  let line = "";
  let lastY = null;
  let lastEnd = null;
  let height = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
    const x = transform[4];
    const y = transform[5];
    const size = Math.abs(transform[3]) || Math.abs(transform[0]) || 10;
    if (lastY !== null && Math.abs(y - lastY) > Math.max(2, (height || size) * 0.5)) { if (line) lines.push(line); line = ""; lastEnd = null; }
    if (item.str) {
      const gap = lastEnd === null ? 0 : x - lastEnd;
      if (line && !line.endsWith(" ") && !item.str.startsWith(" ") && gap > Math.max(1, size * 0.15)) line += " ";
      line += item.str;
      lastEnd = x + (Number(item.width) || 0);
    }
    lastY = y;
    height = size;
    if (item.hasEOL) { lines.push(line); line = ""; lastEnd = null; }
  }
  if (line) lines.push(line);
  return lines.map((text) => text.replace(/[ \t]+/g, " ").trimEnd());
}

async function main() {
  const [dir, file, max] = process.argv.slice(2);
  const maxChars = Number(max) || 1_500_000;
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!dir || !file) { print({ error: "usage: pdf-text.mjs <pdfjs-dist dir> <file.pdf> [maxChars]" }); process.exitCode = 2; return; }
  let pdfjs;
  try {
    pdfjs = await import(pathToFileURL(join(dir, "legacy", "build", "pdf.mjs")).href);
  } catch (error) {
    print({ error: `pdf.js is not installed in the window runtime (${error.message}); run: coop sync` });
    process.exitCode = 2;
    return;
  }
  let task;
  let doc;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(readFileSync(file)),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
      cMapUrl: `${join(dir, "cmaps")}/`,
      cMapPacked: true,
      standardFontDataUrl: `${join(dir, "standard_fonts")}/`,
    });
    doc = await task.promise;
  } catch (error) {
    const name = error && error.name;
    print({ error: name === "PasswordException" ? "This PDF needs a password; coop cannot read it." : name === "InvalidPDFException" ? "This is not a readable PDF." : `The PDF could not be opened: ${error && error.message ? error.message : error}` });
    process.exitCode = 1;
    return;
  }
  const parts = [];
  let length = 0;
  let truncated = false;
  for (let number = 1; number <= doc.numPages && !truncated; number++) {
    let lines = [];
    try {
      const page = await doc.getPage(number);
      lines = pageLines((await page.getTextContent()).items);
      page.cleanup();
    } catch (error) {
      lines = [`[page ${number} could not be read: ${error && error.message ? error.message : error}]`];
    }
    const text = `## Page ${number}\n\n${lines.join("\n").trim()}`;
    if (length + text.length > maxChars) { parts.push(`${text.slice(0, Math.max(0, maxChars - length))}\n\n[The text stops here: the file is longer than coop keeps for one attachment.]`); truncated = true; break; }
    parts.push(text);
    length += text.length + 2;
  }
  const pages = doc.numPages;
  await task.destroy();
  print({ pages, text: parts.join("\n\n"), truncated });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stdout.write(`${JSON.stringify({ error: String(error && error.message ? error.message : error) })}\n`); process.exitCode = 1; });
}
