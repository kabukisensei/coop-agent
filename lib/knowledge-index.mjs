import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { KNOWLEDGE_RECORD_MAX_BYTES, validateKnowledgeRecord } from "./knowledge-policy.mjs";

export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1;
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
const BODY_HEADINGS = Object.freeze({
  "Context": "context",
  "Problem": "problem",
  "Why it happens": "why",
  "Approved pattern": "approvedPattern",
  "Anti-pattern": "antiPattern",
  "Detection method": "detection",
  "Example": "example",
  "Exceptions": "exceptions",
  "Sources": "sources",
});

function scalar(text, label) {
  const value = text.trim();
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { throw new TypeError(`${label} has an invalid quoted value.`); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new TypeError(`${label} has an invalid quoted value.`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch { throw new TypeError(`${label} inline arrays must use JSON string syntax.`); }
  }
  if (/^[{|&*!>]/.test(value)) throw new TypeError(`${label} uses unsupported YAML syntax.`);
  return value;
}

function parseYamlBlock(lines, start, indent, label) {
  const first = lines[start];
  const isArray = first.text.startsWith("- ");
  const output = isArray ? [] : {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const line = lines[index];
    if (line.text.startsWith("- ") !== isArray) throw new TypeError(`${label} mixes arrays and mappings.`);
    if (isArray) {
      const item = line.text.slice(2).trim();
      if (!item) throw new TypeError(`${label} contains an empty list item.`);
      output.push(scalar(item, label));
      index++;
      continue;
    }
    const split = line.text.indexOf(":");
    if (split <= 0) throw new TypeError(`${label} contains malformed YAML.`);
    const key = line.text.slice(0, split).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new TypeError(`${label} contains invalid key ${key}.`);
    if (Object.hasOwn(output, key)) throw new TypeError(`${label} contains duplicate key ${key}.`);
    const rest = line.text.slice(split + 1).trim();
    if (rest) {
      output[key] = scalar(rest, `${label}.${key}`);
      index++;
      continue;
    }
    if (index + 1 >= lines.length || lines[index + 1].indent <= indent) throw new TypeError(`${label}.${key} has no value.`);
    if (lines[index + 1].indent !== indent + 2) throw new TypeError(`${label}.${key} must use two-space indentation.`);
    const nested = parseYamlBlock(lines, index + 1, indent + 2, `${label}.${key}`);
    output[key] = nested.value;
    index = nested.index;
  }
  return { value: output, index };
}

function parseFrontmatter(text, sourceLabel) {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new TypeError(`${sourceLabel} is missing YAML frontmatter.`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new TypeError(`${sourceLabel} has unterminated YAML frontmatter.`);
  const yamlText = normalized.slice(4, end);
  const lines = yamlText.split("\n").map((raw, index) => {
    if (/\t/.test(raw)) throw new TypeError(`${sourceLabel} frontmatter line ${index + 1} contains a tab.`);
    const withoutComment = raw.trimStart();
    if (!withoutComment || withoutComment.startsWith("#")) return null;
    const spaces = raw.length - withoutComment.length;
    if (spaces % 2 !== 0) throw new TypeError(`${sourceLabel} frontmatter line ${index + 1} must use two-space indentation.`);
    return { indent: spaces, text: withoutComment };
  }).filter(Boolean);
  if (!lines.length || lines[0].indent !== 0) throw new TypeError(`${sourceLabel} has empty or indented root frontmatter.`);
  const parsed = parseYamlBlock(lines, 0, 0, sourceLabel);
  if (parsed.index !== lines.length || Array.isArray(parsed.value)) throw new TypeError(`${sourceLabel} frontmatter must be one mapping.`);
  return { metadata: parsed.value, markdown: normalized.slice(end + 5) };
}

function parseBody(markdown, sourceLabel) {
  const body = {};
  let current = null;
  let content = [];
  const finish = () => {
    if (current === null) return;
    body[current] = content.join("\n").trim();
  };
  for (const line of markdown.split("\n")) {
    const match = /^## ([^#].*)$/.exec(line);
    if (match) {
      finish();
      const key = BODY_HEADINGS[match[1].trim()];
      if (!key) throw new TypeError(`${sourceLabel} has unsupported body section ${match[1].trim()}.`);
      if (Object.hasOwn(body, key)) throw new TypeError(`${sourceLabel} repeats body section ${match[1].trim()}.`);
      current = key;
      content = [];
    } else if (current === null) {
      if (line.trim()) throw new TypeError(`${sourceLabel} has content before its first required body section.`);
    } else {
      content.push(line);
    }
  }
  finish();
  return body;
}

export function parseKnowledgeMarkdown(text, sourceLabel = "Knowledge record") {
  const { metadata, markdown } = parseFrontmatter(text, sourceLabel);
  return validateKnowledgeRecord({ ...metadata, body: parseBody(markdown, sourceLabel) });
}

function safeMessage(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : "Knowledge record validation failed.";
}

function listMarkdownFiles(root) {
  const files = [];
  const walk = (directory, depth) => {
    if (depth > MAX_DEPTH) throw new TypeError(`Knowledge directory exceeds the ${MAX_DEPTH}-level depth limit.`);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(path);
        if (files.length > MAX_FILES) throw new TypeError(`Knowledge source exceeds the ${MAX_FILES}-file limit.`);
      }
    }
  };
  walk(root, 0);
  return files;
}

function normalizeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("Knowledge source must be an object.");
  const keys = Object.keys(source).sort();
  if (keys.join(",") !== "id,projectId,root,scope") throw new TypeError("Knowledge source fields must be id, scope, root, and projectId.");
  if (typeof source.id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(source.id)) throw new TypeError("Knowledge source has an invalid ID.");
  if (!new Set(["project", "team"]).has(source.scope)) throw new TypeError("Knowledge source scope must be project or team.");
  if (source.scope === "project" && (typeof source.projectId !== "string" || !source.projectId)) throw new TypeError("Project knowledge source requires a project ID.");
  if (source.scope === "team" && source.projectId !== null) throw new TypeError("Team knowledge source cannot carry a project ID.");
  if (typeof source.root !== "string" || !source.root) throw new TypeError("Knowledge source root is required.");
  const root = realpathSync.native(resolve(source.root));
  if (!statSync(root).isDirectory()) throw new TypeError("Knowledge source root must be a directory.");
  let gitRoot;
  try {
    gitRoot = realpathSync.native(execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim());
  } catch {
    throw new TypeError("Knowledge source must be inside a readable Git repository.");
  }
  // Native realpath expands Windows short names before Git/filesystem paths
  // are compared. Git and the filesystem can spell the same path with different
  // separators or case. Native relative() also detects sibling/drive escapes.
  const fromGit = relative(gitRoot, root);
  if (isAbsolute(fromGit) || fromGit === ".." || fromGit.startsWith(`..${sep}`)) throw new TypeError("Knowledge source is outside its Git repository root.");
  return { ...source, root };
}

function entryFor(record, source, relativePath) {
  return {
    id: record.id,
    scope: record.scope,
    title: record.title,
    kind: record.kind,
    confidence: record.confidence,
    tags: [...record.tags],
    appliesTo: [...record.appliesTo],
    sourceId: source.id,
    relativePath,
    record,
  };
}

function scanKnowledgeSources(inputSources) {
  if (!Array.isArray(inputSources)) throw new TypeError("Knowledge sources must be an array.");
  const sources = inputSources.map(normalizeSource).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new TypeError("Knowledge source IDs must be unique.");
  const coverage = { attempted: 0, parsed: 0, approved: 0, ignored: 0, failed: 0, complete: true };
  const diagnostics = [];
  const entries = [];
  for (const source of sources) {
    let files;
    try { files = listMarkdownFiles(source.root); }
    catch (error) {
      coverage.failed++;
      diagnostics.push({ code: "source-read-failed", message: safeMessage(error), sourceId: source.id, relativePath: null });
      continue;
    }
    for (const path of files) {
      coverage.attempted++;
      const relativePath = relative(source.root, path).split(sep).join("/");
      try {
        const info = lstatSync(path);
        if (info.size > KNOWLEDGE_RECORD_MAX_BYTES) throw new TypeError("Knowledge source file exceeds the 128 KiB limit.");
        const real = realpathSync(path);
        if (!(real === source.root || real.startsWith(`${source.root}${sep}`))) throw new TypeError("Knowledge source path escapes its configured root.");
        const record = parseKnowledgeMarkdown(readFileSync(real, "utf8"), `${source.id}:${relativePath}`);
        if (record.scope !== source.scope) throw new TypeError(`Record scope ${record.scope} does not match source scope ${source.scope}.`);
        if (source.scope === "project" && record.project.projectId !== source.projectId) throw new TypeError("Record project ID does not match its configured project source.");
        coverage.parsed++;
        entries.push(entryFor(record, source, relativePath));
      } catch (error) {
        coverage.failed++;
        diagnostics.push({ code: "record-invalid", message: safeMessage(error), sourceId: source.id, relativePath });
      }
    }
  }
  return { sources, coverage, diagnostics, entries };
}

export function loadKnowledgeCatalog(inputSources) {
  const { sources, coverage, diagnostics, entries } = scanKnowledgeSources(inputSources);
  coverage.approved = entries.filter((entry) => entry.record.status === "approved").length;
  coverage.ignored = entries.length - coverage.approved;
  coverage.complete = coverage.failed === 0;
  return {
    schemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION,
    status: sources.length === 0 ? "not-applicable" : coverage.complete ? "complete" : entries.length ? "partial" : "failed",
    coverage,
    sources: sources.map(({ id, scope, projectId }) => ({ id, scope, projectId })),
    records: entries.sort((a, b) => a.id.localeCompare(b.id) || a.sourceId.localeCompare(b.sourceId) || a.relativePath.localeCompare(b.relativePath)),
    diagnostics: diagnostics.sort((a, b) => `${a.sourceId}:${a.relativePath}:${a.code}`.localeCompare(`${b.sourceId}:${b.relativePath}:${b.code}`)),
  };
}

export function buildKnowledgeIndex(inputSources) {
  const catalog = loadKnowledgeCatalog(inputSources);
  const sources = catalog.sources;
  const coverage = { ...catalog.coverage };
  const diagnostics = [...catalog.diagnostics];
  const candidates = catalog.records.filter((entry) => entry.record.status === "approved");
  const ids = new Map();
  for (const entry of candidates) {
    const list = ids.get(entry.id) || [];
    list.push(entry);
    ids.set(entry.id, list);
  }
  const records = [];
  for (const [id, entries] of [...ids.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.length > 1) {
      coverage.failed += entries.length;
      for (const entry of entries) diagnostics.push({ code: "duplicate-id", message: `Approved knowledge ID ${id} exists more than once; no copy was indexed.`, sourceId: entry.sourceId, relativePath: entry.relativePath });
    } else {
      records.push(entries[0]);
    }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  coverage.approved = records.length;
  coverage.complete = coverage.failed === 0;
  return {
    schemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION,
    status: sources.length === 0 ? "not-applicable" : coverage.complete ? "complete" : records.length ? "partial" : "failed",
    coverage,
    sources,
    records,
    diagnostics: diagnostics.sort((a, b) => `${a.sourceId}:${a.relativePath}:${a.code}`.localeCompare(`${b.sourceId}:${b.relativePath}:${b.code}`)),
  };
}

function terms(value) {
  return String(value || "").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) || [];
}

export function searchKnowledgeIndex(index, query, { scopes = ["project", "team"], limit = 20 } = {}) {
  if (!index || index.schemaVersion !== KNOWLEDGE_INDEX_SCHEMA_VERSION || !Array.isArray(index.records)) throw new TypeError("Unsupported knowledge index.");
  const needles = terms(query);
  if (!needles.length) return [];
  const allowedScopes = new Set(scopes);
  const cap = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 20));
  return index.records.filter((entry) => allowedScopes.has(entry.scope)).map((entry) => {
    const weighted = [
      [entry.id, 12], [entry.title, 10], [entry.tags.join(" "), 7],
      [entry.appliesTo.join(" "), 6], [entry.kind, 4],
      [Object.values(entry.record.body).join(" "), 1],
    ];
    let score = 0;
    for (const needle of needles) {
      for (const [field, weight] of weighted) if (terms(field).includes(needle)) score += weight;
    }
    return { entry, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, cap)
    .map(({ entry, score }) => ({ id: entry.id, title: entry.title, scope: entry.scope, kind: entry.kind, confidence: entry.confidence, tags: [...entry.tags], appliesTo: [...entry.appliesTo], sourceId: entry.sourceId, relativePath: entry.relativePath, score }));
}

export function knowledgeIndexDigest(index) {
  return createHash("sha256").update(JSON.stringify(index)).digest("hex");
}
