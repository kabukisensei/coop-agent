"""Shared Azure CLI discovery and interactive sign-in helpers for Coop wizards.

Azure CLI login can succeed without selecting a default subscription.  In that
case ``az account show`` fails even though ``az login --allow-no-subscriptions``
returned the tenant successfully.  These helpers preserve that login result and
fall back through the other tenant/account inventories exposed by Azure CLI.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def azure_cli_available() -> bool:
    az_cmd = os.environ.get("COOP_AZ_BIN", "az")
    if az_cmd == "az":
        return bool(shutil.which("az"))
    return Path(az_cmd).is_file() or bool(shutil.which(az_cmd))


def azure_argv(*args: str) -> list[str]:
    """Build a cross-platform Azure CLI command, including Windows stubs."""
    az_cmd = os.environ.get("COOP_AZ_BIN", "az")
    if sys.platform == "win32" and az_cmd.lower().endswith((".bat", ".cmd")):
        return ["cmd.exe", "/c", az_cmd, *args]
    return [az_cmd, *args]


def _parse_json(text: str) -> object:
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return {}


def tenants_from_json(value: object) -> list[dict[str, str]]:
    """Normalize Azure CLI account/login/tenant-list JSON into tenant records."""
    items = value if isinstance(value, list) else [value]
    tenants: list[dict[str, str]] = []
    by_id: dict[str, dict[str, str]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        tenant_id = str(item.get("tenantId") or item.get("tenant_id") or "").strip()
        if not tenant_id:
            continue
        name = str(item.get("displayName") or item.get("name") or "").strip()
        domain = str(item.get("defaultDomain") or item.get("tenantDefaultDomain") or "").strip()
        existing = by_id.get(tenant_id)
        if existing:
            if not existing["name"] and name:
                existing["name"] = name
            if not existing["domain"] and domain:
                existing["domain"] = domain
            continue
        tenant = {"tenant_id": tenant_id, "name": name, "domain": domain}
        by_id[tenant_id] = tenant
        tenants.append(tenant)
    return tenants


def _merge_tenants(target: list[dict[str, str]], incoming: list[dict[str, str]]) -> None:
    by_id = {tenant["tenant_id"]: tenant for tenant in target}
    for tenant in incoming:
        existing = by_id.get(tenant["tenant_id"])
        if existing:
            for key in ("name", "domain"):
                if not existing[key] and tenant[key]:
                    existing[key] = tenant[key]
        else:
            target.append(tenant)
            by_id[tenant["tenant_id"]] = tenant


def _query_tenants(*args: str, timeout: int = 20) -> list[dict[str, str]]:
    try:
        result = subprocess.run(
            azure_argv(*args, "--output", "json"),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            return []
        return tenants_from_json(_parse_json(result.stdout))
    except (OSError, subprocess.SubprocessError):
        return []


def discover_azure_tenants() -> list[dict[str, str]]:
    """Return all discoverable signed-in tenants, current account first."""
    if not azure_cli_available():
        return []
    tenants: list[dict[str, str]] = []
    # The first query preserves Azure CLI's current/default account ordering.
    _merge_tenants(tenants, _query_tenants("account", "show"))
    _merge_tenants(tenants, _query_tenants("account", "list", "--all"))
    return tenants


def login_azure(use_device_code: bool = False) -> tuple[bool, list[dict[str, str]]]:
    """Run Azure sign-in and return its verified tenant inventory.

    stderr remains attached to the terminal so browser/device-code directions
    stay visible. stdout is captured because it contains the only reliable
    tenant record for successful no-subscription and guest-tenant logins.
    """
    args = ["login", "--allow-no-subscriptions"]
    if use_device_code:
        args.append("--use-device-code")
    args.extend(("--output", "json"))
    try:
        result = subprocess.run(
            azure_argv(*args),
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
        )
    except KeyboardInterrupt:
        return False, []
    except (OSError, subprocess.SubprocessError):
        return False, []

    tenants = tenants_from_json(_parse_json(result.stdout)) if result.returncode == 0 else []
    if result.returncode == 0:
        _merge_tenants(tenants, discover_azure_tenants())
    return result.returncode == 0, tenants


def tenant_label(tenant: dict[str, str]) -> str:
    """Human-readable tenant label that always includes the immutable ID."""
    friendly = tenant.get("domain") or tenant.get("name")
    tenant_id = tenant.get("tenant_id", "")
    return f"{friendly} ({tenant_id})" if friendly else tenant_id
