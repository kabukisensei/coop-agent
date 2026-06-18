#!/usr/bin/env pwsh
#
# coop doctor (Windows / PowerShell mirror of scripts/doctor.sh) —
# verify the Cooptimize agent's dependencies and configuration.
# Exit 0 when all REQUIRED dependencies are present (warnings are non-fatal);
# exit 1 when something required is missing.
#
$ErrorActionPreference = 'Continue'

# --- Resolve COOP_ROOT and shared helpers (mirror of lib/common.sh) ----------
$script:CoopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:COOP_ROOT = $script:CoopRoot

$script:CoopVersion = '0.0.0'
$verFile = Join-Path $script:CoopRoot 'VERSION'
if (Test-Path -LiteralPath $verFile -PathType Leaf) {
  $vRaw = (Get-Content -LiteralPath $verFile -Raw -ErrorAction SilentlyContinue)
  if ($vRaw) { $script:CoopVersion = $vRaw.Trim() }
}

$script:CoopColor = ($null -eq $env:NO_COLOR -or $env:NO_COLOR -eq '') -and -not [Console]::IsErrorRedirected
$e = [char]27
if ($script:CoopColor) {
  $script:C_NAVY = "$e[38;2;0;65;107m"; $script:C_FOREST = "$e[38;2;66;120;60m"
  $script:C_OLIVE = "$e[38;2;130;170;67m"; $script:C_LIME = "$e[38;2;178;210;53m"
  $script:C_RED = "$e[38;2;239;65;45m"; $script:C_BOLD = "$e[1m"; $script:C_DIM = "$e[2m"; $script:C_RST = "$e[0m"
} else {
  $script:C_NAVY = ''; $script:C_FOREST = ''; $script:C_OLIVE = ''; $script:C_LIME = ''
  $script:C_RED = ''; $script:C_BOLD = ''; $script:C_DIM = ''; $script:C_RST = ''
}
$script:G_BULLET = [char]0x2022   # bullet
$script:G_CHECK  = [char]0x2713   # check
$script:G_CROSS  = [char]0x2717   # cross
function Coop-Say  { param([string]$m) [Console]::Error.WriteLine($m) }
function Coop-Info { param([string]$m) [Console]::Error.WriteLine("$($script:C_LIME)$($script:G_BULLET)$($script:C_RST) $m") }
function Coop-Ok   { param([string]$m) [Console]::Error.WriteLine("$($script:C_FOREST)$($script:G_CHECK)$($script:C_RST) $m") }
function Coop-Warn { param([string]$m) [Console]::Error.WriteLine("$($script:C_OLIVE)!$($script:C_RST) $m") }
function Coop-Err  { param([string]$m) [Console]::Error.WriteLine("$($script:C_RED)$($script:G_CROSS)$($script:C_RST) $m") }
function Coop-Head { param([string]$m) [Console]::Error.WriteLine("`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)") }
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Get-CoopPython { if (Test-Have 'python3') { 'python3' } elseif (Test-Have 'python') { 'python' } else { $null } }

# Read a dotted scalar key from YAML via lib/_yaml.py (PyYAML when present, else the
# dependency-free fallback parser) — matches bash + coop.ps1 on machines without PyYAML.
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

# --- doctor body -------------------------------------------------------------
# Check coop's ISOLATED Pi agent dir, not the user's personal ~/.pi/agent.
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir

$script:FAIL = 0   # required missing -> non-zero exit
$script:WARN = 0

function D-Ok   { param([string]$m) Coop-Ok $m }
function D-Warn { param([string]$m, [string]$hint = '') Coop-Warn ($m + $(if ($hint) { " — $hint" } else { '' })); $script:WARN++ }
function D-Bad  { param([string]$m, [string]$hint = '') Coop-Err ($m + $(if ($hint) { " — $hint" } else { '' })); $script:FAIL++ }

# Check <cmd> <required|optional> <fix-hint> [version-cmd]
function Check {
  param([string]$Bin, [string]$Need, [string]$Hint, [string[]]$VCmd = @())
  if (Test-Have $Bin) {
    $ver = ''
    if ($VCmd.Count -gt 0) {
      $vArgs = if ($VCmd.Count -gt 1) { @($VCmd[1..($VCmd.Count-1)]) } else { @() }
      $vout = (& $VCmd[0] @vArgs 2>$null | Select-Object -First 1)
      if ($vout) { $ver = $vout }
    }
    D-Ok ("$Bin" + $(if ($ver) { "  ($ver)" } else { '' }))
  } else {
    if ($Need -eq 'required') { D-Bad "$Bin missing" $Hint } else { D-Warn "$Bin missing" $Hint }
  }
}

Coop-Head "coop doctor — Cooptimize agent v$($script:CoopVersion)"

Coop-Head 'Core'
Check 'pi'      'required' 'npm install -g @mariozechner/pi-coding-agent   (or: coop bootstrap)' @('pi','--version')
Check 'git'     'required' 'install Git from https://git-scm.com' @('git','--version')
Check 'node'    'optional' 'needed to install/update pi: https://nodejs.org' @('node','--version')
Check 'npm'     'optional' 'ships with Node.js' @('npm','--version')
Check 'python3' 'required' 'install Python 3.10+ from https://python.org' @('python3','--version')
Check 'pipx'    'required' 'python3 -m pip install --user pipx && python3 -m pipx ensurepath' @('pipx','--version')

# Minimum Pi version — the extension API used by coop-powerline / coop-tools.
if (Test-Have 'pi') {
  $piRaw = (& pi --version 2>$null | Select-Object -First 1)
  if ($piRaw -match '(\d+)\.(\d+)\.(\d+)') {
    $piv = [version]("{0}.{1}.{2}" -f $matches[1], $matches[2], $matches[3])
    if ($piv -lt [version]'0.79.0') { D-Warn "pi $piv is older than the tested minimum (0.79.0)" 'coop update' }
  }
}

Coop-Head 'Microsoft Fabric CLI'
if (Test-Have 'fab') {
  $fabver = ((& fab --version 2>&1 | Select-Object -First 3) -join ' ')
  if ($fabver -match '(?i)paramiko|invoke') {
    D-Bad 'fab is the WRONG tool' "this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI"
    Coop-Say '      Fix: pipx install ms-fabric-cli   and ensure ~/.local/bin precedes Homebrew on PATH'
    Coop-Say '           (or: brew uninstall fabric). Verify with: fab --version'
  } else {
    $fv = (& fab --version 2>$null | Select-Object -First 1)
    D-Ok "fab — Microsoft Fabric CLI  ($fv)"
  }
} else {
  D-Bad 'fab missing' 'pipx install ms-fabric-cli'
}

Coop-Head 'Standalone Coop tools (pipx)'
Check 'coop-data-doc'   'required' 'pipx install coop-data-doc'   @('coop-data-doc','--version')
Check 'coop-sql-review' 'required' 'pipx install coop-sql-review' @('coop-sql-review','--version')
Check 'coop-dax-review' 'required' 'pipx install coop-dax-review' @('coop-dax-review','--version')

Coop-Head 'Fabric / semantic-model tooling'
# fabric-cicd is a Python LIBRARY (no CLI) — check it's importable in the Fabric CLI's env.
if (Test-Have 'fab') {
  $fabCmd = (Get-Command fab -ErrorAction SilentlyContinue)
  $fabReal = if ($fabCmd) { $fabCmd.Source } else { '' }
  $fabPy = if ($fabReal) { Join-Path (Split-Path -Parent $fabReal) 'python.exe' } else { '' }
  if (-not (Test-Path -LiteralPath $fabPy)) { $fabPy = if ($fabReal) { Join-Path (Split-Path -Parent $fabReal) 'python' } else { '' } }
  if ($fabPy -and (Test-Path -LiteralPath $fabPy)) {
    & $fabPy -c 'import fabric_cicd' > $null 2>&1
    if ($LASTEXITCODE -eq 0) { D-Ok 'fabric-cicd (library, in the Fabric CLI env)' }
    else { D-Warn 'fabric-cicd not installed' 'pipx inject ms-fabric-cli fabric-cicd' }
  } else {
    D-Warn 'fabric-cicd not installed' 'pipx inject ms-fabric-cli fabric-cicd'
  }
} else {
  D-Warn 'fabric-cicd: install the Microsoft Fabric CLI first' 'coop install'
}
# Tabular Editor CLI is path-configured and mostly Windows; check the project's path if set.
$tePath = Get-CoopYamlValue (Find-CoopProjectYml) 'tools.tabular_editor_cli.executable_path' ''
if (-not $tePath -or $tePath -like 'TODO*') {
  if (Test-Have 'TabularEditor.exe') { D-Ok 'Tabular Editor CLI on PATH' }
  else { D-Warn 'Tabular Editor CLI not configured' 'set tools.tabular_editor_cli.executable_path in .coop/project.yml (optional)' }
} else {
  if (Test-Path -LiteralPath $tePath) { D-Ok "Tabular Editor CLI: $tePath" }
  else { D-Warn "Tabular Editor CLI path not found: $tePath" }
}

Coop-Head 'Pi extensions'
if (Test-Have 'pi') {
  $pilist = (& pi list 2>$null | Out-String)
  foreach ($ext in @('pi-mcp-adapter:MCP servers', 'pi-hermes-memory:persistent memory')) {
    $name = $ext.Split(':')[0]; $desc = $ext.Split(':')[1]
    if ($pilist -match [regex]::Escape($name)) { D-Ok "$name ($desc)" }
    else { D-Warn "$name not installed ($desc)" "coop add npm:$name" }
  }
} else {
  D-Warn 'cannot check extensions' 'pi not installed'
}

Coop-Head 'MCP servers (read-only, optional)'
$mcpFound = ''
$cwd = (Get-Location).Path
foreach ($f in @(
    (Join-Path $env:PI_CODING_AGENT_DIR 'mcp.json'),
    (Join-Path $cwd '.mcp.json'),
    (Join-Path $cwd '.pi\mcp.json'),
    (Join-Path $HOME '.config\mcp\mcp.json'),
    (Join-Path $HOME '.pi\mcp-config\mcp.json'))) {
  if (Test-Path -LiteralPath $f -PathType Leaf) { $mcpFound = $f; break }
}
if ($mcpFound) {
  D-Ok "MCP config: $mcpFound"
  $mcpText = (Get-Content -LiteralPath $mcpFound -Raw -ErrorAction SilentlyContinue)
  foreach ($s in @('fabric', 'powerbi', 'microsoft-learn', 'learn', 'context-mode')) {
    if ($mcpText -match ('(?i)"' + [regex]::Escape($s) + '"')) { D-Ok "  • $s server configured" }
  }
  if ($mcpText -notmatch '(?i)learn\.microsoft\.com|microsoft-learn') {
    D-Warn '  Microsoft Learn MCP not configured' 'coop sync   (adds it read-only)'
  }
} else {
  D-Warn 'no MCP config found' 'coop sync   (writes a read-only fabric/powerbi/learn config)'
}

Coop-Head 'Optional'
Check 'az' 'optional' 'Azure CLI for Fabric/Power BI auth: https://learn.microsoft.com/cli/azure'
Check 'jq' 'optional' 'nice-to-have for JSON in your own scripts (coop uses python3)'

Coop-Head 'Project contract'
$proj = Find-CoopProjectYml
if ($proj) {
  D-Ok ".coop/project.yml found: $proj"
  $todo = 0
  $projText = (Get-Content -LiteralPath $proj -ErrorAction SilentlyContinue)
  if ($projText) { $todo = ($projText | Select-String -Pattern 'TODO' -SimpleMatch).Count }
  if ($todo -gt 0) { D-Warn "$todo TODO placeholder(s) remain in project.yml" 'edit it before live Fabric/Power BI work' }
} else {
  D-Warn 'no .coop/project.yml found' "copy $($script:CoopRoot)/.coop/project.example.yml to your repo's .coop/project.yml"
}

Coop-Head 'Powerline / splash assets'
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi') -PathType Leaf) { D-Ok 'brand splash present' } else { D-Warn 'splash.ansi missing' 'run: coop sync' }
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'themes\cooptimize.json') -PathType Leaf) { D-Ok 'Cooptimize theme present' } else { D-Warn 'theme missing' }

[Console]::Error.WriteLine('')
if ($script:FAIL -gt 0) {
  Coop-Err "doctor: $($script:FAIL) required item(s) missing, $($script:WARN) warning(s). Run: coop install"
  exit 1
} else {
  Coop-Ok ("doctor: all required dependencies present" + $(if ($script:WARN) { ", $($script:WARN) warning(s)" } else { '' }) + '.')
  exit 0
}
