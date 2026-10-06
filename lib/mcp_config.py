#!/usr/bin/env python3
"""Generate COOP's deterministic MCP runtime config from the release manifest and ~/.coop/config.

Unknown and unmarked same-name servers are preserved. COOP updates runtime fields
only for entries listed in top-level `_coop.managed_servers`. A narrow migration removes
or adopts only legacy COOP placeholders containing TODO-/@latest. No secrets are read.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

LIB_DIR = Path(__file__).resolve().parent
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

import coop_paths  # noqa: E402
from warehouse_mcp import (  # noqa: E402
    find_project_yml,
    integration_enabled,
    load_project,
    machine_sqlendpoint_enabled,
    project_sqlendpoint_enabled,
    project_target,
)

# Servers COOP generates. The npm-backed ones run through `npx <package>@<pin>`;
# the two direct HTTP servers (value None) are spoken to by pi-mcp-adapter itself
# (Streamable HTTP with SSE fallback), so they need no package at all.
SERVER_PACKAGES = {
    "fabric": "@microsoft/fabric-mcp",
    "fabric-sqlendpoint": None,
    "powerbi-modeling-mcp": "@microsoft/powerbi-modeling-mcp",
    "azure-devops": "@azure-devops/mcp",
    "microsoft-learn": None,
}
# Direct HTTP entries are wholly COOP-owned and replaced on every regeneration, so
# a stale transport, auth or `command`/`args` field (the pre-0.25 `mcp-remote`
# bridge for Microsoft Learn) can never survive a sync.
URL_SERVERS = frozenset({"fabric-sqlendpoint", "microsoft-learn"})
# Servers COOP generated in earlier releases and no longer generates. Their names
# are still COOP's, so a marked entry or a legacy TODO-/@latest placeholder is
# removed on the next sync; an unmarked user-owned entry is left alone (doctor
# warns). `powerbi` ran powerbi-mcp-server, which ignores --readonly and exposes
# refresh_dataset, a write (#93); powerbi-modeling-mcp is the Power BI MCP.
RETIRED_SERVERS = {"powerbi"}
# NOTE: context-mode is not here: it was a native Pi extension, never an MCP
# server, and its retirement is handled by Remove-CoopRetiredExtensions.


def load_json(path: Path, *, required: bool = False) -> dict[str, Any]:
    if not path.exists():
        if required:
            raise ValueError(f"missing required JSON file: {path}")
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return value


def version(manifest: dict[str, Any], package: str) -> str:
    for section in ("mcp_servers", "npm_tools", "extensions"):
        value = manifest.get(section, {}).get(package)
        if isinstance(value, str) and value:
            return value
    raise ValueError(f"release manifest has no MCP package version for {package}")


def spec(manifest: dict[str, Any], package: str) -> str:
    return f"{package}@{version(manifest, package)}"


def direct_http_server(url: str) -> dict[str, Any]:
    """An unauthenticated Streamable HTTP server the adapter talks to directly.

    `auth: False` skips the adapter's OAuth probing; the adapter defaults to the
    Streamable HTTP transport with SSE fallback, which is what learn.microsoft.com
    serves.
    """
    return {
        "url": url,
        "auth": False,
        "lifecycle": "lazy",
        "requestTimeoutMs": 60000,
    }


def fabric_sqlendpoint_server(url: str) -> dict[str, Any]:
    return {
        "url": url,
        "auth": False,
        "requestHeadersCommand": {
            "command": "node",
            "args": [str(LIB_DIR / "fabric_request_headers.mjs"), url],
            "timeoutMs": 10000,
        },
        "requestTimeoutMs": 60000,
        "lifecycle": "lazy",
    }


def grant_target_metadata(project: dict[str, Any]) -> dict[str, str]:
    """Return non-secret identity fields owned by the parsed project contract."""
    raw_profile = project.get("profile")
    raw_fabric = project.get("fabric")
    profile: dict[str, Any] = raw_profile if isinstance(raw_profile, dict) else {}
    fabric: dict[str, Any] = raw_fabric if isinstance(raw_fabric, dict) else {}
    raw_endpoint = fabric.get("default_sql_endpoint")
    endpoint: dict[str, Any] = raw_endpoint if isinstance(raw_endpoint, dict) else {}
    workspace_name = fabric.get("default_workspace_name")
    environment_names = (
        fabric.get("environment_names")
        if isinstance(fabric.get("environment_names"), dict)
        else {}
    )
    matches = [
        name
        for name in ("dev", "test", "prod")
        if isinstance(workspace_name, str)
        and workspace_name.strip()
        and isinstance(environment_names.get(name), str)
        and environment_names[name].strip().casefold() == workspace_name.strip().casefold()
    ]
    environment = matches[0] if len(matches) == 1 else ""
    if environment == "prod":
        environment = "production"
    return {
        "client": profile.get("client", "") if isinstance(profile.get("client"), str) else "",
        "tenant_id": fabric.get("tenant_id", "") if isinstance(fabric.get("tenant_id"), str) else "",
        "environment": environment,
        "item_name": endpoint.get("item_name", "") if isinstance(endpoint.get("item_name"), str) else "",
    }


def desired_servers(
    manifest: dict[str, Any],
    config: dict[str, Any],
    project: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    if config and config.get("schema_version") != 1:
        raise ValueError("~/.coop/config schema_version must be 1")
    azure = config.get("azure", {}) if isinstance(config.get("azure", {}), dict) else {}
    ado = (
        config.get("azure_devops", {})
        if isinstance(config.get("azure_devops", {}), dict)
        else {}
    )

    def enabled(name: str, default: bool = True) -> bool:
        # warehouse_mcp.integration_enabled is the one flag rule (boolean true only).
        return integration_enabled(config, name, default)

    tenant = (
        azure.get("tenant_id", "")
        if isinstance(azure.get("tenant_id", ""), str)
        else ""
    )
    # Current Azure-backed MCP servers are exclusively client-facing. The future
    # Shared Knowledge server must read a separate `knowledge` config and use its
    # own authentication/token cache, never this Azure CLI credential domain.
    tenant_purpose = azure.get("purpose", "client_resources")
    if tenant and tenant_purpose != "client_resources":
        raise ValueError(
            "~/.coop/config azure.tenant_id is reserved for client resources"
        )
    org = (
        ado.get("organization", "")
        if isinstance(ado.get("organization", ""), str)
        else ""
    )
    out: dict[str, dict[str, Any]] = {}
    env = {"AZURE_TOKEN_CREDENTIALS": "AzureCliCredential"}
    if enabled("fabric"):
        out["fabric"] = {
            "command": "npx",
            "args": [
                "-y",
                spec(manifest, SERVER_PACKAGES["fabric"]),
                "server",
                "start",
                "--mode",
                "namespace",
                # 1.4.0 exposes no router unless its namespaces are named (1.3.0
                # exposed all four by default). Naming them keeps the same four
                # routers on both versions; coop's guardrails classify each
                # router's command (#171).
                "--namespace",
                "docs",
                "--namespace",
                "onelake",
                "--namespace",
                "core",
                "--namespace",
                "datafactory",
            ],
            "env": env,
        }
    if machine_sqlendpoint_enabled(config) and project_sqlendpoint_enabled(
        project or {}
    ):
        target = project_target(project or {})
        # Never turn an explicit malformed/partial item target into the global
        # endpoint. Omitting the managed entry lets Doctor report target_invalid
        # from the project contract without exposing an unintended broad scope.
        if target.scope != "invalid":
            sql_entry = fabric_sqlendpoint_server(target.url)
            sql_entry["_coop_target"] = {
                "scope": target.scope,
                "workspace_id": target.workspace_id,
                "item_id": target.item_id,
                "item_type": target.item_type,
                "reason": target.reason,
                **grant_target_metadata(project or {}),
            }
            out["fabric-sqlendpoint"] = sql_entry
    if enabled("power_bi_modeling"):
        out["powerbi-modeling-mcp"] = {
            "command": "npx",
            "args": [
                "-y",
                spec(manifest, SERVER_PACKAGES["powerbi-modeling-mcp"]),
                "--start",
                # Read-write so an approved edit can land (#159): coop's guardrails
                # classify each call's request.operation and ask before any edit;
                # deletes, whole-model imports, deploys and production always ask.
                "--readwrite",
                # 1.0.0 requires EULA acceptance before any tool runs. Aaron accepted
                # Microsoft's Power BI Authoring MCP EULA for Cooptimize on 2026-09-30;
                # the flag accepts per process and persists nothing.
                "--accept-eula",
            ],
        }
    if enabled("azure_devops") and org:
        out["azure-devops"] = {
            "command": "npx",
            "args": [
                "-y",
                spec(manifest, SERVER_PACKAGES["azure-devops"]),
                org,
                "--authentication",
                "azcli",
                "-d",
                "core",
                "work",
                "work-items",
                "search",
            ],
        }
    if enabled("microsoft_learn"):
        out["microsoft-learn"] = direct_http_server("https://learn.microsoft.com/api/mcp")
    return out


def legacy_seeded(name: str, entry: Any) -> bool:
    """Recognize only unmistakable pre-ownership COOP placeholders.

    A same-package npx entry with real tenant/org/auth values is user-owned and must
    never be seized. TODO-/@latest were shipped by COOP and are safe to migrate.
    """
    if (
        name not in SERVER_PACKAGES and name not in RETIRED_SERVERS
    ) or not isinstance(entry, dict):
        return False
    args = entry.get("args", [])
    return (
        entry.get("command") == "npx"
        and isinstance(args, list)
        and any("TODO-" in str(a) or "@latest" in str(a) for a in args)
    )


def generate(
    manifest: dict[str, Any],
    config: dict[str, Any],
    existing: dict[str, Any],
    project: dict[str, Any] | None = None,
) -> dict[str, Any]:
    desired = desired_servers(manifest, config, project)
    old_servers = (
        existing.get("mcpServers", {})
        if isinstance(existing.get("mcpServers", {}), dict)
        else {}
    )
    meta = (
        existing.get("_coop", {}) if isinstance(existing.get("_coop", {}), dict) else {}
    )
    managed = set(x for x in meta.get("managed_servers", []) if isinstance(x, str))
    result = dict(existing)
    servers = dict(old_servers)
    # Remove disabled marked entries and unmistakable legacy placeholder seeds.
    for name, current in list(servers.items()):
        if name not in desired and (name in managed or legacy_seeded(name, current)):
            servers.pop(name, None)
            managed.discard(name)
    for name, definition in desired.items():
        current = servers.get(name)
        if current is None or name in managed or legacy_seeded(name, current):
            if name in URL_SERVERS:
                # Direct HTTP entries are wholly COOP-owned. Replacing them prevents
                # stale transport/auth fields, or the old `mcp-remote` command line,
                # from surviving regeneration.
                servers[name] = definition
            else:
                merged = dict(current) if isinstance(current, dict) else {}
                for field in ("command", "args", "env", "_coop_target"):
                    if field in definition:
                        merged[field] = definition[field]
                    else:
                        merged.pop(field, None)
                # The adapter can register every server tool directly
                # (`directTools`), bypassing the {server, tool, args} envelope
                # coop's guardrails parse. Coop keeps the proxied dispatch for its
                # managed command servers; the guardrail also labels direct names
                # in case a user config turns it back on. URL entries are replaced
                # wholesale above, so a user-added flag never survives there.
                merged["directTools"] = False
                servers[name] = merged
            managed.add(name)
    result["mcpServers"] = {k: servers[k] for k in sorted(servers)}
    # pi-mcp-adapter's `mcpScript` tool runs JavaScript that calls MCP tools inside
    # the adapter, where no Pi tool_call hook sees them, so coop's MCP mutation and
    # Warehouse SQL guardrails could not gate those calls. Coop always turns it off;
    # other adapter settings a user added are kept. The guardrail also blocks the
    # tool in case a project config turns it back on.
    settings = existing.get("settings")
    settings = dict(settings) if isinstance(settings, dict) else {}
    settings["scriptMode"] = False
    # Adapter 2.37+: the agent may not persist new remote MCP servers with the
    # adapter's install action. Coop's MCP servers are the release's pinned set.
    settings["allowInstall"] = False
    result["settings"] = settings
    result["_coop"] = {
        "schema_version": 1,
        "managed_servers": sorted(managed & set(desired)),
    }
    return result


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(value, f, indent=2, ensure_ascii=False, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


# pi-mcp-adapter 3.0 reads `<agent dir>/mcp-adapter.json` and ignores the old
# `mcp.json`, which belongs to Pi's built-in MCP support from Pi 0.99 on.
ADAPTER_CONFIG_NAME = "mcp-adapter.json"
LEGACY_CONFIG_NAME = "mcp.json"


def legacy_config_for(output: Path) -> Path | None:
    """The pre-3.0 `mcp.json` next to an adapter config, or None."""
    return output.with_name(LEGACY_CONFIG_NAME) if output.name == ADAPTER_CONFIG_NAME else None


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parent.parent
    parser.add_argument(
        "--manifest", type=Path, default=root / "config" / "release-manifest.json"
    )
    # Defaults follow the one profile root (lib/coop_paths.py): the config in
    # <profile dir>/config and the adapter file in the agent dir Pi actually loads.
    parser.add_argument("--config", type=Path, default=coop_paths.config_path())
    parser.add_argument(
        "--output",
        type=Path,
        default=coop_paths.agent_dir() / ADAPTER_CONFIG_NAME,
    )
    # The file whose servers and ownership carry over, when it is not --output:
    # a launch's per-folder copy starts from the shared mcp-adapter.json.
    parser.add_argument("--existing", type=Path, default=None)
    parser.add_argument("--project", type=Path, default=None)
    parser.add_argument("--project-cwd", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        manifest = load_json(args.manifest, required=True)
        config = load_json(args.config)
        existing = load_json(args.existing if args.existing is not None else args.output)
        # Migrate once from the pre-3.0 file: its servers, settings and `_coop`
        # ownership carry over, then it is removed so the adapter stops warning
        # about it. A legacy file without coop's `_coop` marker is someone else's
        # and is left alone once the new file exists.
        legacy = legacy_config_for(args.output) if args.existing is None else None
        legacy_value = None
        if legacy is not None and legacy.exists():
            try:
                legacy_value = load_json(legacy)
            except ValueError:
                legacy_value = None  # unreadable: never migrated, never removed
        migrating = legacy_value is not None and not args.output.exists()
        if migrating:
            existing = legacy_value
        project_path = args.project or find_project_yml(args.project_cwd)
        project = load_project(project_path)
        atomic_write(args.output, generate(manifest, config, existing, project))
        if legacy is not None and legacy_value is not None and (migrating or "_coop" in legacy_value):
            legacy.unlink()
    except ValueError as exc:
        print(f"mcp config: {exc}", file=os.sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
