#!/usr/bin/env python3
import importlib.util
from pathlib import Path

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("init_wizard", root / "lib" / "init_wizard.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
answers = {
    "organization": "Aaron's Client", "client": "a:b #hash \"quoted\" Unicode Ω",
    "timezone": "UTC", "default_branch": "main", "repo_name": "sql repo",
    "repo_description": "SQL", "repo_local_path": r"C:\Users\Aaron\Work\Client Project",
    "repo_remote_name": "origin", "use_fabric": False, "use_tabular_editor": True,
    "te_path": r"C:\Program Files\Tabular Editor\te.exe",
    "bpa_rules_path": r"C:\Rules\BPA Rules.json",
    "repositories": [
        {"name": "sql repo", "description": "Aaron's SQL", "role": "sql", "local_path": r"C:\Users\Aaron\Work\Client Project", "remote_name": "origin", "default_branch": "main"},
        {"name": "power bi", "description": "PBI", "role": "powerbi", "local_path": r"C:\Work\PBI #1", "remote_name": "origin", "default_branch": "main"},
    ],
}
yaml_spec = importlib.util.spec_from_file_location("coop_yaml", root / "lib" / "_yaml.py")
yaml_mod = importlib.util.module_from_spec(yaml_spec); yaml_spec.loader.exec_module(yaml_mod)
parsed = yaml_mod._load_fallback(mod.build_project_yml(answers))
assert parsed["profile"]["organization"] == "Aaron's Client"
assert parsed["profile"]["client"] == 'a:b #hash "quoted" Unicode Ω'
assert parsed["repositories"]["sql repo"]["local_path"] == r"C:\Users\Aaron\Work\Client Project"
assert parsed["tools"]["tabular_editor_cli"]["executable_path"] == r"C:\Program Files\Tabular Editor\te.exe"
assert parsed["tools"]["tabular_editor_cli"]["bpa_rules_path"] == r"C:\Rules\BPA Rules.json"
assert parsed["repositories"]["sql repo"]["role"] == "sql"
assert len(parsed["repositories"]) == 2
print("  ✓ init YAML round-trips Windows paths, apostrophes, punctuation, Unicode, and multiple repos")
