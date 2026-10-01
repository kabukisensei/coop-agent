"""coop profile-root paths (master plan S3: one profile root).

The ONE meaning of the location variables, shared with lib/common.ps1
(Get-CoopProfileDir and friends) and lib/paths.mjs:

- COOP_DIR is the PARENT of `.coop`: the profile dir is `$COOP_DIR/.coop`,
  default `~/.coop`. It holds `config`, `user.json`, `agent/`, `support/`,
  `standards/`, `devops/`.
- The agent dir Pi actually loads is resolved by ONE chain everywhere:
  PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE truthy (1|true|yes|on, any case)
  -> ~/.pi/agent -> COOP_AGENT_DIR -> `<profile dir>/agent`.

Home is Path.home() (USERPROFILE on Windows, HOME elsewhere). With no
variables set every helper yields the historical `~/.coop/...` path.
Dependency-free; never writes.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

NO_ISOLATE_RE = re.compile(r"^(1|true|yes|on)$", re.IGNORECASE)


def _env(name: str) -> str:
    value = os.environ.get(name)
    return value.strip() if isinstance(value, str) else ""


def no_isolate() -> bool:
    """True when COOP_NO_ISOLATE is set to 1/true/yes/on (case-insensitive)."""
    return bool(NO_ISOLATE_RE.match(_env("COOP_NO_ISOLATE")))


def home_dir() -> Path:
    return Path.home()


def profile_dir() -> Path:
    """`$COOP_DIR/.coop` when COOP_DIR is set, else `~/.coop`."""
    base = _env("COOP_DIR")
    return (Path(base) if base else home_dir()) / ".coop"


def config_path() -> Path:
    """The fleet/integration config: `<profile dir>/config`."""
    return profile_dir() / "config"


def user_profile_path() -> Path:
    """The local user profile: `<profile dir>/user.json`."""
    return profile_dir() / "user.json"


def coop_agent_dir() -> Path:
    """coop's ISOLATED Pi agent dir: COOP_AGENT_DIR, else `<profile dir>/agent`.

    Mirror of Get-CoopPiAgentDir (what the launcher exports as PI_CODING_AGENT_DIR).
    """
    configured = _env("COOP_AGENT_DIR")
    return Path(configured).expanduser() if configured else profile_dir() / "agent"


def personal_pi_agent_dir() -> Path:
    """The user's own Pi agent dir (`~/.pi/agent`); loaded with COOP_NO_ISOLATE."""
    return home_dir() / ".pi" / "agent"


def agent_dir() -> Path:
    """The agent dir Pi will ACTUALLY load (mirror of Get-CoopEffectiveAgentDir)."""
    configured = _env("PI_CODING_AGENT_DIR")
    if configured:
        return Path(configured).expanduser()
    if no_isolate():
        return personal_pi_agent_dir()
    return coop_agent_dir()
