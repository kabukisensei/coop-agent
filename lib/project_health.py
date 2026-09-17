#!/usr/bin/env python3
"""Bounded diagnostics and safe migration for legacy Coop project configuration."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

MAX_TEXT_BYTES = 256 * 1024
MAX_SKILLS = 200
MAX_SKILL_FILES = 20
MAX_SKILL_DEPTH = 3
MAX_SKILL_ENTRIES = 200
MAX_SKILL_DIRS = 50
MAX_ARCHIVE_FILES = 500
MAX_ARCHIVE_DIRS = 100
MAX_ARCHIVE_ENTRIES = 1000
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
TEXT_SUFFIXES = {".md", ".txt", ".yml", ".yaml", ".json"}
LEGACY_REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])docs[\\/]standards[\\/][A-Za-z0-9_.-]+-standards\.md\b",
    re.IGNORECASE,
)
GENERATED_STANDARDS = {
    "sql": "docs/standards/sql-standards.md",
    "dax": "docs/standards/dax-standards.md",
    "semantic_model": "docs/standards/semantic-model-standards.md",
    "documentation": "docs/standards/documentation-standards.md",
    "fabric": "docs/standards/fabric-standards.md",
}
GENERATED_SIGNATURES = (
    frozenset({"sql", "dax", "documentation", "fabric"}),
    frozenset(GENERATED_STANDARDS),
)


@dataclass(frozen=True)
class Finding:
    code: str
    path: str
    detail: str
    generated: bool = False


def _strip_yaml_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def _standards_block(text: str) -> tuple[int, int, dict[str, str], bool] | None:
    lines = text.splitlines(keepends=True)
    start = -1
    for index, line in enumerate(lines):
        if re.match(r"^standards:\s*(?:#.*)?(?:\r?\n)?$", line):
            start = index
            break
    if start < 0:
        return None
    top_level_count = sum(
        1 for line in lines if re.match(r"^standards:\s*(?:#.*)?(?:\r?\n)?$", line)
    )
    end = len(lines)
    entries: dict[str, str] = {}
    valid_shape = top_level_count == 1
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.strip() and not line.startswith((" ", "\t", "#")):
            end = index
            break
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*(.*?)\s*(?:\r?\n)?$", line)
        if not match or line.startswith("\t"):
            valid_shape = False
            continue
        key = match.group(1)
        if key in entries:
            valid_shape = False
        entries[key] = _strip_yaml_value(match.group(2))
    return start, end, entries, valid_shape


def _exact_generated(entries: dict[str, str], valid_shape: bool) -> bool:
    return (
        valid_shape
        and frozenset(entries) in GENERATED_SIGNATURES
        and all(
            key in GENERATED_STANDARDS
            and value.replace("\\", "/") == GENERATED_STANDARDS[key]
            for key, value in entries.items()
        )
    )


def _is_link_or_reparse(path: Path) -> bool:
    try:
        metadata = path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return path.is_symlink() or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)


def _is_safe_directory(path: Path) -> bool:
    return not _is_link_or_reparse(path) and path.is_dir()


def _stat_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    # Windows path-stat and handle-stat can report different synthetic mode bits
    # for the same file. File identity there is the volume/device + file index;
    # POSIX also pins mode so replacement/permission changes fail closed.
    mode = 0 if os.name == "nt" else metadata.st_mode
    return metadata.st_dev, metadata.st_ino, mode


def _binary_read_flags() -> int:
    return os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)


def _file_handle_identity(path: Path) -> tuple[int, int, int]:
    if _is_link_or_reparse(path):
        raise OSError(f"unsafe file identity path: {path}")
    descriptor = os.open(path, _binary_read_flags())
    try:
        identity = _stat_identity(os.fstat(descriptor))
    finally:
        os.close(descriptor)
    if _is_link_or_reparse(path):
        raise OSError(f"unsafe file identity path: {path}")
    return identity


def _bounded_children(directory: Path, limit: int) -> tuple[list[Path], bool]:
    children: list[Path] = []
    if not _is_safe_directory(directory):
        return [], False
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(children) >= limit:
                    return sorted(children, key=lambda path: path.name), True
                children.append(Path(entry.path))
    except OSError:
        return [], False
    return sorted(children, key=lambda path: path.name), False


def _read_capped(path: Path, limit: int) -> bytes:
    metadata = path.stat(follow_symlinks=False)
    is_reparse_point = bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
    if path.is_symlink() or is_reparse_point or not path.is_file():
        raise ValueError(f"cannot read unsafe file: {path}")
    descriptor = os.open(path, _binary_read_flags())
    chunks: list[bytes] = []
    size = 0
    try:
        before = os.fstat(descriptor)
        expected_identity = _stat_identity(before)
        while True:
            remaining = limit - size
            chunk = os.read(descriptor, min(128 * 1024, max(1, remaining + 1)))
            if not chunk:
                break
            if len(chunk) > remaining:
                raise ValueError(f"file exceeds {limit} byte safety limit: {path}")
            chunks.append(chunk)
            size += len(chunk)
        after = os.fstat(descriptor)
        if _stat_identity(after) != expected_identity or after.st_size != size:
            raise OSError(f"file changed while reading: {path}")
    finally:
        os.close(descriptor)
    if _file_handle_identity(path) != expected_identity:
        raise OSError(f"file identity changed after reading: {path}")
    return b"".join(chunks)


def _safe_read(path: Path) -> str | None:
    try:
        return _read_capped(path, MAX_TEXT_BYTES).decode("utf-8-sig")
    except (OSError, UnicodeError, ValueError):
        return None


def _relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def find_project_root(target: Path) -> Path | None:
    """Find the nearest real project contract without following a contract symlink."""
    current = target.expanduser().resolve()
    if current.is_file():
        current = current.parent
    while True:
        coop_dir = current / ".coop"
        contract = coop_dir / "project.yml"
        if (
            contract.exists()
            and _is_safe_directory(coop_dir)
            and not _is_link_or_reparse(contract)
            and contract.is_file()
        ):
            return current
        if current.parent == current:
            return None
        current = current.parent


def _path_is_safe_file(root: Path, configured: str) -> tuple[Path | None, str]:
    raw = Path(configured).expanduser()
    candidate = raw if raw.is_absolute() else root / raw
    try:
        # Inspect the configured lexical path before resolve() can collapse a
        # symlink or Windows junction ancestor out of the component chain.
        lexical = Path(os.path.abspath(candidate))
        relative = lexical.relative_to(root)
        cursor = root
        for part in relative.parts:
            cursor = cursor / part
            if _is_link_or_reparse(cursor):
                return None, "path traverses a symlink or reparse point"
        normalized = lexical.resolve(strict=False)
        normalized.relative_to(root)
    except (OSError, ValueError):
        return None, "path escapes the project root"
    if not normalized.is_file():
        return None, "path is missing or is not a file"
    return normalized, ""


def _bundled_skill_names(skills_dir: Path | None) -> set[str]:
    names: set[str] = set()
    if not skills_dir or not _is_safe_directory(skills_dir):
        return names
    children, _truncated = _bounded_children(skills_dir, MAX_SKILLS)
    for child in children:
        if not _is_safe_directory(child) or child.name.startswith("_"):
            continue
        names.add(child.name.casefold())
        text = _safe_read(child / "SKILL.md")
        if text:
            match = re.search(r"(?m)^name:\s*['\"]?([^'\"\s#]+)", text[:8192])
            if match:
                names.add(match.group(1).casefold())
    return names


def _bounded_skill_files(skill: Path) -> tuple[list[Path], bool]:
    """Return bounded, contained text files without following directory links."""
    files: list[Path] = []
    skill_md = skill / "SKILL.md"
    if skill_md.exists() and not skill_md.is_symlink() and skill_md.is_file():
        files.append(skill_md)
    pending: list[tuple[Path, int]] = [(skill, 0)]
    entries_seen = 0
    directories_seen = 0
    truncated = False
    while pending and len(files) < MAX_SKILL_FILES:
        directory, depth = pending.pop(0)
        directories_seen += 1
        if directories_seen > MAX_SKILL_DIRS:
            truncated = True
            break
        remaining = MAX_SKILL_ENTRIES - entries_seen
        if remaining <= 0:
            truncated = True
            break
        children, capped = _bounded_children(directory, remaining)
        truncated = truncated or capped
        entries_seen += len(children)
        for child in children:
            if child == skill_md:
                continue
            if _is_link_or_reparse(child):
                continue
            if child.is_file() and child.suffix.lower() in TEXT_SUFFIXES:
                files.append(child)
                if len(files) >= MAX_SKILL_FILES:
                    truncated = True
                    break
            elif _is_safe_directory(child) and depth < MAX_SKILL_DEPTH:
                pending.append((child, depth + 1))
            elif _is_safe_directory(child):
                truncated = True
    if pending:
        truncated = True
    return files, truncated


def inspect_project(
    target: Path, skills_dir: Path | None = None
) -> tuple[Path | None, list[Finding]]:
    root = find_project_root(target)
    if root is None:
        return None, []
    findings: list[Finding] = []
    contract = root / ".coop" / "project.yml"
    text = _safe_read(contract) or ""
    block = _standards_block(text)
    if block:
        _start, _end, entries, valid_shape = block
        exact = _exact_generated(entries, valid_shape)
        for key, value in entries.items():
            path = ".coop/project.yml"
            if (
                key in GENERATED_STANDARDS
                and value.replace("\\", "/") == GENERATED_STANDARDS[key]
            ):
                findings.append(
                    Finding(
                        "legacy_project_standard_override",
                        path,
                        f"standards.{key} -> {value}",
                        exact,
                    )
                )
            safe_file, reason = _path_is_safe_file(root, value)
            if safe_file is None:
                findings.append(
                    Finding(
                        "missing_project_standard",
                        path,
                        f"standards.{key} -> {value}: {reason}",
                    )
                )

    pi_dir = root / ".pi"
    if pi_dir.exists() and not _is_safe_directory(pi_dir):
        return root, findings
    for name in ("AGENTS.md", "SYSTEM.md"):
        path = pi_dir / name
        content = _safe_read(path)
        if content and LEGACY_REFERENCE_RE.search(content):
            findings.append(
                Finding(
                    "legacy_pi_instruction",
                    _relative(root, path),
                    "references docs/standards/*",
                    True,
                )
            )

    bundled = _bundled_skill_names(skills_dir)
    skills = pi_dir / "skills"
    if _is_safe_directory(skills):
        children, skills_truncated = _bounded_children(skills, MAX_SKILLS)
        if skills_truncated:
            findings.append(
                Finding(
                    "project_health_scan_truncated",
                    ".pi/skills",
                    f"more than {MAX_SKILLS} project skill entries; review remaining entries manually",
                )
            )
        for skill in children:
            if not _is_safe_directory(skill):
                continue
            frontmatter_name = ""
            skill_md = _safe_read(skill / "SKILL.md")
            if skill_md:
                match = re.search(r"(?m)^name:\s*['\"]?([^'\"\s#]+)", skill_md[:8192])
                if match:
                    frontmatter_name = match.group(1)
            local_names = {skill.name, frontmatter_name} - {""}
            collisions = sorted(
                name for name in local_names if name.casefold() in bundled
            )
            if collisions:
                findings.append(
                    Finding(
                        "project_skill_collision",
                        _relative(root, skill),
                        f"collides with bundled skill name(s): {', '.join(collisions)}",
                    )
                )
            referenced = False
            skill_files, skill_truncated = _bounded_skill_files(skill)
            if skill_truncated:
                findings.append(
                    Finding(
                        "project_health_scan_truncated",
                        _relative(root, skill),
                        "bounded skill scan reached its file, entry, directory, or depth limit",
                    )
                )
            for child in skill_files:
                content = _safe_read(child)
                if content and LEGACY_REFERENCE_RE.search(content):
                    referenced = True
                    findings.append(
                        Finding(
                            "legacy_project_skill_reference",
                            _relative(root, child),
                            "references docs/standards/*",
                            True,
                        )
                    )
            # A collision alone never proves generated or obsolete content.
            if referenced:
                continue
    return root, findings


def _remove_exact_standards(text: str) -> str:
    block = _standards_block(text)
    if not block or not _exact_generated(block[2], block[3]):
        return text
    lines = text.splitlines(keepends=True)
    start, end = block[0], block[1]
    # Include one immediately preceding scaffold heading and collapse one blank.
    if start > 0 and re.match(r"^# --- Standards ", lines[start - 1]):
        start -= 1
    del lines[start:end]
    while (
        start < len(lines) - 1
        and not lines[start].strip()
        and not lines[start + 1].strip()
    ):
        del lines[start]
    return "".join(lines)


def _quote_cli_argument(value: str) -> str:
    if os.name == "nt":
        # PowerShell single-quoted strings are literal; embedded quotes double.
        return "'" + value.replace("'", "''") + "'"
    return shlex.quote(value)


def _archive_candidates(findings: list[Finding]) -> list[str]:
    return sorted(
        {
            finding.path
            for finding in findings
            if finding.generated
            and finding.code
            in {"legacy_pi_instruction", "legacy_project_skill_reference"}
        }
    )


def _selected_archives(
    root: Path, findings: list[Finding], selections: list[str]
) -> list[Path]:
    allowed = set(_archive_candidates(findings))
    selected: list[Path] = []
    for raw in selections:
        normalized = raw.replace("\\", "/")
        if normalized.startswith("./"):
            normalized = normalized[2:]
        if normalized not in allowed:
            raise ValueError(
                f"cannot archive {raw!r}: select an exact positively identified legacy .pi file"
            )
        path = root / normalized
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
        if _is_link_or_reparse(path) or not path.is_file():
            raise ValueError(f"cannot archive unsafe path: {raw}")
        parts = Path(normalized).parts
        if len(parts) >= 4 and parts[:2] == (".pi", "skills"):
            path = root / ".pi" / "skills" / parts[2]
            if not _is_safe_directory(path):
                raise ValueError(f"cannot archive unsafe skill directory: {raw}")
        selected.append(path)
    return list(dict.fromkeys(selected))


def _archive_entries(source: Path, budget: dict[str, int] | None = None) -> list[Path]:
    counters = (
        budget
        if budget is not None
        else {
            "files": 0,
            "directories": 0,
            "entries": 0,
            "bytes": 0,
        }
    )
    if _is_link_or_reparse(source):
        raise ValueError(f"cannot archive symlink or reparse point: {source}")
    if source.is_file():
        counters["files"] += 1
        counters["entries"] += 1
        counters["bytes"] += source.stat().st_size
        if (
            counters["files"] > MAX_ARCHIVE_FILES
            or counters["entries"] > MAX_ARCHIVE_ENTRIES
            or counters["bytes"] > MAX_ARCHIVE_BYTES
        ):
            raise ValueError("selected legacy archive exceeds cumulative safety limits")
        return [source]
    if not _is_safe_directory(source):
        raise ValueError(f"cannot archive non-file or unsafe directory: {source}")
    files: list[Path] = []
    pending = [source]
    while pending:
        directory = pending.pop(0)
        counters["directories"] += 1
        if counters["directories"] > MAX_ARCHIVE_DIRS:
            raise ValueError("selected legacy archive exceeds directory safety limit")
        remaining = MAX_ARCHIVE_ENTRIES - counters["entries"]
        if remaining <= 0:
            raise ValueError("selected legacy archive exceeds entry safety limit")
        children, capped = _bounded_children(directory, remaining)
        if capped:
            raise ValueError("selected legacy archive exceeds entry safety limit")
        counters["entries"] += len(children)
        for path in children:
            if _is_link_or_reparse(path):
                raise ValueError(
                    f"cannot archive skill containing symlink or reparse point: {path}"
                )
            if _is_safe_directory(path):
                pending.append(path)
                continue
            if not path.is_file():
                raise ValueError(f"cannot archive unsafe skill entry: {path}")
            files.append(path)
            counters["files"] += 1
            counters["bytes"] += path.stat().st_size
            if (
                counters["files"] > MAX_ARCHIVE_FILES
                or counters["bytes"] > MAX_ARCHIVE_BYTES
            ):
                raise ValueError(
                    "selected legacy archive exceeds cumulative safety limits"
                )
    return sorted(files, key=lambda path: path.as_posix())


def _path_identity(path: Path) -> tuple[int, int, int]:
    metadata = path.stat(follow_symlinks=False)
    is_reparse_point = bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
    if path.is_symlink() or is_reparse_point:
        raise ValueError(f"cannot migrate symlink or reparse point: {path}")
    return _stat_identity(metadata)


def _require_identity(path: Path, expected: tuple[int, int, int]) -> None:
    if _path_identity(path) != expected:
        raise OSError(f"path identity changed during migration: {path}")


def _sha256(path: Path) -> str:
    return _bounded_hash(path, {"bytes": 0})[0]


def _safe_snapshot(path: Path) -> tuple[str, str] | None:
    try:
        raw = _read_capped(path, MAX_TEXT_BYTES)
        return raw.decode("utf-8-sig"), hashlib.sha256(raw).hexdigest()
    except (OSError, UnicodeError, ValueError):
        return None


def _write_fsynced(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _rewrite_existing_fsynced(path: Path, content: bytes) -> None:
    with path.open("r+b") as stream:
        stream.seek(0)
        stream.write(content)
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())


def _copy_fsynced(
    source: Path, destination: Path, limit: int = MAX_ARCHIVE_BYTES
) -> None:
    content = _read_capped(source, limit)
    with destination.open("xb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    shutil.copystat(source, destination, follow_symlinks=False)


def _bounded_hash(path: Path, budget: dict[str, int]) -> tuple[str, int]:
    if _is_link_or_reparse(path) or not path.is_file():
        raise OSError(f"cannot hash unsafe file: {path}")
    descriptor = os.open(path, _binary_read_flags())
    digest = hashlib.sha256()
    size = 0
    try:
        before = os.fstat(descriptor)
        before_identity = _stat_identity(before)
        while True:
            remaining = MAX_ARCHIVE_BYTES - budget["bytes"]
            chunk = os.read(descriptor, min(128 * 1024, max(1, remaining + 1)))
            if not chunk:
                break
            if len(chunk) > remaining:
                raise ValueError(
                    "selected legacy archive exceeds cumulative safety limits"
                )
            digest.update(chunk)
            size += len(chunk)
            budget["bytes"] += len(chunk)
        after = os.fstat(descriptor)
        after_identity = _stat_identity(after)
        if after_identity != before_identity or after.st_size != size:
            raise OSError(f"archived file changed while hashing: {path}")
    finally:
        os.close(descriptor)
    if _file_handle_identity(path) != before_identity:
        raise OSError(f"file identity changed after hashing: {path}")
    return digest.hexdigest(), size


def _verify_manifest_files(archive: Path, records: list[dict[str, str | int]]) -> None:
    budget = {"bytes": 0}
    for record in records:
        archived_path = archive / str(record["archive"])
        digest, size = _bounded_hash(archived_path, budget)
        if digest != record["sha256"] or size != record["bytes"]:
            raise OSError(
                f"archived file changed before manifest finalization: {archived_path}"
            )


def migrate_project(
    target: Path, apply: bool, assume_yes: bool, selections: list[str]
) -> int:
    root, findings = inspect_project(
        target, Path(__file__).resolve().parent.parent / "skills"
    )
    if root is None:
        print("No .coop/project.yml found at or above the target.", file=sys.stderr)
        return 2
    contract = root / ".coop" / "project.yml"
    snapshot = _safe_snapshot(contract)
    if snapshot is None:
        print("Project contract is not a safe readable file.", file=sys.stderr)
        return 2
    original, original_contract_hash = snapshot
    try:
        original_contract_identity = _path_identity(contract)
        contract_parent_identity = _path_identity(contract.parent)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    updated = _remove_exact_standards(original)
    removes_standards = updated != original
    try:
        archive_files = _selected_archives(root, findings, selections)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print(f"Legacy project migration plan for {root}")
    print(
        f"  {'remove' if removes_standards else 'preserve'} .coop/project.yml standards block"
        + (
            " (exact generated mappings)"
            if removes_standards
            else " (absent, customized, or ambiguous)"
        )
    )
    for path in archive_files:
        print(
            f"  archive {_relative(root, path)} "
            "(remove original only after verified archive)"
        )
    if not apply:
        for candidate in _archive_candidates(findings):
            print(
                f"  preserve {candidate}: positively identified generated legacy .pi content; "
                f"available action: --archive {_quote_cli_argument(candidate)}"
            )
    ambiguous = [
        f for f in findings if not f.generated or f.code == "project_skill_collision"
    ]
    for finding in ambiguous:
        print(f"  preserve {finding.path}: {finding.code} ({finding.detail})")
    if not apply:
        print(
            "Dry run only; no files changed. Re-run with --apply and confirm to proceed."
        )
        return 0
    if not removes_standards and not archive_files:
        print("Nothing safe was selected for migration; no archive created.")
        return 0
    if not assume_yes:
        sys.stderr.write("Apply this plan? [y/N] ")
        answer = sys.stdin.readline().strip().lower()
        if answer not in {"y", "yes"}:
            print("Migration cancelled; no files changed.")
            return 1

    budget = {"files": 0, "directories": 0, "entries": 0, "bytes": 0}
    source_identities: dict[Path, tuple[int, int, int]] = {}
    try:
        if removes_standards:
            _archive_entries(contract, budget)
        for source in archive_files:
            _archive_entries(source, budget)
            source_identities[source] = _path_identity(source)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    archive_root = root / ".coop" / "legacy-project-archive"
    archive = archive_root / stamp
    try:
        _require_identity(contract.parent, contract_parent_identity)
        if archive_root.exists():
            if not _is_safe_directory(archive_root):
                raise ValueError(f"unsafe archive root: {archive_root}")
        else:
            # Never create this with parents=True: .coop is already pinned, and
            # an injected symlink/junction must make creation fail closed.
            archive_root.mkdir()
        _require_identity(contract.parent, contract_parent_identity)
        archive_root_identity = _path_identity(archive_root)
        if archive.exists():
            raise FileExistsError(f"archive already exists: {archive}")
        archive.mkdir()
        _require_identity(contract.parent, contract_parent_identity)
        _require_identity(archive_root, archive_root_identity)
        archive_identity = _path_identity(archive)
        resolved_archive = archive.resolve(strict=True)
        resolved_archive.relative_to(root.resolve(strict=True))
        if resolved_archive.parent != archive_root.resolve(strict=True):
            raise ValueError(f"archive escaped its pinned root: {archive}")
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    copied: list[dict[str, str | int]] = []
    moved: list[tuple[Path, Path]] = []
    pending_manifest: Path | None = None
    manifest_path = archive / "manifest.json"
    manifest_published = False
    claimed_contract = archive / ".coop" / ".claimed-project.yml"
    archived_contract = archive / ".coop" / "project.yml"
    contract_claimed = False
    contract_rewritten = False
    contract_installed = False
    updated_bytes = updated.encode("utf-8")
    updated_hash = hashlib.sha256(updated_bytes).hexdigest()
    archived_budget = {"files": 0, "directories": 0, "entries": 0, "bytes": 0}
    hash_budget = {"bytes": 0}
    try:
        # Explicitly selected .pi entries move atomically into the same-project
        # archive. The post-move identity check catches an ancestor replacement
        # race and rolls the moved entry back instead of accepting another file.
        for source in archive_files:
            destination = archive / source.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise FileExistsError(destination)
            _require_identity(archive, archive_identity)
            os.replace(source, destination)
            moved.append((source, destination))
            _require_identity(archive, archive_identity)
            if _path_identity(destination) != source_identities[source]:
                raise OSError(
                    f"selected source identity changed during migration: {source}"
                )
            for archived_file in _archive_entries(destination, archived_budget):
                file_rel = archived_file.relative_to(archive)
                file_hash, file_size = _bounded_hash(archived_file, hash_budget)
                copied.append(
                    {
                        "source": file_rel.as_posix(),
                        "archive": file_rel.as_posix(),
                        "sha256": file_hash,
                        "bytes": file_size,
                    }
                )

        if removes_standards:
            claimed_contract.parent.mkdir(parents=True, exist_ok=True)
            # Claim the live contract by atomically moving its exact inode into
            # the archive. A change at this boundary changes its hash/identity
            # and is restored rather than overwritten.
            _require_identity(archive, archive_identity)
            _require_identity(contract.parent, contract_parent_identity)
            os.replace(contract, claimed_contract)
            contract_claimed = True
            _require_identity(archive, archive_identity)
            _require_identity(contract.parent, contract_parent_identity)
            if _path_identity(claimed_contract) != original_contract_identity:
                raise OSError("project contract identity changed during migration")
            claim_hash, _claim_size = _bounded_hash(claimed_contract, {"bytes": 0})
            if claim_hash != original_contract_hash:
                raise OSError("project contract changed during migration")

            # Preserve the exact original bytes in a distinct archive inode, then
            # rewrite the claimed original inode so its mode and NTFS ACL identity
            # remain attached to the live contract.
            _copy_fsynced(claimed_contract, archived_contract, MAX_TEXT_BYTES)
            _archive_entries(archived_contract, archived_budget)
            archive_hash, archive_size = _bounded_hash(archived_contract, hash_budget)
            if archive_hash != original_contract_hash:
                raise OSError("archive verification failed for .coop/project.yml")
            copied.insert(
                0,
                {
                    "source": ".coop/project.yml",
                    "archive": ".coop/project.yml",
                    "sha256": archive_hash,
                    "bytes": archive_size,
                },
            )
            _rewrite_existing_fsynced(claimed_contract, updated_bytes)
            contract_rewritten = True
            if _path_identity(claimed_contract) != original_contract_identity:
                raise OSError("project contract identity changed while rewriting")
            rewritten_hash, _rewritten_size = _bounded_hash(
                claimed_contract, {"bytes": 0}
            )
            if rewritten_hash != updated_hash:
                raise OSError("rewritten project contract failed verification")

            # A hard link is an atomic create-without-overwrite on both NTFS and
            # POSIX filesystems. If a concurrent writer recreates project.yml,
            # installation fails without replacing that writer's bytes.
            _require_identity(contract.parent, contract_parent_identity)
            os.link(claimed_contract, contract)
            contract_installed = True
            _require_identity(contract.parent, contract_parent_identity)
            claimed_contract.unlink()

        manifest = {
            "schema_version": 1,
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "project_root": str(root),
            "files": copied,
            "edits": ["remove_exact_generated_standards_block"]
            if removes_standards
            else [],
        }
        pending_manifest = archive / ".manifest.pending"
        _require_identity(archive, archive_identity)
        _write_fsynced(pending_manifest, json.dumps(manifest, indent=2) + "\n")
        _require_identity(archive, archive_identity)
        _verify_manifest_files(archive, copied)
        _require_identity(archive, archive_identity)
        os.replace(pending_manifest, manifest_path)
        manifest_published = True
        pending_manifest = None
        _require_identity(archive, archive_identity)
        # Catch mutations injected at publication itself; a failed post-publish
        # check removes/quarantines the final manifest before rollback.
        _verify_manifest_files(archive, copied)
        _require_identity(archive, archive_identity)
    except Exception as exc:
        rollback_errors: list[str] = []
        if manifest_published and manifest_path.exists():
            try:
                os.replace(manifest_path, archive / ".manifest.invalid")
                manifest_published = False
            except OSError as rollback_error:
                rollback_errors.append(
                    f"could not quarantine invalid manifest: {rollback_error}"
                )

        def restore_original_inode(path: Path) -> None:
            current_hash = _sha256(path)
            if current_hash != original_contract_hash:
                if not archived_contract.is_file():
                    raise OSError("archived original contract is unavailable")
                archived_bytes = _read_capped(archived_contract, MAX_TEXT_BYTES)
                if hashlib.sha256(archived_bytes).hexdigest() != original_contract_hash:
                    raise OSError(
                        "archived original contract failed rollback verification"
                    )
                _rewrite_existing_fsynced(path, archived_bytes)
            if (
                _path_identity(path) != original_contract_identity
                or _sha256(path) != original_contract_hash
            ):
                raise OSError(
                    "restored contract failed identity or content verification"
                )

        if contract_installed:
            failed_current = archive / ".coop" / "failed-current-project.yml"
            try:
                if not contract.exists():
                    rollback_errors.append(
                        "live contract disappeared during rollback; archived original retained"
                    )
                else:
                    os.replace(contract, failed_current)
                    if _sha256(failed_current) == updated_hash:
                        restore_original_inode(failed_current)
                        os.link(failed_current, contract)
                        failed_current.unlink()
                    else:
                        os.link(failed_current, contract)
                        rollback_errors.append(
                            "live contract changed concurrently; current and original bytes retained"
                        )
            except (OSError, ValueError) as rollback_error:
                rollback_errors.append(str(rollback_error))
        elif contract_claimed:
            try:
                if contract.exists():
                    rollback_errors.append(
                        "contract path was recreated concurrently; archived original retained"
                    )
                elif not claimed_contract.exists():
                    rollback_errors.append("claimed original contract is unavailable")
                else:
                    if contract_rewritten:
                        restore_original_inode(claimed_contract)
                    os.link(claimed_contract, contract)
                    claimed_contract.unlink()
            except (OSError, ValueError) as rollback_error:
                rollback_errors.append(str(rollback_error))
        for source, destination in reversed(moved):
            try:
                if source.exists():
                    if destination.exists():
                        rollback_errors.append(
                            f"source was recreated concurrently; archived original retained: {source}"
                        )
                elif destination.exists():
                    source.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(destination, source)
                else:
                    rollback_errors.append(
                        f"selected source and archived copy are both unavailable: {source}"
                    )
            except OSError as rollback_error:
                rollback_errors.append(str(rollback_error))
        if not rollback_errors:
            try:
                _require_identity(archive, archive_identity)
                shutil.rmtree(archive)
            except (OSError, ValueError) as rollback_error:
                rollback_errors.append(str(rollback_error))
        if rollback_errors:
            print(
                f"Migration failed; rollback incomplete: {exc}; "
                f"retained archive {archive}; issues: {'; '.join(rollback_errors)}",
                file=sys.stderr,
            )
        else:
            print(f"Migration failed and was rolled back: {exc}", file=sys.stderr)
        return 2
    print(f"Archive created: {archive}")
    if removes_standards:
        print(
            "Removed exact generated legacy standards block; canonical standards now apply."
        )
    return 0


def _human_report(root: Path | None, findings: list[Finding]) -> None:
    if root is None:
        print("No project contract found.")
        return
    if not findings:
        print(f"No legacy project configuration findings in {root}.")
        return
    for finding in findings:
        label = "generated legacy" if finding.generated else "review"
        print(f"[{finding.code}] {finding.path}: {finding.detail} ({label})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_parser = sub.add_parser("inspect")
    inspect_parser.add_argument("target", nargs="?", default=".")
    inspect_parser.add_argument("--skills-dir")
    inspect_parser.add_argument("--json", action="store_true")
    doctor_parser = sub.add_parser("doctor-lines")
    doctor_parser.add_argument("target", nargs="?", default=".")
    doctor_parser.add_argument("--skills-dir")
    migrate_parser = sub.add_parser("migrate")
    migrate_parser.add_argument("target", nargs="?", default=".")
    migrate_parser.add_argument("--apply", action="store_true")
    migrate_parser.add_argument("--yes", action="store_true")
    migrate_parser.add_argument("--archive", action="append", default=[])
    args = parser.parse_args(argv)

    skills_dir = Path(args.skills_dir) if getattr(args, "skills_dir", None) else None
    if args.command == "migrate":
        return migrate_project(Path(args.target), args.apply, args.yes, args.archive)
    root, findings = inspect_project(Path(args.target), skills_dir)
    if args.command == "doctor-lines":
        for finding in findings:
            hint = "Run: coop init --migrate-legacy (dry run first). Project-local configuration shadows canonical behavior."
            print(f"{finding.code}\t{finding.path}: {finding.detail}\t{hint}")
        return 0
    if args.json:
        print(
            json.dumps(
                {
                    "project_root": str(root) if root else None,
                    "findings": [asdict(f) for f in findings],
                },
                separators=(",", ":"),
            )
        )
    else:
        _human_report(root, findings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
