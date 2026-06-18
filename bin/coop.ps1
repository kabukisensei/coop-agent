#!/usr/bin/env pwsh
#
# coop.ps1 — the Cooptimize terminal agent (Windows / PowerShell mirror of bin/coop).
#
# A thin, branded layer ON TOP OF Pi (@mariozechner/pi-coding-agent). coop never
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
#   coop sync                 Ensure Pi extensions + place read-only MCP config + verify assets
#   coop data-doc [args]      Run coop-data-doc (default: build) and summarize outputs
#   coop sql-review [paths]   Run coop-sql-review and summarize findings (--json for raw)
#   coop dax-review [paths]   Run coop-dax-review and summarize findings (--json for raw)
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

# --- Resolve COOP_ROOT (the directory that contains bin/, lib/, scripts/) ------
$script:CoopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:COOP_ROOT = $script:CoopRoot

# --- Shared helpers (mirror of lib/common.sh) --------------------------------
# Reproduced inline so coop.ps1 has no external PowerShell dependency.

$script:CoopVersion = '0.0.0'
$verFile = Join-Path $script:CoopRoot 'VERSION'
if (Test-Path -LiteralPath $verFile -PathType Leaf) {
  $vRaw = (Get-Content -LiteralPath $verFile -Raw -ErrorAction SilentlyContinue)
  if ($vRaw) { $script:CoopVersion = $vRaw.Trim() }
}
$env:COOP_VERSION = $script:CoopVersion

# Colors (respect NO_COLOR and non-TTY). Truecolor brand palette.
$script:CoopColor = ($null -eq $env:NO_COLOR -or $env:NO_COLOR -eq '') -and -not [Console]::IsErrorRedirected
$e = [char]27
if ($script:CoopColor) {
  $script:C_NAVY   = "$e[38;2;0;65;107m"
  $script:C_FOREST = "$e[38;2;66;120;60m"
  $script:C_OLIVE  = "$e[38;2;130;170;67m"
  $script:C_LIME   = "$e[38;2;178;210;53m"
  $script:C_RED    = "$e[38;2;239;65;45m"
  $script:C_BOLD   = "$e[1m"
  $script:C_DIM    = "$e[2m"
  $script:C_RST    = "$e[0m"
} else {
  $script:C_NAVY = ''; $script:C_FOREST = ''; $script:C_OLIVE = ''; $script:C_LIME = ''; $script:C_RED = ''
  $script:C_BOLD = ''; $script:C_DIM = ''; $script:C_RST = ''
}
function Coop-Navy { $script:C_NAVY }
function Coop-Bold { $script:C_BOLD }
function Coop-Dim  { $script:C_DIM }
function Coop-Rst  { $script:C_RST }

# Status glyphs (defined with [char] codepoints for Windows PowerShell 5.1 compat).
$script:G_BULLET = [char]0x2022   # •
$script:G_CHECK  = [char]0x2713   # ✓
$script:G_CROSS  = [char]0x2717   # ✗

# Logging (to stderr, mirroring coop_say/info/ok/warn/err/head).
function Coop-Say  { param([string]$m) [Console]::Error.WriteLine($m) }
function Coop-Info { param([string]$m) [Console]::Error.WriteLine("$($script:C_LIME)$($script:G_BULLET)$($script:C_RST) $m") }
function Coop-Ok   { param([string]$m) [Console]::Error.WriteLine("$($script:C_FOREST)$($script:G_CHECK)$($script:C_RST) $m") }
function Coop-Warn { param([string]$m) [Console]::Error.WriteLine("$($script:C_OLIVE)!$($script:C_RST) $m") }
function Coop-Err  { param([string]$m) [Console]::Error.WriteLine("$($script:C_RED)$($script:G_CROSS)$($script:C_RST) $m") }
function Coop-Die  { param([string]$m) Coop-Err $m; exit 1 }
function Coop-Head { param([string]$m) [Console]::Error.WriteLine("`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)") }

# Is a command available on PATH? (mirror of have())
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Pick a usable python interpreter (for YAML/JSON parsing). Prefer python3.
function Get-CoopPython {
  if (Test-Have 'python3') { return 'python3' }
  elseif (Test-Have 'python') { return 'python' }
  else { return $null }
}

# Read a dotted scalar key from a YAML file via lib/_yaml.py (PyYAML when present,
# else a dependency-free fallback parser). (mirror of coop_yaml_get)
function Get-CoopYamlValue {
  param([string]$File, [string]$Key, [string]$Default = '')
  if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { return $Default }
  $py = Get-CoopPython
  if (-not $py) { return $Default }
  $yamlPy = Join-Path $script:CoopRoot 'lib/_yaml.py'
  try {
    $out = (& $py $yamlPy get $File $Key $Default 2>$null)
    if ($null -eq $out) { return $Default }
    $out = ($out | Out-String).TrimEnd("`r", "`n")
    if ($out -eq '') { return $Default }
    return $out
  } catch { return $Default }
}

# Read a dotted key that is a YAML list of scalars, returning a string array.
# (mirror of coop_yaml_list)
function Get-CoopYamlList {
  param([string]$File, [string]$Key)
  if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { return @() }
  $py = Get-CoopPython
  if (-not $py) { return @() }
  $yamlPy = Join-Path $script:CoopRoot 'lib/_yaml.py'
  try {
    $out = (& $py $yamlPy list $File $Key 2>$null)
    if ($null -eq $out) { return @() }
    return @($out -split "`r?`n" | Where-Object { $_ -ne '' })
  } catch { return @() }
}

# Extract the YAML frontmatter `name:` from a SKILL.md (first match), or '' if none.
# (mirror of coop_skill_name)
function Get-CoopSkillName {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
  $lines = Get-Content -LiteralPath $File -ErrorAction SilentlyContinue
  if (-not $lines -or $lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return '' }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '---') { break }
    if ($lines[$i] -match '^\s*name:\s*(.+?)\s*$') {
      return ($matches[1].Trim() -replace '^["'']|["'']$', '')
    }
  }
  return ''
}

# Locate the active project contract: nearest .coop/project.yml walking up from
# $PWD, else the bundled one at COOP_ROOT/.coop/project.yml. (mirror of coop_find_project_yml)
function Find-CoopProjectYml {
  param([string]$StartDir = (Get-Location).Path)
  $dir = $StartDir
  while ($dir) {
    $candidate = Join-Path $dir '.coop\project.yml'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) { break }
    $dir = $parent
  }
  $bundled = Join-Path $script:CoopRoot '.coop\project.yml'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
  return ''
}

# Summarize a coop-sql-review / coop-dax-review JSON report (a single JSON string).
# Prints a one-line severity breakdown to stderr. (mirror of coop_summarize_review_json)
function Invoke-CoopSummarizeReviewJson {
  param([string]$Json)
  $py = Get-CoopPython
  if (-not $py) { [Console]::Error.WriteLine($Json); return }
  $pyScript = @'
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print("  (could not parse JSON report)"); sys.exit(0)
findings = data.get("findings") or data.get("results") or []
sev = {"error": 0, "warning": 0, "info": 0}
for f in findings:
    s = str(f.get("severity", "")).lower()
    if s in sev: sev[s] += 1
total = len(findings)
files = data.get("files_checked") or data.get("file_count")
parts = ["\033[38;2;239;65;45m{} error\033[0m".format(sev['error']),
         "\033[38;2;130;170;67m{} warning\033[0m".format(sev['warning']),
         "\033[38;2;0;101;164m{} info\033[0m".format(sev['info'])]
head = "  {} finding(s): ".format(total) + "  ".join(parts)
if files is not None:
    head += "   ({} file(s) checked)".format(files)
print(head)
'@
  # Pass the program via -c so stdin stays free for the JSON report (mirrors lib/common.sh).
  ($Json | & $py -c $pyScript 2>$null) | ForEach-Object { [Console]::Error.WriteLine($_) }
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

# Confirm a potentially-destructive action unless --yes / COOP_ASSUME_YES is set.
# (mirror of coop_confirm)
function Coop-Confirm {
  param([string]$Prompt = 'Proceed?')
  if ($env:COOP_ASSUME_YES -eq '1') { return $true }
  if ([Console]::IsInputRedirected) { Coop-Warn 'Non-interactive shell; refusing without --yes.'; return $false }
  [Console]::Error.Write("$($script:C_OLIVE)$Prompt$($script:C_RST) [y/N] ")
  $ans = [Console]::In.ReadLine()
  if ($ans -match '^(y|yes)$') { return $true } else { return $false }
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
  coop sync                 Ensure Pi extensions + place read-only MCP config + verify assets
  coop data-doc [args]      Run coop-data-doc (default: build) and summarize outputs
  coop sql-review [paths]   Run coop-sql-review; summarize findings (--json = raw)
  coop dax-review [paths]   Run coop-dax-review; summarize findings (--json = raw)
  coop fabric [args]        Pass through to the Microsoft Fabric CLI (fab)
  coop version              Print coop + pi versions
  coop help                 Show this help

$(Coop-Bold)Authoring$(Coop-Rst)
  coop init [dir]           Scaffold .coop/project.yml into a work repo (default: .)
  coop new-skill <name>     Scaffold skills/<name>/SKILL.md
  coop new-prompt <name>    Scaffold prompts/<name>.md

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

# --- Optional Azure preflight (non-fatal) ------------------------------------
# Mirrors the team's pi-ready habit: if the project pins a Fabric tenant and the
# Azure CLI is present, make sure a Power BI token exists before launching.
# Skipped entirely when COOP_SKIP_AZ=1 or no tenant is configured.
function Invoke-CoopAzPreflight {
  if ($env:COOP_SKIP_AZ -eq '1') { return }
  if (-not (Test-Have 'az')) { return }
  $proj = Find-CoopProjectYml
  if (-not $proj) { return }
  $tenant = Get-CoopYamlValue $proj 'fabric.tenant_id' ''
  if (-not $tenant -or $tenant -like 'TODO*' -or $tenant -like 'TODO:*') { return }
  & az account get-access-token --resource https://analysis.windows.net/powerbi/api > $null 2>&1
  if ($LASTEXITCODE -eq 0) { return }
  Coop-Warn 'Azure / Power BI token missing or expired.'
  if (Coop-Confirm "Run 'az login' for tenant $tenant now?") {
    & az login --tenant $tenant --allow-no-subscriptions
    if ($LASTEXITCODE -ne 0) { Coop-Warn 'az login failed; continuing anyway.' }
  }
}

# --- Launch the branded Pi agent ---------------------------------------------
function Invoke-LaunchPi {
  param([string[]] $PassArgs = @())

  if (-not (Test-Have 'pi')) {
    Coop-Die 'pi is not installed. Run: coop install   (or: npm install -g @mariozechner/pi-coding-agent)'
  }

  Invoke-CoopAzPreflight

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
  # Point the extension at our vibe files and brand splash.
  $env:COOP_VIBES_DIR = Join-Path $script:CoopRoot 'vibes'
  $env:COOP_SPLASH_FILE = Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi'

  $allArgs = @($piArgs + $PassArgs)
  & pi @allArgs
  exit $LASTEXITCODE
}

# --- Tool wrappers -----------------------------------------------------------
function Get-DefaultReviewPath {
  # Return a sensible default review path from project.yml, else ".".
  $proj = Find-CoopProjectYml
  $p = ''
  if ($proj) { $p = Get-CoopYamlValue $proj 'repositories.fabric_dw.sql_root' '' }
  if (-not $p -or $p -like 'TODO*') { return '.' }
  return $p
}

function Invoke-Review {
  # Invoke-Review <tool-binary> <label> [args...]
  param(
    [string] $Bin,
    [string] $Label,
    [string[]] $RestArgs = @()
  )
  if (-not (Test-Have $Bin)) { Coop-Die "$Bin is not installed. Run: coop install" }

  $raw = $false
  $strict = @()
  $paths = @()
  foreach ($a in $RestArgs) {
    switch -CaseSensitive ($a) {
      '--json'   { $raw = $true }
      '--strict' { $strict += '--strict' }
      default    { $paths += $a }
    }
  }
  if ($paths.Count -eq 0) { $paths = @(Get-DefaultReviewPath) }

  if ($raw) {
    & $Bin check @paths --format json @strict
    exit $LASTEXITCODE
  }

  Coop-Head "$Label — $($paths -join ' ')"
  $out = (& $Bin check @paths --format json @strict 2>$null | Out-String)
  $rc = $LASTEXITCODE
  Invoke-CoopSummarizeReviewJson $out
  Coop-Info "For the full advisory report: $Bin check $($paths -join ' ') --format text"
  exit $rc   # propagate --strict CI exit codes (mirrors bin/coop run_review)
}

function Invoke-DataDoc {
  param([string[]] $RestArgs = @())
  if (-not (Test-Have 'coop-data-doc')) { Coop-Die 'coop-data-doc is not installed. Run: coop install' }
  if ($RestArgs.Count -eq 0) { $RestArgs = @('build') }
  Coop-Head "coop-data-doc $($RestArgs -join ' ')"
  & coop-data-doc @RestArgs
  # Summarize machine-readable artifacts when present (manifest.json / graph.json).
  foreach ($f in @('manifest.json', 'graph.json', 'docs/manifest.json', 'docs/graph.json', 'site/manifest.json')) {
    if (Test-Path -LiteralPath $f -PathType Leaf) {
      Coop-Ok "Machine-readable output: $f"
      Invoke-CoopSummarizeDataDocJson $f
      break
    }
  }
}

# --- Authoring scaffolders (mirror of bin/coop) ------------------------------
function Test-CoopValidName { param([string]$Name) return ($Name -and $Name -notmatch '[^a-zA-Z0-9._-]') }

function Invoke-CoopInit {
  param([string[]]$RestArgs = @())
  $dir = if ($RestArgs.Count -ge 1) { $RestArgs[0] } else { (Get-Location).Path }
  $tmpl = Join-Path $script:CoopRoot '.coop\project.example.yml'
  if (-not (Test-Path -LiteralPath $tmpl -PathType Leaf)) { Coop-Die 'template missing: .coop/project.example.yml' }
  $dst = Join-Path $dir '.coop\project.yml'
  if (Test-Path -LiteralPath $dst) { Coop-Die "$dst already exists — not overwriting." }
  New-Item -ItemType Directory -Force -Path (Join-Path $dir '.coop') | Out-Null
  Copy-Item -LiteralPath $tmpl -Destination $dst
  Coop-Ok "Wrote $dst"
  Coop-Info 'Fill in the TODOs (repo paths, Fabric/Power BI workspaces, tenant), then: coop doctor'
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
  Set-Content -LiteralPath (Join-Path $dir 'SKILL.md') -Value $body -Encoding UTF8
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
  Set-Content -LiteralPath $f -Value $body -Encoding UTF8
  Coop-Ok "Created prompts/$name.md"
  Coop-Info 'Edit it, then it loads automatically next time you run: coop'
}

# --- Dispatch ----------------------------------------------------------------
$argList = @()
if ($null -ne $args) { $argList = @($args) }
$cmd = if ($argList.Count -ge 1) { $argList[0] } else { '' }
# Everything after the subcommand. Guard the count<=1 case: PowerShell ranges like
# 1..0 count DOWNWARDS (1,0) and would wrongly re-include element 0.
$rest = if ($argList.Count -gt 1) { @($argList[1..($argList.Count - 1)]) } else { @() }

switch -CaseSensitive ($cmd) {
  { $_ -eq '' -or $_ -eq '--no-launch' } { Invoke-LaunchPi; break }
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
  'init' { Invoke-CoopInit $rest; break }
  'new-skill' { New-CoopSkill $rest; break }
  'new-prompt' { New-CoopPrompt $rest; break }
  'data-doc' { Invoke-DataDoc $rest; break }
  'sql-review' { Invoke-Review 'coop-sql-review' 'SQL review' $rest; break }
  'dax-review' { Invoke-Review 'coop-dax-review' 'DAX review' $rest; break }
  { $_ -eq 'fabric' -or $_ -eq 'fab' } {
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
  { $_ -eq 'remove' -or $_ -eq 'uninstall' } {
    if (-not (Test-Have 'pi')) { Coop-Die 'pi not installed.' }
    & pi $cmd @rest
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
  { $_ -eq 'version' -or $_ -eq '--version' -or $_ -eq '-V' } {
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
  { $_ -eq 'help' -or $_ -eq '--help' -or $_ -eq '-h' } { Show-Usage; break }
  default {
    # Unknown flags (-*) or unknown subcommand: pass straight to pi (files/messages).
    Invoke-LaunchPi -PassArgs $argList
    break
  }
}
