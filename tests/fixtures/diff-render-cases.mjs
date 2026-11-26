// A tiny DOM, enough for desktop/renderer/ui.mjs el() and diff-view.mjs
// renderDiff, and the diffs tests/desktop-panes.test.mjs renders with it. The
// serialized DOM of each case with review comments OFF is pinned in
// ed1-diff-golden.json, made from the renderer at 6e64add8 (ED1, before
// Diff review comments), so "off is ED1 byte for byte" is checked, not assumed.
// Regenerate only on purpose: node tests/fixtures/diff-render-cases.mjs <renderer dir>.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

class FakeNode {
  constructor(tag, text = null) {
    this.tag = tag;
    this.text = text;
    this.attrs = [];
    this.children = [];
    this.dataset = {};
    this.parentNode = null;
  }
  set className(value) { this.setAttribute("class", value); }
  get className() { return this.getAttribute("class") || ""; }
  set textContent(value) { this.children = [new FakeNode("#text", String(value))]; }
  get textContent() { return this.text !== null ? this.text : this.children.map((c) => c.textContent).join(""); }
  setAttribute(name, value) {
    const hit = this.attrs.find((a) => a[0] === name);
    if (hit) hit[1] = String(value); else this.attrs.push([name, String(value)]);
  }
  getAttribute(name) { const hit = this.attrs.find((a) => a[0] === name); return hit ? hit[1] : null; }
  hasAttribute(name) { return this.attrs.some((a) => a[0] === name); }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
  addEventListener() {}
  /** Every element below this one, depth first. */
  all() { return this.children.flatMap((c) => (c.tag === "#text" ? [] : [c, ...c.all()])); }
}

export function installFakeDom() {
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeNode("#text", String(text)),
  };
}

export function serialize(node) {
  if (node.tag === "#text") return node.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
  return `<${node.tag}${attrs}>${node.children.map(serialize).join("")}</${node.tag}>`;
}

export const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A git-style diff of `count` lines, every `every`th one changed. */
function bigDiff(count, every) {
  const lines = [`@@ -1,${count} +1,${count} @@`];
  for (let i = 1; i <= count; i += 1) {
    if (i % every === 0) lines.push(`-old line ${i}`, `+new line ${i} SELECT`);
    else lines.push(` same line ${i}`);
  }
  return lines.join("\n");
}

/** The diffs and options every golden case renders. */
export const CASES = [
  {
    name: "two hunks, a pair, a removal, an addition, a match",
    diff: ["diff --git a/v.sql b/v.sql", "--- a/v.sql", "+++ b/v.sql",
      "@@ -1,6 +1,6 @@", " CREATE VIEW v AS", "-SELECT a, b", "+SELECT a, b, c", " FROM stg.Customer c", "-WHERE x = 1", " GO", "+-- end",
      "@@ -40,4 +40,5 @@", " END", "+  RETURN", " END", " GO", " )"].join("\n"),
    options: [{ mode: "unified" }, { mode: "split" }, { mode: "unified", query: "select", active: 0 }, { mode: "split", query: "end", active: 1 }],
  },
  { name: "past MAX_ROWS (4000) the diff is cut", diff: bigDiff(4500, 7), options: [{ mode: "unified" }, { mode: "split" }] },
];

/** { "<case> / <mode> <query>": sha256 of the serialized DOM } for a renderer folder. */
export async function renderAll(rendererDir, extra = {}) {
  installFakeDom();
  const view = await import(pathToFileURL(join(rendererDir, "diff-view.mjs")).href);
  const out = {};
  for (const c of CASES) {
    const model = view.diffModel(c.diff);
    for (const o of c.options) {
      out[`${c.name} / ${o.mode} ${o.query || ""}`.trim()] = sha(serialize(view.renderDiff(model, { ...o, ...extra }).node));
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await renderAll(process.argv[2]), null, 2));
}
