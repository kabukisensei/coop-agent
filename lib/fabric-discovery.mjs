// Fabric ids looked up by name for /setup-project (suite review 2026-10-26, pick 10).
//
// The wizard used to ask for up to eight GUIDs typed by hand. This resolves a
// workspace or SQL item by its name with read-only Fabric REST GETs, using the
// Azure CLI token the launch preflight already signed in for, so the person
// confirms a proposal (Enter) instead of pasting ids. Anything missing (no az,
// no sign-in, no network, an ambiguous name) resolves to "" and the question
// keeps its typed fallback; nothing here writes or changes a Fabric item.

const FABRIC = "https://api.fabric.microsoft.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/i;
/** The item types that carry a SQL endpoint coop can target. */
export const SQL_ITEM_TYPES = Object.freeze(["Warehouse", "Lakehouse", "SQLDatabase"]);
const MAX_PAGES = 10;

export const isUuid = (value) => UUID.test(String(value || "").trim());
const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * The Azure CLI call for `exec`. On Windows az is a batch file (az.cmd, the MSI
 * and the coop window package alike) and Node's spawn without a shell, which is
 * what Pi's exec is, refuses a .cmd, so the call goes through cmd.exe the way
 * the person's own shell runs it (one argument string; the args carry no quotes:
 * a fixed resource and a tenant the TENANT pattern has checked). Elsewhere `az`
 * is an executable and runs as it is. The dev VM, 2026-10-27: every lookup
 * answered "" there, so a name typed where an id is asked never resolved.
 */
export function azureCliInvocation(args, platform = process.platform, env = process.env) {
  if (platform !== "win32") return { command: "az", args };
  const comspec = typeof env.ComSpec === "string" && env.ComSpec ? env.ComSpec : "cmd.exe";
  return { command: comspec, args: ["/d", "/s", "/c", ["az", ...args].join(" ")] };
}

/**
 * One discovery per wizard run. `exec(command, args, options)` is Pi's exec
 * (resolves to { code, stdout }); `fetchFn` is the global fetch unless a test
 * passes its own. Every lookup is cached, so a name is resolved once.
 */
export function fabricDiscovery({ exec, tenant = "", fetchFn = globalThis.fetch, timeoutMs = 8000, platform = process.platform, env = process.env } = {}) {
  let tokenPromise = null;
  const pages = new Map();

  async function token() {
    if (typeof exec !== "function") return "";
    if (!tokenPromise) {
      tokenPromise = (async () => {
        try {
          const args = ["account", "get-access-token", "--resource", FABRIC, "--output", "json"];
          if (tenant && TENANT.test(tenant)) args.push("--tenant", tenant);
          const call = azureCliInvocation(args, platform, env);
          const res = await exec(call.command, call.args, { timeout: timeoutMs });
          const code = res && typeof res.code === "number" ? res.code : res?.exitCode;
          if (code !== 0) return "";
          const parsed = JSON.parse(String(res.stdout || ""));
          return typeof parsed?.accessToken === "string" && parsed.accessToken ? parsed.accessToken : "";
        } catch {
          return "";
        }
      })();
    }
    return tokenPromise;
  }

  async function getJson(url) {
    const bearer = await token();
    if (!bearer || typeof fetchFn !== "function") return null;
    try {
      const response = await fetchFn(url, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response || !response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /** Every `value` entry of a paged list ([] when the call fails). */
  function list(path) {
    if (!pages.has(path)) {
      pages.set(path, (async () => {
        const out = [];
        let url = `${FABRIC}/v1/${path}`;
        for (let page = 0; url && page < MAX_PAGES; page++) {
          const body = await getJson(url);
          if (!body || !Array.isArray(body.value)) break;
          out.push(...body.value);
          url = typeof body.continuationUri === "string" && body.continuationUri.startsWith(`${FABRIC}/`) ? body.continuationUri : "";
        }
        return out;
      })());
    }
    return pages.get(path);
  }

  const api = {
    /** [{ id, name }] of the workspaces the signed-in account can see. */
    async workspaces() {
      return (await list("workspaces"))
        .filter((w) => isUuid(w?.id) && typeof w?.displayName === "string")
        .map((w) => ({ id: w.id.toLowerCase(), name: w.displayName }));
    },
    /** The id of the one workspace with this name, else "". */
    async workspaceId(name) {
      if (!String(name || "").trim()) return "";
      const hits = (await api.workspaces()).filter((w) => sameName(w.name, name));
      return hits.length === 1 ? hits[0].id : "";
    },
    /** A workspace id as typed, or the id of the workspace named. */
    async resolveWorkspace(value) {
      const v = String(value || "").trim();
      return isUuid(v) ? v.toLowerCase() : api.workspaceId(v);
    },
    /** [{ id, name, type }] of the workspace's Warehouse, Lakehouse and SQL database items. */
    async sqlItems(workspaceId) {
      const ws = String(workspaceId || "").trim().toLowerCase();
      if (!isUuid(ws)) return [];
      return (await list(`workspaces/${ws}/items`))
        .filter((item) => isUuid(item?.id) && typeof item?.displayName === "string" && SQL_ITEM_TYPES.includes(item?.type))
        .map((item) => ({ id: item.id.toLowerCase(), name: item.displayName, type: item.type }));
    },
    /** The one SQL item with this name (and type, when given), else null. */
    async sqlItem(workspaceId, name, type = "") {
      if (!String(name || "").trim()) return null;
      const hits = (await api.sqlItems(workspaceId)).filter((item) => sameName(item.name, name) && (!type || item.type === type));
      return hits.length === 1 ? hits[0] : null;
    },
    /** An item id as typed, or the id of the item named in the workspace. */
    async resolveItem(workspaceId, value, type = "") {
      const v = String(value || "").trim();
      if (isUuid(v)) return v.toLowerCase();
      const item = await api.sqlItem(workspaceId, v, type);
      return item ? item.id : "";
    },
    /** A Lakehouse's SQL endpoint id (properties.sqlEndpointProperties.id), else "". */
    async lakehouseEndpointId(workspaceId, itemId) {
      const ws = String(workspaceId || "").trim().toLowerCase();
      const id = String(itemId || "").trim().toLowerCase();
      if (!isUuid(ws) || !isUuid(id)) return "";
      const key = `workspaces/${ws}/lakehouses/${id}`;
      if (!pages.has(key)) pages.set(key, getJson(`${FABRIC}/v1/${key}`));
      const body = await pages.get(key);
      const endpoint = body?.properties?.sqlEndpointProperties?.id;
      return isUuid(endpoint) ? String(endpoint).toLowerCase() : "";
    },
  };
  return api;
}
