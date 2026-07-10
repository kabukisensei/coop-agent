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
foreach ($a in $args) {
  if ($a -eq '--fix') { $script:FIX = $true }
  elseif ($a -eq '--json') { $script:JSON = $true }
  elseif ($a -eq '-h' -or $a -eq '--help') {
    Coop-Say 'Usage: coop doctor [--fix] [--json]'
    Coop-Say '  --fix   apply safe remediations (sync extensions/MCP/assets, install missing Coop tools), then re-check'
    Coop-Say '  --json  suppress the human report and emit one JSON document on stdout: {"checks":[{name,section,status,hint}...],"fail":N,"warn":N}'
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
$tePath = Get-CoopYamlValue (Find-CoopProjectYml) 'tools.tabular_editor_cli.executable_path' ''
if (-not $tePath -or $tePath -like 'TODO*') {
  if (Test-Have 'TabularEditor.exe') { D-Ok 'Tabular Editor CLI on PATH' }
  else { D-Warn 'Tabular Editor CLI not configured' 'set tools.tabular_editor_cli.executable_path in .coop/project.yml (optional)' }
} else {
  if (Test-Path -LiteralPath $tePath) { D-Ok "Tabular Editor CLI: $tePath" }
  else { D-Warn "Tabular Editor CLI path not found: $tePath" }
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
  foreach ($s in @('fabric', 'powerbi', 'azure-devops', 'microsoft-learn', 'context-mode')) {
    if ($mcpText -match ('(?i)"' + [regex]::Escape($s) + '"')) { D-Ok "  • $s server configured" }
  }
  if ($mcpText -notmatch '(?i)learn\.microsoft\.com|microsoft-learn') {
    D-Warn '  Microsoft Learn MCP not configured' 'coop sync   (adds it read-only)'
  }
  # A synced mcp.json still carries TODO-tenant-id / TODO-org-name seeds (from
  # config/mcp.example.json) until the user fills them in — mirror the project.yml
  # TODO check so a placeholder config never reads as fully green.
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
  $todo = 0
  $projText = (Get-Content -LiteralPath $proj -ErrorAction SilentlyContinue)
  if ($projText) { $todo = ($projText | Select-String -Pattern 'TODO' -SimpleMatch).Count }
  if ($todo -gt 0) { D-Warn "$todo TODO placeholder(s) remain in project.yml" 'edit it before live Fabric/Power BI work' }
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
    foreach ($t in @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')) {
      if (-not (Test-Have $t)) {
        Coop-Info "pipx install $t"
        & pipx install $t *> $null
        # $LASTEXITCODE is meaningful only because `pipx` resolved (guarded above);
        # a missing pipx would be a command-not-found error that *> $null can't
        # suppress, leaving $LASTEXITCODE stale and a false ✓.
        if ($LASTEXITCODE -eq 0) { Coop-Ok "$t installed" } else { Coop-Warn "could not install $t (run: pipx install $t)" }
      }
    }
  } else {
    Coop-Warn 'pipx missing — cannot auto-install the Coop tools (install pipx first: see the hint above)'
  }
  Coop-Info 'Re-checking... (system deps like node/python/pipx + the Fabric CLI install manually — see hints above)'
  [Console]::Error.WriteLine('')
  # Propagate --json so the re-check emits the (final) machine-readable document.
  $reArgs = @(); if ($script:JSON) { $reArgs += '--json' }
  & (Join-Path $script:CoopRoot 'scripts\doctor.ps1') @reArgs
  exit $LASTEXITCODE
}

# --json: one JSON document on stdout (mirror of doctor.sh; ConvertTo-Json handles
# escaping, including any control character a probed tool leaked into a message).
if ($script:JSON) {
  $doc = [ordered]@{ checks = @($script:JsonChecks); fail = $script:FAIL; warn = $script:WARN }
  Write-Output ($doc | ConvertTo-Json -Depth 4 -Compress)
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
