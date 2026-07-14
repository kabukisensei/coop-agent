#!/usr/bin/env pwsh
#
# coop.ps1 — the Cooptimize terminal agent (Windows / PowerShell mirror of bin/coop).
#
# A thin, branded layer ON TOP OF Pi (@earendil-works/pi-coding-agent). coop never
# forks Pi: it launches `pi` with Cooptimize skills, prompts, theme, a powerline
# splash/footer extension, and a governance system prompt, and it shells out to
# the standalone Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)
# and the Microsoft Fabric CLI (`fab`).
#
# Usage:
#   coop                      Launch the branded Pi agent (passes extra args to pi)
#   coop doctor               Check dependencies and configuration
#   coop update               Update Pi, Coop tools, vibes, skills/prompts, then doctor
#   coop install              Fresh-install / bootstrap everything (idempotent)
#   coop uninstall            Remove coop from this machine (--keep-tools spares pi + tools)
#   coop sync                 Ensure Pi extensions + place read-only MCP config + verify assets
#   coop data-doc [args]      Run coop-data-doc (default: build) and summarize outputs
#   coop sql-review [args]    Pass through to coop-sql-review (e.g. check <paths>, rules)
#   coop dax-review [args]    Pass through to coop-dax-review (e.g. check <paths>, rules)
#   coop review [paths...]    Run both linters + compose findings onto the lineage docs
#   coop fabric [args]        Pass through to the Microsoft Fabric CLI (`fab`)
#   coop version              Print coop + pi versions
#   coop help                 Show this help
#
# Pi management, aliased under coop:
#   coop list                 List installed Pi extensions   (-> pi list)
#   coop config               Open Pi's resource TUI         (-> pi config)
#   coop add <source>         Install a Pi extension          (-> pi install <source>)
#   coop install <source>     Same as `coop add` (bare `coop install` bootstraps)
#   coop remove <source>      Remove a Pi extension           (-> pi remove <source>)
#   coop pi <args...>         Raw escape hatch to pi          (-> pi <args...>)
#
# NB: deliberately NO param() block. With `powershell -File coop.ps1 <args>`, the
# absence of declared parameters routes EVERY token — including bare flags like
# `-c` or `@notes.md` — into the automatic $args verbatim, with no binder errors.
# That lets `coop -c` / `coop @file ...` pass straight through to pi, exactly like
# the bash wrapper's "$@" handling.

# Don't let a single failing native command tear down the dispatcher; we mirror
# bash's per-command behavior and propagate exit codes explicitly.
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, Test-Have,
# Get-CoopPython, YAML readers, Find-CoopProjectYml, Coop-Confirm, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# Isolate coop's Pi config (extensions, settings, themes, MCP) from the user's personal
# `pi` — for launching AND the coop add/remove/list/config/pi management aliases.
# Disable with COOP_NO_ISOLATE=1.
if ($env:COOP_NO_ISOLATE -ne '1') {
  $coopAgentDir = Get-CoopPiAgentDir
  $env:PI_CODING_AGENT_DIR = $coopAgentDir
  New-Item -ItemType Directory -Force -Path $coopAgentDir -ErrorAction SilentlyContinue | Out-Null
}

# Make tools in the npm global bin (`pi`) or the pipx bin (`fab`, coop-*) resolvable
# even when the current shell's persistent PATH predates their install — otherwise
# `coop` / `coop doctor` falsely report them "not installed" right after a fresh
# `coop install`. Best-effort, process-local: only PREPENDS dirs that exist.
function Add-CoopRuntimePaths {
  $dirs = @()
  if (Test-Have 'npm') {
    $p = (& npm prefix -g 2>$null)
    if ($p) { $dirs += $p; $dirs += (Join-Path $p 'bin') }   # win: shims in prefix; *nix: prefix/bin
  }
  $dirs += (Join-Path $HOME '.local\bin')                    # pipx default PIPX_BIN_DIR
  foreach ($d in $dirs) {
    if ($d -and (Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
      $env:PATH = "$d;$env:PATH"
    }
  }
}

# Summarize a coop-data-doc manifest/graph JSON artifact. (mirror of the inline PY in run_data_doc)
function Invoke-CoopSummarizeDataDocJson {
  param([string]$File)
  $py = Get-CoopPython
  if (-not $py) { return }
  $pyScript = @'
import sys, json
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
def n(*keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, list): return len(v)
        if isinstance(v, dict): return len(v)
    return None
parts=[]
for label,keys in [("nodes",("nodes","objects","entities")),("edges",("edges","links","lineage")),("docs",("documents","docs","pages"))]:
    c=n(*keys)
    if c is not None: parts.append("{} {}".format(c, label))
if parts: print("  " + ", ".join(parts))
'@
  ($pyScript | & $py - $File 2>$null) | ForEach-Object { [Console]::Error.WriteLine($_) }
}

function Show-Usage {
  $v = $script:CoopVersion
  Write-Host @"
$(Coop-Bold)$(Coop-Navy)coop$(Coop-Rst) $(Coop-Dim)v$v$(Coop-Rst) — the Cooptimize terminal agent (a branded layer on Pi)

$(Coop-Bold)Usage$(Coop-Rst)
  coop                      Launch the branded Pi agent
  coop doctor               Check dependencies and configuration
  coop update               Update Pi + Coop tools + vibes/skills, then run doctor
  coop install              Fresh-install / bootstrap everything (idempotent)
  coop uninstall            Remove coop from this machine (--keep-tools spares pi + tools)
  coop sync                 Ensure Pi extensions + place read-only MCP config + verify assets
  coop web                  Open a friendly browser UI over the agent (experimental)
  coop data-doc [args]      Run coop-data-doc (default: build) and summarize outputs
  coop sql-review [args]    Pass through to coop-sql-review (e.g. check <paths>, rules)
  coop dax-review [args]    Pass through to coop-dax-review (e.g. check <paths>, rules)
  coop review [paths...]    Run both linters + compose findings onto the lineage docs
                            (--strict: exit 2 on a failing linter; --skip-docs: linters only)
  coop fabric [args]        Pass through to the Microsoft Fabric CLI (fab)
  coop version              Print coop + pi versions
  coop help                 Show this help

$(Coop-Bold)Authoring$(Coop-Rst)
  coop init [dir]           Scaffold .coop/project.yml into a work repo (default: .)
                            (--seed-docs: generate coop-data-doc.yml from repositories:)
  coop new-skill <name>     Scaffold skills/<name>/SKILL.md
  coop new-prompt <name>    Scaffold prompts/<name>.md
  coop release [level]      Cut a release: bump version + roll CHANGELOG + commit + tag + push
                            (level = patch|minor|major, default patch; --yes, --no-push)

$(Coop-Bold)Pi management (aliased under coop)$(Coop-Rst)
  coop list                 List installed Pi extensions   (pi list)
  coop config               Open Pi's resource TUI         (pi config)
  coop add <source>         Install a Pi extension         (pi install <source>)
  coop remove <source>      Remove a Pi extension          (pi remove <source>)
  coop pi <args...>         Raw escape hatch to pi

Anything after ``coop`` that is not a known subcommand is passed straight to pi,
e.g. ``coop -c`` resumes the last session, ``coop @notes.md "review this"``.
"@
}

# The optional Azure preflight (Power BI token check, cached ~30 min) lives in
# lib/common.ps1 (Invoke-CoopAzPreflight) — called below by Invoke-LaunchPi and
# Invoke-CoopWeb.

# --- Launch the branded Pi agent ---------------------------------------------
# Launch-time skew guard (mirror of common.sh coop_launch_preflight): refuse to exec
# pi into a known-broken extension load. If the Pi agent is too old for an installed
# extension (rc 11), aligning the tree can't help — abort with instructions instead
# of crashing in pi's loader. If the tree is merely skewed but fixable (rc 10), run
# sync to re-pin + reinstall, then continue. Read-only + fast. Bypass with
# COOP_SKIP_EXT_CHECK=1.
function Invoke-CoopLaunchPreflight {
  if ($env:COOP_SKIP_EXT_CHECK -eq '1') { return }
  if (-not (Test-Have 'pi')) { return }
  $py = Get-CoopPython; if (-not $py) { return }
  # The dir Pi will ACTUALLY load: PI_CODING_AGENT_DIR when set; with COOP_NO_ISOLATE=1
  # Pi uses the personal ~/.pi/agent, so guarding coop's isolated dir would be wrong.
  $agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR }
              elseif ($env:COOP_NO_ISOLATE -eq '1') { Join-Path $HOME '.pi\agent' }
              elseif ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR }
              else { Join-Path $HOME '.coop\agent' }
  if (-not (Test-Path -LiteralPath (Join-Path $agentDir 'npm\package.json') -PathType Leaf)) { return }
  $verRaw = (& pi --version 2>$null | Select-Object -First 1)
  if (-not $verRaw) { return }
  $m = [regex]::Match([string]$verRaw, '\d+\.\d+\.\d+'); if (-not $m.Success) { return }
  $ver = $m.Value
  $extScript = Join-Path $script:CoopRoot 'lib/_extdeps.py'
  # Capture output BEFORE reading $LASTEXITCODE (piping a native command can leave it unset).
  $out = (& $py $extScript align $agentDir $ver --check 2>$null)
  $rc = $LASTEXITCODE
  $line = if ($out) { @($out)[0] } else { '' }
  $parts = if ($line) { $line -split '\s+' } else { @() }
  if ($rc -eq 11) {
    $req = if ($parts.Count -ge 7) { $parts[6] } else { '-' }
    $ext = if ($parts.Count -ge 8) { $parts[7] } else { '-' }
    $need = if ($ext -and $ext -ne '-' -and $req -and $req -ne '-') { "$ext needs pi-ai >= $req" } else { 'an installed extension needs a newer pi-ai' }
    Coop-Warn "Pi agent $ver is too old — $need — update the Pi agent: coop update   (or move off the legacy-node20 build)"
    Coop-Die 'launch aborted — update the Pi agent above, then re-run: coop   (bypass once with COOP_SKIP_EXT_CHECK=1)'
  }
  elseif ($rc -eq 10) {
    if ($env:COOP_NO_ISOLATE -eq '1') {
      # Isolation off → Pi is loading the user's personal ~/.pi/agent. Don't silently
      # mutate the personal tree at launch; tell them how to align it deliberately.
      Coop-Warn "your Pi extension tree needs realignment to pi $ver (isolation is off) — align it deliberately: coop doctor --fix   (or unset COOP_NO_ISOLATE to use coop's isolated tree)"
    } else {
      # Fixable tree skew in coop's OWN dir — run sync (re-pins + reinstalls) in a child
      # process, then launch. Streams stay visible so a slow reinstall isn't a silent hang.
      Coop-Info 'realigning Pi extensions to the agent…'
      $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
      & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:CoopRoot 'scripts\sync.ps1')
    }
  }
}

# --- Assemble the exact Pi launch spec (args + brand env) --------------------
# SINGLE SOURCE OF TRUTH for how coop launches Pi (mirror of bin/coop's
# coop_build_pi_args). Both Invoke-LaunchPi (the terminal agent) and
# Invoke-CoopLaunchSpec (`coop launch-spec`, JSON for a future coop web bridge)
# consume this, so the terminal and any other surface can NEVER drift. Returns the
# pi args array and exports the brand env. Read-only; never launches pi.
function Build-CoopPiArgs {
  $piArgs = @()
  # Governance system prompt (read-only-first guardrails). Appended, not replaced.
  $guardrails = Join-Path $script:CoopRoot 'docs\guardrails.md'
  if (Test-Path -LiteralPath $guardrails -PathType Leaf) { $piArgs += @('--append-system-prompt', $guardrails) }
  # Cooptimize skills — load each folder individually. The official Microsoft slot
  # (skills/_microsoft/) is SUBORDINATE: a Microsoft skill is surfaced only if it is
  # allow-listed in microsoft_skills.allow[] AND does not conflict (by folder name or
  # frontmatter name) with one of our own skills. Cooptimize skills always win.
  $skills = Join-Path $script:CoopRoot 'skills'
  if (Test-Path -LiteralPath $skills -PathType Container) {
    $ownNames = New-Object System.Collections.Generic.HashSet[string]
    Get-ChildItem -LiteralPath $skills -Directory | Where-Object { $_.Name -ne '_microsoft' } | ForEach-Object {
      $sk = Join-Path $_.FullName 'SKILL.md'
      if (Test-Path -LiteralPath $sk -PathType Leaf) {
        $piArgs += @('--skill', $_.FullName)
        [void]$ownNames.Add($_.Name)
        $fm = Get-CoopSkillName $sk
        if ($fm) { [void]$ownNames.Add($fm) }
      }
    }
    $msDir = Join-Path $skills '_microsoft'
    $proj = Find-CoopProjectYml
    if ($proj -and (Test-Path -LiteralPath $msDir -PathType Container)) {
      foreach ($allow in (Get-CoopYamlList $proj 'microsoft_skills.allow')) {
        if ([string]::IsNullOrWhiteSpace($allow) -or $allow.StartsWith('TODO')) { continue }
        # Validate the name so a hostile project.yml can't traverse out of
        # skills/_microsoft/ and inject an arbitrary SKILL.md into the model.
        if (-not (Test-CoopValidName $allow)) { Coop-Warn "ignoring invalid Microsoft skill name '$allow'"; continue }
        $cand = Join-Path $msDir $allow
        $sk = Join-Path $cand 'SKILL.md'
        if (-not (Test-Path -LiteralPath $sk -PathType Leaf)) { continue }
        if ($ownNames.Contains($allow)) { Coop-Warn "skipping Microsoft skill '$allow' (conflicts with a Cooptimize skill)"; continue }
        $fm = Get-CoopSkillName $sk
        if ($fm -and $ownNames.Contains($fm)) { Coop-Warn "skipping Microsoft skill '$allow' (name '$fm' conflicts with a Cooptimize skill)"; continue }
        $piArgs += @('--skill', $cand)
      }
    }
  }
  $prompts = Join-Path $script:CoopRoot 'prompts'
  if (Test-Path -LiteralPath $prompts -PathType Container) { $piArgs += @('--prompt-template', $prompts) }
  $theme = Join-Path $script:CoopRoot 'themes\cooptimize.json'
  if (Test-Path -LiteralPath $theme -PathType Leaf) { $piArgs += @('--theme', $theme) }
  # Cooptimize companion extensions: branding/splash/vibes, and native review tools.
  $extPowerline = Join-Path $script:CoopRoot 'extensions\coop-powerline'
  if (Test-Path -LiteralPath $extPowerline) { $piArgs += @('-e', $extPowerline) }
  $extTools = Join-Path $script:CoopRoot 'extensions\coop-tools'
  if (Test-Path -LiteralPath $extTools) { $piArgs += @('-e', $extTools) }
  $extGuardrails = Join-Path $script:CoopRoot 'extensions\coop-guardrails'
  if (Test-Path -LiteralPath $extGuardrails) { $piArgs += @('-e', $extGuardrails) }
  # Point the extension at our vibe files and brand splash.
  $env:COOP_VIBES_DIR = Join-Path $script:CoopRoot 'vibes'
  $env:COOP_SPLASH_FILE = Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi'
  return ,$piArgs
}

# --- Launch the branded Pi agent ---------------------------------------------
function Invoke-LaunchPi {
  param([string[]] $PassArgs = @())

  if (-not (Test-Have 'pi')) {
    Coop-Die 'pi is not installed. Run: coop install   (or: npm install -g @earendil-works/pi-coding-agent)'
  }

  # Guard against launching into a known-broken extension load (agent/extension skew).
  Invoke-CoopLaunchPreflight

  # Once-a-day fleet-staleness nudge: warn when this checkout is behind
  # origin/main (throttled fetch, bounded wait — never blocks or fails the launch).
  Invoke-CoopUpdateNudge

  Invoke-CoopAzPreflight

  $piArgs = Build-CoopPiArgs
  $allArgs = @($piArgs + $PassArgs)
  & pi @allArgs
  exit $LASTEXITCODE
}

# --- Emit the launch spec (for a UI / coop web bridge) -----------------------
# Internal/advanced. `coop launch-spec` prints the resolved pi invocation;
# `--json` emits {"bin","args","env"} for a programmatic consumer — e.g. a future
# coop web bridge that spawns `pi --mode rpc` with the SAME governed spec the
# terminal uses. Read-only: builds the spec, never launches pi.
function Invoke-CoopLaunchSpec {
  param([string[]] $SpecArgs = @())
  $piArgs = Build-CoopPiArgs
  if ($SpecArgs -contains '--json') {
    $envMap = [ordered]@{}
    if ($env:PI_CODING_AGENT_DIR) { $envMap['PI_CODING_AGENT_DIR'] = $env:PI_CODING_AGENT_DIR }
    if ($env:COOP_VIBES_DIR)      { $envMap['COOP_VIBES_DIR']      = $env:COOP_VIBES_DIR }
    if ($env:COOP_SPLASH_FILE)    { $envMap['COOP_SPLASH_FILE']    = $env:COOP_SPLASH_FILE }
    # The JSON SHAPE ({bin,args,env}) is the contract with web/server.mjs — the
    # formatting (bash pretty-prints, this compresses) intentionally is not.
    [pscustomobject]@{ bin = 'pi'; args = @($piArgs); env = $envMap } | ConvertTo-Json -Depth 5 -Compress
  } else {
    # Mirror bash's %q-quoted human output: quote any arg containing whitespace.
    'pi ' + (($piArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  }
}

# --- coop web (experimental): friendly browser UI over `pi --mode rpc` --------
# Spawns the SAME governed coop the terminal runs, but drives it from a local
# browser window (SSE bridge). Uses the shared launch spec so it can never drift
# from the terminal. Localhost + one-time token; see web\server.mjs.
function Invoke-CoopWeb {
  param([string[]] $WebArgs = @())
  if (-not (Test-Have 'pi'))   { Coop-Die 'pi is not installed. Run: coop install' }
  if (-not (Test-Have 'node')) { Coop-Die 'Node.js is required for coop web. Run: coop install' }
  Invoke-CoopLaunchPreflight
  Invoke-CoopAzPreflight   # same Fabric/Power BI token check the terminal launch does
  $env:COOP_LAUNCH_SPEC = (Invoke-CoopLaunchSpec @('--json'))
  $server = Join-Path $script:CoopRoot 'web\server.mjs'
  & node $server @WebArgs
  exit $LASTEXITCODE
}

# --- Tool wrappers -----------------------------------------------------------
# Flow straight through to a standalone Coop tool: every subcommand and the tool's
# own interactive prompts work, and the exit code propagates. The AI agent gets
# structured JSON via the native sql_review / dax_review tools. (mirror of run_tool)
function Invoke-Tool {
  param([string] $Bin, [string[]] $RestArgs = @())
  if (-not (Test-Have $Bin)) { Coop-Die "$Bin is not installed. Run: coop install" }
  Coop-Head "$Bin $($RestArgs -join ' ')"
  & $Bin @RestArgs
  exit $LASTEXITCODE
}

function Invoke-DataDoc {
  param([string[]] $RestArgs = @())
  if (-not (Test-Have 'coop-data-doc')) { Coop-Die 'coop-data-doc is not installed. Run: coop install' }
  if ($RestArgs.Count -eq 0) { $RestArgs = @('build') }
  Coop-Head "coop-data-doc $($RestArgs -join ' ')"
  & coop-data-doc @RestArgs
  $rc = $LASTEXITCODE   # capture before the summary loop so the tool's exit code propagates
  # Summarize machine-readable artifacts when present (manifest.json / graph.json).
  # Includes the default output dir (./data-docs) plus legacy/alternate locations.
  foreach ($f in @('data-docs/manifest.json', 'data-docs/graph.json', 'manifest.json', 'graph.json', 'docs/manifest.json', 'docs/graph.json', 'site/manifest.json', 'data-docs-site/manifest.json')) {
    if (Test-Path -LiteralPath $f -PathType Leaf) {
      Coop-Ok "Machine-readable output: $f"
      Invoke-CoopSummarizeDataDocJson $f
      break
    }
  }
  exit $rc   # mirror Invoke-Tool: a coop-data-doc failure must not be masked by the summary
}

# --- coop review: both linters + compose findings onto the lineage docs -------
# Mirror of run_review in bin/coop. One command for the whole advisory loop: run
# coop-sql-review AND coop-dax-review over the same scope (each tool filters by
# file type itself), save both JSON reports under .coop/reviews/ next to the
# contract, then rebuild the lineage docs with the findings composed in
# (coop-data-doc build --reviews …). Scope: explicit paths win; with none, the
# nearest .coop/project.yml's repositories.*.local_path entries — the same
# contract scoping the native sql_review/dax_review tools use (TODO placeholders
# and paths missing on this machine are skipped with a note). NEVER blind-scans
# the cwd. Advisory: linter findings don't fail the run unless --strict; docs-
# not-set-up is a hint, not a failure; a hard data-doc failure (exit 2) propagates.
function Invoke-CoopReview {
  param([string[]] $RestArgs = @())
  $strict = $false; $skipDocs = $false; $scope = @()
  foreach ($a in $RestArgs) {
    switch -CaseSensitive ($a) {
      '--strict'    { $strict = $true }
      '--skip-docs' { $skipDocs = $true }
      { $_ -ceq '-h' -or $_ -ceq '--help' } {
        Coop-Say 'Usage: coop review [paths...] [--strict] [--skip-docs]'
        Coop-Say '  Run coop-sql-review AND coop-dax-review over the project scope (explicit paths'
        Coop-Say "  win; else the nearest .coop/project.yml's repositories.*.local_path entries),"
        Coop-Say '  save both JSON reports under .coop/reviews/, then rebuild the lineage docs with'
        Coop-Say '  the findings composed in (coop-data-doc build --reviews …).'
        Coop-Say '  --strict      pass --strict to both linters; exit 2 if either exits non-zero'
        Coop-Say '  --skip-docs   skip the coop-data-doc build step (linters only)'
        return
      }
      default {
        if ($a -like '-*') { Coop-Die "unknown flag '$a' — usage: coop review [paths...] [--strict] [--skip-docs]" }
        $scope += $a
      }
    }
  }

  if (-not (Test-Have 'coop-sql-review')) { Coop-Die 'coop-sql-review is not installed. Run: coop install' }
  if (-not (Test-Have 'coop-dax-review')) { Coop-Die 'coop-dax-review is not installed. Run: coop install' }
  if (-not $skipDocs -and -not (Test-Have 'coop-data-doc')) { Coop-Die 'coop-data-doc is not installed. Run: coop install   (or skip the docs step: coop review --skip-docs)' }

  # Scope + output dir from the project contract (same semantics as coop-tools'
  # contractReviewScope: resolve against the contract's repo root, existing only).
  $proj = Find-CoopProjectYml
  $outdir = if ($proj) { Join-Path (Split-Path -Parent $proj) 'reviews' } else { Join-Path '.coop' 'reviews' }
  if ($scope.Count -eq 0 -and $proj) {
    $base = Split-Path -Parent (Split-Path -Parent $proj)
    foreach ($p in (Get-CoopYamlList $proj 'repositories.*.local_path')) {
      if (-not $p) { continue }
      if ($p -like 'TODO*') { Coop-Warn 'skipping a repositories.local_path that is still a TODO placeholder'; continue }
      $abs = if ([System.IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $base $p }
      if (Test-Path -LiteralPath $abs) { $scope += $abs } else { Coop-Warn "skipping $p (not found on this machine)" }
    }
  }
  if ($scope.Count -eq 0) { Coop-Die 'nothing to review — run inside a project with .coop/project.yml (repositories.*.local_path filled), or pass paths: coop review <paths...>' }

  New-Item -ItemType Directory -Force -Path $outdir -ErrorAction SilentlyContinue | Out-Null
  if (-not (Test-Path -LiteralPath $outdir -PathType Container)) { Coop-Die "cannot create $outdir" }
  $sqlJson = Join-Path $outdir 'coop-sql-review.json'
  $daxJson = Join-Path $outdir 'coop-dax-review.json'
  $extra = @(); if ($strict) { $extra = @('--strict') }

  # Run both linters over the SAME scope; capture exit codes, never abort here.
  Coop-Head "coop-sql-review check → $sqlJson"
  & coop-sql-review check @scope --format json -o $sqlJson @extra
  $sqlRc = $LASTEXITCODE
  if ($sqlRc -ne 0) { Coop-Warn "coop-sql-review exited $sqlRc" }
  Coop-Head "coop-dax-review check → $daxJson"
  & coop-dax-review check @scope --format json -o $daxJson @extra
  $daxRc = $LASTEXITCODE
  if ($daxRc -ne 0) { Coop-Warn "coop-dax-review exited $daxRc" }

  # Compose the findings onto the lineage docs (unless --skip-docs).
  $ddRc = 0
  if ($skipDocs) {
    Coop-Info 'skipping the lineage-docs step (--skip-docs)'
  } else {
    Coop-Head 'coop-data-doc build (composing review findings)'
    & coop-data-doc build --non-interactive --reviews $sqlJson --reviews $daxJson
    $ddRc = $LASTEXITCODE
    if ($ddRc -eq 1) {
      # Friendly "no config" exit — the findings are still saved; docs are an aid, not a gate.
      Coop-Warn 'lineage docs not set up — findings saved, docs step skipped. Set up lineage docs first: coop data-doc setup   (or /setup-docs in the agent)'
      $ddRc = 0
    } elseif ($ddRc -ne 0) {
      Coop-Err "coop-data-doc build failed (exit $ddRc)"
    } else {
      foreach ($d in @('data-docs-site', 'site')) {
        if (Test-Path -LiteralPath (Join-Path $d 'index.html') -PathType Leaf) { Coop-Ok "Portal: $d/index.html"; break }
      }
    }
  }

  # Summary: per-tool finding counts when cheaply parseable, else just the paths.
  # Feed the script via stdin (single-quoted here-string, quoting-proof on Windows
  # PowerShell 5.1 which mangles embedded double quotes in a native `-c` arg).
  $py = Get-CoopPython
  if ($py) {
    $summaryPy = @'
import json, sys
d = json.load(open(sys.argv[1]))
s = d.get("summary") or {}
f = d.get("findings")
n = len(f) if isinstance(f, list) else 0
print("%d finding(s) — %s error, %s warning, %s info" % (n, s.get("error", 0), s.get("warning", 0), s.get("info", 0)))
'@
    foreach ($f in @($sqlJson, $daxJson)) {
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
      $label = ($summaryPy | & $py - $f 2>$null) | Select-Object -First 1
      if ($label) { Coop-Ok "$(Split-Path -Leaf $f): $label  ($f)" } else { Coop-Ok "Report: $f" }
    }
  } else {
    Coop-Ok "Reports: $sqlJson  $daxJson"
  }
  Coop-Info "Tip: add these files to coop-data-doc.yml's reviews: list so CI check sees the same inputs."

  # Exit: hard data-doc failures propagate; --strict makes a failing linter exit 2.
  if ($ddRc -ge 2) { exit $ddRc }
  if ($strict -and ($sqlRc -ne 0 -or $daxRc -ne 0)) { exit 2 }
  exit 0
}

# --- Authoring scaffolders (mirror of bin/coop) ------------------------------
function Test-CoopValidName { param([string]$Name) if ($Name -in @('.', '..') -or $Name.StartsWith('-')) { return $false }; return ($Name -and $Name -notmatch '[^a-zA-Z0-9._-]') }

function Invoke-CoopInit {
  param([string[]]$RestArgs = @())
  # coop init [dir]              scaffold .coop\project.yml (current behavior)
  # coop init --seed-docs [dir]  generate/patch coop-data-doc.yml from an EXISTING
  #                              contract's repositories: (paths typed once, not twice)
  $seed = $false; $dir = ''
  foreach ($a in $RestArgs) {
    switch -CaseSensitive ($a) {
      '--seed-docs' { $seed = $true }
      '--yes'       { $env:COOP_ASSUME_YES = '1' }
      '-y'          { $env:COOP_ASSUME_YES = '1' }
      default {
        if ($a -like '-*') { Coop-Die "unknown flag '$a' — usage: coop init [dir] [--seed-docs] [--yes]" }
        $dir = $a
      }
    }
  }
  if (-not $dir) { $dir = (Get-Location).Path }
  if ($seed) { Invoke-CoopInitSeedDocs $dir; return }
  $tmpl = Join-Path $script:CoopRoot '.coop\project.example.yml'
  if (-not (Test-Path -LiteralPath $tmpl -PathType Leaf)) { Coop-Die 'template missing: .coop/project.example.yml' }
  $dst = Join-Path $dir '.coop\project.yml'
  if (Test-Path -LiteralPath $dst) { Coop-Die "$dst already exists — not overwriting.  (seed coop-data-doc.yml from it with: coop init --seed-docs)" }
  New-Item -ItemType Directory -Force -Path (Join-Path $dir '.coop') | Out-Null
  Copy-Item -LiteralPath $tmpl -Destination $dst
  Coop-Ok "Wrote $dst"
  Coop-Info 'Fill in the TODOs (repo paths, Fabric/Power BI workspaces, tenant), then: coop doctor'
  Coop-Info 'Once repositories: is filled, seed the lineage-docs config from it: coop init --seed-docs'
  Coop-Info 'Or set up lineage docs interactively: `coop data-doc setup` (full wizard) — or launch `coop` and accept the /setup-docs offer.'
}

# Seed coop-data-doc.yml's repos: from the contract's repositories: (issue #25) —
# mirror of coop_init_seed_docs in bin/coop. lib/_seeddocs.py classifies the filled
# repos into coop-data-doc's sql/powerbi slots (TODO placeholders skipped with a
# note) and prints the JSON patch; `coop-data-doc config-set --from-json -` applies
# it non-destructively. Declining changes nothing.
function Invoke-CoopInitSeedDocs {
  param([string]$Dir)
  $proj = Join-Path $Dir '.coop\project.yml'
  if (-not (Test-Path -LiteralPath $proj -PathType Leaf)) { Coop-Die "no $proj — run 'coop init' first, then fill repositories:." }
  $py = Get-CoopPython
  if (-not $py) { Coop-Die 'python is required for: coop init --seed-docs' }
  if (-not (Test-Have 'coop-data-doc')) { Coop-Die 'coop-data-doc is not installed. Run: coop install' }
  # The mapping summary (and any skip notes) print to stderr; the patch is stdout.
  $patch = (& $py (Join-Path $script:CoopRoot 'lib/_seeddocs.py') $proj | Out-String)
  $rc = $LASTEXITCODE
  if ($rc -eq 3) {
    Coop-Warn "nothing to seed yet — fill repositories.*.local_path in $proj (TODO placeholders are skipped), then re-run: coop init --seed-docs"
    exit 1
  }
  if ($rc -ne 0 -or -not $patch.Trim()) { Coop-Die "could not read repositories from $proj" }
  if (-not (Coop-Confirm "Write these repos into $Dir\coop-data-doc.yml?")) {
    Coop-Info 'seed cancelled — nothing changed.'
    exit 1
  }
  $cfg = Join-Path $Dir 'coop-data-doc.yml'
  $patch | & coop-data-doc config-set --config $cfg --from-json - > $null
  if ($LASTEXITCODE -eq 0) {
    Coop-Ok "seeded $cfg from project.yml (repos)"
    Coop-Info 'review it, then build the lineage docs: coop data-doc   (or /setup-docs inside the agent)'
  } else {
    Coop-Die "coop-data-doc config-set failed — apply the patch by hand: $py $(Join-Path $script:CoopRoot 'lib/_seeddocs.py') $proj | coop-data-doc config-set --from-json -"
  }
}

function New-CoopSkill {
  param([string[]]$RestArgs = @())
  $name = if ($RestArgs.Count -ge 1) { $RestArgs[0] } else { '' }
  if (-not (Test-CoopValidName $name)) { Coop-Die 'Usage: coop new-skill <name>  (letters, digits, . _ - only)' }
  if ($name -eq '_microsoft') { Coop-Die "'_microsoft' is reserved for official Microsoft skills." }
  $dir = Join-Path $script:CoopRoot "skills\$name"
  if (Test-Path -LiteralPath $dir) { Coop-Die "skills/$name already exists." }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $body = @"
---
name: $name
description: TODO one-line summary of when to use this skill.
---

# $name skill

TODO: when to use this skill.

## Checklist
- TODO
- TODO

## Tools
- Use the native tools (sql_review / dax_review / data_doc) and read-only MCP as needed.
- Operates under the coop-workflow skill and docs/guardrails.md (advisory, read-only first).

## Output
- Pass/fail summary, findings by severity, suggested fixes (advisory — never auto-edit).
"@
  # Write LF, no BOM (Set-Content -Encoding UTF8 emits BOM+CRLF on Windows PowerShell
  # 5.1, which breaks the bash-side frontmatter parser `coop_skill_name`). Same
  # [IO.File]::WriteAllText path the release code uses.
  [System.IO.File]::WriteAllText((Join-Path $dir 'SKILL.md'), ($body -replace "`r`n", "`n"))
  Coop-Ok "Created skills/$name/SKILL.md"
  Coop-Info 'Edit it, test with: coop  — then commit & push so the team gets it.'
}

function New-CoopPrompt {
  param([string[]]$RestArgs = @())
  $name = if ($RestArgs.Count -ge 1) { $RestArgs[0] } else { '' }
  if (-not (Test-CoopValidName $name)) { Coop-Die 'Usage: coop new-prompt <name>  (letters, digits, . _ - only)' }
  $f = Join-Path $script:CoopRoot "prompts\$name.md"
  if (Test-Path -LiteralPath $f) { Coop-Die "prompts/$name.md already exists." }
  $body = @"
# $name

Use the ``coop-workflow`` skill.

Task: TODO describe the task for {{subject}}.
Goal: {{goal}}

Steps:
1. Read .coop/project.yml and the relevant standards.
2. TODO …
3. Keep read-only first; present a PLAN and get approval before any edit.
4. Never commit source — show the diff and let a human commit.
"@
  # Write LF, no BOM (see New-CoopSkill).
  [System.IO.File]::WriteAllText($f, ($body -replace "`r`n", "`n"))
  Coop-Ok "Created prompts/$name.md"
  Coop-Info 'Edit it, then it loads automatically next time you run: coop'
}

# --- Release gate: tested_with pins vs coop-website/versions.json -------------
# Mirror of coop_release_check_pins in bin/coop. config/defaults.yml pins the
# coop-tool versions coop was last verified against; the sibling coop-website
# checkout's versions.json is the suite's single source of truth for released
# version strings. Pins match -> $true; a mismatch dies (fix defaults.yml, or
# --no-check); a missing sibling warns + confirms (--yes continues with a note).
# Returns $false when the user declines the confirm (caller cancels the release).
function Test-CoopReleasePins {
  param([bool]$AssumeYes = $false)
  $defaults = Join-Path $script:CoopRoot 'config\defaults.yml'
  $vjson = Join-Path (Split-Path -Parent $script:CoopRoot) 'coop-website\versions.json'
  if (-not (Test-Path -LiteralPath $vjson -PathType Leaf)) {
    Coop-Warn "sibling coop-website checkout not found — can't verify config/defaults.yml tested_with against versions.json (see RELEASE.md)."
    if ($AssumeYes) {
      Coop-Info 'continuing (--yes) — verify the tested_with pins by hand.'
      return $true
    }
    return (Coop-Confirm 'Release without verifying the tested_with pins?')
  }
  $vraw = Get-Content -LiteralPath $vjson -Raw
  $mismatch = $false
  foreach ($tool in @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')) {
    $key = $tool -replace '-', '_'
    $pin = Get-CoopYamlValue $defaults "tested_with.$key" ''
    # versions.json keeps a strict one-`"key": "value"`-per-line layout (enforced
    # by coop-website's own checker), so a regex read is safe — and python-free.
    $rel = ''
    if ($vraw -match ('"' + [regex]::Escape($tool) + '"\s*:\s*"([^"]*)"')) { $rel = $matches[1] }
    if (-not $rel) {
      Coop-Warn "could not read $tool from coop-website/versions.json — skipping its pin check."
      continue
    }
    if (-not $pin) {
      Coop-Warn "could not read tested_with.$key from config/defaults.yml (versions.json says $tool is $rel)."
      $mismatch = $true
    } elseif ($pin -ne $rel) {
      Coop-Warn "tested_with.$key is $pin but coop-website/versions.json says $tool is $rel."
      $mismatch = $true
    }
  }
  if ($mismatch) {
    Coop-Die 'tested_with pins disagree with coop-website/versions.json — update config/defaults.yml (see RELEASE.md), or re-run with --no-check.'
  }
  Coop-Ok 'tested_with pins match coop-website/versions.json'
  return $true
}

# --- Release: bump version, roll CHANGELOG, commit + tag (+ push) -------------
# Mirror of coop_release in bin/coop. Writes files with LF via [IO.File] to avoid
# Windows CRLF/BOM drift. Requires a clean working tree.
function Invoke-CoopRelease {
  param([string[]]$RestArgs = @())
  $level = ''; $assumeYes = $false; $doPush = $true; $doCheck = $true
  foreach ($a in $RestArgs) {
    switch -Regex ($a) {
      '^(patch|minor|major)$' { $level = $a }
      '^(-y|--yes)$'          { $assumeYes = $true }
      '^--no-push$'           { $doPush = $false }
      '^--check$'             { $doCheck = $true }
      '^--no-check$'          { $doCheck = $false }
      '^(-h|--help)$' {
        Coop-Say 'Usage: coop release [patch|minor|major] [--yes] [--no-push] [--no-check]'
        Coop-Say '  Bump VERSION + extension manifests, roll CHANGELOG [Unreleased] into a dated'
        Coop-Say '  release, commit, tag vX.Y.Z, and push (commit + tag). Default level: patch.'
        Coop-Say '  Verifies extensions transpile + tests + bash/PowerShell parity pass, and that'
        Coop-Say '  the tested_with coop-tool pins match the sibling coop-website''s versions.json'
        Coop-Say '  (--no-check to skip).'
        Coop-Say '  Requires a clean working tree (commit your changes first).'
        return
      }
      default { Coop-Die "unknown arg '$a' — usage: coop release [patch|minor|major] [--yes] [--no-push] [--no-check]" }
    }
  }
  if (-not $level) { $level = 'patch' }

  if (-not (Test-Have 'git')) { Coop-Die "git is required for 'coop release'." }
  $root = $script:CoopRoot
  & git -C $root rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -ne 0) { Coop-Die "$root is not a git checkout." }
  if (& git -C $root status --porcelain) { Coop-Die 'working tree not clean — commit or stash your changes before releasing.' }

  $verFile = Join-Path $root 'VERSION'
  if (-not (Test-Path -LiteralPath $verFile -PathType Leaf)) { Coop-Die "VERSION file missing at $verFile — fix it before releasing." }
  $cur = (Get-Content -LiteralPath $verFile -Raw).Trim()
  if ($cur -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Coop-Die "VERSION ('$cur') is not X.Y.Z — fix it before releasing." }
  $p = $cur.Split('.'); $ma = [int]$p[0]; $mi = [int]$p[1]; $pa = [int]$p[2]
  switch ($level) {
    'major' { $new = "$($ma + 1).0.0" }
    'minor' { $new = "$ma.$($mi + 1).0" }
    'patch' { $new = "$ma.$mi.$($pa + 1)" }
  }

  & git -C $root rev-parse "v$new" *> $null
  if ($LASTEXITCODE -eq 0) { Coop-Die "tag v$new already exists." }

  # Pre-flight: never tag code that doesn't transpile. Skips when npx is unavailable;
  # bypass with --no-check. Builds to a temp file (portable null output).
  if ($doCheck) {
    if (Test-Have 'npx') {
      $buildFail = $false
      Get-ChildItem -LiteralPath (Join-Path $root 'extensions') -Directory | ForEach-Object {
        $ext = Join-Path $_.FullName 'index.ts'
        if (Test-Path -LiteralPath $ext) {
          $tmpOut = [System.IO.Path]::GetTempFileName()
          & npx -y esbuild $ext --bundle --format=esm --platform=node --packages=external --outfile=$tmpOut *> $null
          $code = $LASTEXITCODE
          Remove-Item -LiteralPath $tmpOut -ErrorAction SilentlyContinue
          if ($code -ne 0) { Coop-Warn "extension does not build: $($_.Name)/index.ts"; $buildFail = $true }
        }
      }
      if ($buildFail) { Coop-Die 'extension build check failed — fix it, or re-run with --no-check.' }
      Coop-Ok 'extensions build'
    } else {
      Coop-Warn 'npx not found — skipping the extension build check.'
    }

    # Gate on the full Node suite + bash/PowerShell parity, not just transpile.
    # Both are bash scripts, so they need bash (Git Bash / WSL) on Windows. If the
    # gate can't run on this host we fail closed before a push (below) rather than
    # silently tagging an unverified release — matching the macOS/Linux path, where
    # bash is guaranteed and the gate always runs.
    $gateSkipped = $false
    $testsSh = Join-Path (Join-Path $root 'tests') 'run.sh'
    if (Test-Path -LiteralPath $testsSh) {
      if ((Test-Have 'bash') -and (Test-Have 'node')) {
        # Capture combined output and echo it on failure, so a Windows test failure
        # is diagnosable (the bash path cats its log to stderr for the same reason).
        $testOut = & bash $testsSh 2>&1
        if ($LASTEXITCODE -eq 0) { Coop-Ok 'tests pass' }
        else { $testOut | Out-String | Write-Host; Coop-Die 'tests failed (bash tests/run.sh) — fix them, or re-run with --no-check.' }
      } else {
        Coop-Warn 'bash or node not found — skipping the test suite.'; $gateSkipped = $true
      }
    }
    $paritySh = Join-Path (Join-Path $root 'scripts') 'check-parity.sh'
    if (Test-Path -LiteralPath $paritySh) {
      if (Test-Have 'bash') {
        & bash $paritySh *> $null
        if ($LASTEXITCODE -eq 0) { Coop-Ok 'parity check passes' }
        else { Coop-Die 'parity check failed (bash scripts/check-parity.sh) — fix it, or re-run with --no-check.' }
      } else {
        Coop-Warn 'bash not found — skipping the parity check.'; $gateSkipped = $true
      }
    }
    # Fail closed: a host that could not run the gate must not PUBLISH an unverified
    # tag. Bumping/committing locally (--no-push) is fine; a push requires the gate
    # to have run — or an explicit --no-check opt-out (which skips this whole block).
    if ($gateSkipped -and $doPush) {
      Coop-Die 'release gate could not run (bash/node not found) — cut the release from macOS/Linux or a Windows host with Git Bash/WSL, use --no-push to bump locally only, or --no-check to release without gating.'
    }

    # tested_with pins vs the sibling coop-website's versions.json: a mismatch
    # dies; a missing sibling warns + confirms (--yes continues). See
    # Test-CoopReleasePins above and RELEASE.md.
    if (-not (Test-CoopReleasePins -AssumeYes:$assumeYes)) {
      Coop-Info 'release cancelled — nothing changed.'; return
    }
  }

  $pushMsg = if ($doPush) { ' + push' } else { '' }
  if (-not $assumeYes) {
    if (-not (Coop-Confirm "Release v$cur -> v$new? (bump VERSION + manifests, roll CHANGELOG, commit, tag v$new$pushMsg)")) {
      Coop-Info 'release cancelled — nothing changed.'; return
    }
  }

  $today = (Get-Date -Format 'yyyy-MM-dd')

  # 1. VERSION (LF)
  [System.IO.File]::WriteAllText((Join-Path $root 'VERSION'), "$new`n")

  # 2. extension manifests
  Get-ChildItem -LiteralPath (Join-Path $root 'extensions') -Directory | ForEach-Object {
    $pkg = Join-Path $_.FullName 'package.json'
    if (Test-Path -LiteralPath $pkg) {
      $c = Get-Content -LiteralPath $pkg -Raw
      $c = [regex]::Replace($c, '"version":\s*"[0-9][^"]*"', "`"version`": `"$new`"")
      [System.IO.File]::WriteAllText($pkg, $c)
    }
  }

  # 3. CHANGELOG: insert a dated [X.Y.Z] heading right under [Unreleased]
  $clog = Join-Path $root 'CHANGELOG.md'
  if (Test-Path -LiteralPath $clog) {
    $lines = Get-Content -LiteralPath $clog
    if ($lines -match '^## \[Unreleased\]') {
      $out = New-Object System.Collections.Generic.List[string]
      $done = $false
      foreach ($ln in $lines) {
        $out.Add($ln)
        if (-not $done -and $ln -match '^## \[Unreleased\]') { $out.Add(''); $out.Add("## [$new] — $today"); $done = $true }
      }
      [System.IO.File]::WriteAllText($clog, ($out -join "`n") + "`n")
    } else {
      Coop-Warn "no '## [Unreleased]' heading in CHANGELOG.md — skipped the changelog roll."
    }
  }

  # 4. commit + tag. Stage ONLY the files a release touches — never `add -A`, which
  # would sweep in anything created during the (slow) gate window if another agent or
  # an editor autosave shares the tree (this is how a spurious empty release got cut).
  & git -C $root add VERSION CHANGELOG.md
  Get-ChildItem -LiteralPath (Join-Path $root 'extensions') -Directory | ForEach-Object {
    $pkg = Join-Path $_.FullName 'package.json'
    if (Test-Path -LiteralPath $pkg) { & git -C $root add $pkg }
  }
  & git -C $root commit -q -m "Release v$new"
  if ($LASTEXITCODE -ne 0) { Coop-Die 'git commit failed.' }
  & git -C $root tag -a "v$new" -m "coop-agent v$new"
  if ($LASTEXITCODE -ne 0) { Coop-Die 'git tag failed.' }
  Coop-Ok "released v$new (was v$cur)"

  # 5. push
  if ($doPush) {
    $branch = (& git -C $root rev-parse --abbrev-ref HEAD)
    & git -C $root push origin $branch *> $null
    if ($LASTEXITCODE -eq 0) { Coop-Ok "pushed $branch" } else { Coop-Warn "git push $branch failed — push manually: git push origin $branch" }
    & git -C $root push origin "v$new" *> $null
    if ($LASTEXITCODE -eq 0) { Coop-Ok "pushed tag v$new" } else { Coop-Warn 'git push tag failed — push manually.' }
  } else {
    Coop-Info "not pushed (--no-push). When ready: git push origin HEAD; git push origin v$new"
  }
}

# --- Dispatch ----------------------------------------------------------------
$argList = @()
if ($null -ne $args) { $argList = @($args) }
$cmd = if ($argList.Count -ge 1) { $argList[0] } else { '' }
# Everything after the subcommand. Guard the count<=1 case: PowerShell ranges like
# 1..0 count DOWNWARDS (1,0) and would wrongly re-include element 0.
$rest = if ($argList.Count -gt 1) { @($argList[1..($argList.Count - 1)]) } else { @() }

# Surface freshly-installed tools (npm-global `pi`, pipx `fab`/coop-*) on PATH for
# this process so a shell whose persistent PATH predates the install still finds them.
Add-CoopRuntimePaths

switch -CaseSensitive ($cmd) {
  '' { Invoke-LaunchPi; break }
  # Dry-run twin of bash's `--no-launch`: run the preflights, then PRINT the resolved pi
  # invocation instead of launching (the flag used to launch — the opposite of its name).
  # Same stdout as `coop launch-spec`; trailing args (e.g. --json) pass through.
  '--no-launch' { Invoke-CoopLaunchPreflight; Invoke-CoopLaunchSpec $rest; break }
  'doctor' { & (Join-Path $script:CoopRoot 'scripts\doctor.ps1') @rest; exit $LASTEXITCODE }
  'update' { & (Join-Path $script:CoopRoot 'scripts\update.ps1') @rest; exit $LASTEXITCODE }
  'bootstrap' { & (Join-Path $script:CoopRoot 'scripts\install.ps1') @rest; exit $LASTEXITCODE }
  'install' {
    # Bare `coop install` (or with bootstrap flags) bootstraps the whole stack.
    # `coop install <source>` adds a Pi extension (alias of `coop add`).
    if ($rest.Count -eq 0 -or $rest[0].StartsWith('-')) {
      & (Join-Path $script:CoopRoot 'scripts\install.ps1') @rest
      exit $LASTEXITCODE
    }
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed. Run: coop bootstrap' }
    & pi install @rest
    exit $LASTEXITCODE
  }
  'sync' { & (Join-Path $script:CoopRoot 'scripts\sync.ps1') @rest; exit $LASTEXITCODE }
  'web' { Invoke-CoopWeb $rest; break }
  'launch-spec' { Invoke-CoopLaunchSpec $rest; break }
  'init' { Invoke-CoopInit $rest; break }
  'new-skill' { New-CoopSkill $rest; break }
  'new-prompt' { New-CoopPrompt $rest; break }
  'release' { Invoke-CoopRelease $rest; break }
  'data-doc' { Invoke-DataDoc $rest; break }
  'sql-review' { Invoke-Tool 'coop-sql-review' $rest; break }
  'dax-review' { Invoke-Tool 'coop-dax-review' $rest; break }
  'review' { Invoke-CoopReview $rest; break }
  { $_ -ceq 'fabric' -or $_ -ceq 'fab' } {
    if (-not (Test-Have 'fab')) { Coop-Die 'Microsoft Fabric CLI (fab) not found. Run: coop install' }
    & fab @rest
    exit $LASTEXITCODE
  }
  # --- Pi management, aliased under coop ---
  'add' {
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed. Run: coop bootstrap' }
    & pi install @rest
    exit $LASTEXITCODE
  }
  'remove' {
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed.' }
    & pi remove @rest
    exit $LASTEXITCODE
  }
  'uninstall' {
    # Bare `coop uninstall` (or with flags) removes coop's footprint from this
    # machine (scripts\uninstall.ps1; --keep-tools spares pi + the pipx tools).
    # `coop uninstall <source>` removes a Pi extension (alias of `coop remove`) —
    # the same bare-vs-source split `coop install` uses.
    if ($rest.Count -eq 0 -or $rest[0].StartsWith('-')) {
      & (Join-Path $script:CoopRoot 'scripts\uninstall.ps1') @rest
      exit $LASTEXITCODE
    }
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed.' }
    & pi uninstall @rest
    exit $LASTEXITCODE
  }
  'list' {
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed.' }
    & pi list @rest
    exit $LASTEXITCODE
  }
  'config' {
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed.' }
    & pi config @rest
    exit $LASTEXITCODE
  }
  'pi' {
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed.' }
    & pi @rest
    exit $LASTEXITCODE
  }
  { $_ -ceq 'version' -or $_ -ceq '--version' -or $_ -ceq '-V' } {
    Write-Host ("coop {0}" -f $script:CoopVersion)
    if (Test-Have 'pi') {
      $pv = (& pi --version 2>$null)
      if (-not $pv) { $pv = '?' }
      Write-Host ("pi   {0}" -f $pv)
    } else {
      Write-Host 'pi   (not installed)'
    }
    break
  }
  { $_ -ceq 'help' -or $_ -ceq '--help' -or $_ -ceq '-h' } { Show-Usage; break }
  default {
    # Unknown flags (-*) or unknown subcommand: pass straight to pi (files/messages).
    Invoke-LaunchPi -PassArgs $argList
    break
  }
}
