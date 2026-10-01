#!/usr/bin/env python3
import builtins
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
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


def remove_tree(path):
    def make_writable_and_retry(function, target, _error):
        os.chmod(target, stat.S_IRWXU)
        function(target)

    shutil.rmtree(path, onerror=make_writable_and_retry)


def git_repo(
    base: Path, name: str, skills: dict[str, str], extra: dict[str, str] | None = None
) -> tuple[str, str]:
    repo = base / name
    repo.mkdir()
    run(["git", "init", "-q"], repo)
    run(["git", "config", "user.email", "test@example.test"], repo)
    run(["git", "config", "user.name", "Test"], repo)
    run(["git", "config", "core.autocrlf", "false"], repo)
    for skill, body in skills.items():
        d = repo / "skills" / skill
        d.mkdir(parents=True)
        skill_md = d / "SKILL.md"
        payload = body.encode("utf-8")
        # Keep fixture hashes independent of Windows text-mode newline translation.
        skill_md.write_bytes(payload)
        assert skill_md.read_bytes() == payload
    for rel, body in (extra or {}).items():
        f = repo / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(body.encode("utf-8"))
    run(["git", "add", "."], repo)
    run(["git", "commit", "-q", "-m", "seed"], repo)
    return repo.as_uri(), run(["git", "rev-parse", "HEAD"], repo)


def fixture_manifest(ms_url: str, ms_rev: str, fab_url: str, fab_rev: str) -> dict:
    manifest = {
        "schema_version": 1,
        "policy_default": "baseline",
        "dependencies": {
            "refresh": ["git", "python3"],
            "launch": ["python3"],
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
                "version": "v0.3.18",
                "approved_domains": ["github.com"],
                "baseline": ["eventhouse-cli", "sqldw-cli"],
                "skills": {
                    "eventhouse-cli": {
                        "path": "skills/eventhouse-cli",
                        "frontmatter_name": "eventhouse-cli",
                        "approved_optional": True,
                    },
                    "sqldw-cli": {
                        "path": "skills/sqldw-cli",
                        "frontmatter_name": "sqldw-cli",
                        "approved_optional": True,
                    },
                    "project-osmos": {
                        "path": "skills/project-osmos",
                        "frontmatter_name": "project-osmos",
                        "approved_optional": False,
                        "deferred": True,
                    },
                },
                "shared": {"common": {"path": "common"}},
            },
        },
    }

    def file_url_path(url: str) -> Path:
        parsed = urllib.parse.urlparse(url)
        return Path(urllib.request.url2pathname(parsed.path))

    roots = {
        "microsoft_skills": file_url_path(ms_url),
        "fabric_skills": file_url_path(fab_url),
    }
    def committed_tree_hash(repo_key: str, revision: str, path: str) -> str:
        # Hash the immutable committed bytes that production checks out,
        # not a Windows worktree that Git may later rewrite as CRLF.
        root = roots[repo_key]
        listing = subprocess.check_output(
            ["git", "-C", str(root), "ls-tree", "-r", "--name-only", revision, path],
            text=True,
        ).split()
        tree = hashlib.sha256()
        for full in sorted(listing, key=lambda x: x[len(path) + 1 :]):
            blob = subprocess.check_output(
                ["git", "-C", str(root), "show", f"{revision}:{full}"]
            )
            tree.update(full[len(path) + 1 :].encode("utf-8"))
            tree.update(b"\0")
            tree.update(hashlib.sha256(blob).hexdigest().encode("ascii"))
            tree.update(b"\0")
        return tree.hexdigest()

    for repo_key, repo in manifest["repositories"].items():
        for meta in repo["skills"].values():
            meta["sha256"] = committed_tree_hash(repo_key, repo["revision"], meta["path"])
        for meta in repo.get("shared", {}).values():
            meta["sha256"] = committed_tree_hash(repo_key, repo["revision"], meta["path"])
    return manifest


def write_manifest(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    mskills.MANIFEST = path


real_manifest = json.loads((ROOT / "config" / "microsoft-skills.json").read_text())
assert "dependencies" in real_manifest
# Microsoft Learn is a direct HTTP entry; no MCP bridge package is a dependency.
assert "mcp" not in real_manifest["dependencies"]
assert "mcp-remote" not in json.dumps(real_manifest)
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
assert "kql" not in names and "eventhouse-cli" in names and "sqldw-cli" in names
assert names == sorted(real_manifest["repositories"]["fabric_skills"]["skills"])
assert "common" in real_manifest["repositories"]["fabric_skills"]["shared"]

mode, names = mskills.policy_for(
    {}, "fabric_skills", real_manifest["repositories"]["fabric_skills"]
)
assert mode == "disabled"
assert names == []

mode, names = mskills.policy_for(
    {"fabric_skills": {"allow": ["sqldw-cli"]}},
    "fabric_skills",
    real_manifest["repositories"]["fabric_skills"],
)
assert mode == "restricted"
assert names == ["sqldw-cli"]

# Client platform (master plan section 8 item 7): an Azure SQL-only machine keeps
# the Fabric baseline off even when the contract has a fabric: section; an
# explicit fabric_skills policy still wins; fabric/both/unset keep today's rule.
fabric_repo = real_manifest["repositories"]["fabric_skills"]
assert mskills.policy_for({"fabric": {}}, "fabric_skills", fabric_repo, "azure_sql") == ("disabled", [])
assert mskills.policy_for({}, "fabric_skills", fabric_repo, "azure_sql") == ("disabled", [])
mode, names = mskills.policy_for(
    {"fabric": {}, "fabric_skills": {"policy": "baseline"}}, "fabric_skills", fabric_repo, "azure_sql"
)
assert mode == "baseline" and "sqldw-cli" in names
for platform in ("fabric", "both", ""):
    mode, _ = mskills.policy_for({"fabric": {}}, "fabric_skills", fabric_repo, platform)
    assert mode == "baseline", platform
# Microsoft skills (kql, microsoft-docs) are not platform-bound.
mode, names = mskills.policy_for({}, "microsoft_skills", real_manifest["repositories"]["microsoft_skills"], "azure_sql")
assert mode == "baseline" and names == ["kql", "microsoft-docs"]
with tempfile.TemporaryDirectory() as td:
    cfg_dir = Path(td) / ".coop"
    cfg_dir.mkdir()
    assert mskills.machine_platform(cfg_dir / "config") == ""
    (cfg_dir / "config").write_text('{"schema_version": 1, "client": {"platform": "azure_sql"}}', encoding="utf-8")
    assert mskills.machine_platform(cfg_dir / "config") == "azure_sql"
    (cfg_dir / "config").write_text('{"schema_version": 1, "client": {"platform": "mainframe"}}', encoding="utf-8")
    assert mskills.machine_platform(cfg_dir / "config") == ""
    saved_coop_dir = os.environ.get("COOP_DIR")
    os.environ["COOP_DIR"] = td
    try:
        (cfg_dir / "config").write_text('{"schema_version": 1, "client": {"platform": "azure_sql"}}', encoding="utf-8")
        assert mskills.policy_for({"fabric": {}}, "fabric_skills", fabric_repo) == ("disabled", [])
    finally:
        if saved_coop_dir is None:
            del os.environ["COOP_DIR"]
        else:
            os.environ["COOP_DIR"] = saved_coop_dir

for repo_key in ("microsoft_skills", "fabric_skills"):
    mode, names = mskills.policy_for(
        {repo_key: {"allow": []}}, repo_key, real_manifest["repositories"][repo_key]
    )
    assert mode == "restricted"
    assert names == []

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
            # Upstream skills link the shared `common/` tree and sibling skills by
            # relative path; the published layout must keep those resolvable.
            "eventhouse-cli": "---\nname: eventhouse-cli\n---\nSee [core](../../common/COMMON-CLI.md) and [sql](../sqldw-cli/SKILL.md).\n",
            "sqldw-cli": "---\nname: sqldw-cli\n---\nSee [setup](../../mcp-setup/README.md) and [ref](references/consumption.md#x).\n",
            "project-osmos": "---\nname: project-osmos\n---\nDeferred\n",
        },
        {
            "common/COMMON-CLI.md": "# Common CLI\n",
            "common/notebook-authoring/params.md": "# Params\n",
            "skills/sqldw-cli/references/consumption.md": "See [cli](../../../common/COMMON-CLI.md).\n",
            "mcp-setup/README.md": "not shipped\n",
        },
    )
    # The trust manifest follows committed bytes even if a Windows worktree is
    # rewritten to CRLF after commit.
    source_skill = t / "fabric/skills/eventhouse-cli/SKILL.md"
    source_skill.write_bytes(source_skill.read_bytes().replace(b"\n", b"\r\n"))
    mf = t / "manifest.json"
    write_manifest(mf, fixture_manifest(ms_url, ms_rev, fab_url, fab_rev))
    project = t / "project.yml"
    project.write_text("fabric:\n  default_workspace_id: ''\n", encoding="utf-8")

    refresh_rc = mskills.refresh(project)
    fetch_state_path = t / "agent/catalogs/microsoft/fetch-state.json"
    fetch_state = (
        json.loads(fetch_state_path.read_text(encoding="utf-8"))
        if fetch_state_path.is_file()
        else {"detail": "missing fetch-state.json"}
    )
    assert refresh_rc == 0, f"refresh rc={refresh_rc}: {fetch_state}"
    current = json.loads((t / "agent/catalogs/microsoft/current.json").read_text())
    assert [s["name"] for s in current["skills"]] == [
        "eventhouse-cli",
        "sqldw-cli",
        "kql",
        "microsoft-docs",
    ]
    assert all(
        "files" in s and s["hash"] != s["files"][0]["sha256"] for s in current["skills"]
    )
    # The shared tree is published beside the repo slot, where `../../common/`
    # from a skill resolves, and only the manifest's shared trees ship.
    assert [s["name"] for s in current["shared"]] == ["common"]
    gen_root = Path(current["root"])
    assert (gen_root / "common/COMMON-CLI.md").is_file()
    assert (gen_root / "common/notebook-authoring/params.md").is_file()
    assert not (gen_root / "mcp-setup").exists()
    assert sorted(f["path"] for f in current["shared"][0]["files"]) == [
        "COMMON-CLI.md",
        "notebook-authoring/params.md",
    ]
    # Reference closure: shared and sibling links resolve; only the tree coop
    # deliberately leaves out is reported, and reporting never fails the refresh.
    assert mskills.unresolved_refs(gen_root) == [
        "fabric_skills/sqldw-cli/SKILL.md -> ../../mcp-setup/README.md"
    ]
    fetch_state = json.loads(fetch_state_path.read_text(encoding="utf-8"))
    assert fetch_state["receipt"]["unresolved_refs"] == [
        "fabric_skills/sqldw-cli/SKILL.md -> ../../mcp-setup/README.md"
    ]
    assert [s["name"] for s in fetch_state["receipt"]["shared"]] == ["common"]
    rc, lines = capture(mskills.check_refs)
    assert rc == 0 and lines[-1] == "1 unresolved reference(s)"
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
    assert len(dirs) == 4 and all(
        "/catalogs/microsoft/generations/" in Path(d).as_posix() for d in dirs
    )

    # The writable pointer and receipt cannot authorize coordinated skill,
    # generation, repository, revision, path, or manifest-metadata forgeries.
    def rejected(candidate):
        try:
            mskills.verify_current(candidate)
            raise AssertionError("forged catalog metadata was accepted")
        except ValueError:
            pass

    for mutate in (
        lambda x: x["skills"][0].__setitem__("repo", "microsoft_skills"),
        lambda x: x["skills"][0].__setitem__("revision", "0" * 40),
        lambda x: x["skills"][0].__setitem__("path", "fabric_skills/sqldw-cli"),
        lambda x: x.__setitem__("repository", "https://evil.example/skills.git"),
        lambda x: x.__setitem__("manifest", {"trusted": True}),
        # Shared trees carry the same authority: none may be dropped, renamed,
        # re-homed, or re-pinned by editing the pointer.
        lambda x: x.__setitem__("shared", []),
        lambda x: x.pop("shared"),
        lambda x: x["shared"][0].__setitem__("name", "mcp-setup"),
        lambda x: x["shared"][0].__setitem__("repo", "microsoft_skills"),
        lambda x: x["shared"][0].__setitem__("revision", "0" * 40),
        lambda x: x["shared"].append(dict(x["shared"][0], name="extra")),
    ):
        forged = json.loads(json.dumps(current))
        mutate(forged)
        rejected(forged)

    tamper_path = Path(current["root"]) / "microsoft_skills/kql/SKILL.md"
    original_bytes = tamper_path.read_bytes()
    tamper_path.write_bytes(original_bytes + b"\ncoordinated rewrite\n")
    forged = json.loads(json.dumps(current))
    forged_skill = next(s for s in forged["skills"] if s["name"] == "kql")
    digest, files, total = mskills.sha_tree(tamper_path.parent)
    forged_skill.update(hash=digest, files=files, bytes=total)
    forged_generation = mskills.generation_id(forged["skills"], forged["shared"])
    forged_root = Path(current["root"]).parent / forged_generation
    Path(current["root"]).rename(forged_root)
    forged["generation"] = forged_generation
    forged["root"] = str(forged_root)
    rejected(forged)
    forged_root.rename(Path(current["root"]))
    tamper_path.write_bytes(original_bytes)
    assert mskills.verify_current(current)

    # A shared reference file is integrity-checked like a skill file.
    shared_path = Path(current["root"]) / "common/COMMON-CLI.md"
    shared_bytes = shared_path.read_bytes()
    shared_path.write_bytes(shared_bytes + b"\ninjected\n")
    rejected(json.loads(json.dumps(current)))
    shared_path.write_bytes(shared_bytes)
    assert mskills.verify_current(current)

    # A copy-time mutation in the final generation is detected before current.json
    # publication; source-checkout validation alone is not accepted as evidence.
    original_copytree = mskills.shutil.copytree
    os.environ["PI_CODING_AGENT_DIR"] = str(t / "export-tamper-agent")

    def tampering_copytree(src, dest, **kwargs):
        result = original_copytree(src, dest, **kwargs)
        skill_md = Path(dest) / "SKILL.md"
        skill_md.write_text(skill_md.read_text(encoding="utf-8") + "\nrace\n")
        return result

    mskills.shutil.copytree = tampering_copytree
    try:
        assert mskills.refresh(project) == 69
        assert not (t / "export-tamper-agent/catalogs/microsoft/current.json").exists()
    finally:
        mskills.shutil.copytree = original_copytree
        os.environ["PI_CODING_AGENT_DIR"] = str(t / "agent")

    restricted = t / "restricted.yml"
    restricted.write_text(
        "fabric_skills:\n  policy: restricted\n  allow:\n    - sqldw-cli\nmicrosoft_skills:\n  policy: disabled\n",
        encoding="utf-8",
    )
    rc, dirs = capture(mskills.launch_dirs, restricted)
    assert rc == 0
    assert [Path(d).name for d in dirs] == ["sqldw-cli"]

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

    remove_tree(t / "microsoft")
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
    try:
        os.symlink(d / "SKILL.md", d / "link.md")
    except OSError as exc:  # Windows without the symlink privilege (plain VM accounts)
        print(f"  - skipped the symlink case: cannot create symlinks here ({exc})")
    else:
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
