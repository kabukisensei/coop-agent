"""Actual pinned-package review boundaries; fixtures never use client sources."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[1] / "lib"
RUNTIME = os.environ.get("COOP_TEST_REVIEW_ROOT")


@unittest.skipUnless(RUNTIME, "set COOP_TEST_REVIEW_ROOT to the private pinned venvs")
class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="coop-beta-review-"))
        self.root = self.scratch / "Beta Ω"
        self.cwd = self.root / "workspaces" / "Review Ω"
        self.cwd.mkdir(parents=True)
        self.sql = self.cwd / "sample.sql"
        self.sql.write_text("CREATE VIEW gold.sample AS SELECT 1 AS value;\n", encoding="utf-8")
        self.bim = self.cwd / "sample.bim"
        self.bim.write_text(json.dumps({"name": "Synthetic", "model": {"tables": [{"name": "Sales",
            "columns": [{"name": "Amount", "dataType": "decimal"}],
            "measures": [{"name": "Total", "expression": "SUM(Sales[Amount])"}]}]}}), encoding="utf-8")
        self.env = {**os.environ, "COOP_CHANNEL": "beta", "COOP_BETA_ROOT": str(self.root),
                    "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"}
        self.env.pop("COOP_SQL_REVIEW_CONFIG", None)
        self.env.pop("COOP_DAX_REVIEW_CONFIG", None)

    def call(self, tool, args, **kwargs):
        version = "0.15.2" if tool == "sql-review" else "0.22.0"
        python = Path(RUNTIME) / ("coop-" + tool) / "Scripts" / "python.exe"
        return subprocess.run([str(python), "-I", "-B", "-X", "utf8", str(LIB / "beta_review.py"),
            version, tool, *map(str, args)], cwd=self.cwd, env=kwargs.pop("env", self.env),
            capture_output=True, text=True, encoding="utf-8", timeout=60, **kwargs)

    def check(self, tool, *extra):
        return self.call(tool, ["check", self.sql if tool == "sql-review" else self.bim,
                               "--format", "json", *extra])

    def test_actual_reports_rules_compare_and_backups(self):
        for tool in ("sql-review", "dax-review"):
            with self.subTest(tool=tool):
                original = (self.sql.read_bytes(), self.bim.read_bytes())
                result = self.check(tool)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsInstance(json.loads(result.stdout), dict)
                output = self.cwd / (tool + ".json")
                output.write_text("preserve prior report", encoding="utf-8")
                html = self.cwd / (tool + ".html")
                markdown = self.cwd / (tool + ".md")
                report = self.check(tool, "--output", output, "--html", html, "--md", markdown)
                self.assertEqual(report.returncode, 0, report.stderr)
                self.assertTrue(html.is_file())
                self.assertTrue(markdown.is_file())
                self.assertIsInstance(json.loads(output.read_text(encoding="utf-8")), dict)
                backups = list((self.cwd / ".backups" / "coop-review").glob("*/*"))
                self.assertTrue(any(p.read_bytes() == b"preserve prior report" for p in backups))
                comparison = self.call(tool, ["compare" if tool == "sql-review" else "diff", output, output])
                self.assertEqual(comparison.returncode, 0, comparison.stderr)
                rules = self.call(tool, ["rules", "--format", "json"])
                self.assertEqual(rules.returncode, 0, rules.stderr)
                rule = json.loads(rules.stdout)[0]["id"]
                explained = self.call(tool, ["explain", rule, "--format", "json"])
                self.assertEqual(explained.returncode, 0, explained.stderr)
                self.assertEqual(json.loads(explained.stdout)["id"], rule)
                html_default = self.call(tool, ["check", self.sql if tool == "sql-review" else self.bim,
                                                "--format", "html", "--no-open"])
                self.assertEqual(html_default.returncode, 0, html_default.stderr)
                self.assertTrue((self.cwd / ("coop-" + tool + "-report.html")).is_file())
                self.assertEqual((self.sql.read_bytes(), self.bim.read_bytes()), original)

    def test_outside_arguments_discovery_and_control_outputs_refused(self):
        outside = self.scratch / "PRIVATE_CANARY.json"
        outside.write_text("preserve outside", encoding="utf-8")
        for tool in ("sql-review", "dax-review"):
            for option in ("--output", "--html", "--md", "--sarif", "--log-file",
                           "--write-baseline", "--baseline", "--diff-against", "--config", "--standards"):
                with self.subTest(tool=tool, option=option):
                    result = self.check(tool, option, outside)
                    self.assertEqual(result.returncode, 1)
                    self.assertNotIn("PRIVATE_CANARY", result.stdout + result.stderr)
                    self.assertEqual(outside.read_text(), "preserve outside")
            result = self.call(tool, ["check", outside, "--format", "json"])
            self.assertEqual(result.returncode, 1)
            config = self.root / ("coop-" + tool + ".yml")
            config.write_text("PRIVATE_CANARY: preserve\n", encoding="utf-8")
            self.assertEqual(self.check(tool).returncode, 1)
            config.unlink()
            env = {**self.env, "COOP_" + tool.upper().replace("-", "_") + "_CONFIG": str(outside)}
            self.assertEqual(self.call(tool, ["check", self.sql], env=env).returncode, 1)
            for target in (self.sql, self.bim, self.cwd / ".coop" / "project.yml"):
                self.assertEqual(self.check(tool, "--output", target).returncode, 1)
            self.assertFalse((self.cwd / ".backups").exists())

    def test_hardlink_junction_and_unqualified_options(self):
        for tool in ("sql-review", "dax-review"):
            for args in (["upgrade"], ["update"], ["check", "--open"], ["check", "--save-ignores"]):
                self.assertEqual(self.call(tool, args).returncode, 1)
            self.assertEqual(self.call(tool, ["--help"]).returncode, 0)
            no_args = self.call(tool, [])
            self.assertEqual(no_args.returncode, 0, no_args.stderr)
            self.assertIn("Usage:", no_args.stdout)
        self.assertEqual(self.call("sql-review", ["check", "--changed", "HEAD"]).returncode, 1)
        alias = self.cwd / "aliased-report.json"
        external = self.scratch / "external.json"
        external.write_text("preserve alias", encoding="utf-8")
        os.link(external, alias)
        for tool in ("sql-review", "dax-review"):
            self.assertEqual(self.check(tool, "--output", alias).returncode, 1)
        self.assertEqual(external.read_text(), "preserve alias")
        alias.unlink()
        escape = self.cwd / "linked"
        if sys.platform == "win32":
            subprocess.run([os.environ["COOP_TEST_NODE"], "-e",
                "require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                str(self.scratch), str(escape)], check=True)
        else:
            escape.symlink_to(self.scratch, target_is_directory=True)
        for tool in ("sql-review", "dax-review"):
            self.assertEqual(self.check(tool).returncode, 1)

    def test_dax_sibling_report_discovery_is_scoped(self):
        # Explicit model outside cwd: the adjacent Report is not visited by the
        # cwd/input-tree checks, so the package's secondary discovery is exercised.
        model = self.root / "workspaces" / "Separate" / "Sales.SemanticModel"
        model.mkdir(parents=True)
        source = model / "model.bim"
        source.write_bytes(self.bim.read_bytes())
        report = model.parent / "Sales.Report"
        outside = self.scratch / "Outside report"
        outside.mkdir()
        (outside / "visual.json").write_text('{"PRIVATE_CANARY":"preserve"}', encoding="utf-8")
        if sys.platform == "win32":
            subprocess.run([os.environ["COOP_TEST_NODE"], "-e",
                "require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                str(outside), str(report)], check=True)
        else:
            report.symlink_to(outside, target_is_directory=True)
        output = self.cwd / "secondary-discovery.json"
        result = self.call("dax-review", ["check", source, "--format", "json", "--output", output])
        self.assertEqual(result.returncode, 1)
        self.assertFalse(output.exists())
        self.assertNotIn("PRIVATE_CANARY", result.stdout + result.stderr)


    def test_immutable_standards_and_internal_suite_reports(self):
        snapshots = self.root / "profile" / "standards" / "snapshots"
        snapshots.mkdir(parents=True)
        suite = self.cwd / ".coop" / "reviews"
        suite.mkdir(parents=True)
        for tool in ("sql-review", "dax-review"):
            content = b"# Synthetic review standards\nUse explicit names.\n"
            domain = tool.removesuffix("-review")
            standard = snapshots / (hashlib.sha256(content).hexdigest() + "-" + domain + ".md")
            standard.write_bytes(content)
            output = suite / (".coop-" + tool + ".current.fixture.json")
            # Inherited flags are removed at the public lifecycle entry. This
            # private helper receives one derived internal report directory.
            env = {**self.env, "COOP_BETA_REVIEW_SUITE": str(suite)}
            args = ["check", self.sql if tool == "sql-review" else self.bim,
                    "--format", "json", "--standards", standard, "--output", output]
            refused = self.call(tool, args)
            self.assertEqual(refused.returncode, 1)
            self.assertFalse(output.exists())
            result = self.call(tool, args, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(Path(report["standards"]["path"]), standard)
            sidecar = snapshots / "rules.yml"
            sidecar.write_text("rules: {}\n", encoding="utf-8")
            outside_config = self.call(tool, args, env=env)
            self.assertEqual(outside_config.returncode, 1)
            sidecar.unlink()  # only this test's synthetic, owned configuration
            pointer = suite / "active-review-generation.json"
            bad_output = self.call(tool, [*args[:-1], pointer], env=env)
            self.assertEqual(bad_output.returncode, 1)
            self.assertFalse(pointer.exists())
            before = output.read_bytes()
            standard.write_bytes(b"tampered")
            invalid = self.call(tool, args, env=env)
            self.assertEqual(invalid.returncode, 1)
            self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
