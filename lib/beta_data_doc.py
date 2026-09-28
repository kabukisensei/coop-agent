"""Preflight the pinned data-doc CLI before it opens any user input/output.

The package keeps its parser, questionnaire and command implementations.
It is a path boundary, not an operating-system sandbox against hostile code.
"""

import copy
import importlib.metadata
import os
import sys
from uuid import uuid4
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from beta_paths import beta_workspace_path, beta_workspace_tree


def checked_config(data, config_path):
    """Check raw paths before the vendor resolves them or formats errors."""
    if not isinstance(data, dict):
        raise ValueError("Beta data-doc configuration must be a mapping")
    base = config_path.parent
    beta_workspace_tree(base, base)
    repos = data.get("repos", {})
    if not isinstance(repos, dict):
        raise ValueError("Invalid beta data-doc repositories")
    inputs = []
    for repo in repos.values():
        if not isinstance(repo, dict) or not isinstance(repo.get("path"), str):
            raise ValueError("Invalid beta data-doc repository path")
        inputs.append(beta_workspace_tree(repo["path"], base))
        for key in ("include", "exclude"):
            patterns = repo.get(key, [])
            if not isinstance(patterns, list) or any(
                not isinstance(pattern, str) or pattern.startswith(("/", "\\", "~"))
                or ":" in pattern or ".." in pattern.replace("\\", "/").split("/")
                or any(ord(char) < 32 for char in pattern)
                for pattern in patterns
            ):
                raise ValueError("Beta data-doc globs must stay within their repository")
    output = data.get("output", {})
    if not isinstance(output, dict):
        raise ValueError("Invalid beta data-doc output")
    for key, default in (("dir", "./data-docs"), ("site_dir", "./data-docs-site")):
        destination = beta_workspace_tree(output.get(key, default), base)
        if key == "dir":
            beta_workspace_path(destination.parent / ".coop-mkdocs.yml", base)
        # The HTML builder clears its output directory. Never let that directory
        # contain the configuration or a configured source root.
        if any(p == destination or destination in p.parents for p in [base, *inputs]):
            raise ValueError("Beta data-doc output cannot contain configuration or source roots")
    branding = data.get("branding", {})
    if not isinstance(branding, dict):
        raise ValueError("Invalid beta data-doc branding")
    for key in ("logo", "favicon"):
        if branding.get(key):
            beta_workspace_tree(branding[key], base)
    reviews = data.get("reviews", [])
    if not isinstance(reviews, list):
        raise ValueError("Invalid beta data-doc reviews")
    for review in reviews:
        beta_workspace_tree(review, base)


def selected_config(explicit, cwd, allow_missing=False):
    value = explicit or os.environ.get("COOP_DATA_DOC_CONFIG")
    if value:
        return beta_workspace_path(value, cwd)
    workspace = beta_workspace_path(Path(os.environ["COOP_BETA_ROOT"]) / "workspaces", cwd)
    directory = cwd
    while True:
        candidate = beta_workspace_path(directory / "coop-data-doc.yml", cwd)
        if candidate.exists():
            return candidate
        if directory == workspace:
            if allow_missing:
                return beta_workspace_path(cwd / "coop-data-doc.yml", cwd)
            raise ValueError("No data-doc configuration inside owned beta workspaces")
        directory = directory.parent


def checked_model(data, config_path):
    from coop_data_doc.config import Config, output_dirs_conflict
    checked_config(data, config_path)
    model = Config.model_validate(data)
    model._base_dir = config_path.parent
    if output_dirs_conflict(model.output_dir(), model.site_dir()):
        raise ValueError("Beta documentation outputs must be separate")
    return model


def guard_authoring(vendor, command, config_path):
    """Adapt the pinned renderer/IO; never fork its questionnaire or patch rules."""
    import yaml
    from coop_data_doc import wizard
    original = config_path.read_bytes() if config_path.exists() else None
    temporary = config_path.with_name(config_path.name + ".tmp")

    def unchanged():
        beta_workspace_path(config_path, config_path.parent)
        current = config_path.read_bytes() if config_path.exists() else None
        if current != original:
            raise ValueError("Beta configuration changed during authoring; preserve it and retry")
        if command == "setup":
            beta_workspace_path(temporary, config_path.parent)
            if temporary.exists():
                raise ValueError("A pending configuration file exists; preserve it before retry")

    unchanged()
    module = wizard if command == "setup" else vendor
    render = module.render_config_yaml

    def guarded_render(**kwargs):
        try:
            rendered = render(**kwargs)
            checked_model(yaml.safe_load(rendered), config_path)
            # In 1.2.0, scan candidates use sql_path/pbi_path; the final setup
            # and config-set render use repos. Backup only at that write boundary,
            # not during a cancelled wizard's read-only candidate scans.
            if "repos" in kwargs:
                unchanged()
                if original is not None:
                    backup = beta_workspace_path(config_path.parent / ".backups" /
                        "coop-data-doc" / str(uuid4()) / config_path.name, config_path.parent)
                    backup.parent.mkdir(parents=True, exist_ok=False)
                    with backup.open("xb") as stream:
                        stream.write(original)
            return rendered
        except Exception:
            raise ValueError("Beta configuration candidate refused; existing configuration preserved") from None

    module.render_config_yaml = guarded_render
    if command == "config-set":
        apply_patch = vendor._apply_config_patch

        def guarded_patch(kwargs, patch):
            try:
                allowed = {"project_name", "repos", "output", "layers", "schema_mappings",
                    "ignore_schemas", "include_schemas", "branding", "sql_dialect", "reviews"}
                if set(patch) - allowed:
                    raise ValueError("Unknown configuration patch field")
                apply_patch(kwargs, patch)
            except Exception:
                raise ValueError("Invalid beta configuration patch") from None
        vendor._apply_config_patch = guarded_patch
        return

    run_setup = wizard.run_setup

    class ScopedIO:
        def __init__(self, delegate):
            self.delegate = delegate

        def __getattr__(self, name):
            return getattr(self.delegate, name)

        def path(self, prompt_id, message, default=""):
            value = self.delegate.path(prompt_id, message, default)
            if value:
                beta_workspace_tree(value, config_path.parent)
            return value

        def text(self, prompt_id, message, default=""):
            value = self.delegate.text(prompt_id, message, default)
            if prompt_id in {"output_dir", "site_dir", "logo"} and value:
                beta_workspace_tree(value, config_path.parent)
            return value

    def scoped_setup(path, io=None):
        unchanged()
        if beta_workspace_path(path, Path.cwd()) != config_path:
            raise ValueError("Beta setup target changed")
        return run_setup(path, io=ScopedIO(io))
    wizard.run_setup = scoped_setup


def preflight(cli, args):
    import click
    import yaml
    from coop_data_doc.config import Config
    from coop_data_doc import cli as vendor

    cwd = beta_workspace_path(Path.cwd(), Path.cwd())
    # Parse a copy with inert conversions: Click File('w') can truncate an
    # output during parsing, before a command callback can validate its scope.
    dry = copy.deepcopy(cli)
    for command in [dry, *dry.commands.values()]:
        command.add_help_option = False
        for param in command.params:
            param.callback = None
            param.is_eager = False
            if not getattr(param, "is_flag", False):
                param.type = click.STRING
    with dry.make_context("coop-data-doc", list(args)) as root:
        remaining = [*root._protected_args, *root.args]
        name, command, rest = dry.resolve_command(root, remaining)
        if name not in {"status", "folders", "lineage", "show-config", "scan", "build",
                        "update", "check", "export", "findings", "impact", "setup", "config-set"}:
            raise ValueError("This beta data-doc command awaits companion qualification")
        with command.make_context(name, rest, parent=root) as sub:
            params = sub.params
            if params.get("serve") or params.get("git_ref"):
                raise ValueError("Beta data-doc server/Git execution awaits qualification")
            authoring = name in {"setup", "config-set"}
            config_path = selected_config(params.get("config_path") or params.get("path"), cwd,
                allow_missing=authoring or name in {"show-config", "status"})
            if config_path.exists():
                data = yaml.safe_load(config_path.read_text(encoding="utf-8-sig"))
                checked_model(data, config_path)
                if not authoring and name not in {"show-config", "status"}:
                    Config.load(config_path)  # preserve the original runtime existence checks
            for value in [root.params.get("log_file"), params.get("out_dir_str"),
                          params.get("baseline_path"), *params.get("reviews", ())]:
                if value:
                    beta_workspace_tree(value, cwd)
            out_file = params.get("out_file")
            if out_file and out_file != "-":
                beta_workspace_tree(out_file, cwd)
            json_src = params.get("json_src")
            if json_src and json_src != "-":
                beta_workspace_path(json_src, cwd)
            # Make the package's normal discovery use the checked selection;
            # it may never continue walking above the owned workspace boundary.
            os.environ["COOP_DATA_DOC_CONFIG"] = str(config_path)
            if authoring:
                guard_authoring(vendor, name, config_path)


def main():
    try:
        expected, *args = sys.argv[1:]
        if os.environ.get("COOP_CHANNEL") != "beta":
            raise ValueError("An explicit beta context is required")
        beta_workspace_path(Path.cwd(), Path.cwd())
        if expected != "1.2.0" or importlib.metadata.version("coop-data-doc") != expected:
            raise ValueError("The installed data-doc version is not qualified")
        from coop_data_doc import cli as vendor
        # Exact help/version vectors are observational. A help flag mixed with
        # arbitrary options does not bypass the argument preflight.
        if args not in (["--help"], ["--version"]) and not (
            len(args) == 2 and args[0] in vendor.cli.commands and args[1] == "--help"
        ):
            preflight(vendor.cli, args or ["build"])
    except Exception:
        print("Beta data-doc refused: verify the owned configuration, paths, version and supported command.", file=sys.stderr)
        return 1
    # The pinned renderer starts `sys.executable -m mkdocs` in the project cwd.
    # Keep that child from importing a workspace mkdocs.py instead of its venv.
    os.environ["PYTHONSAFEPATH"] = "1"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.argv = ["coop-data-doc", *(args or ["build"])]
    vendor.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
