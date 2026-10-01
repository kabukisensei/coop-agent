#!/usr/bin/env pwsh
# Home-guard (port of tests/home-guard.test.sh): proves the fleet entry points
# (install / update / sync / doctor / onboard) cannot write into the REAL home
# directory when run under the suite's isolation environment. Motivated by a
# historical leak where test stubs landed in ~/.local/bin; this fails if that
# ever happens again.
#
# Scope: ~/.local/bin and ~/.coop (the two locations the fleet scripts write) of
# the home this fixture was started with, plus the checkout running the tests,
# which update and doctor must never fetch or move (the scripts run from a plain
# copy of the tree with no .git, #104). Offline: pi/npm/pipx/fab/az are honest
# stubs; git, node and python are real.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-home-guard-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }
$realNode = (Get-Command node -ErrorAction Stop).Source
$realGit = (Get-Command git -ErrorAction Stop).Source
$realPy = $null
foreach ($n in @('python3.13', 'python3.12', 'python3', 'python')) { $c = Get-Command $n -ErrorAction SilentlyContinue; if ($c) { $realPy = $c.Source; break } }
if (-not $realPy) { throw 'a Python 3.10-3.13 is required for the home-guard fixture' }
$psDir = Split-Path -Parent $psExe

# The home under guard: the one this process was started with (USERPROFILE on
# Windows, HOME elsewhere), captured BEFORE the sandbox replaces it.
$realHome = if ($isWindowsHost -and $env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
# Sorted "relative-path sha256" lines (stable, no mtimes); '' for a missing dir.
function Get-Snapshot([string]$Dir) {
  if (-not $Dir -or -not (Test-Path -LiteralPath $Dir -PathType Container)) { return '' }
  $base = (Resolve-Path -LiteralPath $Dir).Path
  $lines = @()
  foreach ($f in (Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ne '.pyc' })) {
    $h = try { (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { 'unreadable' }
    $lines += ($f.FullName.Substring($base.Length).TrimStart('\', '/') -replace '\\', '/') + ' ' + $h
  }
  return (($lines | Sort-Object) -join "`n")
}
function Write-Stub([string]$Dir, [string]$Name, [string]$Body, [string]$Cmd = 'exit /b 0') {
  [System.IO.File]::WriteAllText((Join-Path $Dir $Name), "#!/bin/sh`n$Body`n")
  if ($isWindowsHost) { [System.IO.File]::WriteAllText((Join-Path $Dir ($Name + '.cmd')), "@echo off`r`n$Cmd`r`n") }
  else { & $chmod +x (Join-Path $Dir $Name) }
}
function Invoke-Fleet([string]$Script, [string]$OutFile, [string[]]$ScriptArgs = @()) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\$Script") @ScriptArgs 2>&1 | ForEach-Object { "$_" })
  $ErrorActionPreference = $eap
  [System.IO.File]::WriteAllText($OutFile, ($lines -join "`n"))
  [System.IO.File]::WriteAllText($env:MARKER, '')
}

$saved = @{}
$names = @('PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COOP_DIR', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PI_CODING_AGENT_DIR', 'COOP_AGENT_DIR',
           'COOP_NO_ONBOARD', 'MARKER', 'COOP_TEST_STUB_PATH', 'COOP_FABRIC_PYTHON', 'COOP_FLEET_TEST_MODE', 'COOP_RELEASE_MANIFEST', 'COOP_SKIP_AZ',
           'COOP_AZ_BIN', 'NO_COLOR', 'COOP_PI_LATEST_OVERRIDE', 'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$priorPath = $env:PATH
try {
  $beforeLocalBin = Get-Snapshot (Join-Path $realHome '.local\bin')
  $beforeCoop = Get-Snapshot (Join-Path $realHome '.coop')

  # A plain copy of the tree, no .git (dot entries other than the bundled .coop
  # contract are git, CI and cache files, not runtime).
  $root = Join-Path $t 'coop-agent'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  foreach ($e in (Get-ChildItem -LiteralPath $checkout -Force | Where-Object { -not $_.Name.StartsWith('.') -or $_.Name -eq '.coop' })) {
    Copy-Item -LiteralPath $e.FullName -Destination (Join-Path $root $e.Name) -Recurse -Force
  }
  $sandboxHome = Join-Path $t 'home'
  $bin = Join-Path $sandboxHome '.local\bin'
  $agent = Join-Path $t 'agent'
  foreach ($p in @($bin, $agent, (Join-Path $t 'pipx-home'), (Join-Path $t 'pipx-bin'), (Join-Path $t 'coop-dir'), (Join-Path $sandboxHome 'AppData\Local\Microsoft\Windows\PowerShell'), (Join-Path $sandboxHome 'AppData\Roaming'))) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
  }
  $marker = Join-Path $t 'calls'
  [System.IO.File]::WriteAllText($marker, '')

  # Honest offline stubs so the scripts exercise real code paths without network
  # or workstation tools. The pi stub installs extensions honestly (sync's
  # postcondition check requires it); the npm stub materializes the shared
  # pi-ai/pi-tui libraries the realignment asks for.
  Write-Stub $bin 'pi' @'
[ "$1" = "--version" ] && { echo 'pi 0.87.1'; exit 0; }
if [ "$1" = "install" ]; then
  spec="$2"; rest="${spec#npm:}"; name="${rest%@*}"; ver="${rest##*@}"
  dir="${PI_CODING_AGENT_DIR:?}/npm/node_modules/$name"
  mkdir -p "$dir"
  printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "$dir/package.json"
fi
echo "PI $*" >> "$MARKER"; exit 0
'@ 'if "%1"=="--version" (echo pi 0.87.1& exit /b 0)' + "`r`n" + 'echo PI %*>>"%MARKER%"' + "`r`n" + 'exit /b 0'
  Write-Stub $bin 'npm' @'
[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }
[ "$1" = "view" ] && { echo '0.87.1'; exit 0; }
[ "$1" = "--version" ] && { echo '10.9.0'; exit 0; }
if [ "$1" = "install" ]; then
  for a in "$@"; do
    case "$a" in
      @earendil-works/pi-ai@*|@earendil-works/pi-tui@*)
        name="${a%@*}"; ver="${a##*@}"; mkdir -p "node_modules/$name"
        printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "node_modules/$name/package.json" ;;
    esac
  done
fi
echo "NPM $*" >> "$MARKER"; exit 0
'@ ('if "%1 %2"=="prefix -g" (echo ' + $sandboxHome + '\.local& exit /b 0)' + "`r`n" + 'if "%1"=="view" (echo 0.87.1& exit /b 0)' + "`r`n" + 'if "%1"=="--version" (echo 10.9.0& exit /b 0)' + "`r`n" + 'echo NPM %*>>"%MARKER%"' + "`r`n" + 'exit /b 0')
  Write-Stub $bin 'pipx' '[ "$1" = "list" ] && exit 0' + "`n" + 'echo "PIPX $*" >> "$MARKER"; exit 0' ('if "%1"=="list" exit /b 0' + "`r`n" + 'echo PIPX %*>>"%MARKER%"' + "`r`n" + 'exit /b 0')
  Write-Stub $bin 'fab' "echo 'fab version 1.6.1'" 'echo fab version 1.6.1'
  # A Fabric-compatible (3.10-3.13) Python and an Azure CLI stub let install pass
  # its H1 prerequisite gate, so the install path below really runs. Real git
  # behind a wrapper (Git Bash keeps git in /mingw64/bin, off this PATH).
  Write-Stub $bin 'az' 'echo azure-cli 2.80.0' 'echo azure-cli 2.80.0'
  Write-Stub $bin 'git' "exec `"$realGit`" `"`$@`"" "`"$realGit`" %*"
  Write-Stub $bin 'node' "exec `"$realNode`" `"`$@`"" "`"$realNode`" %*"
  Write-Stub $bin 'python3' "exec `"$realPy`" `"`$@`"" "`"$realPy`" %*"

  # Native Windows node and python find the home through USERPROFILE, not HOME, so
  # the fleet scripts get a sandboxed USERPROFILE too; without it a standards
  # refresh in sync reached the real %USERPROFILE%\.coop (#135).
  $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome
  $env:LOCALAPPDATA = Join-Path $sandboxHome 'AppData\Local'; $env:APPDATA = Join-Path $sandboxHome 'AppData\Roaming'
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:PIPX_HOME = Join-Path $t 'pipx-home'; $env:PIPX_BIN_DIR = Join-Path $t 'pipx-bin'
  $env:PI_CODING_AGENT_DIR = $agent; $env:COOP_AGENT_DIR = $agent
  $env:COOP_RELEASE_MANIFEST = Join-Path $root 'config\release-manifest.json'
  $env:MARKER = $marker; $env:COOP_TEST_STUB_PATH = $bin
  $env:COOP_NO_ONBOARD = '1'; $env:COOP_SKIP_AZ = '1'; $env:NO_COLOR = '1'
  $env:COOP_PI_LATEST_OVERRIDE = '0.87.1'
  foreach ($n in @('COOP_FABRIC_PYTHON', 'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT')) { [Environment]::SetEnvironmentVariable($n, $null) }
  if ($isWindowsHost) { $env:PATH = $bin + ';' + $priorPath }
  else {
    # Stub bin first, the system dirs the scripts need (sh, uname) next; the stub
    # bin again at the END because install.ps1's PATH helpers prepend with ';'
    # (Windows separators), which on a POSIX host fuses the leading entries into
    # one unusable segment.
    $env:PATH = $bin + ':' + $psDir + ':/usr/bin:/bin:' + $bin
  }

  Write-Host '-> fleet paths cannot mutate the real home directory'
  $env:COOP_FLEET_TEST_MODE = '1'
  Invoke-Fleet 'install.ps1' (Join-Path $t 'install.out') @('--force')
  Invoke-Fleet 'update.ps1' (Join-Path $t 'update.out')
  Remove-Item Env:\COOP_FLEET_TEST_MODE -ErrorAction SilentlyContinue
  Invoke-Fleet 'sync.ps1' (Join-Path $t 'sync.out')
  Push-Location $t
  try { Invoke-Fleet 'doctor.ps1' (Join-Path $t 'doctor.out') } finally { Pop-Location }
  # Onboarding wizard itself (scripted answers, isolated dirs).
  $env:COOP_AZ_BIN = Join-Path $t 'nonexistent\az'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $null = ("Guard User`n2`nn`n`n`nn`n`n" | & $realPy (Join-Path $root 'scripts\onboard.py') onboard 2>&1)
  $ErrorActionPreference = $eap

  $afterLocalBin = Get-Snapshot (Join-Path $realHome '.local\bin')
  $afterCoop = Get-Snapshot (Join-Path $realHome '.coop')
  if ($beforeLocalBin -ceq $afterLocalBin) { Ok "$realHome/.local/bin unchanged by fleet paths" }
  else { Ko "$realHome/.local/bin MUTATED" (Compare-Object ($beforeLocalBin -split "`n") ($afterLocalBin -split "`n") | Select-Object -First 10 | Out-String) }
  if ($beforeCoop -ceq $afterCoop) { Ok "$realHome/.coop unchanged by fleet paths" }
  else { Ko "$realHome/.coop MUTATED" (Compare-Object ($beforeCoop -split "`n") ($afterCoop -split "`n") | Select-Object -First 10 | Out-String) }

  # Update and doctor ran from the copy, so neither saw a git checkout to fetch or move.
  $updateOut = [System.IO.File]::ReadAllText((Join-Path $t 'update.out'))
  $doctorOut = [System.IO.File]::ReadAllText((Join-Path $t 'doctor.out'))
  if ($updateOut.Contains('not a git checkout') -and $doctorOut.Contains('not a git checkout')) { Ok 'update and doctor ran from a copy, never the checkout running the tests' }
  else { Ko 'update or doctor ran against a git checkout; fleet paths must run from a copy (#104)' ($updateOut + "`n" + $doctorOut) }

  # Sanity: the stubs were actually exercised (otherwise the guard proves nothing).
  if (Test-Path -LiteralPath (Join-Path $agent 'npm\node_modules\pi-mcp-adapter')) { Ok 'stubbed install path was genuinely exercised' }
  else { Ko 'isolation sanity failed: extension tree not created in temp dir' ([System.IO.File]::ReadAllText((Join-Path $t 'install.out'))) }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  home-guard tests passed' } else { Write-Host "  $G_CROSS home-guard tests FAILED" }
exit $fail
