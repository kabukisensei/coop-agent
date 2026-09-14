#!/usr/bin/env python3
import builtins
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
spec = importlib.util.spec_from_file_location(
    "mskills", ROOT / "lib" / "microsoft_skills.py"
)
mskills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mskills)

old_no_isolate = os.environ.get("COOP_NO_ISOLATE")
old_pi_dir = os.environ.pop("PI_CODING_AGENT_DIR", None)
old_coop_dir = os.environ.pop("COOP_AGENT_DIR", None)
os.environ["COOP_NO_ISOLATE"] = "1"
assert mskills.agent_dir() == Path.home() / ".pi" / "agent"
if old_no_isolate is None:
    os.environ.pop("COOP_NO_ISOLATE", None)
else:
    os.environ["COOP_NO_ISOLATE"] = old_no_isolate
if old_pi_dir is not None:
    os.environ["PI_CODING_AGENT_DIR"] = old_pi_dir
if old_coop_dir is not None:
    os.environ["COOP_AGENT_DIR"] = old_coop_dir


def run(cmd, cwd=None):
    return subprocess.check_output(cmd, cwd=cwd, text=True).strip()


def capture(fn, *args):
    lines = []
    old_print = builtins.print
    try:
        builtins.print = lambda value="", *a, **k: lines.append(str(value))
        rc = fn(*args)
    finally:
        builtins.print = old_print
    return rc, lines


def git_repo(base: Path, name: str, skills: dict[str, str]) -> tuple[str, str]:
    repo = base / name
    repo.mkdir()
    run(["git", "init", "-q"], repo)
    run(["git", "config", "user.email", "test@example.test"], repo)
    run(["git", "config", "user.name", "Test"], repo)
    for skill, body in skills.items():
        d = repo / "skills" / skill
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(body, encoding="utf-8")
    run(["git", "add", "."], repo)
    run(["git", "commit", "-q", "-m", "seed"], repo)
    return repo.as_uri(), run(["git", "rev-parse", "HEAD"], repo)


def fixture_manifest(ms_url: str, ms_rev: str, fab_url: str, fab_rev: str) -> dict:
    return {
        "schema_version": 1,
        "policy_default": "baseline",
        "dependencies": {
            "refresh": ["git", "python3"],
            "launch": ["python3"],
            "mcp": {"mcp-remote": "0.1.38"},
        },
        "repositories": {
            "microsoft_skills": {
                "url": ms_url,
                "revision": ms_rev,
                "approved_domains": ["github.com"],
                "baseline": ["kql", "microsoft-docs"],
                "skills": {
                    "kql": {"path": "skills/kql", "approved_optional": True},
                    "microsoft-docs": {
                        "path": "skills/microsoft-docs",
                        "approved_optional": True,
                    },
                },
            },
            "fabric_skills": {
                "url": fab_url,
                "revision": fab_rev,
                "version": "v0.3.10",
                "approved_domains": ["github.com"],
                "baseline": ["sqldw-authoring-cli", "sqldw-consumption-cli"],
                "skills": {
                    "sqldw-authoring-cli": {
                        "path": "skills/sqldw-authoring-cli",
                        "frontmatter_name": "sqldw-authoring-cli",
                        "approved_optional": True,
                    },
                    "sqldw-consumption-cli": {
                        "path": "skills/sqldw-consumption-cli",
                        "frontmatter_name": "sqldw-consumption-cli",
                        "approved_optional": True,
                    },
                    "sqldw-operations-cli": {
                        "path": "skills/sqldw-operations-cli",
                        "frontmatter_name": "sqldw-operations-cli",
                        "approved_optional": False,
                        "deferred": True,
                    },
                },
            },
        },
    }


def write_manifest(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    mskills.MANIFEST = path


real_manifest = json.loads((ROOT / "config" / "microsoft-skills.json").read_text())
assert "dependencies" in real_manifest
assert real_manifest["dependencies"]["mcp"]["mcp-remote"] == "0.1.38"
assert mskills.validate_manifest(real_manifest)

mode, names = mskills.policy_for(
    {}, "microsoft_skills", real_manifest["repositories"]["microsoft_skills"]
)
assert mode == "baseline"
assert names == ["kql", "microsoft-docs"]

mode, names = mskills.policy_for(
    {"fabric": {}}, "fabric_skills", real_manifest["repositories"]["fabric_skills"]
)
assert mode == "baseline"
assert names == ["sqldw-authoring-cli", "sqldw-consumption-cli"]

mode, names = mskills.policy_for(
    {}, "fabric_skills", real_manifest["repositories"]["fabric_skills"]
)
assert mode == "disabled"
assert names == []

mode, names = mskills.policy_for(
    {"fabric_skills": {"allow": ["sqldw-consumption-cli"]}},
    "fabric_skills",
    real_manifest["repositories"]["fabric_skills"],
)
assert mode == "restricted"
assert names == ["sqldw-consumption-cli"]

mode, names = mskills.policy_for(
    {"fabric_skills": {"policy": "restricted", "allow": []}},
    "fabric_skills",
    real_manifest["repositories"]["fabric_skills"],
)
assert mode == "restricted"
assert names == []

mode, names = mskills.policy_for(
    {"fabric_skills": {"policy": "disabled"}},
    "fabric_skills",
    real_manifest["repositories"]["fabric_skills"],
)
assert mode == "disabled"
assert names == []

with tempfile.TemporaryDirectory() as td:
    t = Path(td)
    os.environ["PI_CODING_AGENT_DIR"] = str(t / "agent")
    os.environ["COOP_MS_SKILLS_TEST_ALLOW_FILE"] = "1"
    ms_url, ms_rev = git_repo(
        t,
        "microsoft",
        {
            "kql": "---\nname: kql\n---\nKQL\n",
            "microsoft-docs": "---\nname: microsoft-docs\n---\nDocs\n",
        },
    )
    fab_url, fab_rev = git_repo(
        t,
        "fabric",
        {
            "sqldw-authoring-cli": "---\nname: sqldw-authoring-cli\n---\nAuthor\n",
            "sqldw-consumption-cli": "---\nname: sqldw-consumption-cli\n---\nConsume\n",
            "sqldw-operations-cli": "---\nname: sqldw-operations-cli\n---\nDeferred\n",
        },
    )
    mf = t / "manifest.json"
    write_manifest(mf, fixture_manifest(ms_url, ms_rev, fab_url, fab_rev))
    project = t / "project.yml"
    project.write_text("fabric:\n  default_workspace_id: ''\n", encoding="utf-8")

    assert mskills.refresh(project) == 0
    current = json.loads((t / "agent/catalogs/microsoft/current.json").read_text())
    assert [s["name"] for s in current["skills"]] == [
        "sqldw-authoring-cli",
        "sqldw-consumption-cli",
        "kql",
        "microsoft-docs",
    ]
    assert all(
        "files" in s and s["hash"] != s["files"][0]["sha256"] for s in current["skills"]
    )
    generation = current["generation"]
    assert mskills.refresh(project) == 0
    assert (
        json.loads((t / "agent/catalogs/microsoft/current.json").read_text())[
            "generation"
        ]
        == generation
    )

    rc, dirs = capture(mskills.launch_dirs, project)
    assert rc == 0
    assert len(dirs) == 4 and all("/catalogs/microsoft/generations/" in d for d in dirs)

    restricted = t / "restricted.yml"
    restricted.write_text(
        "fabric_skills:\n  policy: restricted\n  allow:\n    - sqldw-consumption-cli\nmicrosoft_skills:\n  policy: disabled\n",
        encoding="utf-8",
    )
    rc, dirs = capture(mskills.launch_dirs, restricted)
    assert rc == 0
    assert [Path(d).name for d in dirs] == ["sqldw-consumption-cli"]

    disabled = t / "disabled.yml"
    disabled.write_text(
        "fabric_skills:\n  policy: disabled\nmicrosoft_skills:\n  policy: disabled\n",
        encoding="utf-8",
    )
    rc, dirs = capture(mskills.launch_dirs, disabled)
    assert rc == 0
    assert dirs == []

    tamper = Path(current["root"]) / "microsoft_skills/kql/SKILL.md"
    tamper.write_text(
        tamper.read_text(encoding="utf-8") + "\nchanged\n", encoding="utf-8"
    )
    rc, lines = capture(mskills.doctor_lines, project)
    assert rc == 0
    assert "\ttampered\t" in lines[0]
    detail = json.loads(lines[0].split("\t", 6)[6])
    assert "target_revisions" in detail
    assert "active_revisions" in detail
    assert detail["enabled_count"] == 4
    assert "microsoft_skills:baseline:2" in detail["policy"]

    shutil.rmtree(t / "microsoft")
    assert mskills.refresh(project) == 70
    state = json.loads((t / "agent/catalogs/microsoft/fetch-state.json").read_text())
    assert state["state"] == "stale_LKG"

    lock = t / "agent/catalogs/microsoft/.lock"
    lock.write_text("locked", encoding="utf-8")
    assert mskills.refresh(project) == 75
    lock.unlink()

with tempfile.TemporaryDirectory() as td:
    t = Path(td)
    os.environ["PI_CODING_AGENT_DIR"] = str(t / "agent2")
    bad = json.loads(json.dumps(real_manifest))
    bad["repositories"]["microsoft_skills"]["url"] = (
        "https://evil.example/microsoft/skills.git"
    )
    try:
        mskills.validate_manifest(bad)
        raise AssertionError("unapproved domain accepted")
    except ValueError:
        pass
    bad = json.loads(json.dumps(real_manifest))
    bad["repositories"]["fabric_skills"]["skills"]["kql"] = {"path": "skills/kql"}
    try:
        mskills.validate_manifest(bad)
        raise AssertionError("duplicate name accepted")
    except ValueError:
        pass
    bad = json.loads(json.dumps(real_manifest))
    bad["repositories"]["microsoft_skills"]["skills"]["kql"]["path"] = "../kql"
    try:
        mskills.validate_manifest(bad)
        raise AssertionError("traversal accepted")
    except ValueError:
        pass

with tempfile.TemporaryDirectory() as td:
    t = Path(td)
    d = t / "skill"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: wrong\n---\n", encoding="utf-8")
    try:
        mskills.validate_skill(d, "right", set())
        raise AssertionError("frontmatter mismatch accepted")
    except ValueError:
        pass
    (d / "SKILL.md").write_text("---\nname: right\n---\n", encoding="utf-8")
    os.symlink(d / "SKILL.md", d / "link.md")
    try:
        mskills.validate_skill(d, "right", set())
        raise AssertionError("symlink accepted")
    except ValueError:
        pass
with tempfile.TemporaryDirectory() as td:
    t = Path(td)
    d = t / "skill"
    d.mkdir()
    (d / "SKILL.md").write_text("# no name\n", encoding="utf-8")
    try:
        mskills.validate_skill(d, "right", set())
        raise AssertionError("missing frontmatter name accepted")
    except ValueError:
        pass

print(
    "  OK  Microsoft skills catalog pins, policy, LKG, tamper, launch, and supply-chain checks"
)
