import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { buildKnowledgeIndex, loadKnowledgeCatalog, parseKnowledgeMarkdown, searchKnowledgeIndex } from "./knowledge-index.mjs";
import { authorizeKnowledgeTransition, validateKnowledgeRecord } from "./knowledge-policy.mjs";

export const KNOWLEDGE_SERVICE_VERSION = 1;
const MAX_PROPOSALS = 20;

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function yamlValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function renderMap(lines, name, value) {
  lines.push(`${name}:`);
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      lines.push(`  ${key}:`);
      for (const listItem of item) lines.push(`    - ${yamlValue(listItem)}`);
    } else {
      lines.push(`  ${key}: ${yamlValue(item)}`);
    }
  }
}

export function renderKnowledgeMarkdown(input) {
  const record = validateKnowledgeRecord(input);
  const lines = [
    "---",
    `schemaVersion: ${record.schemaVersion}`,
    `id: ${yamlValue(record.id)}`,
    `title: ${yamlValue(record.title)}`,
    `kind: ${record.kind}`,
    `scope: ${record.scope}`,
    `sensitivity: ${record.sensitivity}`,
    `status: ${record.status}`,
    `confidence: ${record.confidence}`,
    `tags: ${yamlValue(record.tags)}`,
    `appliesTo: ${yamlValue(record.appliesTo)}`,
  ];
  renderMap(lines, "source", record.source);
  lines.push(`createdAt: ${yamlValue(record.createdAt)}`, `createdBy: ${yamlValue(record.createdBy)}`);
  renderMap(lines, "review", record.review);
  renderMap(lines, "project", record.project);
  renderMap(lines, "sanitization", record.sanitization);
  lines.push(
    `supersedes: ${yamlValue(record.supersedes)}`,
    `supersededBy: ${yamlValue(record.supersededBy)}`,
    "---",
  );
  const sections = [
    ["Context", "context"], ["Problem", "problem"], ["Why it happens", "why"],
    ["Approved pattern", "approvedPattern"], ["Anti-pattern", "antiPattern"],
    ["Detection method", "detection"], ["Example", "example"],
    ["Exceptions", "exceptions"], ["Sources", "sources"],
  ];
  for (const [heading, field] of sections) lines.push(`## ${heading}`, "", record.body[field].trim(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function writeSynced(path, content, flags, mode = 0o600) {
  const fd = openSync(path, flags, mode);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function transitionOperation(status) {
  return ({ approved: "knowledge.approve", rejected: "knowledge.reject", deprecated: "knowledge.deprecate", superseded: "knowledge.supersede" })[status] || null;
}

export class KnowledgeService {
  constructor({ sources, stateDir, createId = () => randomUUID() } = {}) {
    if (typeof stateDir !== "string" || !stateDir) throw new TypeError("Knowledge service state directory is required.");
    loadKnowledgeCatalog(sources || []); // validates every configured Git boundary before accepting it
    this.sources = (sources || []).map((source) => ({ ...source, root: realpathSync(resolve(source.root)) }));
    this.sourceById = new Map(this.sources.map((source) => [source.id, source]));
    this.stateDir = resolve(stateDir);
    this.createId = createId;
    this.proposals = new Map();
  }

  catalog() {
    return loadKnowledgeCatalog(this.sources);
  }

  index() {
    return buildKnowledgeIndex(this.sources);
  }

  search(query, options) {
    return searchKnowledgeIndex(this.index(), query, options);
  }

  #source(sourceId) {
    const source = this.sourceById.get(sourceId);
    if (!source) throw new TypeError("Unknown knowledge source ID.");
    return source;
  }

  #target(source, recordId) {
    if (typeof recordId !== "string" || !/^knowledge\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(recordId)) throw new TypeError("Knowledge record ID is invalid.");
    return { relativePath: `${recordId}.md`, targetPath: resolve(source.root, `${recordId}.md`) };
  }

  #matchSource(record, source) {
    if (record.scope !== source.scope) throw new TypeError("Knowledge record scope does not match its selected repository.");
    if (source.scope === "project" && record.project.projectId !== source.projectId) throw new TypeError("Knowledge record project does not match its selected repository.");
  }

  #remember(proposal) {
    this.proposals.set(proposal.proposalId, proposal);
    while (this.proposals.size > MAX_PROPOSALS) this.proposals.delete(this.proposals.keys().next().value);
    const { targetPath: _targetPath, content: _content, ...publicProposal } = proposal;
    return structuredClone(publicProposal);
  }

  previewCreate({ sourceId, record: input }) {
    const source = this.#source(sourceId);
    const record = validateKnowledgeRecord(input);
    if (record.status !== "proposed") throw new TypeError("New knowledge must enter source control as proposed.");
    this.#matchSource(record, source);
    const { relativePath, targetPath } = this.#target(source, record.id);
    if (existsSync(targetPath)) throw new TypeError("A knowledge record with that ID already exists in the selected repository.");
    const content = renderKnowledgeMarkdown(record);
    return this.#remember({
      schemaVersion: KNOWLEDGE_SERVICE_VERSION,
      proposalId: `knowledge-${this.createId()}`,
      operation: "knowledge.propose",
      sourceId,
      relativePath,
      recordId: record.id,
      fromStatus: null,
      toStatus: "proposed",
      baseDigest: null,
      requiresApproval: true,
      preview: { before: null, after: content },
      targetPath,
      content,
    });
  }

  previewTransition({ sourceId, recordId, record: input }) {
    const source = this.#source(sourceId);
    const { relativePath, targetPath } = this.#target(source, recordId);
    if (!existsSync(targetPath)) throw new TypeError("That canonical knowledge record does not exist in the selected repository.");
    const before = readFileSync(targetPath, "utf8");
    const previous = parseKnowledgeMarkdown(before, `${sourceId}:${relativePath}`);
    const next = authorizeKnowledgeTransition(previous, input, { actorType: "human" });
    this.#matchSource(next, source);
    const operation = transitionOperation(next.status);
    if (!operation || previous.status === next.status) throw new TypeError("Choose a supported knowledge lifecycle change.");
    if (next.status === "superseded") {
      const replacementTarget = this.#target(source, next.supersededBy).targetPath;
      if (!existsSync(replacementTarget)) throw new TypeError("The superseding record does not exist in the selected repository.");
      const replacement = parseKnowledgeMarkdown(readFileSync(replacementTarget, "utf8"), `${sourceId}:${next.supersededBy}.md`);
      if (replacement.status !== "approved" || replacement.supersedes !== next.id) {
        throw new TypeError("The superseding record must already be approved and point back to this record.");
      }
    }
    const content = renderKnowledgeMarkdown(next);
    return this.#remember({
      schemaVersion: KNOWLEDGE_SERVICE_VERSION,
      proposalId: `knowledge-${this.createId()}`,
      operation,
      sourceId,
      relativePath,
      recordId,
      fromStatus: previous.status,
      toStatus: next.status,
      baseDigest: digest(before),
      requiresApproval: true,
      preview: { before, after: content },
      targetPath,
      content,
    });
  }

  apply({ proposalId, approved }) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new TypeError("That knowledge proposal is unavailable.");
    if (approved !== true) throw new TypeError(`Explicit approval for ${proposal.operation} is required.`);
    const current = existsSync(proposal.targetPath) ? readFileSync(proposal.targetPath, "utf8") : null;
    const currentDigest = current === null ? null : digest(current);
    if (currentDigest !== proposal.baseDigest) return { state: "stale", proposalId, recordId: proposal.recordId, sourceId: proposal.sourceId, relativePath: proposal.relativePath, backupId: null };
    let backupId = null;
    if (current === null) {
      writeSynced(proposal.targetPath, proposal.content, "wx");
    } else {
      const info = statSync(proposal.targetPath);
      backupId = `${proposal.proposalId}.md`;
      const backupDir = resolve(this.stateDir, "knowledge-backups", "v1");
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      writeSynced(resolve(backupDir, backupId), current, "wx", 0o600);
      const tempPath = resolve(this.sourceById.get(proposal.sourceId).root, `.${proposal.proposalId}.tmp`);
      try {
        writeSynced(tempPath, proposal.content, "wx", info.mode & 0o777);
        renameSync(tempPath, proposal.targetPath);
      } catch (error) {
        try { unlinkSync(tempPath); } catch { /* nothing to clean */ }
        throw error;
      }
    }
    this.proposals.delete(proposalId);
    return {
      state: "applied",
      proposalId,
      operation: proposal.operation,
      recordId: proposal.recordId,
      sourceId: proposal.sourceId,
      relativePath: proposal.relativePath,
      fromStatus: proposal.fromStatus,
      toStatus: proposal.toStatus,
      backupId,
      gitCommitCreated: false,
    };
  }

  proposalWriteRoot(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new TypeError("That knowledge proposal is unavailable.");
    return this.#source(proposal.sourceId).root;
  }

  discardProposal(proposalId) {
    this.proposals.delete(proposalId);
  }
}
