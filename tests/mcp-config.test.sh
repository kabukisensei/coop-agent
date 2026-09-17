#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python)"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
mkdir -p "$d/no-project"
cat > "$d/config" <<'JSON'
{"schema_version":1,"azure":{"tenant_id":"tenant-1"},"integrations":{"fabric":true,"power_bi":true,"power_bi_modeling":true,"azure_devops":true,"microsoft_learn":true,"context_mode":true},"azure_devops":{"organization":"cooptimize"}}
JSON
cat > "$d/mcp.json" <<'JSON'
{"mcpServers":{"custom":{"command":"custom","args":["x"]},"fabric":{"command":"npx","args":["-y","@microsoft/fabric-mcp@old"],"customField":true,"lifecycle":"eager","auth":"custom-managed-auth","headers":{"X-Managed-Custom":"keep-me"},"extraSettings":{"retry":3}},"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","--transport","http-only","--silent"],"auth":"oauth","bearerToken":"stale-secret-fixture","bearerTokenEnv":"STALE_FABRIC_TOKEN_ENV","headers":{"Authorization":"Bearer stale-secret-fixture"},"oauth":{"legacy":true},"lifecycle":"eager"}},"_coop":{"schema_version":1,"managed_servers":["fabric","fabric-sqlendpoint"]}}
JSON
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/no-project" --output "$d/mcp.json"
"$PY" - "$d/mcp.json" "$ROOT/config/release-manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); manifest=json.load(open(sys.argv[2])); s=m['mcpServers']
assert s['custom']=={'command':'custom','args':['x']}
assert s['fabric']['customField'] is True
assert s['fabric']['lifecycle']=='eager'
assert s['fabric']['auth']=='custom-managed-auth'
assert s['fabric']['headers']=={'X-Managed-Custom':'keep-me'}
assert s['fabric']['extraSettings']=={'retry':3}
sql=s['fabric-sqlendpoint']
assert sql['url']=='https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint'
assert sql['auth']=='bearer' and sql['bearerTokenEnv']=='COOP_FABRIC_MCP_TOKEN'
assert sql['lifecycle']=='lazy'
assert sql['_coop_runtime']=={'request_timeout_ms':60000}
assert 'command' not in sql and 'args' not in sql and 'mcp-remote' not in json.dumps(sql)
assert 'bearerToken' not in sql and 'Authorization' not in json.dumps(sql)
assert 'oauth' not in sql and sql['bearerTokenEnv']=='COOP_FABRIC_MCP_TOKEN'
assert s['powerbi']['args'][-1]=='--readonly'
model=s['powerbi-modeling-mcp']['args']
assert '--start' in model and '--readonly' in model
assert model[1].endswith('@'+manifest['npm_tools']['@microsoft/powerbi-modeling-mcp'])
assert all('@latest' not in str(v) and 'TODO-' not in str(v) for v in s.values())
assert s['azure-devops']['args'][1].endswith('@'+manifest['mcp_servers']['@azure-devops/mcp'])
learn=s['microsoft-learn']
assert learn['command']=='npx'
assert learn['args']==['-y','mcp-remote@'+manifest['mcp_servers']['mcp-remote'],'https://learn.microsoft.com/api/mcp','--transport','http-only','--silent']
# context-mode is a native Pi extension — never generated as an MCP server.
assert 'context-mode' not in s
PY
cp "$d/mcp.json" "$d/mcp-first.json"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/no-project" --output "$d/mcp.json"
cmp "$d/mcp-first.json" "$d/mcp.json"
# Project IDs select item-scoped Warehouse URL only when complete and canonical.
mkdir -p "$d/project/.coop"
cat > "$d/project/.coop/project.yml" <<'YAML'
fabric:
  default_workspace_id: "11111111-1111-1111-1111-111111111111"
  default_sql_endpoint:
    item_type: "Warehouse"
    item_name: "DW"
    item_id: "22222222-2222-2222-2222-222222222222"
YAML
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/project" --output "$d/item-mcp.json" || exit 1
"$PY" - "$d/item-mcp.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))['mcpServers']['fabric-sqlendpoint']
assert s['url']=='https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/11111111-1111-1111-1111-111111111111/items/22222222-2222-2222-2222-222222222222/sqlEndpoint'
assert s['_coop_target']['scope']=='item'
assert s['_coop_runtime']['request_timeout_ms']==60000
PY
# Lakehouse targets use sqlEndpointProperties.id, not the Lakehouse item id.
cat > "$d/project/.coop/project.yml" <<'YAML'
fabric:
  default_workspace_id: "11111111-1111-1111-1111-111111111111"
  default_sql_endpoint:
    item_type: "Lakehouse"
    item_name: "LH"
    item_id: "33333333-3333-3333-3333-333333333333"
    sqlEndpointProperties:
      id: "44444444-4444-4444-4444-444444444444"
YAML
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/project" --output "$d/lakehouse-mcp.json" || exit 1
"$PY" - "$d/lakehouse-mcp.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))['mcpServers']['fabric-sqlendpoint']
assert '/items/44444444-4444-4444-4444-444444444444/sqlEndpoint' in s['url']
PY
# Warehouse doctor never reports healthy from config alone; mocked tools/list
# controls compatible spelling status, and item targets require auth/REST validation.
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/mcp.json" --tools-json '{"tools":[{"name":"executeSQL"}]}' > "$d/sql-doctor.json" || exit 1
"$PY" - "$d/sql-doctor.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
assert v['registered'] is True
assert v['state']=='registered'
assert 'execute_query' in v['compatible_tools']
assert v['target']['scope']=='global'
PY
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/mcp.json" --tools-json '{"tools":[{"name":"listTables"}]}' > "$d/sql-missing.json" || exit 1
"$PY" - "$d/sql-missing.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['state']=='tool_missing'
PY
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/item-mcp.json" --project "$d/project/.coop/project.yml" --tools-json '{"tools":[{"name":"fabric-sqlendpoint-execute_query"}]}' > "$d/sql-item-auth.json" || exit 1
"$PY" - "$d/sql-item-auth.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
assert v['state'] in ('auth_required','target_invalid','registered')
assert v['target']['scope']=='item'
PY
cat > "$d/mismatch-project.yml" <<'YAML'
fabric:
  default_workspace_id: "11111111-1111-1111-1111-111111111111"
  default_sql_endpoint:
    item_type: "Warehouse"
    item_id: "55555555-5555-5555-5555-555555555555"
YAML
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/item-mcp.json" --project "$d/mismatch-project.yml" --tools-json '{"tools":[{"name":"executeSQL"}]}' > "$d/sql-mismatch.json" || exit 1
"$PY" - "$d/sql-mismatch.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
assert v['state']=='target_invalid'
assert v['registered_target']['scope']=='item'
PY
cat > "$d/bad-sql-mcp.json" <<'JSON'
{"mcpServers":{"fabric-sqlendpoint":{"url":"https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/not-a-uuid/items/22222222-2222-2222-2222-222222222222/sqlEndpoint","auth":"bearer","bearerTokenEnv":"COOP_FABRIC_MCP_TOKEN","lifecycle":"lazy"}},"_coop":{"schema_version":1,"managed_servers":["fabric-sqlendpoint"]}}
JSON
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/bad-sql-mcp.json" > "$d/bad-sql-doctor.json" || exit 1
"$PY" - "$d/bad-sql-doctor.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['state']=='target_invalid'
PY
cat > "$d/token-sql-mcp.json" <<'JSON'
{"mcpServers":{"fabric-sqlendpoint":{"url":"https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","auth":"bearer","bearerTokenEnv":"COOP_FABRIC_MCP_TOKEN","lifecycle":"lazy","bearerToken":"secret"}},"_coop":{"schema_version":1,"managed_servers":["fabric-sqlendpoint"]}}
JSON
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/token-sql-mcp.json" > "$d/token-sql-doctor.json" || exit 1
"$PY" - "$d/token-sql-doctor.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['state']=='unavailable'
PY
# Machine config can disable the distinct Warehouse MCP without disabling general Fabric.
printf '%s\n' '{"schema_version":1,"integrations":{"fabric":true,"fabric_sql_endpoint":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/no-project" --output "$d/disabled-mcp.json"
"$PY" - "$d/disabled-mcp.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))['mcpServers']
assert 'fabric' in s and 'fabric-sqlendpoint' not in s
PY
# Missing tenant omits tenant-dependent Power BI server without placeholders.
printf '%s\n' '{"schema_version":1,"integrations":{"power_bi":true,"fabric":false,"power_bi_modeling":false,"azure_devops":false,"microsoft_learn":false,"context_mode":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/no-project" --output "$d/mcp2.json"
"$PY" - "$d/mcp2.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert 'powerbi' not in m['mcpServers']; assert 'fabric-sqlendpoint' not in m['mcpServers']; assert 'TODO-' not in json.dumps(m)
PY
# An explicit new SQL endpoint setting may override the legacy Fabric opt-out.
printf '%s\n' '{"schema_version":1,"integrations":{"fabric":false,"fabric_sql_endpoint":true,"power_bi":false,"power_bi_modeling":false,"azure_devops":false,"microsoft_learn":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/no-project" --output "$d/sql-override.json"
"$PY" - "$d/sql-override.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))['mcpServers']; assert 'fabric' not in s and 'fabric-sqlendpoint' in s
PY
# Explicit malformed item scope is fail-closed and never emits the global endpoint.
cat > "$d/project/.coop/project.yml" <<'YAML'
fabric:
  default_workspace_id: "not-a-uuid"
  default_sql_endpoint:
    item_type: "Warehouse"
    item_id: "22222222-2222-2222-2222-222222222222"
YAML
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --project-cwd "$d/project" --output "$d/invalid-target.json" || exit 1
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/invalid-target.json" --project "$d/project/.coop/project.yml" > "$d/invalid-target-doctor.json" || exit 1
"$PY" - "$d/invalid-target.json" "$d/invalid-target-doctor.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); d=json.load(open(sys.argv[2])); assert 'fabric-sqlendpoint' not in m['mcpServers']; assert d['state']=='target_invalid'; assert d['target']['scope']=='invalid'
PY
# Unmarked same-package entries are user-owned and never seized.
cat > "$d/user-owned.json" <<'JSON'
{"mcpServers":{"powerbi":{"command":"npx","args":["-y","powerbi-mcp-server@9.9.9","--tenant","user-tenant","--custom-auth"]}}}
JSON
printf '%s\n' '{"schema_version":1,"azure":{"tenant_id":"client-tenant"},"integrations":{"power_bi":true,"fabric":false,"power_bi_modeling":false,"azure_devops":false,"microsoft_learn":false,"context_mode":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/user-owned.json" || exit 1
"$PY" - "$d/user-owned.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert m['mcpServers']['powerbi']['args'][-1]=='--custom-auth'; assert 'powerbi' not in m['_coop']['managed_servers']
PY
# A tenant explicitly marked for another identity domain must never be routed
# into client-facing Fabric/Power BI servers.
printf '%s\n' '{"schema_version":1,"azure":{"tenant_id":"knowledge-tenant","purpose":"shared_knowledge"},"integrations":{"power_bi":true}}' > "$d/config"
if "$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/wrong-domain.json" 2>"$d/wrong-domain.err"; then
  echo 'wrong-domain Azure tenant was accepted for client MCP servers' >&2
  exit 1
fi
grep -q 'reserved for client resources' "$d/wrong-domain.err" || exit 1
# Unmistakable pre-marker TODO/@latest COOP seeds migrate and are removed when disabled.
cat > "$d/legacy.json" <<'JSON'
{"mcpServers":{"powerbi":{"command":"npx","args":["-y","powerbi-mcp-server@latest","--tenant","TODO-tenant-id"]},"custom":{"command":"x"}}}
JSON
printf '%s\n' '{"schema_version":1,"integrations":{"power_bi":false,"fabric":false,"power_bi_modeling":false,"azure_devops":false,"microsoft_learn":false,"context_mode":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/legacy.json" || exit 1
"$PY" - "$d/legacy.json" "$ROOT/config/mcp.example.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert 'powerbi' not in m['mcpServers']; assert 'custom' in m['mcpServers']
example=json.load(open(sys.argv[2])); assert example['mcpServers']=={}; assert '@latest' not in json.dumps(example)
PY
printf '  ✓ MCP config is pinned, safe, ownership-aware, and placeholder-free\n'
