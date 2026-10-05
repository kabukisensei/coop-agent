// The project contract (.coop/project.yml) as /setup-project and the coop
// window's project form read and write it: one implementation, used by the
// coop-tools extension (the terminal wizard) and desktop/ (the form), so both
// keep unowned fields, write the same text and take a backup the same way.
//
// The text patcher touches only the scalar paths the wizard owns; comments,
// custom sections, policies and future or unknown keys stay byte for byte.
// Block-style YAML only, dependency-free (no YAML library on fresh machines).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { userProfilePath as coopUserProfilePath } from "./paths.mjs";

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
 *   repositories: ProjectRepositorySettings[], fabricEnabled: boolean, tenantId: string,
 *   fabricWorkspaceName: string, fabricWorkspaceId: string, sqlEndpointItemType?: string,
 *   sqlEndpointItemName?: string, sqlEndpointItemId?: string, sqlEndpointPropertiesId?: string,
 *   powerBiWorkspaceName: string, powerBiWorkspaceId: string, tabularEditorEnabled: boolean,
 *   tabularEditorPath: string, bpaRulesPath: string, sqlTargetKind: string,
 *   sqlTargetServer: string, sqlTargetDatabase: string, fabricLayout?: string,
 *   tableMappingRule?: string, tableMappingSchema?: string, tableMappingPrefix?: string }} ProjectWizardSettings
 */

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
    indent += 2;
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
    start = hit + 1;
    end = yamlBlockEnd(lines, hit, indent);
    indent += 2;
  }
  return "";
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
      indent += 2;
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
export function upsertProjectYamlScalar(text, path, value) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rendered = typeof value === "boolean" ? String(value) : yamlQuoted(value);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth];
    const hit = findYamlKey(lines, key, start, end, indent);
    if (hit >= 0) {
      if (depth === path.length - 1) {
        lines[hit] = `${" ".repeat(indent)}${yamlKey(key)}: ${rendered}`;
        return lines.join("\n");
      }
      // A scalar/flow value cannot contain child mappings; convert only this
      // parent line to a block mapping before inserting the wizard-owned child.
      const after = lines[hit].trim().slice(lines[hit].trim().indexOf(":") + 1).trim();
      if (after && !after.startsWith("#")) lines[hit] = `${" ".repeat(indent)}${yamlKey(key)}:`;
      start = hit + 1;
      end = yamlBlockEnd(lines, hit, indent);
      indent += 2;
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
    const at = depth === 0 ? lines.length : end;
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
  const names = [];
  for (let i = repos + 1; i < end; i++) {
    if (yamlIndent(lines[i]) !== 2) continue;
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
    fabricEnabled: boolValue(fabricFlag, Boolean(projectYamlScalar(text, ["fabric", "tenant_id"]))),
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
  lines.push(
    `    database: ${yamlQuoted(settings.sqlTargetDatabase)}`,
    "  test:",
    `    kind: ${yamlQuoted(kind)}`,
    ...(discovered ? ["    workspace_id: ''", "    item_id: ''"] : ["    server: ''"]),
    "    database: ''",
    "  prod:",
    `    kind: ${yamlQuoted(kind)}`,
    ...(discovered ? ["    workspace_id: ''", "    item_id: ''"] : ["    server: ''"]),
    "    database: ''",
  );
  return lines;
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
  set(["tools", "fabric_cli", "enabled"], settings.fabricEnabled);
  set(["tools", "fabric_cicd", "enabled"], settings.fabricEnabled);
  set(["mcp", "fabric", "enabled"], settings.fabricEnabled);
  set(["mcp", "fabric_sqlendpoint", "enabled"], settings.fabricEnabled);
  if (settings.fabricEnabled) {
    set(["fabric", "tenant_id"], settings.tenantId);
    set(["fabric", "default_workspace_name"], settings.fabricWorkspaceName);
    set(["fabric", "default_workspace_id"], canonicalProjectUuid(settings.fabricWorkspaceId));
    set(["fabric", "default_sql_endpoint", "item_type"], projectSqlEndpointType(settings.sqlEndpointItemType));
    set(["fabric", "default_sql_endpoint", "item_name"], settings.sqlEndpointItemName || "");
    set(["fabric", "default_sql_endpoint", "item_id"], canonicalProjectUuid(settings.sqlEndpointItemId));
    set(["fabric", "default_sql_endpoint", "sqlEndpointProperties", "id"], canonicalProjectUuid(settings.sqlEndpointPropertiesId));
    set(["power_bi", "default_workspace_name"], settings.powerBiWorkspaceName);
    set(["power_bi", "default_workspace_id"], settings.powerBiWorkspaceId);
    set(["fabric", "layout"], settings.fabricLayout || "");
    // The mapping (C2) is always written once Fabric / Power BI is on, so the
    // contract states the rule coop follows instead of leaving it assumed.
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
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Render a complete safe contract for first-time setup. */
export function renderProjectWizardSettings(settings) {
  const lines = [
    "# Cooptimize agent — project contract (.coop/project.yml)",
    "# Generated by Coop's in-app /setup-project wizard.",
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
  lines.push(
    "",
    "tools:",
    "  fabric_cli:",
    "    command: 'fab'",
    `    enabled: ${settings.fabricEnabled}`,
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
    `    enabled: ${settings.fabricEnabled}`,
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
    `  policy: ${settings.fabricEnabled ? "baseline" : "disabled"}`,
    "",
    "# Standards: the canonical Cooptimize standards come from cooptimize/coop-standards",
    "# (`coop sync`, `/standards-status`). Add an override only when this project has",
    "# deliberately approved different standards for a domain. Use a single Markdown file per",
    "# coop domain (sql, dax, or semantic_model), set as `path:`.",
    "# standards:",
    "#   sql:",
    "#     path: \"docs/standards/client-sql.md\"",
    "",
    "backup:",
    "  root: '.backups'",
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

export function findGitRoot(cwd) {
  let dir = resolve(cwd || ".");
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeProjectContract(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  let backup = null;
  if (existsSync(path)) {
    backup = `${path}.bak`;
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
    if (settings.tableMappingRule && !TABLE_MAPPING_RULES.includes(settings.tableMappingRule)) add("tableMappingRule", PROJECT_MESSAGES.mappingRule);
    if (settings.tableMappingSchema && !SQL_IDENTIFIER.test(settings.tableMappingSchema)) add("tableMappingSchema", PROJECT_MESSAGES.mappingSchema);
    if (settings.tableMappingRule === "prefix" && !SQL_PREFIX.test(settings.tableMappingPrefix || "")) add("tableMappingPrefix", PROJECT_MESSAGES.mappingPrefix);
  }
  const kind = settings.sqlTargetKind || "";
  if (kind && !SQL_TARGET_KINDS.includes(kind)) add("sqlTargetKind", PROJECT_MESSAGES.targetKind);
  if (kind && !SQL_TARGET_DISCOVERED_KINDS.has(kind) && !isServerHost(settings.sqlTargetServer)) add("sqlTargetServer", PROJECT_MESSAGES.serverHost);
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
