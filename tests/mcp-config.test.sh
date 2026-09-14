#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python)"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
cat > "$d/config" <<'JSON'
{"schema_version":1,"azure":{"tenant_id":"tenant-1"},"integrations":{"fabric":true,"power_bi":true,"power_bi_modeling":true,"azure_devops":true,"microsoft_learn":true,"context_mode":true},"azure_devops":{"organization":"cooptimize"}}
JSON
cat > "$d/mcp.json" <<'JSON'
{"mcpServers":{"custom":{"command":"custom","args":["x"]},"fabric":{"command":"npx","args":["-y","@microsoft/fabric-mcp@old"],"customField":true}},"_coop":{"schema_version":1,"managed_servers":["fabric"]}}
JSON
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/mcp.json" || exit 1
"$PY" - "$d/mcp.json" "$ROOT/config/release-manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); manifest=json.load(open(sys.argv[2])); s=m['mcpServers']
assert s['custom']=={'command':'custom','args':['x']}
assert s['fabric']['customField'] is True
sql=s['fabric-sqlendpoint']
assert sql['args']==['-y','mcp-remote@'+manifest['mcp_servers']['mcp-remote'],'https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint','--transport','http-only','--silent']
assert 'Bearer' not in json.dumps(sql) and 'accessToken' not in json.dumps(sql)
assert s['powerbi']['args'][-1]=='--readonly'
model=s['powerbi-modeling-mcp']['args']
assert '--start' in model and '--readonly' in model
assert model[1].endswith('@'+manifest['npm_tools']['@microsoft/powerbi-modeling-mcp'])
assert all('@latest' not in str(v) and 'TODO-' not in str(v) for v in s.values())
assert s['azure-devops']['args'][1].endswith('@'+manifest['mcp_servers']['@azure-devops/mcp'])
# context-mode is a native Pi extension — never generated as an MCP server.
assert 'context-mode' not in s
PY
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
assert s['args'][2]=='https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/11111111-1111-1111-1111-111111111111/items/22222222-2222-2222-2222-222222222222/sqlEndpoint'
assert s['_coop_target']['scope']=='item'
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
assert '/items/44444444-4444-4444-4444-444444444444/sqlEndpoint' in s['args'][2]
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
{"mcpServers":{"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/not-a-uuid/items/22222222-2222-2222-2222-222222222222/sqlEndpoint","--transport","http-only","--silent"]}}}
JSON
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/bad-sql-mcp.json" > "$d/bad-sql-doctor.json" || exit 1
"$PY" - "$d/bad-sql-doctor.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['state']=='target_invalid'
PY
cat > "$d/token-sql-mcp.json" <<'JSON'
{"mcpServers":{"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","--transport","http-only","--silent","Bearer secret"]}}}
JSON
"$PY" "$ROOT/lib/warehouse_mcp.py" doctor-json "$d/token-sql-mcp.json" > "$d/token-sql-doctor.json" || exit 1
"$PY" - "$d/token-sql-doctor.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['state']=='unavailable'
PY
# Machine config can disable the distinct Warehouse MCP without disabling general Fabric.
printf '%s\n' '{"schema_version":1,"integrations":{"fabric":true,"fabric_sql_endpoint":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/disabled-mcp.json" || exit 1
"$PY" - "$d/disabled-mcp.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))['mcpServers']
assert 'fabric' in s and 'fabric-sqlendpoint' not in s
PY
# Missing tenant omits tenant-dependent Power BI server without placeholders.
printf '%s\n' '{"schema_version":1,"integrations":{"power_bi":true,"fabric":false,"power_bi_modeling":false,"azure_devops":false,"microsoft_learn":false,"context_mode":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/mcp2.json" || exit 1
"$PY" - "$d/mcp2.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert 'powerbi' not in m['mcpServers']; assert 'TODO-' not in json.dumps(m)
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
