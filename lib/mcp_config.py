#!/usr/bin/env python3
"""Generate COOP's deterministic MCP runtime config from the release manifest and ~/.coop/config.

Unknown and unmarked same-name servers are preserved. COOP updates command/args/env
only for entries listed in top-level `_coop.managed_servers`. A narrow migration removes
or adopts only legacy COOP placeholders containing TODO-/@latest. No secrets are read.
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

SERVER_PACKAGES = {
    "fabric": "@microsoft/fabric-mcp",
    "powerbi": "powerbi-mcp-server",
    "powerbi-modeling-mcp": "@microsoft/powerbi-modeling-mcp",
    "azure-devops": "@azure-devops/mcp",
    "microsoft-learn": "mcp-remote",
}
# NOTE: context-mode is deliberately NOT here. It is a native Pi extension
# (release manifest `extensions` list, installed via `pi install`) — generating it
# too as an MCP server would register the same capability twice.


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


def desired_servers(manifest: dict[str, Any], config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if config and config.get("schema_version") != 1:
        raise ValueError("~/.coop/config schema_version must be 1")
    integrations = config.get("integrations", {}) if isinstance(config.get("integrations", {}), dict) else {}
    azure = config.get("azure", {}) if isinstance(config.get("azure", {}), dict) else {}
    ado = config.get("azure_devops", {}) if isinstance(config.get("azure_devops", {}), dict) else {}
    enabled = lambda name, default=True: integrations.get(name, default) is True
    tenant = azure.get("tenant_id", "") if isinstance(azure.get("tenant_id", ""), str) else ""
    tenant_purpose = azure.get("purpose", "client_resources")
    if tenant and tenant_purpose != "client_resources":
        raise ValueError("~/.coop/config azure.tenant_id is reserved for client resources")
    org = ado.get("organization", "") if isinstance(ado.get("organization", ""), str) else ""
    out: dict[str, dict[str, Any]] = {}
    env = {"AZURE_TOKEN_CREDENTIALS": "AzureCliCredential"}
    if enabled("fabric"):
        out["fabric"] = {"command": "npx", "args": ["-y", spec(manifest, SERVER_PACKAGES["fabric"]), "server", "start", "--mode", "namespace"], "env": env}
    # Current Azure-backed MCP servers are exclusively client-facing. The future
    # Shared Knowledge server must read a separate `knowledge` config and use its
    # own authentication/token cache, never this Azure CLI credential domain.
    if enabled("power_bi") and tenant:
        out["powerbi"] = {"command": "npx", "args": ["-y", spec(manifest, SERVER_PACKAGES["powerbi"]), "--authentication", "azcli", "--tenant", tenant, "--readonly"], "env": env}
    if enabled("power_bi_modeling"):
        out["powerbi-modeling-mcp"] = {"command": "npx", "args": ["-y", spec(manifest, SERVER_PACKAGES["powerbi-modeling-mcp"]), "--start", "--readonly"]}
    if enabled("azure_devops") and org:
        out["azure-devops"] = {"command": "npx", "args": ["-y", spec(manifest, SERVER_PACKAGES["azure-devops"]), org, "--authentication", "azcli", "-d", "core", "work", "work-items", "search"]}
    if enabled("microsoft_learn"):
        out["microsoft-learn"] = {"command": "npx", "args": ["-y", spec(manifest, SERVER_PACKAGES["microsoft-learn"]), "https://learn.microsoft.com/api/mcp"]}
    return out


def legacy_seeded(name: str, entry: Any) -> bool:
    """Recognize only unmistakable pre-ownership COOP placeholders.

    A same-package npx entry with real tenant/org/auth values is user-owned and must
    never be seized. TODO-/@latest were shipped by COOP and are safe to migrate.
    """
    if name not in SERVER_PACKAGES or not isinstance(entry, dict):
        return False
    args = entry.get("args", [])
    return entry.get("command") == "npx" and isinstance(args, list) and any(
        "TODO-" in str(a) or "@latest" in str(a) for a in args
    )


def generate(manifest: dict[str, Any], config: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
    desired = desired_servers(manifest, config)
    old_servers = existing.get("mcpServers", {}) if isinstance(existing.get("mcpServers", {}), dict) else {}
    meta = existing.get("_coop", {}) if isinstance(existing.get("_coop", {}), dict) else {}
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
            merged = dict(current) if isinstance(current, dict) else {}
            for field in ("command", "args", "env"):
                if field in definition:
                    merged[field] = definition[field]
                else:
                    merged.pop(field, None)
            servers[name] = merged
            managed.add(name)
    result["mcpServers"] = {k: servers[k] for k in sorted(servers)}
    result["_coop"] = {"schema_version": 1, "managed_servers": sorted(managed & set(desired))}
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


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("--manifest", type=Path, default=root / "config" / "release-manifest.json")
    parser.add_argument("--config", type=Path, default=Path.home() / ".coop" / "config")
    parser.add_argument("--output", type=Path, default=Path.home() / ".coop" / "agent" / "mcp.json")
    args = parser.parse_args()
    try:
        manifest = load_json(args.manifest, required=True)
        config = load_json(args.config)
        existing = load_json(args.output)
        atomic_write(args.output, generate(manifest, config, existing))
    except ValueError as exc:
        print(f"mcp config: {exc}", file=os.sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
