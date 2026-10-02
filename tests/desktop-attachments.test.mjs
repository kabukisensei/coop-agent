/**
 * Attachments in the coop window (master plan D1b2), plus the window's own
 * splash and vibes: what kind each file is, how coop is told where it is,
 * the text pulled out of Word, Excel and PowerPoint files (built here from
 * their XML, no Office needed), the PDF child process contract (a fake
 * script stands in for pdf.js: the real one is the window runtime's package),
 * and the line grouping pdf-text.mjs applies to pdf.js text items.
 *
 * Gate lane: no Electron, no network, no pdf.js; the only child processes are
 * node running small scripts that answer at once.
 */
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "coop-desktop-attach-"));
const home = join(temp, "home");
mkdirSync(home, { recursive: true });
Object.assign(process.env, { HOME: home, USERPROFILE: home, COOP_DIR: join(temp, "coop-home") });

const { readZip, ZipError } = await import(pathToFileURL(join(ROOT, "desktop", "lib", "zip.mjs")).href);
const { walk, decode } = await import(pathToFileURL(join(ROOT, "desktop", "lib", "xml.mjs")).href);
const office = await import(pathToFileURL(join(ROOT, "desktop", "lib", "office.mjs")).href);
const attachments = await import(pathToFileURL(join(ROOT, "desktop", "lib", "attachments.mjs")).href);
const { pageLines } = await import(pathToFileURL(join(ROOT, "desktop", "scripts", "pdf-text.mjs")).href);
const splash = await import(pathToFileURL(join(ROOT, "desktop", "lib", "splash.mjs")).href);
const vibes = await import(pathToFileURL(join(ROOT, "desktop", "lib", "vibes.mjs")).href);
const { attachmentNote, splitAttachmentNote, NOTE_HEAD } = await import(pathToFileURL(join(ROOT, "desktop", "renderer", "attach-note.mjs")).href);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n    ${String(error && error.stack ? error.stack : error).split("\n").join("\n    ")}`);
  }
}

// --- A zip writer for the fixtures (stored or deflated, CRC-32 as the format needs) ---

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buffer) { let c = -1; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function writeZip(entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const packed = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const DOCX = {
  "[Content_Types].xml": "<Types/>",
  "docProps/app.xml": "<Properties><Pages>2</Pages><Words>40</Words></Properties>",
  "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Sales review</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>North</w:t></w:r><w:r><w:t xml:space="preserve"> region</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew 12% &amp; costs fell.</w:t></w:r><w:r><w:tab/><w:t>Café in Zürich.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>
<w:p><w:r><w:fldChar/><w:instrText> HYPERLINK "x" </w:instrText><w:t>Link text</w:t></w:r></w:p>
<w:p/>
<w:p/>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p><w:p><w:r><w:t>(cont.)</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1 | 200</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing/><w:t>After the picture</w:t></w:r></w:p>
</w:body></w:document>`,
};

const XLSX = {
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Region</t></si><si><r><t>Rev</t></r><r><t>enue</t></r><rPh><t>skip</t></rPh></si><si><t>North</t></si><si><t>A &amp; B</t></si></sst>`,
  "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;Day &quot;0"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>When</t></is></c><c r="D1" t="str"><f>x</f><v>Flag</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200.5</v></c><c r="C2" s="1"><v>45931</v></c><c r="D2" t="b"><v>1</v></c></row>
<row r="3"/>
<row r="4"><c r="A4" t="s"><v>3</v></c><c r="C4" s="2"><v>45931.75</v></c><c r="D4" s="3"><v>7</v></c><c r="E4" t="e"><v>#N/A</v></c></row>
</sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData></sheetData></worksheet>`,
};

const PPTX = {
  "ppt/presentation.xml": `<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Type="t/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="t/slide" Target="slides/slide1.xml"/></Relationships>`,
  "ppt/slides/slide1.xml": `<p:sld><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Quarter </a:t></a:r><a:r><a:t>three</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:p><a:r><a:t>Revenue up</a:t></a:r><a:br/><a:r><a:t>Costs down</a:t></a:r></a:p><a:p/></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`,
  "ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  "ppt/notesSlides/notesSlide1.xml": `<p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Say the number slowly.</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  "ppt/slides/slide2.xml": `<p:sld><p:cSld><p:spTree><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Total</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>1200</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
};

await check("zip and xml: entries read back stored or deflated; entities decode; damaged files are refused", () => {
  for (const deflate of [true, false]) {
    const zip = readZip(writeZip({ "a/b.xml": "<x a=\"1\">&amp;&#233;&#xE9;</x>", "big.txt": "y".repeat(100_000) }, { deflate }));
    assert.deepEqual(zip.names(), ["a/b.xml", "big.txt"]);
    assert.equal(zip.text("a/b.xml"), "<x a=\"1\">&amp;&#233;&#xE9;</x>");
    assert.equal(zip.read("big.txt").length, 100_000);
    assert.equal(zip.text("missing"), null);
  }
  assert.throws(() => readZip(Buffer.from("not a zip at all, nothing to see here!")), ZipError);
  assert.throws(() => readZip(Buffer.from("PK\u0003\u0004" + "x".repeat(40))), ZipError);
  const seen = [];
  walk("<?xml version=\"1.0\"?><!-- c --><a x='1' y=\"2\"><b/>t&amp;<![CDATA[<raw>]]></a>", {
    open: (name, attrs) => seen.push(`open ${name} ${JSON.stringify(attrs())}`),
    close: (name) => seen.push(`close ${name}`),
    text: (text) => seen.push(`text ${text}`),
  });
  assert.deepEqual(seen, ["open a {\"x\":\"1\",\"y\":\"2\"}", "open b {}", "close b", "text t&", "text <raw>", "close a"]);
  assert.equal(decode("&lt;a&gt; &quot;q&quot; &apos;s&apos; &#65; &#x42; &bogus;"), "<a> \"q\" 's' A B &bogus;");
});

await check("word: headings, runs, tabs, lists, field codes, tables and images become Markdown", () => {
  const { text, detail } = office.officeText(writeZip(DOCX), ".docx");
  assert.equal(detail, "2 pages");
  const lines = text.split("\n");
  assert.equal(lines[0], "# Sales review");
  assert.equal(lines[1], "# North region");
  assert.equal(lines[2], "Revenue grew 12% & costs fell.\tCafé in Zürich.");
  assert.equal(lines[3], "- First point");
  assert.equal(lines[4], "Link text", "field instructions are not text");
  assert.ok(text.includes("| Region | Revenue |\n| --- | --- |\n| North (cont.) | 1 \\| 200 |"), text);
  assert.ok(text.endsWith("[image]After the picture"));
  assert.equal(/\n\n\n/.test(text), false, "blank paragraphs collapse");
});

await check("excel: sheets in order, shared and inline strings, dates by style, booleans, hidden sheets", () => {
  const { text, detail } = office.officeText(writeZip(XLSX), ".xlsx");
  assert.equal(detail, "2 sheets");
  assert.ok(text.startsWith("## Sheet: Sales\n\n| Region | Revenue | When | Flag |  |\n| --- | --- | --- | --- | --- |\n| North | 1200.5 | 2025-10-01 | TRUE |  |\n| A & B |  | 2025-10-01 18:00 | 7 | #N/A |"), text);
  assert.ok(text.includes("## Sheet: Notes (hidden)\n\n(empty)"));
  assert.equal(office.excelDate(0.5), "12:00");
  assert.equal(office.excelDate(60), "1900-02-28", "the 1900 system, as Excel counts it");
  assert.deepEqual([...office.dateStyles(XLSX["xl/styles.xml"])], [1, 2], "cellXfs indexes with date formats; quoted text in a format does not count");
  // Row and column caps.
  const wide = { ...XLSX, "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${Array.from({ length: 7 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c><c r="BM${r + 1}"><v>far</v></c></row>`).join("")}</sheetData></worksheet>` };
  const capped = office.excelText(readZip(writeZip(wide)), { rows: 5, columns: 64 }).text;
  assert.ok(capped.includes("(only the first 5 rows with values are shown)") && capped.includes("(only the first 64 columns are shown)"), capped);
});

await check("powerpoint: slides in presentation order, titles, line breaks, tables, notes; slide numbers skipped", () => {
  const { text, detail } = office.officeText(writeZip(PPTX), ".pptx");
  assert.equal(detail, "2 slides");
  assert.equal(text, [
    "## Slide 1", "", "### Quarter three", "", "Revenue up", "Costs down", "", "Notes:", "> Say the number slowly.", "",
    "## Slide 2", "", "| Region | Total |", "| --- | --- |", "| North | 1200 |",
  ].join("\n"), text);
  assert.equal(office.partPath("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml"), "ppt/notesSlides/notesSlide1.xml");
  assert.equal(office.partPath("xl/workbook.xml", "/xl/worksheets/sheet2.xml"), "xl/worksheets/sheet2.xml");
});

await check("office: wrong container, wrong extension and the text cap", () => {
  assert.throws(() => office.officeText(writeZip(DOCX), ".xlsx"), /not an Excel workbook/);
  assert.throws(() => office.officeText(Buffer.from("plain text"), ".docx"), /not a Word file/);
  assert.throws(() => office.officeText(writeZip(DOCX), ".odt"), /not a Word, Excel or PowerPoint file/);
  const cut = office.officeText(writeZip(DOCX), ".docx", { maxChars: 20 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.startsWith("# Sales review\n# Nor") && cut.text.includes("[The text stops here"));
});

await check("classify: images, text by extension or by sniff, PDF by header, Office, old Office, binaries", () => {
  const c = attachments.classify;
  assert.deepEqual(c("C:\\x\\shot.PNG"), { kind: "image", label: "image", mimeType: "image/png" });
  assert.equal(c("/x/report.pdf").kind, "pdf");
  assert.equal(c("/x/noext", Buffer.from("%PDF-1.7")).kind, "pdf");
  assert.equal(c("/x/deck.pptx").label, "PowerPoint");
  assert.equal(c("/x/notes.md").kind, "text");
  assert.equal(c("/x/Makefile", Buffer.from("all:\n\tmake")).kind, "text");
  assert.equal(c("/x/data.bin", Buffer.from([1, 0, 2])).kind, "unsupported");
  assert.match(c("/x/data.bin", Buffer.from([1, 0, 2])).reason, /cannot read \.bin files/);
  assert.match(c("/x/old.doc").reason, /Save the file as \.docx first/);
  assert.equal(c("/x/empty.xyz", Buffer.alloc(0)).kind, "unsupported");
});

await check("referenceFor: a relative path inside the working folder, the full path outside it", () => {
  const r = attachments.referenceFor;
  assert.equal(r(join(temp, "work", "sql", "a.sql"), join(temp, "work")), "sql/a.sql");
  assert.equal(r(join(temp, "other", "a.sql"), join(temp, "work")), join(temp, "other", "a.sql"));
  assert.equal(r(join(temp, "work2", "a.sql"), join(temp, "work")), join(temp, "work2", "a.sql"), "a sibling folder with the same prefix is outside");
});

await check("attach: image data, text by reference, Office text saved under the store, limits and errors", async () => {
  const cwd = join(temp, "work");
  const store = join(temp, "store");
  mkdirSync(join(cwd, "sql"), { recursive: true });
  writeFileSync(join(cwd, "sql", "a.sql"), "SELECT 1;");
  writeFileSync(join(cwd, "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(cwd, "report.docx"), writeZip(DOCX));
  writeFileSync(join(cwd, "big.docx"), Buffer.alloc(1024));
  writeFileSync(join(cwd, "blob.bin"), Buffer.from([0, 1, 2]));
  const options = { cwd, store, node: process.execPath, pdfjsDir: "" };
  const image = await attachments.attach(join(cwd, "pic.png"), options);
  assert.deepEqual([image.kind, image.mimeType, image.data], ["image", "image/png", "iVBORw0KGgo="]);
  const text = await attachments.attach(join(cwd, "sql", "a.sql"), options);
  assert.deepEqual([text.kind, text.ref, text.size], ["text", "sql/a.sql", 9]);
  const doc = await attachments.attach(join(cwd, "report.docx"), options);
  assert.equal(doc.kind, "office");
  assert.equal(doc.label, "Word");
  assert.equal(doc.detail, "2 pages");
  assert.ok(doc.ref.startsWith(join(store, doc.id)) && doc.ref.endsWith("report.docx.md"), doc.ref);
  const saved = readFileSync(doc.ref, "utf8");
  assert.ok(saved.startsWith("# report.docx\n\nText from ") && saved.includes("(Word, 2 pages)") && saved.includes("\n# Sales review\n"), saved);
  await assert.rejects(attachments.attach(join(cwd, "big.docx"), { ...options, limits: { ...attachments.LIMITS, document: 512 } }), /big\.docx is 1 KB; documents up to 1 KB can be attached/);
  await assert.rejects(attachments.attach(join(cwd, "blob.bin"), options), /cannot read \.bin files/);
  await assert.rejects(attachments.attach(join(cwd, "sql"), options), /not a file/);
  await assert.rejects(attachments.attach(join(cwd, "nope.txt"), options), /was not found/);
  await assert.rejects(attachments.attach("relative.txt", options), /not a file path/);
  await assert.rejects(attachments.attach(join(cwd, "report.pdf"), options), /was not found/);
  writeFileSync(join(cwd, "report.pdf"), "%PDF-1.4 nothing");
  await assert.rejects(attachments.attach(join(cwd, "report.pdf"), options), /PDF reading is not installed/);
  // The store: forget one, prune old ones.
  assert.equal(attachments.forget(store, doc.id), true);
  assert.equal(existsSync(join(store, doc.id)), false);
  assert.equal(attachments.forget(store, "../etc"), false);
  const old = attachments.saveExtract(store, { name: "old.docx", source: "x", label: "Word", detail: "1 page", text: "a" }, new Date(Date.now() - 10 * 24 * 3600 * 1000));
  utimesSync(join(store, old.id), new Date(Date.now() - 10 * 24 * 3600 * 1000), new Date(Date.now() - 10 * 24 * 3600 * 1000));
  const fresh = attachments.saveExtract(store, { name: "new.docx", source: "x", label: "Word", detail: "1 page", text: "b" });
  assert.equal(attachments.pruneStore(store), 1);
  assert.ok(!existsSync(join(store, old.id)) && existsSync(join(store, fresh.id)));
  assert.equal(attachments.pruneStore(join(temp, "no-store")), 0);
});

await check("pdf child: result, an error the script reports, a crash, and the time limit", async () => {
  const dir = join(temp, "pdf");
  mkdirSync(dir, { recursive: true });
  const ok = join(dir, "ok.mjs");
  writeFileSync(ok, "console.error('Warning: no canvas'); console.log(JSON.stringify({ pages: 2, text: '## Page 1\\n\\nHello', truncated: false }));");
  const result = await attachments.pdfText({ node: process.execPath, pdfjsDir: dir, file: "x.pdf", script: ok });
  assert.deepEqual(result, { text: "## Page 1\n\nHello", detail: "2 pages", truncated: false });
  const bad = join(dir, "bad.mjs");
  writeFileSync(bad, "console.log(JSON.stringify({ error: 'This PDF needs a password; coop cannot read it.' })); process.exitCode = 1;");
  await assert.rejects(attachments.pdfText({ node: process.execPath, pdfjsDir: dir, file: "x.pdf", script: bad }), /needs a password/);
  const crash = join(dir, "crash.mjs");
  writeFileSync(crash, "console.error('boom happened'); process.exit(3);");
  await assert.rejects(attachments.pdfText({ node: process.execPath, pdfjsDir: dir, file: "x.pdf", script: crash }), /x\.pdf could not be read as a PDF \(boom happened\)/);
  const slow = join(dir, "slow.mjs");
  writeFileSync(slow, "setTimeout(() => {}, 20000);");
  await assert.rejects(attachments.pdfText({ node: process.execPath, pdfjsDir: dir, file: "x.pdf", script: slow, timeoutMs: 300 }), /took longer than 0 seconds|took longer than 1 seconds/);
  // Where pdf.js lives: next to Electron in the runtime tree, or COOP_DESKTOP_RUNTIME.
  const runtime = join(temp, "runtime");
  mkdirSync(join(runtime, "node_modules", "pdfjs-dist"), { recursive: true });
  mkdirSync(join(runtime, "node_modules", "electron", "dist"), { recursive: true });
  writeFileSync(join(runtime, "node_modules", "pdfjs-dist", "package.json"), "{}");
  assert.equal(attachments.findPdfjs(join(runtime, "node_modules", "electron", "dist", "electron.exe"), {}), join(runtime, "node_modules", "pdfjs-dist"));
  assert.equal(attachments.findPdfjs(join(temp, "elsewhere", "electron"), {}), "");
  assert.equal(attachments.findPdfjs("", { COOP_DESKTOP_RUNTIME: runtime }), join(runtime, "node_modules", "pdfjs-dist"));
  assert.equal(attachments.findPdfjs("", { COOP_DESKTOP_RUNTIME: join(temp, "nope") }), "");
});

/** A one-page PDF with two lines of Helvetica text, written by hand with a correct xref. */
function tinyPdf(lines) {
  const content = `BT /F1 18 Tf 20 100 Td ${lines.map((line, i) => `${i ? "0 -30 Td " : ""}(${line}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// The real pdf.js, when a runtime tree is at hand (COOP_TEST_PDFJS=<pdfjs-dist dir>);
// the gate lane has no Electron runtime, so this case is skipped there.
if (process.env.COOP_TEST_PDFJS) {
  await check("pdf child: the real pdf.js reads a PDF's text", async () => {
    const file = join(temp, "tiny.pdf");
    writeFileSync(file, tinyPdf(["Sales review Q3", "North 1,200"]));
    const result = await attachments.pdfText({ node: process.execPath, pdfjsDir: process.env.COOP_TEST_PDFJS, file });
    assert.equal(result.detail, "1 page");
    assert.equal(result.text, "## Page 1\n\nSales review Q3\nNorth 1,200");
    assert.equal(result.truncated, false);
    writeFileSync(join(temp, "not.pdf"), "hello");
    await assert.rejects(attachments.pdfText({ node: process.execPath, pdfjsDir: process.env.COOP_TEST_PDFJS, file: join(temp, "not.pdf") }), /not a readable PDF/);
  });
} else {
  console.log("  - pdf child with the real pdf.js: skipped (set COOP_TEST_PDFJS to a pdfjs-dist folder)");
}

await check("pdf lines: hasEOL and baseline jumps break lines, gaps become spaces, runs join", () => {
  const item = (str, x, y, width, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width, hasEOL });
  const lines = pageLines([
    item("Sales ", 10, 700, 30), item("review", 40, 700, 30, true),
    item("Rev", 10, 680, 15), item("enue", 25, 680, 20), item("grew", 60, 680, 20),
    item("Footer", 10, 20, 30),
  ]);
  assert.deepEqual(lines, ["Sales review", "Revenue grew", "Footer"]);
  assert.deepEqual(pageLines([]), []);
  assert.deepEqual(pageLines([{ str: "", hasEOL: true }, { str: "a" }]), ["", "a"]);
});

await check("attachment note: what the prompt says about each file", () => {
  assert.equal(attachmentNote([]), "");
  const note = attachmentNote([
    { kind: "text", name: "a.sql", ref: "sql/a.sql" },
    { kind: "office", label: "Excel", name: "sales.xlsx", detail: "3 sheets", ref: "C:\\data\\sales.xlsx.md", truncated: true },
    { kind: "image", name: "shot.png" },
  ]);
  assert.equal(note, "\n\nAttached files (read each one with the read tool before answering):\n- a.sql: sql/a.sql\n- sales.xlsx (Excel, 3 sheets; the text was cut at coop's limit): C:\\data\\sales.xlsx.md");
});

await check("attachment note: the conversation view reads it back as chips", () => {
  const sent = `Compare these${attachmentNote([
    { kind: "text", name: "a.sql", ref: "sql/a.sql" },
    { kind: "office", label: "Excel", name: "Q3 sales.xlsx", detail: "3 sheets", ref: "C:\\data\\Q3 sales.xlsx.md", truncated: true },
    { kind: "pdf", label: "PDF", name: "roll (up).pdf", detail: "2 pages", ref: "/x/roll (up).pdf.md" },
  ])}`;
  assert.deepEqual(splitAttachmentNote(sent), { text: "Compare these", files: [
    { name: "a.sql", detail: "", ref: "sql/a.sql" },
    { name: "Q3 sales.xlsx", detail: "Excel, 3 sheets; the text was cut at coop's limit", ref: "C:\\data\\Q3 sales.xlsx.md" },
    { name: "roll (up).pdf", detail: "PDF, 2 pages", ref: "/x/roll (up).pdf.md" },
  ] });
  assert.deepEqual(splitAttachmentNote("plain prompt"), { text: "plain prompt", files: [] });
  assert.deepEqual(splitAttachmentNote(`x\n\n${NOTE_HEAD}\nnot a list`).files, []);
  assert.deepEqual(splitAttachmentNote(""), { text: "", files: [] });
});

await check("splash: the terminal's block art becomes a pixel grid in the brand colours", () => {
  const art = splash.loadSplash(ROOT);
  assert.equal(art.width, 42);
  assert.equal(art.height, 48);
  assert.ok(art.runs.length > 100);
  const colours = new Set(art.runs.map((run) => run[3]));
  assert.deepEqual([...colours].sort(), ["#00416b", "#42783c", "#82aa43", "#b2d235", "#ef412d"]);
  for (const [y, x, length] of art.runs) assert.ok(y >= 0 && y < 48 && x >= 0 && x + length <= 42);
  const small = splash.parseSplash("\x1b[38;2;1;2;3m\u2580\x1b[48;2;4;5;6m\u2584 \x1b[0m\u2588\n\u2588");
  assert.deepEqual(small, { width: 4, height: 4, runs: [[0, 0, 1, "#010203"], [0, 1, 2, "#040506"], [1, 1, 1, "#010203"], [1, 2, 1, "#040506"]] });
  assert.deepEqual(splash.parseSplash(""), { width: 0, height: 0, runs: [] });
  assert.deepEqual(splash.loadSplash(join(temp, "nowhere")), { width: 0, height: 0, runs: [] });
  assert.equal(splash.splashFile("/r", { COOP_SPLASH_FILE: "/x/s.ansi" }), "/x/s.ansi");
});

await check("vibes: the repo's sets, # lines skipped, {user} from the profile, a fallback", () => {
  const dir = vibes.vibesDir(ROOT, {});
  assert.ok(vibes.vibeSets(dir).includes("tips"));
  const tips = vibes.loadVibes(dir, "tips");
  assert.ok(tips.length > 3 && tips.every((line) => line && !line.startsWith("#")));
  assert.ok(vibes.loadVibes(dir).length > tips.length);
  assert.deepEqual(vibes.loadVibes(dir, "no-such-set"), []);
  assert.deepEqual(vibes.loadVibes(join(temp, "nowhere")), []);
  assert.equal(vibes.vibesDir("/r", { COOP_VIBES_DIR: "/v" }), "/v");
  assert.equal(vibes.pickVibe([], () => 0.9), vibes.FALLBACK_VIBES[3], "an empty pool falls back to the built-in tips");
  assert.equal(vibes.pickVibe(["a", "b"], () => 0.99), "b");
  mkdirSync(join(process.env.COOP_DIR, ".coop"), { recursive: true });
  writeFileSync(join(process.env.COOP_DIR, ".coop", "user.json"), JSON.stringify({ schema_version: 1, name: " Aaron\tJ " }));
  assert.equal(vibes.userName(process.env), "Aaron J");
  assert.equal(vibes.fillVibe("Hello {user}, {user}.", "Sam"), "Hello Sam, Sam.");
  assert.equal(vibes.fillVibe("No name here", "Sam"), "No name here");
});

rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} desktop attachment tests passed, ${failed} failed.`);
if (failed) process.exit(1);
