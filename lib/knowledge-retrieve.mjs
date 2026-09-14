/** Semantic-first knowledge retrieval over authorized registry sources.
 *
 * Ordering guarantee: source authorization happens BEFORE any document read,
 * so content from unauthorized sources never enters the caller's context.
 *
 * Ranking: cosine similarity over an injected embedder when one is provided
 * and works ("semantic" mode). Without a working embedder the module falls
 * back to lexical token overlap and labels the result degraded — never
 * presented as semantic success.
 */

import { readSourceDocuments } from "./knowledge-read.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function lexicalScore(queryTokens, text) {
  const counts = new Map();
  for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) || 0) + 1);
  let score = 0;
  for (const tok of queryTokens) if (counts.has(tok)) score += 1 + Math.min(counts.get(tok) - 1, 2) * 0.25;
  return score / Math.max(queryTokens.length, 1);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const normalizeVec = (v) => {
  const len = Math.hypot(...v) || 1;
  return v.map((x) => x / len);
};

const isValidVectorSet = (raw, expectedLength) => {
  // Indexed loops (not .every) so sparse arrays with holes are rejected.
  if (!Array.isArray(raw) || raw.length !== expectedLength) return false;
  const dim = Array.isArray(raw[0]) ? raw[0].length : 0;
  if (dim === 0) return false;
  for (const v of raw) {
    if (!Array.isArray(v) || v.length !== dim) return false;
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== "number" || !Number.isFinite(v[i])) return false;
    }
  }
  return true;
};

/**
 * Retrieve knowledge for a natural-language query.
 *
 * @param {object} args
 * @param {string} args.query                         conceptual/paraphrased question
 * @param {Array<object>} args.sources                registry sources (normalized or raw)
 * @param {(source: object) => boolean} args.authorize authorization gate; runs BEFORE any read
 * @param {object} [args.embedder]                    { embed(texts: string[]) -> number[][] } (sync or async)
 * @param {object} args.readProvider                  provider for lib/knowledge-read.mjs
 * @param {number} [args.limit]                       max results (default 5)
 * @returns {Promise<{mode: "semantic"|"lexical-only", degraded: boolean, query: string,
 *                    results: Array<{document: object, score: number}>,
 *                    exclusions: Array<{source: string, reason: string}>,
 *                    errors: string[], warnings: string[]}>}
 */
export async function retrieveKnowledge(args) {
  const result = { mode: "lexical-only", degraded: true, query: undefined, results: [], exclusions: [], errors: [], warnings: [] };
  if (!isObject(args)) {
    result.errors.push("invalid-args: retrieveKnowledge requires an options object");
    return result;
  }
  const { query, sources, authorize, embedder, readProvider } = args;
  result.query = query;
  let limit = args.limit === undefined ? 5 : args.limit;
  if (!Number.isInteger(limit) || limit < 0) {
    result.errors.push("invalid-limit: limit must be a non-negative integer");
    return result;
  }
  if (!isNonEmptyString(query)) {
    result.errors.push("invalid-query: query must be a non-empty string");
    return result;
  }
  if (!Array.isArray(sources)) {
    result.errors.push("invalid-sources: sources must be an array");
    return result;
  }
  if (typeof authorize !== "function") {
    result.errors.push("invalid-authorize: authorize must be a function (source) => boolean");
    return result;
  }

  // 1. Authorization gate — BEFORE any content read.
  const authorized = [];
  for (const source of sources) {
    const id = isObject(source) && isNonEmptyString(source.id) ? source.id : "unknown";
    let ok = false;
    try {
      ok = authorize(source) === true;
    } catch (error) {
      result.exclusions.push({ source: id, reason: `authorize-threw: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (ok) authorized.push(source);
    else result.exclusions.push({ source: id, reason: "not-authorized" });
  }

  // 2. Read documents from authorized sources only.
  const docs = [];
  for (const source of authorized) {
    const r = await readSourceDocuments(source, readProvider);
    result.errors.push(...r.errors);
    docs.push(...r.documents);
  }

  // 3. Rank.
  let vectors = null;
  if (isObject(embedder) && typeof embedder.embed === "function") {
    try {
      const raw = await embedder.embed([query, ...docs.map((d) => d.text)]);
      if (isValidVectorSet(raw, docs.length + 1)) {
        vectors = raw.map(normalizeVec);
        result.mode = "semantic";
        result.degraded = false;
      } else {
        result.warnings.push("embedder-malformed-output: expected dense number[][] of uniform finite dimensions, one per input text; degraded to lexical-only");
      }
    } catch (error) {
      result.warnings.push(`embedder-failed: ${error instanceof Error ? error.message : String(error)}; degraded to lexical-only`);
    }
  } else {
    result.warnings.push("no-embedder: degraded to lexical-only");
  }

  const scored = docs.map((doc, i) => ({
    document: doc,
    score: vectors ? cosine(vectors[0], vectors[i + 1]) : lexicalScore(tokenize(query), doc.text),
  }));
  scored.sort((a, b) => b.score - a.score);
  result.results = scored.slice(0, limit);
  return result;
}
