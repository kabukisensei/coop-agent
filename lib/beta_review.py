"""Scope the original pinned SQL/DAX CLI; do not copy its parser or rules."""
import copy
import importlib
import importlib.metadata
import os
import re
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
from beta_paths import beta_workspace_path, beta_workspace_tree, beta_standard_path


def preflight(vendor, operation, args):
    import click
    from coop_review_core import config as core

    cwd = beta_workspace_path(Path.cwd(), Path.cwd())
    beta_workspace_tree(cwd, cwd)
    dry = copy.deepcopy(vendor.cli)
    for command in [dry, *dry.commands.values()]:
        command.add_help_option = False
        for param in command.params:
            param.callback = None
            param.is_eager = False
            if not getattr(param, "is_flag", False):
                param.type = click.STRING
    with dry.make_context("coop-review", list(args)) as root:
        name, command, rest = dry.resolve_command(root, [*root._protected_args, *root.args])
        if name not in {"check", "compare", "diff", "rules", "explain", "help"}:
            raise ValueError("Beta review package changes are not authorized")
        with command.make_context(name, rest, parent=root) as sub:
            params = sub.params
    if params.get("changed_ref") is not None or params.get("save_ignores") or params.get("open_report"):
        raise ValueError("Beta Git scope, ignore editing and browser launch await qualification")

    inputs = []
    for value in params.get("paths", ()) or (["."] if name == "check" else []):
        target = beta_workspace_tree(value, cwd)
        inputs.append(target)
        # DAX may discover a sibling VPAX alongside an explicitly selected file.
        if operation == "dax-review" and target.is_file():
            beta_workspace_tree(target.parent, cwd)
    if params.get("standards_path"):
        inputs.append(beta_standard_path(params["standards_path"], cwd, operation.removesuffix("-review")))
    for key in ("config_path", "baseline_path", "diff_against",
                "schema_path", "vpax_path", "old_json", "new_json"):
        if params.get(key):
            inputs.append(beta_workspace_path(params[key], cwd))
    standard = vendor.resolve_standards_path(params.get("standards_path"))
    package = Path(vendor.__file__).resolve().parent
    if not Path(standard).resolve().is_relative_to(package):
        beta_standard_path(standard, cwd, operation.removesuffix("-review"))

    def checked_config(result):
        value = result.path
        if value is not None:
            # Only the package's own exact bundled default is a runtime input.
            if result.source == "bundled" and Path(value).resolve().is_relative_to(package):
                return result
            # The vendor represents a missing rules.yml beside an explicit
            # standard as a bundled default. An immutable snapshot has no such
            # sidecar; retain the vendor's empty-config semantics without giving
            # profile files authority over project rules.
            if result.source == "bundled" and Path(value).absolute() == Path(standard).absolute().parent / "rules.yml":
                beta_standard_path(standard, cwd, operation.removesuffix("-review"))
                try:
                    Path(value).lstat()
                except FileNotFoundError:
                    return core.DiscoveredConfig(path=None, source="none", notes=result.notes)
            beta_workspace_path(value, cwd)
        return result

    discover = core.discover_config

    def scoped_discover(*positional, **kwargs):
        try:
            return checked_config(discover(*positional, **kwargs))
        except Exception:
            raise click.ClickException("Beta review configuration discovery left its owned scope") from None

    core.discover_config = scoped_discover
    if hasattr(vendor, "discover_config"):
        vendor.discover_config = scoped_discover
    config = scoped_discover("coop-" + operation, explicit=params.get("config_path"),
        env=os.environ, start=cwd, bundled_default=core.default_config_path(standard))
    if config.path:
        inputs.append(Path(config.path).absolute())
    inputs.append(Path(standard).absolute())
    # Validate content with the package's parser before any report backup/write.
    if name == "check":
        vendor._load_rule_config(config.path)

    outputs = []
    for key in ("output_path", "html_path", "md_path", "sarif_path", "log_file", "write_baseline_path"):
        if params.get(key):
            outputs.append(beta_workspace_path(params[key], cwd))
    if name == "check" and params.get("fmt") == "html" and not params.get("output_path"):
        outputs.append(beta_workspace_path(vendor._DEFAULT_HTML_NAME, cwd))
    if len(set(outputs)) != len(outputs):
        raise ValueError("Beta review report destinations must be distinct")
    for output in outputs:
        if output in inputs or output.suffix.lower() in {".sql", ".tmdl", ".bim", ".pbit", ".pbix", ".vpax"}:
            raise ValueError("Beta review reports cannot replace their inputs or model sources")
        workspace = Path(os.environ["COOP_BETA_ROOT"]) / "workspaces"
        suite = os.environ.get("COOP_BETA_REVIEW_SUITE")
        suite_report = bool(suite and output.parent == beta_workspace_path(suite, cwd)
            and output.parent.name == "reviews" and output.parent.parent.name == ".coop"
            and re.fullmatch(r"\.coop-" + re.escape(operation) + r"\.current\.[A-Za-z0-9.]+\.json", output.name))
        if not suite_report and any(part in {".git", ".coop", ".pi", ".agents"} for part in output.relative_to(workspace).parts):
            raise ValueError("Beta review reports cannot replace project control files")
    for output in outputs:
        if output.exists():
            backup = beta_workspace_path(cwd / ".backups" / "coop-review" / str(uuid4()) / output.name, cwd)
            backup.parent.mkdir(parents=True, exist_ok=False)
            with backup.open("xb") as stream:
                stream.write(output.read_bytes())

    # Interactive path selection must be checked again before discovery reads.
    discovery_name = "discover_sql_files" if operation == "sql-review" else "discover_inputs"
    discovery = getattr(vendor, discovery_name)

    def scoped_inputs(paths):
        for value in paths or (".",):
            beta_workspace_tree(value, cwd)
        return discovery(paths)
    setattr(vendor, discovery_name, scoped_inputs)
    if operation == "dax-review":
        parse_report = vendor.parse_report_references
        def scoped_report(value):
            return parse_report(beta_workspace_tree(value, cwd))
        vendor.parse_report_references = scoped_report
        apply_vpax = vendor.apply_vpax_stats
        def scoped_vpax(catalogs, value):
            return apply_vpax(catalogs, beta_workspace_path(value, cwd))
        vendor.apply_vpax_stats = scoped_vpax
    # Generating a local HTML artifact is allowed; launching another application
    # is a separate unqualified route, including the package's interactive default.
    if operation == "sql-review":
        vendor._should_open_report = lambda *args, **kwargs: False
    else:
        vendor.should_open_report = lambda *args, **kwargs: False


def main():
    try:
        expected, operation, *args = sys.argv[1:]
        versions = {"sql-review": "0.15.2", "dax-review": "0.22.0"}
        if os.environ.get("COOP_CHANNEL") != "beta" or expected != versions.get(operation):
            raise ValueError("Explicit qualified beta review context required")
        beta_workspace_path(Path.cwd(), Path.cwd())
        if importlib.metadata.version("coop-" + operation) != expected:
            raise ValueError("Installed reviewer version is not qualified")
        vendor = importlib.import_module("coop_" + operation.replace("-", "_") + ".cli")
        help_only = not args or args in (["--help"], ["--version"]) or (
            len(args) == 2 and args[0] in vendor.cli.commands and args[1] == "--help")
        if not help_only:
            preflight(vendor, operation, args)
    except Exception:
        print("Beta review refused: verify owned inputs, configuration, report paths and supported options.", file=sys.stderr)
        return 1
    sys.argv = ["coop-" + operation, *args]
    try:
        vendor.main()
    except Exception:
        print("Beta review failed within the selected command; inspect its owned inputs.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
