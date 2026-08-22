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
assert s['powerbi']['args'][-1]=='--readonly'
model=s['powerbi-modeling-mcp']['args']
assert '--start' in model and '--readonly' in model
assert model[1].endswith('@'+manifest['npm_tools']['@microsoft/powerbi-modeling-mcp'])
assert all('@latest' not in str(v) and 'TODO-' not in str(v) for v in s.values())
assert s['azure-devops']['args'][1].endswith('@'+manifest['mcp_servers']['@azure-devops/mcp'])
# context-mode is a native Pi extension — never generated as an MCP server.
assert 'context-mode' not in s
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
printf '%s\n' '{"schema_version":1,"azure":{"tenant_id":"coop-tenant"},"integrations":{"power_bi":true,"fabric":false,"power_bi_modeling":false,"azure_devops":false,"microsoft_learn":false,"context_mode":false}}' > "$d/config"
"$PY" "$ROOT/lib/mcp_config.py" --config "$d/config" --output "$d/user-owned.json" || exit 1
"$PY" - "$d/user-owned.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert m['mcpServers']['powerbi']['args'][-1]=='--custom-auth'; assert 'powerbi' not in m['_coop']['managed_servers']
PY
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
