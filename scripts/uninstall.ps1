#!/usr/bin/env pwsh
#
# coop uninstall (Windows / PowerShell mirror of scripts/uninstall.sh) — clean
# teardown of coop's footprint on this machine (VM churn, offboarding). Inverse
# of scripts/install.ps1.
#
# Removes (default): the PATH launcher %LOCALAPPDATA%\coop\bin\coop.cmd + that
# dir's entry on the persistent USER PATH (registry, ExpandString-safe, with the
# WM_SETTINGCHANGE broadcast), the Start Menu + Desktop shortcuts, coop's
# isolated Pi agent dir (~/.coop/agent), and the tool layer: the npm-global Pi
# agent plus the pipx venvs (coop-data-doc / coop-sql-review / coop-dax-review /
# ms-fabric-cli).
#
# NEVER touches: this repo clone, any work repo's .coop\project.yml, the rest of
# ~/.coop (private config dirs live there), or your personal ~/.pi/agent (and
# its login — coop only ever linked/copied it in).
#
#   Flags:
#     --keep-tools   Keep pi + the pipx tools installed (fast re-install later;
#                    right for shared machines) — remove only coop's own footprint
#     --yes, -y      Assume yes for the confirmation
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
. (Join-Path $PSScriptRoot '../lib/common.ps1')

$KEEP_TOOLS = $false
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--keep-tools' { $KEEP_TOOLS = $true }
    '--yes'        { $env:COOP_ASSUME_YES = '1' }
    '-y'           { $env:COOP_ASSUME_YES = '1' }
    { $_ -ceq '-h' -or $_ -ceq '--help' } {
      Coop-Say 'Usage: coop uninstall [--keep-tools] [--yes]'
      Coop-Say "  --keep-tools  keep pi + the pipx tools (remove only coop's own footprint)"
      Coop-Say '  --yes, -y     assume yes for the confirmation'
      exit 0
    }
    default { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "uninstall: ignoring unknown flag '$a'" } }
  }
}

$PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent'
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review', 'ms-fabric-cli')

Coop-Head "coop uninstall (v$($script:CoopVersion))"
$scope = "the coop launcher + user-PATH entry + Start Menu/Desktop shortcuts + coop's isolated agent dir ($(Get-CoopPiAgentDir))"
if (-not $KEEP_TOOLS) { $scope += ' + Pi (npm global) + the pipx tools (coop-*, ms-fabric-cli)' }
Coop-Info "will remove: $scope"
Coop-Info "never touched: this repo clone, work repos' .coop\project.yml, the rest of ~/.coop, your personal ~/.pi/agent"
if (-not (Coop-Confirm 'Remove coop from this machine?')) {
  Coop-Info 'uninstall cancelled — nothing changed.'
  exit 1
}

# --- 1. PATH launcher + persistent user-PATH entry (inverse of install.ps1) ----
$LOCALBIN = Join-Path $env:LOCALAPPDATA 'coop\bin'
$launcher = Join-Path $LOCALBIN 'coop.cmd'
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  # NB: if THIS run was started via that launcher, cmd.exe may print a harmless
  # "The batch file cannot be found." once when the call returns — teardown is done.
  Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $launcher)) { Coop-Ok "removed $launcher" } else { Coop-Warn "could not remove $launcher" }
} else {
  Coop-Info "no launcher at $launcher (already gone)"
}
# Remove the now-empty %LOCALAPPDATA%\coop\bin (and \coop, if nothing else lives there).
foreach ($d in @($LOCALBIN, (Split-Path -Parent $LOCALBIN))) {
  if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
  }
}
# Persistent user PATH: read/write the RAW value via the registry as ExpandString
# (mirror of install.ps1 — [Environment]::SetEnvironmentVariable would expand and
# freeze %VAR% tokens), then broadcast WM_SETTINGCHANGE via a throwaway var so
# open shells/Explorer refresh their environment.
try {
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if ($envKey) {
    $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $newUserPath = (@($userPath -split ';' | Where-Object { $_ -and $_ -ne $LOCALBIN })) -join ';'
    if ($newUserPath -ne $userPath) {
      $envKey.SetValue('Path', $newUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', '1', 'User')
      [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', $null, 'User')
      Coop-Ok "removed $LOCALBIN from your user PATH"
    } else {
      Coop-Info 'user PATH has no coop entry (already clean)'
    }
    $envKey.Close()
  }
} catch {
  Coop-Warn "couldn't update the user PATH automatically — remove $LOCALBIN by hand (System Properties > Environment Variables)."
}
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -ne $LOCALBIN }) -join ';'

# --- 2. Start Menu + Desktop shortcuts (inverse of install.ps1) ----------------
$removedLnk = @()
foreach ($name in @('coop.lnk', 'coop (terminal).lnk')) {
  foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    if (-not $dir) { continue }   # special folder can be empty off-Windows
    $lnk = Join-Path $dir $name
    if (Test-Path -LiteralPath $lnk) {
      Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $lnk)) { $removedLnk += $lnk }
    }
  }
}
if ($removedLnk.Count -gt 0) { Coop-Ok "removed $($removedLnk.Count) shortcut(s) (Start Menu / Desktop)" }
else { Coop-Info 'no coop shortcuts found (already gone)' }

# --- 3. The isolated Pi agent dir ----------------------------------------------
# ONLY the agent dir — the rest of ~/.coop can hold private, non-coop-agent config.
$agentDir = Get-CoopPiAgentDir
if (-not $agentDir -or $agentDir -eq $HOME) {
  Coop-Warn "suspicious agent dir '$agentDir' — not removing"
} elseif (Test-Path -LiteralPath $agentDir) {
  Remove-Item -LiteralPath $agentDir -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $agentDir)) { Coop-Ok "removed $agentDir (extensions, settings, MCP config, session state)" }
  else { Coop-Warn "could not fully remove $agentDir — close any running coop/pi session and re-run" }
} else {
  Coop-Info "no agent dir at $agentDir (already gone)"
}

# --- 4. The tool layer (skipped with --keep-tools) -------------------------------
if ($KEEP_TOOLS) {
  Coop-Info 'kept pi + the pipx tools (--keep-tools)'
} else {
  $globals = if (Test-Have 'npm') { (& npm ls -g --depth=0 2>$null | Out-String) } else { '' }
  if ($globals -match [regex]::Escape($PI_NPM_PACKAGE)) {
    & npm uninstall -g $PI_NPM_PACKAGE *> $null
    if ($LASTEXITCODE -eq 0) { Coop-Ok "removed pi ($PI_NPM_PACKAGE)" }
    else { Coop-Warn "could not npm-uninstall pi — remove by hand: npm uninstall -g $PI_NPM_PACKAGE" }
  } else {
    Coop-Info 'pi not installed via npm globally (nothing to remove)'
  }
  if (Test-Have 'pipx') {
    $pipxList = (& pipx list 2>$null | Out-String)
    foreach ($pkg in $PY_TOOLS) {
      if ($pipxList -match ("package " + [regex]::Escape($pkg) + " ")) {
        & pipx uninstall $pkg *> $null
        if ($LASTEXITCODE -eq 0) { Coop-Ok "removed $pkg (pipx)" }
        else { Coop-Warn "could not pipx-uninstall $pkg — remove by hand: pipx uninstall $pkg" }
      }
    }
  } else {
    Coop-Info 'pipx not found — no pipx tools to remove'
  }
}

[Console]::Error.WriteLine('')
Coop-Ok 'uninstall complete.'
Coop-Info 're-install any time from a coop-agent clone:  .\bin\coop.cmd install'
exit 0
