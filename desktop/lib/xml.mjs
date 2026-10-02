// A streaming scan over the XML inside Office files: open and close tags,
// attributes and text, nothing else (no namespaces, DTDs or entities beyond
// the five XML ones and numeric references). Office writes well-formed XML
// with quoted attributes, which is all this reads.

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>]|"[^"]*")*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:(amp|lt|gt|quot|apos)|#x([0-9a-fA-F]+)|#(\d+));/g;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** XML text with its entities decoded. */
export function decode(text) {
  return text.replace(ENTITY, (m, named, hex, dec) => {
    if (named) return NAMED[named];
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** The attributes of one tag as an object (values decoded). */
export function attributes(raw) {
  const out = {};
  if (!raw) return out;
  for (const m of raw.matchAll(ATTR)) out[m[1]] = decode(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/**
 * Walk the document: handlers.open(name, attrs), handlers.close(name),
 * handlers.text(text). A self-closing tag opens and closes. attrs is parsed
 * lazily: it is a function of no arguments.
 */
export function walk(xml, handlers) {
  const open = handlers.open || (() => {});
  const close = handlers.close || (() => {});
  const text = handlers.text || (() => {});
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) { text(m[1]); continue; }
    if (m[6] !== undefined) { if (m[6].trim()) text(decode(m[6])); continue; }
    if (m[3] === undefined) continue;
    const name = m[3];
    if (m[2]) { close(name); continue; }
    const raw = m[4];
    open(name, () => attributes(raw));
    if (m[5]) close(name);
  }
}
