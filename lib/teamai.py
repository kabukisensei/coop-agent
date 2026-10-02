#!/usr/bin/env python3
"""TeamAI shared knowledge, K1 (master plan Phase 7, revision 2.0 section 8.2):
an isolated copy of the exact pinned `teamai-cli` artifact, explicit bounded
synchronization and read-only recall with provenance. Nothing here runs on launch.

Isolation (what the CLI touches and where coop sends it):

- The CLI resolves its home from HOME, then USERPROFILE, then os.homedir(), and
  keeps `~/.teamai` (config, team-repo clone, learnings, indices, logs) and the
  AI-tool resource destinations it injects into (`~/.claude/...`) under that home.
  Every child process this adapter starts gets HOME and USERPROFILE pointed at
  `<profile dir>/teamai/home`, so the data home and the resource destinations
  both land inside coop's isolated root, never in the user's real home, the
  stable coop profile, or another agent's directories.
- The package is installed with `npm install --prefix <profile dir>/teamai/pkg`
  (never `-g`) and run as `node <pkg>/node_modules/teamai-cli/dist/index.js`.
  A `teamai` on PATH is never used.
- The working directory is a disposable `<profile dir>/teamai/workspace`; the
  CLI's project scope (`<cwd>/.teamai`, `<cwd>/.claude`) therefore cannot reach a
  work repository.
- TEAMAI_HOOKS_DISABLED=1 (no hook installation into AI-tool settings),
  TEAMAI_RECALL_DISABLED=1 (no recall-quality recording) and `--dry-run` on recall
  (no auto-upvote writes). Every TEAMAI_* / CLAUDE_* variable of the parent is
  dropped from the child environment.
- Every call has a hard timeout (COOP_TEAMAI_TIMEOUT_SECONDS, default 60) and
  no stdin; on timeout the process tree is killed and the state is `unavailable`.

Config (`<profile dir>/config`, written by `coop onboard --config-only`):

    "knowledge": { "teamai": { "enabled": false, "team_repo": "", "provider": "git", "role": "" } }

States every command reports on stdout as one JSON document (exit 0 for every
reported state; 2 for a malformed invocation; 1 when the adapter itself fails):
`disabled`, `not_installed`, `not_initialized`, `ok`, `no_match`, `partial`,
`unavailable`. `stale` is a flag next to the state, never a state: results are
still returned, with the age of the last successful pull.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import coop_paths  # noqa: E402

try:
    import _yaml  # noqa: E402
except Exception:  # pragma: no cover - the reader ships next to this file
    _yaml = None

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2

PACKAGE_DEFAULT = "teamai-cli"
DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 600
RESULT_CAP = 5
STALE_AFTER_SECONDS = 7 * 24 * 3600
STATE_FILE = "state.json"

# The CLI's own result delimiters (dist formatResults).
RECALL_START = "--- [teamai:recall:start] ---"
RECALL_END = "--- [teamai:recall:end] ---"
HEADER_RE = re.compile(r"^\[(\d+)/(\d+)\]\s+(?:\[(?P<type>[a-z]+)\]\s+)?(?P<title>.*?)(?:\s+★(?P<votes>\d+))?(?:\s+\[(?P<scope>[a-z]+)\])?\s*$")


# --- paths and config ---------------------------------------------------------

def manifest_pin(root: Path | None = None) -> tuple[str, str]:
    """(package, version) from config/release-manifest.json `teamai`."""
    root = root or HERE.parent
    try:
        with open(root / "config" / "release-manifest.json", "r", encoding="utf-8-sig") as fh:
            m = json.load(fh)
        t = m.get("teamai") or {}
        pkg = str(t.get("package") or PACKAGE_DEFAULT)
        ver = str(t.get("version") or "")
        return pkg, ver
    except Exception:
        return PACKAGE_DEFAULT, ""


def teamai_root() -> Path:
    return coop_paths.profile_dir() / "teamai"


def pkg_prefix() -> Path:
    return teamai_root() / "pkg"


def isolated_home() -> Path:
    return teamai_root() / "home"


def workspace() -> Path:
    return teamai_root() / "workspace"


def state_path() -> Path:
    return teamai_root() / STATE_FILE


def cli_entry(package: str) -> Path:
    return pkg_prefix() / "node_modules" / package / "dist" / "index.js"


def load_block() -> dict:
    """The `knowledge.teamai` block of the fleet config ({} when absent/malformed)."""
    try:
        with open(coop_paths.config_path(), "r", encoding="utf-8-sig") as fh:
            cfg = json.load(fh)
    except Exception:
        return {}
    k = cfg.get("knowledge") if isinstance(cfg, dict) else None
    t = k.get("teamai") if isinstance(k, dict) else None
    return t if isinstance(t, dict) else {}


def enabled(block: dict | None = None) -> bool:
    block = load_block() if block is None else block
    v = block.get("enabled", False)
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


def redact_url(url: str) -> str:
    """Strip userinfo (tokens) from a Git URL before it reaches any output."""
    url = (url or "").strip()
    if not url:
        return ""
    if "://" in url:
        try:
            parts = urlsplit(url)
            host = parts.hostname or ""
            if parts.port:
                host = f"{host}:{parts.port}"
            return urlunsplit((parts.scheme, host, parts.path, "", ""))
        except Exception:
            return "<redacted>"
    # scp-like git@host:group/repo.git carries no secret
    return url


def timeout_seconds() -> int:
    raw = os.environ.get("COOP_TEAMAI_TIMEOUT_SECONDS", "").strip()
    try:
        n = int(raw) if raw else DEFAULT_TIMEOUT
    except ValueError:
        n = DEFAULT_TIMEOUT
    return max(1, min(MAX_TIMEOUT, n))


def read_state() -> dict:
    try:
        with open(state_path(), "r", encoding="utf-8") as fh:
            s = json.load(fh)
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def write_state(update: dict) -> None:
    s = read_state()
    s.update(update)
    teamai_root().mkdir(parents=True, exist_ok=True)
    tmp = state_path().with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(s, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, state_path())


# --- bounded child processes ------------------------------------------------

def child_env(home: Path) -> dict:
    """The environment every TeamAI child gets: isolated home, no hooks, no
    recall-quality writes, no inherited TeamAI/Claude settings or tokens."""
    env = {}
    for k, v in os.environ.items():
        ku = k.upper()
        if ku.startswith("TEAMAI_") or ku.startswith("CLAUDE_") or ku.startswith("GIT_CONFIG_") or ku in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "OPENCLAW_STATE_DIR"):
            continue
        env[k] = v
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    env["XDG_CONFIG_HOME"] = str(home / ".config")
    env["CLAUDE_CONFIG_DIR"] = str(home / ".claude")
    env["TEAMAI_HOOKS_DISABLED"] = "1"
    env["TEAMAI_RECALL_DISABLED"] = "1"
    env["TEAMAI_PACKAGE_HINT_DISABLED"] = "1"
    env["TEAMAI_MR_HINT_DISABLED"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["CI"] = "1"
    return env


PUSH_GUARD_PREFIXES = ("https://", "http://", "ssh://", "git@")


def push_guard_env() -> dict:
    """Environment-scoped git config (GIT_CONFIG_COUNT, git 2.31+) that rewrites
    every push URL to the unusable `no-push://` scheme. The CLI's own git
    children inherit it, so nothing the CLI does (member registration on
    `teamai-reports`, `contribute`, `push`) can reach the team repository;
    fetch and pull are untouched. coop's own staging push (K2) runs without it."""
    env = {"GIT_CONFIG_COUNT": str(len(PUSH_GUARD_PREFIXES))}
    for i, prefix in enumerate(PUSH_GUARD_PREFIXES):
        env[f"GIT_CONFIG_KEY_{i}"] = "url.no-push://.pushInsteadOf"
        env[f"GIT_CONFIG_VALUE_{i}"] = prefix
    return env


def _kill_tree(proc: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=15)
        else:
            import signal

            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def run_bounded(argv: list[str], cwd: Path, env: dict, timeout: int) -> dict:
    """Run argv with no stdin and a hard deadline. Returns {rc, stdout, stderr,
    timed_out, error}; a missing executable is an error, never an exception."""
    popen_kwargs: dict = dict(
        cwd=str(cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(argv, **popen_kwargs)
    except OSError as exc:
        return {"rc": None, "stdout": "", "stderr": "", "timed_out": False, "error": str(exc)}
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=10)
        except Exception:
            out, err = b"", b""
        return {
            "rc": None,
            "stdout": out.decode("utf-8", "replace"),
            "stderr": err.decode("utf-8", "replace"),
            "timed_out": True,
            "error": f"timed out after {timeout}s",
        }
    return {
        "rc": proc.returncode,
        "stdout": out.decode("utf-8", "replace"),
        "stderr": err.decode("utf-8", "replace"),
        "timed_out": False,
        "error": "",
    }


def node_exe() -> str:
    return os.environ.get("COOP_NODE_BIN", "").strip() or shutil.which("node") or ""


def npm_argv() -> list[str]:
    explicit = os.environ.get("COOP_NPM_BIN", "").strip()
    if explicit:
        return [explicit]
    found = shutil.which("npm.cmd") if os.name == "nt" else None
    found = found or shutil.which("npm")
    return [found] if found else []


def run_cli(args: list[str], package: str, timeout: int | None = None, cwd: Path | None = None) -> dict:
    """Run the isolated CLI (never PATH's teamai)."""
    entry = cli_entry(package)
    node = node_exe()
    if not node:
        return {"rc": None, "stdout": "", "stderr": "", "timed_out": False, "error": "node is not available"}
    if not entry.is_file():
        return {"rc": None, "stdout": "", "stderr": "", "timed_out": False, "error": f"isolated CLI missing: {entry}"}
    home = isolated_home()
    ws = cwd or workspace()
    home.mkdir(parents=True, exist_ok=True)
    ws.mkdir(parents=True, exist_ok=True)
    env = child_env(home)
    env.update(push_guard_env())
    return run_bounded([node, str(entry)] + args, ws, env, timeout or timeout_seconds())


# --- facts --------------------------------------------------------------------

def installed_version(package: str) -> str:
    """Version of the isolated package from its package.json ('' when absent)."""
    pj = pkg_prefix() / "node_modules" / package / "package.json"
    try:
        with open(pj, "r", encoding="utf-8") as fh:
            return str(json.load(fh).get("version") or "")
    except Exception:
        return ""


def local_config() -> dict:
    """The CLI's `~/.teamai/config.yaml` under the isolated home ({} when absent)."""
    path = isolated_home() / ".teamai" / "config.yaml"
    if not path.is_file() or _yaml is None:
        return {}
    try:
        data = _yaml.load(str(path))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def initialized() -> bool:
    cfg = local_config()
    repo = cfg.get("repo") if isinstance(cfg.get("repo"), dict) else {}
    return bool(cfg) and bool(repo.get("localPath") or repo.get("url") or repo.get("local_path"))


def team_repo_local_path() -> Path | None:
    cfg = local_config()
    repo = cfg.get("repo") if isinstance(cfg.get("repo"), dict) else {}
    raw = str(repo.get("localPath") or repo.get("local_path") or "")
    if not raw:
        return None
    if raw.startswith("~"):
        raw = str(isolated_home()) + raw[1:]
    p = Path(raw)
    if not p.is_absolute():
        p = isolated_home() / p
    return p


def team_repo_revision(timeout: int = 10) -> str:
    """Short HEAD of the isolated team-repo clone ('' when unknown)."""
    path = team_repo_local_path()
    git = shutil.which("git")
    if not path or not path.is_dir() or not git:
        return ""
    r = run_bounded([git, "-C", str(path), "rev-parse", "--short", "HEAD"], path, child_env(isolated_home()), timeout)
    if r.get("rc") == 0:
        return r["stdout"].strip()
    return ""


def staleness(state: dict) -> dict:
    """{stale, last_pull_at, age_seconds} from the adapter's own pull stamp."""
    last = state.get("last_pull_at")
    if not last:
        return {"stale": True, "last_pull_at": None, "age_seconds": None}
    try:
        then = datetime.fromisoformat(str(last).replace("Z", "+00:00")).timestamp()
    except Exception:
        return {"stale": True, "last_pull_at": last, "age_seconds": None}
    age = max(0, int(time.time() - then))
    return {"stale": age > STALE_AFTER_SECONDS, "last_pull_at": last, "age_seconds": age}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def base_doc(command: str, block: dict, package: str, pin: str) -> dict:
    return {
        "schema_version": 1,
        "command": command,
        "state": "",
        "enabled": enabled(block),
        "package": package,
        "pin": pin,
        "installed_version": installed_version(package),
        "team_repo": redact_url(str(block.get("team_repo") or "")),
        "provider": str(block.get("provider") or "git"),
        "roots": {
            "pkg": str(pkg_prefix()),
            "home": str(isolated_home()),
            "workspace": str(workspace()),
        },
        "warnings": [],
    }


def not_initialized_detail(doc: dict) -> str:
    """The real next step when the isolated home is not initialized yet."""
    repo = str(doc.get("team_repo") or "").strip()
    if not repo:
        return "set knowledge.teamai.team_repo (coop onboard --config-only), then run: coop teamai init"
    last = str(read_state().get("last_init_error") or "").strip()
    if last:
        return f"the last init failed: {redact_url(last)}; fix the team repo access, then run: coop teamai init"
    return "run: coop teamai init"


def gate(doc: dict, package: str, need_init: bool = True) -> str | None:
    """The state that stops a command before the CLI runs, or None.
    A not_initialized stop carries a detail naming the real next step."""
    if not doc["enabled"]:
        return "disabled"
    if not doc["installed_version"] or not cli_entry(package).is_file():
        return "not_installed"
    if need_init and not initialized():
        doc["detail"] = not_initialized_detail(doc)
        return "not_initialized"
    return None


# --- commands -----------------------------------------------------------------

def cmd_status(block: dict, package: str, pin: str) -> dict:
    doc = base_doc("status", block, package, pin)
    doc["initialized"] = initialized()
    doc["revision"] = team_repo_revision() if doc["initialized"] else ""
    doc.update(staleness(read_state()))
    g = gate(doc, package)
    if g:
        doc["state"] = g
        doc["stale"] = False if g != "ok" else doc["stale"]
        return doc
    if doc["installed_version"] and pin and doc["installed_version"] != pin:
        doc["warnings"].append(f"installed {doc['installed_version']} differs from the manifest pin {pin}; run: coop teamai install")
    doc["state"] = "ok"
    return doc


def cmd_install(block: dict, package: str, pin: str) -> dict:
    doc = base_doc("install", block, package, pin)
    if not doc["enabled"]:
        doc["state"] = "disabled"
        return doc
    if not pin:
        doc["state"] = "unavailable"
        doc["warnings"].append("no manifest pin for teamai (config/release-manifest.json `teamai.version`)")
        return doc
    if doc["installed_version"] == pin and cli_entry(package).is_file():
        doc["state"] = "ok"
        doc["detail"] = f"{package} {pin} already installed in the isolated prefix"
        return doc
    npm = npm_argv()
    if not npm:
        doc["state"] = "unavailable"
        doc["warnings"].append("npm is not available")
        return doc
    prefix = pkg_prefix()
    prefix.mkdir(parents=True, exist_ok=True)
    env = child_env(isolated_home())
    env["npm_config_update_notifier"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_audit"] = "false"
    argv = npm + ["install", "--prefix", str(prefix), "--no-save", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", f"{package}@{pin}"]
    # The prefix is a bare directory: give npm a package.json so --prefix installs there.
    pj = prefix / "package.json"
    if not pj.is_file():
        with open(pj, "w", encoding="utf-8") as fh:
            json.dump({"name": "coop-teamai-isolated", "private": True, "version": "0.0.0"}, fh, indent=2)
            fh.write("\n")
    r = run_bounded(argv, prefix, env, max(timeout_seconds(), 300))
    doc["installed_version"] = installed_version(package)
    if r["timed_out"] or r["rc"] != 0 or doc["installed_version"] != pin:
        doc["state"] = "unavailable"
        why = r["error"] or f"npm exit {r['rc']}"
        tail = (r["stderr"] or r["stdout"]).strip().splitlines()[-1:] or [""]
        doc["warnings"].append(f"npm install of {package}@{pin} failed ({why}): {tail[0][:200]}")
        return doc
    write_state({"installed_at": now_iso(), "installed_version": pin})
    doc["state"] = "ok"
    doc["detail"] = f"{package} {pin} installed in the isolated prefix"
    return doc


def cmd_init(block: dict, package: str, pin: str) -> dict:
    doc = base_doc("init", block, package, pin)
    g = gate(doc, package, need_init=False)
    if g:
        doc["state"] = g
        return doc
    if initialized():
        doc["state"] = "ok"
        doc["detail"] = "already initialized against the configured team repo"
        doc["revision"] = team_repo_revision()
        return doc
    repo = str(block.get("team_repo") or "").strip()
    if not repo:
        doc["state"] = "not_initialized"
        doc["warnings"].append("knowledge.teamai.team_repo is empty: set the sandbox team repository URL first (coop onboard --config-only)")
        return doc
    provider = str(block.get("provider") or "git").strip() or "git"
    role = str(block.get("role") or "").strip()
    args = ["init", repo, "--provider", provider, "--scope", "user", "--agent", "claude"]
    if role:
        args += ["--role", role]
    r = run_cli(args, package, timeout=max(timeout_seconds(), 180))
    if r["timed_out"] or r["error"] or r["rc"] != 0 or not initialized():
        doc["state"] = "unavailable"
        failure = summarize_failure("teamai init", r)
        doc["warnings"].append(failure)
        write_state({"last_init_error": failure, "last_init_at": now_iso()})
        return doc
    write_state({"initialized_at": now_iso(), "last_init_error": "", "last_init_at": now_iso()})
    doc["state"] = "ok"
    doc["revision"] = team_repo_revision()
    doc["detail"] = "initialized in the isolated home against the configured team repo"
    return doc


def cmd_pull(block: dict, package: str, pin: str) -> dict:
    doc = base_doc("pull", block, package, pin)
    g = gate(doc, package)
    if g:
        doc["state"] = g
        return doc
    r = run_cli(["pull", "--silent"], package, timeout=max(timeout_seconds(), 180))
    if r["timed_out"] or r["error"] or r["rc"] != 0:
        doc["state"] = "unavailable"
        doc["warnings"].append(summarize_failure("teamai pull", r))
        doc.update(staleness(read_state()))
        return doc
    write_state({"last_pull_at": now_iso()})
    doc["state"] = "ok"
    doc["revision"] = team_repo_revision()
    doc.update(staleness(read_state()))
    return doc


def parse_recall(stdout: str) -> list[dict]:
    """Entries from the CLI's text output (title, type, scope, votes, author, date,
    score, tags, file, snippet). Unknown lines are ignored; nothing is inferred."""
    lines = stdout.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith(RECALL_START))
    except StopIteration:
        return []
    entries: list[dict] = []
    cur: dict | None = None
    for line in lines[start + 1 :]:
        if line.startswith(RECALL_END) or line.startswith("--- Candidate change files ---"):
            break
        m = HEADER_RE.match(line)
        if m:
            cur = {
                "title": m.group("title").strip(),
                "type": m.group("type") or "",
                "scope": m.group("scope") or "",
                "votes": int(m.group("votes") or 0),
                "author": "",
                "date": "",
                "score": None,
                "tags": [],
                "file": "",
                "snippet": "",
            }
            entries.append(cur)
            continue
        if cur is None:
            continue
        if line.startswith("Author: "):
            parts = [p.strip() for p in line[len("Author: ") :].split("|")]
            for p in parts:
                if p.startswith("Date: "):
                    cur["date"] = p[6:].strip()
                elif p.startswith("Score: "):
                    try:
                        cur["score"] = float(p[7:].strip())
                    except ValueError:
                        cur["score"] = None
                else:
                    cur["author"] = p
        elif line.startswith("Tags: "):
            cur["tags"] = [t.strip() for t in line[6:].split(",") if t.strip()]
        elif line.startswith("File: "):
            cur["file"] = line[6:].strip()
        elif line.startswith("Snippet: "):
            cur["snippet"] = line[9:].strip()[:400]
    return entries


def summarize_failure(what: str, r: dict) -> str:
    if r.get("timed_out"):
        return f"{what} {r['error']}"
    if r.get("error"):
        return f"{what}: {r['error']}"
    tail = [l for l in (r.get("stderr") or r.get("stdout") or "").strip().splitlines() if l.strip()]
    last = tail[-1][:200] if tail else ""
    return f"{what} exited {r.get('rc')}" + (f": {last}" if last else "")


def cmd_recall(block: dict, package: str, pin: str, query: str) -> dict:
    doc = base_doc("recall", block, package, pin)
    doc["query"] = query
    doc["results"] = []
    doc["result_cap"] = RESULT_CAP
    doc["truncated"] = False
    g = gate(doc, package)
    if g:
        doc["state"] = g
        return doc
    state = read_state()
    doc.update(staleness(state))
    doc["revision"] = team_repo_revision()
    r = run_cli(["recall", "--dry-run", query], package)
    if r["timed_out"] or r["error"] or r["rc"] != 0:
        doc["state"] = "unavailable"
        doc["warnings"].append(summarize_failure("teamai recall", r))
        return doc
    text = r["stdout"]
    if "No learnings available" in text:
        if not doc["last_pull_at"]:
            doc["state"] = "not_initialized"
            doc["warnings"].append("the isolated clone holds no learnings yet; run: coop teamai pull")
        else:
            doc["state"] = "no_match"
            doc["warnings"].append(f"the team repository has no learnings yet (pulled {doc['last_pull_at']} @ {doc.get('revision') or 'unknown'}): nothing to recall")
        return doc
    entries = parse_recall(text)
    if "code graph retrieval unavailable" in (r["stderr"] + text):
        doc["warnings"].append("code-graph retrieval unavailable; learnings only")
        partial = True
    else:
        partial = False
    if not entries:
        doc["state"] = "no_match"
        return doc
    doc["truncated"] = len(entries) > RESULT_CAP
    for e in entries[:RESULT_CAP]:
        e["repository"] = doc["team_repo"]
        e["revision"] = doc["revision"]
    doc["results"] = entries[:RESULT_CAP]
    doc["state"] = "partial" if partial else "ok"
    return doc


# --- CLI ------------------------------------------------------------------------

USAGE = "usage: teamai.py <status|install|init|pull|recall --query <text>>"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE, file=sys.stderr)
        return EXIT_USAGE
    command = argv[0]
    query = ""
    if command == "recall":
        rest = argv[1:]
        if len(rest) >= 2 and rest[0] == "--query":
            query = " ".join(rest[1:]).strip()
        else:
            query = " ".join(rest).strip()
        if not query:
            print("error: recall needs --query <text>", file=sys.stderr)
            return EXIT_USAGE
    elif command not in ("status", "install", "init", "pull"):
        print(f"error: unknown command {command!r}\n{USAGE}", file=sys.stderr)
        return EXIT_USAGE
    elif argv[1:]:
        print(f"error: {command} takes no arguments", file=sys.stderr)
        return EXIT_USAGE
    block = load_block()
    package, pin = manifest_pin()
    try:
        if command == "status":
            doc = cmd_status(block, package, pin)
        elif command == "install":
            doc = cmd_install(block, package, pin)
        elif command == "init":
            doc = cmd_init(block, package, pin)
        elif command == "pull":
            doc = cmd_pull(block, package, pin)
        else:
            doc = cmd_recall(block, package, pin, query)
    except Exception as exc:  # the adapter itself failed: say so, never a traceback on stdout
        print(f"error: teamai adapter failed: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    # ASCII-only JSON: safe on a cp1252 Windows console and for every PowerShell caller.
    sys.stdout.write(json.dumps(doc, indent=2) + "\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
