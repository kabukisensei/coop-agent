#!/usr/bin/env pwsh
#
# coop doctor (Windows / PowerShell mirror of scripts/doctor.sh) —
# verify the Cooptimize agent's dependencies and configuration.
# Exit 0 when all REQUIRED dependencies are present (warnings are non-fatal);
# exit 1 when something required is missing.
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, Test-Have,
# Get-CoopPython, Get-CoopPiVersion, Get-CoopYamlValue, Find-CoopProjectYml, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# --- doctor body -------------------------------------------------------------
# Check coop's ISOLATED Pi agent dir, not the user's personal ~/.pi/agent.
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir

$script:FAIL = 0   # required missing -> non-zero exit
$script:WARN = 0
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

# --json plumbing (mirror of doctor.sh): EVERY check funnels through D-Ok/D-Warn/
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

D-Head 'Core'
Check 'pi'      'required' 'npm install -g @earendil-works/pi-coding-agent   (or: coop bootstrap)' @('pi','--version')
Check 'git'     'required' 'install Git from https://git-scm.com' @('git','--version')
Check 'node'    'optional' 'needed to install/update pi: https://nodejs.org' @('node','--version')
Check 'npm'     'optional' 'ships with Node.js' @('npm','--version')
# Python: Windows ships `python`/`py`, not `python3` — accept either. And no bash-
# style `&&` in hints (Windows PowerShell 5.1 can't parse it). Get-CoopPython skips
# a Windows Store App-Execution-Alias stub (under \WindowsApps\, no real python):
# it makes Test-Have succeed while `--version` prints nothing — must not read as ✓.
$pyBin = Get-CoopPython
$pyName = if ($pyBin) { $pyBin } else { 'python' }
if ($pyBin) {
  $pv = (& $pyBin --version 2>$null | Select-Object -First 1)
  $pm = [regex]::Match([string]$pv, '\d+\.\d+(\.\d+)?')
  D-Ok ('python' + $(if ($pm.Success) { "  ($($pm.Value))" } else { '' }))
  # The coop tools (coop-data-doc/sql-review/dax-review, ms-fabric-cli) require
  # >= 3.10 — flag an old python now instead of failing later at pipx install.
  if ($pm.Success) {
    $parts = $pm.Value -split '\.'
    $pyVer = [version]("{0}.{1}.{2}" -f $parts[0], $parts[1], $(if ($parts.Count -ge 3) { $parts[2] } else { '0' }))
    if ($pyVer -lt [version]'3.10.0') { D-Warn "Python $($pm.Value) is older than the coop tools require (>= 3.10)" 'upgrade Python: https://python.org' }
  }
} else {
  D-Bad 'python missing' 'winget install Python.Python.3.12  (or https://python.org), then: coop install. (A Windows Store python stub does not count.)'
}
if (Test-Have 'pipx') {
  $xv = (& pipx --version 2>$null | Select-Object -First 1)
  $xm = [regex]::Match([string]$xv, '\d+\.\d+(\.\d+)?')
  D-Ok ('pipx' + $(if ($xm.Success) { "  ($($xm.Value))" } else { '' }))
} else {
  D-Bad 'pipx missing' "$pyName -m pip install --user pipx; $pyName -m pipx ensurepath  (or just: coop install)"
}

# Minimum Pi version — the extension API used by coop-powerline / coop-tools.
if (Test-Have 'pi') {
  $piRaw = (& pi --version 2>$null | Select-Object -First 1)
  if ($piRaw -match '(\d+)\.(\d+)\.(\d+)') {
    $piv = [version]("{0}.{1}.{2}" -f $matches[1], $matches[2], $matches[3])
    if ($piv -lt [version]'0.79.0') { D-Warn "pi $piv is older than the tested minimum (0.79.0)" 'coop update' }
    # Ceiling: warn (never fail) when the installed Pi is a newer MINOR than coop's tested
    # version (mirror of doctor.sh). `coop update` gates the jump; doctor just flags it.
    $testedPi = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') 'tested_with.pi' ''
    if ($testedPi -match '(\d+)\.(\d+)') {
      $testedMinor = [version]("{0}.{1}" -f $matches[1], $matches[2])
      $piMinor = [version]("{0}.{1}" -f $piv.Major, $piv.Minor)
      if ($piMinor -gt $testedMinor) { D-Warn "pi $piv is newer than coop's tested version ($testedPi)" "if extensions misbehave, pin back: npm i -g @earendil-works/pi-coding-agent@$testedPi" }
    }
  }
}

# Release manifest: the single source of truth for the exact versions that ship
# together with this coop build. Doctor reports drift so a teammate can `coop update`
# or `coop update --edge` intentionally.
D-Head 'Release manifest'
$piExpected = Coop-ManifestGet 'pi.version'
if ($piExpected) {
  if (Test-Have 'pi') {
    $piRaw = (& pi --version 2>$null | Select-Object -First 1)
    $piv = ''
    if ($piRaw -match '(\d+)\.(\d+)\.(\d+)') {
      $piv = "$($matches[1]).$($matches[2]).$($matches[3])"
    }
    $piStatus = Coop-ManifestStatus $piv $piExpected
    switch ($piStatus) {
      'ok'                { D-Ok "pi $piv matches manifest ($piExpected)" }
      'missing'           { D-Warn 'pi version unknown' 'coop update' }
      'older'             { D-Warn "pi $piv is older than manifest ($piExpected)" 'coop update' }
      'newer-than-tested' { D-Warn "pi $piv is newer than manifest ($piExpected)" "coop update --edge, or pin back: npm i -g @earendil-works/pi-coding-agent@$piExpected" }
      'wrong-version'     { D-Warn "pi $piv differs from manifest ($piExpected)" 'coop update' }
    }
  } else {
    D-Warn 'pi not installed' 'coop install'
  }
}

foreach ($key in @('coop-data-doc', 'coop-sql-review', 'coop-dax-review', 'ms-fabric-cli')) {
  $expected = Coop-ManifestGet "python_tools.$key"
  if (-not $expected) { continue }
  if (Test-Have $key) {
    $vOut = (& $key --version 2>$null | Select-Object -First 1)
    $ver = ''
    if ($vOut -match '\d+\.\d+(\.\d+)?') { $ver = $matches[0] }
  } else {
    $ver = ''
  }
  $status = Coop-ManifestStatus $ver $expected
  switch ($status) {
    'ok'                { D-Ok "$key $ver matches manifest ($expected)" }
    'missing'           { D-Warn "$key not installed or version unknown (manifest: $expected)" "pipx install $key==$expected" }
    'older'             { D-Warn "$key $ver is older than manifest ($expected)" "pipx install $key==$expected" }
    'newer-than-tested' { D-Warn "$key $ver is newer than manifest ($expected)" "pipx install $key==$expected" }
    'wrong-version'     { D-Warn "$key $ver differs from manifest ($expected)" "pipx install $key==$expected" }
  }
}

# Minimum node version from the manifest.
$nodeExpected = Coop-ManifestGet 'node.min'
if ($nodeExpected -and (Test-Have 'node')) {
  $nraw = (& node --version 2>$null | Select-Object -First 1)
  $nodev = ''
  if ($nraw -match '(\d+)\.(\d+)\.(\d+)') { $nodev = "$($matches[1]).$($matches[2]).$($matches[3])" }
  if ($nodev -and (Coop-VersionLessThan $nodev $nodeExpected)) {
    D-Warn "Node $nodev is older than the manifest minimum ($nodeExpected)" 'upgrade Node: https://nodejs.org'
  }
}

# Pi (latest, @earendil-works) requires Node >= 22.19 — check the version so a teammate
# on Node 18/20 gets a clear message instead of a cryptic pi failure.
if (Test-Have 'node') {
  $nraw = (& node --version 2>$null)
  if ($nraw -match '(\d+)\.(\d+)\.(\d+)') {
    $nv = [version]("{0}.{1}.{2}" -f $matches[1], $matches[2], $matches[3])
    if ($nv -lt [version]'22.19.0') { D-Warn "Node $nv is older than Pi's requirement (>= 22.19)" "upgrade Node, or pin Pi's legacy build: npm i -g @earendil-works/pi-coding-agent@legacy-node20" }
  }
}

# Lingering deprecated Pi package — coop migrated to @earendil-works (Out-String so
# npm ls's exit code on an invalid tree doesn't matter).
if (Test-Have 'npm') {
  $globals = (& npm ls -g --depth=0 2>$null | Out-String)
  if ($globals -match '@mariozechner/pi-coding-agent') {
    D-Warn 'deprecated Pi package still installed globally (@mariozechner/pi-coding-agent; Pi is now @earendil-works)' 'remove if unused: npm uninstall -g @mariozechner/pi-coding-agent  (skip if an extension still depends on it)'
  }
}

# First-run login: coop shares Pi auth in from ~/.pi/agent. A brand-new teammate has none.
if (Test-Have 'pi') {
  $authA = Join-Path (Get-CoopPiAgentDir) 'auth.json'
  $authB = Join-Path (Join-Path $HOME '.pi\agent') 'auth.json'
  if ((Test-Path -LiteralPath $authA -PathType Leaf) -or (Test-Path -LiteralPath $authB -PathType Leaf)) {
    D-Ok 'Pi login present'
  } else {
    D-Warn 'no Pi login found yet' "your first 'coop' run will prompt you to sign in — see docs/onboarding.md §3.5 (OpenAI/Codex provider, Cooptimize BUSINESS account)"
  }
}

D-Head 'Microsoft Fabric CLI'
if (Test-Have 'fab') {
  $fabver = ((& fab --version 2>&1 | Select-Object -First 3) -join ' ')
  if ($fabver -match '(?i)paramiko|invoke') {
    D-Bad 'fab is the WRONG tool' "this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI"
    if (-not $script:JSON) {
      Coop-Say '      Fix: pipx install ms-fabric-cli   and ensure ~/.local/bin precedes Homebrew on PATH'
      Coop-Say '           (or: brew uninstall fabric). Verify with: fab --version'
    }
  } else {
    $fv = (& fab --version 2>$null | Select-Object -First 1)
    D-Ok "fab — Microsoft Fabric CLI  ($fv)"
  }
} else {
  D-Bad 'fab missing' 'pipx install ms-fabric-cli'
}

D-Head 'Standalone Coop tools (pipx)'
Check 'coop-data-doc'   'required' 'pipx install coop-data-doc'   @('coop-data-doc','--version')
Check 'coop-sql-review' 'required' 'pipx install coop-sql-review' @('coop-sql-review','--version')
Check 'coop-dax-review' 'required' 'pipx install coop-dax-review' @('coop-dax-review','--version')

D-Head 'Fabric / semantic-model tooling'

# Power BI / Fabric authoring npm tools. powerbi-report-author backs coop's own
# power-bi-* skills AND the skills-for-fabric skills, so it is required; the rest
# stay optional. powerbi-desktop-bridge is only useful on Windows with Desktop.
Check 'powerbi-report-author' 'required' 'npm install -g @microsoft/powerbi-report-authoring-cli' @('powerbi-report-author', '--version')
if ($env:OS -eq 'Windows_NT') {
  Check 'powerbi-desktop' 'optional' 'npm install -g @microsoft/powerbi-desktop-bridge-cli (Windows + Power BI Desktop only)' @('powerbi-desktop', '--version')
} else {
  D-Ok 'powerbi-desktop (Desktop Bridge) — Windows only, not applicable here'
}
# powerbi-modeling-mcp is started via npx; verify the package is installed globally.
$pbihModeling = $false
if (Test-Have 'npm') {
  & npm ls -g --depth=0 @microsoft/powerbi-modeling-mcp *> $null
  if ($LASTEXITCODE -eq 0) { $pbihModeling = $true }
}
if ($pbihModeling) { D-Ok 'powerbi-modeling-mcp (npm package installed)' }
else { D-Warn 'powerbi-modeling-mcp not installed' 'npm install -g @microsoft/powerbi-modeling-mcp' }

# fabric-cicd is a Python LIBRARY (no CLI) — check it's importable in the Fabric CLI's env.
if (Test-Have 'fab') {
  $hasCicd = $false
  # Primary: ask pipx to run pip inside the ms-fabric-cli venv. This is OS-agnostic
  # and avoids guessing the venv layout. (On Windows the `fab` shim in ~\.local\bin
  # is NOT a symlink, so deriving python.exe from the shim's dir — the old approach —
  # never finds the interpreter and falsely reports "not installed".)
  if (Test-Have 'pipx') {
    & pipx runpip ms-fabric-cli show fabric-cicd *> $null
    if ($LASTEXITCODE -eq 0) { $hasCicd = $true }
  }
  if (-not $hasCicd) {
    # Fallback: find the ms-fabric-cli venv interpreter directly. Needed on Windows,
    # where the `fab` shim in ~\.local\bin isn't a symlink AND `pipx` may be absent
    # (no system Python). Try PIPX_HOME + the common defaults, plus an interpreter
    # next to the shim (where the shim IS a symlink, e.g. *nix-like setups).
    $venvCandidates = @()
    foreach ($pipxHome in @($env:PIPX_HOME, (Join-Path $HOME 'pipx'), (Join-Path $HOME '.local\pipx'), (Join-Path $env:LOCALAPPDATA 'pipx\pipx'))) {
      if ($pipxHome) {
        $venvCandidates += (Join-Path $pipxHome 'venvs\ms-fabric-cli\Scripts\python.exe')  # Windows
        $venvCandidates += (Join-Path $pipxHome 'venvs\ms-fabric-cli\bin\python')           # *nix-like
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
  if ($hasCicd) { D-Ok 'fabric-cicd (library, in the Fabric CLI env)' }
  else { D-Warn 'fabric-cicd not installed' 'pipx inject ms-fabric-cli fabric-cicd' }
} else {
  D-Warn 'fabric-cicd: install the Microsoft Fabric CLI first' 'coop install'
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
  foreach ($ext in @('pi-mcp-adapter:MCP servers', 'pi-hermes-memory:persistent memory')) {
    $name = $ext.Split(':')[0]; $desc = $ext.Split(':')[1]
    if ($pilist -match [regex]::Escape($name)) { D-Ok "$name ($desc)" }
    else { D-Warn "$name not installed ($desc)" "coop add npm:$name" }
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

D-Head 'MCP servers (read-only, optional)'
$mcpFound = ''
$cwd = (Get-Location).Path
foreach ($f in @(
    (Join-Path $cwd '.mcp.json'),
    (Join-Path $cwd '.pi\mcp.json'),
    (Join-Path $env:PI_CODING_AGENT_DIR 'mcp.json'),
    (Join-Path $HOME '.config\mcp\mcp.json'),
    (Join-Path $HOME '.pi\mcp-config\mcp.json'))) {
  if (Test-Path -LiteralPath $f -PathType Leaf) { $mcpFound = $f; break }
}
if ($mcpFound) {
  D-Ok "MCP config: $mcpFound"
  $mcpText = (Get-Content -LiteralPath $mcpFound -Raw -ErrorAction SilentlyContinue)
  foreach ($s in @('fabric', 'powerbi', 'powerbi-modeling-mcp', 'azure-devops', 'microsoft-learn', 'context-mode')) {
    if ($mcpText -match ('(?i)"' + [regex]::Escape($s) + '"')) {
      if ($s -eq 'powerbi-modeling-mcp') {
        $modelingArgs = ''
        # Extract the args array lines following the powerbi-modeling-mcp key.
        $m = [regex]::Match($mcpText, ('(?i)"' + [regex]::Escape($s) + '"\s*:\s*\{[\s\S]*?"args"\s*:\s*\[(?<args>[\s\S]*?)\]'))
        if ($m.Success) { $modelingArgs = $m.Groups['args'].Value }
        if ($modelingArgs -match '(?i)"--readonly"|"--read-only"') {
          D-Ok "  • $s server configured (read-only mode)"
        } elseif ($modelingArgs -match '(?i)"--start"|"--read-write"|"--readwrite"') {
          D-Warn "  • $s server configured (read-write mode)" 'change args to --readonly for read-only'
        } else {
          D-Warn "  • $s server configured (mode unclear)" 'use --readonly for read-only'
        }
      } else {
        D-Ok "  • $s server configured"
      }
    }
  }
  if ($mcpText -notmatch '(?i)learn\.microsoft\.com|microsoft-learn') {
    D-Warn '  Microsoft Learn MCP not configured' 'coop sync   (adds it read-only)'
  }
  # Legacy/unmanaged placeholders remain actionable; generated COOP entries never contain TODOs.
  $mcpTodo = 0
  $mcpLines = (Get-Content -LiteralPath $mcpFound -ErrorAction SilentlyContinue)
  if ($mcpLines) { $mcpTodo = ($mcpLines | Select-String -Pattern 'TODO-' -SimpleMatch).Count }
  if ($mcpTodo -gt 0) { D-Warn "$mcpTodo TODO placeholder(s) remain in mcp.json" 'set your tenant/org before live Power BI / Azure DevOps work' }
} else {
  D-Warn 'no MCP config found' 'coop sync   (writes a read-only fabric/powerbi/learn config)'
}

D-Head 'Optional'
Check 'az' 'optional' 'Azure CLI for Fabric/Power BI auth: https://learn.microsoft.com/cli/azure'
Check 'jq' 'optional' 'nice-to-have for JSON in your own scripts (coop uses python3)'

D-Head 'Project contract'
$proj = Find-CoopProjectYml
if ($proj) {
  D-Ok ".coop/project.yml found: $proj"

  # Feature-aware validation: only flag missing values for enabled features instead of
  # counting raw TODO substrings.
  $org = Get-CoopYamlValue $proj 'profile.organization' ''
  $branch = Get-CoopYamlValue $proj 'profile.default_branch' ''
  $repoPaths = @(Get-CoopYamlList $proj 'repositories.*.local_path')
  if ([string]::IsNullOrWhiteSpace($org)) { D-Warn 'profile.organization is empty' 'set it in .coop/project.yml' }
  if ([string]::IsNullOrWhiteSpace($branch)) { D-Warn 'profile.default_branch is empty' 'set it in .coop/project.yml' }
  if ($repoPaths.Count -eq 0) { D-Warn 'no repositories configured' 'add at least one repository under repositories:' }

  if ((Test-CoopToolEnabled $proj 'fabric_cli') -or (Test-CoopToolEnabled $proj 'fabric_cicd')) {
    $tenant = Get-CoopYamlValue $proj 'fabric.tenant_id' ''
    if ([string]::IsNullOrWhiteSpace($tenant)) { D-Warn 'Fabric tools enabled but fabric.tenant_id is empty' 'set it in .coop/project.yml' }
  }

  if (Test-CoopToolEnabled $proj 'tabular_editor_cli') {
    $tePath = Get-CoopYamlValue $proj 'tools.tabular_editor_cli.executable_path' ''
    if ([string]::IsNullOrWhiteSpace($tePath) -or $tePath.StartsWith('TODO')) { D-Warn 'Tabular Editor enabled but executable_path not set' 'set tools.tabular_editor_cli.executable_path in .coop/project.yml' }
  }

  # Subordinate skill sources: warn when configured but not yet fetched.
  foreach ($key in @('microsoft_skills', 'fabric_skills')) {
    $src = Get-CoopYamlValue $proj "$key.source" ''
    if ([string]::IsNullOrWhiteSpace($src) -or $src.StartsWith('TODO')) { continue }
    $loadDir = Get-CoopYamlValue $proj "$key.load_dir" "skills/$key"
    $allowed = Get-CoopYamlList $proj "$key.allow"
    if (-not $allowed -or $allowed.Count -eq 0) { continue }
    $missing = 0
    foreach ($skill in $allowed) {
      if ([string]::IsNullOrWhiteSpace($skill) -or $skill.StartsWith('TODO')) { continue }
      $p = Join-Path $script:CoopRoot "$loadDir/$skill/SKILL.md"
      if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $missing++ }
    }
    if ($missing -gt 0) {
      D-Warn "$key`: $missing allow-listed skill(s) not fetched" 'run: scripts/fetch-microsoft-skills.sh'
    } else {
      D-Ok "$key`: all allow-listed skills fetched"
    }
  }
} else {
  D-Warn 'no .coop/project.yml found' "copy $($script:CoopRoot)/.coop/project.example.yml to your repo's .coop/project.yml"
}

D-Head 'coop-agent repository'
if ((Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git')) -and (Test-Have 'git')) {
  # Staleness nudge: refresh origin at most once/day (bounded wait; silent offline),
  # then count against the last-fetched origin/main — local + instant.
  $null = Invoke-CoopRepoFetchThrottled
  $behind = Get-CoopRepoBehindCount
  if ($behind -gt 0) { D-Warn "coop-agent is $behind commit(s) behind" 'run: coop update' }
  else { D-Ok 'coop-agent is a git checkout (updates via: coop update)' }
} else {
  # A zip/shared-drive copy: everything above still updates, but the repo layer
  # (skills/prompts/guardrails/themes/scripts) is frozen at whatever the zip held.
  D-Warn 'this coop-agent is not a git checkout — skills/prompts/guardrails will NEVER update' 'fix: git clone the repo, then run .\bin\coop.cmd install from the clone (your ~/.coop settings carry over)'
}

D-Head 'Powerline / splash assets'
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi') -PathType Leaf) { D-Ok 'brand splash present' } else { D-Warn 'splash.ansi missing' 'run: coop sync' }
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'themes\cooptimize.json') -PathType Leaf) { D-Ok 'Cooptimize theme present' } else { D-Warn 'theme missing' }

if ($script:FIX -and ($script:FAIL -gt 0 -or $script:WARN -gt 0)) {
  D-Head 'Applying fixes (--fix)'
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
    if (-not (Test-Have 'fab')) {
      Coop-Info 'pipx install ms-fabric-cli'
      & pipx install ms-fabric-cli *> $null
      if ($LASTEXITCODE -eq 0) {
        & pipx inject ms-fabric-cli fabric-cicd *> $null
        Coop-Ok 'ms-fabric-cli installed'
      } else {
        Coop-Warn 'could not install ms-fabric-cli (run: pipx install ms-fabric-cli)'
      }
    }
    foreach ($t in @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')) {
      if (-not (Test-Have $t)) {
        Coop-Info "pipx install $t"
        & pipx install $t *> $null
        if ($LASTEXITCODE -eq 0) { Coop-Ok "$t installed" } else { Coop-Warn "could not install $t (run: pipx install $t)" }
      }
    }
  } else {
    Coop-Warn 'pipx missing — cannot auto-install tools (install pipx first: see the hint above)'
  }
  Coop-Info 'Re-checking... (system deps like node/python/pipx + the Fabric CLI install manually — see hints above)'
  [Console]::Error.WriteLine('')
  # Propagate --json/--publish so the re-check emits the (final) machine-readable document.
  $reArgs = @(); if ($script:PUBLISH) { $reArgs += '--publish' } elseif ($script:JSON) { $reArgs += '--json' }
  & (Join-Path $script:CoopRoot 'scripts\doctor.ps1') @reArgs
  exit $LASTEXITCODE
}

# --json: one JSON document on stdout (mirror of doctor.sh; ConvertTo-Json handles
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
    $piVer = Get-CoopPiVersion
    $doc['pi_version'] = if ($piVer) { $piVer } else { 'none' }
    $doc['timestamp'] = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    
    $jsonStr = ($doc | ConvertTo-Json -Depth 4 -Compress)
    
    $pubDir = ''
    $pyCmd = Get-CoopPython
    if ($pyCmd) {
      $pubDir = (& $pyCmd -c "import os, sys; sys.path.insert(0, os.path.join(r'$script:CoopRoot', 'lib')); import _yaml; d = _yaml.load(os.path.expanduser('~/.coop/config')) if os.path.exists(os.path.expanduser('~/.coop/config')) else {}; p = _yaml.dig(d, 'fleet.publish_dir'); print(p or _yaml.dig(_yaml.load(os.path.join(r'$script:CoopRoot', 'config/defaults.yml')), 'fleet.publish_dir') or '')" 2>$null | Out-String).Trim()
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
