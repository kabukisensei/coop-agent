#!/usr/bin/env python3
"""
coop onboard / coop profile edit
First-run and profile-management wizard for COOP.
Writes only to ~/.coop/user.json and ~/.coop/config; never touches project files.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent.parent / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from azure_auth import (  # noqa: E402
    azure_cli_available,
    discover_azure_tenants,
    login_azure,
    tenant_label,
)
import coop_paths  # noqa: E402

# One profile root (master plan S3): COOP_DIR is the parent of .coop, and the
# managed MCP config lands in the agent dir Pi actually loads (same chain as the
# launcher: PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE -> COOP_AGENT_DIR -> default).
COOP_DIR = coop_paths.profile_dir()
USER_JSON = coop_paths.user_profile_path()
CONFIG_JSON = coop_paths.config_path()
MCP_OUTPUT = coop_paths.agent_dir() / "mcp-adapter.json"

PRESETS = {
    "concise": "Answer first. Keep explanations short. Use bullets where useful. Explain tradeoffs only when material.",
    "balanced": "Answer first. Give a brief why. Then structured detail.",
    "teaching": "Answer first. Explain reasoning, alternatives, and tradeoffs in more depth.",
}
PRESET_KEYS = list(PRESETS.keys()) + ["custom"]

# Client SQL platform (master plan section 8 item 7). A machine default stored in
# ~/.coop/config as client.platform; `coop install --platform` and the
# COOP_CLIENT_PLATFORM variable answer the question without a prompt. The
# project contract still wins per repository (one teammate can serve two clients).
PLATFORMS = ["fabric", "azure_sql", "both"]
PLATFORM_LABELS = {
    "fabric": "Microsoft Fabric (Warehouse / Lakehouse SQL endpoint)",
    "azure_sql": "Azure SQL Database (no Fabric)",
    "both": "Both Fabric and Azure SQL",
}
PLATFORM_ENV = "COOP_CLIENT_PLATFORM"


def normalize_platform(value: object) -> str:
    """Canonical platform id for a user/env spelling, or '' when unknown."""
    if not isinstance(value, str):
        return ""
    v = value.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "fabric": "fabric",
        "azure_sql": "azure_sql",
        "azuresql": "azure_sql",
        "azure": "azure_sql",
        "sql": "azure_sql",
        "both": "both",
    }
    return aliases.get(v, "")


def config_platform(config: dict) -> str:
    client = config.get("client") if isinstance(config.get("client"), dict) else {}
    return normalize_platform(client.get("platform", ""))


def fabric_platform(platform: str) -> bool:
    """True unless the machine is an Azure SQL-only client (unset means Fabric)."""
    return platform != "azure_sql"


def coop_user_profile_missing() -> bool:
    return not USER_JSON.is_file()


def find_project_yml() -> Path | None:
    """Walk up from cwd looking for .coop/project.yml (bounded)."""
    cwd = Path.cwd().resolve()
    for _ in range(8):
        candidate = cwd / ".coop" / "project.yml"
        if candidate.is_file():
            return candidate
        parent = cwd.parent
        if parent == cwd:
            break
        cwd = parent
    return None


def parse_consultant_name(project_yml: Path) -> str | None:
    """Best-effort regex extraction of profile.consultant_name from project.yml."""
    try:
        text = project_yml.read_text(encoding="utf-8")
    except Exception:
        return None
    m = re.search(
        r"^\s*consultant_name\s*:\s*['\"]?(.*?)(?:['\"]?\s*$)",
        text,
        re.MULTILINE | re.IGNORECASE,
    )
    if not m:
        return None
    name = m.group(1).strip().strip('"').strip("'")
    if not name or "TODO" in name.upper():
        return None
    return name


def read_input(prompt: str, default: str = "") -> str:
    """Read a line, returning default on EOF or empty in non-interactive mode.
    Prompts go to stderr so stdout stays clean for JSON/cli callers."""
    sys.stderr.write(prompt)
    sys.stderr.flush()
    line = sys.stdin.readline()
    if not line:
        line = ""
    return line.strip() or default


def read_line_bounded(prompt: str, default: str) -> tuple[str, bool]:
    """Read a line for a re-prompting loop. Returns (value, eof).

    On EOF there is nobody left to answer; callers must stop looping instead of
    re-asking forever (a wizard must never spin on a closed pipe).
    """
    sys.stderr.write(prompt)
    sys.stderr.flush()
    line = sys.stdin.readline()
    if not line:
        return default, True
    return (line.strip() or default), False


def read_choice(prompt: str, choices: list[str], default: str = "") -> str:
    """Present a list and return one of the choices (or default if empty/non-interactive)."""
    sys.stderr.write(prompt + "\n")
    for i, c in enumerate(choices, 1):
        mark = "*" if c == default else " "
        sys.stderr.write(f"  [{mark}] {i}. {c}\n")
    sys.stderr.write("> ")
    sys.stderr.flush()
    answer = sys.stdin.readline()
    if not answer:
        answer = ""
    answer = answer.strip()
    if not answer:
        return default
    # Accept either the number or the text.
    if answer.isdigit():
        idx = int(answer) - 1
        if 0 <= idx < len(choices):
            return choices[idx]
    lower = answer.lower()
    for c in choices:
        if c.lower() == lower:
            return c
    return default


def validate_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise ValueError("Name cannot be empty.")
    # Reject path-like or clearly bogus values.
    if re.search(r"[\\/<>|:&;]", name):
        raise ValueError("Name contains invalid characters.")
    if len(name) > 100:
        raise ValueError("Name is too long (max 100 characters).")
    return name


def load_user() -> dict:
    if USER_JSON.exists():
        try:
            data = json.loads(USER_JSON.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    return {}


def atomic_save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def save_user(data: dict) -> None:
    atomic_save(USER_JSON, data)


def load_config() -> dict:
    if not CONFIG_JSON.exists():
        return {}
    try:
        value = json.loads(CONFIG_JSON.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(
            f"Invalid existing {CONFIG_JSON}: {exc}. Fix or move it; COOP will not overwrite it."
        ) from exc
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValueError(
            f"Unsupported existing {CONFIG_JSON} schema; expected schema_version 1. COOP will not overwrite it."
        )
    return value


def save_config(data: dict) -> None:
    atomic_save(CONFIG_JSON, data)


def read_confirm(prompt: str, default: bool) -> bool:
    answer = read_input(
        f"{prompt} [{'Y/n' if default else 'y/N'}]: ", "y" if default else "n"
    )
    return answer.lower() in ("y", "yes", "true", "1")


def choose_tenant(
    tenants: list[dict[str, str]], *, login_result: bool = False
) -> dict[str, str]:
    """Choose one tenant, avoiding another confirmation when login found one."""
    if not tenants:
        return {}
    if len(tenants) == 1:
        tenant = tenants[0]
        if login_result:
            sys.stderr.write(
                f"✓ Signed in. Detected client tenant {tenant_label(tenant)}.\n"
            )
            return tenant
        if read_confirm(
            f"Detected Azure tenant {tenant_label(tenant)}.\n"
            "Use this as the client resource tenant for Fabric and Power BI?",
            True,
        ):
            return tenant
        return {}

    labels = [tenant_label(tenant) for tenant in tenants]
    sys.stderr.write(
        "✓ Azure sign-in succeeded.\n"
        if login_result
        else "Multiple signed-in Azure tenants detected.\n"
    )
    selected = read_choice(
        "Which tenant owns the client's Fabric and Power BI environment?",
        labels,
        default=labels[0],
    )
    return tenants[labels.index(selected)]


def sign_in_and_detect_tenant() -> dict[str, str]:
    """Complete browser sign-in, with a visible device-code recovery path."""
    sys.stderr.write("Opening Azure sign-in. Coop will wait here until it finishes…\n")
    ok, tenants = login_azure()
    if ok and tenants:
        return choose_tenant(tenants, login_result=True)

    if ok:
        sys.stderr.write(
            "Azure accepted the sign-in, but did not expose a tenant. This can happen with older Azure CLI versions.\n"
        )
    else:
        sys.stderr.write("Azure sign-in did not complete.\n")
    if read_confirm("Try again with a device code?", True):
        sys.stderr.write(
            "Starting device-code sign-in. Follow the Azure instructions below…\n"
        )
        ok, tenants = login_azure(use_device_code=True)
        if ok and tenants:
            return choose_tenant(tenants, login_result=True)
    sys.stderr.write(
        "Azure is not connected. You can enter the client tenant manually now or run `coop onboard --config-only` later.\n"
    )
    return {}


def validate_ado_organization(value: str) -> str | None:
    """Return an error message, or None when the value is acceptable.

    Accepts a short organization name (e.g. 'contoso') or a full Azure DevOps
    URL (https://dev.azure.com/<org> or https://<org>.visualstudio.com).
    """
    v = value.strip()
    if not v:
        return "Azure DevOps organization cannot be empty."
    if re.match(
        r"^https://(?:dev\.azure\.com/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.visualstudio\.com)/?$",
        v,
        re.IGNORECASE,
    ):
        return None
    if v.lower().startswith(("http://", "https://")) or re.search(r"\s", v):
        return "Enter a short organization name (e.g. 'contoso') or a https://dev.azure.com/<org> URL."
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", v):
        return "Organization names use letters, digits, '.', '_' or '-' (or paste the full https://dev.azure.com/<org> URL)."
    return None


def run_config_questions(
    existing: dict | None = None, *, quick_start: bool = False
) -> dict:
    existing = existing or load_config()
    old_azure = (
        existing.get("azure", {}) if isinstance(existing.get("azure", {}), dict) else {}
    )
    old_i = (
        existing.get("integrations", {})
        if isinstance(existing.get("integrations", {}), dict)
        else {}
    )
    discovered = discover_azure_tenants()
    tenant = str(old_azure.get("tenant_id", ""))
    tenant_name = str(old_azure.get("tenant_name", ""))

    # Asked once: an install-time answer (coop install --platform) is kept on the
    # quick-start path; editing the config re-asks with the saved value as default.
    platform = ask_platform(
        config_platform(existing), skip_saved=quick_start
    )
    services = (
        "Azure SQL" if platform == "azure_sql" else "Microsoft Fabric and Power BI"
    )

    # This identity domain is exclusively for client resources. Shared Knowledge
    # will use a separate `knowledge` config, authentication flow, and token cache;
    # it must never reuse or replace the client's Azure CLI session.
    sys.stderr.write(
        "\nClient Microsoft environment\n"
        f"This is the tenant whose {services} resources Coop should access.\n"
        "Do not enter the Cooptimize tenant here unless this is internal Cooptimize work.\n"
        "Cooptimize Shared Knowledge always uses a separate sign-in and identity.\n"
    )

    configure_cloud = True
    if quick_start and not tenant:
        configure_cloud = read_confirm(
            f"Connect Coop to client {services} now?", True
        )

    selected: dict[str, str] = {}
    if configure_cloud and discovered:
        selected = choose_tenant(discovered)
    elif configure_cloud and not tenant and azure_cli_available():
        sys.stderr.write("Azure CLI is ready, but it is not signed in.\n")
        if read_confirm(
            "Sign in now so Coop can detect the client tenant automatically?", True
        ):
            selected = sign_in_and_detect_tenant()

    if selected:
        tenant = selected["tenant_id"]
        tenant_name = selected.get("domain") or selected.get("name", "")
    elif configure_cloud and tenant and not quick_start:
        # Keep configuration editing explicit and preserve the established prompt
        # cadence for users who only want to review other integration choices.
        if read_confirm("Change the saved client Azure tenant ID?", False):
            sys.stderr.write(
                "Find it in Azure Portal > Microsoft Entra ID > Overview > Tenant ID.\n"
            )
            tenant = read_input("Azure tenant ID (GUID): ", tenant)
            tenant_name = ""
    elif (
        configure_cloud
        and not tenant
        and read_confirm(
            f"Configure the Azure tenant whose {services} resources Coop should access now?",
            False if quick_start else bool(tenant),
        )
    ):
        sys.stderr.write(
            "Find it in Azure Portal > Microsoft Entra ID > Overview > Tenant ID.\n"
            "You can also sign in later with `coop onboard --config-only`.\n"
        )
        tenant = read_input("Azure tenant ID (GUID): ", tenant)
        tenant_name = ""  # only Azure CLI can resolve display names

    integrations = {}
    omitted = {}  # key -> reason shown in the summary

    old_ado = (
        existing.get("azure_devops", {})
        if isinstance(existing.get("azure_devops", {}), dict)
        else {}
    )
    organization = str(old_ado.get("organization", ""))

    if quick_start:
        integrations.update(
            {
                "fabric": bool(tenant) and fabric_platform(platform),
                "fabric_sql_endpoint": bool(tenant) and fabric_platform(platform),
                "power_bi_modeling": True,
                "azure_devops": False,
                "microsoft_learn": True,
            }
        )
        if not fabric_platform(platform):
            omitted["fabric"] = "Azure SQL client"
            omitted["fabric_sql_endpoint"] = "Azure SQL client"
        elif not tenant:
            omitted["fabric"] = "connect Azure later"
            omitted["fabric_sql_endpoint"] = "connect Azure later"
        omitted["azure_devops"] = "set up later if needed"
        sys.stderr.write(
            "Using the recommended integrations. Customize them anytime with `coop onboard --config-only`.\n"
        )
    else:
        # Fabric MCP follows the active Azure CLI login; it works without an
        # explicitly stored tenant (the login itself carries the tenant).
        # An Azure SQL-only client defaults the Fabric servers off; the
        # question is still asked so a mixed machine can turn them on.
        integrations["fabric"] = read_confirm(
            "Enable Microsoft Fabric MCP? (follows your active Azure CLI login)",
            bool(old_i.get("fabric", fabric_platform(platform))),
        )
        integrations["fabric_sql_endpoint"] = read_confirm(
            "Enable Fabric Warehouse SQL endpoint MCP? (approval-gated SQL)",
            bool(
                old_i.get(
                    "fabric_sql_endpoint",
                    old_i.get("fabric", fabric_platform(platform)),
                )
            ),
        )

        # No "Power BI MCP" toggle: powerbi-mcp-server is retired (#93) and never
        # generated, and we never offer a toggle we cannot honor.
        integrations["power_bi_modeling"] = read_confirm(
            "Enable Power BI Modeling MCP?", bool(old_i.get("power_bi_modeling", True))
        )
        integrations["azure_devops"] = read_confirm(
            "Enable Azure DevOps MCP?", bool(old_i.get("azure_devops", True))
        )

    if integrations["azure_devops"]:
        while True:
            organization, eof = read_line_bounded(
                "Azure DevOps organization (short name or full URL): ", organization
            )
            err = validate_ado_organization(organization)
            if err is None:
                break
            sys.stderr.write(f"  {err}\n")
            if eof:
                # Nobody left to answer — never save the integration half-configured,
                # and never spin on a closed pipe.
                integrations["azure_devops"] = False
                organization = ""
                omitted["azure_devops"] = "no organization provided"
                sys.stderr.write("Input ended; Azure DevOps MCP saved disabled.\n")
                break
            if not read_confirm(
                "Try another organization? (answering 'n' disables Azure DevOps MCP)",
                True,
            ):
                integrations["azure_devops"] = False
                omitted["azure_devops"] = "no valid organization"
                break
    elif "azure_devops" not in omitted:
        omitted["azure_devops"] = "not enabled"

    if not quick_start:
        integrations["microsoft_learn"] = read_confirm(
            "Enable Microsoft Learn MCP?", bool(old_i.get("microsoft_learn", True))
        )

    # Cooptimize Shared Knowledge (teamai-cli-style team knowledge repos, first:
    # github.com/cooptimize/incremental-bi). Optional; declining/absent/disabled is
    # a clean no-op everywhere. repos is a LIST from day one (multi-KB future), and
    # an existing list is preserved verbatim across re-runs — onboarding never edits it.
    old_k = (
        existing.get("knowledge", {})
        if isinstance(existing.get("knowledge", {}), dict)
        else {}
    )
    knowledge_enabled = read_confirm(
        "Enable Cooptimize Shared Knowledge sync? (clones team knowledge repos; `coop sync` keeps them fresh)",
        bool(old_k.get("enabled", False)),
    )
    old_repos = old_k.get("repos") if isinstance(old_k.get("repos"), list) else []
    if knowledge_enabled:
        knowledge = {
            "enabled": True,
            "repos": old_repos
            or [
                {
                    "url": "https://github.com/cooptimize/incremental-bi.git",
                    "local_path": "~/.coop/knowledge/incremental-bi",
                }
            ],
        }
    else:
        knowledge = {"enabled": False, "repos": old_repos}

    # TeamAI shared knowledge trial (master plan K1): an isolated copy of the
    # pinned teamai-cli under <profile dir>/teamai, explicit `coop teamai` commands
    # only, off by default. Quick start never asks; an existing block is kept.
    old_t = old_k.get("teamai") if isinstance(old_k.get("teamai"), dict) else {}
    teamai = {
        "enabled": bool(old_t.get("enabled", False)),
        "team_repo": str(old_t.get("team_repo", "") or ""),
        "provider": str(old_t.get("provider", "") or "git"),
        "role": str(old_t.get("role", "") or ""),
        "skills": bool(old_t.get("skills", False)),
    }
    if not quick_start:
        teamai["enabled"] = read_confirm(
            "Enable the TeamAI shared knowledge trial? (isolated teamai-cli copy; recall only via `coop teamai`)",
            teamai["enabled"],
        )
        if teamai["enabled"]:
            teamai["team_repo"] = read_input(
                f"TeamAI sandbox team repository (https or ssh URL) [{teamai['team_repo'] or 'none'}]: ",
                teamai["team_repo"],
            ).strip()
            teamai["role"] = read_input(
                f"TeamAI role filter (optional) [{teamai['role'] or 'none'}]: ",
                teamai["role"],
            ).strip()
            teamai["skills"] = read_confirm(
                "Load the team repository's skills into coop at launch? (subordinate: Cooptimize skills win)",
                teamai["skills"],
            )
    knowledge["teamai"] = teamai

    # Honest summary BEFORE anything is saved.
    labels = {
        "fabric": "Microsoft Fabric MCP",
        "fabric_sql_endpoint": "Fabric Warehouse SQL endpoint MCP",
        "power_bi_modeling": "Power BI Modeling MCP",
        "azure_devops": "Azure DevOps MCP",
        "microsoft_learn": "Microsoft Learn MCP",
    }
    enabled_labels = [labels[k] for k in labels if integrations.get(k)]
    omitted_lines = [
        f"{labels[k]} ({reason})"
        for k, reason in omitted.items()
        if not integrations.get(k)
    ]
    sys.stderr.write("\nReview:\n")
    sys.stderr.write(f"- Client platform: {PLATFORM_LABELS[platform]}\n")
    if tenant:
        sys.stderr.write(
            f"- Client Azure tenant: {tenant_name or '(display name unknown)'} ({tenant})\n"
        )
    else:
        sys.stderr.write("- Client Azure tenant: not configured\n")
    if knowledge["enabled"]:
        sys.stderr.write(
            f"- Cooptimize Shared Knowledge: enabled ({len(knowledge['repos'])} repo(s))\n"
        )
    else:
        sys.stderr.write("- Cooptimize Shared Knowledge: disabled\n")
    if teamai["enabled"]:
        sys.stderr.write(
            f"- TeamAI trial: enabled ({re.sub(r'://[^@/]+@', '://', teamai['team_repo']) or 'team repo not set yet'}; isolated, explicit `coop teamai` only)\n"
        )
    else:
        sys.stderr.write("- TeamAI trial: disabled\n")
    sys.stderr.write(
        f"- Enabled: {', '.join(enabled_labels) if enabled_labels else 'none'}\n"
    )
    for line in omitted_lines:
        sys.stderr.write(f"- Omitted: {line}\n")
    sys.stderr.write(f"- Destination: {CONFIG_JSON}\n")

    return {
        "schema_version": 1,
        "client": {"platform": platform},
        "azure": {
            "enabled": bool(tenant),
            "purpose": "client_resources",
            "tenant_id": tenant,
            "tenant_name": tenant_name,
        },
        "integrations": integrations,
        "azure_devops": {"organization": organization},
        "mcp": {"safe_mode": "read_only_first"},
        "knowledge": knowledge,
        "fleet": {
            "publish_dir": str(existing.get("fleet", {}).get("publish_dir", ""))
            if isinstance(existing.get("fleet", {}), dict)
            else ""
        },
    }


def ask_platform(current: str, *, forced: str = "", skip_saved: bool = False) -> str:
    """Resolve the client platform: a forced value, the environment, else a prompt.

    A saved value is the prompt's default (or the answer itself with skip_saved);
    an unknown forced or environment spelling is reported and the prompt runs.
    """
    if skip_saved and current in PLATFORMS:
        return current
    for candidate, origin in ((forced, "--platform"), (os.environ.get(PLATFORM_ENV, ""), PLATFORM_ENV)):
        if not candidate:
            continue
        value = normalize_platform(candidate)
        if value:
            return value
        sys.stderr.write(
            f"Ignoring {origin}={candidate!r}: expected one of {', '.join(PLATFORMS)}.\n"
        )
    sys.stderr.write(
        "\nClient SQL platform\n"
        "Coop tailors doctor, the default MCP servers and the Fabric skills to it.\n"
        "A project contract (.coop/project.yml) can still override it per repository.\n"
    )
    labels = [PLATFORM_LABELS[p] for p in PLATFORMS]
    default = current if current in PLATFORMS else "fabric"
    chosen = read_choice(
        "Does this client run on Fabric, Azure SQL, or both?",
        labels,
        default=PLATFORM_LABELS[default],
    )
    for key, label in PLATFORM_LABELS.items():
        if label == chosen:
            return key
    return default


def cmd_platform(args: argparse.Namespace) -> int:
    """Show or set the machine's client platform without re-running onboarding.

    Used by `coop install --platform` and `coop doctor --fix` (which asks once on
    a machine that predates the setting). Only client.platform is written; every
    other key of ~/.coop/config is preserved.
    """
    try:
        config = load_config()
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    current = config_platform(config)
    if args.show:
        print(current)
        return 0 if current else 1
    if args.set:
        value = normalize_platform(args.set)
        if not value:
            sys.stderr.write(
                f"Unknown platform {args.set!r}: expected one of {', '.join(PLATFORMS)}.\n"
            )
            return 2
    else:
        value = ask_platform(current)
    config = dict(config)
    config.setdefault("schema_version", 1)
    client = dict(config.get("client")) if isinstance(config.get("client"), dict) else {}
    client["platform"] = value
    config["client"] = client
    save_config(config)
    sys.stderr.write(f"Client platform: {PLATFORM_LABELS[value]} (saved to {CONFIG_JSON}).\n")
    print(value)
    return 0


def refresh_mcp() -> None:
    helper = Path(__file__).resolve().parent.parent / "lib" / "mcp_config.py"
    result = subprocess.run(
        [
            sys.executable,
            str(helper),
            "--config",
            str(CONFIG_JSON),
            "--output",
            str(MCP_OUTPUT),
        ]
    )
    if result.returncode != 0:
        raise RuntimeError("MCP config generation failed")


def run_profile_questions(
    existing: dict | None = None, migration_name: str = ""
) -> dict:
    """Ask only the user-profile questions."""
    existing = existing or load_user()
    schema_version = existing.get("schema_version", 1)
    old_name = existing.get("name", "")
    old_preset = existing.get("communication", {}).get("preset", "balanced")
    old_custom = existing.get("communication", {}).get("custom_instructions", "")

    name_default = old_name or migration_name
    # A persisted default that fails validation must never reach the retry
    # loop: at EOF the loop would otherwise feed it back forever.
    if name_default:
        try:
            validate_name(name_default)
        except ValueError as e:
            sys.stderr.write(
                f"  Saved profile name is invalid ({e}); entering a new one.\n"
            )
            name_default = ""
    name = ""
    while True:
        try:
            prompt = "What should COOP call you?"
            if name_default:
                prompt += f" [{name_default}]"
            prompt += ": "
            value, eof = read_line_bounded(prompt, name_default)
            if eof and not value:
                sys.stderr.write(
                    "\nNo name entered; aborting onboarding. Run `coop onboard` to try again.\n"
                )
                raise SystemExit(1)

            # Assign only AFTER validation: storing the raw value first would let
            # a rejected answer satisfy the retry loop.
            name = validate_name(value)
            break
        except ValueError as e:
            sys.stderr.write(f"  {e}\n")
            if eof:
                # The saved default was invalid AND input has ended: re-prompting
                # can never succeed, so stop instead of spinning forever.
                sys.stderr.write(
                    "Input ended with an invalid saved name; aborting onboarding. Run `coop onboard`.\n"
                )
                raise SystemExit(1)

    preset = read_choice(
        "How do you prefer agents to communicate?",
        PRESET_KEYS,
        default=old_preset if old_preset in PRESET_KEYS else "balanced",
    )

    custom = ""
    if preset == "custom":
        custom = read_input(
            f"Brief custom instruction{' [' + old_custom + ']' if old_custom else ''}: ",
            default=old_custom,
        )
        if len(custom) > 1000:
            sys.stderr.write("  Trimming custom instruction to 1000 characters.\n")
            custom = custom[:1000]

    return {
        "schema_version": schema_version,
        "name": name,
        "communication": {
            "preset": preset,
            "custom_instructions": custom,
        },
    }


def maybe_migrate_consultant_name() -> str:
    """If a project.yml has a legacy consultant_name and no local profile exists, ask the
    user whether to seed the local profile from it. Returns the name if accepted, else ''."""
    if not coop_user_profile_missing():
        return ""
    project_yml = find_project_yml()
    if not project_yml:
        return ""
    old_name = parse_consultant_name(project_yml)
    if not old_name:
        return ""
    sys.stderr.write(
        f'\nFound consultant_name "{old_name}" in this project\'s old config.\n'
    )
    try:
        ans = read_input(
            "Use that as your local COOP profile name? [Y/n]: ", default="Y"
        )
    except (EOFError, KeyboardInterrupt):
        return ""
    if ans.lower() in ("y", "yes", ""):
        return old_name
    return ""


def run_full_onboarding() -> dict:
    """Full first-run onboarding."""
    sys.stderr.write("Welcome to COOP. Let's set up your local profile.\n\n")
    migration = maybe_migrate_consultant_name()
    profile = run_profile_questions(migration_name=migration)
    save_user(profile)
    sys.stderr.write(f"\nSaved profile for {profile['name']}.\n")
    return profile


def cmd_onboard(args: argparse.Namespace) -> int:
    if args.reset:
        if USER_JSON.exists():
            USER_JSON.unlink()
        sys.stderr.write("Profile reset.\n")
        return 0

    try:
        existing_config = load_config()
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    if args.platform:
        if not normalize_platform(args.platform):
            sys.stderr.write(
                f"Unknown platform {args.platform!r}: expected one of {', '.join(PLATFORMS)}.\n"
            )
            return 2
        os.environ[PLATFORM_ENV] = args.platform

    if args.config_only:
        profile = load_user()
    elif args.edit:
        profile = run_profile_questions()
        save_user(profile)
        sys.stderr.write(f"Updated profile for {profile['name']}.\n")
    elif USER_JSON.exists():
        profile = load_user()
        try:
            validate_name(str(profile.get("name", "")))
        except ValueError:
            # A corrupt/incomplete profile still needs the guarded repair flow;
            # a healthy existing profile should not be re-asked during install.
            profile = run_profile_questions(profile)
            save_user(profile)
            sys.stderr.write(f"Repaired profile for {profile['name']}.\n")
    else:
        profile = run_full_onboarding()

    # Quick start is for a machine with no integration answers yet; a config that
    # only carries the install-time platform choice still qualifies.
    config = run_config_questions(
        existing_config,
        quick_start="integrations" not in existing_config and not args.config_only,
    )
    save_config(config)
    try:
        refresh_mcp()
    except Exception as exc:
        # The profile and integration config are already saved — an MCP-generation
        # failure must not surface as a traceback or look like onboarding broke.
        sys.stderr.write(
            f"\nMCP config generation failed ({exc}). Your profile and integration config were saved.\n"
            "Fix the cause (usually a missing manifest or python), then run `coop sync` to write the MCP config.\n"
        )
        return 1
    sys.stderr.write(f"Saved integration config to {CONFIG_JSON}.\n")
    sys.stderr.write("Setup complete. Run 'coop' to start.\n")
    if args.json:
        print(json.dumps(profile, indent=2, ensure_ascii=False))
    return 0


def cmd_profile(args: argparse.Namespace) -> int:
    profile = load_user()
    if args.reset:
        if USER_JSON.exists():
            USER_JSON.unlink()
        sys.stderr.write("Profile reset.\n")
        return 0
    if args.edit:
        updated = run_profile_questions(profile)
        save_user(updated)
        profile = updated
        sys.stderr.write(f"Updated profile for {profile['name']}.\n")

    if not profile:
        sys.stderr.write("No COOP profile yet. Run: coop onboard\n")
        return 1

    if args.json:
        print(json.dumps(profile, indent=2, ensure_ascii=False))
    else:
        comm = profile.get("communication", {})
        preset = comm.get("preset", "balanced")
        print(f"Name: {profile.get('name', '')}")
        print(f"Communication: {preset}")
        custom = comm.get("custom_instructions", "")
        if custom:
            print(f"Custom instruction: {custom}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="coop-onboard", description="COOP onboarding and profile management."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    onboard = sub.add_parser("onboard", help="Run first-run onboarding.")
    onboard.add_argument(
        "--edit", action="store_true", help="Re-run only profile questions."
    )
    onboard.add_argument("--reset", action="store_true", help="Remove local profile.")
    onboard.add_argument("--json", action="store_true", help="Emit profile as JSON.")
    onboard.add_argument(
        "--config-only",
        action="store_true",
        help="Edit integrations without changing the user profile.",
    )
    onboard.add_argument(
        "--platform",
        choices=PLATFORMS,
        help="Answer the client platform question (fabric, azure_sql, both) without a prompt.",
    )

    platform = sub.add_parser(
        "platform", help="Show or set the machine's client platform (fabric, azure_sql, both)."
    )
    platform.add_argument("--show", action="store_true", help="Print the saved value (exit 1 when unset).")
    platform.add_argument("--set", metavar="PLATFORM", help="Save this value without a prompt.")

    profile = sub.add_parser("profile", help="Show or edit COOP profile.")
    profile.add_argument("--edit", action="store_true", help="Edit profile.")
    profile.add_argument("--reset", action="store_true", help="Remove local profile.")
    profile.add_argument("--json", action="store_true", help="Emit profile as JSON.")

    args = parser.parse_args(argv)
    if args.command == "onboard":
        return cmd_onboard(args)
    if args.command == "profile":
        return cmd_profile(args)
    if args.command == "platform":
        return cmd_platform(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
