#!/usr/bin/env pwsh
#
# coop doctor —
# verify the Cooptimize agent's dependencies and configuration.
# Exit 0 when all REQUIRED dependencies are present (warnings are non-fatal);
# exit 1 when something required is missing.
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 ---------------------------------
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, Test-Have,
# Get-CoopPython, Get-CoopPiVersion, Get-CoopYamlValue, Find-CoopProjectYml, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# --- doctor body -------------------------------------------------------------
# Check coop's ISOLATED Pi agent dir, not the user's personal ~/.pi/agent.
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir

$script:FAIL = 0   # required missing -> non-zero exit
$script:WARN = 0
$script:Shadowed = @()   # exes the manifest section found shadowed by a non-pipx copy
$script:FIX  = $false   # --fix: auto-apply safe remediations at the end
$script:JSON = $false   # --json: one machine-readable document on stdout (fleet health digests)
$script:PUBLISH = $false
foreach ($a in $args) {
  if ($a -eq '--fix') { $script:FIX = $true }
  elseif ($a -eq '--json') { $script:JSON = $true }
  elseif ($a -eq '--publish') { $script:PUBLISH = $true; $script:JSON = $true }
  elseif ($a -eq '-h' -or $a -eq '--help') {
    Coop-Say 'Usage: coop doctor [--fix] [--json] [--publish]'
    Coop-Say '  --fix      apply safe remediations (sync extensions/MCP/assets, install missing Coop tools), then re-check'
    Coop-Say '  --json     suppress the human report and emit one JSON document on stdout: {"checks":[{name,section,status,hint}...],"fail":N,"warn":N}'
    Coop-Say '  --publish  augment the --json payload with machine identity (hostname/user/versions/timestamp) and write to fleet.publish_dir (from ~/.coop/config or defaults.yml) instead of stdout'
    exit 0
  }
}

# --json plumbing: EVERY check funnels through D-Ok/D-Warn/
# D-Bad (and every header through D-Head), so machine-readable output is a
# choke-point change. Records collect in $script:JsonChecks; the summary at the
# bottom emits the document via ConvertTo-Json.
$script:Section = ''
$script:JsonChecks = @()
function D-Rec {
  param([string]$Status, [string]$Name, [string]$Hint = '')
  if ($script:JSON) {
    $script:JsonChecks += [ordered]@{ name = $Name; section = $script:Section; status = $Status; hint = $Hint }
  }
}
function D-Ok   { param([string]$m) D-Rec 'ok' $m; if (-not $script:JSON) { Coop-Ok $m } }
function D-Warn { param([string]$m, [string]$hint = '') D-Rec 'warn' $m $hint; if (-not $script:JSON) { Coop-Warn ($m + $(if ($hint) { " — $hint" } else { '' })) }; $script:WARN++ }
function D-Bad  { param([string]$m, [string]$hint = '') D-Rec 'fail' $m $hint; if (-not $script:JSON) { Coop-Err ($m + $(if ($hint) { " — $hint" } else { '' })) }; $script:FAIL++ }
function D-Head { param([string]$m) $script:Section = $m; if (-not $script:JSON) { Coop-Head $m } }

# Check <cmd> <required|optional> <fix-hint> [version-cmd]
function Check {
  param([string]$Bin, [string]$Need, [string]$Hint, [string[]]$VCmd = @())
  if (Test-Have $Bin) {
    $ver = ''
    if ($VCmd.Count -gt 0) {
      $vArgs = if ($VCmd.Count -gt 1) { @($VCmd[1..($VCmd.Count-1)]) } else { @() }
      $vout = (& $VCmd[0] @vArgs 2>$null | Select-Object -First 1)
      # Show only a version-looking token, so a stray REPL banner (node ->
      # "Welcome to Node.js v24..."), an "Unknown command: -" error, or a version-
      # manager wrapper's noise never gets printed as the "version".
      if ($vout) {
        $m = [regex]::Match([string]$vout, '\d+\.\d+(\.\d+)?')
        if ($m.Success) { $ver = $m.Value }
      }
    }
    D-Ok ("$Bin" + $(if ($ver) { "  ($ver)" } else { '' }))
  } else {
    if ($Need -eq 'required') { D-Bad "$Bin missing" $Hint } else { D-Warn "$Bin missing" $Hint }
  }
}

D-Head "coop doctor — Cooptimize agent v$($script:CoopVersion)"

# Prerequisites: the SAME ordered table and text `coop install` prints and stops
# on (Get-CoopPrereqs in lib/common.ps1), so install and doctor never disagree.
D-Head 'Prerequisites'
foreach ($r in (Get-CoopPrereqs)) {
  $line = "$($r.Order). $($r.Name)" + $(if ($r.Detail) { "  ($($r.Detail))" } else { '' })
  if ($r.Ok) { D-Ok $line } elseif ($r.Required) { D-Bad $line $r.Fix } else { D-Warn $line $r.Fix }
}

D-Head 'Core'
Check 'pi'      'required' 'coop install   (installs the release''s tested Pi)' @('pi','--version')
Check 'npm'     'optional' 'ships with Node.js' @('npm','--version')
# Get-CoopPython skips a Windows Store App-Execution-Alias stub; later checks
# (project health, --fix) run through this interpreter.
$pyBin = Get-CoopPython

# Minimum Pi version — the extension API used by coop-powerline / coop-tools.
if (Test-Have 'pi') {
  $piProbe = Get-CoopPiVersion
  if ($piProbe) {
    $piv = [version]$piProbe
    # Floor: config/defaults.yml tested_with.pi_min (the extension API coop relies on);
    # 0.79.0 only if that key is missing.
    $piMin = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') 'tested_with.pi_min' '0.79.0'
    if ($piMin -notmatch '^\d+\.\d+(\.\d+)?$') { $piMin = '0.79.0' }
    if ($piv -lt [version]$piMin) { D-Warn "pi $piv is older than the tested minimum ($piMin)" 'coop update' }
    # Ceiling: warn (never fail) when the installed Pi is a newer MINOR than the
    # manifest's Pi (what `coop update` pins to); doctor just flags the drift.
    $testedPi = Coop-ManifestGet -Key 'pi.version'
    if ($testedPi -match '(\d+)\.(\d+)') {
      $testedMinor = [version]("{0}.{1}" -f $matches[1], $matches[2])
      $piMinor = [version]("{0}.{1}" -f $piv.Major, $piv.Minor)
      if ($piMinor -gt $testedMinor) { D-Warn "pi $piv is newer than coop's tested version ($testedPi)" "if extensions misbehave, pin back: npm i -g @earendil-works/pi-coding-agent@$testedPi" }
    }
  }
}

# Release manifest: the single source of truth for the exact versions that ship
# together with this coop build. Doctor reports drift so a teammate can pin back
# with `coop update`; maintainers take head of main + latest with `coop update --edge`.
D-Head 'Release manifest'
$piExpected = Coop-ManifestGet 'pi.version'
if ($piExpected) {
  if (Test-Have 'pi') {
    $piv = Get-CoopPiVersion
    $piStatus = Coop-ManifestStatus $piv $piExpected
    switch ($piStatus) {
      'ok'                { D-Ok "pi $piv matches manifest ($piExpected)" }
      'missing'           { D-Warn 'pi version unknown' 'coop update' }
      'older'             { D-Warn "pi $piv is older than manifest ($piExpected)" 'coop update' }
      'newer-than-tested' { D-Warn "pi $piv is newer than manifest ($piExpected)" 'pin back: coop update   (maintainers: coop update --edge)' }
      'wrong-version'     { D-Warn "pi $piv differs from manifest ($piExpected)" 'coop update' }
    }
  } else {
    D-Warn 'pi not installed' 'coop install'
  }
}

# Truthful inventory per distribution. The in-venv metadata is authoritative;
# the CLI-reported version cross-checks it; `pipx list` is never trusted. Each
# distribution maps to its real executable — ms-fabric-cli installs `fab`.
function Check-PipxDist([string]$Dist, [string]$Exe) {
  $expected = Coop-ManifestGet "python_tools.$Dist"
  if (-not $expected) { return }
  $repair = "pipx install --force $Dist==$expected"
  $meta = Get-CoopVenvDistVersion $Dist $Dist
  if (Test-Have $Exe) {
    $vOut = (& $Exe --version 2>$null | Out-String)
    $cli = ''
    if ($vOut -match '\d+\.\d+(\.\d+)?') { $cli = $matches[0] }
  } else { $cli = '' }
  # Python interpreter INSIDE this tool's venv — not the system default python.
  $pyver = (Get-CoopVenvPythonVersion $Dist)

  if (-not $meta -and -not $cli) {
    D-Warn "$Dist not installed (manifest: $expected)" "pipx install $Dist==$expected"
    return
  }
  # Executable ownership FIRST: a foreign $Exe earlier on PATH (a `pip install`
  # copy, another tool manager, a leftover shim) must never be correlated with
  # this distribution's pipx metadata — reading it as "stale/corrupt" sends the
  # user to `pipx install --force`, which rebuilds a venv that was never wrong.
  if ($cli -and ((Get-CoopExePipxVenv $Exe) -ne $Dist)) {
    $resolved = ''
    $rc = Get-Command $Exe -ErrorAction SilentlyContinue
    if ($rc) { $resolved = " ($($rc.Source))" }
    $script:Shadowed += $Exe
    if ($meta) {
      $hint = "remove that copy (pip uninstall $Dist / uv tool uninstall $Dist) or put pipx's bin dir first on PATH (pipx ensurepath), then open a new terminal; last resort: $repair"
      D-Warn "$Dist skipped: $Exe on PATH$resolved is not the pipx one (it reports $cli; pipx metadata says $meta)" $hint
    } else {
      $hint = "pipx install $Dist==$expected, then remove that copy (pip uninstall $Dist / uv tool uninstall $Dist) or put pipx's bin dir first on PATH (pipx ensurepath), and open a new terminal"
      D-Warn "$Dist skipped: $Exe on PATH$resolved is not the pipx one (it reports $cli; pipx has no $Dist installed)" $hint
    }
    return
  }
  if ($meta -and $cli -and ($meta -ne $cli)) {
    # One call per line: PowerShell has no backslash continuation, so a trailing \
    # became the hint and the real hint printed to stdout on its own (#90).
    $hint = "$repair   (metadata/CLI disagreement; recreate the environment)"
    D-Bad "$Dist pipx environment is stale/corrupt: metadata says $meta but $Exe reports $(if ($cli) { $cli } else { 'nothing' })" $hint
    return
  }
  if (-not $cli) {
    # Stop here: without a CLI answer there is nothing trustworthy to compare.
    # Say WHICH way it failed: nothing on PATH, or a launcher that prints nothing.
    $rc = Get-Command $Exe -ErrorAction SilentlyContinue
    if ($rc) {
      # Quote the launcher's first output line (stderr included) so the row
      # shows what it said instead of sending the user to run it by hand.
      # Windows PowerShell 5.1 turns each native stderr line into an ErrorRecord
      # whose rendering is prefixed with the command name and position; take the
      # record's own message so the row quotes the launcher's line verbatim.
      $probe = ''
      try {
        $pLines = @(& $Exe --version 2>&1 | ForEach-Object {
          if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
        })
        $pLine = @($pLines | ForEach-Object { ($_ -split "`r?`n") } | Where-Object { $_.Trim() }) | Select-Object -First 1
        if ($pLine) { $probe = ([string]$pLine).Trim(); if ($probe.Length -gt 120) { $probe = $probe.Substring(0, 120) } }
      } catch {}
      $said = if ($probe) { "; it printed: $probe" } else { '' }
      $hint = "a broken leftover launcher: delete it, then pipx reinstall $Dist, and open a new terminal"
      D-Warn "${Dist}: $Exe at $($rc.Source) runs but prints no version (pipx metadata says $meta)$said" $hint
    } else {
      $hint = "put pipx's bin dir on PATH: pipx ensurepath, then open a new terminal; if the launcher is missing there: pipx reinstall $Dist"
      D-Warn "$Dist is not on PATH (pipx has $meta installed)" $hint
    }
    return
  }
  if (-not $meta) {
    # Metadata unreadable (missing/broken/shadowed pipx): classify by the CLI's
    # own report, but say so — the two sources are supposed to agree.
    $status = Coop-ManifestStatus $cli $expected
    switch ($status) {
      'ok' { D-Ok "$Dist $cli matches manifest ($expected) (CLI-reported; pipx metadata unreadable)" }
      default { D-Warn "$Dist $cli differs from manifest per $Exe (pipx metadata unreadable)" "$repair   (also check that pipx itself works)" }
    }
  } else {
    $status = Coop-ManifestStatus $meta $expected
    switch ($status) {
      'ok'                { D-Ok "$Dist $meta matches manifest ($expected)" }
      'missing'           { D-Warn "$Dist not installed or version unknown (manifest: $expected)" "pipx install $Dist==$expected" }
      'older'             { D-Warn "$Dist $meta is older than manifest ($expected)" "pipx install $Dist==$expected" }
      'newer-than-tested' { D-Warn "$Dist $meta is newer than manifest ($expected)" "pipx install $Dist==$expected" }
      'wrong-version'     { D-Warn "$Dist $meta differs from manifest ($expected)" "pipx install $Dist==$expected" }
    }
  }
  if (-not $pyver) {
    D-Warn "$Dist environment Python could not be determined" "$repair --python 3.12"
    return
  }
  # Judge support by the distribution's own installed Requires-Python metadata.
  $rp = Get-CoopVenvRequiresPython $Dist $Dist
  if (-not $rp) {
    D-Ok "$Dist environment uses Python $pyver (no Requires-Python metadata found)"
    return
  }
  if (Test-CoopPythonSpec $pyver $rp) {
    D-Ok "$Dist environment uses Python $pyver (requires-python: $rp)"
  } else {
    # Only the Fabric CLI env carries the injected fabric-cicd library.
    $cicdPin = if ($Dist -eq 'ms-fabric-cli') { Coop-ManifestGet 'python_tools.fabric-cicd' } else { '' }
    $hint = "$repair --python 3.12   (or --python 3.13)$(if ($cicdPin) { ", then: pipx inject $Dist fabric-cicd==$cicdPin   (or: coop doctor --fix)" })"
    D-Warn "$Dist environment uses Python $pyver — violates its own requires-python '$rp'" $hint
  }
}
Check-PipxDist 'coop-data-doc' 'coop-data-doc'
Check-PipxDist 'ms-fabric-cli' 'fab'

# Retired standalone reviewers (ST1): an install from v0.24.0 or older still has
# them in pipx, and nothing in coop uses or updates them any more.
foreach ($retired in @('coop-sql-review', 'coop-dax-review')) {
  $rv = Get-CoopVenvDistVersion $retired $retired
  if ($rv) { D-Warn "$retired $rv is retired (coop no longer uses it)" "pipx uninstall $retired" }
}

# Power BI / Fabric authoring npm tools against their pins, with the probe
# update --check uses. A missing tool is reported by its own row further down.
foreach ($pkg in (Coop-ManifestKeys 'npm_tools')) {
  if ($pkg -eq '@microsoft/powerbi-desktop-bridge-cli' -and $env:OS -ne 'Windows_NT') { continue }
  $exp = Coop-ManifestGet -Key "npm_tools.$pkg"
  $cur = Get-CoopNpmToolVersion $pkg
  if (-not $exp -or -not $cur) { continue }
  switch (Coop-ManifestStatus -Installed $cur -Expected $exp) {
    'ok'                { D-Ok "$pkg $cur matches manifest ($exp)" }
    'newer-than-tested' { D-Warn "$pkg $cur is newer than manifest ($exp)" "coop update   (or: npm install -g $pkg@$exp)" }
    default             { D-Warn "$pkg $cur differs from manifest ($exp)" "coop update   (or: npm install -g $pkg@$exp)" }
  }
}

# The Node minimum (manifest node.min) is prerequisite row 2 above.

# Lingering deprecated Pi package — coop migrated to @earendil-works (Out-String so
# npm ls's exit code on an invalid tree doesn't matter).
if (Test-Have 'npm') {
  $globals = (& npm ls -g --depth=0 2>$null | Out-String)
  if ($globals -match '@mariozechner/pi-coding-agent') {
    D-Warn 'deprecated Pi package still installed globally (@mariozechner/pi-coding-agent; Pi is now @earendil-works)' 'remove if unused: npm uninstall -g @mariozechner/pi-coding-agent  (skip if an extension still depends on it)'
  }
}

# First-run login: coop shares Pi auth in from ~/.pi/agent. A brand-new teammate has none.
# Only a stored provider credential counts: Pi writes `{}` on startup (#167).
if (Test-Have 'pi') {
  $authA = Join-Path (Get-CoopPiAgentDir) 'auth.json'
  $authB = Join-Path (Get-CoopPersonalPiAgentDir) 'auth.json'
  if ((Test-CoopAuthHasCredential $authA) -or (Test-CoopAuthHasCredential $authB)) {
    D-Ok 'Pi login present'
  } else {
    D-Warn 'no Pi login found yet' "your first 'coop' run will prompt you to sign in — see docs/onboarding.md §3.5 (OpenAI/Codex provider, Cooptimize BUSINESS account)"
  }
}

# The client tenant, resolved once through the one predicate (Get-CoopTenant:
# Rc 0 resolved, 1 none, 2 not a GUID or domain name). The Azure sign-in row, the
# Warehouse MCP row and the project contract row all read this result; no row
# re-validates a tenant with its own regex.
$azTenant = Get-CoopTenant

# Azure sign-in for the client tenant (H2). Probe only: doctor never signs in and
# never touches the launch cache (.az-ok). Same tenant chain and token check as
# the launch (Get-CoopTenant / Get-CoopAzTokenRc) and the same hint pair
# (Get-CoopAzLoginHint / Get-CoopAzTokenHint). A missing az is prerequisite row 5.
if ($env:COOP_SKIP_AZ -ne '1' -and (Test-Have 'az')) {
  if ($azTenant.Rc -eq 2) {
    D-Warn 'Azure sign-in: tenant id is not a GUID or domain name' 'fix fabric.tenant_id in .coop/project.yml or run: coop onboard --config-only'
  } elseif (-not $azTenant.Tenant) {
    D-Warn 'Azure sign-in: no client tenant configured' 'run: coop onboard --config-only'
  } else {
    $azT = $azTenant.Tenant
    $azRc = Get-CoopAzTokenRc -Tenant $azT
    if ($azRc -eq 0) { D-Ok "Azure sign-in: signed in to tenant $azT" }
    elseif ($azRc -eq 124) { D-Warn "Azure sign-in: check timed out for tenant $azT" (Get-CoopAzTokenHint $azT) }
    elseif ($azRc -eq 1) { D-Warn "Azure sign-in: not signed in to tenant $azT" (Get-CoopAzLoginHint $azT) }
    else { D-Warn "Azure sign-in: token check failed for tenant $azT (not an auth error)" (Get-CoopAzTokenHint $azT) }
  }
}

D-Head 'Microsoft Fabric CLI'
# An Azure SQL-only client (client.platform in ~/.coop/config, master plan section
# 8 item 7) does not need the Fabric CLI: a missing fab is reported, never red.
if (-not (Test-Have 'fab') -and (Test-CoopAzureSqlOnly)) {
  D-Ok 'fab not installed (Azure SQL client; the Fabric CLI is optional here)'
} elseif (Test-Have 'fab') {
  $fabver = ((& fab --version 2>&1 | Select-Object -First 3) -join ' ')
  if ($fabver -match '(?i)paramiko|invoke') {
    D-Bad 'fab is the WRONG tool' "this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI"
    if (-not $script:JSON) {
      Coop-Say "      Fix: pipx install $(Coop-ManifestPythonSpec 'ms-fabric-cli')   and put pipx's bin dir first on PATH (pipx ensurepath)"
      Coop-Say '           or uninstall the Python fabric package. Verify with: fab --version'
    }
  } else {
    $fv = (& fab --version 2>$null | Select-Object -First 1)
    D-Ok "fab — Microsoft Fabric CLI  ($fv)"
  }
} else {
  D-Bad 'fab missing' "coop install   (or: pipx install $(Coop-ManifestPythonSpec 'ms-fabric-cli'))"
}

D-Head 'Standalone Coop tools (pipx)'
# A tool the manifest section found shadowed by a non-pipx copy never gets a
# green tick here: the copy that answered is not the one coop pinned.
function Check-PipxTool([string]$Bin) {
  if ($script:Shadowed -contains $Bin) {
    D-Warn "$Bin on PATH is not the pipx copy (see Release manifest above)" "the fix is on that row: remove the stray copy or put pipx's bin dir first on PATH"
  } else {
    Check $Bin 'required' "pipx install $Bin" @($Bin,'--version')
  }
}
Check-PipxTool 'coop-data-doc'

D-Head 'Fabric / semantic-model tooling'

# Power BI / Fabric authoring npm tools. powerbi-report-author backs coop's own
# power-bi-* skills AND the skills-for-fabric skills, so it is required; the rest
# stay optional. powerbi-desktop-bridge is only useful on Windows with Desktop.
# Hints name the manifest pin (Coop-ManifestNpmToolSpec), never npm's latest.
function Get-NpmToolHint([string]$Package) { $s = Coop-ManifestNpmToolSpec $Package; if (-not $s) { $s = $Package }; return "npm install -g $s" }
Check 'powerbi-report-author' 'required' (Get-NpmToolHint '@microsoft/powerbi-report-authoring-cli') @('powerbi-report-author', '--version')
if ($env:OS -eq 'Windows_NT') {
  Check 'powerbi-desktop' 'optional' "$(Get-NpmToolHint '@microsoft/powerbi-desktop-bridge-cli') (Windows + Power BI Desktop only)" @('powerbi-desktop', '--version')
} else {
  D-Ok 'powerbi-desktop (Desktop Bridge) — Windows only, not applicable here'
}
# powerbi-modeling-mcp is started via npx; verify the package is installed
# globally, with the same probe update --check uses (Get-CoopNpmToolVersion).
$pbihModelingVer = Get-CoopNpmToolVersion '@microsoft/powerbi-modeling-mcp'
if ($pbihModelingVer) { D-Ok "powerbi-modeling-mcp $pbihModelingVer (npm package installed)" }
else { D-Warn 'powerbi-modeling-mcp not installed' (Get-NpmToolHint '@microsoft/powerbi-modeling-mcp') }

# fabric-cicd is a Python LIBRARY (no CLI) living inside the Fabric CLI's env;
# it is manifest-pinned like any other tool, just verified differently.
if (Test-Have 'fab') {
  $cicdExpected = Coop-ManifestGet 'python_tools.fabric-cicd'
  $cicdMeta = Get-CoopVenvDistVersion 'ms-fabric-cli' 'fabric-cicd'
  $hasCicd = [bool]$cicdMeta
  if (-not $hasCicd) {
    # Metadata unavailable: fall back to importing with a venv interpreter found
    # next to the shim or under common pipx homes.
    $venvCandidates = @()
    foreach ($pipxHome in @($env:PIPX_HOME, (Join-Path $HOME 'pipx'), (Join-Path $HOME '.local\pipx'), (Join-Path $env:LOCALAPPDATA 'pipx\pipx'))) {
      if ($pipxHome) {
        $venvCandidates += (Join-Path $pipxHome 'venvs\ms-fabric-cli\Scripts\python.exe')
        $venvCandidates += (Join-Path $pipxHome 'venvs\ms-fabric-cli\bin\python')
      }
    }
    $fabCmd = (Get-Command fab -ErrorAction SilentlyContinue)
    if ($fabCmd) {
      $shimDir = Split-Path -Parent $fabCmd.Source
      $venvCandidates += (Join-Path $shimDir 'python.exe')
      $venvCandidates += (Join-Path $shimDir 'python')
    }
    foreach ($py in $venvCandidates) {
      if ($py -and (Test-Path -LiteralPath $py)) {
        & $py -c 'import fabric_cicd' *> $null
        if ($LASTEXITCODE -eq 0) { $hasCicd = $true; break }
      }
    }
  }
  if ($hasCicd) {
    if ($cicdExpected -and $cicdMeta -and ($cicdMeta -ne $cicdExpected)) {
      D-Warn "fabric-cicd $cicdMeta differs from manifest ($cicdExpected)" "pipx inject ms-fabric-cli fabric-cicd==$cicdExpected"
    } else {
      $label = if ($cicdMeta) { "fabric-cicd $cicdMeta" } else { 'fabric-cicd' }
      D-Ok "$label (library, in the Fabric CLI env)"
    }
  } else {
    $pinSuffix = if ($cicdExpected) { "==$cicdExpected" } else { '' }
    D-Warn 'fabric-cicd not installed' "pipx inject ms-fabric-cli fabric-cicd$pinSuffix"
  }
} else {
  D-Warn 'fabric-cicd: install the Microsoft Fabric CLI first' 'coop install'
}

$sqlRuntime = Get-CoopFabricSqlRuntimeStatus
switch ($sqlRuntime.state) {
  'ready'            { D-Ok "Fabric SQL fallback ready (pyodbc $($sqlRuntime.version), ODBC Driver $($sqlRuntime.driver))" }
  'pyodbc_missing'   { D-Bad 'Fabric SQL fallback: pyodbc missing from selected runtime' 'coop sync' }
  'pyodbc_wrong'     { D-Bad "Fabric SQL fallback: pyodbc $($sqlRuntime.version) differs from manifest ($(Coop-ManifestGet 'python_tools.pyodbc'))" 'coop sync' }
  'pyodbc_unloadable'{ D-Bad 'Fabric SQL fallback: pyodbc is installed but unloadable' 'coop sync; repair the ms-fabric-cli environment if it persists' }
  'driver_missing'   { D-Bad 'Fabric SQL fallback: ODBC Driver 18+ for SQL Server is missing' 'coop install --yes, or install Microsoft.msodbcsql.18 manually' }
  default            { D-Bad 'Fabric SQL fallback: selected Fabric Python runtime is unavailable' 'coop install' }
}

# Tabular Editor CLI is path-configured and mostly Windows; check the project's path if set.
$projYml = Find-CoopProjectYml
if (-not (Test-CoopToolEnabled $projYml 'tabular_editor_cli')) {
  D-Ok 'Tabular Editor CLI disabled in project.yml'
} else {
  $tePath = Get-CoopYamlValue $projYml 'tools.tabular_editor_cli.executable_path' ''
  $teRules = Get-CoopYamlValue $projYml 'tools.tabular_editor_cli.bpa_rules_path' ''
  if (-not $tePath) {
    if (Test-Have 'te') {
      $tev = (& te --version 2>$null | Select-Object -First 1)
      D-Ok "te — Tabular Editor CLI ($tev)"
    } else {
      $foundTe = $null
      foreach ($d in (@(
        (Join-Path $HOME '.local\bin\te.exe'),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\te\te.exe' })
      ) | Where-Object { $_ })) {
        if (Test-Path -LiteralPath $d) { $foundTe = $d; break }
      }
      if ($foundTe) { D-Ok "Tabular Editor CLI: $foundTe" }
      else { D-Warn 'Tabular Editor CLI (te) not found (optional)' "download 'te' from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli (requires a Tabular Editor account during the preview), place in ~/.local/bin or on PATH, then run: te auth login" }
    }
  } elseif ($tePath -like 'TODO*') {
    D-Warn 'Tabular Editor CLI executable_path not configured' 'set tools.tabular_editor_cli.executable_path in .coop/project.yml'
  } else {
    if (Test-Path -LiteralPath $tePath) { D-Ok "Tabular Editor CLI: $tePath" }
    else { D-Warn "Tabular Editor CLI path not found: $tePath" }
  }
  if (-not $teRules -or $teRules -like 'TODO*') {
    D-Warn 'Tabular Editor BPA rules not configured' 'set tools.tabular_editor_cli.bpa_rules_path in .coop/project.yml (optional)'
  } else {
    $resolvedRules = if ($projYml) { Join-Path (Split-Path -Parent (Split-Path -Parent $projYml)) $teRules } else { $null }
    if (($resolvedRules -and (Test-Path -LiteralPath $resolvedRules)) -or (Test-Path -LiteralPath $teRules)) { D-Ok "Tabular Editor BPA Rules: $teRules" }
    else { D-Warn "Tabular Editor BPA rules not found: $teRules" }
  }
}

D-Head 'Pi extensions'
if (Test-Have 'pi') {
  $pilist = (& pi list 2>$null | Out-String)
  # Every MANAGED extension is checked against its exact release-manifest pin —
  # presence alone let a drifted fleet read as healthy.
  foreach ($name in (Coop-ManifestKeys 'extensions')) {
    $exp = Coop-ManifestGet -Key "extensions.$name"
    if ($pilist -notmatch [regex]::Escape($name)) {
      D-Warn "$name not installed" 'coop sync   (installs the pinned extension fleet)'
      continue
    }
    if (-not $exp) { D-Ok "$name installed (no manifest pin)"; continue }
    # Count only real package specs: the install path beneath each spec also
    # contains the extension name (and often a version), so matching any line
    # made one installed version read as several.
    $installed = @(Get-CoopPiExtensionVersions $pilist $name)
    if ($installed.Count -gt 1) { D-Warn "$name installed at several versions ($($installed -join ', '); manifest: $exp)" 'coop sync   (pins the extension fleet)'; continue }
    $cur = $installed[0]
    $st = Coop-ManifestStatus -Installed $cur -Expected $exp
    switch ($st) {
      'ok'                { D-Ok "$name $cur matches manifest ($exp)" }
      'missing'           { D-Warn "$name installed but version unknown (manifest: $exp)" 'coop sync   (pins the extension fleet)' }
      'older'             { D-Warn "$name ${cur}: differs from manifest ($exp)" 'coop sync   (pins the extension fleet)' }
      'wrong-version'     { D-Warn "$name ${cur}: differs from manifest ($exp)" 'coop sync   (pins the extension fleet)' }
      'newer-than-tested' { D-Warn "$name $cur is newer than manifest ($exp)" 'coop sync   (pins back); maintainers: coop update --edge' }
    }
  }
  # pi-ai / pi-tui must match the agent — coop's extensions load INTO it and share one
  # copy. A skew (e.g. tree 0.74.x vs agent 0.80.x) breaks pi-web-access's /compat import.
  $extPy = Get-CoopPython
  $extVer = Get-CoopPiVersion
  if ($extPy -and $extVer) {
    $extScript = Join-Path $script:CoopRoot 'lib/_extdeps.py'
    # Capture output BEFORE reading $LASTEXITCODE — piping a native command into
    # `Select-Object -First 1` terminates it early and leaves $LASTEXITCODE unset.
    $extOut = (& $extPy $extScript align $env:PI_CODING_AGENT_DIR $extVer --check 2>$null)
    $extRc = $LASTEXITCODE
    $extLine = if ($extOut) { @($extOut)[0] } else { '' }
    $ep = if ($extLine) { $extLine -split '\s+' } else { @() }
    if ($extRc -eq 0) { D-Ok "extension pi-ai / pi-tui aligned to pi $extVer" }
    elseif ($extRc -eq 10) {
      $etAi = if ($ep.Count -ge 1) { $ep[0] } else { '-' }
      $etTui = if ($ep.Count -ge 2) { $ep[1] } else { '-' }
      D-Warn "extension pi-ai/pi-tui skew (tree $etAi/$etTui vs agent $extVer)" 'coop doctor --fix   (re-pins + reinstalls; close any running coop session first)'
    }
    elseif ($extRc -eq 11) {
      $eReq = if ($ep.Count -ge 7) { $ep[6] } else { '-' }
      $eExt = if ($ep.Count -ge 8) { $ep[7] } else { '-' }
      $eNeed = if ($eExt -and $eExt -ne '-' -and $eReq -and $eReq -ne '-') { "$eExt needs pi-ai >= $eReq" } else { 'an installed extension needs a newer pi-ai' }
      D-Warn "Pi agent $extVer is too old — $eNeed" 'update the Pi agent: coop update   (or move off the legacy-node20 build)'
    }
    # $extRc -eq 2 (no extension tree yet) / other → silent
  }
} else {
  D-Warn 'cannot check extensions' 'pi not installed'
}

D-Head 'MCP servers (optional; edits ask first)'
# coop launches pi-mcp-adapter in exclusive mode (#165), so the agent dir's
# mcp-adapter.json is the only MCP config it reads. Check that file, and name a
# work repo's MCP file that coop does not use.
$mcpFound = ''
$mcpManaged = Join-Path $env:PI_CODING_AGENT_DIR 'mcp-adapter.json'
if (Test-Path -LiteralPath $mcpManaged -PathType Leaf) { $mcpFound = $mcpManaged }
$cwd = (Get-Location).Path
foreach ($f in @((Join-Path $cwd '.mcp.json'), (Join-Path $cwd '.pi\mcp-adapter.json'), (Join-Path $cwd '.pi\mcp.json'))) {
  if ((Test-Path -LiteralPath $f -PathType Leaf) -and $f -ne $mcpManaged) { D-Ok "not used: $f (coop reads MCP servers only from $mcpManaged)" }
}
if ($mcpFound) {
  D-Ok "MCP config: $mcpFound"
  $mcpText = (Get-Content -LiteralPath $mcpFound -Raw -ErrorAction SilentlyContinue)
  foreach ($s in @('fabric', 'powerbi-modeling-mcp', 'azure-devops', 'microsoft-learn')) {
    if ($mcpText -match ('(?i)"' + [regex]::Escape($s) + '"')) {
      if ($s -eq 'powerbi-modeling-mcp') {
        # Health requires --start (the server must actually launch). coop runs it
        # read-write and its guardrails ask before every edit (#159); --readonly
        # is a supported stricter choice.
        $modelingArgs = ''
        # Extract the args array lines following the powerbi-modeling-mcp key.
        $m = [regex]::Match($mcpText, ('(?i)"' + [regex]::Escape($s) + '"\s*:\s*\{[\s\S]*?"args"\s*:\s*\[(?<args>[\s\S]*?)\]'))
        if ($m.Success) { $modelingArgs = $m.Groups['args'].Value }
        $hasStart = ($modelingArgs -match '(?i)"--start"')
        $hasRo = ($modelingArgs -match '(?i)"--readonly"|"--read-only"')
        if (-not $hasStart) {
          D-Warn '  • Power BI Modeling MCP missing --start' 'add --start so the server launches (run coop sync to regenerate it)'
        } elseif ($hasRo) {
          D-Ok "  • $s configured (started, read-only)"
        } else {
          D-Ok "  • $s configured (started, read-write; coop asks before each edit)"
        }
      } elseif ($s -eq 'fabric') {
        # @microsoft/fabric-mcp signs in through az's default account; coop can
        # pin only its own token mints to the client tenant (H2b).
        D-Ok "  • $s server configured (uses az's default account; coop cannot pin its tenant)"
      } else {
        D-Ok "  • $s server configured"
      }
    }
  }
  # powerbi-mcp-server ignores --readonly and exposes refresh_dataset, a write
  # (#93). coop no longer generates it and never removes a user-owned entry, so
  # doctor names the risk instead of reporting the server as configured.
  if ($mcpText -match '(?i)powerbi-mcp-server') {
    D-Warn '  • powerbi-mcp-server is not read-only: it ignores --readonly and exposes refresh_dataset, a write (coop-agent#93)' "remove that entry from $mcpFound; coop's Power BI MCP is powerbi-modeling-mcp (its edits ask for approval)"
  }
  if ($mcpText -notmatch '(?i)learn\.microsoft\.com|microsoft-learn') {
    D-Warn '  Microsoft Learn MCP not configured' 'coop sync   (adds it read-only)'
  }
  # Legacy/unmanaged placeholders remain actionable; generated COOP entries never contain TODOs.
  $mcpTodo = 0
  $mcpLines = (Get-Content -LiteralPath $mcpFound -ErrorAction SilentlyContinue)
  if ($mcpLines) { $mcpTodo = ($mcpLines | Select-String -Pattern 'TODO-' -SimpleMatch).Count }
  if ($mcpTodo -gt 0) { D-Warn "$mcpTodo TODO placeholder(s) remain in mcp-adapter.json" 'set your tenant/org before live Power BI / Azure DevOps work' }
  $sqlPy = Get-CoopPython
  if ($sqlPy) {
    $sqlArgs = @((Join-Path $script:CoopRoot 'lib\warehouse_mcp.py'), 'doctor-json', $mcpFound)
    $sqlProject = Find-CoopProjectYml
    if ($sqlProject) { $sqlArgs += @('--project', $sqlProject) }
    $sqlArgs += '--probe'
    $sqlJson = (& $sqlPy @sqlArgs 2>$null | Out-String)
    $sqlState = 'unavailable'
    $sqlScope = 'unknown'
    $sqlTenant = ''
    $sqlProbe = 'not_probed'
    $sqlUsable = $false
    if ($sqlJson) {
      try {
        $sqlDoc = $sqlJson | ConvertFrom-Json
        if ($sqlDoc.state) { $sqlState = [string]$sqlDoc.state }
        if ($sqlDoc.target -and $sqlDoc.target.scope) { $sqlScope = [string]$sqlDoc.target.scope }
        # The tenant the probe minted for (H2b); empty means az's default account.
        # Named only when it is the tenant the one chain resolves (Get-CoopTenant,
        # above), so a value that chain rejects is never printed.
        if ($sqlDoc.tenant -is [string] -and $azTenant.Rc -eq 0 -and $sqlDoc.tenant -ceq $azTenant.Tenant) { $sqlTenant = $azTenant.Tenant }
        if ($sqlDoc.probe_state -is [string] -and $sqlDoc.probe_state) { $sqlProbe = [string]$sqlDoc.probe_state }
        if ($sqlDoc.usable -eq $true) { $sqlUsable = $true }
      } catch { $sqlState = 'unavailable' }
    }
    $sqlFor = if ($sqlTenant) { "$sqlScope target, tenant $sqlTenant" } else { "$sqlScope target" }
    $sqlTenantFlag = if ($sqlTenant) { " --tenant $sqlTenant" } else { '' }
    # Observational and honest: what the row proves. 'usable' means the probe ran,
    # the target validated and a compatible SQL tool was listed; a registered
    # config alone is 'configured (not probed)'; otherwise the probe's own state.
    $sqlHow = if ($sqlUsable) { 'usable' } elseif ($sqlProbe -ne 'not_probed') { "probed: $sqlProbe" } elseif ($sqlState -eq 'registered') { 'configured (not probed)' } else { 'not probed' }
    $sqlTail = if ($sqlProbe -eq $sqlState) { '' } else { "; $sqlHow" }
    switch ($sqlState) {
      'registered'            { D-Ok "  • fabric-sqlendpoint registered ($sqlFor; direct HTTP, Azure CLI bearer token; $sqlHow)" }
      'auth_required'         { D-Warn "  • fabric-sqlendpoint auth_required ($sqlFor)" 'sign in with Azure CLI/tenant access; doctor never triggers login' }
      'azure_cli_unavailable' { D-Warn "  • fabric-sqlendpoint azure_cli_unavailable ($sqlFor)" 'install/repair Azure CLI and ensure az is on PATH; this is not an authentication diagnosis' }
      'token_launch_failed'   { D-Warn "  • fabric-sqlendpoint token_launch_failed ($sqlFor)" 'Azure CLI was found but could not be launched; this is not an authentication diagnosis' }
      'token_timeout'         { D-Warn "  • fabric-sqlendpoint token_timeout ($sqlFor)" 'Azure CLI token command exceeded the bounded timeout; retry after checking Azure CLI responsiveness' }
      'token_command_failed'  { D-Warn "  • fabric-sqlendpoint token_command_failed ($sqlFor)" "Azure CLI launched but token acquisition failed; run: az account get-access-token --resource https://api.fabric.microsoft.com --output json$sqlTenantFlag" }
      'token_output_invalid'  { D-Warn "  • fabric-sqlendpoint token_output_invalid ($sqlFor)" 'Azure CLI returned no usable accessToken JSON; verify the Fabric token command output' }
      'tool_missing'          { D-Warn "  • fabric-sqlendpoint tool_missing ($sqlFor)" 'managed MCP did not advertise executeSQL/execute_query' }
      'target_invalid'{ D-Warn "  • fabric-sqlendpoint target_invalid$sqlTail" 'run: coop sync after fixing fabric.default_sql_endpoint / registered URL' }
      'unavailable'   { D-Warn "  • fabric-sqlendpoint unavailable$sqlTail" 'run: coop sync; if already configured, retry when network/auth is available' }
      default         { D-Warn "  • fabric-sqlendpoint $sqlState$sqlTail" 'run: coop sync' }
    }
  } else {
    D-Warn '  fabric-sqlendpoint status unavailable' 'Python is required'
  }
} else {
  D-Warn 'no MCP config found' 'coop sync   (writes the managed fabric/powerbi/learn config)'
}

D-Head 'Microsoft skills catalog'
$catPy = Get-CoopPython
if ($catPy) {
  foreach ($line in (& $catPy (Join-Path $script:CoopRoot 'lib\microsoft_skills.py') doctor-lines 2>$null)) {
    $parts = $line -split "`t", 7
    if ($parts.Count -lt 3) { continue }
    $name = $parts[1]; $state = $parts[2]; $revision = if ($parts.Count -gt 3) { $parts[3] } else { '' }; $count = if ($parts.Count -gt 4) { $parts[4] } else { '0' }
    $target = if ($parts.Count -gt 5 -and $parts[5]) { $parts[5] } else { 'unknown' }
    $detail = if ($parts.Count -gt 6 -and $parts[6]) { " details $($parts[6])" } else { '' }
    if ($state -eq 'current') { D-Ok "$name`: current$(if ($revision) { " @ $revision" } else { '' }) ($count skill(s); target $target)$detail" }
    elseif ($state -eq 'stale_LKG') { D-Warn "$name`: stale_LKG$(if ($revision) { " @ $revision" } else { '' }) (target $target)$detail" 'offline or fetch failed; launch continues from LKG' }
    else { D-Warn "$name`: $state$detail" 'run: coop sync' }
  }
} else {
  D-Warn 'Microsoft skills catalog status unavailable' 'Python is required'
}

D-Head 'Standards'
if (Test-Have 'node') {
  $standardsCli = Join-Path $env:COOP_ROOT 'lib\standards-cli.mjs'
  # The canonical-sync row comes first. Doctor never refreshes, so a last-known-good
  # domain is a warning only when the last refresh attempt actually failed (or never
  # ran); after a successful launch refresh whose freshness window has expired, the
  # cached standards are simply the ones from the last check.
  $syncFailed = $false
  foreach ($line in (& node $standardsCli doctor-lines '' $PWD.Path 2>$null)) {
    $parts = $line -split "`t", 4
    if ($parts.Count -lt 3) { continue }
    $kind = $parts[0]; $name = $parts[1]; $state = $parts[2]; $detail = if ($parts.Count -gt 3) { $parts[3] } else { '' }
    $hint = if ($detail) { $detail } else { 'standards remain fail-soft' }
    if ($name -eq 'canonical-sync' -and $state -match '^(failed|never|degraded)$') { $syncFailed = $true; D-Warn "$kind ${name}: $state" $hint; continue }
    if ($state -match 'stale_last_known_good') {
      if ($syncFailed) { D-Warn "$kind ${name}: $state" $hint }
      else { D-Ok "$kind ${name}: last known good @ $(($detail -split '\|')[0]) (verified at the last check; the next coop launch or coop sync refreshes it)" }
    }
    elseif ($state -match 'bundled') { D-Warn "$kind ${name}: $state (the copy shipped with coop; $(($detail -split '\|')[0]))" 'the coop-standards wiki has not been reached from this machine; run coop sync when online' }
    elseif ($state -match 'unavailable|auth_required|dirty_preserved|wiki_warning') { D-Warn "$kind ${name}: $state" $hint }
    else { D-Ok "$kind ${name}: $state$(if ($detail) { " @ $detail" } else { '' })" }
  }
} else {
  D-Warn 'standards status unavailable' 'Node is required to verify the standards wiki cache and the bundled copy'
}

D-Head 'Optional'
Check 'jq' 'optional' 'nice-to-have for JSON in your own scripts (coop uses python3)'

D-Head 'Project contract'
$proj = Find-CoopProjectYml
if ($proj) {
  D-Ok ".coop/project.yml found: $proj"

  # Feature-aware validation: only flag missing values for enabled features instead of
  # counting raw TODO substrings.
  $org = Get-CoopYamlValue $proj 'profile.organization' ''
  $branch = Get-CoopYamlValue $proj 'profile.default_branch' ''
  $estateMode = Get-CoopYamlValue $proj 'estate.mode' ''
  $repoPaths = @(Get-CoopYamlList $proj 'repositories.*.local_path')
  if ([string]::IsNullOrWhiteSpace($org)) { D-Warn 'profile.organization is empty' 'set it in .coop/project.yml' }
  if ([string]::IsNullOrWhiteSpace($branch)) { D-Warn 'profile.default_branch is empty' 'set it in .coop/project.yml' }
  if ($repoPaths.Count -eq 0 -and $estateMode -ne 'discovery') { D-Warn 'no repositories configured' 'run /setup-project in Coop, or set estate.mode: discovery' }

  if ((Test-CoopToolEnabled $proj 'fabric_cli') -or (Test-CoopToolEnabled $proj 'fabric_cicd')) {
    # The one tenant predicate (Get-CoopTenant, above): a TODO placeholder is
    # unset and a value that is not a GUID or domain name is invalid, never "set".
    $tenant = Get-CoopYamlValue $proj 'fabric.tenant_id' ''
    if ([string]::IsNullOrWhiteSpace($tenant) -or $tenant.Trim().StartsWith('todo', [System.StringComparison]::OrdinalIgnoreCase)) { D-Warn 'Fabric tools enabled but fabric.tenant_id is empty' 'set it in .coop/project.yml' }
    elseif ($azTenant.Rc -eq 2) { D-Warn 'Fabric tools enabled but fabric.tenant_id is not a GUID or domain name' 'fix it in .coop/project.yml' }
  }

  if (Test-CoopToolEnabled $proj 'tabular_editor_cli') {
    $tePath = Get-CoopYamlValue $proj 'tools.tabular_editor_cli.executable_path' ''
    if ([string]::IsNullOrWhiteSpace($tePath) -or $tePath.StartsWith('TODO')) { D-Warn 'Tabular Editor enabled but executable_path not set' 'set tools.tabular_editor_cli.executable_path in .coop/project.yml' }
  }

  D-Ok 'Microsoft skills project policy is covered by the pinned catalog doctor section'

  # SQL connection targets (sql_targets:, master plan SQ1): kinds, host patterns,
  # and the rule that production is never the default. Shared with Bash.
  if ($pyBin) {
    foreach ($line in @(& $pyBin (Join-Path $script:CoopRoot 'lib\sql_targets.py') --project $proj doctor-lines 2>$null)) {
      $parts = @(([string]$line) -split "`t", 3)
      if ($parts.Count -lt 2 -or -not $parts[0]) { continue }
      $hint = if ($parts.Count -ge 3) { $parts[2] } else { '' }
      if ($parts[0] -ceq 'ok') { D-Ok $parts[1] }
      elseif ($parts[0] -ceq 'bad') { D-Bad $parts[1] $hint }
      else { D-Warn $parts[1] $hint }
    }
  }

  # Read-only bounded legacy-project diagnostics, shared with Bash and migration.
  if ($pyBin) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $proj)
    $healthLines = @(& $pyBin (Join-Path $script:CoopRoot 'lib/project_health.py') doctor-lines $projectRoot --skills-dir (Join-Path $script:CoopRoot 'skills'))
    foreach ($line in $healthLines) {
      $parts = @(([string]$line) -split "`t", 3)
      if ($parts.Count -ge 2 -and $parts[0]) {
        D-Warn ("$($parts[0]): $($parts[1])") $(if ($parts.Count -ge 3) { $parts[2] } else { '' })
      }
    }
  }
} else {
  D-Warn 'no .coop/project.yml found' "copy $($script:CoopRoot)/.coop/project.example.yml to your repo's .coop/project.yml"
}

D-Head 'coop-agent repository'
if ((Test-CoopGitCheckout $script:CoopRoot) -and (Test-Have 'git')) {
  # Staleness nudge: refresh origin at most once/day (bounded wait; silent offline),
  # then compare against the release `coop update` would move to — local + instant.
  # A checkout the update cannot move (hold, diverged, no origin/main) is named.
  # The row itself is decided by Get-CoopRepoDoctorRow (tests/fixtures/update-follow.test.ps1).
  $null = Invoke-CoopRepoFetchThrottled
  $repoRow = Get-CoopRepoDoctorRow
  if ($repoRow.Level -ceq 'ok') { D-Ok $repoRow.Message } else { D-Warn $repoRow.Message $repoRow.Hint }
} else {
  # A zip/shared-drive copy: everything above still updates, but the repo layer
  # (skills/prompts/guardrails/themes/scripts) is frozen at whatever the zip held.
  D-Warn 'this coop-agent is not a git checkout — skills/prompts/guardrails will NEVER update' 'fix: git clone the repo, then run .\bin\coop.cmd install from the clone (your ~/.coop settings carry over)'
}

D-Head 'Powerline / splash assets'
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi') -PathType Leaf) { D-Ok 'brand splash present' } else { D-Warn 'splash.ansi missing' 'run: coop sync' }
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'themes\cooptimize.json') -PathType Leaf) { D-Ok 'Cooptimize theme present' } else { D-Warn 'theme missing' }

# A machine that predates the client platform setting is asked once (--fix,
# interactive, never in --json): the answer is saved to ~/.coop/config and the
# rows above read it on the next run.
if ($script:FIX -and -not $script:JSON -and -not [Console]::IsInputRedirected -and (Test-Path -LiteralPath (Get-CoopConfigFile) -PathType Leaf) -and -not (Get-CoopClientPlatform)) {
  D-Head 'Client platform (--fix)'
  $fixPy = Get-CoopPython
  $platFixed = $false
  if ($fixPy) {
    & $fixPy (Join-Path $script:CoopRoot 'scripts\onboard.py') platform | Out-Null
    $platFixed = ($LASTEXITCODE -eq 0)
  }
  if ($platFixed) { Coop-Ok 'client platform saved; rerun: coop doctor' }
  else { Coop-Warn 'client platform not saved; run: coop onboard --platform fabric|azure_sql|both' }
}

if ($script:FIX -and ($script:FAIL -gt 0 -or $script:WARN -gt 0)) {
  D-Head 'Applying fixes (--fix)'
  $repairFailed = $false
  $syncScript = Join-Path $script:CoopRoot 'scripts\sync.ps1'
  if (Test-Path -LiteralPath $syncScript) {
    # Run in a CHILD process (like install/update) so its real exit code is read from
    # $LASTEXITCODE — invoking it in-process could leave $LASTEXITCODE stale from an
    # earlier native call and report a random success/failure.
    $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $syncScript *> $null
    if ($LASTEXITCODE -eq 0) { Coop-Ok 'synced extensions / MCP / assets' } else { Coop-Warn 'sync had issues (run: coop sync)' }
  }
  if (Test-Have 'pipx') {
    # The Fabric CLI is (re)built when fab is missing, or when its environment
    # runs a Python its own Requires-Python rejects (a 3.14 venv, after the
    # default Python moved on). The interpreter comes from the same plan install
    # and update use: a local 3.10-3.13, or pipx's standalone 3.12.
    $fabricRebuild = 0
    $fabricEnvPy = ''
    if (-not (Test-Have 'fab')) { $fabricRebuild = 1 }
    else {
      $fabricEnvPy = [string](Get-CoopVenvPythonVersion 'ms-fabric-cli')
      $fabricRp = if ($fabricEnvPy) { Get-CoopVenvRequiresPython 'ms-fabric-cli' 'ms-fabric-cli' } else { '' }
      if ($fabricEnvPy -and $fabricRp -and -not (Test-CoopPythonSpec $fabricEnvPy $fabricRp)) { $fabricRebuild = 2 }
    }
    if ($fabricRebuild -ne 0) {
      # Repairs install the release's pinned versions only, never PyPI's latest.
      $fabricSpec = Coop-ManifestPythonSpec 'ms-fabric-cli'
      $fabricPlan = if ($fabricSpec) { Get-CoopFabricPipxPlan } else { $null }
      if (-not $fabricSpec) {
        Coop-Warn 'no release pin for ms-fabric-cli in the manifest' 'run: coop update'
        $repairFailed = $true
      } elseif (-not $fabricPlan) {
        Coop-Warn 'Microsoft Fabric CLI needs Python 3.10-3.13 and this pipx cannot fetch one' "apply the Python row's fix under Prerequisites (install Python 3.12, or upgrade pipx to 1.12+), then run: coop doctor --fix"
        $repairFailed = $true
      } else {
        $fabricArgs = @('install')
        if ($fabricRebuild -eq 2) { $fabricArgs += '--force' }
        if ($fabricPlan.FetchFlag) { $fabricArgs += $fabricPlan.FetchFlag }
        $fabricArgs += @('--python', $fabricPlan.Python, $fabricSpec)
        Coop-Info "pipx $($fabricArgs -join ' ')"
        & pipx @fabricArgs *> $null
        if ($LASTEXITCODE -eq 0 -and (Sync-CoopFabricPythonPackages) -and (Ensure-CoopFabricOdbcDriver $true)) {
          if ($fabricRebuild -eq 2) { Coop-Ok "managed Fabric runtime rebuilt on Python $($fabricPlan.Python) (was $fabricEnvPy)" }
          else { Coop-Ok "managed Fabric runtime installed (Python $($fabricPlan.Python))" }
        } else {
          Coop-Warn 'could not install the managed Fabric runtime' 'run: coop install'
          $repairFailed = $true
        }
      }
    }
    # The Coop tools come from the fleet plan install/update converge (the
    # Fabric CLI is the rebuild above); repairs install the manifest pin only.
    foreach ($t in @((Get-CoopFleetPlan).PythonTools | ForEach-Object { $_.Name })) {
      if (-not (Test-Have $t)) {
        $tSpec = Coop-ManifestPythonSpec $t
        if (-not $tSpec) {
          Coop-Warn "no release pin for $t in the manifest" 'run: coop update'
          $repairFailed = $true
          continue
        }
        Coop-Info "pipx install $tSpec"
        & pipx install $tSpec *> $null
        if ($LASTEXITCODE -eq 0) { Coop-Ok "$t installed" } else { Coop-Warn "could not install $t (run: pipx install $tSpec)" }
      }
    }
  } else {
    Coop-Warn 'pipx missing — cannot auto-install tools (install pipx first: see the hint above)'
  }
  if ($repairFailed) { exit 1 }
  Coop-Info 'Re-checking... (system deps like node/python/pipx install manually — see hints above)'
  [Console]::Error.WriteLine('')
  # Propagate --json/--publish so the re-check emits the (final) machine-readable document.
  $reArgs = @(); if ($script:PUBLISH) { $reArgs += '--publish' } elseif ($script:JSON) { $reArgs += '--json' }
  & (Join-Path $script:CoopRoot 'scripts\doctor.ps1') @reArgs
  exit $LASTEXITCODE
}

# --json: one JSON document on stdout (ConvertTo-Json handles
# escaping, including any control character a probed tool leaked into a message).
if ($script:JSON) {
  $doc = [ordered]@{ checks = @($script:JsonChecks); fail = $script:FAIL; warn = $script:WARN }

  if ($script:PUBLISH) {
    $hostName = [System.Net.Dns]::GetHostName()
    $userName = if ($env:USERNAME) { $env:USERNAME } else { $env:USER }
    if (-not $userName) { $userName = 'unknown' }
    $doc['hostname'] = $hostName
    $doc['user'] = $userName
    $doc['coop_version'] = $script:CoopVersion
    # VERSION reads the same at a tag and at every commit past it, so the snapshot
    # also carries the checkout's git describe ('' for a non-git copy).
    $doc['coop_describe'] = [string](Get-CoopRepoDescribe)
    $piVer = Get-CoopPiVersion
    $doc['pi_version'] = if ($piVer) { $piVer } else { 'none' }
    $doc['timestamp'] = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    
    $jsonStr = ($doc | ConvertTo-Json -Depth 4 -Compress)
    
    $pubDir = ''
    $pyCmd = Get-CoopPython
    if ($pyCmd) {
      $cfgFile = Get-CoopConfigFile
      $pubDir = (& $pyCmd -c "import os, sys; sys.path.insert(0, os.path.join(r'$script:CoopRoot', 'lib')); import _yaml; cfg = r'$cfgFile'; d = _yaml.load(cfg) if os.path.exists(cfg) else {}; p = _yaml.dig(d, 'fleet.publish_dir'); print(p or _yaml.dig(_yaml.load(os.path.join(r'$script:CoopRoot', 'config/defaults.yml')), 'fleet.publish_dir') or '')" 2>$null | Out-String).Trim()
    }
    if ($pubDir) {
      if (-not (Test-Path -LiteralPath $pubDir)) { New-Item -ItemType Directory -Force -Path $pubDir | Out-Null }
      if (Test-Path -LiteralPath $pubDir -PathType Container) {
        $dest = Join-Path $pubDir "${hostName}_${userName}.json"
        [System.IO.File]::WriteAllText($dest, $jsonStr)
        [Console]::Error.WriteLine("  ✓ Published fleet health to $dest")
      } else {
        [Console]::Error.WriteLine("  ✗ fleet.publish_dir '$pubDir' is not a valid directory")
      }
    } else {
      [Console]::Error.WriteLine("  ✗ fleet.publish_dir not configured in ~/.coop/config or config/defaults.yml")
    }
  } else {
    Write-Output ($doc | ConvertTo-Json -Depth 4 -Compress)
  }

  if ($script:FAIL -gt 0) { exit 1 } else { exit 0 }
}

[Console]::Error.WriteLine('')
$fixHint = if (-not $script:FIX) { "   (or auto-fix what's safe: coop doctor --fix)" } else { '' }
if ($script:FAIL -gt 0) {
  Coop-Err "doctor: $($script:FAIL) required item(s) missing, $($script:WARN) warning(s). Run: coop install$fixHint"
  exit 1
} else {
  Coop-Ok ("doctor: all required dependencies present" + $(if ($script:WARN) { ", $($script:WARN) warning(s)" } else { '' }) + '.')
  exit 0
}
