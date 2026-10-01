#!/usr/bin/env pwsh
#
# coop install / bootstrap —
# set up the whole Cooptimize stack on a fresh machine. Idempotent: safe to re-run.
# Non-fatal where it can be (warns and keeps going), so `coop doctor` can report
# whatever is still missing at the end.
#
#   Flags:
#     --force        Reinstall Pi / pipx / npm tools even if already at their pins
#     --edge         Upstream latest for Pi and the tools (extensions stay pinned)
#     --no-fabric    Skip installing the Microsoft Fabric CLI (ms-fabric-cli)
#     --no-prereqs   Report missing prerequisites but continue anyway
#     --prereqs auto Install missing prerequisites visibly (winget), then stop
#                    and ask for a new terminal
#     --yes, -y      Assume yes for prompts
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 ---------------------------------
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
  # pipx creates ~\.local\bin only when it installs the FIRST tool (steps 3/4), so
  # it may not exist yet here — prepend it unconditionally (a not-yet-existing PATH
  # entry is harmless and goes live once the dir appears). The pipx launcher itself
  # (from `pip install --user pipx`) lands in the VERSIONED per-user Scripts dir —
  # %APPDATA%\Python\Python312\Scripts — so `site --user-base`\Scripts points at a
  # dir that does not exist; ask sysconfig for the real nt_user scripts path.
  $pipxBin = (Join-Path $HOME '.local\bin')       # pipx default PIPX_BIN_DIR on Windows
  if (($env:PATH -split ';') -notcontains $pipxBin) { $env:PATH = "$pipxBin;$env:PATH" }
  $py = Get-CoopPython
  if ($py) {
    $scripts = (& $py -c "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))" 2>$null)
    if ($scripts -and (($env:PATH -split ';') -notcontains $scripts)) {
      $env:PATH = "$scripts;$env:PATH"
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
$FORCE = $false; $NO_FABRIC = $false; $NO_PREREQS = $false; $EDGE = $false; $PREREQS_AUTO = $false
# --platform <fabric|azure_sql|both> answers the client platform question (master
# plan section 8 item 7) without a prompt: onboarding reads COOP_CLIENT_PLATFORM,
# and step 8 saves it even when onboarding does not run (non-interactive install).
function Set-CoopInstallPlatform([string]$Value) {
  if ($Value -cin @('fabric', 'azure_sql', 'both')) { $env:COOP_CLIENT_PLATFORM = $Value }
  else { Coop-Warn "install: --platform takes one value: fabric, azure_sql or both (got '$Value')" }
}
for ($ai = 0; $ai -lt $args.Count; $ai++) {
  $a = $args[$ai]
  if ($a -is [string] -and $a.StartsWith('--platform=')) { Set-CoopInstallPlatform $a.Substring(11); continue }
  switch -CaseSensitive ($a) {
    '--force'      { $FORCE = $true }
    '--no-fabric'  { $NO_FABRIC = $true }
    '--no-prereqs' { $NO_PREREQS = $true }
    '--prereqs=auto' { $PREREQS_AUTO = $true }
    '--prereqs'    { $ai++; if ($ai -lt $args.Count -and $args[$ai] -eq 'auto') { $PREREQS_AUTO = $true } else { Coop-Warn "install: --prereqs takes one value: auto" } }
    '--platform'   { $ai++; if ($ai -lt $args.Count) { Set-CoopInstallPlatform ([string]$args[$ai]) } else { Coop-Warn "install: --platform takes one value: fabric, azure_sql or both" } }
    '--edge'       { $EDGE = $true }
    '--yes'        { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "install: ignoring unknown flag '$a'" } }
  }
}

# --- What we install: the release manifest, through Get-CoopFleetPlan ----------
# One manifest-driven plan (lib/common.ps1) feeds install, update, sync and
# uninstall: Pi, the extensions (converged by the sync child in the last step),
# the Coop tools and the Fabric CLI (pipx) and the Power BI / Fabric authoring
# tools (npm; powerbi-desktop-bridge only on Windows). --edge drops the Pi and
# tool pins (upstream latest); extensions stay pinned. coop renders its OWN
# footer/splash via extensions/coop-powerline — no third-party powerline footer.
$PLAN = Get-CoopFleetPlan -Edge:$EDGE -NoFabric:$NO_FABRIC

# Install/operate against coop's ISOLATED Pi agent dir (Get-CoopPiAgentDir).
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir
New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null

$OS = 'Windows'

# Overall-bar denominator: the install ITEMS we attempt (pipx + pi + each coop
# tool + Power BI/Fabric authoring tools, plus Fabric unless --no-fabric). The
# extensions converge in the sync child (step 8), outside the bar.
$TOTAL = 2 + @($PLAN.PythonTools).Count + 1
if ($PLAN.Fabric) { $TOTAL += 1 }

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

# Every other item is a convergence function in lib/common.ps1 (Invoke-CoopPiConverge,
# Invoke-CoopFabricCliConverge, Invoke-CoopPipxConverge, Invoke-CoopNpmToolsConverge),
# run through $script:CoopConvergeUnit: the job's fresh runspace dot-sources the
# library and every input arrives as an argument (#213). `coop update` runs the
# same functions, so install and update cannot drift apart (master plan S2).

# --- Prerequisite gate (plan H1) ----------------------------------------------
# Print the prerequisite table; returns how many REQUIRED rows are missing.
function Show-CoopPrereqs([object[]]$Rows) {
  $missing = 0
  foreach ($r in $Rows) {
    $line = "$($r.Order). $($r.Name)" + $(if ($r.Detail) { "  ($($r.Detail))" } else { '' })
    if ($r.Ok) { Coop-Ok $line; continue }
    if ($r.Required) { Coop-Err $line; $missing++ } else { Coop-Warn $line }
    foreach ($step in ($r.Fix -split ' then ')) { Coop-Say "      $step" }
  }
  return $missing
}

# --prereqs auto: run each missing REQUIRED row's printed command, in table order,
# with its output and exit code visible. Optional rows are never auto-installed.
function Invoke-CoopPrereqInstall([object[]]$Rows) {
  foreach ($r in $Rows) {
    if ($r.Ok -or -not $r.Required -or $r.Fix -like 'see *') { continue }
    foreach ($step in ($r.Fix -split ' then ')) {
      Coop-Info "running: $step"
      if ($env:OS -eq 'Windows_NT') {
        $parts = @($step -split ' ')
        if (-not (Test-Have $parts[0])) { Coop-Warn "$($parts[0]) is not available" "run it yourself: $step"; break }
        & $parts[0] @($parts | Select-Object -Skip 1)
      } else {
        & sh -c $step
      }
      if ($LASTEXITCODE -ne 0) { Coop-Warn "exited with code $LASTEXITCODE" "run it yourself: $step"; break }
    }
  }
  # Re-read PATH from the registry so the re-check can see what was just
  # installed, plus the Python install manager's bin dir (not always on PATH).
  if ($env:OS -eq 'Windows_NT') {
    foreach ($scope in @('Machine', 'User')) {
      foreach ($d in ([string][Environment]::GetEnvironmentVariable('Path', $scope) -split ';')) {
        if ($d -and (($env:PATH -split ';') -notcontains $d)) { $env:PATH = "$env:PATH;$d" }
      }
    }
    $pyManager = Join-Path $env:LOCALAPPDATA 'Python\bin'
    if ((Test-Path -LiteralPath $pyManager) -and (($env:PATH -split ';') -notcontains $pyManager)) { $env:PATH = "$pyManager;$env:PATH" }
  }
}

Coop-Head "Cooptimize agent bootstrap (v$($script:CoopVersion))  [$OS]"

# Check every prerequisite before installing anything. A missing required row
# stops here with the exact command, instead of failing several steps later.
Coop-Head '1/8  Prerequisites'
$prereqRows = Get-CoopPrereqs $NO_FABRIC
$prereqMissing = Show-CoopPrereqs $prereqRows
# The command that re-runs this install. A first install stops here, before step 6
# links `coop` onto PATH, so until then name Install coop.cmd and the clone's own
# launcher (#112). Checked before --prereqs auto can widen PATH.
$installCmd = 'coop install'
$rerunHint = 'run: coop install'
if (-not (Test-Have 'coop')) {
  $installCmd = "& `"$(Join-Path $script:CoopRoot 'bin\coop.cmd')`" install"
  $rerunHint = "double-click Install coop.cmd again (or run: $installCmd)"
}
if ($prereqMissing -gt 0 -and $PREREQS_AUTO -and -not $NO_PREREQS) {
  Invoke-CoopPrereqInstall $prereqRows
  Coop-Head 'Prerequisites (re-checked)'
  $prereqMissing = Show-CoopPrereqs (Get-CoopPrereqs $NO_FABRIC)
  if ($prereqMissing -gt 0) { Coop-Err "$prereqMissing required prerequisite(s) still missing — install the $($script:G_CROSS) rows above in that order." }
  Coop-Warn "Open a NEW terminal so the new tools are on PATH, then $rerunHint"
  exit 1
}
if ($prereqMissing -gt 0) {
  if ($NO_PREREQS) {
    Coop-Warn "$prereqMissing required prerequisite(s) missing (--no-prereqs: continuing anyway)"
  } else {
    Coop-Err "$prereqMissing required prerequisite(s) missing. Install the $($script:G_CROSS) rows above in that order, open a NEW terminal, then $rerunHint"
    Coop-Say "      (or let coop run those commands for you: $installCmd --prereqs auto)"
    exit 1
  }
} else {
  Coop-Ok 'all prerequisites present, continuing'
}
# A Python found off PATH (install manager, winget user scope) must be visible to
# the pipx and Fabric steps in this same run.
$gatePython = if (-not $NO_FABRIC) { Get-CoopFabricBootstrapPython } else { $null }
if ($gatePython -and [System.IO.Path]::IsPathRooted($gatePython)) {
  $gatePyDir = Split-Path -Parent $gatePython
  if (($env:PATH -split [System.IO.Path]::PathSeparator) -notcontains $gatePyDir) { $env:PATH = "$gatePyDir$([System.IO.Path]::PathSeparator)$env:PATH" }
}

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C / errors via finally. Begin is INSIDE the try so an interrupt between
# hiding the cursor and the first loop still reaches the finally.
try {
  Coop-ProgBegin $TOTAL
  Install-Unit 'pipx' $UnitPipx
  Add-CoopUserPaths    # make a just-installed pipx + its tool-bin visible this run

  # A local 3.10-3.13, or pipx's standalone 3.12 (Get-CoopFabricPipxPlan, shared
  # with update and doctor --fix). $null leaves $fabricPython empty and the unit
  # reports what to install.
  $fabricPlan = if ($PLAN.Fabric) { Get-CoopFabricPipxPlan } else { $null }
  $fabricPython = if ($fabricPlan) { $fabricPlan.Python } else { '' }
  $fabricFetchPython = if ($fabricPlan) { $fabricPlan.FetchFlag } else { '' }

  # --- 2. Pi itself ----------------------------------------------------------
  # Same busy guard as update: never converge Pi in place under a running session.
  Coop-Head "2/8  Pi ($($PLAN.PiPackage))"
  if (Test-CoopPiConvergeAllowed 'coop install') {
    Install-Unit "pi ($($PLAN.PiPackage))" $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopPiConverge', @{ Package = $PLAN.PiPackage; Pin = $PLAN.PiPin; Edge = $EDGE; Force = $FORCE })
  } else {
    $script:InstallFailures++
    $script:ProgDone++
  }
  Add-CoopNpmPath      # make a just-npm-installed `pi` visible to the rest of this run

  # --- 3. Microsoft Fabric CLI ----------------------------------------------
  Coop-Head '3/8  Microsoft Fabric CLI'
  if (-not $PLAN.Fabric) { Coop-Info 'skipping Microsoft Fabric CLI (--no-fabric)' }
  else {
    Install-Unit 'Microsoft Fabric CLI' $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopFabricCliConverge', @{ Package = $PLAN.Fabric.Name; Pin = $PLAN.Fabric.Pin; Edge = $EDGE; Force = $FORCE; Python = $fabricPython; FetchPython = $fabricFetchPython; Command = 'coop install' })
    # A Fabric CLI venv that did not converge is the wrong target for the library
    # injection and the driver check; the unit already counted the failure (#213).
    if (-not $script:CoopUnitLastOk) { Coop-Warn 'skipping the Fabric Python runtime (Fabric CLI did not converge)' }
    elseif (-not (Sync-CoopFabricPythonPackages $EDGE)) { Coop-Warn 'failed to converge the Fabric Python runtime'; $script:InstallFailures++ }
    elseif (-not (Ensure-CoopFabricOdbcDriver (-not $NO_PREREQS))) { Coop-Warn 'Fabric SQL fallback is not ready'; $script:InstallFailures++ }
  }

  # --- 4. Python tools (pipx) -----------------------------------------------
  Coop-Head '4/8  Coop tools (pipx)'
  foreach ($tool in $PLAN.PythonTools) {
    Install-Unit $tool.Name $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopPipxConverge', @{ Package = $tool.Name; Pin = $tool.Pin; Edge = $EDGE; Force = $FORCE })
  }

  # --- 5. Power BI / Fabric authoring tools (npm) ----------------------------
  Coop-Head '5/8  Power BI / Fabric authoring tools'
  Install-Unit 'Power BI/Fabric authoring tools' $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopNpmToolsConverge', @{ Names = [string[]]@($PLAN.NpmTools | ForEach-Object { $_.Name }); Pins = [string[]]@($PLAN.NpmTools | ForEach-Object { $_.Pin }); Edge = $EDGE; Force = $FORCE })
}
finally {
  Coop-ProgEnd
}

# --- 6. Put `coop` on PATH ---------------------------------------------------
Coop-Head "6/8  Link 'coop' onto your PATH"
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
  if (Test-CoopProfileRedirected) {
    # An isolated install (HOME / USERPROFILE redirected at a sandbox) must not
    # touch the real account's persistent PATH in the registry: the sandbox is on
    # PATH for this run only, and the sandbox's own shell env block keeps it there.
    Coop-Info "isolated profile ($(Get-CoopProfileInUse)): leaving your user PATH alone; $LOCALBIN is on PATH for this run only"
    $env:PATH = "$LOCALBIN;$env:PATH"
  } else {
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
}

# --- Double-click launcher (Start Menu + Desktop shortcut) -------------------
# A friendly front door so members who aren't comfortable in a terminal can open
# coop by double-clicking an icon. PURELY ADDITIVE: `coop` in any terminal is
# unchanged. Best-effort — a failure here never fails the install (you can always
# run coop from a terminal). The helper lives in lib/common.ps1 so update repairs
# shortcuts too. An isolated install (redirected profile) gets its shortcuts inside
# the sandbox profile, never on the real Desktop / Start Menu.
try {
  if (Set-CoopDesktopShortcuts) {
    $where = if (Test-CoopProfileRedirected) { "in the isolated profile $(Get-CoopProfileInUse)" } else { 'Start Menu + Desktop' }
    Coop-Ok "created the `"coop`" double-click launcher ($where)"
  }
} catch {
  Coop-Warn "couldn't create the double-click launcher (you can still run coop in a terminal): $($_.Exception.Message)"
}

# --- 7. First-run onboarding -----------------------------------------------------
# If this is an interactive install and there's no local profile yet, ask the user
# for their name and communication preference before the first real session.
if (-not [Console]::IsInputRedirected -and $env:COOP_NO_ONBOARD -ne '1') {
  Coop-Head '7/8  Personalize Coop'
  Invoke-CoopMaybeOnboard
}
# --platform is kept even when onboarding did not run (non-interactive or
# COOP_NO_ONBOARD): the first interactive launch then skips that question.
if ($env:COOP_CLIENT_PLATFORM -and ((Get-CoopClientPlatform) -cne $env:COOP_CLIENT_PLATFORM)) {
  $platPy = Get-CoopPython
  $platSaved = $false
  if ($platPy) {
    & $platPy (Join-Path $script:CoopRoot 'scripts\onboard.py') platform --set $env:COOP_CLIENT_PLATFORM | Out-Null
    $platSaved = ($LASTEXITCODE -eq 0)
  }
  if ($platSaved) { Coop-Ok "client platform saved: $($env:COOP_CLIENT_PLATFORM)" }
  else { Coop-Warn "could not save the client platform; run: coop onboard --platform $($env:COOP_CLIENT_PLATFORM)" }
}

# --- 8. Sync (extensions), model sign-in, and doctor ---------------------------------------
Coop-Head '8/8  Sync extensions and assets, sign in, and run doctor'
$priorSkipFabricSync = $env:COOP_SKIP_FABRIC_SYNC
$env:COOP_SKIP_FABRIC_SYNC = '1' # Fabric was converged (or explicitly skipped) above.
# The sync child is the ONE extension convergence path (Sync-CoopExtensionFleet):
# the manifest's extensions at their pins, the lockfile, the pi-ai/pi-tui
# alignment and the postconditions. Install itself never runs `pi install`.
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($null -eq $priorSkipFabricSync) { Remove-Item Env:COOP_SKIP_FABRIC_SYNC -ErrorAction SilentlyContinue } else { $env:COOP_SKIP_FABRIC_SYNC = $priorSkipFabricSync }
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
# Propagate doctor's verdict as the install's exit code: a
# genuinely broken install (a required dep still missing → doctor exits 1) is then
# detectable by whatever ran `coop install`, incl. the double-click launcher wrapper.
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')

[Console]::Error.WriteLine('')
# Close on doctor's verdict: a green "complete" line after a
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
