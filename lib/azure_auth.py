"""Shared Azure CLI discovery and interactive sign-in helpers for Coop wizards.

Azure CLI login can succeed without selecting a default subscription.  In that
case ``az account show`` fails even though ``az login --allow-no-subscriptions``
returned the tenant successfully.  These helpers preserve that login result and
fall back through the other tenant/account inventories exposed by Azure CLI.
"""
from __future__ import annotations

import json
import ntpath
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


# cmd.exe metacharacters (plus CR/LF). A path containing any of them is never
# spliced into a cmd.exe command line (same rule as fabric_request_headers.mjs).
_UNSAFE = re.compile(r'["&|<>^%!\r\n]')
_WINDOWS_AZ_NAMES = ("az.cmd", "az.exe", "az.bat")


def windows_az_path(path_value: str, isfile=None) -> str | None:
    """First az.cmd / az.exe / az.bat in an absolute PATH folder, or None.

    Folders are searched in PATH order and names in the order the Fabric token
    helper uses. Relative and empty entries are ignored, so the current folder
    can never supply az, and a folder with cmd.exe metacharacters is skipped.
    """
    isfile = isfile or os.path.isfile
    for raw in path_value.split(";"):
        entry = raw.strip().strip('"')
        if not entry or not ntpath.isabs(entry) or _UNSAFE.search(entry):
            continue
        for name in _WINDOWS_AZ_NAMES:
            candidate = ntpath.join(entry, name)
            if isfile(candidate):
                return candidate
    return None


def _resolve_az() -> str | None:
    """The Azure CLI to run: COOP_AZ_BIN (test seam) or az found on PATH."""
    override = os.environ.get("COOP_AZ_BIN", "")
    if override and override != "az":
        if Path(override).is_file():
            return override
        return shutil.which(override)
    if sys.platform == "win32":
        return windows_az_path(os.environ.get("PATH", ""))
    return shutil.which("az")


def azure_cli_available() -> bool:
    return _resolve_az() is not None


def windows_az_command(system_root: str, cli: str, args) -> str:
    """cmd.exe command line that runs a .cmd/.bat Azure CLI with literal flags.

    `/s` plus the outer quotes keeps a path such as "C:\\Program Files (x86)\\..."
    in one piece; `cmd /c "<path>" args` without /s strips the outer quotes and
    splits it at the space. `call` returns the batch file's exit code.
    """
    cmd = ntpath.join(system_root, "System32", "cmd.exe")
    return f'"{cmd}" /d /s /c "call "{cli}" {" ".join(args)}"'


def azure_argv(*args: str) -> list[str] | str:
    """Build a cross-platform Azure CLI command, including Windows az.cmd.

    args must be literal flags (no spaces, quotes or cmd.exe metacharacters).
    CreateProcess only appends .exe to a bare name, so on Windows a .cmd/.bat
    Azure CLI runs through an explicit cmd.exe command line (a str, which
    subprocess passes to CreateProcess unchanged); anything else is a list.
    """
    override = os.environ.get("COOP_AZ_BIN", "")
    # An unresolvable COOP_AZ_BIN stays as given (and fails to start); it never
    # falls back to the az on PATH.
    az = _resolve_az() or (override if override and override != "az" else "az")
    if (
        sys.platform == "win32"
        and az.lower().endswith((".cmd", ".bat"))
        and not _UNSAFE.search(az)
    ):
        return windows_az_command(
            os.environ.get("SystemRoot") or r"C:\Windows", az, args
        )
    return [az, *args]


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
        # stdout is captured, so Azure CLI 2.61+'s subscription picker would
        # wait invisibly on stdin; AZURE_CORE_LOGIN_EXPERIENCE_V2=off skips it.
        result = subprocess.run(
            azure_argv(*args),
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            env={**os.environ, "AZURE_CORE_LOGIN_EXPERIENCE_V2": "off"},
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
