#!/usr/bin/env pwsh
#
# coop install / bootstrap (Windows / PowerShell mirror of scripts/install.sh) —
# set up the whole Cooptimize stack on a fresh machine. Idempotent: safe to re-run.
# Non-fatal where it can be (warns and keeps going), so `coop doctor` can report
# whatever is still missing at the end.
#
#   Flags:
#     --force        Reinstall pi tools / pipx packages even if already present
#     --no-fabric    Skip installing the Microsoft Fabric CLI (ms-fabric-cli)
#     --no-prereqs   Skip auto-installing missing system prerequisites
#     --yes, -y      Assume yes for prompts
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, the progress engine
# (Coop-Prog*/Coop-Emit), Test-Have, Get-CoopPython, Coop-Unit, Invoke-CoopScript, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# Keep going so Doctor can present the complete state, but preserve every failed
# convergence unit for the final process result. A warning-only Doctor must not
# turn an unusable install (for example, extension sync failure) into exit 0.
$script:InstallFailures = 0
function Install-Unit {
  param([string]$Label, [scriptblock]$Work, [object[]]$WorkArgs = @())
  Coop-Unit $Label $Work $WorkArgs
  if (-not $script:CoopUnitLastOk) { $script:InstallFailures++ }
}

# Make freshly-installed user/pipx/npm bins visible to the REST of this run (their
# dirs are usually not on PATH until a new shell — which is why a one-pass install
# would otherwise "skip" later steps). Best-effort; never fatal.
function Add-CoopUserPaths {
  # pipx creates ~\.local\bin only when it installs the FIRST tool (steps 4/5), so
  # it may not exist yet here — prepend it unconditionally (a not-yet-existing PATH
  # entry is harmless and goes live once the dir appears). The python user-base dirs
  # hold the pipx launcher itself (from `pip install --user pipx`).
  $pipxBin = (Join-Path $HOME '.local\bin')       # pipx default PIPX_BIN_DIR on Windows
  if (($env:PATH -split ';') -notcontains $pipxBin) { $env:PATH = "$pipxBin;$env:PATH" }
  $py = Get-CoopPython
  if ($py) {
    $base = (& $py -m site --user-base 2>$null)
    if ($base) {
      foreach ($d in @((Join-Path $base 'Scripts'), (Join-Path $base 'bin'))) {
        if (($env:PATH -split ';') -notcontains $d) { $env:PATH = "$d;$env:PATH" }
      }
    }
  }
}
function Add-CoopNpmPath {
  if (-not (Test-Have 'npm')) { return }
  $prefix = (& npm prefix -g 2>$null)
  if ($prefix) {
    foreach ($d in @($prefix, (Join-Path $prefix 'bin'))) {   # win: shims in prefix; unix: prefix/bin
      if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
        $env:PATH = "$d;$env:PATH"
      }
    }
  }
}

# --- Parse flags -------------------------------------------------------------
$FORCE = $false; $NO_FABRIC = $false; $NO_PREREQS = $false; $EDGE = $false
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--force'      { $FORCE = $true }
    '--no-fabric'  { $NO_FABRIC = $true }
    '--no-prereqs' { $NO_PREREQS = $true }
    '--edge'       { $EDGE = $true }
    '--yes'        { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "install: ignoring unknown flag '$a'" } }
  }
}

# --- What we install (release manifest is the single source of truth) ----------
# coop renders its OWN footer/splash via extensions/coop-powerline — no third-party
# powerline footer.
$PI_NPM_PACKAGE = Coop-ManifestGet -Key 'pi.package' -Default '@earendil-works/pi-coding-agent'
$PI_TARGET_VERSION = Coop-ManifestGet -Key 'pi.version'
$PI_EXTENSIONS = @(
  'npm:pi-mcp-adapter',       # MCP servers (Fabric / Power BI / Microsoft Learn)
  'npm:pi-hermes-memory',     # persistent memory + session search + secret scanning
  'npm:pi-better-openai',     # plan usage limits (5h/7d) — shown in coop's footer
  'npm:pi-web-access',        # web search / URL fetch / GitHub clone / PDF / video (read-only)
  'npm:@juicesharp/rpiv-ask-user-question', # structured questions the model can ask (consent rounds)
  'npm:context-mode'
)
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
$FABRIC_PKG = 'ms-fabric-cli'
# Microsoft Fabric/Power BI authoring CLI packages (npm). powerbi-desktop-bridge
# requires Power BI Desktop on Windows, so it is installed only there.
$PBIH_NPM_TOOLS = @('@microsoft/powerbi-report-authoring-cli', '@microsoft/powerbi-modeling-mcp')
if ($env:OS -eq 'Windows_NT') { $PBIH_NPM_TOOLS += '@microsoft/powerbi-desktop-bridge-cli' }

# Install/operate against coop's ISOLATED Pi agent dir (mirror of coop_pi_agent_dir).
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir
New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null

$OS = 'Windows'

# Overall-bar denominator: the install ITEMS we attempt (pipx + pi + each extension
# + each coop tool + Power BI/Fabric authoring tools, plus Fabric unless --no-fabric).
$TOTAL = 2 + $PI_EXTENSIONS.Count + $PY_TOOLS.Count + 1
if (-not $NO_FABRIC) { $TOTAL += 1 }

# --- Per-item units (run in a background job; return @{ok=<bool>; msg=<string>}) --
$UnitPipx = {
  if (Get-Command pipx -ErrorAction SilentlyContinue) { return [pscustomobject]@{ ok = $true; msg = 'pipx present' } }
  # Skip a Windows Store App-Execution-Alias stub (under \WindowsApps\, no real python):
  # it makes Get-Command succeed but every pip call returns rc 9009. Self-contained
  # because this scriptblock runs in a background job without the script's functions.
  $py = $null
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and ($c.Source -notmatch '\\WindowsApps\\')) {
      $vv = (& $name --version 2>&1)
      if ($vv -match '\d+\.\d+') { $py = $name; break }
    }
  }
  if (-not $py) { return [pscustomobject]@{ ok = $false; msg = 'skipping pipx (python missing)' } }
  & $py -m pip install --user pipx *> $null; $a = ($LASTEXITCODE -eq 0)
  & $py -m pipx ensurepath          *> $null; $b = ($LASTEXITCODE -eq 0)
  if ($a -and $b) { return [pscustomobject]@{ ok = $true; msg = 'pipx installed (open a new shell for PATH changes)' } }
  return [pscustomobject]@{ ok = $false; msg = 'could not install pipx automatically — see https://pipx.pypa.io' }
}

$UnitPi = {
  param([bool]$Force, [string]$Spec)
  $piCmd = Get-Command pi -ErrorAction SilentlyContinue
  if ($piCmd) {
    $raw = (& pi --version 2>$null | Out-String)
    $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
    $cur = if ($m.Success) { $m.Value } else { '' }
    # Convergence: missing -> install exact; == manifest -> skip;
    # != manifest -> force-install exact; --force -> reinstall exact.
    if (-not $Force -and $cur) {
      if ($EDGE) {
        # Edge means upstream/latest for EXISTING installs too.
        if (Get-Command npm -ErrorAction SilentlyContinue) {
          & npm install -g $PI_NPM_PACKAGE *> $null
          if ($LASTEXITCODE -eq 0) {
            $raw2 = (& pi --version 2>$null | Out-String)
            $m3 = [regex]::Match([string]$raw2, '\d+\.\d+\.\d+')
            return [pscustomobject]@{ ok = $true; msg = "pi updated to latest ($($m3.Value))" }
          }
          return [pscustomobject]@{ ok = $false; msg = "failed to update pi to latest (npm install -g $PI_NPM_PACKAGE)" }
        }
        return [pscustomobject]@{ ok = $false; msg = 'cannot update pi (npm missing) — install Node.js, then re-run: coop install' }
      }
      $expected = $null
      if (-not [string]::IsNullOrEmpty($PI_TARGET_VERSION)) { $expected = $PI_TARGET_VERSION }
      if (-not $expected) { return [pscustomobject]@{ ok = $true; msg = "pi present ($cur) — no manifest pin" } }
      if ($cur -eq $expected) { return [pscustomobject]@{ ok = $true; msg = "pi $cur matches manifest" } }
      if (Get-Command npm -ErrorAction SilentlyContinue) {
        & npm install -g $Spec *> $null
        if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = "pi converged $cur -> $expected" } }
        return [pscustomobject]@{ ok = $false; msg = "failed to converge pi to $Spec — try: npm install -g $Spec" }
      }
      return [pscustomobject]@{ ok = $false; msg = "cannot converge pi (npm missing) — install Node.js, then re-run: coop install" }
    }
  }
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm install -g $Spec *> $null
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = "pi installed ($Spec)" } }
    return [pscustomobject]@{ ok = $false; msg = "npm install of pi failed — try: npm install -g $Spec" }
  }
  return [pscustomobject]@{ ok = $false; msg = "cannot install pi (npm missing) — install Node.js, then re-run: coop install" }
}

$UnitExt = {
  param([string]$Spec)
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = "skipped $Spec (pi not installed)" } }
  & pi install $Spec *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Spec } }
  return [pscustomobject]@{ ok = $false; msg = "could not install $Spec (continuing)" }
}

$UnitFabric = {
  param([bool]$Force, [bool]$Edge, [string]$Pkg, [string]$Target, [string]$Fcc, [string]$Python, [string]$FetchPython)
  $pipxBin = Join-Path $HOME '.local\bin'
  if ((Test-Path -LiteralPath $pipxBin) -and (($env:PATH -split ';') -notcontains $pipxBin)) {
    $env:PATH = "$pipxBin;$env:PATH"
  }
  $runPipx = {
    param([string[]]$PipxArgs)
    if (Get-Command pipx -ErrorAction SilentlyContinue) {
      & pipx @PipxArgs *> $null
      return $LASTEXITCODE
    }
    foreach ($name in @('python3', 'python')) {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
      & $name -m pipx @PipxArgs *> $null
      return $LASTEXITCODE
    }
    return 1
  }
  $runPipxText = {
    param([string[]]$PipxArgs)
    if (Get-Command pipx -ErrorAction SilentlyContinue) {
      return ((& pipx @PipxArgs 2>$null | Out-String))
    }
    foreach ($name in @('python3', 'python')) {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
      return ((& $name -m pipx @PipxArgs 2>$null | Out-String))
    }
    return ''
  }

  $hasPipx = (Get-Command pipx -ErrorAction SilentlyContinue)
  if (-not $hasPipx) {
    foreach ($name in @('python3', 'python')) {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
      & $name -m pipx --version *> $null
      if ($LASTEXITCODE -eq 0) { $hasPipx = $true; break }
    }
  }
  if (-not $hasPipx) { return [pscustomobject]@{ ok = $false; msg = 'skipping Fabric CLI (pipx missing)' } }
  if (-not $Python) { return [pscustomobject]@{ ok = $false; msg = 'Microsoft Fabric CLI needs Python 3.12 or 3.13 — install one, then re-run: coop install' } }

  $installArgs = { param([bool]$WithForce, [string]$Spec)
    $a = @('install')
    if ($WithForce) { $a += '--force' }
    if ($FetchPython) { $a += $FetchPython }
    $a += @('--python', $Python, $Spec)
    return $a
  }

  $target = if ($Target) { $Target } else { $Pkg }
  # Convergence: skip only when the installed version matches the pin.
  $expectedVer = $null
  if ($target -match '==(.+)$') { $expectedVer = $Matches[1] }
  if (-not $Force) {
    $installed = ''
    $listText = (& $runPipxText @('list'))
    if ($listText) {
      $m2 = [regex]::Match([string]$listText, ('(?i)package ' + [regex]::Escape($Pkg) + ' (\d+\.\d+\.\d+)'))
      if ($m2.Success) { $installed = $m2.Groups[1].Value }
    }
    if ($installed) {
      if ($Edge) {
        # Reinstall explicitly so an existing unsupported 3.14 venv is repaired.
        $pipxInstallArgs = & $installArgs $true $target
        $rc = & $runPipx $pipxInstallArgs
        if ($rc -ne 0) { return [pscustomobject]@{ ok = $false; msg = "failed to update $Pkg with Python $Python" } }
      } elseif ($expectedVer -and $installed -ne $expectedVer) {
        $pipxInstallArgs = & $installArgs $true $target
        $rc = & $runPipx $pipxInstallArgs
        if ($rc -ne 0) { return [pscustomobject]@{ ok = $false; msg = "failed to converge $Pkg to $expectedVer" } }
      } elseif ($FetchPython) {
        # A matching package version can still live in an unsupported 3.14 venv.
        $pipxInstallArgs = & $installArgs $true $target
        $rc = & $runPipx $pipxInstallArgs
        if ($rc -ne 0) { return [pscustomobject]@{ ok = $false; msg = "failed to rebuild $Pkg with standalone Python $Python" } }
      }
    } else {
      $pipxInstallArgs = & $installArgs $false $target
      & $runPipx $pipxInstallArgs
    }
  } else {
    $pipxInstallArgs = & $installArgs $true $target
    $rc = & $runPipx $pipxInstallArgs
    if ($rc -ne 0) { return [pscustomobject]@{ ok = $false; msg = "failed to reinstall $Pkg ($target)" } }
  }
  # fabric-cicd is a Python LIBRARY (no CLI) — inject it into the Fabric CLI env.
  $fcc = if ($Fcc) { $Fcc } else { 'fabric-cicd' }
  $injectRc = & $runPipx @('inject', '--force', $Pkg, $fcc)
  if ($injectRc -ne 0) { return [pscustomobject]@{ ok = $false; msg = "failed to inject $fcc into $Pkg" } }
  # A failed convergence must not read as success just because an OLD fab binary
  # is still on PATH — verify the installed version actually matches the pin.
  if (-not $Edge -and $expectedVer) {
    $now = ''
    $listText2 = (& $runPipxText @('list'))
    if ($listText2) {
      $m4 = [regex]::Match([string]$listText2, ('(?i)package ' + [regex]::Escape($Pkg) + ' (\d+\.\d+\.\d+)'))
      if ($m4.Success) { $now = $m4.Groups[1].Value }
    }
    if ($now -ne $expectedVer) {
      $nowDisp = if ($now) { $now } else { 'none' }
      return [pscustomobject]@{ ok = $false; msg = "Fabric CLI remains at $nowDisp; expected $expectedVer" }
    }
  }
  if (Get-Command fab -ErrorAction SilentlyContinue) {
    $fv = ((& fab --version 2>&1) -join ' ')
    if ($fv -match '(?i)paramiko|invoke') {
      return [pscustomobject]@{ ok = $false; msg = "'fab' is Python Fabric (SSH), not Microsoft Fabric CLI — put the pipx Scripts dir first on PATH, then: fab --version" }
    }
    $v = (& fab --version 2>$null | Select-Object -First 1)
    return [pscustomobject]@{ ok = $true; msg = "Microsoft Fabric CLI ready ($v)" }
  }
  $localFab = Join-Path $HOME '.local\bin\fab.exe'
  if (Test-Path -LiteralPath $localFab) {
    $v = (& $localFab --version 2>$null | Select-Object -First 1)
    return [pscustomobject]@{ ok = $true; msg = "Microsoft Fabric CLI ready ($v)" }
  }
  return [pscustomobject]@{ ok = $false; msg = "ms-fabric-cli installed but 'fab' not on PATH yet — open a new shell" }
}

$UnitPytool = {
  param([bool]$Force, [string]$Pkg, [string]$Target)
  $pipxBin = Join-Path $HOME '.local\bin'
  if ((Test-Path -LiteralPath $pipxBin) -and (($env:PATH -split ';') -notcontains $pipxBin)) {
    $env:PATH = "$pipxBin;$env:PATH"
  }
  $runPipx = {
    param([string[]]$PipxArgs)
    if (Get-Command pipx -ErrorAction SilentlyContinue) {
      & pipx @PipxArgs *> $null
      return $LASTEXITCODE
    }
    foreach ($name in @('python3', 'python')) {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
      & $name -m pipx @PipxArgs *> $null
      return $LASTEXITCODE
    }
    return 1
  }
  $runPipxText = {
    param([string[]]$PipxArgs)
    if (Get-Command pipx -ErrorAction SilentlyContinue) {
      return ((& pipx @PipxArgs 2>$null | Out-String))
    }
    foreach ($name in @('python3', 'python')) {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
      return ((& $name -m pipx @PipxArgs 2>$null | Out-String))
    }
    return ''
  }

  $hasPipx = (Get-Command pipx -ErrorAction SilentlyContinue)
  if (-not $hasPipx) {
    foreach ($name in @('python3', 'python')) {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
      & $name -m pipx --version *> $null
      if ($LASTEXITCODE -eq 0) { $hasPipx = $true; break }
    }
  }
  if (-not $hasPipx) { return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing)" } }

  $target = $Pkg
  if (-not $Edge) {
    $ver = Coop-ManifestGet -Key "python_tools.$Pkg"
    if ($ver) { $target = "${Pkg}==${ver}" }
  }
  # Convergence: skip only when the installed version matches the manifest pin.
  if (-not $Force) {
    $installed = ''
    $listText = (& $runPipxText @('list'))
    if ($listText) {
      $m2 = [regex]::Match([string]$listText, ('(?i)package ' + [regex]::Escape($Pkg) + ' (\d+\.\d+\.\d+)'))
      if ($m2.Success) { $installed = $m2.Groups[1].Value }
    }
    if ($installed) {
      if ($Edge) {
        # Edge means upstream/latest for EXISTING installs too.
        $rc = & $runPipx @('upgrade', $Pkg)
        if ($rc -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg updated to latest ($(& $runPipxText @('list') | ForEach-Object { if ($_ -match "(?i)package $Pkg (\d+\.\d+\.\d+)") { $Matches[1] } }))" } }
        return [pscustomobject]@{ ok = $false; msg = "failed to upgrade $Pkg to latest" }
      }
      if (-not $target -match '==') { return [pscustomobject]@{ ok = $true; msg = "$Pkg present ($installed) — no manifest pin" } }
      $expectedVer = $target -replace '.*==', ''
      if ($installed -eq $expectedVer) { return [pscustomobject]@{ ok = $true; msg = "$Pkg $installed matches manifest" } }
      $rc = & $runPipx @('install', '--force', $target)
      if ($rc -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg converged $installed -> $expectedVer" } }
      return [pscustomobject]@{ ok = $false; msg = "failed to converge $Pkg to $target" }
    }
  }
  if ($Force) {
    $rc = & $runPipx @('install', '--force', $target)
    if ($rc -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Pkg } }
    return [pscustomobject]@{ ok = $false; msg = "failed: $Pkg" }
  }
  $rc = & $runPipx @('install', $target)
  if ($rc -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg (installed)" } }
  $rc = & $runPipx @('upgrade', $target)
  if ($rc -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg (up to date)" } }
  return [pscustomobject]@{ ok = $false; msg = "could not install $Pkg" }
}

$UnitPbihTools = {
  param([bool]$Force, [array]$Specs)
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = 'skipping Power BI/Fabric authoring tools (npm missing)' } }
  $ok = 0; $fail = 0
  foreach ($spec in $Specs) {
    if ($Force) {
      & npm install -g $spec *> $null
      if ($LASTEXITCODE -eq 0) { $ok++ } else { $fail++ }
    } else {
      & npm install -g $spec *> $null
      if ($LASTEXITCODE -eq 0) { $ok++ }
      else {
        & npm update -g $spec *> $null
        if ($LASTEXITCODE -eq 0) { $ok++ } else { $fail++ }
      }
    }
  }
  if ($fail -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$ok Power BI/Fabric authoring tool(s) ready" } }
  return [pscustomobject]@{ ok = $false; msg = "$ok installed, $fail failed" }
}

Coop-Head "Cooptimize agent bootstrap (v$($script:CoopVersion))  [$OS]"

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C / errors via finally. Begin is INSIDE the try so an interrupt between
# hiding the cursor and the first loop still reaches the finally.
try {
  Coop-ProgBegin $TOTAL
  # --- 1. Prerequisites (auto-install missing tools if winget is available) --
  Coop-Head '1/9  Prerequisites'

  # Git
  if ((-not (Test-Have 'git')) -and (-not $NO_PREREQS)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Coop-Info 'installing git via winget…'
      & winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
      foreach ($d in (@(
        (Join-Path $env:ProgramFiles 'Git\cmd'),
        (Join-Path $env:ProgramFiles 'Git\bin'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Git\cmd' }),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd')
      ) | Where-Object { $_ })) {
        if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
          $env:PATH = "$d;$env:PATH"
        }
      }
    }
  }
  if (Test-Have 'git') {
    $gv = (& git --version 2>$null | Select-Object -First 1)
    Coop-Ok "git present ($gv)"
  } else {
    Coop-Warn "git not found — install Git from https://git-scm.com (or 'winget install Git.Git')."
  }

  # General Coop tooling can use any current Python 3, but ms-fabric-cli
  # currently requires <3.14. Treat those as separate prerequisites: a machine
  # with only Python 3.14 still needs a compatible interpreter installed
  # alongside it when Fabric support is enabled.
  $needPython = -not (Get-CoopPython)
  $needFabricPython = (-not $NO_FABRIC) -and (-not (Get-CoopFabricPython))
  if (($needPython -or $needFabricPython) -and (-not $NO_PREREQS)) {
    # Ladder: the Python launcher/install manager first (`py install` covers both
    # the classic py.exe and the newer Python install manager), then winget.
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
      Coop-Info 'installing Python 3.12 via the Python manager…'
      & $pyLauncher.Source install 3.12 *> $null
    }
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Coop-Info 'installing Fabric-compatible Python 3.12 via winget…'
      & winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
      foreach ($d in @(
        (Join-Path $env:ProgramFiles 'Python312'),
        (Join-Path $env:ProgramFiles 'Python312\Scripts'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts'),
        (Join-Path $env:ProgramFiles 'Python311'),
        (Join-Path $env:ProgramFiles 'Python311\Scripts'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\Scripts')
      )) {
        if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
          $env:PATH = "$d;$env:PATH"
        }
      }
    }
  }
  $py = Get-CoopPython
  if ($py) {
    $pyv = (& $py --version 2>&1)
    Coop-Ok "python present ($pyv)"
  } else {
    Coop-Warn "python not found — install Python 3.10+ from https://python.org (or 'winget install Python.Python.3.12'). (A Windows Store 'python' stub does not count.)"
  }
  if (-not $NO_FABRIC) {
    $fabricPrereqPython = Get-CoopFabricPython
    if ($fabricPrereqPython) {
      $fabricPyVersion = (& $fabricPrereqPython --version 2>&1)
      Coop-Ok "Fabric-compatible Python present ($fabricPyVersion)"
    } elseif ((Get-Command pipx -ErrorAction SilentlyContinue) -and ((& pipx install --help 2>&1 | Out-String) -match '--fetch-python')) {
      Coop-Info "Fabric-compatible Python will be fetched into pipx's standalone cache"
    } else {
      Coop-Warn "Microsoft Fabric CLI needs Python 3.10–3.13 — upgrade pipx or install Python 3.12, then re-run: coop install"
    }
  }

  # Node.js
  if ((-not (Test-Have 'node')) -and (-not $NO_PREREQS)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Coop-Info 'installing Node.js LTS via winget…'
      & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
      foreach ($d in (@(
        (Join-Path $env:ProgramFiles 'nodejs'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs' }),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
      ) | Where-Object { $_ })) {
        if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
          $env:PATH = "$d;$env:PATH"
        }
      }
    }
  }
  if (Test-Have 'node') {
    $nv = (& node --version 2>$null | Select-Object -First 1)
    Coop-Ok "node present ($nv)"
    if ($nv -match '(\d+)\.(\d+)\.(\d+)') {
      $nver = [version]("{0}.{1}.{2}" -f $matches[1], $matches[2], $matches[3])
      if ($nver -lt [version]'22.19.0') { Coop-Warn "Node $nver is older than Pi's requirement (>= 22.19)" "upgrade Node, or pin Pi's legacy build: npm i -g @earendil-works/pi-coding-agent@legacy-node20" }
    }
  } else {
    Coop-Warn "node not found — install Node.js 22.19+ from https://nodejs.org (needed to install/update pi)."
  }

  # Azure CLI (az)
  if ((-not (Test-Have 'az')) -and (-not $NO_PREREQS)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Coop-Info 'installing Azure CLI via winget…'
      & winget install --id Microsoft.AzureCLI -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
      foreach ($d in (@(
        (Join-Path $env:ProgramFiles 'Microsoft SDKs\Azure\CLI2\wbin'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft SDKs\Azure\CLI2\wbin' }),
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft\Azure CLI\wbin')
      ) | Where-Object { $_ })) {
        if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
          $env:PATH = "$d;$env:PATH"
        }
      }
    }
  }
  if (Test-Have 'az') {
    $azv = (& az --version 2>$null | Select-Object -First 1)
    Coop-Ok "az present ($azv)"
  } else {
    Coop-Warn "az not found — install Azure CLI from https://learn.microsoft.com/cli/azure (or 'winget install Microsoft.AzureCLI')."
  }

  # Tabular Editor CLI (te — cross-platform; BPA reviews run through `te bpa run`)
  if (Test-Have 'te') {
    $tev = (& te --version 2>$null | Select-Object -First 1)
    Coop-Ok "te present ($tev)"
  } else {
    Coop-Warn "Tabular Editor CLI (te) not found (optional; BPA reviews need it — download from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, place in ~/.local/bin or on PATH, then run: te auth login)."
  }

  Install-Unit 'pipx' $UnitPipx
  Add-CoopUserPaths    # make a just-installed pipx + its tool-bin visible this run

  # Resolve exact specs from the release manifest (unless --edge).
  $piSpec = if (-not $EDGE -and $PI_TARGET_VERSION) { "${PI_NPM_PACKAGE}@${PI_TARGET_VERSION}" } else { $PI_NPM_PACKAGE }
  $extSpecs = @()
  foreach ($ext in $PI_EXTENSIONS) {
    $spec = $ext
    if (-not $EDGE) {
      $pkg = if ($ext -match '^npm:(.+)$') { $matches[1] } else { $ext }
      $pinned = Coop-ManifestExtensionSpec $pkg
      if ($pinned) { $spec = $pinned }
    }
    $extSpecs += $spec
  }
  $fabricTarget = if (-not $EDGE) { $tv = Coop-ManifestGet -Key "python_tools.$FABRIC_PKG"; if ($tv) { "${FABRIC_PKG}==${tv}" } else { $FABRIC_PKG } } else { $FABRIC_PKG }
  $fabricCicd = if (-not $EDGE) { $tv = Coop-ManifestObjectGet 'python_tools' 'fabric-cicd'; if ($tv) { "fabric-cicd==${tv}" } else { 'fabric-cicd' } } else { 'fabric-cicd' }
  $fabricPython = Get-CoopFabricPython
  $fabricFetchPython = ''
  if (-not $fabricPython -and (Get-Command pipx -ErrorAction SilentlyContinue)) {
    $pipxInstallHelp = (& pipx install --help 2>&1 | Out-String)
    if ($pipxInstallHelp -match '--fetch-python') {
      $fabricPython = '3.12'
      $fabricFetchPython = '--fetch-python=missing'
    } elseif ($pipxInstallHelp -match '--fetch-missing-python') {
      $fabricPython = '3.12'
      $fabricFetchPython = '--fetch-missing-python'
    }
  }
  $pytoolTargets = @()
  foreach ($pkg in $PY_TOOLS) {
    $pytoolTargets += if (-not $EDGE) { $tv = Coop-ManifestGet -Key "python_tools.$pkg"; if ($tv) { "${pkg}==${tv}" } else { $pkg } } else { $pkg }
  }
  $pbihSpecs = @()
  foreach ($pkg in $PBIH_NPM_TOOLS) {
    $pbihSpecs += if (-not $EDGE) { $tv = Coop-ManifestGet -Key "npm_tools.$pkg"; if ($tv) { "${pkg}@${tv}" } else { $pkg } } else { $pkg }
  }

  # --- 2. Pi itself ----------------------------------------------------------
  Coop-Head '2/9  Pi (@earendil-works/pi-coding-agent)'
  Install-Unit 'pi (@earendil-works/pi-coding-agent)' $UnitPi @($FORCE, $piSpec)
  Add-CoopNpmPath      # make a just-npm-installed `pi` visible to step 3 this run

  # --- 3. Pi extensions ------------------------------------------------------
  Coop-Head '3/9  Pi extensions'
  for ($i = 0; $i -lt $PI_EXTENSIONS.Count; $i++) { Install-Unit $PI_EXTENSIONS[$i] $UnitExt @($extSpecs[$i]) }

  # --- 4. Microsoft Fabric CLI ----------------------------------------------
  Coop-Head '4/9  Microsoft Fabric CLI'
  if ($NO_FABRIC) { Coop-Info 'skipping Microsoft Fabric CLI (--no-fabric)' }
  else { Install-Unit 'Microsoft Fabric CLI' $UnitFabric @($FORCE, $EDGE, $FABRIC_PKG, $fabricTarget, $fabricCicd, $fabricPython, $fabricFetchPython) }

  # --- 5. Python tools (pipx) -----------------------------------------------
  Coop-Head '5/9  Coop tools (pipx)'
  for ($i = 0; $i -lt $PY_TOOLS.Count; $i++) { Install-Unit $PY_TOOLS[$i] $UnitPytool @($FORCE, $PY_TOOLS[$i], $pytoolTargets[$i]) }

  # --- 6. Power BI / Fabric authoring tools (npm) ----------------------------
  Coop-Head '6/9  Power BI / Fabric authoring tools'
  Install-Unit 'Power BI/Fabric authoring tools' $UnitPbihTools @($FORCE, $pbihSpecs)
}
finally {
  Coop-ProgEnd
}

# Offline fleet fixtures exercise the real install units but must stop before
# launcher/PATH/onboarding/Doctor work. This mirrors install.sh's existing seam.
if ($env:COOP_FLEET_TEST_MODE -eq '1') {
  if ($script:InstallFailures -eq 0) { exit 0 } else { exit 1 }
}

# --- 7. Put `coop` on PATH ---------------------------------------------------
Coop-Head "7/9  Link 'coop' onto your PATH"
$LOCALBIN = Join-Path $env:LOCALAPPDATA 'coop\bin'
New-Item -ItemType Directory -Force -Path $LOCALBIN | Out-Null
# Drop a launcher .cmd that forwards to the repo's coop.cmd shim, so `coop` works
# anywhere once $LOCALBIN is on PATH.
#
# Encoding matters: cmd.exe parses batch files in the console OEM code page, NOT
# ASCII/UTF-8. `-Encoding ASCII` mangled any non-ASCII repo path (C:\Users\José\...)
# into '?', so every `coop` failed while install still reported success. Write with
# the OEM encoding and verify the embedded path round-trips; if it can't survive
# the OEM code page, the launcher is broken no matter what we write — warn the
# user to clone coop-agent into an ASCII-safe path (the file is still written).
$shimTarget = Join-Path $script:CoopRoot 'bin\coop.cmd'
$launcher = Join-Path $LOCALBIN 'coop.cmd'
$launcherBody = "@echo off`r`ncall `"$shimTarget`" %*`r`n"
$oemEnc = [System.Text.Encoding]::GetEncoding(
  [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
$existing = if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  [System.IO.File]::ReadAllText($launcher, $oemEnc)
} else { '' }
if ($existing -ne $launcherBody) {
  [System.IO.File]::WriteAllText($launcher, $launcherBody, $oemEnc)
  $roundTrip = [System.IO.File]::ReadAllText($launcher, $oemEnc)
  if ($roundTrip -eq $launcherBody) {
    Coop-Ok "linked $launcher -> bin\coop.cmd"
  } else {
    Coop-Warn "the repo path '$($script:CoopRoot)' contains characters that don't survive the console (OEM) code page — the coop launcher on PATH will NOT work. Clone coop-agent into an ASCII-safe path (e.g. C:\coop-agent) and re-run install."
  }
} else {
  Coop-Ok 'coop already linked'
}
if (($env:PATH -split ';') -notcontains $LOCALBIN) {
  # Add the launcher dir to the persistent USER PATH (idempotent) so coop works in every
  # shell — not just warn. Read/write the RAW user PATH via the registry as an
  # ExpandString, so any %VAR% tokens already in it stay dynamic ([Environment]::
  # SetEnvironmentVariable would expand and freeze them into REG_SZ). Also prepend it to
  # THIS process so the rest of the install + doctor can call coop now; new terminals
  # pick up the persistent change. NeedNewShell is set ONLY on success, so a failed
  # write doesn't produce a misleading "coop was just added to your PATH" at the end.
  try {
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $userPath = if ($envKey) {
      [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } else { '' }
    if (($userPath -split ';') -notcontains $LOCALBIN) {
      $newUserPath = (@($userPath, $LOCALBIN) | Where-Object { $_ }) -join ';'
      if ($envKey) { $envKey.SetValue('Path', $newUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
      # A raw registry SetValue does NOT notify anyone. Setting a User env var via
      # [Environment]::SetEnvironmentVariable DOES broadcast WM_SETTINGCHANGE, so open
      # terminals/Explorer refresh their environment and actually see the new PATH
      # (otherwise "open a new terminal" wouldn't help until a logoff). Set + clear a
      # throwaway var so we trigger the broadcast without leaving residue or touching PATH.
      [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', '1', 'User')
      [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', $null, 'User')
      Coop-Ok "added $LOCALBIN to your user PATH (open a new terminal so coop is found there)"
      $script:NeedNewShell = $true
    }
    if ($envKey) { $envKey.Close() }
    $env:PATH = "$LOCALBIN;$env:PATH"
  } catch {
    Coop-Warn "couldn't update PATH automatically — add $LOCALBIN to your user PATH (System Properties > Environment Variables), then open a new terminal."
  }
}

# --- Double-click launcher (Start Menu + Desktop shortcut) -------------------
# A friendly front door so members who aren't comfortable in a terminal can open
# coop by double-clicking an icon. PURELY ADDITIVE: `coop` in any terminal is
# unchanged. The shortcut points at bin\coop-desktop.ps1, which finds/installs
# coop, runs it, and keeps the window open on error. Best-effort — a failure here
# never fails the install (you can always run coop from a terminal).
$desktopLauncher = Join-Path $script:CoopRoot 'bin\coop-desktop.ps1'
if (Test-Path -LiteralPath $desktopLauncher) {
  try {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $icon  = Join-Path $script:CoopRoot 'themes\coop.ico'
    $ws = New-Object -ComObject WScript.Shell
    # Two shortcuts, each on the Start Menu + Desktop:
    #   coop            -> the friendly chat window (`coop web`, ChatGPT-style; the
    #                      server console starts minimized so the chat is the star —
    #                      closing that minimized window stops coop)
    #   coop (terminal) -> the classic terminal agent, for people who prefer it
    $shortcuts = @(
      @{ Name = 'coop.lnk';            ExtraArgs = ' web'; Window = 7; Desc = 'coop - chat with the Cooptimize analytics agent' },
      @{ Name = 'coop (terminal).lnk'; ExtraArgs = '';     Window = 1; Desc = 'coop - the Cooptimize analytics agent (terminal)' }
    )
    foreach ($def in $shortcuts) {
      foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        $sc = $ws.CreateShortcut((Join-Path $dir $def.Name))
        $sc.TargetPath       = $psExe
        $sc.Arguments        = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncher`"$($def.ExtraArgs)"
        $sc.WorkingDirectory = $HOME
        $sc.Description       = $def.Desc
        $sc.WindowStyle       = $def.Window
        # ',0' = explicit icon index; some shells show a generic icon without it.
        if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
        $sc.Save()
      }
    }
    Coop-Ok 'created double-click launchers (Start Menu + Desktop): "coop" (chat window) and "coop (terminal)"'
  } catch {
    Coop-Warn "couldn't create the double-click launcher (you can still run coop in a terminal): $($_.Exception.Message)"
  }
}

# --- 8. First-run onboarding -----------------------------------------------------
# If this is an interactive install and there's no local profile yet, ask the user
# for their name and communication preference before the first real session.
if (-not [Console]::IsInputRedirected -and $env:COOP_NO_ONBOARD -ne '1') {
  Coop-Head '8/9  Personalize Coop'
  Invoke-CoopMaybeOnboard
}

# --- 9. Sync, model sign-in, and doctor ---------------------------------------
Coop-Head '9/9  Sync assets, sign in, and run doctor'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues'; $script:InstallFailures++ }

# Finish a fresh interactive setup inside the real Pi /login UI. coop-tools
# primes the built-in command and, in login-only mode, returns here as soon as Pi
# persists the credential. Non-interactive automation and explicit opt-outs keep
# the previous behavior and receive doctor's normal login hint instead.
if ($script:InstallFailures -eq 0 -and
    -not [Console]::IsInputRedirected -and
    -not [Console]::IsOutputRedirected -and
    $env:COOP_NO_MODEL_LOGIN -ne '1' -and
    -not (Test-CoopPiLoginPresent)) {
  Coop-Head 'Final setup  Sign in to the model'
  Coop-Say 'Press Enter on the prepared /login command, then complete the browser sign-in'
  Coop-Say 'with your Cooptimize OpenAI account. Coop will return here automatically.'
  $oldPrime = $env:COOP_PRIME_MODEL_LOGIN
  $oldLoginOnly = $env:COOP_LOGIN_ONLY
  $env:COOP_PRIME_MODEL_LOGIN = '1'
  $env:COOP_LOGIN_ONLY = '1'
  $loginRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'bin\coop.ps1')
  if ($null -eq $oldPrime) { Remove-Item Env:COOP_PRIME_MODEL_LOGIN -ErrorAction SilentlyContinue } else { $env:COOP_PRIME_MODEL_LOGIN = $oldPrime }
  if ($null -eq $oldLoginOnly) { Remove-Item Env:COOP_LOGIN_ONLY -ErrorAction SilentlyContinue } else { $env:COOP_LOGIN_ONLY = $oldLoginOnly }
  if (Test-CoopPiLoginPresent) {
    Coop-Ok 'model sign-in saved — Coop is ready'
  } else {
    Coop-Warn 'model sign-in did not finish — run: coop   (the /login command will be ready)'
    if ($loginRc -ne 0) { Coop-Warn "the sign-in session exited with code $loginRc" }
    $script:InstallFailures++
  }
}

[Console]::Error.WriteLine('')
# Propagate doctor's verdict as the install's exit code (mirror of install.sh): a
# genuinely broken install (a required dep still missing → doctor exits 1) is then
# detectable by whatever ran `coop install`, incl. the double-click launcher wrapper.
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')

[Console]::Error.WriteLine('')
# Close on doctor's verdict (mirror of install.sh): a green "complete" line after a
# failed doctor would bury the real state — on failure, point back at the ✗ items.
$installRc = if (($doctorRc -ne 0) -or ($script:InstallFailures -gt 0)) { 1 } else { 0 }
if ($installRc -ne 0) {
  if ($script:InstallFailures -gt 0) { Coop-Warn "$($script:InstallFailures) install/sync step(s) failed — review the ! items above" }
  if ($doctorRc -ne 0) {
    Coop-Warn "Bootstrap finished, but doctor reported problems — fix the $($script:G_CROSS) items above, then re-run: coop doctor"
  } else {
    Coop-Warn 'Bootstrap is incomplete — fix the failed steps above, then re-run: coop install'
  }
} elseif ($script:NeedNewShell) {
  Coop-Ok 'Bootstrap complete. coop was just added to your PATH.'
} else {
  Coop-Ok 'Bootstrap complete. Coop is ready — start it with:  coop'
}
if ($script:NeedNewShell) {
  Coop-Say "      Open a NEW terminal, then run:  coop"
  Coop-Say "      (or use it right now in this window:  & `"$LOCALBIN\coop.cmd`")"
}
exit $installRc
