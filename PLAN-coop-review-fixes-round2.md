# coop-agent review — round 2 fix plan

> **Status (2026-08-19): all 15 findings IMPLEMENTED and validated** (uncommitted, 9 files changed).
> Baseline at review: `v0.21.0` (`3f2c4a9`), clean tree. Repo fast-forwarded to `v0.22.0`
> (`5345927`) before edits — upstream commits did not touch any fix target, so line
> numbers here remain valid.
Scope: `bin/`, `lib/`, `scripts/`, `extensions/`, `tests/`, `config/`, `.github/`.

Every finding below was verified against the current source. Apply top-to-bottom; each
item has the exact `before → after` edit and a verification command. Run the full
validation block at the end. Do **not** commit anything — this is the fix plan only.

Severity key: **HIGH** = breaks install/uninstall for real users · **MED** = wrong
behavior or silent failure in a specific path · **LOW** = dead code / misleading output.

---

## HIGH

### H1 — `install.sh` dies with `OS: unbound variable` on macOS/Linux

- **File:** `scripts/install.sh`
- **Lines:** 44 (the `case "$OS"`), 53 (the `OS=` assignment)
- **Problem:** `set -uo pipefail` is active (line 12). `case "$OS" in` runs at line 44,
  but `OS` is only assigned at line 53. On macOS and Linux there is no `OS` env var
  (only Windows Git-Bash predefines `OS=Windows_NT`), so `bash scripts/install.sh`
  aborts immediately with `OS: unbound variable`. Install is fully broken outside Windows.
- **Fix:** move the assignment above the `case`. Change lines 41–53 so `OS` is set first:

  ```bash
  PBIH_NPM_TOOLS=( @microsoft/powerbi-report-authoring-cli @microsoft/powerbi-modeling-mcp )
  OS="$(uname -s 2>/dev/null || echo unknown)"
  case "$OS" in
    MINGW*|CYGWIN*|MSYS*|Windows*|windows*) PBIH_NPM_TOOLS+=( @microsoft/powerbi-desktop-bridge-cli ) ;;
  esac

  # Install/operate against coop's ISOLATED Pi agent dir ...
  PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"; export PI_CODING_AGENT_DIR
  mkdir -p "$PI_CODING_AGENT_DIR"
  ```
  i.e. **delete** the old line 53 (`OS="$(uname -s 2>/dev/null || echo unknown)"`).
- **Verify:** `bash -n scripts/install.sh && bash -u -c 'OS= ; . /dev/null; case "$OS" in x) ;; esac' >/dev/null 2>&1; echo "no unbound error at case site"` — then, from a macOS shell, `env -i PATH="$PATH" HOME="$HOME" bash scripts/install.sh --help 2>&1 | head -5` should print the bootstrap header (not `unbound variable`). (Do not run a full install.)

---

## MED

### M1 — `uninstall` can `rm -rf ~/.coop` (destructive, violates "NEVER touches")

- **Files:** `scripts/uninstall.sh:66-70`, `scripts/uninstall.ps1:116-119`
- **Problem:** the agent-dir removal guard only rejects `''`, `/`, and `$HOME`. But
  `coop_pi_agent_dir()` honors `COOP_AGENT_DIR`; if a user sets
  `COOP_AGENT_DIR=$HOME/.coop`, the guard passes and `rm -rf "$AGENT_DIR"` wipes all of
  `~/.coop` — the exact directory the header promises is "NEVER touched" (it can hold
  private, non-coop config).
- **Fix (sh):** extend the `case` in `scripts/uninstall.sh`:

  ```bash
  case "$AGENT_DIR" in
    ''|/|"$HOME"|"$HOME/.coop"|"$HOME/.coop/") coop_warn "suspicious agent dir '$AGENT_DIR' — not removing" ;;
    *)
  ```
- **Fix (ps1):** in `scripts/uninstall.ps1` change the guard (line 116) to also reject
  `$HOME\.coop` and `$HOME\.coop\`:

  ```powershell
  if (-not $agentDir -or $agentDir -eq $HOME -or $agentDir -eq (Join-Path $HOME '.coop')) {
    Coop-Warn "suspicious agent dir '$agentDir' — not removing"
  }
  ```
- **Verify:** `COOP_AGENT_DIR="$HOME/.coop" bash scripts/uninstall.sh --yes 2>&1 | grep -i "suspicious"` should print the warning and **not** remove anything. (Use `--yes` so it never prompts.)

### M2 — `coop review --diff` crashes on bash 3.2 (macOS) when nothing changed

- **File:** `bin/coop:395`
- **Problem:** `scope=("${new_scope[@]}")` expands an empty array unguarded. Under
  `set -u` + bash 3.2 (the stock `/bin/bash` on macOS), this raises
  `new_scope[@]: unbound variable` instead of the intended "no files changed" message.
  Every other array expansion in the file uses the safe idiom; this one site doesn't.
- **Fix:**

  ```bash
  scope=(${new_scope[@]+"${new_scope[@]}"})
  ```
- **Verify:** `bash bin/coop review --diff 2>&1 | head -3` in a clean repo prints the
  "no files changed" info line (or runs the review), not `unbound variable`.

### M3 — `coop init --ci` exits 0 on scaffolding failure (bash) — parity break

- **File:** `bin/coop:911`
- **Problem:** the bash path uses `coop_err "CI scaffolding failed"` (prints only,
  returns 0), so a failed `_ciscaffold.py` run exits 0. The PowerShell twin (`Coop-Die`)
  and the function's other fatal branches exit 1. Callers can't detect the failure.
- **Fix:**

  ```bash
  coop_die "CI scaffolding failed"
  ```
- **Verify:** `bash -n bin/coop` passes; force a failure (e.g. `coop init --ci bogus`
  in a repo with no `.coop/project.yml`) and confirm the process exits non-zero.

### M4 — PS1 `init` flag parsing swallows positional dirs (substring regex match)

- **File:** `bin/coop.ps1:593-599`
- **Problem:** `switch -Regex` patterns `'--seed-docs'`, `'--ci'`, `'--yes'`, `'-y'`
  are substring matches, so `coop init new-york` matches `-y` and scaffolds into the
  cwd instead of `new-york` (and any dir containing `--ci`/`--yes` mis-parses too).
  The review parser at :384-388 already anchors; this one does not.
- **Fix:** anchor every pattern:

  ```powershell
  '^--seed-docs$' { $seed = $true }
  '^--ci$'       { ... }
  '^--yes$'      { $env:COOP_ASSUME_YES = '1' }
  '^-y$'         { $env:COOP_ASSUME_YES = '1' }
  ```
- **Verify:** `pwsh -NoProfile -Command "& { . ./bin/coop.ps1; Invoke-CoopInit @('new-york') }"` — `new-york` must be treated as the dir, not a `-y` flag. (If pwsh is unavailable, confirm the regexes are anchored by reading.)

### M5 — PS1 `coop init --ci <value>` never validates the CI type

- **File:** `bin/coop.ps1:1056-1066` (`Invoke-CoopInitCi`)
- **Problem:** bash validates `github|ado` and dies on anything else (`bin/coop:891-893`);
  the ps1 passes a bogus value straight through to `lib/_ciscaffold.py`. Parity break.
- **Fix:** add at the top of `Invoke-CoopInitCi` (after `param(...)`):

  ```powershell
  if ($CiType -notin @('github','ado')) { Coop-Die "unknown CI type '$CiType' — usage: coop init --ci github|ado" }
  ```
- **Verify:** `coop init --ci junk` (ps1) prints the usage error and exits non-zero.

### M6 — `coop-desktop.ps1` first-run auto-install path is unreachable

- **File:** `bin/coop-desktop.ps1:17-20`
- **Problem:** `Find-Coop` returns the sibling `coop.ps1` unconditionally whenever it
  exists (it always does — the launcher ships next to it in `bin/`), so the
  "coop is not installed yet — running first-time setup" branch (:33-43) never fires.
  On a fresh machine the double-click just runs `coop.ps1`, which dies with "pi is not
  installed" instead of bootstrapping — defeating the launcher's whole purpose.
- **Fix:** only return the sibling when an actual install is detectable, else `$null`
  so the setup branch runs:

  ```powershell
  $sibling = Join-Path $PSScriptRoot 'coop.ps1'
  if ((Test-Path -LiteralPath $sibling) -and (Get-Command pi -ErrorAction SilentlyContinue)) {
    return $sibling
  }
  ```
- **Verify:** read-through: `Find-Coop` now returns `$null` when `pi` is absent, so the
  setup block at :33-43 executes.

### M7 — `coop-desktop.ps1` pause-on-error is bypassed (window flashes shut)

- **File:** `bin/coop-desktop.ps1:58-66`
- **Problem:** `& $coop @args` runs the sibling `coop.ps1` **in-process**; `coop.ps1`
  ends nearly every branch with `exit`, which terminates the whole host — so the
  `Read-Host 'Press Enter to close'` pauses (:63-66, :70-74) never run and the error
  window still flashes shut, the exact problem the launcher exists to prevent.
- **Fix:** launch the sibling out-of-process so its exit code comes back to the launcher:

  ```powershell
  if ($coop -like '*.ps1') {
    $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $coop @args
    $code = $LASTEXITCODE
  } else {
    & $coop @args
    $code = $LASTEXITCODE
  }
  ```
- **Verify:** `pwsh -NoProfile -Command "& ./bin/coop-desktop.ps1 bogus-command"` exits
  non-zero after printing the pause prompt (no instant window close).

---

## LOW

### L1 — BPA `--compare` snapshot is dead code in both twins

- **Files:** `bin/coop:427-433` and `bin/coop.ps1:469-504`
- **Problem:** `$bpa_prev`/`$bpaPrev` is copied to a temp file then deleted, but never
  passed to `lib/_bpa_runner.py`. In bash the `rm -f "$bpa_json"` at :427 runs **before**
  the `[ -f "$bpa_json" ]` test at :432, so `bpa_prev` is always empty (dead branch).
- **Fix:** delete the three `bpa_prev` lines in each file (bash: the `local bpa_prev=""`,
  the `if [ "$compare" = 1 ] && [ -f "$bpa_json" ]; then bpa_prev=...` block, and the
  `[ -n "$bpa_prev" ] && rm -f "$bpa_prev"`; mirror in ps1). Leave a comment that BPA has
  no `--diff-against` (or, if you later add one, thread the snapshot into the runner).
- **Verify:** `bash -n bin/coop` and `bash scripts/check-parity.sh` still pass; grep
  confirms no `bpa_prev` remains.

### L2 — leftover `$needDiffRef`/`$diffRef` block pasted into `Invoke-CoopRelease`

- **File:** `bin/coop.ps1:772-775`
- **Problem:** an uninitialized `$needDiffRef`/`$diffRef` block (copied from the review
  parser) sits in the release path; harmless today but misleading dead code.
- **Fix:** delete lines 772-775 (the `if ($needDiffRef) { ... }` block).
- **Verify:** `bash scripts/check-parity.sh` passes; grep shows no `needDiffRef` in the
  release function.

### L3 — `sed -n … | head -1` under `pipefail` can abort `coop release` silently

- **File:** `bin/coop:675`
- **Problem:** `rel="$(sed -n 's/…/\1/p' "$vjson" | head -1)"` — if `versions.json`
  contains the tool key twice, `head -1` closes the pipe and `sed` dies with SIGPIPE
  (141); under `set -o pipefail` the substitution fails and `set -e` aborts mid-release
  with no message.
- **Fix:** capture full output, then take the first line without a pipeline:

  ```bash
  rel="$(sed -n 's/…/\1/p' "$vjson")"; rel="${rel%%$'\n'*}"
  ```
- **Verify:** `bash -n bin/coop`; temporarily duplicate a key in the release input to
  confirm it no longer aborts (revert the test edit).

### L4 — `uninstall` removes any symlink at `~/.local/bin/coop` without verifying target

- **Files:** `scripts/uninstall.sh:54-56`, `scripts/uninstall.ps1:62-67`
- **Problem:** a user's own symlink named `coop` (pointing elsewhere) is silently
  unlinked. `install.sh` already verifies the target class; uninstall does not.
- **Fix (sh):** guard the removal:

  ```bash
  if [ -L "$LOCALBIN/coop" ]; then
    if [ "$(readlink "$LOCALBIN/coop" 2>/dev/null)" = "$COOP_ROOT/bin/coop" ]; then
      rm -f "$LOCALBIN/coop" 2>/dev/null && coop_ok "removed $LOCALBIN/coop" || coop_warn "could not remove $LOCALBIN/coop"
    else
      coop_warn "$LOCALBIN/coop points elsewhere — left in place"
    fi
  elif [ -e "$LOCALBIN/coop" ]; then
  ```
  (mirror the same target check in `uninstall.ps1`.)
- **Verify:** create a throwaway symlink `ln -sf /tmp/other ~/.local/bin/coop` and run
  `bash scripts/uninstall.sh --yes 2>&1 | grep -i "elsewhere"` — the symlink must remain.

### L5 — `migrate-from-pi-analytics-agent.sh` reports success on failed copies

- **File:** `scripts/migrate-from-pi-analytics-agent.sh:29,39,43`
- **Problem:** (a) `mkdir -p "$DST/.coop"` runs with no `[ -d "$DST" ]` check, so a typo'd
  target silently creates a stray tree; (b) both `cp` calls at :39 and :43 are unchecked
  yet followed by unconditional `coop_ok`, printing a false success on failure.
- **Fix:** after arg parsing add `[ -d "$DST" ] || coop_die "Target repo not found: $DST"`;
  change the two `cp … ; coop_ok "Created…"` sequences to
  `cp … && coop_ok "Created…" || coop_warn "copy failed: …"` (the standards-doc copy at
  :60 already does this correctly — match it).
- **Verify:** `bash -n scripts/migrate-from-pi-analytics-agent.sh`; run it with a
  nonexistent target and confirm a non-zero exit / warning (not "Created").

### L6 — `fetch-microsoft-skills.sh` git calls have no timeout

- **File:** `scripts/fetch-microsoft-skills.sh:59,62`
- **Problem:** `git pull`/`git clone` can hang indefinitely on a VPN-black-holed network.
  The repo already bounds this exact risk elsewhere (`coop_repo_fetch_throttled`, 5s).
- **Fix:** wrap with git's own low-speed watchdog, e.g.
  `git -C "$cache" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 pull --ff-only --depth 1 …`
  (and the same for `clone`), or `timeout 30 git …` where `timeout` exists.
- **Verify:** `bash -n scripts/fetch-microsoft-skills.sh`; optionally run against a
  blocked host and confirm it returns in ≤ ~30s.

### L7 — `install.ps1` always prints "open a NEW terminal" even when PATH already set

- **File:** `scripts/install.ps1:291`
- **Problem:** `$script:NeedNewShell = $true` is set unconditionally inside the `try`,
  even when `$LOCALBIN` was already in the persistent user PATH (the inner `if` at
  :283 is skipped). Every re-run ends with the misleading "coop was just added to your
  PATH / open a NEW terminal" guidance.
- **Fix:** move the assignment inside the `if (($userPath -split ';') -notcontains $LOCALBIN) { … }`
  block; keep the session-level `$env:PATH` update outside.
- **Verify:** read-through; on a Windows host, run install twice and confirm the second
  run no longer emits the "open a new terminal" tail.

---

## Verification block (run after all edits, in order)

```bash
cd ~/Developer/coop-agent
bash -n bin/coop scripts/*.sh            # bash syntax
bash scripts/validate-resources.sh       # skills + prompts
bash scripts/check-parity.sh             # sh/ps1 flag parity
bash tests/run.sh                        # test suite
./bin/coop doctor                        # dependency/contract check
./bin/coop launch-spec --json | head -1  # launch spec still builds
```

PowerShell syntax (if pwsh available):

```powershell
pwsh -NoProfile -Command "[System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw ./bin/coop.ps1),[ref]$null) | Out-Null; 'coop.ps1 parses'"
```

> Reminder (from AGENTS.md): never `bash -n` a `.ps1`, and never run `bin/coop.ps1`
> through bash. Do not commit — the fixes land in a future change set after review.

---

## Not flagged (verified correct)

- `coop_init_ci` function-after-dispatch ordering — already fixed.
- `bpa-review.json` stale-cleanup — already fixed.
- `update.sh` `npm update -g` → install-if-missing — already fixed.
- `doctor.sh` `coop_version` → `$COOP_VERSION`, `doctor.ps1` subordinate-skills check,
  `uninstall` tool teardown — already fixed.
- All three Pi extensions (`coop-guardrails`, `coop-tools`, `coop-powerline`) — reviewed
  in full; fail-open, feature-detected, no material defects found.
- `lib/common.sh` / `lib/common.ps1` / `lib/_yaml.py` — reviewed in full; no new
  parity/parse defects beyond the items above.
