"""Boundary tests; optional real pinned-package tests use an explicit E: Python."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB))
from beta_data_doc import checked_config, selected_config
from beta_paths import beta_workspace_path, beta_workspace_tree
from init_wizard import run_lineage_setup


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        # Retain failed/successful scratch evidence; no recursive teardown.
        self.scratch = Path(tempfile.mkdtemp(prefix="coop-beta-data-doc-"))
        self.root = self.scratch / "Beta Ω"
        self.work = self.root / "workspaces"
        self.project = self.work / "Project Ω"
        self.project.mkdir(parents=True)
        self.config = self.project / "coop-data-doc.yml"
        self.data = {"project_name": "Synthetic Ω", "repos": {}}
        self.config.write_text(json.dumps(self.data), encoding="utf-8")
        self.old = dict(os.environ)
        os.environ.update(COOP_CHANNEL="beta", COOP_BETA_ROOT=str(self.root))
        os.environ.pop("COOP_DATA_DOC_CONFIG", None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)

    def test_discovery_stops_at_workspace(self):
        child = self.project / "child"
        child.mkdir()
        self.assertEqual(selected_config(None, child), self.config)
        self.config.rename(self.project / "saved.json")
        (self.root / "coop-data-doc.yml").write_text("preserve", encoding="utf-8")
        with self.assertRaises(ValueError):
            selected_config(None, child)

    def test_guided_lineage_uses_selected_vector_and_stops_on_failure(self):
        command = [str(self.root / "private-python.exe"), "-I", "-B", "-X", "utf8",
                   str(LIB / "beta_data_doc.py"), "1.2.0"]
        os.environ["COOP_DATA_DOC_BIN"] = "must-not-run"
        os.environ["COOP_BETA_DATA_DOC_COMMAND"] = '["must-not-run"]'
        seeded = subprocess.CompletedProcess([], 0, '{"repos":{}}', '')
        with patch("init_wizard.subprocess.run", side_effect=[seeded,
                subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 130)]) as run:
            self.assertEqual(run_lineage_setup(self.project, command), 130)
            helper, config, setup = run.call_args_list
            self.assertEqual(helper.args[0][1:5], ["-I", "-B", "-X", "utf8"])
            self.assertEqual(helper.kwargs["cwd"], self.project)
            self.assertEqual(config.args[0], [*command, "config-set", "--config",
                str(self.config), "--from-json", "-"])
            self.assertEqual(config.kwargs["input"], seeded.stdout)
            self.assertEqual(config.kwargs["encoding"], "utf-8")
            self.assertEqual(setup.args[0], [*command, "setup"])
        for results in ([subprocess.CompletedProcess([], 3, '', '')],
                [seeded, subprocess.CompletedProcess([], 1)]):
            with patch("init_wizard.subprocess.run", side_effect=results) as run:
                self.assertNotEqual(run_lineage_setup(self.project, command), 0)
                self.assertEqual(run.call_count, len(results))
        with patch("init_wizard.subprocess.run") as run:
            self.assertEqual(run_lineage_setup(self.project), 1)
            run.assert_not_called()

    def test_explicit_and_environment_scope(self):
        outside = str(self.scratch / "outside.yml")
        with self.assertRaises(ValueError):
            selected_config(outside, self.project)
        os.environ["COOP_DATA_DOC_CONFIG"] = outside
        with self.assertRaises(ValueError):
            selected_config(None, self.project)
        self.assertEqual(selected_config(str(self.config), self.project), self.config)

    def test_configuration_paths_and_globs(self):
        checked_config(self.data, self.config)
        cases = [
            {"repos": {"sql": {"path": str(self.scratch)}}},
            {"repos": {"sql": {"path": ".", "include": ["../*.sql"]}}},
            {"repos": {"sql": {"path": ".", "exclude": ["C:*.sql"]}}},
            {"output": {"dir": "../../.."}},
            {"output": {"site_dir": "."}},
            {"branding": {"logo": str(self.scratch / "logo.png")}},
            {"branding": {"favicon": "https://example.invalid/icon.png"}},
            {"reviews": [str(self.scratch / "review.json")]},
        ]
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaises((ValueError, TypeError)):
                checked_config({**self.data, **fields}, self.config)

    def test_unambiguous_paths(self):
        values = ["~", "../..", "bad\nname"]
        if sys.platform == "win32":
            values.extend(["NUL", "con.txt", "file:stream", "trailing.", "trailing "])
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                beta_workspace_path(value, self.project)
        self.assertEqual(beta_workspace_path("new Ω", self.project), self.project / "new Ω")

    def test_hardlink_alias_refused(self):
        alias = self.scratch / "external-alias.json"
        os.link(self.config, alias)
        self.assertGreater(self.config.stat().st_nlink, 1)
        original = alias.read_bytes()
        with self.assertRaises(ValueError):
            beta_workspace_path(self.config, self.project)
        with self.assertRaises(ValueError):
            beta_workspace_tree(self.project, self.project)
        self.assertEqual(alias.read_bytes(), original)

    def test_seed_contract_scope_and_classification(self):
        contract = self.project / ".coop" / "project.yml"
        contract.parent.mkdir()
        def seed(text):
            contract.write_text(text, encoding="utf-8")
            before = contract.read_bytes()
            result = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(LIB / "_seeddocs.py"), str(contract)],
                cwd=self.project, env=os.environ, capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(contract.read_bytes(), before)
            return result
        result = seed("repositories:\n  combined:\n    role: mixed\n    local_path: source Ω\n    sql_root: warehouse\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        patch = json.loads(result.stdout)
        self.assertEqual(Path(patch["repos"]["sql"]["path"]), self.project / "source Ω" / "warehouse")
        self.assertEqual(Path(patch["repos"]["powerbi"]["path"]), self.project / "source Ω")
        result = seed("repositories:\n  sql:\n    role: sql\n    local_path: " + json.dumps(str(self.scratch / "PRIVATE_CANARY")) + "\n")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("PRIVATE_CANARY", result.stdout + result.stderr)
        result = seed("repositories:\n  sql:\n    role: sql\n    local_path: .\n    sql_root: ../../../outside\n")
        self.assertEqual(result.returncode, 2)
        result = seed("repositories:\n  pending:\n    role: sql\n    local_path: TODO later\n")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, "")
        alias = self.scratch / "contract-alias.yml"
        os.link(contract, alias)
        shared = alias.read_bytes()
        result = subprocess.run([sys.executable, "-I", "-B", str(LIB / "_seeddocs.py"), str(contract)],
            cwd=self.project, env=os.environ, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(alias.read_bytes(), shared)

    def test_nested_directory_link_refused(self):
        link = self.project / "linked"
        if sys.platform == "win32":
            env = {**os.environ, "COOP_TEST_LINK": str(link), "COOP_TEST_TARGET": str(self.scratch)}
            ps = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            result = subprocess.run([str(ps), "-NoProfile", "-Command",
                "New-Item -ItemType Junction -Path $env:COOP_TEST_LINK -Target $env:COOP_TEST_TARGET | Out-Null"],
                env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(self.scratch, target_is_directory=True)
        with self.assertRaises(ValueError):
            beta_workspace_tree(self.project, self.project)
        with self.assertRaises(ValueError):
            beta_workspace_path(link / ".." / "new", self.project)

    @unittest.skipUnless(os.environ.get("COOP_TEST_DATADOC_PYTHON"), "explicit pinned data-doc Python required")
    def test_real_pinned_package(self):
        python = os.environ["COOP_TEST_DATADOC_PYTHON"]
        poison = self.project / "poison-ran.txt"
        (self.project / "mkdocs.py").write_text(
            "from pathlib import Path\nPath('poison-ran.txt').write_text('unexpected workspace import')\n",
            encoding="utf-8")
        def run(args, cwd=None):
            return subprocess.run([python, "-I", "-B", "-X", "utf8", str(LIB / "beta_data_doc.py"), "1.2.0", *args],
                cwd=cwd or self.project, env=os.environ, capture_output=True, text=True, encoding="utf-8", timeout=90)
        for args in [["--version"], ["--help"], ["show-config"], ["status"], ["scan", "--non-interactive"],
                     ["build", "--non-interactive", "--skip-html"], ["build", "--non-interactive"],
                     ["check"], ["export"], ["findings"]]:
            with self.subTest(args=args):
                result = run(args)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                self.assertFalse(poison.exists())
        self.assertTrue((self.project / "data-docs-site" / "index.html").is_file())
        outside = self.scratch / "outside.yml"
        outside.write_text('{"project_name":"PRIVATE_CANARY","repos":{}}', encoding="utf-8")
        out = self.scratch / "preserve.txt"
        out.write_text("preserve", encoding="utf-8")
        for args in [["show-config", "--config", str(outside)], ["--log-file", str(out), "status"],
                     ["findings", "--out", str(out)], ["export", "--out", str(self.scratch)],
                     ["upgrade"], ["build", "--serve"],
                     ["impact", "--git", "HEAD"], ["status", "--config", str(outside), "--help"]]:
            with self.subTest(args=args):
                result = run(args)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("PRIVATE_CANARY", result.stdout + result.stderr)
                self.assertEqual(out.read_text(encoding="utf-8"), "preserve")
        self.assertEqual(run(["show-config"], self.scratch).returncode, 1)
        saved = self.config.read_bytes()
        hostile = copy.deepcopy(self.data)
        hostile["repos"] = {"outside": {"path": str(self.scratch)}}
        self.config.write_text(json.dumps(hostile), encoding="utf-8")
        self.assertEqual(run(["scan"]).returncode, 1)
        self.config.write_bytes(saved)

    @unittest.skipUnless(os.environ.get("COOP_TEST_DATADOC_PYTHON"), "explicit pinned data-doc Python required")
    def test_canonical_authoring(self):
        python = os.environ["COOP_TEST_DATADOC_PYTHON"]
        vector = [python, "-I", "-B", "-X", "utf8", str(LIB / "beta_data_doc.py"), "1.2.0"]
        def patch(value, *extra):
            return subprocess.run([*vector, "config-set", *extra], input=json.dumps(value),
                cwd=self.project, env=os.environ, capture_output=True, text=True, encoding="utf-8", timeout=60)
        def backups():
            return list((self.project / ".backups").rglob("coop-data-doc.yml"))
        original = self.config.read_bytes()
        result = patch({"project_name": "Patched Ω"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(backups()), 1)
        self.assertEqual(backups()[0].read_bytes(), original)
        updated = self.config.read_bytes()
        for value in [{"repos": {"sql": {"path": str(self.scratch)}}},
                      {"output": {"dir": "same", "site_dir": "same"}},
                      {"future_unknown_field": "PRIVATE_CANARY"}]:
            with self.subTest(value=value):
                result = patch(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.config.read_bytes(), updated)
                self.assertEqual(len(backups()), 1)
                self.assertNotIn("PRIVATE_CANARY", result.stdout + result.stderr)
        result = patch({}, "--from-json", str(self.scratch / "outside.json"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.config.read_bytes(), updated)

        def setup(answer, eof=False):
            events = []
            with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as errors:
                child = subprocess.Popen([*vector, "setup", "--transport", "jsonl"], cwd=self.project,
                    env=os.environ, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                    text=True, encoding="utf-8")
                timer = threading.Timer(60, child.kill)
                timer.start()
                try:
                    for line in child.stdout:
                        event = json.loads(line)
                        events.append(event)
                        if event.get("type") == "prompt":
                            if eof:
                                child.stdin.close()
                            else:
                                child.stdin.write(json.dumps({"id": event["id"], "answer": answer(event)}) + "\n")
                                child.stdin.flush()
                    child.wait(timeout=10)
                finally:
                    timer.cancel()
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    if not child.stdin.closed:
                        child.stdin.close()
                    child.stdout.close()
                errors.seek(0)
                return child.returncode, events, errors.read()

        def normal(event):
            if event["id"] == "project_name":
                return "Canonical Ω"
            if event["id"] == "local_sources":
                return "none"
            if event["kind"] == "text":
                return event.get("default") or ""
            if event["kind"] == "select":
                return event.get("default") or event["choices"][0]["value"]
            if event["kind"] == "checkbox":
                return [x["value"] for x in event["choices"] if x.get("checked")]
            if event["kind"] == "confirm":
                return False
            raise AssertionError("Unexpected questionnaire prompt")

        status, events, stderr = setup(normal)
        self.assertEqual(status, 0, stderr + repr(events[-2:]))
        self.assertTrue(any(e["type"] == "complete" for e in events))
        self.assertEqual(len(backups()), 2)
        self.assertIn(updated, [p.read_bytes() for p in backups()])
        saved = self.config.read_bytes()
        status, events, _ = setup(normal, eof=True)
        self.assertEqual(status, 130, events)
        self.assertEqual(self.config.read_bytes(), saved)
        self.assertEqual(len(backups()), 2)

        def outside_output(event):
            return str(self.scratch) if event["id"] == "output_dir" else normal(event)
        status, events, _ = setup(outside_output)
        self.assertEqual(status, 2)
        self.assertTrue(any(e["type"] == "error" for e in events))
        self.assertEqual(self.config.read_bytes(), saved)
        self.assertEqual(len(backups()), 2)

        def outside_repo(event):
            if event["id"] == "local_sources":
                return "sql"
            return str(self.scratch) if event["kind"] == "path" else normal(event)
        status, events, _ = setup(outside_repo)
        self.assertEqual(status, 2)
        self.assertEqual(self.config.read_bytes(), saved)
        self.assertEqual(len(backups()), 2)

        concurrent = b'{"project_name":"Concurrent edit","repos":{}}'
        def changed(event):
            if event["id"] == "project_name":
                self.config.write_bytes(concurrent)
            return normal(event)
        status, events, _ = setup(changed)
        self.assertEqual(status, 2)
        self.assertEqual(self.config.read_bytes(), concurrent)
        self.assertEqual(len(backups()), 2)
        temporary = self.config.with_name(self.config.name + ".tmp")
        temporary.write_text("preserve pending", encoding="utf-8")
        status, events, _ = setup(normal)
        self.assertEqual(status, 1)
        self.assertEqual(events, [])
        self.assertEqual(temporary.read_text(encoding="utf-8"), "preserve pending")
        self.config.write_text('{"project_name":"Unknown","repos":{},"future":true}', encoding="utf-8")
        unknown = self.config.read_bytes()
        self.assertEqual(patch({"project_name": "replacement"}).returncode, 1)
        self.assertEqual(self.config.read_bytes(), unknown)
        temporary.rename(self.project / "preserved-pending.tmp")
        self.config.write_bytes(saved)
        sql = self.project / "sql"
        sql.mkdir()
        (sql / "sample.sql").write_text("CREATE VIEW gold.sample AS SELECT 1 AS value;\n", encoding="utf-8")
        def with_sql(event):
            if event["id"] == "local_sources":
                return "sql"
            if event["kind"] == "path":
                return str(sql)
            if event["kind"] == "checkbox":
                return [x["value"] for x in event["choices"] if x["value"] != "__manual__"]
            return normal(event)
        def escaping_glob(event):
            if event["id"] == "csv" and "INCLUDE" in event["message"]:
                return "../*.sql"
            return with_sql(event)
        status, events, _ = setup(escaping_glob)
        self.assertEqual(status, 2, events[-3:])
        self.assertEqual(self.config.read_bytes(), saved)
        self.assertEqual(len(backups()), 2)
        status, events, stderr = setup(with_sql)
        self.assertEqual(status, 0, stderr + repr(events[-3:]))
        self.assertTrue(any("Scanning your repos" in e.get("message", "") for e in events))
        self.assertTrue(any(e["type"] == "complete" for e in events))
        self.assertEqual(len(backups()), 3, "read-only scan render must not create extra backups")
        self.config.rename(self.project / "preserved-config.yml")
        result = patch({"project_name": "New configuration", "repos": {}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.config.is_file())
        self.assertEqual(len(backups()), 3, "creating a configuration has no prior file to back up")
        alias = self.scratch / "external-config-alias.json"
        os.link(self.config, alias)
        shared = alias.read_bytes()
        self.assertEqual(patch({"project_name": "must not change aliases"}).returncode, 1)
        self.assertEqual(alias.read_bytes(), shared)
        self.assertEqual(self.config.read_bytes(), shared)
        self.assertEqual(len(backups()), 3)


if __name__ == "__main__":
    unittest.main()
