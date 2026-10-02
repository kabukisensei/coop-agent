// The standards pane's data (master plan D1b2): the coop-standards articles
// coop resolves for this folder, read through lib/standards-cli.mjs exactly as
// a task pins them (`resolve-many`, which also refreshes a stale canonical
// copy), with source and freshness from `status`. Read-only: the pane shows
// the resolved snapshot each domain feeds the model, never a second copy.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DOMAINS = Object.freeze(["sql", "dax", "semantic_model", "fabric", "documentation"]);
export const DOMAIN_LABELS = Object.freeze({ sql: "SQL", dax: "DAX", semantic_model: "Semantic model", fabric: "Fabric", documentation: "Documentation" });
const MAX_SNAPSHOT = 2 * 1024 * 1024;

function runCli({ node, cli, args, cwd, env, execFileImpl = execFile }) {
  return new Promise((resolve, reject) => {
    execFileImpl(node, [cli, ...args], { cwd, env, windowsHide: true, timeout: 90_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || error.message).trim().split("\n").pop() || "the standards resolver failed")); return; }
      try { resolve(JSON.parse(String(stdout))); } catch { reject(new Error("the standards resolver returned no result")); }
    });
  });
}

const text = (value) => (typeof value === "string" ? value : "");

/** The pane's summary of one domain's resolution (no paths cross to the window). */
export function domainView(domain, resolution) {
  const r = resolution && typeof resolution === "object" ? resolution : {};
  const articles = Array.isArray(r.articles) ? r.articles : [];
  return {
    domain,
    label: DOMAIN_LABELS[domain] || domain,
    state: text(r.state) || "unavailable",
    authority: text(r.authority_class),
    source: text(r.source),
    revision: text(r.revision || r.commit).slice(0, 12),
    branch: text(r.branch),
    fallback: Boolean(r.fallback),
    degraded: Boolean(r.degraded),
    available: Boolean(r.path),
    articles: articles.map((a) => ({ id: text(a.id), title: text(a.title) || text(a.file), file: text(a.file), layer: text(a.layer), technology: text(a.technology) })),
  };
}

/** The pane's summary of `standards-cli.mjs status`. */
export function sourceView(status) {
  const s = status && typeof status === "object" ? status : {};
  const bundle = s.bundle && typeof s.bundle === "object" ? s.bundle : {};
  return {
    repository: text(s.repository),
    branch: text(s.authoritative_branch),
    freshness: text(s.freshness) || "unknown",
    degraded: Boolean(s.degraded),
    lastCheckMs: Number.isFinite(s.last_successful_check_ms) ? s.last_successful_check_ms : null,
    lastAttemptOk: s.last_attempt_ok !== false,
    detail: text(s.detail),
    bundle: { state: text(bundle.state) || "unavailable", revision: text(bundle.revision).slice(0, 12), capturedMs: Number.isFinite(bundle.captured_ms) ? bundle.captured_ms : null },
  };
}

/**
 * Resolve every domain for the folder. Returns { source, domains, snapshots }
 * where snapshots maps a domain to the resolved snapshot's path (kept in main;
 * the window asks for a domain's text by name).
 */
export async function readStandards({ node, repoRoot, cwd, env, execFileImpl }) {
  const cli = join(repoRoot, "lib", "standards-cli.mjs");
  // Resolve first: it refreshes a stale canonical copy, which status then reports.
  const resolved = await runCli({ node, cli, args: ["resolve-many", DOMAINS.join(","), cwd], cwd, env, execFileImpl });
  const status = await runCli({ node, cli, args: ["status"], cwd, env, execFileImpl }).catch(() => ({}));
  const snapshots = new Map();
  const domains = DOMAINS.map((domain) => {
    const resolution = resolved[domain];
    if (resolution && typeof resolution.path === "string" && resolution.path) snapshots.set(domain, resolution.path);
    return domainView(domain, resolution);
  });
  return { source: sourceView(status), domains, snapshots };
}

/** One resolved snapshot's Markdown, bounded. */
export async function readSnapshot(path, { readFileImpl = readFile } = {}) {
  const bytes = await readFileImpl(path);
  const body = bytes.length > MAX_SNAPSHOT ? bytes.subarray(0, MAX_SNAPSHOT) : bytes;
  // The first line is coop's provenance comment, not part of any article.
  return { text: body.toString("utf8").replace(/^<!--[\s\S]*?-->\s*/, ""), truncated: bytes.length > MAX_SNAPSHOT };
}
