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


def machine_profile_dir() -> Path:
    """The machine-level profile folder (master plan P1): COOP_MACHINE_DIR, else
    `%ProgramData%\\coop` on Windows and `/etc/coop` elsewhere. Mirror of
    lib/paths.mjs machineProfileDir."""
    configured = _env("COOP_MACHINE_DIR")
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        return Path(_env("ProgramData") or r"C:\ProgramData") / "coop"
    return Path("/etc/coop")


def machine_profile_path() -> Path:
    """The machine-level profile file: `<machine dir>/user.json` (name and
    communication preference only; the per-user file wins field by field)."""
    return machine_profile_dir() / "user.json"


def coop_agent_dir() -> Path:
    """coop's ISOLATED Pi agent dir: COOP_AGENT_DIR, else `<profile dir>/agent`.

    Mirror of Get-CoopPiAgentDir (what the launcher exports as PI_CODING_AGENT_DIR).
    """
    configured = _env("COOP_AGENT_DIR")
    return Path(configured).expanduser() if configured else profile_dir() / "agent"


def personal_pi_agent_dir() -> Path:
    """The user's own Pi agent dir (`~/.pi/agent`); loaded with COOP_NO_ISOLATE."""
    return home_dir() / ".pi" / "agent"


def managed_mcp_config() -> Path:
    """The managed MCP config this launch's Pi loaded: the launch folder's own
    copy (COOP_MCP_CONFIG, an `<agent dir>/mcp/<12 hex>.json` file that coop
    passed to Pi as --mcp-config), else the shared mcp-adapter.json. Anything
    else in the variable is ignored."""
    base = agent_dir()
    configured = _env("COOP_MCP_CONFIG")
    if configured:
        path = Path(configured)
        same = os.path.normcase(os.path.abspath(path.parent)) == os.path.normcase(os.path.abspath(base / "mcp"))
        if same and re.fullmatch(r"[0-9a-f]{12}\.json", path.name):
            return path
    return base / "mcp-adapter.json"


def agent_dir() -> Path:
    """The agent dir Pi will ACTUALLY load (mirror of Get-CoopEffectiveAgentDir)."""
    configured = _env("PI_CODING_AGENT_DIR")
    if configured:
        return Path(configured).expanduser()
    if no_isolate():
        return personal_pi_agent_dir()
    return coop_agent_dir()


# --- File tiers (F2) -----------------------------------------------------------
# coop keeps its files in three places, named the same way everywhere coop speaks:
# this machine (machine_profile_dir: the program, the standards, the person's name
# and preferences), this client (profile_dir: sessions, memory, backups, drafts)
# and the repository (<repo>/.coop: the team's project file, client skills and
# prompts). Mirrors of lib/paths.mjs standardsLocation / backupDirFor /
# draftsDirFor / repositoryCoopDir and the Get-Coop* helpers in lib/common.ps1.


def dir_writable(path: Path) -> bool:
    """True when `path` exists and this process can create a file in it (the one
    honest test on Windows, where os.access says yes to every existing folder)."""
    try:
        if not path.is_dir():
            return False
        probe = path / f".coop-write-probe-{os.getpid()}-{os.urandom(4).hex()}"
        with open(probe, "x", encoding="utf-8"):
            pass
        probe.unlink()
        return True
    except OSError:
        return False


def standards_location() -> tuple[Path, str]:
    """Where the standards live, as (root, tier). COOP_STANDARDS_ROOT names the
    canonical checkout as it always has, so the root is its parent ("override");
    else `<machine dir>/standards` when that folder exists and is writable
    ("machine"); else `<profile dir>/standards` ("client")."""
    override = _env("COOP_STANDARDS_ROOT")
    if override:
        return Path(override).expanduser().resolve().parent, "override"
    machine = machine_profile_dir() / "standards"
    if dir_writable(machine):
        return machine, "machine"
    return profile_dir() / "standards", "client"


def standards_root() -> Path:
    """The standards root folder (see standards_location)."""
    return standards_location()[0]


def backups_root() -> Path:
    """This client's backups: `<profile dir>/backups` (one folder per repository)."""
    return profile_dir() / "backups"


def drafts_root() -> Path:
    """This client's drafts: `<profile dir>/drafts` (one folder per repository)."""
    return profile_dir() / "drafts"


def git_root_above(path: Path) -> Path | None:
    """The git root at or above `path`, or None."""
    at = Path(path).resolve()
    while True:
        if (at / ".git").exists():
            return at
        if at.parent == at:
            return None
        at = at.parent


def _contract_above(path: Path) -> Path | None:
    at = Path(path).resolve()
    while True:
        candidate = at / ".coop" / "project.yml"
        if candidate.is_file():
            return candidate
        if at.parent == at:
            return None
        at = at.parent


def _contract_repositories(text: str) -> list[tuple[str, str]]:
    """`repositories.<name>.local_path` entries of a block-YAML contract (a line scan)."""
    out: list[tuple[str, str]] = []
    in_repos = False
    name = ""
    for line in text.splitlines():
        if re.match(r"^\S", line):
            in_repos = bool(re.match(r"^repositories:\s*(#.*)?$", line))
            name = ""
            continue
        if not in_repos:
            continue
        key = re.match(r"^  ([A-Za-z0-9_.-]+):\s*(#.*)?$", line)
        if key:
            name = key.group(1)
            continue
        local = re.match(r"^\s+local_path:\s*(.+?)\s*$", line)
        if local and name:
            value = local.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if value and not value.startswith("TODO"):
                out.append((name, value))
    return out


def repository_name_for(path: Path | str) -> str:
    """The name of the repository holding `path`: the project file's `repositories`
    key whose local_path is that repository, else its git root's basename, else
    the basename of the file's own folder."""
    full = Path(path).resolve()
    directory = full if full.is_dir() else full.parent
    git_root = git_root_above(directory)
    if git_root is None:
        # No git: the folder whose .coop/project.yml is nearest above, else the folder itself.
        above = _contract_above(directory)
        folder = above.parent.parent if above is not None else directory
        return folder.name or "root"
    configured = _env("COOP_PROJECT_YML")
    contract = Path(configured) if configured and Path(configured).is_file() else _contract_above(git_root)
    if contract is not None:
        root = contract.resolve().parent.parent
        try:
            text = contract.read_text(encoding="utf-8")
        except OSError:
            text = ""
        for name, local_path in _contract_repositories(text):
            expanded = Path(os.path.expanduser(local_path)) if local_path.startswith("~") else Path(local_path)
            candidate = (root / expanded).resolve()
            if os.path.normcase(str(candidate)) == os.path.normcase(str(git_root)):
                return name
    return git_root.name or "root"


def backup_dir_for(path: Path | str) -> Path:
    """Where backups of `path` go: `<profile dir>/backups/<repository name>`."""
    return backups_root() / repository_name_for(path)


def drafts_dir_for(path: Path | str) -> Path:
    """Where drafts beside `path` go: `<profile dir>/drafts/<repository name>`."""
    return drafts_root() / repository_name_for(path)


def repository_coop_dir(cwd: Path | str) -> Path:
    """The repository's `.coop` folder for a launch in `cwd`: the folder of the
    project file coop uses there (COOP_PROJECT_YML, else the nearest one at or
    above), else `<git root>/.coop`, else `<cwd>/.coop`."""
    root = Path(cwd).resolve()
    configured = _env("COOP_PROJECT_YML")
    if configured and Path(configured).is_file():
        return Path(configured).resolve().parent
    above = _contract_above(root)
    if above is not None:
        return above.parent
    return (git_root_above(root) or root) / ".coop"
