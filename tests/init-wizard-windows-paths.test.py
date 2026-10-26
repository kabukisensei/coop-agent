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
fabric_answers = dict(answers)
fabric_answers["use_fabric"] = True
fabric_contract = yaml_mod._load_fallback(mod.build_project_yml(fabric_answers))
assert set(fabric_contract["fabric"]["environment_names"]) == {"dev", "test", "prod"}
assert set(fabric_contract["power_bi"]["environment_names"]) == {"dev", "test", "prod"}
print("OK: init YAML round-trips Windows paths, apostrophes, punctuation, Unicode, and multiple repos")
# Two answers (2026-10-26): a Power BI-only client gets power_bi: without fabric:.
pbi_only = dict(answers)
pbi_only["use_power_bi"] = True
pbi_contract = yaml_mod._load_fallback(mod.build_project_yml(pbi_only))
assert "fabric" not in pbi_contract, "no empty fabric: block for a Power BI-only client"
assert set(pbi_contract["power_bi"]["environment_names"]) == {"dev", "test", "prod"}
assert pbi_contract["tools"]["fabric_cli"]["enabled"] is True
assert pbi_contract["mcp"]["fabric"]["enabled"] is True
assert pbi_contract["tools"]["fabric_cicd"]["enabled"] is False
assert pbi_contract["mcp"]["fabric_sqlendpoint"]["enabled"] is False
fabric_only = dict(fabric_answers)
fabric_only["use_power_bi"] = False
assert "power_bi" not in yaml_mod._load_fallback(mod.build_project_yml(fabric_only))
print("OK: the Fabric and Power BI answers write their own blocks")
