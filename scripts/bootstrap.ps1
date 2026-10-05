#!/usr/bin/env pwsh
#
# coop bootstrap — ONE command sets up coop on a Windows machine, terminal and
# window alike (master plan D1k). Paste this into Windows PowerShell:
#
#   irm https://raw.githubusercontent.com/kabukisensei/coop-agent/main/scripts/bootstrap.ps1 | iex
#
# What it does, in order (each step is skipped when already done, so the same
# line repairs a half-finished setup):
#   1. Git            installed with winget when missing (the only tool the clone
#                     itself needs; everything else goes through coop install)
#   2. the code       git clone into ~\coop-agent at the newest release tag, the
#                     same checkout docs/install-windows.md step 2 describes
#   3. coop install   with --prereqs auto: Node, Python, pipx and the Azure CLI
#                     through winget where missing, then Pi, the tools, the
#                     sign-ins, the `coop` command and the "coop" shortcut
#   4. the window     the release's coop-window-<version>-win-x64.exe, checked
#                     against the SHA-256 in the release's installer-acceptance
#                     report, installed silently for this user
#
# Everything comes from winget's Microsoft source, nodejs.org (inside the
# installer), npm, PyPI and github.com, the same places coop install already
# uses: no third-party service is contacted (client data isolation).
# winget's machine installers (Git, the Azure CLI, ODBC) each raise one Windows
# permission prompt; Python and pipx stay per-user.
#
# Settings (environment variables, read once):
#   COOP_BOOTSTRAP_DIR=<folder>   where to clone (default: $HOME\coop-agent)
#   COOP_BOOTSTRAP_NO_WINDOW=1    terminal coop only; skip the window installer
#   COOP_BOOTSTRAP_DRY_RUN=1      print the steps for this machine and stop
#
# Runs under `irm | iex` (no $PSScriptRoot, and `exit` would close the user's
# shell, so every failure is a `return`) and as a file (tests, `pwsh -File`),
# where the same code sets the exit code. Windows PowerShell 5.1 syntax only.
# The file keeps the repo's UTF-8 BOM (scripts/check-bom.ps1); Invoke-RestMethod
# decodes the response through a StreamReader, which drops it, so iex sees the
# `#!` line first (checked against pwsh 7; 5.1 decodes the same way).

$script:CoopBootstrapRepo = 'https://github.com/kabukisensei/coop-agent'
$script:CoopBootstrapTagFloor = '0.23.6'   # first release whose coop update follows tags

function Write-CoopBootstrapLine([string]$Mark, [string]$Text) { [Console]::Error.WriteLine("  $Mark $Text") }
function Coop-BootstrapInfo([string]$m) { Write-CoopBootstrapLine '-' $m }
function Coop-BootstrapOk([string]$m) { Write-CoopBootstrapLine '+' $m }
function Coop-BootstrapWarn([string]$m) { Write-CoopBootstrapLine '!' $m }
function Coop-BootstrapFail([string]$m) { Write-CoopBootstrapLine 'x' $m }
function Coop-BootstrapHead([string]$m) { [Console]::Error.WriteLine(''); [Console]::Error.WriteLine($m) }

# PATH as a new terminal would see it: the registry's Machine and User values,
# appended to this process's PATH (winget's installers register there).
function Update-CoopBootstrapPath {
  foreach ($scope in @('Machine', 'User')) {
    foreach ($d in ([string][Environment]::GetEnvironmentVariable('Path', $scope) -split ';')) {
      if ($d -and (($env:PATH -split ';') -notcontains $d)) { $env:PATH = "$env:PATH;$d" }
    }
  }
}

function Get-CoopBootstrapReleaseTag([string]$Dir) {
  $tags = @(& git -C $Dir tag --merged origin/main '--sort=-v:refname' 2>$null)
  foreach ($t in $tags) {
    if ($t -match '^v(\d+\.\d+\.\d+)$' -and ([version]$Matches[1] -ge [version]$script:CoopBootstrapTagFloor)) { return $t }
  }
  return ''
}

# The installed window's version from `coop.exe --doctor` (one JSON line), or ''.
function Get-CoopBootstrapWindowVersion {
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\coop\coop.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return '' }
  try {
    $line = (& $exe --doctor 2>$null | Select-Object -Last 1)
    if (-not $line) { return '' }
    $info = $line | ConvertFrom-Json -ErrorAction Stop
    return [string]$info.version
  } catch { return '' }
}

function Install-CoopBootstrapWindow([string]$Tag) {
  $version = $Tag.Substring(1)
  $have = Get-CoopBootstrapWindowVersion
  if ($have -eq $version) { Coop-BootstrapOk "the coop window $version is already installed"; return $true }
  $base = "$($script:CoopBootstrapRepo)/releases/download/$Tag"
  $name = "coop-window-$version-win-x64.exe"
  $work = Join-Path $env:TEMP 'coop-bootstrap'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $exe = Join-Path $work $name
  try {
    $report = Invoke-RestMethod -Uri "$base/installer-acceptance.json" -UseBasicParsing -ErrorAction Stop
  } catch {
    Coop-BootstrapWarn "release $Tag has no window installer report ($($_.Exception.Message)); skipping the window. Download it from $($script:CoopBootstrapRepo)/releases/latest when it exists."
    return $true
  }
  if ($report.ok -ne $true -or [string]$report.version -ne $version -or -not $report.installerSha256) {
    Coop-BootstrapFail "the release's installer report does not vouch for $name (ok=$($report.ok), version=$($report.version)); not installing the window"
    return $false
  }
  Coop-BootstrapInfo "downloading $name"
  try {
    Invoke-WebRequest -Uri "$base/$name" -OutFile $exe -UseBasicParsing -ErrorAction Stop
  } catch {
    Coop-BootstrapFail "could not download $name ($($_.Exception.Message))"
    return $false
  }
  $sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sha -ne ([string]$report.installerSha256).ToLowerInvariant()) {
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Coop-BootstrapFail "the downloaded installer's SHA-256 ($sha) is not the one the release's acceptance report names ($($report.installerSha256)); deleted it, not installing the window"
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
  Coop-BootstrapOk 'the coop window is installed: "coop (window)" on the Desktop and in the Start Menu'
  return $true
}

function Invoke-CoopBootstrap {
  $dir = if ($env:COOP_BOOTSTRAP_DIR) { $env:COOP_BOOTSTRAP_DIR } else { Join-Path $HOME 'coop-agent' }
  $noWindow = ($env:COOP_BOOTSTRAP_NO_WINDOW -eq '1')
  Coop-BootstrapHead 'coop bootstrap: one command for the terminal coop and the coop window'
  Coop-BootstrapInfo "1. Git (winget, when missing)"
  Coop-BootstrapInfo "2. clone $($script:CoopBootstrapRepo) into $dir at the newest release"
  Coop-BootstrapInfo "3. coop install --prereqs auto (Node, Python, pipx, Azure CLI through winget when missing; then Pi, the tools and the sign-ins)"
  if ($noWindow) { Coop-BootstrapInfo '4. the coop window: skipped (COOP_BOOTSTRAP_NO_WINDOW=1)' }
  else { Coop-BootstrapInfo "4. the coop window installer from that release, SHA-256 checked, installed for this user" }
  if ($env:COOP_BOOTSTRAP_DRY_RUN -eq '1') { Coop-BootstrapOk 'dry run (COOP_BOOTSTRAP_DRY_RUN=1): nothing was changed'; $script:CoopBootstrapRc = 0; return }
  if ($env:OS -ne 'Windows_NT') {
    Coop-BootstrapFail 'this bootstrap runs on Windows only. On macOS or Linux: git clone the repository, then run ./bin/coop install'
    $script:CoopBootstrapRc = 1; return
  }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  Coop-BootstrapHead '1. Git'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Coop-BootstrapFail 'Git is missing and winget is not available. Install Git from https://git-scm.com/download/win, open a new PowerShell window and run this command again'
      $script:CoopBootstrapRc = 1; return
    }
    Coop-BootstrapInfo 'installing Git with winget (Windows may ask for permission)'
    & winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    Update-CoopBootstrapPath
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      Coop-BootstrapFail 'Git is still not on PATH. Open a NEW PowerShell window and run this command again'
      $script:CoopBootstrapRc = 1; return
    }
  }
  Coop-BootstrapOk ((& git --version 2>$null | Select-Object -First 1))

  Coop-BootstrapHead '2. The code'
  if (Test-Path -LiteralPath (Join-Path $dir '.git') -PathType Container) {
    Coop-BootstrapInfo "$dir exists; fetching releases"
    & git -C $dir fetch --tags --quiet origin
    if ($LASTEXITCODE -ne 0) { Coop-BootstrapFail "git fetch failed in $dir"; $script:CoopBootstrapRc = 1; return }
  } elseif ((Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
    Coop-BootstrapFail "$dir exists and is not a coop-agent clone. Move it away, or set COOP_BOOTSTRAP_DIR to another folder, then run this command again"
    $script:CoopBootstrapRc = 1; return
  } else {
    Coop-BootstrapInfo "cloning into $dir (no --depth: a partial clone cannot follow releases)"
    & git clone --quiet "$($script:CoopBootstrapRepo).git" $dir
    if ($LASTEXITCODE -ne 0) { Coop-BootstrapFail 'git clone failed (see above)'; $script:CoopBootstrapRc = 1; return }
  }
  $tag = Get-CoopBootstrapReleaseTag $dir
  if ($tag) {
    & git -C $dir checkout --quiet $tag
    if ($LASTEXITCODE -ne 0) { Coop-BootstrapFail "could not check out $tag in $dir (uncommitted changes there?)"; $script:CoopBootstrapRc = 1; return }
    Coop-BootstrapOk "coop $tag in $dir"
  } else {
    Coop-BootstrapWarn "no release tag found; staying on the clone's current branch"
  }

  Coop-BootstrapHead '3. coop install'
  $launcher = Join-Path $dir 'bin\coop.cmd'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { Coop-BootstrapFail "$launcher is missing; the clone is incomplete"; $script:CoopBootstrapRc = 1; return }
  & $launcher install --prereqs auto
  $rc = $LASTEXITCODE
  if ($rc -ne 0) {
    Coop-BootstrapFail "coop install stopped with exit code $rc. Do what its last lines say (usually: open a NEW PowerShell window), then run this one command again; it continues where it stopped"
    $script:CoopBootstrapRc = 1; return
  }
  Coop-BootstrapOk 'the terminal coop is installed'

  if (-not $noWindow) {
    Coop-BootstrapHead '4. The coop window'
    if (-not $tag) { Coop-BootstrapWarn 'no release tag, so no window installer to download; skipping' }
    elseif (-not (Install-CoopBootstrapWindow $tag)) { $script:CoopBootstrapRc = 1; return }
  }

  Coop-BootstrapHead 'All set'
  Coop-BootstrapInfo 'open a NEW PowerShell window and run: coop'
  if (-not $noWindow) { Coop-BootstrapInfo 'or double-click "coop (window)" on the Desktop or in the Start Menu' }
  $script:CoopBootstrapRc = 0; return
}

# The function sets the result instead of returning it: the native commands it
# runs (winget, git, coop.cmd) must keep the console as their stdout (the install
# ends in an interactive coop screen), so their output is not captured here.
$script:CoopBootstrapRc = 1
Invoke-CoopBootstrap
# Under `irm | iex` there is no script path and `exit` would close the shell;
# run as a file (pwsh -File, tests) the exit code carries the result.
if ($PSCommandPath) { exit $script:CoopBootstrapRc }
