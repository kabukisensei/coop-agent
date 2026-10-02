// A small reader for the zip containers Office files are (docx, xlsx, pptx):
// a central directory walk and stored or deflated entries, nothing more. Node's
// zlib inflates; no package is installed for this.
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {}

/**
 * Open a zip held in memory. Returns { names(), has(name), read(name) ->
 * Buffer|null, text(name) -> string|null }. Entries are read on demand, each
 * capped at maxEntryBytes once inflated.
 */
export function readZip(buffer, { maxEntries = 20000, maxEntryBytes = 64 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError("not a zip file");
  // The end record sits at the very end, before an optional comment of up to 64 KB.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = buffer.readUInt16LE(eocd + 10);
  const start = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || start === 0xffffffff) throw new ZipError("zip64 archives are not supported");
  if (count > maxEntries) throw new ZipError("too many entries");
  const entries = new Map();
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL) throw new ZipError("damaged central directory");
    const method = buffer.readUInt16LE(p + 10);
    const compressed = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    entries.set(name, { method, compressed, size, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }

  function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size > maxEntryBytes) throw new ZipError(`${name} is too large`);
    const h = entry.offset;
    if (h + 30 > buffer.length || buffer.readUInt32LE(h) !== LOCAL) throw new ZipError(`damaged entry ${name}`);
    const from = h + 30 + buffer.readUInt16LE(h + 26) + buffer.readUInt16LE(h + 28);
    if (from + entry.compressed > buffer.length) throw new ZipError(`damaged entry ${name}`);
    const data = buffer.subarray(from, from + entry.compressed);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxEntryBytes });
    throw new ZipError(`${name} uses an unsupported compression method`);
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => { const data = read(name); return data ? data.toString("utf8") : null; },
  };
}
