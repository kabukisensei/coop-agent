#!/usr/bin/env python3
"""One profile root (master plan S3, issue #220): lib/coop_paths.py and every
Python reader that goes through it resolve the profile locations from ONE
meaning of the variables.

  COOP_DIR is the PARENT of .coop: profile_dir() = $COOP_DIR/.coop (default
  ~/.coop); config_path() / user_profile_path() hang off it.
  The agent dir is one chain: PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE truthy
  (1|true|yes|on, any case) -> ~/.pi/agent -> COOP_AGENT_DIR -> <profile>/agent.

Mirrors tests/fixtures/profile-root.test.ps1 and tests/paths.test.mjs. Offline;
reads nothing outside a temp dir (the home is a temp dir too).
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(ROOT / "scripts"))
import coop_paths  # noqa: E402

LOCATION_VARS = ("COOP_DIR", "COOP_AGENT_DIR", "PI_CODING_AGENT_DIR", "COOP_NO_ISOLATE")
passed = 0

# Windows runners default stdout to cp1252, which cannot encode the check mark.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def ok(label: str) -> None:
    global passed
    passed += 1
    print(f"  ✓ {label}")


def load(name: str, path: Path):
    """Import a script fresh under the CURRENT environment (module-level paths)."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def env(home: Path, **overrides: str) -> dict[str, str]:
    """A clean location environment: temp home, no location vars, then overrides."""
    base = {k: v for k, v in os.environ.items() if k not in LOCATION_VARS}
    base["HOME"] = str(home)
    base["USERPROFILE"] = str(home)
    base.update(overrides)
    return base


with tempfile.TemporaryDirectory(prefix="coop-paths-") as tmp:
    root = Path(tmp).resolve()
    home = root / "home"
    cdir = root / "cdir"
    agent = root / "agent"
    pidir = root / "pidir"
    for d in (home, cdir, agent, pidir):
        d.mkdir()

    # --- no variables: the historical ~/.coop defaults -------------------------
    with mock.patch.dict(os.environ, env(home), clear=True):
        assert Path.home() == home, "the test home must be the temp home"
        assert coop_paths.profile_dir() == home / ".coop"
        assert coop_paths.config_path() == home / ".coop" / "config"
        assert coop_paths.user_profile_path() == home / ".coop" / "user.json"
        assert coop_paths.coop_agent_dir() == home / ".coop" / "agent"
        assert coop_paths.agent_dir() == home / ".coop" / "agent"
        assert coop_paths.personal_pi_agent_dir() == home / ".pi" / "agent"
        assert not coop_paths.no_isolate()
        ok("no vars: ~/.coop/{config,user.json,agent} and isolation on")

        onboard = load("onboard_defaults", ROOT / "scripts" / "onboard.py")
        assert onboard.USER_JSON == home / ".coop" / "user.json"
        assert onboard.CONFIG_JSON == home / ".coop" / "config"
        assert onboard.MCP_OUTPUT == home / ".coop" / "agent" / "mcp-adapter.json"
        ok("no vars: onboard.py writes user.json, config and the MCP config under ~/.coop")

    # --- COOP_DIR=X: X/.coop/... everywhere (X is the PARENT of .coop) ----------
    with mock.patch.dict(os.environ, env(home, COOP_DIR=str(cdir)), clear=True):
        assert coop_paths.profile_dir() == cdir / ".coop"
        assert coop_paths.config_path() == cdir / ".coop" / "config"
        assert coop_paths.user_profile_path() == cdir / ".coop" / "user.json"
        assert coop_paths.agent_dir() == cdir / ".coop" / "agent"
        ok("COOP_DIR=X: X/.coop/{config,user.json,agent}")

        onboard = load("onboard_coopdir", ROOT / "scripts" / "onboard.py")
        assert onboard.USER_JSON == cdir / ".coop" / "user.json"
        assert onboard.MCP_OUTPUT == cdir / ".coop" / "agent" / "mcp-adapter.json"
        budget = load("context_budget", ROOT / "scripts" / "context-budget.py")
        assert budget.profile_path() == cdir / ".coop" / "user.json", budget.profile_path()
        ok("COOP_DIR=X: onboard.py writes and context-budget.py reads X/.coop/user.json")

        search = load("search_knowledge", ROOT / "scripts" / "search-knowledge.py")
        assert Path(search.config_path()) == cdir / ".coop" / "config"
        import warehouse_mcp  # noqa: E402

        assert warehouse_mcp.coop_config_path() == cdir / ".coop" / "config"
        ok("COOP_DIR=X: search-knowledge.py and warehouse_mcp read X/.coop/config")

        ado = load("ado_lib_coopdir", ROOT / "scripts" / "ado_lib.py")
        assert Path(ado.DEFAULT_CONFIG) == cdir / ".coop" / "devops" / "clients.yml"
        assert ado.config_path() == ado.DEFAULT_CONFIG
        assert ado.config_path("/x/y.yml") == "/x/y.yml"
        ok("COOP_DIR=X: ado_lib defaults to X/.coop/devops/clients.yml (explicit path still wins)")

    # --- COOP_AGENT_DIR only ----------------------------------------------------
    with mock.patch.dict(os.environ, env(home, COOP_AGENT_DIR=str(agent)), clear=True):
        assert coop_paths.coop_agent_dir() == agent
        assert coop_paths.agent_dir() == agent
        assert coop_paths.profile_dir() == home / ".coop"
        ok("COOP_AGENT_DIR only: agent dir moves, profile dir stays ~/.coop")
    with mock.patch.dict(os.environ, env(home, COOP_DIR=str(cdir), COOP_AGENT_DIR=str(agent)), clear=True):
        assert coop_paths.agent_dir() == agent
        onboard = load("onboard_agentdir", ROOT / "scripts" / "onboard.py")
        assert onboard.MCP_OUTPUT == agent / "mcp-adapter.json"
        assert onboard.CONFIG_JSON == cdir / ".coop" / "config"
        ok("COOP_AGENT_DIR beats COOP_DIR/.coop/agent (onboard.py MCP output follows the chain)")

    # --- PI_CODING_AGENT_DIR wins over everything --------------------------------
    with mock.patch.dict(
        os.environ,
        env(home, COOP_DIR=str(cdir), COOP_AGENT_DIR=str(agent), PI_CODING_AGENT_DIR=str(pidir), COOP_NO_ISOLATE="1"),
        clear=True,
    ):
        assert coop_paths.agent_dir() == pidir
        assert coop_paths.coop_agent_dir() == agent, "the isolated dir itself is unchanged"
        import microsoft_skills  # noqa: E402

        assert microsoft_skills.agent_dir() == pidir
        onboard = load("onboard_pidir", ROOT / "scripts" / "onboard.py")
        assert onboard.MCP_OUTPUT == pidir / "mcp-adapter.json"
        ok("PI_CODING_AGENT_DIR wins (coop_paths, microsoft_skills, onboard.py MCP output)")

    # --- COOP_NO_ISOLATE truthiness: 1|true|yes|on, any case ---------------------
    for value in ("1", "true", "TRUE", "Yes", "on", " On "):
        with mock.patch.dict(os.environ, env(home, COOP_AGENT_DIR=str(agent), COOP_NO_ISOLATE=value), clear=True):
            assert coop_paths.no_isolate(), value
            assert coop_paths.agent_dir() == home / ".pi" / "agent", value
            assert microsoft_skills.agent_dir() == home / ".pi" / "agent", value
    for value in ("0", "false", "no", "off", "yes please", ""):
        with mock.patch.dict(os.environ, env(home, COOP_AGENT_DIR=str(agent), COOP_NO_ISOLATE=value), clear=True):
            assert not coop_paths.no_isolate(), value
            assert coop_paths.agent_dir() == agent, value
    ok("COOP_NO_ISOLATE=true/yes/on (any case) -> ~/.pi/agent; anything else keeps isolation")

    # --- fabric_sql_query reads the managed config from the chain, not only
    #     PI_CODING_AGENT_DIR ---------------------------------------------------
    import fabric_sql_query  # noqa: E402

    assert fabric_sql_query.coop_paths is coop_paths
    src = (ROOT / "lib" / "sql_query.py").read_text(encoding="utf-8")
    assert 'os.environ.get("PI_CODING_AGENT_DIR"' not in src
    assert "coop_paths.agent_dir()" in src
    ok("fabric_sql_query locates mcp-adapter.json through coop_paths.agent_dir()")

print(f"  coop-paths tests passed ({passed} checks)")
