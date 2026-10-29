// The project contract (.coop/project.yml) as /setup-project and the coop
// window's project form read and write it: one implementation, used by the
// coop-tools extension (the terminal wizard) and desktop/ (the form), so both
// keep unowned fields, write the same text and take a backup the same way.
//
// The text patcher touches only the scalar paths the wizard owns; comments,
// custom sections, policies and future or unknown keys stay byte for byte.
// Block-style YAML only, dependency-free (no YAML library on fresh machines).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backupPathFor, gitRootAbove, userProfilePath as coopUserProfilePath } from "./paths.mjs";

/** Read just the scalar value off a `key: value` line, quote- and comment-aware.
 *  Handles double-quote backslash escapes and single-quote '' → ' the way YAML
 *  does, and only treats '#' as a comment when it's whitespace-preceded. */
/** YAML double-quoted single-character escapes (YAML 1.2, 5.7). */
const YAML_ESCAPES = Object.freeze({
  "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
  " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029",
});
const YAML_HEX_ESCAPES = Object.freeze({ x: 2, u: 4, U: 8 });

export function scalarValue(afterColon) {
  const s = afterColon.trim();
  if (s.startsWith('"')) {
    // Backslash escapes as YAML reads them, including the \xXX, \uXXXX and
    // \UXXXXXXXX forms coop-data-doc writes for every non-ASCII character.
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") {
        const c = s[i + 1] ?? "";
        const width = YAML_HEX_ESCAPES[c];
        const hex = width ? s.slice(i + 2, i + 2 + width) : "";
        const code = hex.length === width && /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN;
        if (width && code <= 0x10ffff) {
          out += String.fromCodePoint(code);
          i += 1 + width;
          continue;
        }
        out += YAML_ESCAPES[c] ?? c;
        i++;
        continue;
      }
      if (s[i] === '"') break;
      out += s[i];
    }
    return out;
  }
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      out += s[i];
    }
    return out;
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

/**
 * One repository as the wizard and the form edit it.
 * @typedef {{ name: string, description: string, role: "sql" | "powerbi" | "mixed" | "generic",
 *   localPath: string, remoteName: string, defaultBranch: string, isNew?: boolean }} ProjectRepositorySettings
 */

/**
 * The wizard-owned subset of .coop/project.yml. sqlTargetKind is sql_targets.dev
 * (master plan SQ1): a blank kind means no sql_targets block.
 * @typedef {{ organization: string, client: string, timezone: string, defaultBranch: string,
 *   repositories: ProjectRepositorySettings[], fabricEnabled: boolean, powerBiEnabled?: boolean,
 *   tenantId: string, fabricWorkspaceName: string, fabricWorkspaceId: string, sqlEndpointItemType?: string,
 *   sqlEndpointItemName?: string, sqlEndpointItemId?: string, sqlEndpointPropertiesId?: string,
 *   powerBiWorkspaceName: string, powerBiWorkspaceId: string, tabularEditorEnabled: boolean,
 *   tabularEditorPath: string, bpaRulesPath: string, sqlTargetKind: string,
 *   sqlTargetServer: string, sqlTargetDatabase: string, fabricLayout?: string,
 *   tableMappingRule?: string, tableMappingSchema?: string, tableMappingPrefix?: string,
 *   sqlTargetProdServer?: string, sqlTargetProdWorkspaceId?: string, sqlTargetProdItemId?: string,
 *   sqlTargetProdEndpointId?: string, sqlTargetProdDatabase?: string,
 *   sqlTargetTestServer?: string, sqlTargetTestWorkspaceId?: string, sqlTargetTestItemId?: string,
 *   sqlTargetTestEndpointId?: string, sqlTargetTestDatabase?: string,
 *   schemaCompareExclude?: string, schemaCompareRebuild?: string }} ProjectWizardSettings
 *
 * fabricEnabled is the Fabric side (Warehouse / Lakehouse: the fabric: block, the
 * SQL endpoint, fabric_cicd, the Warehouse MCP); powerBiEnabled is the Power BI side
 * (the power_bi: block: workspace, table mapping). A Power BI-only client (Pro or
 * PPU workspaces on Azure SQL, no Fabric capacity) answers No / Yes and gets no
 * empty fabric: block, which would otherwise make the Warehouse target invalid.
 * A file read without the Power BI answer (older contracts) follows its power_bi:
 * block, else the Fabric answer.
 *
 * The test and prod entries share the dev kind (one estate, one engine per client);
 * a blank database means "no entry written" (an existing one is left as it is).
 * schemaCompareExclude / schemaCompareRebuild are comma-separated schema names for
 * the `schema_compare:` section (exclude_schemas, rebuild_tables_in).
 */

/** The wizard's other environments (sql_targets.test, sql_targets.prod) and their settings keys. */
export const SQL_TARGET_OTHER_ENVIRONMENTS = Object.freeze([
  { env: "prod", prefix: "sqlTargetProd", label: "Prod" },
  { env: "test", prefix: "sqlTargetTest", label: "Test" },
]);
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_ ]{0,127}$/;
/** Named target sets (sql_targets.named.<set>, lib/sql_targets.py): the name rule and the cap. */
export const NAMED_SET_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_NAMED_SETS = 20;
export const NAMED_SET_ENVIRONMENTS = Object.freeze(["dev", "test", "prod"]);
export const SCHEMA_COMPARE_DESTRUCTIVE = Object.freeze(["runnable", "commented"]);
/** The per-environment fields of a named set entry and the YAML keys they map to. */
export const NAMED_ENTRY_FIELDS = Object.freeze([
  ["database", "database"], ["server", "server"], ["workspaceId", "workspace_id"], ["itemId", "item_id"], ["endpointId", "sql_endpoint_id"],
]);

/** The child keys of a mapping path, in file order ([] when absent or not a mapping). */
export function projectYamlKeys(text, path) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const hit = findYamlKey(lines, path[depth], start, end, indent);
    if (hit < 0) return [];
    start = hit + 1;
    end = yamlBlockEnd(lines, hit, indent);
    indent = yamlChildIndent(lines, start, end, indent);
  }
  const keys = [];
  for (let i = start; i < end; i++) {
    if (yamlIndent(lines[i]) !== indent) continue;
    const key = yamlLineKey(lines[i]);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** sql_targets.named as wizard settings: [{ name, kind, dev: {...}, test: {...}, prod: {...} }]. */
export function readNamedTargets(text) {
  return projectYamlKeys(text, ["sql_targets", "named"]).slice(0, MAX_NAMED_SETS).map((name) => {
    const set = { name, kind: "" };
    for (const env of NAMED_SET_ENVIRONMENTS) {
      const base = ["sql_targets", "named", name, env];
      const entry = Object.fromEntries(NAMED_ENTRY_FIELDS.map(([field, key]) => [field, projectYamlScalar(text, [...base, key])]));
      if (!set.kind) set.kind = projectYamlScalar(text, [...base, "kind"]).toLowerCase();
      set[env] = entry;
    }
    return set;
  });
}

/** True when a named set's environment entry has a database (the "answered" test the writers use). */
export function namedEntryAnswered(entry) {
  return Boolean(entry && String(entry.database || "").trim());
}

/** The YAML lines of one named set's answered environments at the given indent ([] when none). */
function namedSetLines(set, indent) {
  const pad = " ".repeat(indent);
  const kind = String(set.kind || "").toLowerCase();
  const discovered = SQL_TARGET_DISCOVERED_KINDS.has(kind);
  const lines = [];
  for (const env of NAMED_SET_ENVIRONMENTS) {
    const entry = set[env];
    if (!namedEntryAnswered(entry)) continue;
    lines.push(`${pad}  ${env}:`, `${pad}    kind: ${yamlQuoted(kind)}`);
    if (discovered) {
      lines.push(`${pad}    workspace_id: ${yamlQuoted(canonicalProjectUuid(entry.workspaceId))}`, `${pad}    item_id: ${yamlQuoted(canonicalProjectUuid(entry.itemId))}`);
      if (kind === "fabric_lakehouse") lines.push(`${pad}    sql_endpoint_id: ${yamlQuoted(canonicalProjectUuid(entry.endpointId))}`);
    } else {
      lines.push(`${pad}    server: ${yamlQuoted(String(entry.server || "").toLowerCase())}`);
    }
    lines.push(`${pad}    database: ${yamlQuoted(String(entry.database).trim())}`);
  }
  return lines.length ? [`${pad}${set.name}:`, ...lines] : [];
}

/** Comma-separated schema names -> trimmed, de-duplicated list (order kept). */
export function schemaNameList(value) {
  const out = [];
  for (const raw of String(value || "").split(",")) {
    const name = raw.trim();
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** The names in a comma-separated list that are not plain schema names ([] when all are). */
export function badSchemaNames(value) {
  return schemaNameList(value).filter((name) => !SCHEMA_NAME.test(name));
}

/** `[a, b]`, the flow-list form the wizard writes for schema_compare lists. */
function yamlFlowList(items) {
  return `[${items.map((item) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(item) ? item : yamlQuoted(item))).join(", ")}]`;
}

// --- Project-file gaps (A2, deployment call 2026-10-23) -----------------------
// A project file written by an older coop lacks the sections a current coop reads.
// Nothing fills them in on its own: doctor and the session-start note name them,
// and /setup-project or the Project pane writes them when the person says so.

/** True when a mapping path exists in the YAML text (as a mapping or a scalar). */
export function projectYamlHas(text, path) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const hit = findYamlKey(lines, path[depth], start, end, indent);
    if (hit < 0) return false;
    if (depth === path.length - 1) return true;
    start = hit + 1;
    end = yamlBlockEnd(lines, hit, indent);
    indent = yamlChildIndent(lines, start, end, indent);
  }
  return false;
}

/** The sections a current coop reads that this project file lacks: [{ path, why }]. */
export function projectFileGaps(text) {
  const gaps = [];
  const has = (path) => projectYamlHas(text, path.split("."));
  // Each gap is relative to what the file already declares: a Power BI-only
  // client without sql_targets is not missing anything, a file that names a SQL
  // endpoint or a dev target is.
  if (!has("sql_targets")) {
    if (has("fabric.default_sql_endpoint")) gaps.push({ path: "sql_targets", why: "the SQL connection targets (dev, test, prod); native SQL tools, schema compare and the launch sign-in need it" });
  } else {
    if (!has("sql_targets.prod")) gaps.push({ path: "sql_targets.prod", why: "schema compare's default target" });
    if (!has("schema_compare")) gaps.push({ path: "schema_compare", why: "the shared compare defaults (exclude_schemas, rebuild_tables_in, destructive), so everyone on the team gets the same differences" });
  }
  if (has("fabric") && !has("fabric.layout")) gaps.push({ path: "fabric.layout", why: "the declared Fabric layout coop would otherwise assume" });
  if (has("power_bi") && !has("power_bi.table_mapping")) gaps.push({ path: "power_bi.table_mapping", why: "how a semantic-model table maps to the SQL object it loads" });
  return gaps;
}

/** The agent-visible session note for the gaps (null when there are none). */
export function projectFileGapsNote(text, contractPath) {
  const gaps = projectFileGaps(text);
  if (!gaps.length) return null;
  return `The project file ${contractPath} predates sections this coop reads: ${gaps.map((g) => `${g.path} (${g.why})`).join("; ")}. ` +
    "Nothing is filled in on its own. When the user does SQL, schema compare or semantic-model work that one of them governs, say so once and offer /setup-project (or the Project pane in the coop window), which asks for them and keeps everything else in the file; the team then commits the file.";
}

// --- The declared layout and the semantic-model-to-SQL mapping (master plan C2) ---
// The contract says what coop used to assume: how a semantic-model table maps to
// the SQL object it loads (power_bi.table_mapping) and, for Fabric clients, which
// item kinds hold the SQL (fabric.layout). data_doc lineage and sql_impact read the
// mapping and report a mismatch instead of "no dependents" when it does not hold.

/** fabric.layout values: the Fabric item kinds that hold the client's SQL. */
export const FABRIC_LAYOUTS = Object.freeze(["warehouse", "lakehouse", "sql_database", "mixed"]);
/** power_bi.table_mapping.rule values. */
export const TABLE_MAPPING_RULES = Object.freeze(["same_name", "prefix"]);
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_PREFIX = /^[A-Za-z0-9_]*$/;

/** The fabric.layout to propose: the default SQL endpoint's item type first, then the dev sql_targets kind. */
export function proposedFabricLayout(endpointType, sqlTargetKind) {
  if (endpointType === "Warehouse") return "warehouse";
  if (endpointType === "Lakehouse") return "lakehouse";
  if (sqlTargetKind === "fabric_warehouse") return "warehouse";
  if (sqlTargetKind === "fabric_lakehouse") return "lakehouse";
  if (sqlTargetKind === "fabric_sql_database") return "sql_database";
  return "";
}

/** Read a mapping of scalars at a path ({ key: value }); {} when absent or a flow `{}`. Read-only. */
export function projectYamlMapping(text, path) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const hit = findYamlKey(lines, path[depth], start, end, indent);
    if (hit < 0) return {};
    start = hit + 1;
    end = yamlBlockEnd(lines, hit, indent);
    indent = yamlChildIndent(lines, start, end, indent);
  }
  const out = {};
  for (let i = start; i < end; i++) {
    if (yamlIndent(lines[i]) !== indent) continue;
    const key = yamlLineKey(lines[i]);
    if (!key) continue;
    const body = lines[i].trim();
    out[key] = scalarValue(body.slice(body.indexOf(":") + 1));
  }
  return out;
}

/**
 * The declared mapping of a contract: { declared, rule, defaultSchema, viewPrefix,
 * overrides, layout }. `declared` is false when the contract has no
 * power_bi.table_mapping block (nothing to check against).
 */
export function tableMappingFromContract(text) {
  const rule = projectYamlScalar(text, ["power_bi", "table_mapping", "rule"]);
  return {
    declared: TABLE_MAPPING_RULES.includes(rule),
    rule: TABLE_MAPPING_RULES.includes(rule) ? rule : "same_name",
    defaultSchema: projectYamlScalar(text, ["power_bi", "table_mapping", "default_schema"]) || "dbo",
    viewPrefix: projectYamlScalar(text, ["power_bi", "table_mapping", "view_prefix"]) || "",
    overrides: projectYamlMapping(text, ["power_bi", "table_mapping", "overrides"]),
    layout: projectYamlScalar(text, ["fabric", "layout"]),
  };
}

const sameName = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const splitObject = (qualified) => {
  const parts = String(qualified || "").replace(/[\[\]]/g, "").split(".");
  return parts.length > 1 ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] } : { schema: "", name: parts[0] };
};

/** The SQL object (schema.name) a semantic-model table loads under the mapping. */
export function expectedSqlObject(mapping, tableName) {
  const table = String(tableName || "").trim();
  for (const [key, value] of Object.entries(mapping.overrides || {})) if (sameName(key, table) && value) return value;
  const { schema, name } = splitObject(table);
  if (mapping.rule === "prefix") return `${schema || mapping.defaultSchema}.${mapping.viewPrefix}${name}`;
  return `${schema || mapping.defaultSchema}.${name}`;
}

/**
 * The semantic-model table names that would load schema.name under the mapping:
 * every override pointing at it, else the rule's name(s). [] when the rule
 * cannot name one (a prefix rule and an object without the prefix).
 */
export function expectedModelTables(mapping, schema, name) {
  const target = `${schema || mapping.defaultSchema}.${name}`;
  const fromOverrides = Object.entries(mapping.overrides || {}).filter(([, value]) => sameName(value, target) || sameName(value, name)).map(([key]) => key);
  if (fromOverrides.length) return fromOverrides;
  if (mapping.rule === "prefix") {
    const prefix = mapping.viewPrefix || "";
    if (prefix && !String(name).toLowerCase().startsWith(prefix.toLowerCase())) return [];
    return [String(name).slice(prefix.length)];
  }
  return sameName(schema || mapping.defaultSchema, mapping.defaultSchema) ? [name, target] : [target];
}

const describeRule = (mapping) => mapping.rule === "prefix"
  ? `rule prefix: model table <name> loads ${mapping.defaultSchema}.${mapping.viewPrefix}<name>`
  : `rule same_name: a model table loads the SQL object with the same schema and name (default schema ${mapping.defaultSchema})`;

/**
 * What the declared mapping says about one SQL object, given the semantic-model
 * tables that load it (from the built docs): [] when no mapping is declared,
 * otherwise one or two lines that confirm the match or name the mismatch.
 */
export function mappingCheckLines(mapping, qualifiedName, loadedTables) {
  if (!mapping || !mapping.declared) return [];
  const { schema, name } = splitObject(qualifiedName);
  const object = `${schema || mapping.defaultSchema}.${name}`;
  const expected = expectedModelTables(mapping, schema, name);
  const loaded = (loadedTables || []).map((t) => String(t || "")).filter(Boolean);
  const matched = loaded.filter((table) => expected.some((e) => sameName(e, table) || sameName(splitObject(e).name, splitObject(table).name)));
  const where = "(power_bi.table_mapping in .coop/project.yml)";
  if (!expected.length) {
    return [`Declared mapping does not match ${where}: ${describeRule(mapping)}, but ${object} does not carry the prefix '${mapping.viewPrefix}', so no model table is expected to load it. Add an override under power_bi.table_mapping.overrides if a model does.`];
  }
  const names = expected.map((e) => `'${e}'`).join(" or ");
  if (!loaded.length) {
    return [`Declared mapping does not match ${where}: ${describeRule(mapping)}; a semantic-model table named ${names} would load ${object}, and none is documented. Either the mapping is wrong for this object (add an override) or its model is not in the built docs: do not read this as "no Power BI dependents".`];
  }
  if (!matched.length) {
    return [`Declared mapping does not match ${where}: ${object} is loaded by ${loaded.map((t) => `'${t}'`).join(", ")}, which ${describeRule(mapping)} does not predict (expected ${names}). Add an override under power_bi.table_mapping.overrides or fix the model so the contract stays true.`];
  }
  const extra = loaded.filter((t) => !matched.includes(t));
  return [`Declared mapping holds ${where}: ${matched.map((t) => `'${t}'`).join(", ")} loads ${object} as ${describeRule(mapping)} predicts.${extra.length ? ` Also loaded by ${extra.map((t) => `'${t}'`).join(", ")}, outside the rule.` : ""}`];
}

/** One line for sql_impact when the catalog shows no dependents: what the mapping expects on the Power BI side. */
export function mappingExpectationLine(mapping, schema, name) {
  if (!mapping || !mapping.declared) return "";
  const expected = expectedModelTables(mapping, schema, name);
  if (!expected.length) return `Declared mapping (power_bi.table_mapping, ${describeRule(mapping)}): no semantic-model table is expected to load ${schema || mapping.defaultSchema}.${name}; an override would say otherwise.`;
  return `Declared mapping (power_bi.table_mapping, ${describeRule(mapping)}): a semantic-model table named ${expected.map((e) => `'${e}'`).join(" or ")} is expected to load ${schema || mapping.defaultSchema}.${name}; the catalog cannot see Power BI, so confirm with data_doc lineage before reading this as "no dependents".`;
}

/** The sql_targets kinds lib/sql_targets.py accepts (the Python module is the authority). */
export const SQL_TARGET_KINDS = Object.freeze(["fabric_warehouse", "fabric_lakehouse", "fabric_sql_database", "azure_sql", "synapse_serverless"]);
/** Kinds whose host coop discovers from Fabric ids; the others name a server. */
export const SQL_TARGET_DISCOVERED_KINDS = new Set(["fabric_warehouse", "fabric_lakehouse"]);

/**
 * The dev sql_targets kind to propose for a new contract: the machine's client
 * platform (SQ7) seeds it, the Fabric answer refines it, and the person can
 * still type any kind or blank it (section 8 item 7).
 */
/** The Power BI answer; a settings object without it (older callers) follows the Fabric answer. */
export function powerBiOn(settings) {
  return typeof settings.powerBiEnabled === "boolean" ? settings.powerBiEnabled : Boolean(settings.fabricEnabled);
}

export function proposedSqlTargetKind(platform, fabricEnabled) {
  if (platform === "azure_sql") return "azure_sql";
  if (platform === "both") return fabricEnabled ? "fabric_warehouse" : "azure_sql";
  if (platform === "fabric") return fabricEnabled ? "fabric_warehouse" : "";
  return fabricEnabled ? "fabric_warehouse" : "";
}

/** Derive the engagement's current local-source coverage from wizard repo roles. */
export function estateMode(repositories) {
  if (!repositories.length) return "discovery";
  const roles = new Set(repositories.map((repo) => repo.role));
  return roles.has("mixed") || (roles.has("sql") && roles.has("powerbi")) ? "connected" : "partial";
}

function coverageFor(repositories, role) {
  if (repositories.some((repo) => repo.role === role || repo.role === "mixed")) return "available";
  return repositories.some((repo) => repo.role === "generic") ? "unknown" : "not_available_yet";
}

function yamlLineKey(raw) {
  const body = raw.trim();
  if (!body || body.startsWith("#") || body.startsWith("-")) return null;
  const m = /^(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_.-]+))\s*:/.exec(body);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/''/g, "'");
  if (m[2] !== undefined) {
    try { return JSON.parse(`"${m[2]}"`); } catch { return m[2]; }
  }
  return m[3];
}

function yamlIndent(raw) {
  return raw.length - raw.trimStart().length;
}

function yamlBlockEnd(lines, line, indent) {
  let i = line + 1;
  for (; i < lines.length; i++) {
    const body = lines[i].trim();
    if (!body || body.startsWith("#")) continue;
    if (yamlIndent(lines[i]) <= indent) break;
  }
  return i;
}

/** The indent of a block's child keys: the first content line inside it (so a
 *  hand-indented file reads the same as the 2-space one the wizard writes),
 *  else the parent's indent + 2 for an empty block. */
function yamlChildIndent(lines, start, end, parentIndent) {
  for (let i = start; i < end; i++) {
    const body = lines[i].trim();
    if (!body || body.startsWith("#")) continue;
    const indent = yamlIndent(lines[i]);
    return indent > parentIndent ? indent : parentIndent + 2;
  }
  return parentIndent + 2;
}

function findYamlKey(lines, key, start, end, indent) {
  for (let i = start; i < end; i++) {
    if (yamlIndent(lines[i]) === indent && yamlLineKey(lines[i]) === key) return i;
  }
  return -1;
}

/** Read a scalar at a simple mapping path. Exported for contract-wizard tests. */
export function projectYamlScalar(text, path) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const hit = findYamlKey(lines, path[depth], start, end, indent);
    if (hit < 0) return "";
    const body = lines[hit].trim();
    if (depth === path.length - 1) return scalarValue(body.slice(body.indexOf(":") + 1));
    const after = body.slice(body.indexOf(":") + 1).trim();
    if (after.startsWith("{")) return flowMappingScalar(after, path.slice(depth + 1));
    start = hit + 1;
    end = yamlBlockEnd(lines, hit, indent);
    indent = yamlChildIndent(lines, start, end, indent);
  }
  return "";
}

/** Read the rest of a path inside a flow mapping (`{ a: 1, b: { c: 2 } }`);
 *  "" when absent or unreadable, like a missing block key. */
function flowMappingScalar(after, rest) {
  let entries;
  try { entries = flowMappingEntries(after, ""); } catch { return ""; }
  const pair = entries.pairs.find(([k]) => k === rest[0]);
  if (!pair) return "";
  if (rest.length === 1) return pair[1].startsWith("{") ? "" : scalarValue(pair[1]);
  return pair[1].startsWith("{") ? flowMappingScalar(pair[1], rest.slice(1)) : "";
}

/** Read a sequence of scalars at a mapping path (block or simple flow style);
 *  [] when absent. Read-only: the wizard never writes sequences. */
export function projectYamlList(text, path) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const hit = findYamlKey(lines, path[depth], start, end, indent);
    if (hit < 0) return [];
    if (depth < path.length - 1) {
      start = hit + 1;
      end = yamlBlockEnd(lines, hit, indent);
      indent = yamlChildIndent(lines, start, end, indent);
      continue;
    }
    const body = lines[hit].trim();
    const inline = body.slice(body.indexOf(":") + 1).trim();
    if (inline.startsWith("[")) {
      return inline.replace(/^\[/, "").replace(/\]\s*(#.*)?$/, "").split(",").map((item) => scalarValue(item)).filter(Boolean);
    }
    const items = [];
    for (let i = hit + 1; i < lines.length; i++) {
      const item = lines[i].trim();
      if (!item || item.startsWith("#")) continue;
      const level = yamlIndent(lines[i]);
      // Items may sit deeper than the key or, as YAML allows, at its own level.
      if (level < indent || (level === indent && !item.startsWith("- "))) break;
      if (item.startsWith("- ")) items.push(scalarValue(item.slice(2)));
      else if (item === "-") items.push("");
    }
    return items;
  }
  return [];
}

/** Split a flow mapping (`{ a: 1, b: "x, y" }`, optionally followed by a
 *  comment) into its [key, rawValue] pairs; the value text is kept verbatim so
 *  quoting, nested `[...]`/`{...}` and spacing survive the move to block style. */
function flowMappingEntries(after, where) {
  let depthBraces = 0;
  let quote = "";
  let close = -1;
  for (let i = 0; i < after.length; i++) {
    const ch = after[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") depthBraces++;
    else if (ch === "}" || ch === "]") {
      depthBraces--;
      if (depthBraces === 0) { close = i; break; }
    }
  }
  const rest = close >= 0 ? after.slice(close + 1).trim() : "";
  if (close < 0 || (rest && !rest.startsWith("#"))) {
    throw new Error(`${where} is written as an inline mapping ({...}) that could not be read; put its keys on their own lines and try again`);
  }
  const body = after.slice(1, close);
  const items = [];
  let current = "";
  let level = 0;
  quote = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') current += body[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") level++;
    else if (ch === "}" || ch === "]") level--;
    if (ch === "," && level === 0) { items.push(current); current = ""; continue; }
    current += ch;
  }
  items.push(current);
  const pairs = [];
  for (const item of items) {
    if (!item.trim()) continue;
    const k = yamlLineKey(item.trim());
    if (k === null) {
      throw new Error(`${where} is written as an inline mapping ({...}) that could not be read; put its keys on their own lines and try again`);
    }
    const value = /^(?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*:(.*)$/s.exec(item.trim())[1].trim();
    pairs.push([k, value]);
  }
  return { pairs, comment: rest ? `  ${rest}` : "" };
}

/** The quote style of an existing scalar and whatever follows it on the line
 *  (a trailing comment, with its spacing): { style: '"' | "'" | "", trailing }. */
function splitScalarLine(afterColon) {
  const text = afterColon.replace(/^\s+/, "");
  let end = text.length;
  let style = "";
  if (text.startsWith('"')) {
    style = '"';
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === '"') { end = i + 1; break; }
    }
  } else if (text.startsWith("'")) {
    style = "'";
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") { i++; continue; }
        end = i + 1;
        break;
      }
    }
  } else {
    end = text.length;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "#" && (i === 0 || /\s/.test(text[i - 1]))) { end = i; break; }
    }
    end = text.slice(0, end).trimEnd().length;
  }
  const rest = text.slice(end);
  return { style, trailing: /^\s*#/.test(rest) ? `  ${rest.trim()}` : "" };
}

const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED_PLAIN = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

/** Render a value in the style the line already used: double quotes stay
 *  double (JSON escapes are YAML's), single stay single, and a plain word stays
 *  plain while it is one; anything else is single-quoted, as new lines are. */
function renderScalar(value, style) {
  const text = String(value);
  if (style === '"') return JSON.stringify(text);
  if (style === "" && PLAIN_SCALAR.test(text) && !RESERVED_PLAIN.test(text)) return text;
  return yamlQuoted(text);
}

function yamlQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function yamlKey(value) {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : yamlQuoted(value);
}

export function canonicalProjectUuid(value) {
  const candidate = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : "";
}

export function projectSqlEndpointType(value) {
  return value === "Warehouse" || value === "Lakehouse" ? value : "";
}

/** Update or insert one scalar mapping path while preserving every unrelated line. */
export function upsertProjectYamlScalar(text, path, value, options = {}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // `raw` writes the value as given (a flow list such as `[dim, fact]`); never for free text.
  const rendered = typeof value === "boolean" ? String(value) : options.raw ? String(value) : yamlQuoted(value);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth];
    const hit = findYamlKey(lines, key, start, end, indent);
    if (hit >= 0) {
      if (depth === path.length - 1) {
        // Keep the line's own quote style and its trailing comment: a client's
        // file documents its keys there (`mode: "connected"  # discovery | ...`).
        const body = lines[hit].trim();
        const { style, trailing } = splitScalarLine(body.slice(body.indexOf(":") + 1));
        const kept = typeof value === "boolean" || options.raw ? rendered : renderScalar(value, style);
        lines[hit] = `${" ".repeat(indent)}${yamlKey(key)}: ${kept}${trailing}`;
        return lines.join("\n");
      }
      // A scalar/flow value cannot contain child mappings; convert only this
      // parent line to a block mapping before inserting the wizard-owned child.
      const after = lines[hit].trim().slice(lines[hit].trim().indexOf(":") + 1).trim();
      if (after.startsWith("{")) {
        // A populated flow mapping (`key: { a: 1, b: 2 }`) becomes block keys on
        // their own lines so none of them is lost; an empty `{}` just opens.
        const entries = flowMappingEntries(after, `${path.slice(0, depth + 1).join(".")}`);
        const pad = " ".repeat(indent + 2);
        lines.splice(hit, 1, `${" ".repeat(indent)}${yamlKey(key)}:${entries.comment}`,
          ...entries.pairs.map(([k, v]) => `${pad}${yamlKey(k)}:${v ? ` ${v}` : ""}`));
      } else if (after && !after.startsWith("#")) {
        lines[hit] = `${" ".repeat(indent)}${yamlKey(key)}:`;
      }
      start = hit + 1;
      end = yamlBlockEnd(lines, hit, indent);
      indent = yamlChildIndent(lines, start, end, indent);
      continue;
    }

    const addition = [];
    for (let j = depth; j < path.length; j++) {
      const pad = " ".repeat(indent + (j - depth) * 2);
      addition.push(j === path.length - 1
        ? `${pad}${yamlKey(path[j])}: ${rendered}`
        : `${pad}${yamlKey(path[j])}:`);
    }
    // Keep top-level sections visually separated, but never disturb the current
    // section's existing content when adding a nested value.
    if (depth === 0 && lines.length && lines[lines.length - 1].trim()) lines.push("");
    // Inside a section, insert before the blank or comment lines that separate
    // it from the next one, so they (and the next section's comments) stay put.
    let at = depth === 0 ? lines.length : end;
    if (depth > 0) while (at > start && (!lines[at - 1].trim() || lines[at - 1].trim().startsWith("#"))) at--;
    lines.splice(at, 0, ...addition);
    return lines.join("\n");
  }
  return lines.join("\n");
}

export function repositoryNames(text) {
  const lines = text.split(/\r?\n/);
  const repos = findYamlKey(lines, "repositories", 0, lines.length, 0);
  if (repos < 0) return [];
  const end = yamlBlockEnd(lines, repos, 0);
  const indent = yamlChildIndent(lines, repos + 1, end, 0);
  const names = [];
  for (let i = repos + 1; i < end; i++) {
    if (yamlIndent(lines[i]) !== indent) continue;
    const key = yamlLineKey(lines[i]);
    if (key) names.push(key);
  }
  return names;
}

export function boolValue(value, fallback = false) {
  if (/^(true|yes|1|on)$/i.test(value)) return true;
  if (/^(false|no|0|off)$/i.test(value)) return false;
  return fallback;
}

/** Parse the wizard-owned subset; unknown project fields are intentionally ignored. */
export function parseProjectWizardSettings(text, projectRoot) {
  const defaultBranch = projectYamlScalar(text, ["profile", "default_branch"]) || "main";
  const repositories = repositoryNames(text).map((name) => ({
    name,
    description: projectYamlScalar(text, ["repositories", name, "description"]) || "Project source and docs",
    role: projectYamlScalar(text, ["repositories", name, "role"]) || "generic",
    localPath: projectYamlScalar(text, ["repositories", name, "local_path"]) || ".",
    remoteName: projectYamlScalar(text, ["repositories", name, "remote_name"]) || "origin",
    defaultBranch: projectYamlScalar(text, ["repositories", name, "default_branch"]) || defaultBranch,
  }));
  const fabricFlag = projectYamlScalar(text, ["tools", "fabric_cli", "enabled"]);
  const teFlag = projectYamlScalar(text, ["tools", "tabular_editor_cli", "enabled"]);
  const fabricEnabled = boolValue(fabricFlag, Boolean(projectYamlScalar(text, ["fabric", "tenant_id"])));
  return {
    organization: projectYamlScalar(text, ["profile", "organization"]) || "Cooptimize",
    client: projectYamlScalar(text, ["profile", "client"]),
    timezone: projectYamlScalar(text, ["profile", "timezone"]) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    defaultBranch,
    repositories: repositories.length || text.trim() ? repositories : [{
      name: basename(projectRoot) || "project",
      description: "Project source and docs",
      role: "generic",
      localPath: ".",
      remoteName: "origin",
      defaultBranch,
      isNew: true,
    }],
    fabricEnabled,
    powerBiEnabled: projectYamlHas(text, ["power_bi"]) || fabricEnabled,
    tenantId: projectYamlScalar(text, ["fabric", "tenant_id"]),
    fabricWorkspaceName: projectYamlScalar(text, ["fabric", "default_workspace_name"]),
    fabricWorkspaceId: projectYamlScalar(text, ["fabric", "default_workspace_id"]),
    sqlEndpointItemType: projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_type"]),
    sqlEndpointItemName: projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_name"]),
    sqlEndpointItemId: projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_id"]),
    sqlEndpointPropertiesId: projectYamlScalar(text, ["fabric", "default_sql_endpoint", "sqlEndpointProperties", "id"]),
    powerBiWorkspaceName: projectYamlScalar(text, ["power_bi", "default_workspace_name"]),
    powerBiWorkspaceId: projectYamlScalar(text, ["power_bi", "default_workspace_id"]),
    tabularEditorEnabled: boolValue(teFlag, false),
    tabularEditorPath: projectYamlScalar(text, ["tools", "tabular_editor_cli", "executable_path"]) || "te",
    bpaRulesPath: projectYamlScalar(text, ["tools", "tabular_editor_cli", "bpa_rules_path"]),
    sqlTargetKind: projectYamlScalar(text, ["sql_targets", "dev", "kind"]),
    sqlTargetServer: projectYamlScalar(text, ["sql_targets", "dev", "server"]),
    sqlTargetDatabase: projectYamlScalar(text, ["sql_targets", "dev", "database"]),
    ...Object.fromEntries(SQL_TARGET_OTHER_ENVIRONMENTS.flatMap(({ env, prefix }) => [
      [`${prefix}Server`, projectYamlScalar(text, ["sql_targets", env, "server"])],
      [`${prefix}WorkspaceId`, projectYamlScalar(text, ["sql_targets", env, "workspace_id"])],
      [`${prefix}ItemId`, projectYamlScalar(text, ["sql_targets", env, "item_id"])],
      [`${prefix}EndpointId`, projectYamlScalar(text, ["sql_targets", env, "sql_endpoint_id"])],
      [`${prefix}Database`, projectYamlScalar(text, ["sql_targets", env, "database"])],
    ])),
    schemaCompareExclude: projectYamlList(text, ["schema_compare", "exclude_schemas"]).join(", "),
    schemaCompareRebuild: projectYamlList(text, ["schema_compare", "rebuild_tables_in"]).join(", "),
    schemaCompareDestructive: projectYamlScalar(text, ["schema_compare", "destructive"]).toLowerCase(),
    namedTargets: readNamedTargets(text),
    fabricLayout: projectYamlScalar(text, ["fabric", "layout"]),
    tableMappingRule: projectYamlScalar(text, ["power_bi", "table_mapping", "rule"]),
    tableMappingSchema: projectYamlScalar(text, ["power_bi", "table_mapping", "default_schema"]),
    tableMappingPrefix: projectYamlScalar(text, ["power_bi", "table_mapping", "view_prefix"]),
  };
}

/** The sql_targets lines for a contract (dev entry from the wizard; test/prod left to fill in). */
export function sqlTargetsBlock(settings) {
  const kind = settings.sqlTargetKind;
  if (!kind) return [];
  const discovered = SQL_TARGET_DISCOVERED_KINDS.has(kind);
  const lines = [
    "",
    "# SQL connection targets (one per environment). coop works on default_environment",
    "# (dev or test, never prod) unless a session is explicitly scoped and approved.",
    "# Entra ID tokens only: never a user, password or connection string here.",
    "sql_targets:",
    "  default_environment: dev",
    "  dev:",
    `    kind: ${yamlQuoted(kind)}`,
  ];
  if (discovered) {
    lines.push(
      "    # coop discovers the host from these Fabric ids through the Fabric REST API.",
      `    workspace_id: ${yamlQuoted(canonicalProjectUuid(settings.fabricWorkspaceId))}`,
      `    item_id: ${yamlQuoted(canonicalProjectUuid(settings.sqlEndpointItemId))}`,
    );
    if (kind === "fabric_lakehouse") lines.push(`    sql_endpoint_id: ${yamlQuoted(canonicalProjectUuid(settings.sqlEndpointPropertiesId))}`);
  } else {
    lines.push(`    server: ${yamlQuoted(settings.sqlTargetServer)}`);
  }
  lines.push(`    database: ${yamlQuoted(settings.sqlTargetDatabase)}`);
  // test, then prod: the answered entries as given, the rest as placeholders to fill in.
  for (const { env, prefix } of [...SQL_TARGET_OTHER_ENVIRONMENTS].reverse()) {
    const database = (settings[`${prefix}Database`] || "").trim();
    lines.push(`  ${env}:`, `    kind: ${yamlQuoted(kind)}`);
    if (database) {
      if (discovered) {
        lines.push(`    workspace_id: ${yamlQuoted(canonicalProjectUuid(settings[`${prefix}WorkspaceId`]))}`, `    item_id: ${yamlQuoted(canonicalProjectUuid(settings[`${prefix}ItemId`]))}`);
        if (kind === "fabric_lakehouse") lines.push(`    sql_endpoint_id: ${yamlQuoted(canonicalProjectUuid(settings[`${prefix}EndpointId`]))}`);
      } else {
        lines.push(`    server: ${yamlQuoted((settings[`${prefix}Server`] || "").toLowerCase())}`);
      }
      lines.push(`    database: ${yamlQuoted(database)}`);
    } else {
      lines.push(...(discovered ? ["    workspace_id: ''", "    item_id: ''"] : ["    server: ''"]), "    database: ''");
    }
  }
  // Named sets (a second engine beside the main one): only the answered environments.
  const named = (settings.namedTargets || []).flatMap((set) => namedSetLines(set, 4));
  if (named.length) {
    lines.push("  # A second engine beside the main one; a side is then <env>@<set> (dev@lakehouse).", "  named:", ...named);
  }
  return lines;
}

/** The `schema_compare:` lines for a new contract ([] when nothing was answered:
 * no list and the engine's own default, `runnable`). `commented` is an answer on
 * its own (#476): leaving it out would run the engine with destructive statements
 * active. */
export function schemaCompareBlock(settings) {
  const exclude = schemaNameList(settings.schemaCompareExclude);
  const rebuild = schemaNameList(settings.schemaCompareRebuild);
  if (!exclude.length && !rebuild.length && settings.schemaCompareDestructive !== "commented") return [];
  return [
    "",
    "# Schema compare defaults for this client (coop schema compare / schema_compare):",
    "# schemas never compared, and schemas whose changed tables are dropped and",
    "# recreated empty (full-load dim/fact tables) instead of altered.",
    "schema_compare:",
    `  exclude_schemas: ${yamlFlowList(exclude)}`,
    `  rebuild_tables_in: ${yamlFlowList(rebuild)}`,
    `  destructive: ${SCHEMA_COMPARE_DESTRUCTIVE.includes(settings.schemaCompareDestructive) ? settings.schemaCompareDestructive : "runnable"}`,
  ];
}

/** `fabric.lakehouse_names` / `warehouse_names` for a new contract: the default SQL endpoint item when it is of that type. */
function fabricItemNames(settings, type) {
  const name = settings.sqlEndpointItemName || "";
  return settings.sqlEndpointItemType === type && name ? `[${yamlQuoted(name)}]` : "[]";
}

function safeRepositoryBlock(repo) {
  return [
    `  ${yamlKey(repo.name)}:`,
    `    description: ${yamlQuoted(repo.description)}`,
    `    role: ${yamlQuoted(repo.role)}`,
    `    local_path: ${yamlQuoted(repo.localPath)}`,
    `    remote_name: ${yamlQuoted(repo.remoteName)}`,
    `    default_branch: ${yamlQuoted(repo.defaultBranch)}`,
    "    agent_allowed_to_commit:",
    "      - 'docs/**'",
    "      - 'site/**'",
    "      - 'docs/agent/logs/**'",
    "      - 'docs/agent/diagrams/**'",
    "    agent_never_commit:",
    "      - '**/*.sql'",
    "      - '**/*.py'",
    "      - '**/*.ipynb'",
    "      - '**/*.pbip'",
    "      - '**/*.pbir'",
    "      - '**/*.bim'",
    "      - '**/*.tmdl'",
    "      - '**/*.dax'",
    "      - '**/*.rdl'",
    "      - '**/*.SemanticModel/**'",
    "      - '**/*.Report/**'",
  ];
}

function appendNewRepository(text, repo) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let repos = findYamlKey(lines, "repositories", 0, lines.length, 0);
  if (repos < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push("");
    lines.push("repositories:", ...safeRepositoryBlock(repo), "");
    return lines.join("\n");
  }
  // A discovery-mode contract carries `repositories: {}` (or `[]`); a block
  // entry cannot hang under a flow value, so turn the line into a bare key first.
  const after = lines[repos].trim().slice(lines[repos].trim().indexOf(":") + 1).trim();
  if (after && !after.startsWith("#")) lines[repos] = "repositories:";
  const end = yamlBlockEnd(lines, repos, 0);
  lines.splice(end, 0, ...safeRepositoryBlock(repo));
  return lines.join("\n");
}

/** Apply wizard answers to an existing contract without replacing unknown fields. */
export function applyProjectWizardSettings(text, settings) {
  let out = text;
  const set = (path, value) => { out = upsertProjectYamlScalar(out, path, value); };
  set(["profile", "organization"], settings.organization);
  set(["profile", "client"], settings.client);
  set(["profile", "timezone"], settings.timezone);
  set(["profile", "default_branch"], settings.defaultBranch);
  set(["profile", "work_mode"], "consultant_review_first");
  set(["estate", "mode"], estateMode(settings.repositories));
  set(["estate", "local_source_coverage", "sql"], coverageFor(settings.repositories, "sql"));
  set(["estate", "local_source_coverage", "power_bi"], coverageFor(settings.repositories, "powerbi"));
  for (const repo of settings.repositories) {
    if (repo.isNew && !repositoryNames(out).includes(repo.name)) out = appendNewRepository(out, repo);
    else {
      set(["repositories", repo.name, "description"], repo.description);
      set(["repositories", repo.name, "role"], repo.role);
      set(["repositories", repo.name, "local_path"], repo.localPath);
      set(["repositories", repo.name, "remote_name"], repo.remoteName);
      set(["repositories", repo.name, "default_branch"], repo.defaultBranch);
    }
  }
  const powerBiEnabled = powerBiOn(settings);
  // The Fabric CLI and the Fabric MCP list Power BI workspaces too (Pro and PPU
  // included, through the Fabric REST API), so they follow either answer; the
  // Warehouse MCP and fabric_cicd are Fabric-only.
  set(["tools", "fabric_cli", "enabled"], settings.fabricEnabled || powerBiEnabled);
  set(["tools", "fabric_cicd", "enabled"], settings.fabricEnabled);
  set(["mcp", "fabric", "enabled"], settings.fabricEnabled || powerBiEnabled);
  set(["mcp", "fabric_sqlendpoint", "enabled"], settings.fabricEnabled);
  if (settings.fabricEnabled) {
    set(["fabric", "tenant_id"], settings.tenantId);
    set(["fabric", "default_workspace_name"], settings.fabricWorkspaceName);
    set(["fabric", "default_workspace_id"], canonicalProjectUuid(settings.fabricWorkspaceId));
    set(["fabric", "default_sql_endpoint", "item_type"], projectSqlEndpointType(settings.sqlEndpointItemType));
    set(["fabric", "default_sql_endpoint", "item_name"], settings.sqlEndpointItemName || "");
    set(["fabric", "default_sql_endpoint", "item_id"], canonicalProjectUuid(settings.sqlEndpointItemId));
    set(["fabric", "default_sql_endpoint", "sqlEndpointProperties", "id"], canonicalProjectUuid(settings.sqlEndpointPropertiesId));
    set(["fabric", "layout"], settings.fabricLayout || "");
  }
  if (powerBiEnabled) {
    set(["power_bi", "default_workspace_name"], settings.powerBiWorkspaceName);
    set(["power_bi", "default_workspace_id"], settings.powerBiWorkspaceId);
    // The mapping (C2) is always written once Power BI is on, so the contract
    // states the rule coop follows instead of leaving it assumed.
    set(["power_bi", "table_mapping", "rule"], settings.tableMappingRule || "same_name");
    set(["power_bi", "table_mapping", "default_schema"], settings.tableMappingSchema || "dbo");
    set(["power_bi", "table_mapping", "view_prefix"], settings.tableMappingRule === "prefix" ? settings.tableMappingPrefix || "" : "");
    if (!Object.keys(projectYamlMapping(out, ["power_bi", "table_mapping", "overrides"])).length && !projectYamlScalar(out, ["power_bi", "table_mapping", "overrides"]).startsWith("{")) {
      set(["power_bi", "table_mapping", "overrides"], "{}");
      out = out.replace(/^(\s*overrides:) '\{\}'$/m, "$1 {}");
    }
  }
  set(["tools", "tabular_editor_cli", "enabled"], settings.tabularEditorEnabled);
  if (settings.tabularEditorEnabled) {
    set(["tools", "tabular_editor_cli", "executable_path"], settings.tabularEditorPath);
    set(["tools", "tabular_editor_cli", "bpa_rules_path"], settings.bpaRulesPath);
  }
  if (settings.sqlTargetKind) {
    // Only the dev entry is wizard-owned; test/prod entries and an existing
    // default_environment stay as the person wrote them.
    if (!projectYamlScalar(out, ["sql_targets", "default_environment"])) set(["sql_targets", "default_environment"], "dev");
    set(["sql_targets", "dev", "kind"], settings.sqlTargetKind);
    if (SQL_TARGET_DISCOVERED_KINDS.has(settings.sqlTargetKind)) {
      set(["sql_targets", "dev", "workspace_id"], canonicalProjectUuid(settings.fabricWorkspaceId));
      set(["sql_targets", "dev", "item_id"], canonicalProjectUuid(settings.sqlEndpointItemId));
      if (settings.sqlTargetKind === "fabric_lakehouse") set(["sql_targets", "dev", "sql_endpoint_id"], canonicalProjectUuid(settings.sqlEndpointPropertiesId));
    } else {
      set(["sql_targets", "dev", "server"], settings.sqlTargetServer);
    }
    set(["sql_targets", "dev", "database"], settings.sqlTargetDatabase);
    // The test and prod entries the wizard asked for (A1, 2026-10-24): written
    // only when a database was answered, with the dev kind; an entry the person
    // left blank stays exactly as the file has it.
    for (const { env, prefix } of SQL_TARGET_OTHER_ENVIRONMENTS) {
      const database = (settings[`${prefix}Database`] || "").trim();
      if (!database) continue;
      set(["sql_targets", env, "kind"], settings.sqlTargetKind);
      if (SQL_TARGET_DISCOVERED_KINDS.has(settings.sqlTargetKind)) {
        set(["sql_targets", env, "workspace_id"], canonicalProjectUuid(settings[`${prefix}WorkspaceId`]));
        set(["sql_targets", env, "item_id"], canonicalProjectUuid(settings[`${prefix}ItemId`]));
        if (settings.sqlTargetKind === "fabric_lakehouse") set(["sql_targets", env, "sql_endpoint_id"], canonicalProjectUuid(settings[`${prefix}EndpointId`]));
      } else {
        set(["sql_targets", env, "server"], (settings[`${prefix}Server`] || "").toLowerCase());
      }
      set(["sql_targets", env, "database"], database);
    }
  }
  // Named target sets: each answered environment of each set is written with the
  // set's kind; an environment left blank, and a set the form no longer lists,
  // stay as the file has them (the writer never removes an entry).
  if (settings.sqlTargetKind) {
    for (const named of (settings.namedTargets || []).slice(0, MAX_NAMED_SETS)) {
      const kind = String(named.kind || "").toLowerCase();
      if (!NAMED_SET_NAME.test(named.name || "") || !SQL_TARGET_KINDS.includes(kind)) continue;
      for (const env of NAMED_SET_ENVIRONMENTS) {
        const entry = named[env];
        if (!namedEntryAnswered(entry)) continue;
        const base = ["sql_targets", "named", named.name, env];
        set([...base, "kind"], kind);
        if (SQL_TARGET_DISCOVERED_KINDS.has(kind)) {
          set([...base, "workspace_id"], canonicalProjectUuid(entry.workspaceId));
          set([...base, "item_id"], canonicalProjectUuid(entry.itemId));
          if (kind === "fabric_lakehouse") set([...base, "sql_endpoint_id"], canonicalProjectUuid(entry.endpointId));
        } else {
          set([...base, "server"], String(entry.server || "").toLowerCase());
        }
        set([...base, "database"], String(entry.database).trim());
      }
    }
  }
  // schema_compare lists: written when answered (a blank answer on an existing
  // list empties it; an unanswered one, undefined, leaves the file alone).
  let schemaCompareWritten = false;
  for (const [key, field] of [["exclude_schemas", "schemaCompareExclude"], ["rebuild_tables_in", "schemaCompareRebuild"]]) {
    if (settings[field] === undefined) continue;
    const items = schemaNameList(settings[field]);
    if (!items.length && !projectYamlList(out, ["schema_compare", key]).length && !projectYamlScalar(out, ["schema_compare", key])) continue;
    out = upsertProjectYamlScalar(out, ["schema_compare", key], yamlFlowList(items), { raw: true });
    schemaCompareWritten = true;
  }
  // destructive: an explicit answer is written when the section exists or is being
  // written; `commented` is always written, since it is the one value that changes
  // the engine's behaviour (#476); a new section gets `runnable` (the engine's
  // default) when nothing was said.
  const destructive = SCHEMA_COMPARE_DESTRUCTIVE.includes(settings.schemaCompareDestructive) ? settings.schemaCompareDestructive : "";
  const hasSection = projectYamlHas(out, ["schema_compare"]);
  if (destructive && (hasSection || schemaCompareWritten || destructive === "commented")) set(["schema_compare", "destructive"], destructive);
  else if (!destructive && schemaCompareWritten && !projectYamlScalar(out, ["schema_compare", "destructive"])) set(["schema_compare", "destructive"], "runnable");
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Render a complete safe contract for first-time setup. */
export function renderProjectWizardSettings(settings) {
  const lines = [
    "# Cooptimize agent — project contract (.coop/project.yml)",
    "# Generated by Coop's in-app /setup-project wizard.",
    "# One committed team file per client: everyone who opens coop at or below this",
    "# folder, or in a repository it lists, reads it. Share it with /project-share (or",
    "# coop project share), which commits only this file after your yes and pushes it.",
    "# Edit it with /setup-project, which never writes a second copy.",
    "",
    "profile:",
    `  organization: ${yamlQuoted(settings.organization)}`,
    `  client: ${yamlQuoted(settings.client)}`,
    `  timezone: ${yamlQuoted(settings.timezone)}`,
    `  default_branch: ${yamlQuoted(settings.defaultBranch)}`,
    "  work_mode: 'consultant_review_first'",
    "",
    "estate:",
    `  mode: ${yamlQuoted(estateMode(settings.repositories))}`,
    "  local_source_coverage:",
    `    sql: ${yamlQuoted(coverageFor(settings.repositories, "sql"))}`,
    `    power_bi: ${yamlQuoted(coverageFor(settings.repositories, "powerbi"))}`,
    "",
    settings.repositories.length ? "repositories:" : "repositories: {}",
  ];
  for (const repo of settings.repositories) lines.push(...safeRepositoryBlock(repo));
  if (settings.fabricEnabled) lines.push(
    "",
    "fabric:",
    `  tenant_id: ${yamlQuoted(settings.tenantId)}`,
    `  default_workspace_name: ${yamlQuoted(settings.fabricWorkspaceName)}`,
    `  default_workspace_id: ${yamlQuoted(canonicalProjectUuid(settings.fabricWorkspaceId))}`,
    "  # Optional unambiguous Warehouse/Lakehouse target; IDs must come from Fabric.",
    "  default_sql_endpoint:",
    `    item_type: ${yamlQuoted(projectSqlEndpointType(settings.sqlEndpointItemType))}`,
    `    item_name: ${yamlQuoted(settings.sqlEndpointItemName || "")}`,
    `    item_id: ${yamlQuoted(canonicalProjectUuid(settings.sqlEndpointItemId))}`,
    "    sqlEndpointProperties:",
    `      id: ${yamlQuoted(canonicalProjectUuid(settings.sqlEndpointPropertiesId))}`,
    "  # The Fabric item kinds that hold this client's SQL: warehouse, lakehouse,",
    "  # sql_database or mixed (master plan C2). coop assumes nothing beyond it.",
    `  layout: ${yamlQuoted(settings.fabricLayout || "")}`,
    `  lakehouse_names: ${fabricItemNames(settings, "Lakehouse")}`,
    `  warehouse_names: ${fabricItemNames(settings, "Warehouse")}`,
    "  # Warehouse / Lakehouse workspace for each deployment environment.",
    "  environment_names:",
    "    dev: ''",
    "    test: ''",
    "    prod: ''",
  );
  if (powerBiOn(settings)) lines.push(
    "",
    "power_bi:",
    `  default_workspace_name: ${yamlQuoted(settings.powerBiWorkspaceName)}`,
    `  default_workspace_id: ${yamlQuoted(settings.powerBiWorkspaceId)}`,
    "  # Semantic-model workspace for each deployment environment.",
    "  environment_names:",
    "    dev: ''",
    "    test: ''",
    "    prod: ''",
    "  semantic_models: []",
    "  reports: []",
    "  # How a semantic-model table maps to the SQL object it loads (master plan C2).",
    "  # rule same_name: the table is named like the view (dbo.vSales or vSales loads",
    "  # dbo.vSales); rule prefix: table <name> loads default_schema.<view_prefix><name>.",
    "  # overrides win over the rule: model table name -> schema.object. data_doc",
    "  # lineage and sql_impact check this and report a mismatch, never 'no dependents'.",
    "  table_mapping:",
    `    rule: ${yamlQuoted(settings.tableMappingRule || "same_name")}`,
    `    default_schema: ${yamlQuoted(settings.tableMappingSchema || "dbo")}`,
    `    view_prefix: ${yamlQuoted(settings.tableMappingRule === "prefix" ? settings.tableMappingPrefix || "" : "")}`,
    "    overrides: {}",
  );
  lines.push(...sqlTargetsBlock(settings));
  lines.push(...schemaCompareBlock(settings));
  lines.push(
    "",
    "tools:",
    "  fabric_cli:",
    "    command: 'fab'",
    `    enabled: ${settings.fabricEnabled || powerBiOn(settings)}`,
    "    default_mode: 'read_only_first'",
    "  fabric_cicd:",
    "    library: 'fabric_cicd'",
    "    injected_into: 'ms-fabric-cli'",
    `    enabled: ${settings.fabricEnabled}`,
    "    default_mode: 'validate_only'",
    "  tabular_editor_cli:",
    `    enabled: ${settings.tabularEditorEnabled}`,
  );
  if (settings.tabularEditorEnabled) lines.push(
    `    executable_path: ${yamlQuoted(settings.tabularEditorPath)}`,
    `    bpa_rules_path: ${yamlQuoted(settings.bpaRulesPath)}`,
  );
  lines.push(
    "  coop_data_doc:",
    "    command: 'coop-data-doc'",
    "    enabled: true",
    "    default_command: 'build'",
    "    machine_outputs: ['graph.json', 'manifest.json']",
    "",
    "mcp:",
    "  fabric:",
    `    enabled: ${settings.fabricEnabled || powerBiOn(settings)}`,
    "  fabric_sqlendpoint:",
    `    enabled: ${settings.fabricEnabled}`,
    "  microsoft_learn:",
    "    enabled: true",
    "",
    "memory:",
    "  extension: 'pi-hermes-memory'",
    "  enabled: true",
    "  secret_scanning: true",
    "",
    "microsoft_skills:",
    "  policy: restricted",
    "  allow:",
    "    - 'kql'",
    "    - 'microsoft-docs'",
    "",
    "fabric_skills:",
    `  policy: ${settings.fabricEnabled || powerBiOn(settings) ? "baseline" : "disabled"}`,
    "",
    "# Standards: the canonical Cooptimize standards come from cooptimize/coop-standards",
    "# (`coop sync`, `/standards-status`). Add an override only when this project has",
    "# deliberately approved different standards for a domain. Use a single Markdown file per",
    "# coop domain (sql, dax, or semantic_model), set as `path:`.",
    "# standards:",
    "#   sql:",
    "#     path: \"docs/standards/client-sql.md\"",
    "",
    "# Backups go to this client's folder (%USERPROFILE%\\.coop\\backups\\<repository>\\), never",
    "# inside the repository; only the timestamp and the file name pattern are read here.",
    "backup:",
    "  timestamp_format: '%Y%m%d_%H%M%S'",
    "  naming_pattern: '{original_name}.{timestamp}.bak'",
    "  required_before_edit: true",
    "",
    "logging:",
    "  daily_log_path: 'docs/agent/logs/daily/{yyyy-mm-dd}.md'",
    "  weekly_log_path: 'docs/agent/logs/weekly/{yyyy}-W{ww}.md'",
    "  require_task_log: true",
    "",
    "documentation:",
    "  agent_docs_root: 'docs/agent'",
    "  human_site_root: 'site'",
    "  glossary_path: 'docs/agent/glossary/index.md'",
    "  diagrams_path: 'docs/agent/diagrams'",
    "  source_of_truth: 'markdown_first_html_generated'",
    "  use_coop_data_doc: true",
    "",
    "workflow:",
    "  skill: 'coop-workflow'",
    "  steps:",
    "    - 'Read .coop/project.yml and use COOP resolved standards task authority'",
    "    - 'Identify upstream and downstream impact before edits'",
    "    - 'Write a short plan and get approval before editing'",
    "    - 'Create backups before changing source files'",
    "    - 'Make the smallest safe edit and run the applicable review'",
    "    - 'Show the diff, update documentation, and append to the work log'",
    "    - 'Commit docs/logs/site only with approval; never commit source'",
    "",
    "approval_policy:",
    "  always_allowed:",
    "    - 'read files'",
    "    - 'git status / git diff / git pull'",
    "    - 'create backups'",
    "    - 'run the advisory data_doc / bpa_review tools'",
    "    - 'MCP dev/test metadata / schema / artifact-code list / read / inspect'",
    "    - 'update markdown docs, html site, logs'",
    "  ask_first:",
    "    - 'read actual rows from a live environment'",
    "    - 'read production metadata or artifact code'",
    "    - 'read production rows with target / columns / filters / limit'",
    "    - 'delete files'",
    "    - 'deploy or publish'",
    "    - 'change production workspace'",
    "    - 'commit documentation changes'",
    "  never_without_explicit_instruction:",
    "    - 'commit SQL/DAX/model/report source changes'",
    "    - 'push to remote'",
    "    - 'deploy to test/prod'",
    "    - 'MCP create/update/delete/deploy/publish'",
    "    - 'print secrets, tokens, connection strings, or .env contents'",
    "",
    "tests:",
    "  live_data:",
    "    enabled: false",
    "    between_slices: true",
    "    command: ''",
    "    workspace: 'dev'",
    "    require_approval: true",
    "",
  );
  return lines.join("\n");
}

/** True when `dir` is a coop-agent checkout (coop's own install, by default
 *  `C:\Users\<you>\coop-agent`, or any clone of it). Its `.coop/project.yml` is
 *  coop's sample contract, never a client's project file, so the sibling and
 *  one-level-down lookups skip it. Mirrors Test-CoopCheckout in lib/common.ps1. */
export function isCoopCheckout(dir) {
  return existsSync(join(dir, "bin", "coop.ps1")) && existsSync(join(dir, "lib", "common.ps1"));
}

/** The folders directly under `dir` that are Git repositories (a `.git` entry),
 *  hidden folders and coop checkouts skipped; [] when `dir` cannot be read. */
/** A directory entry that is a folder, following a junction or symlink to one. */
function isFolderEntry(dir, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(join(dir, entry.name)).isDirectory(); } catch { return false; }
}

/** Path equality the way the file system sees it (case-insensitive on Windows,
 *  where `process.cwd()` keeps the case the user typed). */
function samePath(a, b) {
  const x = resolve(a), y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function childRepositories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => isFolderEntry(dir, entry) && !entry.name.startsWith(".") && existsSync(join(dir, entry.name, ".git")) && !isCoopCheckout(join(dir, entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** A short, safe slug of the client name for folder and repository names (`contoso-retail`). */
export function clientSlug(client) {
  return String(client || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "client";
}

/** The client home repository coop proposes beside the client's repositories
 *  (the shared project file design, C1): `<parent>/<client>-coop`, the small
 *  private repository that holds the project file, the lineage docs, the catalog
 *  snapshot and the client's prompts and skills. */
export function homeRepositoryPath(parent, client) {
  return join(parent, `${clientSlug(client)}-coop`);
}

/** The sibling home repository's contract that lists the repository holding
 *  `cwd` (a `repositories.*.local_path` resolving to that repository's root), or
 *  null. One level up only, never the parent folder itself: a file there is in
 *  no repository, so it could not reach a teammate. */
export function findSiblingContract(cwd) {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  const parent = dirname(gitRoot);
  if (parent === gitRoot) return null;
  let names = [];
  try {
    names = readdirSync(parent, { withFileTypes: true }).filter((e) => isFolderEntry(parent, e) && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const candidate = join(parent, name);
    if (samePath(candidate, gitRoot) || isCoopCheckout(candidate)) continue;
    const path = join(candidate, ".coop", "project.yml");
    let text = "";
    try { if (!statSync(path).isFile()) continue; text = readFileSync(path, "utf8"); } catch { continue; }
    if (contractListsFolder(text, candidate, gitRoot)) return path;
  }
  return null;
}

/** Folders coop never looks inside for a client's repositories when opened
 *  two levels above them (the user folder): Windows' own data and package trees. */
const NO_DESCEND = new Set(["appdata", "node_modules"]);

/** The repositories inside `dir` that hold a committed `.coop/project.yml`, as
 *  contract paths: the repositories directly inside it, then those one folder
 *  further down inside a plain folder (`<user>\devops\fabric` opened from the
 *  user folder). Hidden folders, AppData, node_modules and coop checkouts are
 *  skipped, and a repository is never searched inside. */
export function childContracts(dir) {
  const root = resolve(dir || ".");
  const contractIn = (repo) => { const path = join(repo, ".coop", "project.yml"); try { return statSync(path).isFile() ? [path] : []; } catch { return []; } };
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const folder = join(root, name);
    if (existsSync(join(folder, ".git"))) {
      if (!isCoopCheckout(folder)) found.push(...contractIn(folder));
      continue;
    }
    if (NO_DESCEND.has(name.toLowerCase())) continue;
    for (const inner of childRepositories(folder)) found.push(...contractIn(join(folder, inner)));
  }
  return found;
}

/** The contract below `cwd` when coop is opened in the folder that holds the
 *  client's repositories, or the folder above that (`cwd` in no repository):
 *  the one repository up to two levels down with a `.coop/project.yml`, or
 *  null when none or several do (with several, the user opens the repository
 *  they mean). */
export function findChildContract(cwd) {
  if (findGitRoot(cwd)) return null;
  const found = childContracts(cwd);
  return found.length === 1 ? found[0] : null;
}

/** True when the contract at `root` names `folder` as one of its repositories. */
export function contractListsFolder(text, root, folder) {
  for (const name of repositoryNames(text)) {
    const localPath = projectYamlScalar(text, ["repositories", name, "local_path"]);
    if (!localPath || /^TODO\b/i.test(localPath)) continue;
    if (samePath(resolve(root, localPath.replace(/^~(?=$|[\\/])/, homedir())), folder)) return true;
  }
  return false;
}

/**
 * Where a contract belongs for `cwd` (master plan C1, the shared project file
 * design: one committed contract per client, in a repository the whole team
 * clones).
 *   existing   a contract already covers cwd (above it, a sibling home
 *              repository that lists this repository, or, outside Git, the one
 *              repository inside cwd that has one): its root, and nothing else
 *              is ever written below it; `sibling` / `child` say which
 *   home-repo  cwd is inside a repository whose parent holds other repositories
 *              too, or is itself the folder holding several repositories: the client home repository `<parent>/<client>-coop` beside
 *              them (created on demand); with no `client` yet the root is a
 *              placeholder and `pending` is true
 *   git-root   cwd is inside the only repository in its folder: the repository
 *   folder     no repository: cwd itself; `children` names the repositories
 *              inside it (up to two levels, as relative paths) that have a contract (several, or none would be found)
 * `repos` lists the repositories beside the home (home-repo only);
 * `repository: true` skips the home step and stays with the repository (the
 * answer when the user declines the home repository).
 */
export function proposeContractRoot(cwd, { existing, repository = false, client = "" } = {}) {
  const found = existing === undefined ? (findContract(cwd) || findSiblingContract(cwd) || findChildContract(cwd)) : existing;
  if (found) {
    const root = resolve(found, "..", "..");
    const outside = !isInside(resolve(cwd || "."), root);
    const inGit = findGitRoot(cwd) !== null;
    const child = outside && !inGit;
    return { root, kind: "existing", path: found, repos: [], sibling: outside && inGit, child, childPath: child ? relative(resolve(cwd || "."), root) : "" };
  }
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const parent = dirname(gitRoot);
    const repos = repository || parent === gitRoot ? [] : childRepositories(parent);
    if (repos.length >= 2 && repos.includes(basename(gitRoot))) {
      const pending = !String(client || "").trim();
      const root = pending ? join(parent, "<client>-coop") : homeRepositoryPath(parent, client);
      return { root, kind: "home-repo", path: join(root, ".coop", "project.yml"), repos: repos.filter((name) => name !== basename(root)), parent, pending };
    }
    return { root: gitRoot, kind: "git-root", path: join(gitRoot, ".coop", "project.yml"), repos: [] };
  }
  const root = resolve(cwd || ".");
  const children = childContracts(root).map((path) => relative(root, resolve(path, "..", "..")));
  // Opened in the folder that holds the client's repositories: the same home
  // repository beside them, never the folder (a file there is in no repository).
  const inside = repository ? [] : childRepositories(root);
  if (inside.length >= 2 && !children.length) {
    const pending = !String(client || "").trim();
    const home = pending ? join(root, "<client>-coop") : homeRepositoryPath(root, client);
    return { root: home, kind: "home-repo", path: join(home, ".coop", "project.yml"), repos: inside.filter((name) => name !== basename(home)), parent: root, pending, fromParent: true };
  }
  return { root, kind: "folder", path: join(root, ".coop", "project.yml"), repos: [], children };
}

/** One sentence for the wizard and the form on why the contract goes where it goes. */
export function contractLocationNote(where) {
  switch (where.kind) {
    case "existing":
      if (where.child) return `The team's project file for this folder is ${where.path}, in the repository ${where.childPath || basename(where.root)} inside it. Coop edits it and never writes a second copy here.`;
      return where.sibling
        ? `The team's project file for this repository is ${where.path} (the client home repository beside it lists this folder). Coop edits it and never writes a second copy here.`
        : `A contract already covers this folder: ${where.path}. Coop edits it and never writes a second copy below it.`;
    case "home-repo":
      return `No contract yet. ${where.fromParent ? "This folder holds" : "This repository is one of"} ${where.repos.length} side by side (${where.repos.join(", ")}), so the team's project file goes in a small client home repository beside them, ${where.root}: it holds the project file, the lineage docs, the catalog snapshot and the client's prompts and skills, and the whole team clones it. The folder between the repositories is never used, because a file there is in no repository.`;
    case "git-root":
      return `No contract yet. Coop proposes this repository's root, ${where.root}: the committed .coop/project.yml there is read by everyone who opens coop at or below it.`;
    default:
      if (where.children && where.children.length > 1) return `Several repositories inside this folder have a project file (${where.children.join(", ")}). Open coop in the repository you mean to edit its file; a new one here would be in no repository, so it could not reach a teammate.`;
      return `No contract yet. This folder is not a Git repository, so the contract goes in ${where.root}; the team's committed contract belongs in a repository the team clones (the client's repository, or the client home repository beside several).`;
  }
}

/** What to tell the user once a contract was created (C1: share it, open coop there). */
export function contractCreatedNote(root) {
  return `Share .coop/project.yml with the team (/project-share commits that one file and pushes it; the window's Project pane has the same button) so your teammates get it. Open coop at or below ${root}, or in a repository it lists, so it is found.`;
}

/** The repositories beside a home repository, as wizard entries (one generic
 *  entry per sibling, relative paths), for a new home-repo contract. */
export function siblingRepositoryEntries(repos, defaultBranch = "main") {
  return repos.map((name) => ({
    name: repositoryShortName(name, name),
    description: "Project source and docs",
    role: "generic",
    localPath: `../${name}`,
    remoteName: "origin",
    defaultBranch,
  }));
}

/** True when `path` is `root` or below it. */
function isInside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findContract(cwd) {
  let dir = resolve(cwd || ".");
  for (;;) {
    const path = join(dir, ".coop", "project.yml");
    try { if (statSync(path).isFile()) return path; } catch { /* not here */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The git root at or above `cwd`, or null: lib/paths.mjs's gitRootAbove, the one finder. */
export const findGitRoot = gitRootAbove;

/** Write the project file; an existing one is copied first to this client's
 *  backups folder (F2: `<profile dir>/backups/<repository>/.coop/project.yml.<timestamp>.bak`,
 *  never inside the repository). Returns the backup path, or null for a new file. */
export function writeProjectContract(path, text, { env = process.env, now = new Date() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let backup = null;
  if (existsSync(path)) {
    backup = backupPathFor(path, env, now);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(path, backup);
    writeFileSync(path, text, "utf8");
  } else {
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  }
  return backup;
}

/** Write `<profile dir>/user.json` with just a name and the balanced preset: the
 *  same shape and name rules as scripts/onboard.py (`validate_name`), which stays
 *  the place to change the communication preset. Returns the saved name, or null
 *  when the name is invalid or the file could not be written. */
export function saveUserProfileName(rawName, path = coopUserProfilePath()) {
  if (!isSavableProfileName(rawName)) return null;
  const name = cleanAnswer(rawName);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const profile = { schema_version: 1, name, communication: { preset: "balanced", custom_instructions: "" } };
    writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", "utf8");
    return name;
  } catch {
    return null;
  }
}

/**
 * The machine's client platform from ~/.coop/config (client.platform, written by
 * `coop install --platform` / `coop onboard`; master plan section 8 item 7):
 * "fabric", "azure_sql" or "both". "" when unset or unreadable (treated as Fabric).
 * The project contract still wins per repository; this only seeds wizard defaults.
 */
export function clientPlatform(coopDir) {
  const base = coopDir || process.env.COOP_DIR || homedir();
  const cfgPath = join(base, ".coop", "config");
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    const value = raw?.client?.platform;
    return value === "fabric" || value === "azure_sql" || value === "both" ? value : "";
  } catch {
    return "";
  }
}

// --- The wizard's answer checks ---------------------------------------------
// The terminal wizard stops at the first failing answer; the window's form
// shows every problem next to its field. Same tests, same words.

/** A lowercase canonical UUID: the only id form the wizard accepts. */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** fabric.default_sql_endpoint.item_type values; blank is allowed too. */
export const SQL_ENDPOINT_TYPES = Object.freeze(["Warehouse", "Lakehouse"]);

export const PROJECT_MESSAGES = Object.freeze({
  endpointType: "SQL endpoint item type must be exactly Warehouse, Lakehouse, or blank.",
  uuids: "Fabric workspace and SQL endpoint IDs must be lowercase canonical UUIDs or blank.",
  lakehouseId: "Lakehouse SQL endpoint selection requires sqlEndpointProperties.id.",
  targetKind: `SQL target kind must be one of ${SQL_TARGET_KINDS.join(", ")}, or blank.`,
  serverHost: "The server is a host name only: no port, path or connection-string parts.",
  targetIncomplete: (label) => `The ${label} SQL target needs both its database name and its ids (or server); leave every ${label} field blank for no ${label} entry yet.`,
  schemaNames: "Schema names are plain identifiers (letters, digits, _), separated by commas.",
  destructive: `Destructive statements are ${SCHEMA_COMPARE_DESTRUCTIVE.join(" or ")}.`,
  namedSetName: "A target set name is lowercase letters, digits, _ or -, starting with a letter (up to 32 characters), and used once.",
  namedSetKind: `A target set needs a kind (${SQL_TARGET_KINDS.join(", ")}) and the dev SQL target must be set.`,
  namedSetEntry: (name, env) => `The ${env} entry of target set ${name} needs both its database name and its ids (or server); leave every ${env} field blank for no ${env} entry.`,
  namedSetEmpty: (name) => `Target set ${name} has no environment filled in; fill in dev, test or prod, or remove the set.`,
  fabricLayout: `Fabric layout must be one of ${FABRIC_LAYOUTS.join(", ")}, or blank.`,
  mappingRule: `The table mapping rule must be ${TABLE_MAPPING_RULES.join(" or ")}.`,
  mappingSchema: "The default schema is one SQL identifier (letters, digits and _, not starting with a digit).",
  mappingPrefix: "The view prefix is letters, digits and _ only (for example v_), or blank.",
  repoName: (name) => `A repository named ${name} already exists; choose a unique short name.`,
  profileName: "That name has characters coop can't save (\\ / < > | : & ;) or is over 100 characters; run `coop onboard` to set it.",
});

/** A name user.json can hold: the rules of scripts/onboard.py's validate_name. */
export function isSavableProfileName(raw) {
  const name = cleanAnswer(raw);
  return Boolean(name) && name.length <= 100 && !/[\\/<>|:&;]/.test(name);
}

/** One typed answer as the wizard keeps it: control characters (including DEL
 *  and C1, which PyYAML's safe_load rejects) removed, then trimmed. */
export function cleanAnswer(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw === undefined || raw === null ? "" : raw).replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
}

/** A repository short name: letters, digits, _ . and -; the fallback when nothing is left. */
export function repositoryShortName(raw, fallback) {
  return String(raw).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

/** A SQL server is a host name only: no spaces, port, path or connection-string parts. */
export function isServerHost(server) {
  return !/[\s,:;=\/\\]/.test(String(server || ""));
}

/**
 * Every problem with a set of answers, as { field, message }; [] when the
 * wizard would accept them all. Fields are ProjectWizardSettings keys, or
 * `repositories.<index>.name`.
 * @param {ProjectWizardSettings} settings
 */
export function projectSettingsProblems(settings) {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });
  if (settings.fabricEnabled) {
    const type = settings.sqlEndpointItemType || "";
    if (type && !SQL_ENDPOINT_TYPES.includes(type)) add("sqlEndpointItemType", PROJECT_MESSAGES.endpointType);
    for (const field of ["fabricWorkspaceId", "sqlEndpointItemId", "sqlEndpointPropertiesId"]) {
      if (settings[field] && !CANONICAL_UUID.test(settings[field])) add(field, PROJECT_MESSAGES.uuids);
    }
    if (type === "Lakehouse" && !settings.sqlEndpointPropertiesId) add("sqlEndpointPropertiesId", PROJECT_MESSAGES.lakehouseId);
    if (settings.fabricLayout && !FABRIC_LAYOUTS.includes(settings.fabricLayout)) add("fabricLayout", PROJECT_MESSAGES.fabricLayout);
  }
  if (powerBiOn(settings)) {
    if (settings.tableMappingRule && !TABLE_MAPPING_RULES.includes(settings.tableMappingRule)) add("tableMappingRule", PROJECT_MESSAGES.mappingRule);
    if (settings.tableMappingSchema && !SQL_IDENTIFIER.test(settings.tableMappingSchema)) add("tableMappingSchema", PROJECT_MESSAGES.mappingSchema);
    if (settings.tableMappingRule === "prefix" && !SQL_PREFIX.test(settings.tableMappingPrefix || "")) add("tableMappingPrefix", PROJECT_MESSAGES.mappingPrefix);
  }
  const kind = settings.sqlTargetKind || "";
  if (kind && !SQL_TARGET_KINDS.includes(kind)) add("sqlTargetKind", PROJECT_MESSAGES.targetKind);
  if (kind && !SQL_TARGET_DISCOVERED_KINDS.has(kind) && !isServerHost(settings.sqlTargetServer)) add("sqlTargetServer", PROJECT_MESSAGES.serverHost);
  if (kind) {
    for (const { prefix, label } of SQL_TARGET_OTHER_ENVIRONMENTS) {
      const database = (settings[`${prefix}Database`] || "").trim();
      const ids = ["WorkspaceId", "ItemId", "EndpointId"].map((k) => (settings[`${prefix}${k}`] || "").trim());
      const server = (settings[`${prefix}Server`] || "").trim();
      if (SQL_TARGET_DISCOVERED_KINDS.has(kind)) {
        ids.forEach((id, i) => { if (id && !CANONICAL_UUID.test(id)) add(`${prefix}${["WorkspaceId", "ItemId", "EndpointId"][i]}`, PROJECT_MESSAGES.uuids); });
        const needed = kind === "fabric_lakehouse" ? ids : ids.slice(0, 2);
        if (database && needed.some((id) => !id)) add(`${prefix}Database`, PROJECT_MESSAGES.targetIncomplete(label));
        if (!database && ids.some(Boolean)) add(`${prefix}Database`, PROJECT_MESSAGES.targetIncomplete(label));
      } else {
        if (server && !isServerHost(server)) add(`${prefix}Server`, PROJECT_MESSAGES.serverHost);
        if ((database && !server) || (!database && server)) add(`${prefix}Database`, PROJECT_MESSAGES.targetIncomplete(label));
      }
    }
  }
  for (const field of ["schemaCompareExclude", "schemaCompareRebuild"]) {
    if (badSchemaNames(settings[field]).length) add(field, PROJECT_MESSAGES.schemaNames);
  }
  if (settings.schemaCompareDestructive && !SCHEMA_COMPARE_DESTRUCTIVE.includes(settings.schemaCompareDestructive)) add("schemaCompareDestructive", PROJECT_MESSAGES.destructive);
  const setNames = new Set();
  (settings.namedTargets || []).forEach((set, index) => {
    const at = (key) => `namedTargets.${index}.${key}`;
    const name = String(set.name || "");
    if (!NAMED_SET_NAME.test(name) || setNames.has(name)) add(at("name"), PROJECT_MESSAGES.namedSetName);
    setNames.add(name);
    const setKind = String(set.kind || "").toLowerCase();
    if (!SQL_TARGET_KINDS.includes(setKind) || !kind) add(at("kind"), PROJECT_MESSAGES.namedSetKind);
    let answered = 0;
    for (const env of NAMED_SET_ENVIRONMENTS) {
      const entry = set[env] || {};
      const database = String(entry.database || "").trim();
      const ids = ["workspaceId", "itemId", "endpointId"].map((k) => String(entry[k] || "").trim());
      const server = String(entry.server || "").trim();
      if (database) answered += 1;
      if (!SQL_TARGET_KINDS.includes(setKind)) continue;
      if (SQL_TARGET_DISCOVERED_KINDS.has(setKind)) {
        ids.forEach((id, i) => { if (id && !CANONICAL_UUID.test(id)) add(at(`${env}.${["workspaceId", "itemId", "endpointId"][i]}`), PROJECT_MESSAGES.uuids); });
        const needed = setKind === "fabric_lakehouse" ? ids : ids.slice(0, 2);
        if ((database && needed.some((id) => !id)) || (!database && ids.some(Boolean))) add(at(`${env}.database`), PROJECT_MESSAGES.namedSetEntry(name, env));
      } else {
        if (server && !isServerHost(server)) add(at(`${env}.server`), PROJECT_MESSAGES.serverHost);
        if ((database && !server) || (!database && server)) add(at(`${env}.database`), PROJECT_MESSAGES.namedSetEntry(name, env));
      }
    }
    if (!answered) add(at("name"), PROJECT_MESSAGES.namedSetEmpty(name));
  });
  const seen = new Set();
  (settings.repositories || []).forEach((repo, index) => {
    if (seen.has(repo.name)) add(`repositories.${index}.name`, PROJECT_MESSAGES.repoName(repo.name));
    seen.add(repo.name);
  });
  return problems;
}

/** The contract text an answer set produces: patched when a contract exists,
 *  a complete new one otherwise (what /setup-project writes). */
export function projectContractText(original, settings) {
  return original ? applyProjectWizardSettings(original, settings) : renderProjectWizardSettings(settings);
}
