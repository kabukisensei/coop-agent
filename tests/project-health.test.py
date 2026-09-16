#!/usr/bin/env python3
"""Regression tests for bounded legacy-project diagnostics and migration."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))
import project_health as health  # noqa: E402


class ProjectHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "project"
        (self.root / ".coop").mkdir(parents=True)
        self.contract = self.root / ".coop" / "project.yml"
        self.skills = Path(self.temp.name) / "bundled"
        (self.skills / "daily-logger").mkdir(parents=True)
        (self.skills / "daily-logger" / "SKILL.md").write_text(
            "---\nname: daily-logger\n---\n", encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def inspect(self):
        return health.inspect_project(self.root, self.skills)

    def test_detects_generated_missing_instruction_skill_reference_and_collision(
        self,
    ) -> None:
        self.contract.write_text(
            "profile:\n  organization: Test\nstandards:\n"
            "  sql: 'docs/standards/sql-standards.md'\n"
            "  dax: docs/standards/dax-standards.md\n",
            encoding="utf-8",
        )
        pi = self.root / ".pi"
        (pi / "skills" / "custom-folder").mkdir(parents=True)
        (pi / "AGENTS.md").write_text(
            "Read docs/standards/sql-standards.md\n", encoding="utf-8"
        )
        (pi / "SYSTEM.md").write_text(
            "See docs\\standards\\dax-standards.md\n", encoding="utf-8"
        )
        (pi / "skills" / "custom-folder" / "SKILL.md").write_text(
            "---\nname: daily-logger\n---\nUse docs/standards/sql-standards.md\n",
            encoding="utf-8",
        )
        root, findings = self.inspect()
        self.assertEqual(root, self.root.resolve())
        codes = [finding.code for finding in findings]
        self.assertEqual(codes.count("legacy_project_standard_override"), 2)
        self.assertEqual(codes.count("missing_project_standard"), 2)
        self.assertEqual(codes.count("legacy_pi_instruction"), 2)
        self.assertEqual(codes.count("legacy_project_skill_reference"), 1)
        self.assertEqual(codes.count("project_skill_collision"), 1)

    def test_case_insensitive_collision_and_nested_legacy_reference(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        skill = self.root / ".pi" / "skills" / "DAILY-LOGGER"
        (skill / "references").mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: ClientLogger\n---\nIntentional body.\n", encoding="utf-8"
        )
        nested = skill / "references" / "legacy.md"
        nested.write_text(
            "Read docs/standards/documentation-standards.md\n", encoding="utf-8"
        )
        _root, findings = self.inspect()
        self.assertTrue(any(f.code == "project_skill_collision" for f in findings))
        self.assertTrue(
            any(
                f.code == "legacy_project_skill_reference"
                and f.path.endswith("references/legacy.md")
                for f in findings
            )
        )

    def test_collision_without_legacy_marker_is_ambiguous_and_read_only(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        local = self.root / ".pi" / "skills" / "daily-logger" / "SKILL.md"
        local.parent.mkdir(parents=True)
        local.write_text(
            "---\nname: client-daily-logger\n---\nIntentional client behavior.\n",
            encoding="utf-8",
        )
        before = local.read_bytes()
        _root, findings = self.inspect()
        collision = [
            finding for finding in findings if finding.code == "project_skill_collision"
        ]
        self.assertEqual(len(collision), 1)
        self.assertFalse(collision[0].generated)
        self.assertEqual(local.read_bytes(), before)
        self.assertFalse(
            any(f.code == "legacy_project_skill_reference" for f in findings)
        )

    def test_simulated_windows_reparse_directories_are_not_inspected(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        pi = self.root / ".pi"
        pi.mkdir()
        (pi / "AGENTS.md").write_text(
            "Read docs/standards/sql-standards.md\n", encoding="utf-8"
        )
        real_check = health._is_link_or_reparse

        def mark_pi_as_reparse(path: Path) -> bool:
            return path == pi or real_check(path)

        with mock.patch.object(
            health, "_is_link_or_reparse", side_effect=mark_pi_as_reparse
        ):
            _root, findings = self.inspect()
        self.assertFalse(any(f.path.startswith(".pi/") for f in findings))

    def test_configured_standard_through_symlink_ancestor_is_rejected(self) -> None:
        actual = self.root / "actual"
        actual.mkdir()
        (actual / "sql.md").write_text("# Standard\n", encoding="utf-8")
        linked = self.root / "linked"
        try:
            linked.symlink_to(actual, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unavailable")
        self.contract.write_text("standards:\n  sql: linked/sql.md\n", encoding="utf-8")

        _root, findings = self.inspect()

        self.assertTrue(
            any(
                finding.code == "missing_project_standard"
                and "symlink or reparse point" in finding.detail
                for finding in findings
            )
        )

    def test_custom_mapping_and_symlinked_known_paths_are_preserved(self) -> None:
        custom = self.root / "client" / "sql.md"
        custom.parent.mkdir()
        custom.write_text("# Client standard\n", encoding="utf-8")
        self.contract.write_text(
            "standards:\n  sql: client/sql.md\n  dax: ../outside.md\ncustom: keep\n",
            encoding="utf-8",
        )
        outside = Path(self.temp.name) / "outside-skill"
        outside.mkdir()
        (outside / "SKILL.md").write_text(
            "docs/standards/sql-standards.md", encoding="utf-8"
        )
        skills = self.root / ".pi" / "skills"
        skills.mkdir(parents=True)
        try:
            (skills / "linked").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unavailable")
        before = self.contract.read_bytes()
        _root, findings = self.inspect()
        self.assertTrue(
            any(
                f.code == "missing_project_standard" and "escapes" in f.detail
                for f in findings
            )
        )
        self.assertFalse(any("linked" in f.path for f in findings))
        rc = health.migrate_project(self.root, True, True, [])
        self.assertEqual(rc, 0)
        self.assertEqual(self.contract.read_bytes(), before)
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

    def test_dry_run_is_immutable_and_apply_archives_before_exact_cleanup(self) -> None:
        original = (
            "profile:\n  organization: Test\n\nstandards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n\n"
            "custom:\n  keep: true\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        self.assertEqual(health.migrate_project(self.root, False, False, []), 0)
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        migrated = self.contract.read_text(encoding="utf-8")
        self.assertNotIn("standards:", migrated)
        self.assertIn("custom:\n  keep: true", migrated)
        archives = list((self.root / ".coop" / "legacy-project-archive").iterdir())
        self.assertEqual(len(archives), 1)
        archived_contract = archives[0] / ".coop" / "project.yml"
        self.assertEqual(archived_contract.read_text(encoding="utf-8"), original)
        manifest = json.loads(
            (archives[0] / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["edits"], ["remove_exact_generated_standards_block"])
        self.assertEqual(manifest["files"][0]["source"], ".coop/project.yml")

        # A second apply is idempotent and creates no second archive.
        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        self.assertEqual(
            len(list((self.root / ".coop" / "legacy-project-archive").iterdir())), 1
        )

    def test_pi_content_moves_only_when_exactly_selected_after_verified_archive(
        self,
    ) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        self.assertTrue(agents.exists())
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

        self.assertEqual(
            health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]), 0
        )
        self.assertFalse(agents.exists())
        archive = next((self.root / ".coop" / "legacy-project-archive").iterdir())
        archived_agents = archive / ".pi" / "AGENTS.md"
        self.assertEqual(
            archived_agents.read_text(encoding="utf-8"),
            "Read docs/standards/sql-standards.md\n",
        )
        manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["files"][0]["sha256"], health._sha256(archived_agents)
        )
        self.assertEqual(
            health.migrate_project(self.root, True, True, [".pi/SYSTEM.md"]), 2
        )

    def test_dry_run_lists_each_generated_pi_candidate_and_exact_archive_action(
        self,
    ) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        reference = self.root / ".pi" / "skills" / "old" / "references" / "legacy.md"
        reference.parent.mkdir(parents=True)
        (reference.parents[1] / "SKILL.md").write_text(
            "---\nname: old\n---\n", encoding="utf-8"
        )
        reference.write_text("Read docs/standards/dax-standards.md\n", encoding="utf-8")
        metacharacter = self.root / ".pi" / "skills" / "old$HOME" / "SKILL.md"
        metacharacter.parent.mkdir(parents=True)
        metacharacter.write_text(
            "Read docs/standards/fabric-standards.md\n", encoding="utf-8"
        )

        output = StringIO()
        with redirect_stdout(output):
            self.assertEqual(health.migrate_project(self.root, False, False, []), 0)

        plan = output.getvalue()
        self.assertIn(
            "preserve .pi/AGENTS.md: positively identified generated legacy .pi content; "
            "available action: --archive .pi/AGENTS.md",
            plan,
        )
        self.assertIn(
            "preserve .pi/skills/old/references/legacy.md: positively identified "
            "generated legacy .pi content; available action: --archive "
            ".pi/skills/old/references/legacy.md",
            plan,
        )
        metacharacter_line = next(
            line
            for line in plan.splitlines()
            if "preserve .pi/skills/old$HOME/SKILL.md:" in line
        )
        action = metacharacter_line.split("available action: ", 1)[1]
        self.assertEqual(
            shlex.split(action), ["--archive", ".pi/skills/old$HOME/SKILL.md"]
        )
        self.assertTrue(agents.exists())
        self.assertTrue(reference.exists())
        self.assertTrue(metacharacter.exists())
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

    def test_archive_action_quoting_is_literal_on_powershell(self) -> None:
        with mock.patch.object(health.os, "name", "nt"):
            self.assertEqual(
                health._quote_cli_argument(".pi/skills/old$`'name\\SKILL.md"),
                "'.pi/skills/old$`''name\\SKILL.md'",
            )

    def test_windows_file_identity_ignores_synthetic_mode_differences(self) -> None:
        first = mock.Mock(st_dev=7, st_ino=11, st_mode=0o100600)
        second = mock.Mock(st_dev=7, st_ino=11, st_mode=0o100666)
        with mock.patch.object(health.os, "name", "nt"):
            self.assertEqual(
                health._stat_identity(first), health._stat_identity(second)
            )
        with mock.patch.object(health.os, "name", "posix"):
            self.assertNotEqual(
                health._stat_identity(first), health._stat_identity(second)
            )

    def test_selecting_nested_skill_reference_archives_complete_skill(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        skill = self.root / ".pi" / "skills" / "old-generated"
        (skill / "references").mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: old-generated\n---\n", encoding="utf-8"
        )
        reference = skill / "references" / "legacy.md"
        reference.write_text("Use docs/standards/sql-standards.md\n", encoding="utf-8")
        asset = skill / "asset.bin"
        asset.write_bytes(b"preserve me")

        self.assertEqual(
            health.migrate_project(
                self.root,
                True,
                True,
                [".pi/skills/old-generated/references/legacy.md"],
            ),
            0,
        )
        self.assertFalse(skill.exists())
        archive = next((self.root / ".coop" / "legacy-project-archive").iterdir())
        archived_skill = archive / ".pi" / "skills" / "old-generated"
        self.assertEqual((archived_skill / "asset.bin").read_bytes(), b"preserve me")
        self.assertEqual(
            (archived_skill / "references" / "legacy.md").read_text(encoding="utf-8"),
            "Use docs/standards/sql-standards.md\n",
        )

    def test_generated_subset_is_diagnosed_but_never_automatically_removed(
        self,
    ) -> None:
        original = "standards:\n  sql: docs/standards/sql-standards.md\n"
        self.contract.write_text(original, encoding="utf-8")
        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

    def test_duplicate_standard_key_never_qualifies_for_automatic_removal(self) -> None:
        original = (
            "standards:\n"
            "  sql: client/custom-sql.md\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

    def test_duplicate_top_level_standards_blocks_are_never_removed(self) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
            "standards:\n"
            "  sql: client/custom-sql.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

    def test_skill_md_is_always_scanned_before_other_text_files(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        skill = self.root / ".pi" / "skills" / "crowded"
        skill.mkdir(parents=True)
        for index in range(health.MAX_SKILL_FILES + 5):
            (skill / f"{index:02d}.md").write_text("ordinary\n", encoding="utf-8")
        (skill / "SKILL.md").write_text(
            "---\nname: crowded\n---\nRead docs/standards/sql-standards.md\n",
            encoding="utf-8",
        )
        _root, findings = self.inspect()
        self.assertTrue(
            any(
                finding.code == "legacy_project_skill_reference"
                and finding.path.endswith("SKILL.md")
                for finding in findings
            )
        )
        self.assertTrue(
            any(finding.code == "project_health_scan_truncated" for finding in findings)
        )

    def test_archive_directory_fanout_fails_without_moving_source(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        skill = self.root / ".pi" / "skills" / "fanout"
        skill.mkdir(parents=True)
        marker = skill / "SKILL.md"
        marker.write_text(
            "---\nname: fanout\n---\nRead docs/standards/sql-standards.md\n",
            encoding="utf-8",
        )
        for index in range(health.MAX_ARCHIVE_DIRS + 1):
            (skill / f"dir-{index:03d}").mkdir()
        self.assertEqual(
            health.migrate_project(
                self.root, True, True, [".pi/skills/fanout/SKILL.md"]
            ),
            2,
        )
        self.assertTrue(marker.exists())

    def test_cumulative_archive_budget_applies_across_all_selected_sources(
        self,
    ) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        pi = self.root / ".pi"
        pi.mkdir()
        agents = pi / "AGENTS.md"
        system = pi / "SYSTEM.md"
        content = "Read docs/standards/sql-standards.md " + ("x" * 35) + "\n"
        agents.write_text(content, encoding="utf-8")
        system.write_text(content, encoding="utf-8")
        self.assertLess(agents.stat().st_size, 100)
        with mock.patch.object(health, "MAX_ARCHIVE_BYTES", 100):
            self.assertEqual(
                health.migrate_project(
                    self.root,
                    True,
                    True,
                    [".pi/AGENTS.md", ".pi/SYSTEM.md"],
                ),
                2,
            )
        self.assertTrue(agents.exists())
        self.assertTrue(system.exists())
        self.assertFalse((self.root / ".coop" / "legacy-project-archive").exists())

    def test_archive_root_swap_before_stamp_creation_fails_closed(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        archive_root = self.root / ".coop" / "legacy-project-archive"
        displaced = self.root / ".coop" / "legacy-project-archive-original"
        external = Path(self.temp.name) / "external-archive"
        external.mkdir()
        real_mkdir = Path.mkdir
        swapped = False

        def swap_root_then_mkdir(path: Path, *args, **kwargs):
            nonlocal swapped
            if not swapped and path.parent == archive_root:
                swapped = True
                archive_root.rename(displaced)
                archive_root.symlink_to(external, target_is_directory=True)
            return real_mkdir(path, *args, **kwargs)

        with mock.patch.object(
            Path, "mkdir", autospec=True, side_effect=swap_root_then_mkdir
        ):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertTrue(agents.exists())
        self.assertFalse(any(external.rglob("AGENTS.md")))
        self.assertFalse(any(external.rglob("manifest.json")))

    def test_archive_growth_during_hashing_exceeds_cumulative_limit(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text(
            "Read docs/standards/sql-standards.md\n" + ("x" * 20),
            encoding="utf-8",
        )
        real_hash = health._bounded_hash
        grew = False

        def grow_before_hash(path: Path, budget: dict[str, int]):
            nonlocal grew
            if not grew and path.name == "AGENTS.md":
                grew = True
                with path.open("ab") as stream:
                    stream.write(b"y" * 100)
            return real_hash(path, budget)

        with (
            mock.patch.object(health, "MAX_ARCHIVE_BYTES", 100),
            mock.patch.object(health, "_bounded_hash", side_effect=grow_before_hash),
        ):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertTrue(agents.exists())
        self.assertFalse(
            (self.root / ".coop" / "legacy-project-archive").exists()
            and any((self.root / ".coop" / "legacy-project-archive").iterdir())
        )

    def test_contract_cleanup_preserves_original_inode_and_permissions(self) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        self.contract.chmod(0o600)
        before = self.contract.stat()
        self.assertEqual(health.migrate_project(self.root, True, True, []), 0)
        after = self.contract.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        if os.name != "nt":
            self.assertEqual(after.st_mode & 0o777, 0o600)
        self.assertNotIn("standards:", self.contract.read_text(encoding="utf-8"))

    def test_failed_contract_replace_rolls_back_sources_and_removes_manifest(
        self,
    ) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")

        failed_once = False

        def fail_contract_install(source, destination):
            nonlocal failed_once
            source_path = Path(source)
            destination_path = Path(destination)
            if (
                not failed_once
                and destination_path == self.contract
                and ".claimed-project" in source_path.name
            ):
                failed_once = True
                raise OSError("injected contract installation failure")
            return real_link(source, destination)

        real_link = health.os.link
        with mock.patch.object(health.os, "link", side_effect=fail_contract_install):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)
        self.assertTrue(agents.exists())
        archive_root = self.root / ".coop" / "legacy-project-archive"
        self.assertFalse(archive_root.exists() and any(archive_root.iterdir()))

    def test_concurrent_contract_creation_at_install_is_never_overwritten(self) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        real_link = health.os.link

        def create_at_install(source, destination):
            if (
                Path(destination) == self.contract
                and ".claimed-project" in Path(source).name
            ):
                self.contract.write_text("concurrent: must-survive\n", encoding="utf-8")
            return real_link(source, destination)

        with mock.patch.object(health.os, "link", side_effect=create_at_install):
            self.assertEqual(health.migrate_project(self.root, True, True, []), 2)
        self.assertEqual(
            self.contract.read_text(encoding="utf-8"), "concurrent: must-survive\n"
        )
        archive = next((self.root / ".coop" / "legacy-project-archive").iterdir())
        self.assertEqual(
            (archive / ".coop" / "project.yml").read_text(encoding="utf-8"),
            original,
        )
        self.assertFalse((archive / "manifest.json").exists())

    def test_manifest_finalize_failure_rolls_back_contract_and_sources(self) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        real_replace = health.os.replace

        def fail_manifest_finalize(source, destination):
            if Path(destination).name == "manifest.json":
                raise OSError("injected manifest finalize failure")
            return real_replace(source, destination)

        with mock.patch.object(
            health.os, "replace", side_effect=fail_manifest_finalize
        ):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)
        self.assertTrue(agents.exists())
        archive_root = self.root / ".coop" / "legacy-project-archive"
        self.assertFalse(archive_root.exists() and any(archive_root.iterdir()))

    def test_mutation_at_manifest_publication_is_detected_and_not_finalized(
        self,
    ) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        real_replace = health.os.replace

        def mutate_at_publication(source, destination):
            result = real_replace(source, destination)
            if Path(destination).name == "manifest.json":
                archive = Path(destination).parent
                with (archive / ".pi" / "AGENTS.md").open("ab") as stream:
                    stream.write(b"concurrent archived mutation\n")
            return result

        with mock.patch.object(health.os, "replace", side_effect=mutate_at_publication):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertTrue(agents.exists())
        self.assertIn(
            "concurrent archived mutation", agents.read_text(encoding="utf-8")
        )
        archive_root = self.root / ".coop" / "legacy-project-archive"
        self.assertFalse(archive_root.exists() and any(archive_root.iterdir()))

    def test_manifest_failure_preserves_concurrent_contract_and_recreated_pi(
        self,
    ) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        real_replace = health.os.replace

        def mutate_then_fail_manifest(source, destination):
            if Path(destination).name == "manifest.json":
                with self.contract.open("a", encoding="utf-8") as stream:
                    stream.write("concurrent: must-survive\n")
                agents.write_text("concurrent replacement\n", encoding="utf-8")
                raise OSError("injected manifest finalize failure")
            return real_replace(source, destination)

        with mock.patch.object(
            health.os, "replace", side_effect=mutate_then_fail_manifest
        ):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertIn(
            "concurrent: must-survive", self.contract.read_text(encoding="utf-8")
        )
        self.assertEqual(agents.read_text(encoding="utf-8"), "concurrent replacement\n")
        archive = next((self.root / ".coop" / "legacy-project-archive").iterdir())
        self.assertEqual(
            (archive / ".pi" / "AGENTS.md").read_text(encoding="utf-8"),
            "Read docs/standards/sql-standards.md\n",
        )
        self.assertFalse((archive / "manifest.json").exists())

    def test_contract_mutation_at_atomic_claim_boundary_is_preserved(self) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        real_replace = health.os.replace

        def mutate_at_claim(source, destination):
            if Path(source) == self.contract:
                self.contract.write_text(
                    original + "concurrent: must-survive\n", encoding="utf-8"
                )
            return real_replace(source, destination)

        with mock.patch.object(health.os, "replace", side_effect=mutate_at_claim):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertTrue(agents.exists(), "selected .pi file must roll back")
        self.assertIn(
            "concurrent: must-survive", self.contract.read_text(encoding="utf-8")
        )

    def test_atomic_pi_archive_keeps_a_last_moment_source_edit(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        agents = self.root / ".pi" / "AGENTS.md"
        agents.parent.mkdir()
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        real_replace = health.os.replace

        def edit_then_replace(source, destination):
            source_path = Path(source)
            if source_path == agents:
                with source_path.open("a", encoding="utf-8") as stream:
                    stream.write("custom concurrent content\n")
            return real_replace(source, destination)

        with mock.patch.object(health.os, "replace", side_effect=edit_then_replace):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                0,
            )
        archive = next((self.root / ".coop" / "legacy-project-archive").iterdir())
        archived = (archive / ".pi" / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("custom concurrent content", archived)

    def test_pi_ancestor_symlink_swap_cannot_archive_external_file(self) -> None:
        self.contract.write_text("profile:\n  organization: Test\n", encoding="utf-8")
        pi = self.root / ".pi"
        pi.mkdir()
        agents = pi / "AGENTS.md"
        agents.write_text("Read docs/standards/sql-standards.md\n", encoding="utf-8")
        original_pi = self.root / ".pi-original"
        external = Path(self.temp.name) / "external-pi"
        external.mkdir()
        external_agents = external / "AGENTS.md"
        external_agents.write_text(
            "Read docs/standards/sql-standards.md\nexternal\n", encoding="utf-8"
        )
        real_replace = health.os.replace
        swapped = False

        def swap_ancestor_then_replace(source, destination):
            nonlocal swapped
            if not swapped and Path(source) == agents:
                swapped = True
                real_replace(pi, original_pi)
                pi.symlink_to(external, target_is_directory=True)
            return real_replace(source, destination)

        with mock.patch.object(
            health.os, "replace", side_effect=swap_ancestor_then_replace
        ):
            self.assertEqual(
                health.migrate_project(self.root, True, True, [".pi/AGENTS.md"]),
                2,
            )
        self.assertTrue((original_pi / "AGENTS.md").exists())
        self.assertTrue(external_agents.exists())
        self.assertIn("external", external_agents.read_text(encoding="utf-8"))

    def test_cli_default_is_dry_run(self) -> None:
        original = (
            "standards:\n"
            "  sql: docs/standards/sql-standards.md\n"
            "  dax: docs/standards/dax-standards.md\n"
            "  documentation: docs/standards/documentation-standards.md\n"
            "  fabric: docs/standards/fabric-standards.md\n"
        )
        self.contract.write_text(original, encoding="utf-8")
        bash = shutil.which("bash")
        self.assertIsNotNone(bash)
        run = subprocess.run(
            [
                str(bash),
                str(ROOT / "bin" / "coop"),
                "init",
                "--migrate-legacy",
                str(self.root),
            ],
            text=True,
            capture_output=True,
            env={**os.environ, "NO_COLOR": "1"},
            check=False,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("Dry run only", run.stdout)
        self.assertEqual(self.contract.read_text(encoding="utf-8"), original)

        # Both public dispatchers expose the same helper and migration flags.
        bash_dispatch = (ROOT / "bin" / "coop").read_text(encoding="utf-8")
        ps_dispatch = (ROOT / "bin" / "coop.ps1").read_text(encoding="utf-8-sig")
        for token in (
            "--migrate-legacy",
            "--apply",
            "--archive",
            "lib/project_health.py",
        ):
            self.assertIn(token, bash_dispatch)
            self.assertIn(token, ps_dispatch)
        self.assertEqual((ROOT / "bin" / "coop.ps1").read_bytes()[:3], b"\xef\xbb\xbf")
        bash_doctor = (ROOT / "scripts" / "doctor.sh").read_text(encoding="utf-8")
        ps_doctor = (ROOT / "scripts" / "doctor.ps1").read_text(encoding="utf-8-sig")
        for token in (
            "project_health.py",
            "doctor-lines",
            "legacy-project diagnostics",
        ):
            self.assertIn(token, bash_doctor)
            self.assertIn(token, ps_doctor)
        self.assertEqual(
            (ROOT / "scripts" / "doctor.ps1").read_bytes()[:3], b"\xef\xbb\xbf"
        )

        pwsh = shutil.which("pwsh")
        if pwsh:
            ps_run = subprocess.run(
                [
                    pwsh,
                    "-NoProfile",
                    "-File",
                    str(ROOT / "bin" / "coop.ps1"),
                    "init",
                    "--migrate-legacy",
                    str(self.root),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(ps_run.returncode, 0, ps_run.stderr)
            self.assertIn("Dry run only", ps_run.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
