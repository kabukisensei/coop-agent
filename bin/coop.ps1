#!/usr/bin/env pwsh
#
# coop.ps1 — the Cooptimize terminal agent: the one dispatcher (bin/coop.cmd and the
# Git Bash forwarder bin/coop both run it).
#
# A thin, branded layer ON TOP OF Pi (@earendil-works/pi-coding-agent). coop never
# forks Pi: it launches `pi` with Cooptimize skills, prompts, theme, a powerline
# splash/footer extension, and a governance system prompt, and it shells out to
# the standalone Coop tool (coop-data-doc)
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
#   coop support [--json]     Collect a sanitized support bundle (health, versions, events); preview + export
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
# That lets `coop -c` / `coop @file ...` pass straight through to pi.

# Don't let a single failing native command tear down the dispatcher; every
# subcommand propagates its exit code explicitly.
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (coop's one helper library) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, Test-Have,
# Get-CoopPython, YAML readers, Find-CoopProjectYml, Coop-Confirm, etc.
$CoopCommonPs1 = (Join-Path $PSScriptRoot '../lib/common.ps1')
if (-not (Test-Path -LiteralPath $CoopCommonPs1)) {
  # A fresh clone/install whose lib\common.ps1 vanishes before first launch was
  # almost always quarantined by antivirus/Defender (Mark-of-the-Web + AMSI
  # heuristics). Fail with the fix instead of cascading CommandNotFoundException.
  Write-Host ''
  Write-Host "coop: missing $CoopCommonPs1" -ForegroundColor Red
  Write-Host 'The helper library ships with the repo. If it disappeared right after a clone or install,' -ForegroundColor Yellow
  Write-Host 'endpoint security likely quarantined it: check Defender Protection history (or your AV),' -ForegroundColor Yellow
  Write-Host 'restore the file with:  git restore lib/common.ps1' -ForegroundColor Yellow
  Write-Host 'and add an exclusion for the repo directory, then re-run.' -ForegroundColor Yellow
  exit 1
}
. $CoopCommonPs1

# Isolate coop's Pi config (extensions, settings, themes, MCP) from the user's personal
# `pi` — for launching AND the coop add/remove/list/config/pi management aliases.
# Disable with COOP_NO_ISOLATE=1 (or true/yes/on).
if (-not (Test-CoopNoIsolate)) {
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
    # npm can print a notice before the path (seen under Git Bash on the Windows
    # runner with a temp HOME): keep the last non-blank line, never an array.
    $lines = @(& npm prefix -g 2>$null | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() -ne '' })
    $p = ''
    if ($lines.Count -gt 0) { $p = $lines[$lines.Count - 1].Trim() }
    if ($p) { $dirs += $p; $dirs += (Join-Path $p 'bin') }   # win: shims in prefix; *nix: prefix/bin
  }
  $dirs += (Join-Path $HOME '.local\bin')                    # pipx default PIPX_BIN_DIR
  foreach ($d in $dirs) {
    if ($d -and (Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
      $env:PATH = "$d;$env:PATH"
    }
  }
}

# --- Onboarding / profile ----------------------------------------------------
function Invoke-CoopOnboard {
  param([string[]]$Rest)
  $py = Get-CoopPython
  if (-not $py) { Coop-Die 'python3 is required for coop onboard' }
  & $py (Join-Path $script:CoopRoot 'scripts\onboard.py') onboard @Rest
  exit $LASTEXITCODE
}

function Invoke-CoopProfile {
  param([string[]]$Rest)
  $py = Get-CoopPython
  if (-not $py) { Coop-Die 'python3 is required for coop profile' }
  & $py (Join-Path $script:CoopRoot 'scripts\onboard.py') profile @Rest
  exit $LASTEXITCODE
}

# --- TeamAI shared knowledge (K1: isolated CLI, read-only recall) ------------
# Every operation goes through lib/teamai.py: the pinned teamai-cli lives only in
# <profile dir>\teamai\pkg, runs with its home redirected to <profile dir>\teamai\home
# and a disposable workspace, hooks disabled, a hard timeout, and reports one
# JSON document per call (state: disabled | not_installed | not_initialized |
# ok | no_match | partial | unavailable). Nothing here runs at launch.
function Invoke-CoopTeamai {
  param([string[]]$Rest)
  $py = Get-CoopPython
  if (-not $py) { Coop-Die 'python3 is required for coop teamai' }
  if (-not $Rest -or $Rest.Count -eq 0) { Coop-Die 'usage: coop teamai <status|install|init|pull|skills|maintenance|recall --query <text>|compare --query <text>|contribute --file <draft.md> [--title <text>] [--approve]>' }
  & $py (Join-Path $script:CoopRoot 'lib\teamai.py') @Rest
  exit $LASTEXITCODE
}

function Invoke-CoopContextBudget {
  param([string[]]$Rest)
  $py = Get-CoopPython
  if (-not $py) { Coop-Die 'python3 is required for coop context-budget' }
  & $py (Join-Path $script:CoopRoot 'scripts\context-budget.py') @Rest
  exit $LASTEXITCODE
}

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
  coop onboard              First-run global onboarding (creates ~/.coop/user.json)
  coop onboard --platform <fabric|azure_sql|both>   Answer the client platform question without a prompt
  coop profile              Show your COOP user profile
  coop profile edit         Edit your COOP user profile
  coop profile reset        Remove your COOP user profile
  coop teamai <cmd>         TeamAI shared-knowledge trial, isolated (status|install|init|pull|
                            skills|maintenance|recall --query <text>|compare --query <text>|
                            contribute --file <draft.md> [--approve]); off until
                            knowledge.teamai.enabled is true
  coop context-budget       Report fixed startup context sizes (use --json for machine output)
  coop data-doc [args]      Run coop-data-doc (default: build) and summarize outputs
                            (--strict: exit 2 on a failing linter; --skip-docs: linters only)
  coop support [--json]     Collect a sanitized support bundle (health, versions, events)
                            (--incident: incident record; --export PATH: write bundle)
  coop fabric [args]        Pass through to the Microsoft Fabric CLI (fab)
  coop version              Print coop + pi versions
  coop help                 Show this help

$(Coop-Bold)Authoring$(Coop-Rst)
  coop init [dir]           Scaffold .coop/project.yml into a work repo (default: .)
                            (--seed-docs: generate coop-data-doc.yml from repositories:)
  coop init --migrate-legacy [dir]
                            Inspect legacy project configuration (dry run; add --apply to confirm changes)
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

# The Azure sign-in preflight (Fabric + Power BI token check for the client
# tenant, automatic bounded sign-in in an interactive console, cached ~30 min)
# lives in lib/common.ps1 (Invoke-CoopAzPreflight) — called below by
# Invoke-LaunchPi.

# --- Launch the branded Pi agent ---------------------------------------------
# Launch-time skew guard (Invoke-CoopLaunchPreflight): refuse to exec
# pi into a known-broken extension load. If the Pi agent is too old for an installed
# extension (rc 11), aligning the tree can't help — abort with instructions instead
# of crashing in pi's loader. If the tree is merely skewed but fixable (rc 10), run
# sync to re-pin + reinstall, then continue. Read-only + fast. Bypass with
# COOP_SKIP_EXT_CHECK=1.
function Invoke-CoopLaunchPreflight {
  if ($env:COOP_SKIP_EXT_CHECK -eq '1') { return }
  if (-not (Test-Have 'pi')) { return }
  $py = Get-CoopPython; if (-not $py) { return }
  # The dir Pi will ACTUALLY load (with COOP_NO_ISOLATE Pi uses the personal
  # ~/.pi/agent, so guarding coop's isolated dir would be wrong).
  $agentDir = Get-CoopEffectiveAgentDir
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
      # Fixable tree skew in coop's OWN dir — re-pin + reinstall ONLY pi-ai/pi-tui, then
      # launch. Call the shared Sync-CoopExtDeps against the SAME effective agent dir we
      # detected the skew in (not the whole sync.ps1 child, which would also reinstall
      # deliberately-removed core extensions, re-merge MCP config, and never clear the
      # skew under a custom PI_CODING_AGENT_DIR). Mirrors bash coop_align_ext_deps.
      Sync-CoopExtDeps -AgentDir $agentDir
    }
  }
}

# --- Assemble the exact Pi launch spec (args + brand env) --------------------
# SINGLE SOURCE OF TRUTH for how coop launches Pi. Both Invoke-LaunchPi (the terminal agent) and
# Invoke-CoopLaunchSpec (`coop launch-spec`, JSON for the future desktop app)
# consume this, so the terminal and any other surface can NEVER drift. Returns the
# pi args array and exports the brand env. Read-only; never launches pi.
function Build-CoopPiArgs {
  $piArgs = @()
  # Governance system prompt (read-only-first guardrails). Appended, not replaced.
  $guardrails = Join-Path $script:CoopRoot 'docs\guardrails.md'
  if (Test-Path -LiteralPath $guardrails -PathType Leaf) { $piArgs += @('--append-system-prompt', $guardrails) }
  # Cooptimize skills — load each first-party folder individually. Official
  # Microsoft skills are resolved separately from the pinned immutable catalog.
  $skills = Join-Path $script:CoopRoot 'skills'
  $subordinateSlots = @('_microsoft', '_microsoft_fabric')
  if (Test-Path -LiteralPath $skills -PathType Container) {
    $ownNames = New-Object System.Collections.Generic.HashSet[string]
    Get-ChildItem -LiteralPath $skills -Directory | Where-Object { $_.Name -notin $subordinateSlots } | ForEach-Object {
      $sk = Join-Path $_.FullName 'SKILL.md'
      if (Test-Path -LiteralPath $sk -PathType Leaf) {
        $piArgs += @('--skill', $_.FullName)
        [void]$ownNames.Add($_.Name)
        $fm = Get-CoopSkillName $sk
        if ($fm) { [void]$ownNames.Add($fm) }
      }
    }
    $catPy = Get-CoopPython
    if ($catPy) {
      $effectiveAgentDir = Get-CoopEffectiveAgentDir
      $catArgs = @((Join-Path $script:CoopRoot 'lib\microsoft_skills.py'))
      $proj = Find-CoopProjectYml
      if ($proj) { $catArgs += @('--project', $proj) }
      $catArgs += 'launch-dirs'
      foreach ($msDir in (& $catPy @catArgs 2>$null)) {
        if ([string]::IsNullOrWhiteSpace($msDir)) { continue }
        $expectedPrefix = Join-Path $effectiveAgentDir 'catalogs\microsoft\generations'
        if ($msDir.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          $piArgs += @('--skill', $msDir)
        } else {
          Coop-Warn "ignoring Microsoft catalog path outside agent catalog: $msDir"
        }
      }
    }
    # Team skills roots: every knowledge repo's skills\ plus, when the TeamAI
    # trial's distribution is enabled (K3), the isolated clone's skills\. Same
    # subordinate rules for all of them: a Cooptimize skill always wins.
    $teamSkillRoots = @()
    if (Test-CoopKnowledgeEnabled) {
      foreach ($repo in (Get-CoopKnowledgeRepos)) {
        if ($repo.LocalPath) { $teamSkillRoots += (Join-Path $repo.LocalPath 'skills') }
      }
    }
    $teamaiSkills = Get-CoopTeamaiSkillsRoot
    if ($teamaiSkills) { $teamSkillRoots += $teamaiSkills }
    if ($teamSkillRoots.Count -gt 0) {
      foreach ($teamSkills in $teamSkillRoots) {
        if (-not (Test-Path -LiteralPath $teamSkills -PathType Container)) { continue }
        # Parse the frontmatter name BEFORE adding any launch argument; an
        # optional external skill that can't identify itself is skipped, never
        # added half-validated.
        foreach ($skillDir in (Get-ChildItem -LiteralPath $teamSkills -Directory)) {
          $sk = Join-Path $skillDir.FullName 'SKILL.md'
          if (-not (Test-Path -LiteralPath $sk -PathType Leaf)) { continue }
          if ($ownNames.Contains($skillDir.Name)) {
            Coop-Warn "skipping team skill '$($skillDir.Name)' (conflicts with a Cooptimize skill)"
            continue
          }
          $fm = Get-CoopSkillName $sk
          if (-not $fm) {
            Write-Error 'missing frontmatter name'
            continue
          }
          if ($ownNames.Contains($fm)) {
            Coop-Warn "skipping team skill '$($skillDir.Name)' (name '$fm' conflicts with a Cooptimize skill)"
            continue
          }
          $piArgs += @('--skill', $skillDir.FullName)
          [void]$ownNames.Add($skillDir.Name)
          [void]$ownNames.Add($fm)
        }
      }
    }
  }
  $prompts = Join-Path $script:CoopRoot 'prompts'
  if (Test-Path -LiteralPath $prompts -PathType Container) { $piArgs += @('--prompt-template', $prompts) }
  $theme = Join-Path $script:CoopRoot 'themes\cooptimize.json'
  if (Test-Path -LiteralPath $theme -PathType Leaf) { $piArgs += @('--theme', $theme) }
  # Cooptimize companion extensions: branding/splash/vibes, native tools, governance,
  # and the local user profile hidden instruction.
  $extPowerline = Join-Path $script:CoopRoot 'extensions\coop-powerline'
  if (Test-Path -LiteralPath $extPowerline) { $piArgs += @('-e', $extPowerline) }
  $extTools = Join-Path $script:CoopRoot 'extensions\coop-tools'
  if (Test-Path -LiteralPath $extTools) { $piArgs += @('-e', $extTools) }
  $extGuardrails = Join-Path $script:CoopRoot 'extensions\coop-guardrails'
  if (Test-Path -LiteralPath $extGuardrails) { $piArgs += @('-e', $extGuardrails) }
  $extProfile = Join-Path $script:CoopRoot 'extensions\coop-profile'
  if (Test-Path -LiteralPath $extProfile) { $piArgs += @('-e', $extProfile) }
  # Coop owns fleet updates. Hide Pi's upstream self-update banner so users do not
  # drift Pi away from the release-manifest pins; Invoke-CoopUpdateNudge still
  # reports when THIS checkout is behind and directs the user to `coop update`.
  if ($env:COOP_SHOW_UPSTREAM_UPDATE_NOTICES -ne '1') {
    $env:PI_SKIP_VERSION_CHECK = '1'
  }
  # MCP servers come only from coop's managed agent-dir mcp-adapter.json (#165). Without
  # this, pi-mcp-adapter also merges a work repo's .mcp.json / .pi/mcp.json and
  # other tools' configs, so a repo could add a server or redefine a coop one.
  $env:PI_MCP_CONFIG_MODE = 'exclusive'
  # Point the extension at our vibe files and brand splash.
  $env:COOP_VIBES_DIR = Join-Path $script:CoopRoot 'vibes'
  $env:COOP_SPLASH_FILE = Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi'
  return ,$piArgs
}

# --- Launch the branded Pi agent ---------------------------------------------
# The launch token for the managed Warehouse MCP (child-only, never argv or disk).
# lib/fabric_token_runner.mjs is the one validator of the helper's framed stdout:
# it exits 0 and forwards the frame only when it is exactly `token<TAB>...<TAB>end`
# or `warning<TAB><state><TAB>end` with a state from lib/warehouse_mcp.py
# WARNING_STATES. This function only splits that validated frame and keeps the
# state-to-message table.
function Get-CoopFabricMcpToken {
  $py = Get-CoopPython
  if (-not $py) { return '' }
  $agentDir = Get-CoopEffectiveAgentDir
  $config = Join-Path $agentDir 'mcp-adapter.json'
  if (-not (Test-Have 'node')) {
    Coop-Warn 'Fabric Warehouse MCP unavailable: token helper supervisor is unavailable'
    return ''
  }
  $previousEap = $ErrorActionPreference
  $records = @()
  $rc = 1
  try {
    # The Node supervisor captures both native streams byte-for-byte in memory,
    # rejects any stderr, and forwards only one exact framed stdout record.
    $ErrorActionPreference = 'Continue'
    $runner = Join-Path $script:CoopRoot 'lib\fabric_token_runner.mjs'
    $helper = Join-Path $script:CoopRoot 'lib\warehouse_mcp.py'
    $records = @(& node $runner $py $helper $config 2>&1)
    $rc = $LASTEXITCODE
  } catch {
    $rc = 1
  } finally {
    $ErrorActionPreference = $previousEap
  }
  if ($rc -ne 0) {
    Coop-Warn 'Fabric Warehouse MCP unavailable: token helper failed'
    return ''
  }
  $stdout = @()
  $stderrFound = $false
  foreach ($record in $records) {
    if ($record -is [System.Management.Automation.ErrorRecord]) {
      $stderrFound = $true
    } else {
      $stdout += $record.ToString()
    }
  }
  if ($stderrFound) {
    Coop-Warn 'Fabric Warehouse MCP unavailable: token helper returned invalid output'
    return ''
  }
  $protocol = ($stdout -join "`n")
  if (-not $protocol) { return '' }
  $fields = @($protocol -split "`t")
  if ($fields.Count -eq 3 -and $fields[2] -eq 'end' -and $fields[0] -eq 'token') { return $fields[1] }
  if ($fields.Count -eq 3 -and $fields[2] -eq 'end' -and $fields[0] -eq 'warning') {
    $state = $fields[1]
    $warnings = @{
      config_invalid = 'managed configuration is invalid; run coop sync'
      azure_cli_unavailable = 'Azure CLI is not installed or not on PATH'
      token_launch_failed = 'Azure CLI could not be launched'
      token_timeout = 'Azure CLI token acquisition timed out'
      auth_required = 'Azure authentication is required; run az login'
      token_command_failed = 'Azure CLI token acquisition failed'
      token_output_invalid = 'Azure CLI returned no usable Fabric token'
    }
    $message = $warnings[$state]
    if (-not $message) { $message = 'token helper returned invalid output' }
    if ($state -eq 'auth_required') {
      # The preflight's cached success is stale: drop it so the next launch
      # checks again (and signs in) instead of trusting the marker.
      Remove-Item -LiteralPath (Join-Path $agentDir '.az-ok') -Force -ErrorAction SilentlyContinue
    }
    Coop-Warn "Fabric Warehouse MCP unavailable: $message"
    return ''
  }
  Coop-Warn 'Fabric Warehouse MCP unavailable: token helper returned invalid output'
  return ''
}

function Invoke-CoopPiProcess {
  param([string[]] $PiArgs = @())
  Remove-Item Env:COOP_FABRIC_MCP_TOKEN -ErrorAction SilentlyContinue
  $token = Get-CoopFabricMcpToken
  if ($token) { $env:COOP_FABRIC_MCP_TOKEN = $token }
  try {
    & pi @PiArgs
    if ($?) {
      $script:CoopPiRc = $LASTEXITCODE
    } else {
      # Process failed to start (Windows PowerShell 5.1 with -ErrorActionPreference
      # Continue records the error instead of throwing, and leaves $LASTEXITCODE
      # stale). Reading it would silently succeed with an unrelated exit code.
      $launchCode = -1
      $startError = $error[0]
      if ($startError -and $startError.Exception) {
        $ex = $startError.Exception
        if ($ex.PSObject.Properties['NativeErrorCode']) { $launchCode = $ex.NativeErrorCode }
        elseif ($ex.InnerException -and $ex.InnerException.PSObject.Properties['NativeErrorCode']) { $launchCode = $ex.InnerException.NativeErrorCode }
        elseif ($ex.PSObject.Properties['HResult']) { $launchCode = $ex.HResult }
      }
      Coop-Warn "Pi launch failed (code=$launchCode)"
      $script:CoopPiRc = 1
    }
  } catch {
    $launchCode = $_.Exception.HResult
    $inner = $_.Exception.InnerException
    if ($inner -and $inner.PSObject.Properties['NativeErrorCode']) {
      $launchCode = $inner.NativeErrorCode
    }
    Coop-Warn "Pi launch failed (code=$launchCode)"
    $script:CoopPiRc = 1
  } finally {
    Remove-Item Env:COOP_FABRIC_MCP_TOKEN -ErrorAction SilentlyContinue
  }
}

function Invoke-LaunchPi {
  param([string[]] $PassArgs = @())

  if (-not (Test-Have 'pi')) {
    Coop-Die 'pi is not installed. Run: coop install   (installs the release''s tested Pi)'
  }

  # First launch (master plan FR1): no wizard and nothing that can stop the launch.
  # The first interactive launch hands coop-tools COOP_FIRST_RUN=1 so the Start
  # Here menu of common workflows opens once Pi is up; `coop onboard` stays on demand.
  Set-CoopFirstRunLaunch

  # Guard against launching into a known-broken extension load (agent/extension skew).
  Invoke-CoopLaunchPreflight

  # Once-a-day fleet-staleness nudge: warn when this checkout is behind the next
  # release tag (throttled fetch, bounded wait — never blocks or fails the launch).
  Invoke-CoopUpdateNudge

  # Bounded, noninteractive and fail-soft. Native stderr is suppressed so
  # PowerShell 5.1 cannot turn an offline credential diagnostic into a launch error.
  if (Test-Have 'node') {
    try { & node (Join-Path $script:CoopRoot 'lib\standards-cli.mjs') refresh 2>$null | Out-Null } catch { }
  }

  Invoke-CoopAzPreflight

  # A plain interactive launch with no stored provider credential should lead
  # directly into the real Pi login command. The coop-tools extension fills the
  # command into Pi's editor (CLI positional arguments would incorrectly send it
  # to the model as a prompt). Explicit Pi arguments are never overridden.
  if ($PassArgs.Count -eq 0 -and
      -not [Console]::IsInputRedirected -and
      -not [Console]::IsOutputRedirected -and
      $env:COOP_NO_MODEL_LOGIN -ne '1' -and
      -not (Test-CoopPiLoginPresent)) {
    $env:COOP_PRIME_MODEL_LOGIN = '1'
  }

  $piArgs = Build-CoopPiArgs
  $allArgs = @($piArgs + $PassArgs)
  try {
    Invoke-CoopPiProcess -PiArgs $allArgs
  } finally {
    Remove-Item Env:COOP_FIRST_RUN -ErrorAction SilentlyContinue
  }
  exit $script:CoopPiRc
}

# --- Emit the launch spec (for the future desktop app) -----------------------
# Internal/advanced. `coop launch-spec` prints the resolved pi invocation;
# `--json` emits {"bin","args","env"} for a programmatic consumer — e.g. the
# future desktop app, which spawns `pi --mode rpc` with the SAME governed spec the
# terminal uses. Read-only: builds the spec, never launches pi.
function Invoke-CoopLaunchSpec {
  param([string[]] $SpecArgs = @())
  $piArgs = Build-CoopPiArgs
  if ($SpecArgs -contains '--json') {
    $envMap = [ordered]@{}
    if ($env:PI_CODING_AGENT_DIR) { $envMap['PI_CODING_AGENT_DIR'] = $env:PI_CODING_AGENT_DIR }
    if ($env:PI_SKIP_VERSION_CHECK) { $envMap['PI_SKIP_VERSION_CHECK'] = $env:PI_SKIP_VERSION_CHECK }
    if ($env:PI_MCP_CONFIG_MODE)    { $envMap['PI_MCP_CONFIG_MODE']    = $env:PI_MCP_CONFIG_MODE }
    if ($env:COOP_VIBES_DIR)      { $envMap['COOP_VIBES_DIR']      = $env:COOP_VIBES_DIR }
    if ($env:COOP_SPLASH_FILE)    { $envMap['COOP_SPLASH_FILE']    = $env:COOP_SPLASH_FILE }
    # The JSON SHAPE ({bin,args,env}) is the contract with programmatic consumers — the
    # formatting (bash pretty-prints, this compresses) intentionally is not.
    [pscustomobject]@{ bin = 'pi'; args = @($piArgs); env = $envMap } | ConvertTo-Json -Depth 5 -Compress
  } else {
    # Mirror bash's %q-quoted human output: quote any arg containing whitespace.
    'pi ' + (($piArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  }
}

# --- coop web (retired) --------------------------------------------------------
# The browser UI was removed (master plan S5); the installable desktop app comes
# later. Older 'coop' shortcuts still run `coop web` in a minimized console, so
# restore that window and start the terminal agent instead of failing. `coop update`
# rewrites those shortcuts.
function Invoke-CoopWebRetired {
  if ($env:OS -eq 'Windows_NT') {
    try {
      Add-Type -Namespace CoopWin -Name Console -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);' -ErrorAction Stop
      $h = [CoopWin.Console]::GetConsoleWindow()
      if ($h -ne [System.IntPtr]::Zero) { [void][CoopWin.Console]::ShowWindow($h, 9) }  # SW_RESTORE
    } catch { }
  }
  Coop-Warn 'coop web was removed; starting coop in this terminal' 'run: coop update (it refreshes the coop shortcut)'
  Invoke-LaunchPi
}

# --- Tool wrapper ------------------------------------------------------------
# Flow straight through to coop-data-doc: every subcommand and its own interactive
# prompts work, and the exit code propagates. The AI agent gets structured JSON
# via the native data_doc tool.
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
  exit $rc   # a coop-data-doc failure must not be masked by the summary
}

# --- Authoring scaffolders ---------------------------------------------------
function Test-CoopValidName { param([string]$Name) if ($Name -in @('.', '..') -or $Name.StartsWith('-')) { return $false }; return ($Name -and $Name -notmatch '[^a-zA-Z0-9._-]') }

function Invoke-CoopInit {
  param([string[]]$RestArgs = @())
  # coop init [dir]              run the guided project wizard
  # coop init --template [dir]   copy the full documented example (legacy raw template)
  # coop init --migrate-legacy [dir] [--apply] [--archive .pi/path]
  #                              inspect first; apply only exact safe cleanup
  # coop init --seed-docs [dir]  generate/patch coop-data-doc.yml from an EXISTING
  #                              contract's repositories: (paths typed once, not twice)
  # coop init --ci github|ado    generate CI pipeline
  $seed = $false; $dir = ''; $ciType = ''; $template = $false
  $migrate = $false; $apply = $false; $archiveArgs = @()
  for ($i = 0; $i -lt $RestArgs.Count; $i++) {
    $a = $RestArgs[$i]
    switch -Regex ($a) {
      '^--seed-docs$' { $seed = $true }
      '^--template$'  { $template = $true }
      '^--migrate-legacy$' { $migrate = $true }
      '^--apply$' { $apply = $true }
      '^--archive$' {
        if ($i + 1 -lt $RestArgs.Count) { $archiveArgs += @('--archive', $RestArgs[++$i]) }
        else { Coop-Die '--archive requires a project-relative .pi file' }
      }
      '^--ci$' {
        if ($i + 1 -lt $RestArgs.Count) { $ciType = $RestArgs[++$i] }
        else { Coop-Die "--ci requires an argument (github or ado)" }
      }
      '^--yes$'       { $env:COOP_ASSUME_YES = '1' }
      '^-y$'          { $env:COOP_ASSUME_YES = '1' }
      default {
        if ($a -like '-*') { Coop-Die "unknown flag '$a' — usage: coop init [dir] [--seed-docs] [--template] [--migrate-legacy] [--apply] [--archive .pi/path] [--ci github|ado] [--yes]" }
        $dir = $a
      }
    }
  }
  if (-not $dir) { $dir = (Get-Location).Path }
  if ($migrate) {
    $py = Get-CoopPython
    if (-not $py) { Coop-Die 'python is required for: coop init --migrate-legacy' }
    $migrateArgs = @((Join-Path $script:CoopRoot 'lib/project_health.py'), 'migrate', $dir)
    if ($apply) { $migrateArgs += '--apply' }
    if ($env:COOP_ASSUME_YES -eq '1') { $migrateArgs += '--yes' }
    $migrateArgs += $archiveArgs
    & $py @migrateArgs
    exit $LASTEXITCODE
  }
  if ($seed) { Invoke-CoopInitSeedDocs $dir; return }
  if ($ciType) { Invoke-CoopInitCi $dir $ciType; return }
  $dst = Join-Path $dir '.coop\project.yml'
  if (Test-Path -LiteralPath $dst) { Coop-Die "$dst already exists — not overwriting.  (seed coop-data-doc.yml from it with: coop init --seed-docs)" }
  $py = Get-CoopPython
  if (-not $py) { Coop-Die 'python3 is required for: coop init' }
  $wizard = Join-Path (Join-Path $script:CoopRoot 'lib') 'init_wizard.py'
  if ($template) {
    New-Item -ItemType Directory -Force -Path (Join-Path $dir '.coop') | Out-Null
    & $py $wizard "$dir" --template > "$dst"
    if ($LASTEXITCODE -ne 0) {
      # Never leave an empty contract behind and report success.
      Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
      exit $LASTEXITCODE
    }
  } else {
    & $py $wizard "$dir"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  Coop-Ok "Wrote $dst"
  if ($template) {
    Coop-Info 'Fill in the TODOs (repo paths, Fabric/Power BI workspaces, tenant), then: coop doctor'
  }
  Coop-Info 'Once repositories: is filled, seed the lineage-docs config from it: coop init --seed-docs'
  Coop-Info 'Run the same native lineage wizard via `coop data-doc setup` or /setup-docs inside coop.'
}

# Seed coop-data-doc.yml's repos: from the contract's repositories: (issue #25).
# `coop init --seed-docs` runs this after the contract exists: lib/_seeddocs.py
# classifies the filled repos into coop-data-doc's sql/powerbi slots (TODO
# placeholders skipped with a note) and prints the JSON patch; `coop-data-doc
# config-set --from-json -` applies it non-destructively. Declining changes nothing.
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
  # config-set prints one status line: "Wrote <path> (validated)." or, when a slot
  # can't validate yet (a placeholder repo path), "... (saved, not runnable yet (...))."
  # Show it; the second is a warning, never silence (#102).
  $status = ($patch | & coop-data-doc config-set --config $cfg --from-json - | Out-String).Trim()
  if ($LASTEXITCODE -eq 0) {
    Coop-Ok "seeded $cfg from project.yml (repos)"
    if ($status -like '*not runnable yet*') {
      Coop-Warn $status 'fix the repo path it names (or run: coop data-doc setup), then build: coop data-doc'
    } else {
      if ($status) { Coop-Info $status }
      Coop-Info 'review it, then build the lineage docs: coop data-doc   (or /setup-docs inside the agent)'
    }
  } else {
    Coop-Die "coop-data-doc config-set failed — apply the patch by hand: $py $(Join-Path $script:CoopRoot 'lib/_seeddocs.py') $proj | coop-data-doc config-set --from-json -"
  }
}

function New-CoopSkill {
  param([string[]]$RestArgs = @())
  $name = if ($RestArgs.Count -ge 1) { $RestArgs[0] } else { '' }
  if (-not (Test-CoopValidName $name)) { Coop-Die 'Usage: coop new-skill <name>  (letters, digits, . _ - only)' }
  if ($name -in @('_microsoft', '_microsoft_fabric')) { Coop-Die "'$name' is reserved for subordinate skill slots." }
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
- Use the native tools (data_doc / bpa_review) and read-only MCP as needed.
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
1. Read .coop/project.yml and use COOP's resolved standards task authority.
2. TODO …
3. Keep read-only first; present a PLAN and get approval before any edit.
4. Never commit source — show the diff and let a human commit.
"@
  # Write LF, no BOM (see New-CoopSkill).
  [System.IO.File]::WriteAllText($f, ($body -replace "`r`n", "`n"))
  Coop-Ok "Created prompts/$name.md"
  Coop-Info 'Edit it, then it loads automatically next time you run: coop'
}

# --- Release gate: the manifest's coop-tool pins vs coop-website/versions.json -
# config/release-manifest.json (python_tools) pins the coop-tool versions a release
# installs; the sibling coop-website checkout's versions.json is the suite's single
# source of truth for released version strings. Pins match -> $true; a mismatch
# dies (fix the manifest, or --no-check); a missing sibling warns + confirms (--yes
# continues with a note). Returns $false when the user declines the confirm
# (caller cancels the release). scripts/release.sh's coop_release_check_pins is
# the same gate for a bash release.
function Test-CoopReleasePins {
  param([bool]$AssumeYes = $false)
  $vjson = Join-Path (Split-Path -Parent $script:CoopRoot) 'coop-website\versions.json'
  if (-not (Test-Path -LiteralPath $vjson -PathType Leaf)) {
    Coop-Warn "sibling coop-website checkout not found — can't verify config/release-manifest.json python_tools against versions.json (see RELEASE.md)."
    if ($AssumeYes) {
      Coop-Info 'continuing (--yes) — verify the coop-tool pins by hand.'
      return $true
    }
    return (Coop-Confirm 'Release without verifying the coop-tool pins?')
  }
  $vraw = Get-Content -LiteralPath $vjson -Raw
  $mismatch = $false
  foreach ($tool in @('coop-data-doc')) {
    $pin = Coop-ManifestObjectGet 'python_tools' $tool
    # versions.json keeps a strict one-`"key": "value"`-per-line layout (enforced
    # by coop-website's own checker), so a regex read is safe — and python-free.
    $rel = ''
    if ($vraw -match ('"' + [regex]::Escape($tool) + '"\s*:\s*"([^"]*)"')) { $rel = $matches[1] }
    if (-not $rel) {
      Coop-Warn "could not read $tool from coop-website/versions.json — skipping its pin check."
      continue
    }
    if (-not $pin) {
      Coop-Warn "could not read python_tools.$tool from config/release-manifest.json (versions.json says $tool is $rel)."
      $mismatch = $true
    } elseif ($pin -ne $rel) {
      Coop-Warn "python_tools.$tool is $pin in config/release-manifest.json but coop-website/versions.json says $rel."
      $mismatch = $true
    }
  }
  if ($mismatch) {
    Coop-Die 'the coop-tool pins in config/release-manifest.json disagree with coop-website/versions.json — update the manifest (see RELEASE.md), or re-run with --no-check.'
  }
  Coop-Ok 'coop-tool pins match coop-website/versions.json'
  return $true
}

# --- Release gate: an attached main that equals origin/main (#105) ------------
# Release precondition (scripts/release.sh has the same gate). `coop update` follows only tags
# merged into origin/main (H5), so a tag cut from a detached HEAD, another branch,
# or a main with unpushed or missing commits never deploys: the fleet ignores it
# silently. Fetches origin, then dies with the fix unless HEAD is the branch main
# and points at origin/main. Runs before any file changes; the atomic push in
# Invoke-CoopRelease covers origin moving afterwards.
function Assert-CoopReleaseOnMain {
  $root = $script:CoopRoot
  $branch = Get-CoopRepoBranch
  if (-not $branch) { Coop-Die 'HEAD is detached — release from main: git switch main; git pull --ff-only' }
  if ($branch -cne 'main') { Coop-Die "on branch '$branch' — release from main: git switch main; git pull --ff-only" }
  $fetchOut = @(& git -C $root fetch --quiet origin 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $line = 'fetch failed'
    foreach ($o in $fetchOut) { $s = ([string]$o).Trim(); if ($s) { $line = $s; break } }
    Coop-Die "could not fetch origin (git: $line) — a release must start from the current origin/main; fix the remote or network and re-run."
  }
  $there = Get-CoopRepoGitLine @('rev-parse', '-q', '--verify', 'refs/remotes/origin/main')
  if (-not $there) { Coop-Die 'no origin/main after fetching origin — a release tags origin/main; check the origin remote.' }
  $here = Get-CoopRepoGitLine @('rev-parse', '-q', '--verify', 'HEAD')
  if ($here -ne $there) {
    $counts = (Get-CoopRepoGitLine @('rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main')) -split '\s+'
    $ahead = if ($counts.Count -ge 2 -and $counts[0]) { $counts[0] } else { '?' }
    $behind = if ($counts.Count -ge 2 -and $counts[1]) { $counts[1] } else { '?' }
    Coop-Die "main differs from origin/main ($ahead ahead, $behind behind) — a release tags exactly origin/main: land or drop local commits, git pull --ff-only, then re-run."
  }
  Coop-Ok 'on main at origin/main'
}

# --- Release: bump version, roll CHANGELOG, commit + tag (+ push) -------------
# coop release (scripts/release.sh is the bash dev-tooling equivalent). Bumps VERSION, release-manifest.json, and
# the extension manifests, commits, tags, and pushes main + the tag in one atomic
# push. Writes files with LF via [IO.File] to avoid Windows CRLF/BOM drift.
# Requires a clean tree on an attached main that equals origin/main.
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
        Coop-Say '  Bump VERSION + release/extension manifests, roll CHANGELOG [Unreleased] into'
        Coop-Say '  a dated release, commit, tag vX.Y.Z, and push main + the tag atomically (both'
        Coop-Say '  or neither). Default: patch.'
        Coop-Say '  Verifies extensions transpile + tests + the .ps1 BOM check pass, and that'
        Coop-Say '  the manifest''s coop-tool pins match the sibling coop-website''s versions.json'
        Coop-Say '  (--no-check to skip).'
        Coop-Say '  Requires a clean working tree on main, equal to origin/main (it fetches origin).'
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
  Assert-CoopReleaseOnMain

  $verFile = Join-Path $root 'VERSION'
  if (-not (Test-Path -LiteralPath $verFile -PathType Leaf)) { Coop-Die "VERSION file missing at $verFile — fix it before releasing." }
  $cur = (Get-Content -LiteralPath $verFile -Raw).Trim()
  if ($cur -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Coop-Die "VERSION ('$cur') is not X.Y.Z — fix it before releasing." }
  $releaseManifest = Join-Path $root 'config\release-manifest.json'
  if (-not (Test-Path -LiteralPath $releaseManifest -PathType Leaf)) { Coop-Die "release manifest missing at $releaseManifest — fix it before releasing." }
  $manifestRaw = Get-Content -LiteralPath $releaseManifest -Raw
  $manifestMatches = [regex]::Matches($manifestRaw, '(?m)^\s*"coop_version"\s*:\s*"([^"]*)"')
  $manifestCur = if ($manifestMatches.Count -eq 1) { $manifestMatches[0].Groups[1].Value } else { '' }
  if ($manifestCur -ne $cur) { Coop-Die "release manifest coop_version ('$manifestCur') does not match VERSION ('$cur') — align it before releasing." }
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
    # Track whether the transpile/test gate actually ran. A host missing npx/node/bash
    # skips those halves; if a push is requested we fail closed below rather than
    # publish an unverified tag. Mirrors coop_release in bin/coop.
    $gateSkipped = $false
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
      Coop-Warn 'npx not found — skipping the extension build check.'; $gateSkipped = $true
    }

    # Gate on the full Node suite + the .ps1 BOM check, not just transpile.
    # Both are bash scripts (dev tooling), so they need bash (Git Bash / WSL) on
    # Windows. If the gate can't run on this host we fail closed before a push
    # (below) rather than silently tagging an unverified release. scripts/release.sh
    # tracks the same gate_skipped condition — bash is guaranteed on macOS/Linux,
    # but node/npx are not, so a node-less host fails closed there too.
    # COOP_TEST_EXTENDED=1 runs BOTH test lanes (gate + extended), so a release
    # keeps the full coverage that CI splits between ci.yml (gate, every PR) and
    # extended.yml (nightly). See docs/ci.md. Set only for the test run and then
    # restored, the same scope as scripts/release.sh's one-command prefix.
    $testsSh = Join-Path (Join-Path $root 'tests') 'run.sh'
    if (Test-Path -LiteralPath $testsSh) {
      if ((Test-Have 'bash') -and (Test-Have 'node')) {
        # Capture combined output and echo it on failure, so a Windows test failure
        # is diagnosable (the bash path cats its log to stderr for the same reason).
        $prevTestExtended = $env:COOP_TEST_EXTENDED
        $env:COOP_TEST_EXTENDED = '1'
        try {
          $testOut = & bash $testsSh 2>&1
          $testCode = $LASTEXITCODE
        } finally {
          $env:COOP_TEST_EXTENDED = $prevTestExtended
        }
        if ($testCode -eq 0) { Coop-Ok 'tests pass (gate + extended lanes)' }
        else { $testOut | Out-String | Write-Host; Coop-Die 'tests failed (COOP_TEST_EXTENDED=1 bash tests/run.sh, gate + extended lanes) — fix them, or re-run with --no-check.' }
      } else {
        Coop-Warn 'bash or node not found — skipping the test suite.'; $gateSkipped = $true
      }
    }
    # The PowerShell suite is the product's own lane; it runs under this same host.
    $testsPs1 = Join-Path (Join-Path $root 'tests') 'run.ps1'
    if (Test-Path -LiteralPath $testsPs1) {
      $psOut = & $testsPs1 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok 'PowerShell tests pass (tests/run.ps1)' }
      else { $psOut | Out-String | Write-Host; Coop-Die 'PowerShell tests failed (tests/run.ps1) — fix them, or re-run with --no-check.' }
    }
    # The .ps1 encoding gate is PowerShell too (scripts/check-bom.ps1): it runs
    # under this same host, so no host can skip it.
    $bomPs1 = Join-Path (Join-Path $root 'scripts') 'check-bom.ps1'
    if (Test-Path -LiteralPath $bomPs1) {
      $bomOut = & $bomPs1 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok 'BOM check passes (scripts/check-bom.ps1)' }
      else { $bomOut | Out-String | Write-Host; Coop-Die 'BOM check failed (pwsh -NoProfile -File scripts/check-bom.ps1) — fix it, or re-run with --no-check.' }
    }
    # Fail closed: a host that could not run the gate must not PUBLISH an unverified
    # tag. Bumping/committing locally (--no-push) is fine; a push requires the gate
    # to have run — or an explicit --no-check opt-out (which skips this whole block).
    if ($gateSkipped -and $doPush) {
      Coop-Die 'release gate could not run (npx/bash/node not found) — cut the release from macOS/Linux or a Windows host with Git Bash/WSL, use --no-push to bump locally only, or --no-check to release without gating.'
    }

    # The manifest's coop-tool pins vs the sibling coop-website's versions.json: a mismatch
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

  # 2. release manifest + extension manifests
  $manifestRaw = [regex]::Replace(
    $manifestRaw,
    '(?m)^(\s*"coop_version"\s*:\s*")[^"]*(".*)$',
    ('${1}' + $new + '${2}')
  )
  [System.IO.File]::WriteAllText($releaseManifest, ($manifestRaw -replace "`r`n", "`n"))
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
  & git -C $root add VERSION CHANGELOG.md config/release-manifest.json
  Get-ChildItem -LiteralPath (Join-Path $root 'extensions') -Directory | ForEach-Object {
    $pkg = Join-Path $_.FullName 'package.json'
    if (Test-Path -LiteralPath $pkg) { & git -C $root add $pkg }
  }
  & git -C $root commit -q -m "Release v$new"
  if ($LASTEXITCODE -ne 0) { Coop-Die 'git commit failed.' }
  & git -C $root tag -a "v$new" -m "coop-agent v$new"
  if ($LASTEXITCODE -ne 0) { Coop-Die 'git tag failed.' }
  Coop-Ok "released v$new (was v$cur)"

  # 5. push main and the tag in ONE atomic push (#105): if origin rejects either
  # ref (main moved during the gate, a protected branch, an existing tag), neither
  # lands, so the tag can never reach origin off main. Fully qualified refs, so a
  # stray tag named 'main' cannot be pushed in place of the branch.
  if ($doPush) {
    $pushOut = @(& git -C $root push --atomic --quiet origin refs/heads/main "refs/tags/v$new" 2>&1)
    if ($LASTEXITCODE -eq 0) { Coop-Ok "pushed main + tag v$new" }
    else {
      foreach ($o in $pushOut) { $pushLine = ([string]$o).TrimEnd(); if ($pushLine) { Coop-Emit $pushLine } }
      Coop-Die "push failed — nothing was pushed (atomic), so v$new exists only on this machine. Retry: git push --atomic origin main v$new — or, if origin/main moved, undo the local release (git tag -d v$new; git reset --keep HEAD~1), git pull --ff-only, and re-run coop release."
    }
  } else {
    Coop-Info "not pushed (--no-push). When ready: git push --atomic origin main v$new"
  }
}

# --- Dispatch ----------------------------------------------------------------
$argList = @()
if ($null -ne $args) { $argList = @($args) }
$cmd = if ($argList.Count -ge 1) { $argList[0] } else { '' }
# Everything after the subcommand. Guard the count<=1 case: PowerShell ranges like
# 1..0 count DOWNWARDS (1,0) and would wrongly re-include element 0.
$rest = @()
if ($argList.Count -gt 1) { $rest = @($argList[1..($argList.Count - 1)]) }

# Surface freshly-installed tools (npm-global `pi`, pipx `fab`/coop-*) on PATH for
# this process so a shell whose persistent PATH predates the install still finds them.
Add-CoopRuntimePaths

switch -CaseSensitive ($cmd) {
  '' { Invoke-LaunchPi; break }
  # --no-launch is a dry-run: run the preflights, then PRINT the resolved pi
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
  'web' { Invoke-CoopWebRetired; break }
  'launch-spec' { Invoke-CoopLaunchSpec $rest; break }
  'onboard' { Invoke-CoopOnboard $rest; break }
  'profile' { Invoke-CoopProfile $rest; break }
  'teamai' { Invoke-CoopTeamai $rest; break }
  'context-budget' { Invoke-CoopContextBudget $rest; break }
  'init' { Invoke-CoopInit $rest; break }
  'new-skill' { New-CoopSkill $rest; break }
  'new-prompt' { New-CoopPrompt $rest; break }
  'release' { Invoke-CoopRelease $rest; break }
  'data-doc' { Invoke-DataDoc $rest; break }
  'support' { & (Join-Path $script:CoopRoot 'scripts\support-center.ps1') @rest; exit $LASTEXITCODE }
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
    Invoke-CoopPiProcess -PiArgs $rest
    exit $script:CoopPiRc
  }
  { $_ -ceq 'version' -or $_ -ceq '--version' -or $_ -ceq '-V' } {
    # A git checkout also prints its `git describe` (v0.23.5-21-gdf91630), since
    # VERSION reads the same at a tag and at every commit past it; a non-git copy
    # prints VERSION only.
    $describe = Get-CoopRepoDescribe
    Write-Host ("coop {0}{1}" -f $script:CoopVersion, $(if ($describe) { " ($describe)" } else { '' }))
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

function Invoke-CoopInitCi {
  param([string]$Dir, [string]$CiType)
  if ($CiType -notin @('github','ado')) { Coop-Die "unknown CI type '$CiType' — usage: coop init --ci github|ado" }
  $projYml = Join-Path $Dir '.coop\project.yml'
  # The generated pipelines pin the coop tools at the release manifest's versions.
  $manifest = $script:CoopReleaseManifest

  if (-not (Test-Path -LiteralPath $projYml -PathType Leaf)) { Coop-Die "$projYml not found. Run ``coop init`` first." }

  $pyCmd = Get-CoopPython
  if ($pyCmd) {
    $script = Join-Path $script:CoopRoot 'lib\_ciscaffold.py'
    $outFile = (& $pyCmd $script $CiType $projYml $manifest $Dir)
    $rc = $LASTEXITCODE
    if ($rc -eq 0) {
      Coop-Ok "Wrote $outFile"
    } elseif ($rc -eq 3) {
      Coop-Warn "No CI gates generated: no coop-data-doc.yml in $Dir" 'set up lineage docs first: coop data-doc setup   (or /setup-docs in the agent)'
    } else {
      Coop-Die "CI scaffolding failed"
    }
  } else {
    Coop-Die "Python 3 required to scaffold CI"
  }
}
