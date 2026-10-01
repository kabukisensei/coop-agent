#!/usr/bin/env pwsh
# Execute the normal install/update/sync fleet paths with offline stubs and assert
# the exact specs they converge to (port of tests/fleet-execution.test.sh):
#   - `install --force` reinstalls the Fabric CLI with an explicit supported
#     bootstrap Python and injects the exact fabric-cicd / pyodbc runtime pins;
#     an injection or pipx failure is exit 1; install itself never runs
#     `pi install` (the extensions are the sync child's, master plan S2)
#   - a non-Windows install without ODBC Driver 18 still converges with ONE warning
#   - `update` (fleet mode) never fetches the checkout it runs from, leaves Pi and
#     the pipx tools already at their pins alone (offline no-op), converges a
#     drifted tool, and is exit 1 when a convergence unit fails
#   - `sync` installs every manifest extension pin into the isolated tree, and a
#     repeat sync is an offline no-op
#   - normal install converges drifted Pi / pipx tools, skips matching ones;
#     `--edge` attempts upstream latest for Pi and the tools (extensions stay
#     pinned); a failed Fabric convergence is a failure; update installs missing
#     manifest-pinned pipx tools with the explicit bootstrap Python
# The pipx stub is honest: `install` / `upgrade` update the list it reports, so
# the convergence postcondition (installed version == pin) is really exercised.
# The scripts run from a plain COPY of this tree with no .git (#104): step 1 of
# `coop update` fetches and fast-forwards the checkout it runs from, and a test
# must never touch the checkout running it. Every location the fleet scripts can
# write is isolated per block (temp HOME / USERPROFILE / COOP_DIR / PIPX_HOME /
# agent dirs); the real ~/.coop is never read or written.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-fleet-exec-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
$sep = [System.IO.Path]::PathSeparator
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }
# Real tools the stub machine forwards to (captured before PATH is restricted).
$realNode = (Get-Command node -ErrorAction Stop).Source
$realGit = (Get-Command git -ErrorAction Stop).Source
# The stub machine needs a Fabric-compatible (3.10-3.13) Python for the H1 gate;
# prefer a versioned one so a host whose python3 is 3.14 still qualifies.
$realPy = $null
foreach ($n in @('python3.13', 'python3.12', 'python3', 'python')) { $c = Get-Command $n -ErrorAction SilentlyContinue; if ($c) { $realPy = $c.Source; break } }
if (-not $realPy) { throw 'a Python 3.10-3.13 is required for the fleet fixtures' }
$psDir = Split-Path -Parent $psExe

$extSpecs = @('npm:pi-mcp-adapter@3.3.0', 'npm:pi-hermes-memory@0.9.9', 'npm:pi-better-openai@0.1.22', 'npm:pi-web-access@0.10.7',
              'npm:@juicesharp/rpiv-ask-user-question@2.12.0', 'npm:@xl0/pi-lovely-rename@0.1.5', 'npm:context-mode@1.0.169')

# Stubs are sh scripts (plus .cmd twins on Windows). They log their argv to $MARKER.
function Write-Stub([string]$Dir, [string]$Name, [string]$Body, [string]$Cmd = 'exit /b 0') {
  [System.IO.File]::WriteAllText((Join-Path $Dir $Name), "#!/bin/sh`n$Body`n")
  if ($isWindowsHost) { [System.IO.File]::WriteAllText((Join-Path $Dir ($Name + '.cmd')), "@echo off`r`n$Cmd`r`n") }
  else { & $chmod +x (Join-Path $Dir $Name) }
}
$piHonest = @'
if [ "$1" = "install" ]; then
  spec="$2"; rest="${spec#npm:}"; name="${rest%@*}"; ver="${rest##*@}"
  dir="${PI_CODING_AGENT_DIR:?}/npm/node_modules/$name"
  mkdir -p "$dir"
  printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "$dir/package.json"
fi
'@
# Honest npm: the shared-library realignment (Sync-CoopExtDeps) runs
# `npm install ... @earendil-works/pi-ai@V @earendil-works/pi-tui@V` in the tree
# and sync's postcondition (lib/_extdeps.py align --check) then reads those two
# package.json files back, so the stub materializes exactly them in its cwd.
$npmHonest = @'
if [ "$1" = "install" ]; then
  for a in "$@"; do
    case "$a" in
      @earendil-works/pi-ai@*|@earendil-works/pi-tui@*)
        name="${a%@*}"; ver="${a##*@}"; mkdir -p "node_modules/$name"
        printf '{"name":"%s","version":"%s"}
' "$name" "$ver" > "node_modules/$name/package.json" ;;
    esac
  done
fi

'@
$pipxHonest = @'
if [ "$1" = "install" ] || [ "$1" = "upgrade" ]; then
  for a in "$@"; do last="$a"; done
  name="${last%%==*}"; ver="${last#*==}"; [ "$ver" = "$last" ] && ver=9.9.9
  grep -v "package $name " "$PIPX_STATE" > "$PIPX_STATE.tmp" 2>/dev/null
  echo "package $name $ver" >> "$PIPX_STATE.tmp"; mv "$PIPX_STATE.tmp" "$PIPX_STATE"
fi
'@
# The Fabric venv python answers the pyodbc runtime probe (stdin program) and
# forwards everything else to the real interpreter.
$pyWrapper = @'
if [ "$1" = "-" ]; then
  prog="$(cat)"
  case "$prog" in
    *'pyodbc.drivers()'*)
      if [ "${COOP_TEST_DRIVER_MISSING:-0}" = 1 ]; then printf 'driver_missing\t5.3.0\n'; exit 5; fi
      printf 'ready\t5.3.0\t18\n'; exit 0 ;;
  esac
  printf '%s\n' "$prog" | exec "__REAL_PY__" "$@"
fi
exec "__REAL_PY__" "$@"
'@
# One fully isolated "machine": every location the fleet scripts can touch lives
# under it, plus the stub bin that models the tools present on it.
function New-Machine {
  param([string]$Name, [string]$PiVersion = '0.87.1', [bool]$HonestPi = $true, [string[]]$PipxList = @(), [string]$FabVersion = '1.6.1', [bool]$LogPi = $true)
  $d = Join-Path $t "m-$Name"
  $mHome = Join-Path $d 'home'
  $bin = Join-Path $mHome '.local\bin'
  $agent = Join-Path $d 'agent'
  $pipxHome = Join-Path $d 'pipx-home'
  foreach ($p in @($bin, $agent, $pipxHome, (Join-Path $d 'pipx-bin'), (Join-Path $d 'coop-dir'), (Join-Path $mHome 'AppData\Local\Microsoft\Windows\PowerShell'), (Join-Path $mHome 'AppData\Roaming'))) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
  }
  $marker = Join-Path $d 'calls'
  [System.IO.File]::WriteAllText($marker, '')
  $env:HOME = $mHome; $env:USERPROFILE = $mHome
  $env:LOCALAPPDATA = Join-Path $mHome 'AppData\Local'; $env:APPDATA = Join-Path $mHome 'AppData\Roaming'
  $env:COOP_DIR = Join-Path $d 'coop-dir'
  $env:PIPX_HOME = $pipxHome; $env:PIPX_BIN_DIR = Join-Path $d 'pipx-bin'
  $env:PI_CODING_AGENT_DIR = $agent; $env:COOP_AGENT_DIR = $agent
  $env:COOP_NO_ONBOARD = '1'
  $env:MARKER = $marker
  $env:COOP_TEST_STUB_PATH = $bin
  Remove-Item Env:\COOP_FABRIC_PYTHON, Env:\PIPX_FAIL_MATCH, Env:\COOP_TEST_DRIVER_MISSING -ErrorAction SilentlyContinue
  $piLog = if ($LogPi) { 'echo "PI $*" >> "$MARKER"' } else { ':' }
  $piBody = "[ `"`$1`" = `"--version`" ] && { echo 'pi $PiVersion'; exit 0; }`n$piLog`n" + $(if ($HonestPi) { $piHonest + "`n" } else { '' }) + "exit 0"
  Write-Stub $bin 'pi' $piBody "if `"%1`"==`"--version`" (echo pi $PiVersion& exit /b 0)`r`necho PI %*>>`"%MARKER%`"`r`nexit /b 0"
  Write-Stub $bin 'npm' ('[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }' + "`n" + '[ "$1" = "view" ] && { echo ''0.87.1''; exit 0; }' + "`n" + '[ "$1" = "--version" ] && { echo ''10.9.0''; exit 0; }' + "`n" + 'echo "NPM $*" >> "$MARKER"' + "`n" + $npmHonest + 'exit 0') ('if "%1 %2"=="prefix -g" (echo ' + $mHome + '\.local& exit /b 0)' + "`r`n" + 'if "%1"=="view" (echo 0.87.1& exit /b 0)' + "`r`n" + 'if "%1"=="--version" (echo 10.9.0& exit /b 0)' + "`r`n" + 'echo NPM %*>>"%MARKER%"' + "`r`n" + 'exit /b 0')
  # The pipx list lives in a state file: `install [--force] ... <pkg>[==<ver>]`
  # records the package at that version (an unpinned spec and `upgrade` land on
  # 9.9.9, "latest"), so a convergence can be verified by what pipx then reports.
  $pipxState = Join-Path $d 'pipx-list'
  [System.IO.File]::WriteAllText($pipxState, (($PipxList | ForEach-Object { "$_" }) -join "`n") + $(if ($PipxList.Count) { "`n" } else { '' }))
  $listCmd = (($PipxList | ForEach-Object { "echo $_" }) -join '& '); if (-not $listCmd) { $listCmd = 'rem' }
  Write-Stub $bin 'pipx' ('if [ "$1" = "list" ]; then cat "$PIPX_STATE"; exit 0; fi' + "`n" + 'case "$*" in *"${PIPX_FAIL_MATCH:-__never__}"*) exit 1 ;; esac' + "`n" + 'echo "PIPX $*" >> "$MARKER"' + "`n" + $pipxHonest + "`n" + 'exit 0') ('if "%1"=="list" (' + $listCmd + '& exit /b 0)' + "`r`n" + 'echo PIPX %*>>"%MARKER%"' + "`r`n" + 'exit /b 0')
  $env:PIPX_STATE = $pipxState
  Write-Stub $bin 'fab' "echo 'fab version $FabVersion'" "echo fab version $FabVersion"
  # Git and Azure CLI are install prerequisites (H1 gate); this machine has them.
  Write-Stub $bin 'az' 'echo azure-cli 2.80.0' 'echo azure-cli 2.80.0'
  Write-Stub $bin 'git' "exec `"$realGit`" `"`$@`"" "`"$realGit`" %*"
  Write-Stub $bin 'node' "exec `"$realNode`" `"`$@`"" "`"$realNode`" %*"
  $py = $pyWrapper.Replace('__REAL_PY__', $realPy)
  Write-Stub $bin 'python3' $py "`"$realPy`" %*"
  $venvBin = Join-Path $pipxHome 'venvs\ms-fabric-cli\bin'
  New-Item -ItemType Directory -Force -Path $venvBin | Out-Null
  Write-Stub $venvBin 'python' $py "`"$realPy`" %*"
  if ($isWindowsHost) {
    $env:PATH = $bin + $sep + $script:priorPath
  } else {
    # The stub bin first, then the system dirs the scripts need (sh, uname). The
    # stub bin is repeated at the END because install.ps1's PATH helpers prepend
    # with ';' (Windows separators): on a POSIX host that fuses the first entries
    # into one unusable segment, and the trailing copy keeps the stubs resolvable.
    $env:PATH = $bin + ':' + $psDir + ':/usr/bin:/bin:' + $bin
  }
  return [pscustomobject]@{ Dir = $d; Bin = $bin; Agent = $agent; Marker = $marker; Home = $mHome; PipxState = $pipxState }
}
# Rewrite what the stub pipx reports (a machine whose tool drifted after install).
function Set-PipxList([object]$M, [string[]]$Lines) { [System.IO.File]::WriteAllText($M.PipxState, ($Lines -join "`n") + "`n") }
function Get-Calls([object]$M) { return [System.IO.File]::ReadAllText($M.Marker) }
function Reset-Calls([object]$M) { [System.IO.File]::WriteAllText($M.Marker, '') }
function Test-Call([object]$M, [string]$Pattern) { return [bool]@((Get-Calls $M) -split "`r?`n" | Where-Object { $_ -match $Pattern }).Count }
function Test-CallLiteral([object]$M, [string]$Text) { return (Get-Calls $M).Contains($Text) }
# Run one fleet script from the tree copy; output as text, exit code in $script:rc.
function Invoke-Fleet([string]$Script, [string[]]$ScriptArgs = @()) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\$Script") @ScriptArgs 2>&1 | ForEach-Object { "$_" })
  $script:rc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  return ($lines -join "`n")
}

$saved = @{}
$names = @('PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COOP_DIR', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PI_CODING_AGENT_DIR', 'COOP_AGENT_DIR',
           'COOP_NO_ONBOARD', 'MARKER', 'COOP_TEST_STUB_PATH', 'COOP_FABRIC_PYTHON', 'PIPX_FAIL_MATCH', 'COOP_TEST_DRIVER_MISSING',
           'COOP_FLEET_TEST_MODE', 'COOP_PI_LATEST_OVERRIDE', 'COOP_PYPI_LATEST_OVERRIDE', 'COOP_RELEASE_MANIFEST', 'COOP_SKIP_AZ', 'NO_COLOR', 'PIPX_STATE')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$script:priorPath = $env:PATH
try {
  # A plain copy of the tree, no .git (dot entries other than the bundled .coop
  # contract are git, CI and cache files, not runtime).
  $root = Join-Path $t 'coop-agent'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  foreach ($e in (Get-ChildItem -LiteralPath $checkout -Force | Where-Object { -not $_.Name.StartsWith('.') -or $_.Name -eq '.coop' })) {
    Copy-Item -LiteralPath $e.FullName -Destination (Join-Path $root $e.Name) -Recurse -Force
  }
  $env:COOP_SKIP_AZ = '1'; $env:NO_COLOR = '1'
  $env:COOP_RELEASE_MANIFEST = Join-Path $root 'config\release-manifest.json'
  $env:COOP_PI_LATEST_OVERRIDE = '0.87.1'; $env:COOP_PYPI_LATEST_OVERRIDE = '0.1.0'

  # --- 1. install --force on a machine with pipx tools at older versions ----------
  $m = New-Machine 'install' -PipxList @('package coop-data-doc 1.1.0', 'package coop-sql-review 0.15.2', 'package coop-dax-review 0.22.0', 'package ms-fabric-cli 1.7.0')
  $env:COOP_FLEET_TEST_MODE = '1'
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -eq 0) { Ok 'install --force (fleet mode) exits 0' } else { Ko "install --force exited $rc" $out }
  if (Test-Call $m 'PIPX install --force --python .+ ms-fabric-cli==1\.7\.0') { Ok 'Fabric CLI install selects a supported bootstrap Python explicitly' } else { Ko 'Fabric CLI install did not select a supported bootstrap Python explicitly' (Get-Calls $m) }
  if (Test-CallLiteral $m 'PIPX install --force coop-data-doc==1.2.0') { Ok 'install --force reinstalls a pipx tool at its exact pin' } else { Ko 'install --force did not reinstall coop-data-doc at its pin' (Get-Calls $m) }
  # Extensions are the sync child's (one `pi install` path, S2): install runs none.
  if (Test-Call $m '^PI install ') { Ko 'install ran its own pi install; extensions converge once, in sync' (Get-Calls $m) } else { Ok 'install leaves the extensions to the sync child (no pi install of its own)' }
  if ((Test-CallLiteral $m 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force') -and (Test-CallLiteral $m 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ok 'install injects the exact fabric-cicd and pyodbc runtime pins' } else { Ko 'install did not inject the exact runtime pins' (Get-Calls $m) }

  # Driver auto-provisioning is Windows-only. A supported non-Windows install still
  # converges pyodbc and succeeds with one actionable warning.
  if (-not $isWindowsHost) {
    Reset-Calls $m
    $env:COOP_TEST_DRIVER_MISSING = '1'
    $out = Invoke-Fleet 'install.ps1' @('--force')
    Remove-Item Env:\COOP_TEST_DRIVER_MISSING -ErrorAction SilentlyContinue
    $warns = ([regex]::Matches($out, [regex]::Escape('ODBC Driver 18+ for SQL Server is missing'))).Count
    if ($rc -ne 0) { Ko 'non-Windows install failed solely because Driver 18 is absent' $out }
    elseif ($warns -ne 1) { Ko "non-Windows install emitted $warns Driver 18 warning(s), expected exactly one" $out }
    elseif (-not (Test-CallLiteral $m 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ko 'non-Windows missing-driver install did not converge pyodbc' (Get-Calls $m) }
    else { Ok 'non-Windows install succeeds with one warning when Driver 18 is absent' }
  }

  # An injected-library failure is a convergence failure, not a warning-only success.
  $env:PIPX_FAIL_MATCH = 'pyodbc==5.3.0'
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -ne 0) { Ok 'exact pyodbc pin is injected and injection failure is nonzero' } else { Ko 'failed pyodbc injection was converted into install success' $out }
  # Install, like update, keeps a visible convergence failure in its exit status
  # even though it continues through the remaining units for diagnostics.
  # (the match is the unit's argv prefix; the pinned spec follows it)
  $env:PIPX_FAIL_MATCH = 'install --force coop-data-doc'
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -ne 0) { Ok 'install exits non-zero when a convergence unit fails' } else { Ko 'failed pipx convergence was converted into install success' $out }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 2. update (fleet mode) on the same machine ---------------------------------
  Reset-Calls $m
  $out = Invoke-Fleet 'update.ps1'
  if ($rc -eq 0) { Ok 'normal pinned update exits 0' } else { Ko "normal pinned update failed unexpectedly (rc=$rc)" $out }
  if ($out.Contains('not a git checkout')) { Ok 'update runs from a copy of the tree, so step 1 never fetches or moves the checkout running the tests' } else { Ko 'update step 1 ran against a git checkout; the fixture must run a copy (#104)' $out }
  # Everything the --force install left is at its pin, so update is an offline
  # no-op for Pi and every pipx tool (the same probe-then-skip install uses).
  if (Test-Call $m '^PIPX (install|upgrade) ') { Ko 'update reinstalled a pipx tool already at its pin' (Get-Calls $m) } else { Ok 'update leaves pipx tools already at their pins alone (offline no-op)' }
  if (Test-Call $m '^NPM install -g @earendil-works/pi-coding-agent') { Ko 'update reinstalled a Pi already at the manifest version' (Get-Calls $m) } else { Ok 'update leaves a Pi already at the manifest version alone (offline no-op)' }
  if ((Test-CallLiteral $m 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force') -and (Test-CallLiteral $m 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ok 'update still converges the exact Fabric runtime pins' } else { Ko 'update did not converge the Fabric runtime pins' (Get-Calls $m) }
  if (Test-CallLiteral $m 'PI update --extensions') { Ko 'update ran the unpinned pi update --extensions' (Get-Calls $m) } else { Ok 'update never runs the unpinned pi update --extensions' }
  if (Test-Call $m '^PI (install|update) ') { Ko 'update ran its own pi install/update; extensions converge once, in sync' (Get-Calls $m) } else { Ok 'update leaves the extensions to the sync child (no pi install of its own)' }
  # Drift after the install: update converges the tool to its pin, and a visible
  # unit failure makes update non-zero even though execution reaches the
  # aggregate end (the old behaviour silently returned success via Doctor).
  Reset-Calls $m
  Set-PipxList $m @('package coop-data-doc 1.1.0', 'package coop-sql-review 0.15.2', 'package coop-dax-review 0.22.0', 'package ms-fabric-cli 1.7.0')
  $out = Invoke-Fleet 'update.ps1'
  if ($rc -eq 0 -and (Test-CallLiteral $m 'PIPX install --force coop-data-doc==1.2.0')) { Ok 'update converges a drifted pipx tool to its manifest pin' } else { Ko "update did not converge drifted coop-data-doc (rc=$rc)" (Get-Calls $m) }
  Set-PipxList $m @('package coop-data-doc 1.1.0', 'package coop-sql-review 0.15.2', 'package coop-dax-review 0.22.0', 'package ms-fabric-cli 1.7.0')
  $env:PIPX_FAIL_MATCH = 'coop-data-doc==1.2.0'
  $out = Invoke-Fleet 'update.ps1'
  if ($rc -ne 0) { Ok 'update exits non-zero when a convergence unit fails' } else { Ko 'failed pipx convergence was converted into update success' $out }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_FLEET_TEST_MODE -ErrorAction SilentlyContinue

  # --- 3. sync installs every manifest extension pin into the isolated tree ------
  # Force the production sync through its install path: repeat syncs intentionally
  # skip already-exact extensions without touching the network.
  Reset-Calls $m
  Remove-Item -LiteralPath (Join-Path $m.Agent 'npm\node_modules') -Recurse -Force -ErrorAction SilentlyContinue
  $out = Invoke-Fleet 'sync.ps1'
  if ($rc -eq 0) { Ok 'production sync exits 0' } else { Ko "production sync failed unexpectedly (rc=$rc)" $out }
  $missing = @($extSpecs | Where-Object { -not (Test-CallLiteral $m "PI install $_") })
  if ($missing.Count -eq 0) { Ok 'sync installs every manifest extension at its exact pin' } else { Ko "missing sync spec(s): $($missing -join ', ')" (Get-Calls $m) }
  foreach ($ext in @('pi-mcp-adapter', '@juicesharp/rpiv-ask-user-question')) {
    if (Test-Path -LiteralPath (Join-Path $m.Agent "npm\node_modules\$ext\package.json")) { Ok "sync materialized $ext in the isolated tree" } else { Ko "sync did not materialize $ext in the isolated tree" $out }
  }
  # A tree already at every pin needs no `pi install`: the repeat sync is offline.
  Reset-Calls $m
  $out = Invoke-Fleet 'sync.ps1'
  if ($rc -eq 0 -and -not (Test-Call $m '^PI install ')) { Ok 'a repeat sync skips extensions already at their pins (offline no-op)' } else { Ko "repeat sync reinstalled extensions or failed (rc=$rc)" ($out + "`n" + (Get-Calls $m)) }
  # The Fabric runtime convergence argv (normal + edge) through the shared helper.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $frOut = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $checkout 'tests\fixtures\fabric-runtime-convergence.test.ps1') 2>&1 | ForEach-Object { "$_" })
  $frRc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($frRc -eq 0) { $frOut | ForEach-Object { Write-Host $_ } } else { Ko 'fabric-runtime-convergence fixture failed' ($frOut -join "`n") }

  # --- 4. NORMAL-mode drift convergence (no --force): round-2 review item #1 -------
  # Deliberate drift: installed Pi 0.81.0 (manifest 0.87.1) and coop-data-doc 1.1.0
  # (manifest 1.2.0); ms-fabric-cli matches its pin.
  $m2 = New-Machine 'drift' -PiVersion '0.81.0' -HonestPi $false -PipxList @('package coop-data-doc 1.1.0', 'package coop-sql-review 0.15.2', 'package coop-dax-review 0.22.0', 'package ms-fabric-cli 1.7.0')
  $env:COOP_FLEET_TEST_MODE = '1'
  $out = Invoke-Fleet 'install.ps1'
  if (-not (Test-CallLiteral $m2 'NPM install -g @earendil-works/pi-coding-agent@0.87.1')) { Ko 'drifted Pi NOT converged to manifest' (Get-Calls $m2) }
  else { Ok 'normal install converges a drifted Pi to the manifest without --force' }
  if (-not (Test-CallLiteral $m2 'PIPX install --force coop-data-doc')) { Ko 'drifted coop-data-doc NOT force-installed' (Get-Calls $m2) }
  elseif (-not (Test-CallLiteral $m2 'PIPX install --force coop-data-doc==1.2.0')) { Ko 'drifted coop-data-doc NOT force-installed to its manifest pin' (Get-Calls $m2) }
  else { Ok 'normal install converges a drifted pipx tool to its manifest pin without --force' }
  if (Test-Call $m2 'PIPX install .*ms-fabric-cli==') { Ko 'matching fabric-cli was reinstalled despite matching pin' (Get-Calls $m2) }
  else { Ok 'normal install leaves a pipx tool that already matches its pin alone' }

  # --- 5. --edge on an EXISTING machine attempts upstream latest -------------------
  $m4 = New-Machine 'edge' -HonestPi $false -PipxList @('package coop-data-doc 1.2.0', 'package ms-fabric-cli 1.7.0')
  $out = Invoke-Fleet 'install.ps1' @('--edge')
  if (-not (Test-CallLiteral $m4 'NPM install -g @earendil-works/pi-coding-agent')) { Ko 'edge install did not attempt a Pi upstream update' (Get-Calls $m4) }
  else { Ok 'install --edge attempts a Pi upstream update' }
  if (-not (Test-CallLiteral $m4 'PIPX upgrade coop-data-doc')) { Ko 'edge install did not attempt a pipx upgrade for an existing tool' (Get-Calls $m4) }
  else { Ok 'install --edge attempts a pipx upgrade for an existing tool' }
  # --edge is a Pi and tools channel: the extensions stay pinned (sync has no
  # --edge), so install issues no `pi install` of its own here either.
  if (Test-Call $m4 '^PI install ') { Ko 'edge install ran its own pi install (extensions are the pinned sync child''s)' (Get-Calls $m4) }
  elseif (-not (Test-Call $m4 'PIPX install --force --python .+ ms-fabric-cli$')) { Ko 'edge install did not reinstall the Fabric CLI unpinned' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli fabric-cicd --force')) { Ko 'edge install did not refresh unpinned fabric-cicd' ($out + "`n" + (Get-Calls $m4)) }
  elseif (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force') { Ko 'edge install incorrectly pinned fabric-cicd' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ko 'edge install did not preserve the exact pyodbc runtime contract' (Get-Calls $m4) }
  else { Ok 'install --edge takes upstream latest for the Fabric CLI and fabric-cicd, keeps the extensions pinned' }

  # --- 6. Fabric failed convergence must NOT read as success -------------------------
  # pipx refuses the --force install of ms-fabric-cli==pin while an OLD fab binary
  # stays on PATH: the unit must fail, not report "ready".
  $m5 = New-Machine 'fabric-fail' -HonestPi $false -PipxList @('package coop-data-doc 1.2.0', 'package ms-fabric-cli 1.5.0') -FabVersion '1.5.0'
  $env:PIPX_FAIL_MATCH = 'ms-fabric-cli==1.7.0'
  $out = Invoke-Fleet 'install.ps1'
  if ($rc -eq 0) { Ko 'failed Fabric convergence returned install success' $out }
  elseif ($out.Contains('Microsoft Fabric CLI ready')) { Ko 'fabric reported ready after FAILED convergence' $out }
  elseif (-not ($out.Contains('failed to converge ms-fabric-cli') -or $out.Contains('remains at'))) { Ko 'unexpected fabric outcome: no converge-failure message' $out }
  else { Ok 'failed Fabric convergence is reported as failure, not ready' }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 7. NORMAL-mode skip when everything already matches --------------------------
  $m3 = New-Machine 'match' -HonestPi $false -PipxList @('package coop-data-doc 1.2.0', 'package ms-fabric-cli 1.7.0')
  $out = Invoke-Fleet 'install.ps1'
  if (Test-Call $m3 '^NPM install -g @earendil-works/pi-coding-agent@') { Ko 'Pi was reinstalled although it matched the manifest' (Get-Calls $m3) }
  elseif (Test-CallLiteral $m3 'PIPX install --force coop-data-doc==') { Ko 'coop-data-doc was reinstalled although it matched the manifest' (Get-Calls $m3) }
  else { Ok 'normal install skips components already at their manifest pins' }

  # --- 8. UPDATE repairs an incomplete workstation instead of only diagnosing it ----
  $m6 = New-Machine 'repair' -HonestPi $false -PipxList @() -LogPi $false
  $out = Invoke-Fleet 'update.ps1'
  $missing = @(@('coop-data-doc==1.2.0', 'coop-sql-review==0.15.2', 'coop-dax-review==0.22.0', 'ms-fabric-cli==1.7.0') | Where-Object { -not (Test-CallLiteral $m6 $_) })
  if ($missing.Count -eq 0) { Ok 'update installs missing manifest-pinned pipx tools' } else { Ko "update did not install missing $($missing -join ', ')" (Get-Calls $m6) }
  if (Test-Call $m6 '^PIPX install --python .+ ms-fabric-cli==1\.7\.0') { Ok 'update installs a missing Fabric CLI with an explicit supported bootstrap Python' } else { Ko 'update did not select a supported bootstrap Python for the missing Fabric CLI' (Get-Calls $m6) }
  if (Test-Call $m6 '^PIPX install --force ') { Ko 'update force-reinstalled a tool that was simply missing' (Get-Calls $m6) } else { Ok 'a missing tool is installed, not force-reinstalled' }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  normal install/update/sync executed exact manifest specs' } else { Write-Host "  $G_CROSS fleet-execution tests FAILED" }
exit $fail
