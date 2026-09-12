#!/usr/bin/env python3
"""Inspect only the non-sensitive setup fields Coop surfaces to clients."""
import json
import sys
from pathlib import Path

import _yaml


def dig(value, *path, default=None):
    current = value
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def present(value):
    return isinstance(value, str) and bool(value.strip()) and not value.strip().lower().startswith("todo")


def enabled(value):
    return value is True or (isinstance(value, str) and value.strip().lower() in {"true", "yes", "1", "on"})


def section(section_id, name, state, optional, selected, summary, operation):
    return {
        "id": section_id,
        "name": name,
        "state": state,
        "optional": optional,
        "selected": selected,
        "summary": summary,
        "setupOperationId": operation,
    }


def inspect(workspace):
    root = Path(workspace).resolve()
    contract = root / ".coop" / "project.yml"
    if not contract.exists():
        return {
            "workspace": str(root),
            "contractPath": str(contract),
            "contractState": "not-configured",
            "sections": [section("project-contract", "Project contract", "not-configured", False, True, "No .coop/project.yml exists yet.", "project.configure")],
        }
    try:
        contract.resolve().relative_to(root)
        if contract.stat().st_size > 512 * 1024:
            raise ValueError("Project configuration exceeds the safety limit.")
    except Exception:
        return {
            "workspace": str(root),
            "contractPath": str(contract),
            "contractState": "broken",
            "sections": [section("project-contract", "Project contract", "broken", False, True, "The project contract is outside the workspace boundary or exceeds the safety limit.", "project.repair")],
        }
    try:
        config = _yaml.load(contract)
        if not isinstance(config, dict):
            raise ValueError("Project configuration must be a YAML mapping.")
        # Match the proposal validator even when the dependency-free YAML reader
        # conservatively treats unsupported/malformed flow syntax as a scalar.
        if "profile" in config and not isinstance(config["profile"], dict):
            raise ValueError("Project profile must be a YAML mapping.")
    except Exception:
        return {
            "workspace": str(root),
            "contractPath": str(contract),
            "contractState": "broken",
            "sections": [section("project-contract", "Project contract", "broken", False, True, "The project contract cannot be parsed safely.", "project.repair")],
        }

    sections = [section("project-contract", "Project contract", "configured", False, True, "The project contract is readable.", None)]
    repositories = dig(config, "repositories", default={})
    repo_count = 0
    if isinstance(repositories, dict):
        repo_count = sum(1 for repo in repositories.values() if isinstance(repo, dict) and present(repo.get("local_path")))
    sections.append(section(
        "repositories", "Local repositories", "configured" if repo_count else "not-configured", True, bool(repo_count),
        f"{repo_count} local repository path{' is' if repo_count == 1 else 's are'} configured." if repo_count else "No local source repository is configured; discovery mode remains valid.",
        None if repo_count else "repositories.configure",
    ))

    fabric_selected = any([
        enabled(dig(config, "tools", "fabric_cli", "enabled")),
        enabled(dig(config, "mcp", "fabric", "enabled")),
        enabled(dig(config, "mcp", "powerbi", "enabled")),
        isinstance(config.get("fabric"), dict),
        isinstance(config.get("power_bi"), dict),
    ])
    tenant = dig(config, "fabric", "tenant_id", default="")
    sections.append(section(
        "microsoft", "Microsoft client identity", "configured" if fabric_selected and present(tenant) else "not-configured", True, fabric_selected,
        "A client tenant is configured." if fabric_selected and present(tenant) else ("Fabric/Power BI was selected, but its client tenant is not configured." if fabric_selected else "Microsoft/Fabric integration was skipped and local Coop work remains available."),
        None if fabric_selected and present(tenant) else "microsoft.configure",
    ))

    fabric_name = dig(config, "fabric", "default_workspace_name", default="")
    fabric_id = dig(config, "fabric", "default_workspace_id", default="")
    fabric_ready = fabric_selected and present(fabric_name) and present(fabric_id)
    sections.append(section(
        "fabric-workspace", "Default Fabric workspace", "configured" if fabric_ready else "not-configured", True, fabric_selected,
        "A recognizable Fabric workspace name and resolved ID are configured." if fabric_ready else ("Choose a Fabric workspace when a Fabric capability first needs one." if fabric_selected else "Fabric workspace setup was skipped."),
        None if fabric_ready else "fabric-workspace.discover",
    ))

    pbi_name = dig(config, "power_bi", "default_workspace_name", default="")
    pbi_id = dig(config, "power_bi", "default_workspace_id", default="")
    pbi_ready = fabric_selected and present(pbi_name) and present(pbi_id)
    sections.append(section(
        "power-bi-workspace", "Default Power BI workspace", "configured" if pbi_ready else "not-configured", True, fabric_selected,
        "A recognizable Power BI workspace name and resolved ID are configured." if pbi_ready else ("Choose a Power BI workspace when a semantic-model capability first needs one." if fabric_selected else "Power BI workspace setup was skipped."),
        None if pbi_ready else "power-bi-workspace.discover",
    ))

    data_doc_ready = (root / "coop-data-doc.yml").is_file()
    sections.append(section(
        "data-doc", "Lineage documentation", "configured" if data_doc_ready else "not-configured", True, data_doc_ready,
        "coop-data-doc.yml is present; the native Data Doc protocol owns its detailed validation." if data_doc_ready else "Lineage setup can be added later through the native Data Doc protocol.",
        None if data_doc_ready else "data-doc.configure",
    ))

    te_selected = enabled(dig(config, "tools", "tabular_editor_cli", "enabled"))
    te_path = dig(config, "tools", "tabular_editor_cli", "executable_path", default="")
    te_ready = te_selected and present(te_path)
    sections.append(section(
        "tabular-editor", "Tabular Editor BPA", "configured" if te_ready else "not-configured", True, te_selected,
        "Tabular Editor CLI is configured for BPA." if te_ready else ("Tabular Editor was selected, but its CLI path is missing." if te_selected else "Tabular Editor BPA was skipped."),
        None if te_ready else "tabular-editor.configure",
    ))
    return {"workspace": str(root), "contractPath": str(contract), "contractState": "configured", "sections": sections}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: project_setup_state.py WORKSPACE"}))
        return 2
    print(json.dumps(inspect(sys.argv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
