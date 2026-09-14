#!/usr/bin/env python3
"""Fetch and resolve official Microsoft skills into immutable local catalogs.

The catalog lives outside the repo under the effective Coop/Pi agent directory:
catalogs/microsoft/generations/<hash>/..., current.json, and fetch-state.json.
Launch resolution reads only current.json and never networks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any

try:
    from _yaml import load as load_yaml
except Exception:  # pragma: no cover
    load_yaml = None

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "config" / "microsoft-skills.json"
MAX_SKILL_BYTES = 750_000
MAX_FILE_BYTES = 500_000
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
APPROVED_HOSTS = {"github.com"}


def agent_dir() -> Path:
    configured = os.environ.get("PI_CODING_AGENT_DIR") or os.environ.get(
        "COOP_AGENT_DIR"
    )
    if configured:
        return Path(configured).expanduser()
    if os.environ.get("COOP_NO_ISOLATE", "").lower() in {"1", "true", "yes", "on"}:
        return Path.home() / ".pi" / "agent"
    return Path.home() / ".coop" / "agent"


def catalog_root() -> Path:
    return agent_dir() / "catalogs" / "microsoft"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(value, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sha_tree(path: Path) -> tuple[str, list[dict[str, Any]], int]:
    h = hashlib.sha256()
    files: list[dict[str, Any]] = []
    total = 0
    root = path.resolve()
    for p in sorted(path.rglob("*"), key=lambda x: x.relative_to(path).as_posix()):
        rel = p.relative_to(path).as_posix()
        if p.is_symlink():
            raise ValueError(f"symlink rejected: {rel}")
        st = p.stat()
        if not p.is_file() and not p.is_dir():
            raise ValueError(f"special file rejected: {rel}")
        if p.is_dir():
            continue
        if p.resolve().parent != p.parent.resolve() or root not in p.resolve().parents:
            raise ValueError(f"path containment failed: {rel}")
        if st.st_size > MAX_FILE_BYTES:
            raise ValueError(f"file exceeds size limit: {rel}")
        total += st.st_size
        if total > MAX_SKILL_BYTES:
            raise ValueError("skill exceeds size limit")
        digest = sha_file(p)
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(digest.encode("ascii"))
        h.update(b"\0")
        files.append({"path": rel, "sha256": digest, "bytes": st.st_size})
    return h.hexdigest(), files, total


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported manifest schema")
    deps = manifest.get("dependencies")
    if not isinstance(deps, dict) or "refresh" not in deps or "launch" not in deps:
        raise ValueError("manifest missing explicit dependencies")
    repos = manifest.get("repositories")
    if not isinstance(repos, dict):
        raise ValueError("manifest missing repositories")
    seen: set[str] = set()
    for repo_key, repo in repos.items():
        if repo_key not in {"microsoft_skills", "fabric_skills"}:
            raise ValueError(f"unexpected repository key {repo_key}")
        if not isinstance(repo, dict):
            raise ValueError(f"invalid repository {repo_key}")
        parsed = urllib.parse.urlparse(str(repo.get("url", "")))
        test_file_ok = os.environ.get("COOP_MS_SKILLS_TEST_ALLOW_FILE") == "1"
        if test_file_ok and parsed.scheme == "file":
            pass
        elif parsed.scheme != "https" or parsed.hostname not in APPROVED_HOSTS:
            raise ValueError(f"unapproved repository URL for {repo_key}")
        if not SHA_RE.match(str(repo.get("revision", ""))):
            raise ValueError(f"repository {repo_key} must pin a full commit SHA")
        domains = repo.get("approved_domains")
        if domains != ["github.com"]:
            raise ValueError(f"repository {repo_key} has invalid approved domains")
        skills = repo.get("skills")
        baseline = repo.get("baseline")
        if not isinstance(skills, dict) or not isinstance(baseline, list):
            raise ValueError(f"repository {repo_key} missing skills/baseline")
        for name in list(skills) + baseline:
            if not isinstance(name, str) or not NAME_RE.match(name):
                raise ValueError(f"invalid skill name {name!r}")
        for name, meta in skills.items():
            if name in seen:
                raise ValueError(f"duplicate skill name {name}")
            seen.add(name)
            if not isinstance(meta, dict):
                raise ValueError(f"invalid skill metadata for {name}")
            rel = Path(str(meta.get("path", "")))
            if rel.is_absolute() or ".." in rel.parts or rel.name == "":
                raise ValueError(f"invalid manifest path for {name}")
            if meta.get("frontmatter_name") not in (None, name):
                raise ValueError(f"frontmatter authority mismatch for {name}")
            if (
                meta.get("approved_optional", True) is not True
                and meta.get("deferred") is not True
            ):
                raise ValueError(
                    f"unapproved non-baseline skill must be deferred: {name}"
                )
        for name in baseline:
            if name not in skills:
                raise ValueError(f"baseline skill missing metadata: {name}")
            if skills[name].get("approved_optional", True) is not True:
                raise ValueError(f"baseline skill is not approved: {name}")
    return manifest


def parse_project(project: Path | None) -> dict[str, Any]:
    if not project or not project.is_file() or load_yaml is None:
        return {}
    data = load_yaml(str(project))
    return data if isinstance(data, dict) else {}


def find_project(start: Path) -> Path | None:
    d = start.resolve()
    for _ in range(8):
        p = d / ".coop" / "project.yml"
        if p.is_file():
            return p
        if d.parent == d:
            break
        d = d.parent
    return None


def own_skill_names() -> set[str]:
    names: set[str] = set()
    for d in (ROOT / "skills").glob("*"):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        skill = d / "SKILL.md"
        if not skill.is_file():
            continue
        names.add(d.name)
        text = skill.read_text(encoding="utf-8", errors="replace")[:2048]
        for line in text.splitlines():
            if line.startswith("name:"):
                names.add(line.split(":", 1)[1].strip().strip("'\""))
                break
    return names


def policy_for(
    project: dict[str, Any], repo_key: str, repo_manifest: dict[str, Any]
) -> tuple[str, list[str]]:
    block = project.get(repo_key) if isinstance(project.get(repo_key), dict) else {}
    explicit_mode = block.get("policy") or block.get("mode")
    legacy_allow = block.get("allow")
    if explicit_mode in ("restricted", "disabled", "baseline"):
        mode = explicit_mode
    elif isinstance(legacy_allow, list) and legacy_allow:
        mode = "restricted"
    elif repo_key == "fabric_skills":
        fabric = project.get("fabric")
        mode = "baseline" if isinstance(fabric, dict) else "disabled"
    else:
        mode = "baseline"
    if mode == "disabled":
        return mode, []
    approved = repo_manifest.get("skills", {})
    baseline = [s for s in repo_manifest.get("baseline", []) if s in approved]
    if mode == "restricted":
        wanted = [
            s
            for s in (legacy_allow if isinstance(legacy_allow, list) else [])
            if isinstance(s, str)
        ]
    else:
        wanted = baseline
    return mode, [
        s for s in wanted if approved.get(s, {}).get("approved_optional", True) is True
    ]


def validate_skill(src: Path, expected_name: str, own: set[str]) -> dict[str, Any]:
    if not src.is_dir():
        raise ValueError(f"missing skill dir {src}")
    real = src.resolve()
    if src.name in {".", ".."} or any(part in {".", ".."} for part in src.parts):
        raise ValueError(f"invalid skill path {src}")
    if src.is_symlink() or any(p.is_symlink() for p in src.rglob("*")):
        raise ValueError(f"symlink rejected in {src}")
    skill_md = src / "SKILL.md"
    if not skill_md.is_file():
        raise ValueError(f"missing SKILL.md for {expected_name}")
    text = skill_md.read_text(encoding="utf-8", errors="replace")
    fm_name = ""
    for line in text.splitlines()[:40]:
        if line.startswith("name:"):
            fm_name = line.split(":", 1)[1].strip().strip("'\"")
            break
    if not fm_name:
        raise ValueError(f"missing frontmatter name for {expected_name}")
    if fm_name and fm_name != expected_name:
        raise ValueError(f"frontmatter name mismatch for {expected_name}: {fm_name}")
    if expected_name in own or (fm_name and fm_name in own):
        raise ValueError(f"subordinate conflict for {expected_name}")
    digest, files, total = sha_tree(src)
    return {"bytes": total, "hash": digest, "files": files, "real": str(real)}


def git_archive_exact(url: str, revision: str, dest: Path) -> None:
    clone = dest / "_repo"
    git_env = dict(os.environ)
    git_env.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "Never",
            "GIT_ASKPASS": "",
        }
    )
    subprocess.run(
        [
            "git",
            "-c",
            "core.autocrlf=false",
            "clone",
            "--no-checkout",
            "--filter=blob:none",
            url,
            str(clone),
        ],
        check=True,
        timeout=60,
        env=git_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(clone),
            "-c",
            "core.autocrlf=false",
            "fetch",
            "--depth",
            "1",
            "origin",
            revision,
        ],
        check=True,
        timeout=60,
        env=git_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    got = subprocess.check_output(
        ["git", "-C", str(clone), "rev-parse", "FETCH_HEAD"],
        text=True,
        timeout=15,
        env=git_env,
    ).strip()
    if got != revision:
        raise RuntimeError(f"revision mismatch for {url}: {got}")
    subprocess.run(
        [
            "git",
            "-C",
            str(clone),
            "-c",
            "core.autocrlf=false",
            "checkout",
            "--detach",
            revision,
        ],
        check=True,
        timeout=30,
        env=git_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def refresh(project_path: Path | None, *, force: bool = False) -> int:
    manifest = validate_manifest(read_json(MANIFEST))
    project = parse_project(project_path)
    cat = catalog_root()
    lock = cat / ".lock"
    cat.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except FileExistsError:
        write_json_atomic(
            cat / "fetch-state.json",
            {"state": "unavailable", "detail": "locked", "time": int(time.time())},
        )
        return 75
    stage = Path(tempfile.mkdtemp(prefix="microsoft-skills.", dir=str(cat)))
    try:
        own = own_skill_names()
        enabled: list[dict[str, Any]] = []
        receipt: dict[str, Any] = {
            "schema_version": 1,
            "repositories": {},
            "skills": [],
        }
        for repo_key, repo in manifest["repositories"].items():
            mode, wanted = policy_for(project, repo_key, repo)
            receipt["repositories"][repo_key] = {
                "mode": mode,
                "revision": repo["revision"],
                "count": len(wanted),
            }
            if not wanted:
                continue
            git_archive_exact(repo["url"], repo["revision"], stage / repo_key)
            checkout = stage / repo_key / "_repo"
            for name in wanted:
                meta = repo["skills"][name]
                rel = Path(meta["path"])
                if rel.is_absolute() or ".." in rel.parts:
                    raise ValueError(f"invalid manifest path for {name}")
                src = checkout / rel
                expected_fm = meta.get("frontmatter_name")
                if expected_fm and expected_fm != name:
                    raise ValueError(f"frontmatter authority mismatch for {name}")
                v = validate_skill(src, name, own)
                dest_rel = Path(repo_key) / name
                dest = stage / "skills" / dest_rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src, dest, symlinks=False)
                enabled.append(
                    {
                        "name": name,
                        "repo": repo_key,
                        "path": str(dest_rel).replace("\\", "/"),
                        "hash": v["hash"],
                        "bytes": v["bytes"],
                        "files": v["files"],
                        "revision": repo["revision"],
                    }
                )
        gen_hash = hashlib.sha256(
            json.dumps(enabled, sort_keys=True).encode("utf-8")
        ).hexdigest()[:16]
        gen = cat / "generations" / gen_hash
        if gen.exists():
            current = {
                "schema_version": 1,
                "generation": gen_hash,
                "root": str(gen),
                "skills": enabled,
            }
            verify_current(current)
        else:
            gen.parent.mkdir(parents=True, exist_ok=True)
            if (stage / "skills").is_dir():
                shutil.move(str(stage / "skills"), str(gen))
            else:
                gen.mkdir()
        gen.parent.mkdir(parents=True, exist_ok=True)
        current = {
            "schema_version": 1,
            "generation": gen_hash,
            "root": str(gen),
            "skills": enabled,
            "fetched_at": int(time.time()),
        }
        write_json_atomic(cat / "current.json", current)
        receipt["generation"] = gen_hash
        receipt["skills"] = enabled
        write_json_atomic(
            cat / "fetch-state.json",
            {"state": "current", "receipt": receipt, "time": int(time.time())},
        )
        return 0
    except Exception as exc:
        state = "stale_LKG" if (cat / "current.json").is_file() else "never_fetched"
        write_json_atomic(
            cat / "fetch-state.json",
            {"state": state, "detail": str(exc), "time": int(time.time())},
        )
        return 70 if state == "stale_LKG" else 69
    finally:
        try:
            os.unlink(lock)
        except FileNotFoundError:
            pass
        shutil.rmtree(stage, ignore_errors=True)


def verify_current(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("schema_version") != 1:
        raise ValueError("bad current schema")
    cat = catalog_root().resolve()
    gen = data.get("generation")
    root = Path(str(data.get("root", ""))).expanduser().resolve()
    if (
        not isinstance(gen, str)
        or not gen
        or root != (cat / "generations" / gen).resolve()
    ):
        raise ValueError("current root is outside the active generation")
    if not root.is_dir():
        raise ValueError("current generation missing")
    skills = data.get("skills")
    if not isinstance(skills, list):
        raise ValueError("current skills missing")
    seen: set[str] = set()
    for skill in skills:
        if not isinstance(skill, dict):
            raise ValueError("bad skill receipt")
        name = skill.get("name")
        rel = skill.get("path")
        if not isinstance(name, str) or not NAME_RE.match(name) or name in seen:
            raise ValueError("duplicate or invalid skill receipt name")
        seen.add(name)
        if not isinstance(rel, str):
            raise ValueError("bad skill receipt path")
        rel_path = Path(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise ValueError("bad skill receipt path")
        p = (root / rel_path).resolve()
        if root not in p.parents or not (p / "SKILL.md").is_file():
            raise ValueError("skill path containment failed")
        digest, files, total = sha_tree(p)
        if digest != skill.get("hash"):
            raise ValueError(f"tampered skill {name}")
        if "files" in skill and files != skill["files"]:
            raise ValueError(f"tampered file receipt {name}")
        if "bytes" in skill and total != skill["bytes"]:
            raise ValueError(f"tampered byte receipt {name}")
    return data


def doctor_lines(project_path: Path | None) -> int:
    cat = catalog_root()
    manifest = validate_manifest(read_json(MANIFEST))
    project = parse_project(project_path)
    state = {}
    if (cat / "fetch-state.json").is_file():
        try:
            state = read_json(cat / "fetch-state.json")
        except Exception:
            state = {"state": "tampered"}
    status = state.get("state", "never_fetched")
    current = {}
    if (cat / "current.json").is_file():
        try:
            current = verify_current(read_json(cat / "current.json"))
        except Exception:
            status = "tampered"
    count = (
        len(current.get("skills", [])) if isinstance(current.get("skills"), list) else 0
    )
    generation = current.get("generation", "")
    active_revs = ",".join(
        sorted(
            {
                str(skill.get("revision", ""))
                for skill in current.get("skills", [])
                if isinstance(skill, dict) and skill.get("revision")
            }
        )
    )
    target = ",".join(
        sorted(
            str(repo.get("revision", "")) for repo in manifest["repositories"].values()
        )
    )
    policy_bits = []
    enabled_total = 0
    for repo_key, repo in manifest["repositories"].items():
        mode, wanted = policy_for(project, repo_key, repo)
        enabled_total += len(wanted)
        policy_bits.append(f"{repo_key}:{mode}:{len(wanted)}")
    missing_deps = [
        dep
        for dep in manifest.get("dependencies", {}).get("refresh", [])
        if isinstance(dep, str) and shutil.which(dep) is None
    ]
    own = own_skill_names()
    conflicts = [
        str(skill.get("name"))
        for skill in current.get("skills", [])
        if isinstance(skill, dict) and skill.get("name") in own
    ]
    legacy = []
    for key in ("microsoft_skills", "fabric_skills"):
        block = project.get(key) if isinstance(project.get(key), dict) else {}
        if "source" in block:
            legacy.append(f"{key}.source_ignored")
        if "load_dir" in block:
            legacy.append(f"{key}.load_dir_ignored")
    fetch_health = str(state.get("detail", "ok" if status == "current" else status))
    detail = {
        "target_revisions": target,
        "active_revisions": active_revs,
        "fetch_health": fetch_health,
        "policy": ",".join(policy_bits),
        "enabled_count": enabled_total,
        "missing_deps": ",".join(missing_deps),
        "conflicts": ",".join(conflicts),
        "legacy": ",".join(legacy),
    }
    print(
        "catalog\tmicrosoft-skills\t{status}\t{generation}\t{count}\t{target}\t{detail}".format(
            status=status,
            generation=generation,
            count=count,
            target=target,
            detail=json.dumps(detail, sort_keys=True),
        )
    )
    return 0


def launch_dirs(project_path: Path | None) -> int:
    current = catalog_root() / "current.json"
    if not current.is_file():
        return 0
    try:
        data = verify_current(read_json(current))
    except Exception:
        return 0
    project = parse_project(project_path)
    manifest = validate_manifest(read_json(MANIFEST))
    allowed: set[str] = set()
    repo_modes: dict[str, str] = {}
    for repo_key, repo in manifest["repositories"].items():
        mode, wanted = policy_for(project, repo_key, repo)
        repo_modes[repo_key] = mode
        allowed.update(wanted)
    root = Path(data.get("root", "")).resolve()
    own = own_skill_names()
    for skill in data.get("skills", []):
        name = skill.get("name")
        repo = skill.get("repo")
        if not isinstance(repo, str) or repo_modes.get(repo) == "disabled":
            continue
        if not isinstance(name, str) or name not in allowed:
            continue
        if isinstance(name, str) and name in own:
            continue
        rel = skill.get("path")
        if isinstance(rel, str):
            p = (root / rel).resolve()
            if root not in p.parents:
                continue
            fm = ""
            try:
                text = (p / "SKILL.md").read_text(encoding="utf-8", errors="replace")[
                    :2048
                ]
                for line in text.splitlines():
                    if line.startswith("name:"):
                        fm = line.split(":", 1)[1].strip().strip("'\"")
                        break
            except OSError:
                continue
            if fm and fm in own:
                continue
            if (p / "SKILL.md").is_file():
                print(str(p))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=None)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("refresh")
    sub.add_parser("doctor-lines")
    sub.add_parser("launch-dirs")
    args = parser.parse_args(argv)
    project = args.project or find_project(Path.cwd())
    if args.cmd == "refresh":
        return refresh(project)
    if args.cmd == "doctor-lines":
        return doctor_lines(project)
    if args.cmd == "launch-dirs":
        return launch_dirs(project)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
