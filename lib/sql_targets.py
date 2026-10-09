#!/usr/bin/env python3
"""Connection targets from the project contract (`sql_targets:`, master plan SQ1).

One section of `.coop/project.yml` names every SQL environment the engagement
can reach, and which one is the default:

    sql_targets:
      default_environment: dev        # dev or test; never prod
      dev:
        kind: azure_sql               # see KINDS
        server: contoso-dev.database.windows.net
        database: ContosoDW
      test:
        kind: fabric_warehouse
        workspace_id: <guid>
        item_id: <guid>
        database: SalesWarehouse      # the Warehouse / Lakehouse item name
      prod:
        kind: azure_sql
        server: contoso.database.windows.net
        database: ContosoDW

Rules (section 8 item 1):
- the host pattern must match the kind, so a production host cannot hide
  behind a dev kind and a Fabric host cannot be passed off as Azure SQL;
- `prod` is present but never the default;
- Fabric kinds keep today's rule: the server is discovered through the Fabric
  REST API from the workspace/item ids, never supplied by hand;
- an entry with blank values is "unconfigured" (a doctor note), not an error,
  so a wizard can leave placeholders;
- nothing here holds a credential: Entra ID tokens only (`auth` keys are rejected).

Dependency-free (lib/_yaml.py, never PyYAML). Readers: doctor (doctor-lines),
the SQL executor (SQ2), the guardrails' resolved scope (SQ3) and `/setup-project`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

LIB_DIR = Path(__file__).resolve().parent
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

try:
    from _yaml import load as load_yaml  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - the launcher always ships _yaml.py
    load_yaml = None  # type: ignore[assignment]

ENVIRONMENTS = ("dev", "test", "prod")
DEFAULTABLE_ENVIRONMENTS = ("dev", "test")
PRODUCTION_ENVIRONMENT = "prod"

_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
# Host pattern per kind. A Fabric Warehouse/Lakehouse host is discovered, so the
# contract never carries one; the pattern is what discovery must return (SQ2).
KINDS: dict[str, dict[str, Any]] = {
    "fabric_warehouse": {
        "host": re.compile(rf"^{_LABEL}(?:\.{_LABEL})*\.datawarehouse\.fabric\.microsoft\.com$"),
        "discovered": True,
        "connect_timeout": 15,
        "label": "Fabric Warehouse",
    },
    "fabric_lakehouse": {
        "host": re.compile(rf"^{_LABEL}(?:\.{_LABEL})*\.datawarehouse\.fabric\.microsoft\.com$"),
        "discovered": True,
        "connect_timeout": 15,
        "label": "Fabric Lakehouse SQL endpoint",
    },
    "fabric_sql_database": {
        "host": re.compile(rf"^{_LABEL}(?:\.{_LABEL})*\.database\.fabric\.microsoft\.com$"),
        "discovered": False,
        "connect_timeout": 15,
        "label": "Fabric SQL database",
    },
    "azure_sql": {
        "host": re.compile(rf"^{_LABEL}(?:\.{_LABEL})*\.database\.windows\.net$"),
        "discovered": False,
        # Serverless compute auto-pauses; the first connection after idle can
        # take up to a minute (section 8 item 1).
        "connect_timeout": 60,
        "label": "Azure SQL Database",
    },
    "synapse_serverless": {
        "host": re.compile(rf"^{_LABEL}-ondemand(?:\.{_LABEL})*\.sql\.azuresynapse\.net$"),
        "discovered": False,
        "connect_timeout": 15,
        "label": "Synapse serverless SQL pool",
    },
}
FABRIC_ITEM_KINDS = {"fabric_warehouse": "Warehouse", "fabric_lakehouse": "Lakehouse"}
SAFE_DATABASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._@&'()+-]{0,159}$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ALLOWED_KEYS = {
    "kind", "server", "database", "workspace_id", "item_id", "sql_endpoint_id", "description",
    # azure_sql only: the database has read-scale replicas (Premium / Business
    # Critical), so the executor connects with ApplicationIntent=ReadOnly.
    "read_scale_replicas",
}
FORBIDDEN_KEYS = {
    "user", "username", "uid", "password", "pwd", "secret", "token", "connection_string",
    "connectionstring", "auth", "authentication", "login", "credential", "credentials",
}


@dataclass
class SqlTarget:
    environment: str
    kind: str = ""
    server: str = ""
    database: str = ""
    workspace_id: str = ""
    item_id: str = ""
    sql_endpoint_id: str = ""
    read_scale_replicas: bool = False
    state: str = "unconfigured"  # ready | unconfigured | invalid
    reason: str = ""

    @property
    def production(self) -> bool:
        return self.environment == PRODUCTION_ENVIRONMENT

    @property
    def discovered(self) -> bool:
        return bool(KINDS.get(self.kind, {}).get("discovered"))

    @property
    def connect_timeout(self) -> int:
        return int(KINDS.get(self.kind, {}).get("connect_timeout", 15))

    @property
    def label(self) -> str:
        return str(KINDS.get(self.kind, {}).get("label", self.kind or "unset"))


@dataclass
class SqlTargets:
    configured: bool = False
    default_environment: str = ""
    targets: dict[str, SqlTarget] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def default(self) -> SqlTarget | None:
        target = self.targets.get(self.default_environment)
        return target if target and target.state == "ready" else None

    def to_json(self) -> dict[str, Any]:
        return {
            "configured": self.configured,
            "default_environment": self.default_environment,
            "targets": {env: asdict(t) for env, t in self.targets.items()},
            "errors": list(self.errors),
        }


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _placeholder(value: str) -> bool:
    return not value or value.upper().startswith("TODO")


def parse_target(environment: str, raw: Any) -> SqlTarget:
    """Validate one environment entry. Never raises; the state says what it is."""
    target = SqlTarget(environment=environment)
    if raw is None:
        return target
    if not isinstance(raw, dict):
        target.state, target.reason = "invalid", "entry must be a mapping"
        return target
    secrets = sorted(str(k) for k in raw if str(k).lower() in FORBIDDEN_KEYS)
    if secrets:
        target.state, target.reason = "invalid", f"credential keys are not allowed ({', '.join(secrets)}); Entra ID tokens only"
        return target
    unknown = sorted(str(k) for k in raw if str(k) not in ALLOWED_KEYS)
    target.kind = _text(raw.get("kind"))
    target.server = _text(raw.get("server")).lower()
    target.database = _text(raw.get("database"))
    target.workspace_id = _text(raw.get("workspace_id")).lower()
    target.item_id = _text(raw.get("item_id")).lower()
    target.sql_endpoint_id = _text(raw.get("sql_endpoint_id")).lower()
    # lib/_yaml.py hands a plain `true` / `false` over as a bool; a quoted one
    # ("true") is text and is accepted the same way.
    replicas = raw.get("read_scale_replicas", False)
    if isinstance(replicas, str):
        replicas = {"true": True, "false": False}.get(replicas.strip().lower(), replicas)
    if replicas not in (True, False) or isinstance(replicas, int) and not isinstance(replicas, bool):
        target.state, target.reason = "invalid", "read_scale_replicas must be true or false"
        return target
    target.read_scale_replicas = replicas is True
    if unknown:
        target.state, target.reason = "invalid", f"unknown keys: {', '.join(unknown)}"
        return target
    if _placeholder(target.kind) and _placeholder(target.server) and _placeholder(target.database):
        target.state, target.reason = "unconfigured", "no kind, server or database yet"
        return target
    if target.kind not in KINDS:
        target.state, target.reason = "invalid", (
            f"kind {target.kind or '(blank)'!r} is not one of {', '.join(KINDS)}"
        )
        return target
    spec = KINDS[target.kind]
    if _placeholder(target.database):
        target.state, target.reason = "unconfigured", "database not set"
        return target
    if not SAFE_DATABASE.fullmatch(target.database):
        target.state, target.reason = "invalid", "database name has characters coop does not accept"
        return target
    if spec["discovered"]:
        if target.server:
            target.state, target.reason = "invalid", (
                f"{target.kind} takes no server: coop discovers it from workspace_id and item_id"
            )
            return target
        if _placeholder(target.workspace_id) or _placeholder(target.item_id):
            target.state, target.reason = "unconfigured", "workspace_id and item_id not set"
            return target
        if not UUID_RE.match(target.workspace_id) or not UUID_RE.match(target.item_id):
            target.state, target.reason = "invalid", "workspace_id and item_id must be GUIDs"
            return target
        if target.kind == "fabric_lakehouse":
            if _placeholder(target.sql_endpoint_id):
                target.state, target.reason = "unconfigured", "sql_endpoint_id not set (the Lakehouse's SQL endpoint id)"
                return target
            if not UUID_RE.match(target.sql_endpoint_id):
                target.state, target.reason = "invalid", "sql_endpoint_id must be a GUID"
                return target
    else:
        if _placeholder(target.server):
            target.state, target.reason = "unconfigured", "server not set"
            return target
        if "," in target.server or ":" in target.server:
            target.state, target.reason = "invalid", "server is a host name only (no port)"
            return target
        if not spec["host"].match(target.server):
            target.state, target.reason = "invalid", (
                f"server {target.server!r} does not match the {target.kind} host pattern"
            )
            return target
        if target.workspace_id or target.item_id or target.sql_endpoint_id:
            target.state, target.reason = "invalid", f"{target.kind} takes no Fabric ids"
            return target
    if target.read_scale_replicas and target.kind != "azure_sql":
        target.state, target.reason = "invalid", "read_scale_replicas applies to azure_sql only"
        return target
    target.state, target.reason = "ready", ""
    return target


def parse_sql_targets(project: Any) -> SqlTargets:
    """Parse the `sql_targets:` section of a loaded contract (never raises)."""
    result = SqlTargets()
    if not isinstance(project, dict):
        return result
    raw = project.get("sql_targets")
    if raw is None:
        return result
    result.configured = True
    if not isinstance(raw, dict):
        result.errors.append("sql_targets must be a mapping")
        return result
    unknown = sorted(str(k) for k in raw if str(k) not in ENVIRONMENTS and str(k) != "default_environment")
    if unknown:
        result.errors.append(
            f"sql_targets has unknown entries ({', '.join(unknown)}); environments are dev, test, prod"
        )
    for env in ENVIRONMENTS:
        if env in raw:
            result.targets[env] = parse_target(env, raw.get(env))
    default = _text(raw.get("default_environment")).lower()
    if not default:
        default = "dev" if "dev" in result.targets else ""
        if default:
            result.errors.append("sql_targets.default_environment is not set; coop assumes dev")
    if default == PRODUCTION_ENVIRONMENT:
        result.errors.append("sql_targets.default_environment must never be prod (production is explicit-approval only)")
        default = ""
    elif default and default not in DEFAULTABLE_ENVIRONMENTS:
        result.errors.append(f"sql_targets.default_environment {default!r} is not dev or test")
        default = ""
    elif default and default not in result.targets:
        result.errors.append(f"sql_targets.default_environment is {default} but no {default} entry exists")
        default = ""
    result.default_environment = default
    for env, target in result.targets.items():
        if target.state == "invalid":
            result.errors.append(f"sql_targets.{env}: {target.reason}")
    return result


def load_project(path: Path | None) -> dict[str, Any]:
    if not path or not path.is_file() or load_yaml is None:
        return {}
    try:
        data = load_yaml(str(path))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def find_project_yml(start: Path) -> Path | None:
    d = start.resolve()
    for _ in range(8):
        p = d / ".coop" / "project.yml"
        if p.is_file():
            return p
        if d.parent == d:
            break
        d = d.parent
    # The launcher's answer (COOP_PROJECT_YML, bin/coop.ps1): the contract in the
    # client home repository beside this one (master plan C1).
    launched = os.environ.get("COOP_PROJECT_YML", "")
    if launched and Path(launched).is_file():
        return Path(launched)
    return None


def doctor_lines(targets: SqlTargets) -> list[tuple[str, str, str]]:
    """(level, name, hint) rows for doctor's Project contract section."""
    rows: list[tuple[str, str, str]] = []
    if not targets.configured:
        rows.append((
            "ok",
            "sql_targets not configured (SQL work follows fabric: / the managed SQL endpoint)",
            "",
        ))
        return rows
    for error in targets.errors:
        rows.append(("warn", error, "fix sql_targets in .coop/project.yml"))
    for env in ENVIRONMENTS:
        target = targets.targets.get(env)
        if not target:
            continue
        marker = " (default)" if env == targets.default_environment else ""
        if target.state == "ready":
            where = target.server or f"{target.workspace_id}/{target.item_id}"
            rows.append(("ok", f"sql_targets.{env}{marker}: {target.label} {where} / {target.database}", ""))
        elif target.state == "unconfigured":
            rows.append(("warn", f"sql_targets.{env}{marker}: {target.reason}", "complete the entry in .coop/project.yml"))
    if targets.targets and not targets.default:
        rows.append((
            "warn",
            "sql_targets: no ready default environment (dev or test)",
            "set sql_targets.default_environment and complete that entry",
        ))
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sql_targets")
    parser.add_argument("--project", type=Path, default=None, help="path to .coop/project.yml")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("doctor-lines", help="level<TAB>name<TAB>hint rows for coop doctor")
    sub.add_parser("show", help="the parsed section as JSON")
    sub.add_parser("default", help="the ready default target as JSON (exit 1 when none)")
    args = parser.parse_args(argv)
    project_path = args.project or find_project_yml(Path.cwd())
    targets = parse_sql_targets(load_project(project_path))
    if args.cmd == "doctor-lines":
        for level, name, hint in doctor_lines(targets):
            sys.stdout.write(f"{level}\t{name}\t{hint}\n")
        return 0
    if args.cmd == "show":
        print(json.dumps(targets.to_json(), indent=2, sort_keys=True))
        return 0
    if args.cmd == "default":
        target = targets.default
        if not target:
            print("{}")
            return 1
        print(json.dumps(asdict(target), sort_keys=True))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
