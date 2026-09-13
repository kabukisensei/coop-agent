import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const ENVIRONMENT_DISCOVERY_SCHEMA_VERSION = 1;
const FABRIC_ORIGIN = "https://api.fabric.microsoft.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_TYPES = new Set(["DataPipeline", "Eventhouse", "KQLDatabase", "KQLQueryset", "Lakehouse", "Notebook", "PaginatedReport", "Report", "SemanticModel", "SQLDatabase", "Warehouse"]);
const MAX_PAGES = 20;
const MAX_CANDIDATES = 5000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function diagnostic(code, severity, message) { return { code, severity, message }; }
function coverage(attempted, completed, pages, complete) { return { attempted, completed, pages, complete }; }

function result({ kind, requestId, status, scope, candidates = [], diagnostics = [], attempted = 0, completed = 0, pages = 0, complete = false }) {
  return {
    schemaVersion: ENVIRONMENT_DISCOVERY_SCHEMA_VERSION,
    requestId,
    kind,
    status,
    readOnly: true,
    scope,
    coverage: coverage(attempted, completed, pages, complete),
    candidates,
    diagnostics,
  };
}

export function assertFabricDiscoveryUrl(value) {
  const url = new URL(value);
  if (url.origin !== FABRIC_ORIGIN || url.protocol !== "https:") throw new TypeError("Fabric discovery URL is outside the allowlisted API origin.");
  const path = url.pathname;
  const allowed = path === "/v1/workspaces" || /^\/v1\/workspaces\/[0-9a-f-]{36}\/items$/i.test(path);
  if (!allowed) throw new TypeError("Fabric discovery URL is outside the allowlisted read-only paths.");
  for (const key of url.searchParams.keys()) {
    if (!["continuationToken", "type"].includes(key)) throw new TypeError("Fabric discovery URL contains an unsupported query parameter.");
  }
  if (url.searchParams.has("type") && !ITEM_TYPES.has(url.searchParams.get("type"))) throw new TypeError("Fabric discovery URL contains an unsupported item type.");
  if ((url.searchParams.get("continuationToken") || "").length > 4096) throw new TypeError("Fabric continuation token exceeds the safety limit.");
  return url;
}

async function defaultRequestJson(value) {
  const url = assertFabricDiscoveryUrl(value).toString();
  const command = process.env.COOP_AZ_BIN || "az";
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, ["rest", "--method", "get", "--url", url, "--output", "json", "--only-show-errors"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let oversized = false;
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout, "utf8") + chunk.length > MAX_RESPONSE_BYTES) { oversized = true; child.kill(); return; }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (oversized) { reject(new Error("Fabric discovery response exceeded the 8 MiB safety limit.")); return; }
      if (code !== 0) { reject(new Error(stderr.trim() || "Azure CLI could not read Fabric metadata.")); return; }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("Azure CLI returned invalid Fabric discovery JSON.")); }
    });
  });
}

function canonicalLocal(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function localCandidate(path) {
  const canonical = canonicalLocal(path);
  const marker = join(canonical, ".git");
  if (!existsSync(marker)) return null;
  return {
    candidateId: `local:${createHash("sha256").update(canonical).digest("hex")}`,
    resourceType: "Repository",
    resourceId: canonical,
    displayName: basename(canonical) || canonical,
    workspaceId: null,
    workspaceName: null,
    metadata: { localPath: canonical, gitMarker: statSync(marker).isDirectory() ? "directory" : "file" },
  };
}

export async function discoverLocalRepositories({ workspace, requestId = randomUUID() }) {
  const root = canonicalLocal(workspace);
  let rootStat;
  try { rootStat = statSync(root); } catch {
    return result({ kind: "local-repositories", requestId, status: "not-configured", scope: { workspacePath: root, workspaceId: null, itemTypes: [] }, diagnostics: [diagnostic("workspace-missing", "error", "The selected workspace directory does not exist.")] });
  }
  if (!rootStat.isDirectory()) throw new TypeError("Workspace must be a directory.");
  const candidates = [];
  const own = localCandidate(root);
  if (own) candidates.push(own);
  for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, 500)) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "vendor"].includes(entry.name)) continue;
    const path = canonicalLocal(join(root, entry.name));
    if (path !== root && !path.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) continue;
    const candidate = localCandidate(path);
    if (candidate) candidates.push(candidate);
  }
  return result({ kind: "local-repositories", requestId, status: "complete", scope: { workspacePath: root, workspaceId: null, itemTypes: [] }, candidates, attempted: 1, completed: 1, pages: 1, complete: true });
}

function fabricCandidate(item, { workspaceId = null, workspaceName = null, resourceType = null } = {}) {
  const id = typeof item?.id === "string" ? item.id : "";
  const displayName = typeof item?.displayName === "string" ? item.displayName.trim() : "";
  const type = resourceType || (typeof item?.type === "string" ? item.type : "Item");
  if (!id || !displayName) return null;
  const metadata = {};
  for (const key of ["type", "description", "capacityId", "capacityRegion", "folderId"]) {
    if (["string", "number", "boolean"].includes(typeof item[key])) metadata[key] = item[key];
  }
  return { candidateId: `${type}:${workspaceId || "tenant"}:${id}`, resourceType: type, resourceId: id, displayName, workspaceId, workspaceName, metadata };
}

function nextUrl(base, continuationToken) {
  const url = new URL(base);
  if (continuationToken) url.searchParams.set("continuationToken", continuationToken);
  return assertFabricDiscoveryUrl(url).toString();
}

async function pagedCandidates({ baseUrl, mapPage, requestJson }) {
  const candidates = [];
  let token = null;
  let pages = 0;
  let partial = false;
  let failure = false;
  do {
    let page;
    try { page = await requestJson(nextUrl(baseUrl, token)); }
    catch (error) {
      if (pages === 0) throw error;
      partial = true;
      failure = true;
      break;
    }
    pages += 1;
    let mapped;
    try { mapped = mapPage(page); }
    catch (error) {
      if (pages === 1) throw error;
      partial = true;
      failure = true;
      break;
    }
    for (const candidate of mapped) {
      if (candidate) candidates.push(candidate);
      if (candidates.length >= MAX_CANDIDATES) { partial = true; break; }
    }
    token = typeof page?.continuationToken === "string" && page.continuationToken ? page.continuationToken : null;
    if (pages >= MAX_PAGES && token) partial = true;
  } while (token && !partial);
  return { candidates, pages, partial, failure };
}

function safeFailure(kind, requestId, scope, error) {
  const unavailable = error?.code === "ENOENT";
  return result({
    kind,
    requestId,
    status: unavailable ? "unavailable" : "failed",
    scope,
    diagnostics: [diagnostic(unavailable ? "azure-cli-unavailable" : "fabric-discovery-failed", "error", unavailable ? "Azure CLI is not installed or not available to the Coop runtime." : "Fabric metadata discovery failed. Re-authenticate or inspect Coop Health, then retry.")],
    attempted: 1,
  });
}

export async function discoverFabricWorkspaces({ requestJson = defaultRequestJson, requestId = randomUUID() } = {}) {
  const kind = "fabric-workspaces";
  const scope = { workspacePath: null, workspaceId: null, itemTypes: [] };
  try {
    const fetched = await pagedCandidates({
      baseUrl: `${FABRIC_ORIGIN}/v1/workspaces`,
      requestJson,
      mapPage: (page) => {
        if (!Array.isArray(page?.value)) throw new Error("Fabric workspace discovery response is missing its value array.");
        return page.value.map((item) => fabricCandidate(item, { resourceType: "Workspace" }));
      },
    });
    const code = fetched.failure ? "discovery-incomplete" : "discovery-truncated";
    const message = fetched.failure ? "Workspace discovery stopped after a later page failed; the returned candidates are incomplete." : "Workspace discovery reached its safety limit; refine the environment scope.";
    return result({ kind, requestId, status: fetched.partial ? "partial" : "complete", scope, candidates: fetched.candidates, diagnostics: fetched.partial ? [diagnostic(code, "warning", message)] : [], attempted: 1, completed: fetched.pages > 0 ? 1 : 0, pages: fetched.pages, complete: !fetched.partial });
  } catch (error) { return safeFailure(kind, requestId, scope, error); }
}

export async function discoverFabricItems({ workspaceId, workspaceName = null, itemTypes = [], requestJson = defaultRequestJson, requestId = randomUUID(), kind = "fabric-items" } = {}) {
  if (!UUID.test(workspaceId || "")) throw new TypeError("A valid Fabric workspace ID is required.");
  const types = kind === "semantic-models" ? ["SemanticModel"] : [...new Set(itemTypes)];
  for (const type of types) if (!ITEM_TYPES.has(type)) throw new TypeError(`Unsupported Fabric item type: ${type}`);
  const scope = { workspacePath: null, workspaceId, itemTypes: types };
  try {
    const all = [];
    let pages = 0;
    let partial = false;
    let failedAfterProgress = false;
    let completed = 0;
    const queries = types.length ? types : [null];
    for (const type of queries) {
      const url = new URL(`${FABRIC_ORIGIN}/v1/workspaces/${workspaceId}/items`);
      if (type) url.searchParams.set("type", type);
      let fetched;
      try {
        fetched = await pagedCandidates({
          baseUrl: url.toString(),
          requestJson,
          mapPage: (page) => {
            if (!Array.isArray(page?.value)) throw new Error("Fabric item discovery response is missing its value array.");
            return page.value.map((item) => fabricCandidate(item, { workspaceId, workspaceName }));
          },
        });
      } catch (error) {
        if (all.length === 0) throw error;
        partial = true;
        failedAfterProgress = true;
        break;
      }
      all.push(...fetched.candidates);
      pages += fetched.pages;
      completed += 1;
      partial ||= fetched.partial || all.length >= MAX_CANDIDATES;
      failedAfterProgress ||= fetched.failure;
      if (partial) break;
    }
    const unique = [...new Map(all.slice(0, MAX_CANDIDATES).map((candidate) => [candidate.candidateId, candidate])).values()];
    const code = failedAfterProgress ? "discovery-incomplete" : "discovery-truncated";
    const message = failedAfterProgress ? "Item discovery stopped after a later read failed; the returned candidates are incomplete." : "Item discovery reached its safety limit; select a narrower item type.";
    return result({ kind, requestId, status: partial ? "partial" : "complete", scope, candidates: unique, diagnostics: partial ? [diagnostic(code, "warning", message)] : [], attempted: queries.length, completed, pages, complete: !partial });
  } catch (error) { return safeFailure(kind, requestId, scope, error); }
}

export function resolveDiscoveryCandidate(candidates, { resourceType, displayName, workspaceId = null }) {
  const wantedName = String(displayName || "").trim().toLocaleLowerCase();
  const wantedType = String(resourceType || "").trim().toLocaleLowerCase();
  if (!wantedName || !wantedType) throw new TypeError("Resource type and display name are required.");
  const matches = candidates.filter((candidate) =>
    candidate.resourceType.toLocaleLowerCase() === wantedType &&
    candidate.displayName.trim().toLocaleLowerCase() === wantedName &&
    (!workspaceId || candidate.workspaceId === workspaceId || candidate.resourceId === workspaceId),
  );
  if (matches.length === 1) return { state: "resolved", candidate: matches[0], candidates: matches };
  if (matches.length > 1) return { state: "ambiguous", candidate: null, candidates: matches };
  const suggestions = candidates.filter((candidate) => candidate.resourceType.toLocaleLowerCase() === wantedType && candidate.displayName.toLocaleLowerCase().includes(wantedName));
  return { state: "not-found", candidate: null, candidates: suggestions };
}
