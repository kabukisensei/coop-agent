#!/usr/bin/env python3
"""coop context-budget — report fixed startup context sizes for COOP.

Measurement method: static character counts with a conservative token estimate
(ceil(chars / 4)). This is NOT an exact tokenizer output. If a provider exposes
exact usage it can be added behind an explicit --measure/--yes approval gate;
until then we report estimates and label them clearly.

Rules:
- Never emit secrets or raw config/auth values.
- Never claim an estimate is exact.
- Cross-platform: works on Linux, macOS, Windows with python3.
- Bash 3.2 compatibility is irrelevant here because this is Python; the bash
  launcher simply execs this script.

Classification:
- Always-loaded items are counted in estimated_fixed_total_tokens.
- Prompt template bodies are NOT counted in fixed total because Pi expands them
  only when invoked; they are reported as on-demand inventory.
"""

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

SCHEMA_VERSION = 1
TOKEN_FORMULA = "ceil(chars/4)"

PRESET_TEXT = {
    "concise": "Answer first. Keep explanations short. Use bullets where useful. Explain tradeoffs only when material.",
    "balanced": "Answer first. Give a brief why. Then structured detail.",
    "teaching": "Answer first. Explain reasoning, alternatives, and tradeoffs in more depth.",
    "custom": "",
}

VALID_PRESETS = set(PRESET_TEXT.keys())


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def find_repo_root() -> Path:
    """Resolve repo root from COOP_ROOT or by walking up from this script."""
    env = os.environ.get("COOP_ROOT")
    if env:
        return Path(env).resolve()
    p = Path(__file__).resolve().parent.parent
    return p


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def read_bytes(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


def estimate_tokens(chars: int) -> int:
    return math.ceil(chars / 4)


def defaults_value(defaults_text: str, key: str) -> str:
    """Extract a simple top-level scalar from config/defaults.yml.

    Handles quoted strings, unquoted scalars, and inline comments. Multi-line
    values are not needed for the keys we care about.
    """
    for line in defaults_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(rf"^\s*{re.escape(key)}\s*:\s*(.*)$", line)
        if not m:
            continue
        val = m.group(1).strip()
        # remove inline comment (only when # preceded by whitespace)
        val = re.sub(r"\s#.*$", "", val)
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        return val
    return ""


def find_project_instructions(start_dir: Path) -> tuple[Path | None, int, int]:
    """Find the nearest AGENTS.md or CLAUDE.md from start_dir upward."""
    cur = start_dir.resolve()
    for _ in range(64):
        for name in ("AGENTS.md", "CLAUDE.md"):
            candidate = cur / name
            if candidate.is_file():
                text = read_text(candidate)
                return candidate, len(text), estimate_tokens(len(text))
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None, 0, 0


def profile_path() -> Path:
    """Locate the local user profile."""
    home = Path.home()
    coop_dir = os.environ.get("COOP_DIR", str(home / ".coop"))
    return Path(coop_dir) / "user.json"


def _sanitize(value: str, max_len: int = 100) -> str:
    """Mirror of extensions/coop-profile/index.ts sanitize()."""
    cleaned = re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+", " ", value)
    collapsed = re.sub(r"\s+", " ", cleaned)
    return collapsed.strip()[:max_len]


def load_profile(profile_file: Path) -> dict | None:
    """Load and validate ~/.coop/user.json; return normalized profile or None."""
    if not profile_file.is_file():
        return None
    try:
        raw = json.loads(profile_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        return None
    name = raw.get("name")
    if not isinstance(name, str) or not _sanitize(name):
        return None
    comm = raw.get("communication")
    if not isinstance(comm, dict):
        return None
    preset = comm.get("preset")
    if not isinstance(preset, str) or preset not in VALID_PRESETS:
        return None
    custom = comm.get("custom_instructions")
    return {
        "name": _sanitize(name),
        "preset": preset,
        "custom_instructions": _sanitize(custom, 1000) if isinstance(custom, str) else "",
    }


def build_profile_instruction(profile: dict) -> str:
    """Mirror of extensions/coop-profile/index.ts buildInstruction()."""
    preset = profile["preset"]
    style = PRESET_TEXT[preset]
    if preset == "custom" and profile["custom_instructions"]:
        style = profile["custom_instructions"].strip()
    parts = [
        "COOP user profile:",
        f"- Call the user {profile['name']}.",
    ]
    if style:
        parts.append(f"- Communication: {preset}. {style}")
    else:
        parts.append(f"- Communication: {preset}.")
    return "\n".join(parts)


def measure_profile(profile_file: Path) -> dict:
    """Measure the instruction the coop-profile extension actually injects."""
    raw_text = read_text(profile_file)
    profile = load_profile(profile_file)
    instruction = build_profile_instruction(profile) if profile else ""
    return {
        "path": str(profile_file),
        "present": profile_file.is_file(),
        "valid": profile is not None,
        "raw_chars": len(raw_text),
        "instruction_chars": len(instruction),
        "estimated_tokens": estimate_tokens(len(instruction)),
    }


def parse_skill_frontmatter(path: Path) -> dict:
    """Return a dict with name, description from a SKILL.md frontmatter block."""
    text = read_text(path)
    out = {"name": path.parent.name, "description": ""}
    if not text.startswith("---"):
        return out
    end = text.find("\n---", 3)
    if end == -1:
        end = text.find("\r\n---", 3)
    if end == -1:
        return out
    fm = text[3:end]
    m = re.search(r"^\s*name:\s*(.+)$", fm, re.MULTILINE)
    if m:
        out["name"] = m.group(1).strip().strip('"').strip("'")
    m = re.search(r'^\s*description:\s*(?:"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\'|([^\r\n]+))$', fm, re.MULTILINE)
    if m:
        desc = next(g for g in m.groups() if g is not None)
        out["description"] = desc.strip()
    return out


def measure_skills(skills_dir: Path) -> dict:
    entries = []
    desc_chars = 0
    if skills_dir.is_dir():
        for skill_dir in sorted(skills_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            name = skill_dir.name
            if name.startswith("_"):
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.is_file():
                continue
            fm = parse_skill_frontmatter(skill_md)
            desc = fm.get("description", "")
            entries.append({
                "folder": name,
                "name": fm.get("name", name),
                "description_chars": len(desc),
            })
            desc_chars += len(desc)
    return {
        "count": len(entries),
        "description_chars": desc_chars,
        "estimated_tokens": estimate_tokens(desc_chars),
        "entries": entries,
    }


def measure_prompts(prompts_dir: Path) -> dict:
    files = []
    total_chars = 0
    if prompts_dir.is_dir():
        for f in sorted(prompts_dir.iterdir()):
            if f.is_file() and f.suffix == ".md":
                text = read_text(f)
                files.append({"file": f.name, "chars": len(text)})
                total_chars += len(text)
    return {
        "count": len(files),
        "chars": total_chars,
        "estimated_tokens": estimate_tokens(total_chars),
        "files": files,
    }


def extract_braced_blocks(text: str, marker: str) -> list[str]:
    """Extract the contents inside balanced {} for every occurrence of marker{.

    Handles nested braces and skips braceless arrow functions/templates by only
    counting '{' and '}' that appear at the top level of the block.
    """
    blocks = []
    i = 0
    while True:
        idx = text.find(marker, i)
        if idx == -1:
            break
        start = idx + len(marker)
        if start >= len(text) or text[start] != "{":
            i = start
            continue
        depth = 1
        j = start + 1
        while j < len(text) and depth > 0:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        if depth == 0:
            blocks.append(text[start + 1 : j - 1])
        i = j
    return blocks


def extract_string_literal(text: str, pos: int) -> tuple[str, int]:
    """Extract a string literal starting at pos. Returns (literal, next_index)."""
    if pos >= len(text):
        return "", pos
    ch = text[pos]
    if ch not in ('"', "'", "`"):
        return "", pos
    end = pos + 1
    while end < len(text):
        if text[end] == "\\" and end + 1 < len(text):
            end += 2
        elif text[end] == ch:
            break
        else:
            end += 1
    return text[pos + 1 : end], end + 1


def collect_tool_metadata_chars(index_text: str) -> tuple[int, int]:
    """Return (total_chars_of_metadata_strings, number_of_tools).

    Captures strings after description:, promptSnippet:, and inside
    promptGuidelines: [...] arrays within pi.registerTool({...}) blocks.
    """
    total = 0
    tool_blocks = extract_braced_blocks(index_text, "pi.registerTool(")
    for block in tool_blocks:
        i = 0
        in_guidelines = False
        while i < len(block):
            if block.startswith("promptGuidelines", i):
                j = i + len("promptGuidelines")
                while j < len(block) and block[j] in ": \t\n\r":
                    j += 1
                if j < len(block) and block[j] == "[":
                    in_guidelines = True
                    i = j + 1
                    continue
            if in_guidelines and block[i] == "]":
                in_guidelines = False
                i += 1
                continue
            key_match = None
            for key in ("description", "promptSnippet"):
                if block.startswith(key, i):
                    j = i + len(key)
                    if j < len(block) and block[j] == ":":
                        key_match = key
                        i = j + 1
                        break
            if key_match:
                while i < len(block) and block[i] in " \t\n\r":
                    i += 1
                lit, nxt = extract_string_literal(block, i)
                total += len(lit)
                i = nxt
                continue
            if in_guidelines:
                lit, nxt = extract_string_literal(block, i)
                if nxt > i:
                    total += len(lit)
                    i = nxt
                    continue
            i += 1
    return total, len(tool_blocks)


def measure_native_tools(extensions_dir: Path) -> dict:
    """Measure the COOP native tool surface (currently extensions/coop-tools)."""
    coop_tools = extensions_dir / "coop-tools" / "index.ts"
    text = read_text(coop_tools)
    meta_chars, tool_count = collect_tool_metadata_chars(text)
    return {
        "file": str(coop_tools.relative_to(extensions_dir.parent) if coop_tools.is_file() else "extensions/coop-tools/index.ts"),
        "count": tool_count,
        "schema_chars": meta_chars,
        "estimated_tokens": estimate_tokens(meta_chars),
        "file_chars": len(text),
    }


def measure_extensions(extensions_dir: Path) -> dict:
    entries = []
    if extensions_dir.is_dir():
        for ext_dir in sorted(extensions_dir.iterdir()):
            if not ext_dir.is_dir():
                continue
            name = ext_dir.name
            index_ts = ext_dir / "index.ts"
            tool_count = 0
            if index_ts.is_file():
                tool_count = len(re.findall(r"pi\.registerTool\s*\(", read_text(index_ts)))
            cmd_count = 0
            if index_ts.is_file():
                cmd_count = len(re.findall(r"pi\.registerCommand\s*\(", read_text(index_ts)))
            entries.append({
                "name": name,
                "registered_tools": tool_count,
                "registered_commands": cmd_count,
            })
    return {
        "count": len(entries),
        "entries": entries,
    }


def measure_guardrails(guardrails_path: Path, repo_root: Path) -> dict:
    chars = len(read_text(guardrails_path))
    return {
        "path": str(guardrails_path.relative_to(repo_root) if guardrails_path.is_file() else guardrails_path),
        "chars": chars,
        "bytes": read_bytes(guardrails_path),
        "estimated_tokens": estimate_tokens(chars),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Report COOP fixed startup context sizes.",
        prog="coop context-budget",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument(
        "--measure",
        action="store_true",
        help="Request exact provider measurement (not implemented; would require explicit approval)",
    )
    parser.add_argument("--yes", action="store_true", help="Auto-approve --measure when implemented")
    args = parser.parse_args()

    if args.measure:
        print(
            "Exact provider measurement is not available in this implementation.\n"
            "Static estimates are shown below. A future --measure option would make a\n"
            "tiny no-op model call and require explicit user approval.",
            file=sys.stderr,
        )

    repo_root = find_repo_root()
    defaults_path = repo_root / "config" / "defaults.yml"
    defaults_text = read_text(defaults_path)

    guardrails_rel = defaults_value(defaults_text, "guardrails") or "docs/guardrails.md"
    prompts_rel = defaults_value(defaults_text, "prompts") or "prompts"
    skills_rel = defaults_value(defaults_text, "skills") or "skills"

    guardrails_path = repo_root / guardrails_rel
    prompts_dir = repo_root / prompts_rel
    skills_dir = repo_root / skills_rel
    extensions_dir = repo_root / "extensions"

    cwd = Path.cwd()
    guardrails = measure_guardrails(guardrails_path, repo_root)

    profile_file = profile_path()
    profile = measure_profile(profile_file)

    proj_path, proj_chars, proj_tokens = find_project_instructions(cwd)

    prompts = measure_prompts(prompts_dir)
    skills = measure_skills(skills_dir)
    native_tools = measure_native_tools(extensions_dir)
    extensions = measure_extensions(extensions_dir)

    # Fixed total: only always-loaded + advertised metadata that is present at startup.
    # Prompt template bodies are on-demand inventory, not fixed total.
    total_chars = (
        guardrails["chars"]
        + profile["instruction_chars"]
        + proj_chars
        + skills["description_chars"]
        + native_tools["schema_chars"]
    )

    measurement = {
        "method": "static_char_estimate",
        "token_formula": TOKEN_FORMULA,
        "note": "Upper-bound static estimate of prompt-visible fixed startup context. Prompt template bodies are excluded from the fixed total because Pi expands them only when invoked.",
    }

    categories = {
        "guardrails": {
            "path": guardrails["path"],
            "bytes": guardrails["bytes"],
            "chars": guardrails["chars"],
            "estimated_tokens": guardrails["estimated_tokens"],
        },
        "profile": {
            "path": profile["path"],
            "present": profile["present"],
            "valid": profile["valid"],
            "chars": profile["instruction_chars"],
            "raw_chars": profile["raw_chars"],
            "instruction_chars": profile["instruction_chars"],
            "estimated_tokens": estimate_tokens(profile["instruction_chars"]),
        },
        "project_instructions": {
            "path": str(proj_path) if proj_path else None,
            "present": proj_path is not None,
            "chars": proj_chars,
            "estimated_tokens": proj_tokens,
        },
        "skills": {
            "dir": str(skills_dir.relative_to(repo_root)),
            "count": skills["count"],
            "description_chars": skills["description_chars"],
            "estimated_tokens": skills["estimated_tokens"],
            "entries": skills["entries"],
        },
        "native_tools": {
            "file": native_tools["file"],
            "count": native_tools["count"],
            "schema_chars": native_tools["schema_chars"],
            "estimated_tokens": native_tools["estimated_tokens"],
            "file_chars": native_tools["file_chars"],
        },
        "extensions": {
            "dir": "extensions",
            "count": extensions["count"],
            "entries": extensions["entries"],
            "note": "Extension implementation source is not included in the fixed-total estimate; only tool/command metadata and hidden messages are prompt-visible.",
        },
        "on_demand_inventory": {
            "prompts": {
                "dir": str(prompts_dir.relative_to(repo_root)),
                "count": prompts["count"],
                "chars": prompts["chars"],
                "estimated_tokens": prompts["estimated_tokens"],
                "files": prompts["files"],
                "note": "Prompt templates are loaded by name/reference; their full bodies expand only when invoked.",
            },
        },
    }

    result = {
        "schema_version": SCHEMA_VERSION,
        "coop_version": (repo_root / "VERSION").read_text(encoding="utf-8").strip()
        if (repo_root / "VERSION").is_file()
        else None,
        "measurement": measurement,
        "categories": categories,
        "estimated_fixed_total_tokens": estimate_tokens(total_chars),
        "total_chars": total_chars,
    }

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    print("COOP context budget")
    print("")
    print("Always-loaded")
    print(f"  Guardrails              {guardrails['chars']:,} chars    ~{guardrails['estimated_tokens']:,} tokens   ({guardrails['path']})")
    print(f"  User profile            {profile['instruction_chars']:,} instr chars  ~{estimate_tokens(profile['instruction_chars']):,} tokens   ({'valid' if profile['valid'] else ('present but invalid' if profile['present'] else 'absent')})")
    print(f"  Project instructions    {proj_chars:,} chars    ~{proj_tokens:,} tokens   ({proj_path if proj_path else 'none found'})")
    print("")
    print("Advertised metadata")
    print(f"  Skills                 {skills['count']:<3} entries {skills['description_chars']:,} chars    ~{skills['estimated_tokens']:,} tokens")
    print(f"  Native tools           {native_tools['count']:<3} tools   {native_tools['schema_chars']:,} schema chars  ~{native_tools['estimated_tokens']:,} tokens")
    print("")
    print("On-demand inventory (not included in fixed total)")
    print(f"  Prompt templates       {prompts['count']:<3} files   {prompts['chars']:,} chars    ~{prompts['estimated_tokens']:,} tokens")
    print("")
    print("Extensions")
    for e in extensions["entries"]:
        print(f"  {e['name']:<24} {e['registered_tools']} tool(s), {e['registered_commands']} cmd(s)")
    print("")
    print(f"Estimated fixed total              ~{estimate_tokens(total_chars):,} tokens")
    print(f"Total measured chars               {total_chars:,}")
    print("")
    print(f"Static estimate: {TOKEN_FORMULA}")
    print("Exact provider measurement: not requested" if not args.measure else "Exact provider measurement: requested but unavailable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
