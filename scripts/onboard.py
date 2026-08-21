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
import sys
from pathlib import Path

COOP_DIR = Path.home() / ".coop"
USER_JSON = COOP_DIR / "user.json"
CONFIG_YML = COOP_DIR / "config"

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


def save_user(data: dict) -> None:
    COOP_DIR.mkdir(parents=True, exist_ok=True)
    USER_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run_profile_questions(existing: dict | None = None, migration_name: str = "") -> dict:
    """Ask only the user-profile questions."""
    existing = existing or load_user()
    schema_version = existing.get("schema_version", 1)
    old_name = existing.get("name", "")
    old_preset = existing.get("communication", {}).get("preset", "balanced")
    old_custom = existing.get("communication", {}).get("custom_instructions", "")

    name_default = old_name or migration_name
    name = ""
    while not name:
        try:
            prompt = "What should COOP call you?"
            if name_default:
                prompt += f" [{name_default}]"
            prompt += ": "
            name = validate_name(read_input(prompt, default=name_default))
        except ValueError as e:
            sys.stderr.write(f"  {e}\n")

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

    if args.edit or USER_JSON.exists():
        # edit mode or file exists: ask questions and overwrite.
        profile = run_profile_questions()
        save_user(profile)
        sys.stderr.write(f"Updated profile for {profile['name']}.\n")
    else:
        profile = run_full_onboarding()

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
