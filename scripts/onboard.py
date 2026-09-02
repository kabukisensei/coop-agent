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

from azure_auth import azure_cli_available, discover_azure_tenants, login_azure, tenant_label

COOP_DIR = Path(os.environ.get("COOP_DIR", Path.home())) / ".coop"
USER_JSON = COOP_DIR / "user.json"
CONFIG_JSON = COOP_DIR / "config"
MCP_OUTPUT = COOP_DIR / "agent" / "mcp.json"

PRESETS = {
    "concise": "Answer first. Keep explanations short. Use bullets where useful. Explain tradeoffs only when material.",
    "balanced": "Answer first. Give a brief why. Then structured detail.",
    "teaching": "Answer first. Explain reasoning, alternatives, and tradeoffs in more depth.",
}
PRESET_KEYS = list(PRESETS.keys()) + ["custom"]


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
    m = re.search(r"^\s*consultant_name\s*:\s*['\"]?(.*?)(?:['\"]?\s*$)", text, re.MULTILINE | re.IGNORECASE)
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
        raise ValueError(f"Invalid existing {CONFIG_JSON}: {exc}. Fix or move it; COOP will not overwrite it.") from exc
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValueError(f"Unsupported existing {CONFIG_JSON} schema; expected schema_version 1. COOP will not overwrite it.")
    return value


def save_config(data: dict) -> None:
    atomic_save(CONFIG_JSON, data)


def read_confirm(prompt: str, default: bool) -> bool:
    answer = read_input(f"{prompt} [{'Y/n' if default else 'y/N'}]: ", "y" if default else "n")
    return answer.lower() in ("y", "yes", "true", "1")


def choose_tenant(tenants: list[dict[str, str]], *, login_result: bool = False) -> dict[str, str]:
    """Choose one tenant, avoiding another confirmation when login found one."""
    if not tenants:
        return {}
    if len(tenants) == 1:
        tenant = tenants[0]
        if login_result:
            sys.stderr.write(f"✓ Signed in. Detected client tenant {tenant_label(tenant)}.\n")
            return tenant
        if read_confirm(
            f"Detected Azure tenant {tenant_label(tenant)}.\n"
            "Use this as the client resource tenant for Fabric and Power BI?",
            True,
        ):
            return tenant
        return {}

    labels = [tenant_label(tenant) for tenant in tenants]
    sys.stderr.write("✓ Azure sign-in succeeded.\n" if login_result else "Multiple signed-in Azure tenants detected.\n")
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
        sys.stderr.write("Starting device-code sign-in. Follow the Azure instructions below…\n")
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
    if re.match(r"^https://(?:dev\.azure\.com/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.visualstudio\.com)/?$", v, re.IGNORECASE):
        return None
    if v.lower().startswith(("http://", "https://")) or re.search(r"\s", v):
        return "Enter a short organization name (e.g. 'contoso') or a https://dev.azure.com/<org> URL."
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", v):
        return "Organization names use letters, digits, '.', '_' or '-' (or paste the full https://dev.azure.com/<org> URL)."
    return None


def run_config_questions(existing: dict | None = None, *, quick_start: bool = False) -> dict:
    existing = existing or load_config()
    old_azure = existing.get("azure", {}) if isinstance(existing.get("azure", {}), dict) else {}
    old_i = existing.get("integrations", {}) if isinstance(existing.get("integrations", {}), dict) else {}
    discovered = discover_azure_tenants()
    tenant = str(old_azure.get("tenant_id", ""))
    tenant_name = str(old_azure.get("tenant_name", ""))

    # This identity domain is exclusively for client resources. Shared Knowledge
    # will use a separate `knowledge` config, authentication flow, and token cache;
    # it must never reuse or replace the client's Azure CLI session.
    sys.stderr.write(
        "\nClient Microsoft environment\n"
        "This is the tenant whose Fabric and Power BI resources Coop should access.\n"
        "Do not enter the Cooptimize tenant here unless this is internal Cooptimize work.\n"
        "Cooptimize Shared Knowledge always uses a separate sign-in and identity.\n"
    )

    configure_cloud = True
    if quick_start and not tenant:
        configure_cloud = read_confirm("Connect Coop to client Microsoft Fabric and Power BI now?", True)

    selected: dict[str, str] = {}
    if configure_cloud and discovered:
        selected = choose_tenant(discovered)
    elif configure_cloud and not tenant and azure_cli_available():
        sys.stderr.write("Azure CLI is ready, but it is not signed in.\n")
        if read_confirm("Sign in now so Coop can detect the client tenant automatically?", True):
            selected = sign_in_and_detect_tenant()

    if selected:
        tenant = selected["tenant_id"]
        tenant_name = selected.get("domain") or selected.get("name", "")
    elif configure_cloud and tenant and not quick_start:
        # Keep configuration editing explicit and preserve the established prompt
        # cadence for users who only want to review other integration choices.
        if read_confirm("Change the saved client Azure tenant ID?", False):
            sys.stderr.write("Find it in Azure Portal > Microsoft Entra ID > Overview > Tenant ID.\n")
            tenant = read_input("Azure tenant ID (GUID): ", tenant)
            tenant_name = ""
    elif configure_cloud and not tenant and read_confirm(
        "Configure the Azure tenant whose Fabric and Power BI resources Coop should access now?",
        False if quick_start else bool(tenant),
    ):
        sys.stderr.write(
            "Find it in Azure Portal > Microsoft Entra ID > Overview > Tenant ID.\n"
            "You can also sign in later with `coop onboard --config-only`.\n"
        )
        tenant = read_input("Azure tenant ID (GUID): ", tenant)
        tenant_name = ""  # only Azure CLI can resolve display names

    integrations = {}
    omitted = {}  # key -> reason shown in the summary

    old_ado = existing.get("azure_devops", {}) if isinstance(existing.get("azure_devops", {}), dict) else {}
    organization = str(old_ado.get("organization", ""))

    if quick_start:
        integrations.update({
            "fabric": bool(tenant),
            "power_bi": bool(tenant),
            "power_bi_modeling": True,
            "azure_devops": False,
            "microsoft_learn": True,
        })
        if not tenant:
            omitted["fabric"] = "connect Azure later"
            omitted["power_bi"] = "requires an Azure tenant"
        omitted["azure_devops"] = "set up later if needed"
        sys.stderr.write(
            "Using the recommended integrations. Customize them anytime with `coop onboard --config-only`.\n"
        )
    else:
        # Fabric MCP follows the active Azure CLI login; it works without an
        # explicitly stored tenant (the login itself carries the tenant).
        integrations["fabric"] = read_confirm("Enable Microsoft Fabric MCP? (follows your active Azure CLI login)", bool(old_i.get("fabric", True)))

        # Power BI MCP needs an explicit tenant ID. Never offer an enable toggle we
        # cannot honor: without a tenant it stays disabled, visibly.
        if tenant:
            integrations["power_bi"] = read_confirm("Enable Power BI MCP?", bool(old_i.get("power_bi", True)))
        else:
            integrations["power_bi"] = False
            omitted["power_bi"] = "requires an Azure tenant"
            sys.stderr.write("Power BI MCP requires an Azure tenant and will remain disabled.\n")

        integrations["power_bi_modeling"] = read_confirm("Enable Power BI Modeling MCP?", bool(old_i.get("power_bi_modeling", True)))
        integrations["azure_devops"] = read_confirm("Enable Azure DevOps MCP?", bool(old_i.get("azure_devops", True)))

    if integrations["azure_devops"]:
        while True:
            organization, eof = read_line_bounded("Azure DevOps organization (short name or full URL): ", organization)
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
            if not read_confirm("Try another organization? (answering 'n' disables Azure DevOps MCP)", True):
                integrations["azure_devops"] = False
                omitted["azure_devops"] = "no valid organization"
                break
    elif "azure_devops" not in omitted:
        omitted["azure_devops"] = "not enabled"

    if not quick_start:
        integrations["microsoft_learn"] = read_confirm("Enable Microsoft Learn MCP?", bool(old_i.get("microsoft_learn", True)))

    # Honest summary BEFORE anything is saved.
    labels = {
        "fabric": "Microsoft Fabric MCP", "power_bi": "Power BI MCP",
        "power_bi_modeling": "Power BI Modeling MCP", "azure_devops": "Azure DevOps MCP",
        "microsoft_learn": "Microsoft Learn MCP",
    }
    enabled_labels = [labels[k] for k in labels if integrations.get(k)]
    omitted_lines = [f"{labels[k]} ({reason})" for k, reason in omitted.items() if not integrations.get(k)]
    sys.stderr.write("\nReview:\n")
    if tenant:
        sys.stderr.write(f"- Client Azure tenant: {tenant_name or '(display name unknown)'} ({tenant})\n")
    else:
        sys.stderr.write("- Client Azure tenant: not configured\n")
    sys.stderr.write("- Cooptimize Shared Knowledge identity: separate; not configured by this release\n")
    sys.stderr.write(f"- Enabled: {', '.join(enabled_labels) if enabled_labels else 'none'}\n")
    for line in omitted_lines:
        sys.stderr.write(f"- Omitted: {line}\n")
    sys.stderr.write(f"- Destination: {CONFIG_JSON}\n")

    return {
        "schema_version": 1,
        "azure": {
            "enabled": bool(tenant),
            "purpose": "client_resources",
            "tenant_id": tenant,
            "tenant_name": tenant_name,
        },
        "integrations": integrations,
        "azure_devops": {"organization": organization},
        "mcp": {"safe_mode": "read_only_first"},
        "fleet": {"publish_dir": str(existing.get("fleet", {}).get("publish_dir", "")) if isinstance(existing.get("fleet", {}), dict) else ""},
    }


def refresh_mcp() -> None:
    helper = Path(__file__).resolve().parent.parent / "lib" / "mcp_config.py"
    result = subprocess.run([sys.executable, str(helper), "--config", str(CONFIG_JSON), "--output", str(MCP_OUTPUT)])
    if result.returncode != 0:
        raise RuntimeError("MCP config generation failed")


def run_profile_questions(existing: dict | None = None, migration_name: str = "") -> dict:
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
            sys.stderr.write(f"  Saved profile name is invalid ({e}); entering a new one.\n")
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
                sys.stderr.write("\nNo name entered; aborting onboarding. Run `coop onboard` to try again.\n")
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
                sys.stderr.write("Input ended with an invalid saved name; aborting onboarding. Run `coop onboard`.\n")
                raise SystemExit(1)

    preset = read_choice(
        "How do you prefer agents to communicate?",
        PRESET_KEYS,
        default=old_preset if old_preset in PRESET_KEYS else "balanced",
    )

    custom = ""
    if preset == "custom":
        custom = read_input(f"Brief custom instruction{' [' + old_custom + ']' if old_custom else ''}: ", default=old_custom)
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
    sys.stderr.write(f'\nFound consultant_name "{old_name}" in this project\'s old config.\n')
    try:
        ans = read_input("Use that as your local COOP profile name? [Y/n]: ", default="Y")
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

    config = run_config_questions(existing_config, quick_start=not existing_config and not args.config_only)
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
    if not config["azure"].get("tenant_id") and (config["integrations"]["power_bi"]):
        # Only reachable via hand-edited legacy configs; the wizard itself can no
        # longer save Power BI as enabled without a tenant.
        sys.stderr.write("Power BI MCP is omitted until an Azure tenant is configured; run `coop onboard --edit`.\n")
    if os.environ.get("COOP_ONBOARD_FROM_LAUNCH") == "1":
        sys.stderr.write("Setup complete. Starting Coop…\n")
    else:
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
    parser = argparse.ArgumentParser(prog="coop-onboard", description="COOP onboarding and profile management.")
    sub = parser.add_subparsers(dest="command", required=True)

    onboard = sub.add_parser("onboard", help="Run first-run onboarding.")
    onboard.add_argument("--edit", action="store_true", help="Re-run only profile questions.")
    onboard.add_argument("--reset", action="store_true", help="Remove local profile.")
    onboard.add_argument("--json", action="store_true", help="Emit profile as JSON.")
    onboard.add_argument("--config-only", action="store_true", help="Edit integrations without changing the user profile.")

    profile = sub.add_parser("profile", help="Show or edit COOP profile.")
    profile.add_argument("--edit", action="store_true", help="Edit profile.")
    profile.add_argument("--reset", action="store_true", help="Remove local profile.")
    profile.add_argument("--json", action="store_true", help="Emit profile as JSON.")

    args = parser.parse_args(argv)
    if args.command == "onboard":
        return cmd_onboard(args)
    if args.command == "profile":
        return cmd_profile(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
