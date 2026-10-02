#!/usr/bin/env python3
"""Contract tests for lib/teamai.py (master plan K1): the isolated TeamAI adapter.

Everything runs against a stub `teamai-cli` package placed in the isolated
prefix under a temporary COOP_DIR profile. The real CLI is never installed. A
decoy `teamai` on PATH records every invocation; the adapter must never use it.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADAPTER = ROOT / "lib" / "teamai.py"
MANIFEST = json.loads((ROOT / "config" / "release-manifest.json").read_text(encoding="utf-8-sig"))
PIN = MANIFEST["teamai"]["version"]
PACKAGE = MANIFEST["teamai"]["package"]

fails = 0

# Windows runners default stdout to cp1252, which cannot encode the check mark.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def ko(msg: str) -> None:
    global fails
    fails += 1
    print(f"  ✗ {msg}")


def check(cond: bool, msg: str) -> None:
    ok(msg) if cond else ko(msg)


STUB_CLI = r"""
const fs = require('fs');
const path = require('path');
const os = require('os');
const home = process.env.HOME || '';
const log = process.env.COOP_TEST_STUB_LOG;
const mode = (() => { try { return fs.readFileSync(process.env.COOP_TEST_STUB_MODE, 'utf8').trim(); } catch (e) { return 'results'; } })();
const rec = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  home,
  userprofile: process.env.USERPROFILE || '',
  os_home: os.homedir(),
  hooks_disabled: process.env.TEAMAI_HOOKS_DISABLED || '',
  recall_disabled: process.env.TEAMAI_RECALL_DISABLED || '',
  claude_config_dir: process.env.CLAUDE_CONFIG_DIR || '',
  api_token: process.env.TEAMAI_API_TOKEN || '',
  claude_leak: process.env.CLAUDE_SECRET || '',
  git_prompt: process.env.GIT_TERMINAL_PROMPT || '',
  git_cfg: Object.keys(process.env).filter((k) => k.startsWith('GIT_CONFIG_')).sort().map((k) => k + '=' + process.env[k]).join(';'),
};
if (log) fs.appendFileSync(log, JSON.stringify(rec) + '\n');
const cmd = rec.argv[0];
if (cmd === 'init') {
  if (mode === 'init-fail') { process.stderr.write("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"); process.exit(1); }
  const dir = path.join(home, '.teamai');
  fs.mkdirSync(dir, { recursive: true });
  const repo = path.join(dir, 'team');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'repo:\n  url: ' + rec.argv[1] + '\n  localPath: ' + repo.replace(/\\/g, '/') + '\nagent: claude\n');
  // a "clone" into the isolated home, and a dirty marker the adapter must report through git
  fs.writeFileSync(path.join(repo, 'README.md'), '# sandbox\n');
  process.exit(0);
}
if (cmd === 'pull') { if (mode === 'pull-fail') { process.stderr.write('fatal: could not read from remote\n'); process.exit(1); } process.exit(0); }
if (cmd === 'recall') {
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'none') { process.stdout.write('No learnings available. Run `teamai pull` first.\n'); process.exit(0); }
  if (mode === 'crash') { process.stderr.write('Error: index corrupt\n'); process.exit(1); }
  if (mode === 'partial') { process.stderr.write('warn: code graph retrieval unavailable\n'); }
  const n = mode === 'results' || mode === 'partial' ? 7 : 2;
  let out = '--- [teamai:recall:start] --- (' + n + ' results)\n';
  for (let i = 1; i <= n; i++) {
    out += '[' + i + '/' + n + '] [learning] Marker alpha ' + i + ' ★' + (10 - i) + ' [team]\n';
    out += 'Author: Aaron | Date: 2026-09-3' + (i % 2) + ' | Score: 0.' + (9 - (i % 9)) + '\n';
    out += 'Tags: fabric, incremental\n';
    out += 'File: learnings/2026-09-30-marker-alpha-' + i + '.md\n';
    out += 'Snippet: Use a watermark per partition (alpha ' + i + ').\n\n';
  }
  out += '--- [teamai:recall:end] ---\n';
  process.stdout.write(out);
  process.exit(0);
}
process.stderr.write('stub: unknown command ' + cmd + '\n');
process.exit(2);
"""


def write_exec(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def run(env: dict, *args: str) -> tuple[int, dict | None, str]:
    r = subprocess.run([sys.executable, str(ADAPTER), *args], env=env, text=True, encoding="utf-8", errors="replace", capture_output=True, check=False)
    try:
        doc = json.loads(r.stdout) if r.stdout.strip() else None
    except json.JSONDecodeError:
        doc = None
    return r.returncode, doc, r.stderr


with tempfile.TemporaryDirectory() as raw:
    tmp = Path(raw)
    coop_dir = tmp / "profile"
    profile = coop_dir / ".coop"
    profile.mkdir(parents=True)
    stub_log = tmp / "stub.log"
    stub_mode = tmp / "mode"
    stub_mode.write_text("results", encoding="utf-8")
    real_home = tmp / "real-home"
    real_home.mkdir()

    # Decoy `teamai` on PATH: must never run.
    decoy_dir = tmp / "decoy-bin"
    decoy_marker = tmp / "decoy-ran"
    write_exec(decoy_dir / "teamai", f"#!/bin/sh\ntouch '{decoy_marker}'\nexit 0\n")

    base_env = {
        k: v for k, v in os.environ.items() if not k.upper().startswith(("TEAMAI_", "CLAUDE_"))
    }
    base_env.update(
        {
            "COOP_DIR": str(coop_dir),
            "HOME": str(real_home),
            "USERPROFILE": str(real_home),
            "PATH": f"{decoy_dir}{os.pathsep}{base_env.get('PATH', '')}",
            "COOP_TEST_STUB_LOG": str(stub_log),
            "COOP_TEST_STUB_MODE": str(stub_mode),
            "TEAMAI_API_TOKEN": "parent-secret-token",
            "TEAMAI_HOOKS_DISABLED": "0",
            "CLAUDE_SECRET": "parent-claude-secret",
            "COOP_TEAMAI_TIMEOUT_SECONDS": "20",
        }
    )

    def set_config(block: dict | None) -> None:
        cfg = {"schema_version": 1, "knowledge": {"enabled": False, "repos": []}}
        if block is not None:
            cfg["knowledge"]["teamai"] = block
        (profile / "config").write_text(json.dumps(cfg), encoding="utf-8")

    pkg_root = profile / "teamai" / "pkg" / "node_modules" / PACKAGE
    iso_home = profile / "teamai" / "home"
    workspace = profile / "teamai" / "workspace"

    def install_stub(version: str = PIN) -> None:
        (pkg_root / "dist").mkdir(parents=True, exist_ok=True)
        (pkg_root / "package.json").write_text(json.dumps({"name": PACKAGE, "version": version}), encoding="utf-8")
        (pkg_root / "dist" / "index.js").write_text(STUB_CLI, encoding="utf-8")

    print("teamai adapter (K1): states, isolation, provenance, bounds")

    # --- usage ---------------------------------------------------------------
    rc, doc, err = run(base_env)
    check(rc == 2 and doc is None, "no command -> usage, exit 2, nothing on stdout")
    rc, doc, err = run(base_env, "recall")
    check(rc == 2 and "--query" in err, "recall without a query -> exit 2")
    rc, doc, err = run(base_env, "frobnicate")
    check(rc == 2, "unknown command -> exit 2")

    # --- disabled (default) ----------------------------------------------------
    set_config(None)
    for cmd in ("status", "install", "init", "pull"):
        rc, doc, _ = run(base_env, cmd)
        check(rc == 0 and doc and doc["state"] == "disabled" and doc["enabled"] is False, f"{cmd}: no knowledge.teamai block -> disabled, exit 0")
    rc, doc, _ = run(base_env, "recall", "--query", "watermark")
    check(rc == 0 and doc["state"] == "disabled" and doc["results"] == [], "recall: disabled -> empty results, exit 0")
    set_config({"enabled": False, "team_repo": "https://example.invalid/t.git"})
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "disabled", "status: enabled=false -> disabled")
    check(not (profile / "teamai").exists(), "disabled: nothing is created under the profile")

    # --- enabled, not installed ---------------------------------------------------
    team_url = "https://oauth2:ghp_SECRET_TOKEN@github.com/cooptimize/teamai-sandbox.git"
    set_config({"enabled": True, "team_repo": team_url, "provider": "git", "role": ""})
    rc, doc, _ = run(base_env, "status")
    check(rc == 0 and doc["state"] == "not_installed", "status: enabled, no isolated package -> not_installed")
    check(doc["pin"] == PIN and doc["package"] == PACKAGE, f"status reports the manifest pin ({PACKAGE} {PIN})")
    check(doc["team_repo"] == "https://github.com/cooptimize/teamai-sandbox.git", "team_repo userinfo (token) is redacted in every document")
    check("ghp_SECRET_TOKEN" not in json.dumps(doc), "no token anywhere in the status document")
    check(doc["roots"]["pkg"] == str(profile / "teamai" / "pkg") and doc["roots"]["home"] == str(iso_home), "roots live under <profile dir>/teamai")
    rc, doc, _ = run(base_env, "recall", "--query", "watermark")
    check(doc["state"] == "not_installed" and doc["results"] == [], "recall: not installed -> not_installed, no CLI run")
    rc, doc, _ = run(base_env, "pull")
    check(doc["state"] == "not_installed", "pull: not installed -> not_installed")

    # --- install via a fake npm (never -g, into the isolated prefix) --------------
    npm_log = tmp / "npm.log"
    # A Python fake behind a platform wrapper, so the same test runs under Git Bash on Windows.
    fake_npm_py = tmp / "fake-npm.py"
    fake_npm_py.write_text(
        "import json, os, shutil, sys\n"
        "log, stub, args = sys.argv[1], sys.argv[2], sys.argv[3:]\n"
        "with open(log, 'a', encoding='utf-8') as fh:\n"
        "    fh.write(' '.join(args) + '\\n')\n"
        "    fh.write('HOME=' + os.environ.get('HOME', '') + '\\n')\n"
        "prefix = ''\n"
        "for i, a in enumerate(args):\n"
        "    if a == '--prefix':\n"
        "        prefix = args[i + 1]\n"
        f"pkg = os.path.join(prefix, 'node_modules', {PACKAGE!r})\n"
        "os.makedirs(os.path.join(pkg, 'dist'), exist_ok=True)\n"
        "with open(os.path.join(pkg, 'package.json'), 'w', encoding='utf-8') as fh:\n"
        f"    json.dump({{'name': {PACKAGE!r}, 'version': {PIN!r}}}, fh)\n"
        "shutil.copy(stub, os.path.join(pkg, 'dist', 'index.js'))\n",
        encoding="utf-8",
    )
    if os.name == "nt":
        fake_npm = tmp / "fake-npm.cmd"
        fake_npm.write_text(f'@"{sys.executable}" "{fake_npm_py}" "{npm_log}" "{tmp / "stub-index.js"}" %*\r\n', encoding="utf-8")
    else:
        fake_npm = tmp / "fake-npm.sh"
        write_exec(fake_npm, f'#!/bin/sh\nexec "{sys.executable}" "{fake_npm_py}" "{npm_log}" "{tmp / "stub-index.js"}" "$@"\n')
    (tmp / "stub-index.js").write_text(STUB_CLI, encoding="utf-8")
    env_npm = dict(base_env, COOP_NPM_BIN=str(fake_npm))
    rc, doc, err = run(env_npm, "install")
    check(rc == 0 and doc and doc["state"] == "ok" and doc["installed_version"] == PIN, f"install: fake npm -> ok, installed_version {PIN} ({err.strip()[:120]})")
    npm_args = npm_log.read_text(encoding="utf-8") if npm_log.exists() else ""
    check(f"--prefix {profile / 'teamai' / 'pkg'}" in npm_args and f"{PACKAGE}@{PIN}" in npm_args, "install: npm install --prefix <profile>/teamai/pkg <package>@<pin>")
    check(" -g" not in npm_args and "--global" not in npm_args, "install: never npm -g")
    check("--ignore-scripts" in npm_args and "--no-save" in npm_args, "install: --ignore-scripts and --no-save")
    check(f"HOME={iso_home}" in npm_args, "install: npm runs with HOME redirected to the isolated home")
    check((profile / "teamai" / "pkg" / "package.json").is_file(), "install: placeholder package.json written in the prefix")
    rc, doc, _ = run(env_npm, "install")
    check(doc["state"] == "ok" and "already installed" in doc.get("detail", ""), "install: second run is a no-op (already at the pin)")
    state = json.loads((profile / "teamai" / "state.json").read_text(encoding="utf-8"))
    check(state.get("installed_version") == PIN and state.get("installed_at"), "install: state.json records installed_at and the version")

    # --- installed, not initialized ------------------------------------------------
    install_stub()  # make sure the stub is the pinned package from here on
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "not_initialized" and doc["installed_version"] == PIN and doc["initialized"] is False, "status: installed, no isolated config.yaml -> not_initialized")
    rc, doc, _ = run(base_env, "recall", "--query", "watermark")
    check(doc["state"] == "not_initialized", "recall: not initialized -> not_initialized, no CLI run")
    check(doc.get("detail") == "run: coop teamai init", "not_initialized with a team repo set: the detail says to run init, not to set the repo")
    check(not stub_log.exists(), "no CLI process ran before init")

    # --- init failure is remembered and named by the next status ---------------------
    stub_mode.write_text("init-fail", encoding="utf-8")
    rc, doc, _ = run(base_env, "init")
    check(rc == 0 and doc["state"] == "unavailable" and any("could not read Username" in w for w in doc["warnings"]), "init: CLI failure -> unavailable with the git error, exit 0")
    state = json.loads((profile / "teamai" / "state.json").read_text(encoding="utf-8"))
    check("could not read Username" in state.get("last_init_error", ""), "init failure recorded in state.json")
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "not_initialized" and "last init failed" in doc.get("detail", "") and "coop teamai init" in doc["detail"], "status after a failed init: detail names the failure and the fix")
    stub_mode.write_text("results", encoding="utf-8")
    stub_log.unlink(missing_ok=True)

    # --- init needs a team repo -----------------------------------------------------
    set_config({"enabled": True, "team_repo": "", "provider": "git"})
    rc, doc, _ = run(base_env, "init")
    check(doc["state"] == "not_initialized" and any("team_repo" in w for w in doc["warnings"]), "init: empty team_repo -> not_initialized with a warning, nothing run")
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "not_initialized" and "set knowledge.teamai.team_repo" in doc.get("detail", ""), "status without a team repo: detail says to set the repo")
    check(not stub_log.exists(), "init without a repo never starts the CLI")

    # --- init against the (stub) sandbox repo ---------------------------------------
    set_config({"enabled": True, "team_repo": team_url, "provider": "git", "role": "bi"})
    rc, doc, err = run(base_env, "init")
    check(rc == 0 and doc["state"] == "ok", f"init: stub CLI -> ok ({err.strip()[:120]})")
    recs = [json.loads(l) for l in stub_log.read_text(encoding="utf-8").splitlines()]
    init_rec = recs[-1]
    check(init_rec["argv"][:2] == ["init", team_url] and "--provider" in init_rec["argv"] and "--scope" in init_rec["argv"] and init_rec["argv"][init_rec["argv"].index("--scope") + 1] == "user", "init: teamai init <repo> --provider git --scope user ...")
    check("--role" in init_rec["argv"] and init_rec["argv"][init_rec["argv"].index("--role") + 1] == "bi", "init: --role carried from the config")
    check(init_rec["home"] == str(iso_home) and init_rec["userprofile"] == str(iso_home) and init_rec["os_home"] == str(iso_home), "child HOME, USERPROFILE and os.homedir() are the isolated home")
    check(init_rec["cwd"] == str(workspace), "child cwd is the disposable workspace")
    check(init_rec["hooks_disabled"] == "1" and init_rec["recall_disabled"] == "1", "TEAMAI_HOOKS_DISABLED=1 and TEAMAI_RECALL_DISABLED=1 in the child")
    check(init_rec["claude_config_dir"] == str(iso_home / ".claude"), "CLAUDE_CONFIG_DIR points inside the isolated home")
    check(init_rec["api_token"] == "" and init_rec["claude_leak"] == "", "parent TEAMAI_* / CLAUDE_* variables are not inherited")
    check(init_rec["git_prompt"] == "0", "GIT_TERMINAL_PROMPT=0 (no credential prompts)")
    check("GIT_CONFIG_KEY_0=url.no-push://.pushInsteadOf" in init_rec["git_cfg"] and "GIT_CONFIG_VALUE_0=https://" in init_rec["git_cfg"], "push guard: the CLI's git inherits pushInsteadOf=no-push:// for https/ssh/git@ URLs")
    # the guard really blocks a push (any remote URL) while fetch still works
    guard_bare = tmp / "guard.git"
    subprocess.run(["git", "init", "--quiet", "--bare", "--initial-branch=main", str(guard_bare)], check=True)
    guard_clone = tmp / "guard-clone"
    subprocess.run(["git", "clone", "--quiet", str(guard_bare), str(guard_clone)], check=True, capture_output=True)
    (guard_clone / "a.md").write_text("a\n", encoding="utf-8")
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-C", str(guard_clone), "add", "a.md"], check=True)
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-C", str(guard_clone), "commit", "--quiet", "-m", "a"], check=True)
    subprocess.run(["git", "-C", str(guard_clone), "remote", "set-url", "origin", "https://example.invalid/guard.git"], check=True)
    guard_env = dict(os.environ)
    guard_env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "url.no-push://.pushInsteadOf", "GIT_CONFIG_VALUE_0": "https://"})
    gp = subprocess.run(["git", "-C", str(guard_clone), "push", "--dry-run", "origin", "main"], env=guard_env, capture_output=True, text=True)
    check(gp.returncode != 0 and "no-push" in (gp.stderr + gp.stdout), f"push guard: a push under the guard fails on the no-push:// scheme ({(gp.stderr or gp.stdout).strip()[:100]})")
    check((iso_home / ".teamai" / "config.yaml").is_file(), "the CLI's data home landed under the isolated home")
    check(json.loads((profile / "teamai" / "state.json").read_text(encoding="utf-8")).get("last_init_error", "x") == "", "a successful init clears last_init_error")
    check(not (real_home / ".teamai").exists() and not (real_home / ".claude").exists(), "nothing was written to the real home")
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "ok" and doc["initialized"] is True and doc["stale"] is True and doc["last_pull_at"] is None, "status: initialized, never pulled -> ok + stale, last_pull_at null")
    rc, doc, _ = run(base_env, "init")
    check(doc["state"] == "ok" and "already initialized" in doc.get("detail", ""), "init: second run is a no-op")

    # --- pull ----------------------------------------------------------------------
    rc, doc, _ = run(base_env, "pull")
    check(rc == 0 and doc["state"] == "ok" and doc["last_pull_at"] and doc["stale"] is False, "pull: ok, last_pull_at stamped, not stale")
    pull_rec = [json.loads(l) for l in stub_log.read_text(encoding="utf-8").splitlines()][-1]
    check(pull_rec["argv"] == ["pull", "--silent"], "pull: teamai pull --silent")
    stub_mode.write_text("pull-fail", encoding="utf-8")
    rc, doc, _ = run(base_env, "pull")
    check(rc == 0 and doc["state"] == "unavailable" and doc["last_pull_at"] and any("teamai pull" in w for w in doc["warnings"]), "pull: CLI failure -> unavailable, previous stamp kept, exit 0")
    stub_mode.write_text("results", encoding="utf-8")

    # --- recall: capped, provenance, redacted ------------------------------------------
    rc, doc, _ = run(base_env, "recall", "--query", "marker alpha")
    check(rc == 0 and doc["state"] == "ok", "recall: results -> ok")
    check(len(doc["results"]) == 5 and doc["result_cap"] == 5 and doc["truncated"] is True, "recall: 7 entries capped to 5, truncated=true")
    first = doc["results"][0]
    check(first["title"] == "Marker alpha 1" and first["type"] == "learning" and first["scope"] == "team" and first["votes"] == 9, "recall: title, type, scope and votes parsed")
    check(first["author"] == "Aaron" and first["date"].startswith("2026-09") and isinstance(first["score"], float), "recall: author, date and score parsed")
    check(first["tags"] == ["fabric", "incremental"] and first["file"].startswith("learnings/") and "watermark" in first["snippet"], "recall: tags, file and snippet parsed")
    check(first["repository"] == "https://github.com/cooptimize/teamai-sandbox.git" and "ghp_SECRET_TOKEN" not in json.dumps(doc), "recall: provenance names the redacted repository")
    check("revision" in first, "recall: every result carries a revision field")
    recall_rec = [json.loads(l) for l in stub_log.read_text(encoding="utf-8").splitlines()][-1]
    check(recall_rec["argv"] == ["recall", "--dry-run", "marker alpha"], "recall: teamai recall --dry-run <query> (no auto-upvote writes)")
    check(recall_rec["home"] == str(iso_home) and recall_rec["cwd"] == str(workspace), "recall: isolated home and workspace again")

    stub_mode.write_text("none", encoding="utf-8")
    rc, doc, _ = run(base_env, "recall", "--query", "nothing")
    check(doc["state"] == "no_match" and doc["results"] == [], "recall: 'No learnings available' after a pull -> no_match")
    stub_mode.write_text("partial", encoding="utf-8")
    rc, doc, _ = run(base_env, "recall", "--query", "marker")
    check(doc["state"] == "partial" and len(doc["results"]) == 5 and any("code-graph" in w for w in doc["warnings"]), "recall: code-graph unavailable -> partial with results")
    stub_mode.write_text("crash", encoding="utf-8")
    rc, doc, _ = run(base_env, "recall", "--query", "marker")
    check(rc == 0 and doc["state"] == "unavailable" and any("teamai recall exited 1" in w for w in doc["warnings"]), "recall: CLI exit 1 -> unavailable with the last stderr line, exit 0")

    # --- bounded: a hung CLI is killed and reported as unavailable ------------------------
    stub_mode.write_text("hang", encoding="utf-8")
    t0 = time.monotonic()
    rc, doc, _ = run(dict(base_env, COOP_TEAMAI_TIMEOUT_SECONDS="2"), "recall", "--query", "marker")
    elapsed = time.monotonic() - t0
    check(rc == 0 and doc["state"] == "unavailable" and any("timed out after 2s" in w for w in doc["warnings"]), "recall: hang -> unavailable, 'timed out after 2s'")
    check(elapsed < 15, f"recall: the hard timeout bounds the call ({elapsed:.1f}s)")
    stub_mode.write_text("results", encoding="utf-8")

    # --- stale fallback: old pull stamp still answers, flagged -----------------------------
    sp = profile / "teamai" / "state.json"
    st = json.loads(sp.read_text(encoding="utf-8"))
    st["last_pull_at"] = "2026-09-01T00:00:00Z"
    sp.write_text(json.dumps(st), encoding="utf-8")
    rc, doc, _ = run(base_env, "recall", "--query", "marker")
    check(doc["state"] == "ok" and doc["stale"] is True and doc["age_seconds"] > 7 * 24 * 3600 and len(doc["results"]) == 5, "recall: stale clone still answers, stale=true with age_seconds")
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "ok" and doc["stale"] is True, "status: stale flag next to state ok")

    # --- pin drift is a warning, not a state ------------------------------------------------
    install_stub("0.0.1")
    rc, doc, _ = run(base_env, "status")
    check(doc["state"] == "ok" and any("differs from the manifest pin" in w for w in doc["warnings"]), "status: installed version != pin -> warning, run: coop teamai install")
    install_stub()

    # --- the decoy never ran ---------------------------------------------------------------------
    check(not decoy_marker.exists(), "a `teamai` on PATH was never executed")

print()
if fails:
    print(f"✗ teamai adapter tests: {fails} failure(s)")
    sys.exit(1)
print("✓ teamai adapter tests passed")
