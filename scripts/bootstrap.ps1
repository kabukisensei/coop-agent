#!/usr/bin/env pwsh
#
# coop bootstrap - ONE command sets up coop on a Windows machine (master plan
# D1k). Paste this into Windows PowerShell:
#
#   irm https://raw.githubusercontent.com/kabukisensei/coop-agent/main/scripts/bootstrap.ps1 | iex
#
# This file is ASCII with NO UTF-8 BOM, the one .ps1 exempt from the BOM rule
# (scripts/check-bom.ps1): `irm | iex` hands a BOM to iex as a character, so
# the first line stops being a comment and prints a red error first.
#
# It downloads and runs the same coop window installer the install page links,
# which carries everything (Aaron 2026-10-06, "an installer that installs
# everything"): Node, Pi, Git, Python with pipx and every coop tool, the Azure
# CLI, and the ODBC Driver 18 with its VC++ runtime. No winget, no clone.
#   1. the release    the newest coop-agent release on github.com
#   2. the installer  its coop-window-<version>-win-x64.exe, checked against
#                     the SHA-256 in the release's installer-acceptance report
#   3. install        silently, for this user, no administrator
#   4. first launch   opens the coop window, which sets up this computer from
#                     the package (the `coop` command, the Python tools, the
#                     sign-ins) and asks Windows for administrator permission
#                     once, for the SQL driver
# Running it again repairs a half-finished setup: an installed window at the
# same version is kept and simply opened.
#
# Only github.com is contacted (client data isolation): the installer carries
# every download inside it.
#
# Settings (environment variables, read once):
#   COOP_BOOTSTRAP_NO_LAUNCH=1    install, but do not open the window
#   COOP_BOOTSTRAP_DRY_RUN=1      print the steps and stop
#
# Runs under `irm | iex` (no $PSScriptRoot, and `exit` would close the user's
# shell, so every failure is a `return`) and as a file (tests, `pwsh -File`),
# where the same code sets the exit code. Windows PowerShell 5.1 syntax only.
# The file keeps the repo's UTF-8 BOM (scripts/check-bom.ps1); Invoke-RestMethod
# decodes the response through a StreamReader, which drops it, so iex sees the
# `#!` line first (checked against pwsh 7; 5.1 decodes the same way).

$script:CoopBootstrapRepo = 'https://github.com/kabukisensei/coop-agent'

function Write-CoopBootstrapLine([string]$Mark, [string]$Text) { [Console]::Error.WriteLine("  $Mark $Text") }
function Coop-BootstrapInfo([string]$m) { Write-CoopBootstrapLine '-' $m }
function Coop-BootstrapOk([string]$m) { Write-CoopBootstrapLine '+' $m }
function Coop-BootstrapWarn([string]$m) { Write-CoopBootstrapLine '!' $m }
function Coop-BootstrapFail([string]$m) { Write-CoopBootstrapLine 'x' $m }
function Coop-BootstrapHead([string]$m) { [Console]::Error.WriteLine(''); [Console]::Error.WriteLine($m) }

# The newest release's version: GitHub's latest-release record, else the
# VERSION file on main (a release bumps it as it tags). '' when neither answers.
function Get-CoopBootstrapLatestVersion {
  try {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/kabukisensei/coop-agent/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'coop-bootstrap' } -ErrorAction Stop
    if ([string]$rel.tag_name -match '^v(\d+\.\d+\.\d+)$') { return $Matches[1] }
  } catch { }
  try {
    $v = [string](Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/kabukisensei/coop-agent/main/VERSION' -UseBasicParsing -ErrorAction Stop)
    if ($v.Trim() -match '^\d+\.\d+\.\d+$') { return $v.Trim() }
  } catch { }
  return ''
}

function Get-CoopBootstrapWindowExe { return (Join-Path $env:LOCALAPPDATA 'Programs\coop\coop.exe') }

# The installed window's version from `coop.exe --doctor` (one JSON line), or ''.
function Get-CoopBootstrapWindowVersion {
  $exe = Get-CoopBootstrapWindowExe
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return '' }
  try {
    $line = (& $exe --doctor 2>$null | Select-Object -Last 1)
    if (-not $line) { return '' }
    $info = $line | ConvertFrom-Json -ErrorAction Stop
    return [string]$info.version
  } catch { return '' }
}

function Install-CoopBootstrapWindow([string]$Version) {
  $have = Get-CoopBootstrapWindowVersion
  if ($have -eq $Version) { Coop-BootstrapOk "the coop window $Version is already installed"; return $true }
  $base = "$($script:CoopBootstrapRepo)/releases/download/v$Version"
  $name = "coop-window-$Version-win-x64.exe"
  $work = Join-Path $env:TEMP 'coop-bootstrap'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $exe = Join-Path $work $name
  try {
    $report = Invoke-RestMethod -Uri "$base/installer-acceptance.json" -UseBasicParsing -ErrorAction Stop
  } catch {
    Coop-BootstrapFail "release v$Version has no window installer report ($($_.Exception.Message)). Download the installer from $($script:CoopBootstrapRepo)/releases/latest when it appears, then run this command again"
    return $false
  }
  if ($report.ok -ne $true -or [string]$report.version -ne $Version -or -not $report.installerSha256) {
    Coop-BootstrapFail "the release's installer report does not vouch for $name (ok=$($report.ok), version=$($report.version)); not installing"
    return $false
  }
  Coop-BootstrapInfo "downloading $name (large: everything coop needs is inside)"
  try {
    # Invoke-WebRequest's progress bar slows Windows PowerShell 5.1 downloads badly.
    $pp = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri "$base/$name" -OutFile $exe -UseBasicParsing -ErrorAction Stop } finally { $ProgressPreference = $pp }
  } catch {
    Coop-BootstrapFail "could not download $name ($($_.Exception.Message))"
    return $false
  }
  $sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sha -ne ([string]$report.installerSha256).ToLowerInvariant()) {
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Coop-BootstrapFail "the downloaded installer's SHA-256 ($sha) is not the one the release's acceptance report names ($($report.installerSha256)); deleted it, not installing"
    return $false
  }
  Coop-BootstrapOk "SHA-256 matches the release's acceptance report"
  # The hash check above is the trust decision; the download mark would only
  # bring the SmartScreen click the install page describes.
  Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue
  Coop-BootstrapInfo 'installing the coop window for this user (silent, no administrator)'
  $p = Start-Process -FilePath $exe -ArgumentList @('/S', '/currentuser') -Wait -PassThru
  if ($p.ExitCode -ne 0) { Coop-BootstrapFail "the window installer exited with code $($p.ExitCode)"; return $false }
  Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
  Coop-BootstrapOk 'the coop window is installed: "coop" on the Desktop and in the Start Menu'
  return $true
}

function Invoke-CoopBootstrap {
  $noLaunch = ($env:COOP_BOOTSTRAP_NO_LAUNCH -eq '1')
  Coop-BootstrapHead 'coop bootstrap: one installer with everything coop needs'
  Coop-BootstrapInfo '1. find the newest coop release on github.com'
  Coop-BootstrapInfo '2. download its coop window installer, SHA-256 checked'
  Coop-BootstrapInfo '3. install it for this user (no administrator)'
  if ($noLaunch) { Coop-BootstrapInfo '4. first launch: skipped (COOP_BOOTSTRAP_NO_LAUNCH=1); open "coop" from the Desktop to finish setup' }
  else { Coop-BootstrapInfo '4. open the coop window: its first launch sets up this computer from the package (Windows asks for administrator permission once, for the SQL driver)' }
  if ($env:COOP_BOOTSTRAP_DRY_RUN -eq '1') { Coop-BootstrapOk 'dry run (COOP_BOOTSTRAP_DRY_RUN=1): nothing was changed'; $script:CoopBootstrapRc = 0; return }
  if ($env:OS -ne 'Windows_NT') {
    Coop-BootstrapFail 'this bootstrap runs on Windows only. On macOS or Linux: git clone the repository, then run ./bin/coop install'
    $script:CoopBootstrapRc = 1; return
  }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  Coop-BootstrapHead '1. The release'
  $version = Get-CoopBootstrapLatestVersion
  if (-not $version) { Coop-BootstrapFail "could not read the newest release from github.com. Check this machine can open $($script:CoopBootstrapRepo)/releases/latest, then run this command again"; $script:CoopBootstrapRc = 1; return }
  Coop-BootstrapOk "coop $version"

  Coop-BootstrapHead '2-3. The coop window'
  if (-not (Install-CoopBootstrapWindow $version)) { $script:CoopBootstrapRc = 1; return }

  Coop-BootstrapHead '4. First launch'
  if ($noLaunch) {
    Coop-BootstrapInfo 'open "coop" from the Desktop or the Start Menu: its first launch finishes the setup'
  } else {
    $exe = Get-CoopBootstrapWindowExe
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Coop-BootstrapFail "$exe is missing after the install"; $script:CoopBootstrapRc = 1; return }
    Start-Process -FilePath $exe | Out-Null
    Coop-BootstrapOk 'the coop window is opening; its setup console shows each step, then the window appears'
  }
  Coop-BootstrapInfo 'later, open "coop" from the Desktop, or type coop in a NEW PowerShell window'
  $script:CoopBootstrapRc = 0; return
}

# The function sets the result instead of returning it, so the steps' own
# output stays on the console.
$script:CoopBootstrapRc = 1
Invoke-CoopBootstrap
# Under `irm | iex` there is no script path and `exit` would close the shell;
# run as a file (pwsh -File, tests) the exit code carries the result.
if ($PSCommandPath) { exit $script:CoopBootstrapRc }
