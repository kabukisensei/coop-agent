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
#     --yes, -y      Assume yes for prompts
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, the progress engine
# (Coop-Prog*/Coop-Emit), Test-Have, Get-CoopPython, Coop-Unit, Invoke-CoopScript, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

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
$FORCE = $false; $NO_FABRIC = $false
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--force'     { $FORCE = $true }
    '--no-fabric' { $NO_FABRIC = $true }
    '--yes'       { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "install: ignoring unknown flag '$a'" } }
  }
}

# --- What we install (keep in sync with config/defaults.yml) ------------------
# coop renders its OWN footer/splash via extensions/coop-powerline — no third-party
# powerline footer.
$PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent'
$PI_EXTENSIONS = @(
  'npm:pi-mcp-adapter',       # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  'npm:pi-hermes-memory',     # persistent memory + session search + secret scanning
  'npm:pi-better-openai',     # plan usage limits (5h/7d) — shown in coop's footer
  'npm:pi-web-access',        # web search / URL fetch / GitHub clone / PDF / video (read-only)
  'npm:@juicesharp/rpiv-ask-user-question'  # structured questions the model can ask (consent rounds)
)
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
$FABRIC_PKG = 'ms-fabric-cli'

# Install/operate against coop's ISOLATED Pi agent dir (mirror of coop_pi_agent_dir).
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir
New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null

$OS = 'Windows'

# Overall-bar denominator: the install ITEMS we attempt (pipx + pi + each extension
# + each coop tool, plus Fabric unless --no-fabric).
$TOTAL = 2 + $PI_EXTENSIONS.Count + $PY_TOOLS.Count
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
  param([bool]$Force, [string]$Pkg)
  if ((Get-Command pi -ErrorAction SilentlyContinue) -and -not $Force) {
    $v = (& pi --version 2>$null); if (-not $v) { $v = '?' }
    return [pscustomobject]@{ ok = $true; msg = "pi present ($v)" }
  }
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm install -g $Pkg *> $null
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = 'pi installed' } }
    return [pscustomobject]@{ ok = $false; msg = "npm install of pi failed — try: npm install -g $Pkg" }
  }
  return [pscustomobject]@{ ok = $false; msg = "cannot install pi (npm missing) — install Node.js, then re-run: coop install" }
}

$UnitExt = {
  param([string]$Ext)
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = "skipped $Ext (pi not installed)" } }
  & pi install $Ext *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Ext } }
  return [pscustomobject]@{ ok = $false; msg = "could not install $Ext (continuing)" }
}

$UnitFabric = {
  param([bool]$Force, [string]$Pkg)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = 'skipping Fabric CLI (pipx missing)' } }
  if ($Force) { & pipx install --force $Pkg *> $null }
  else { & pipx install $Pkg *> $null; if ($LASTEXITCODE -ne 0) { & pipx upgrade $Pkg *> $null } }
  # fabric-cicd is a Python LIBRARY (no CLI) — inject it into the Fabric CLI env.
  # (doctor verifies it separately; we don't claim success here unless `fab` works.)
  & pipx inject $Pkg fabric-cicd *> $null
  if (Get-Command fab -ErrorAction SilentlyContinue) {
    $fv = ((& fab --version 2>&1) -join ' ')
    if ($fv -match '(?i)paramiko|invoke') {
      return [pscustomobject]@{ ok = $false; msg = "'fab' is Python Fabric (SSH), not Microsoft Fabric CLI — put the pipx Scripts dir first on PATH, then: fab --version" }
    }
    $v = (& fab --version 2>$null | Select-Object -First 1)
    return [pscustomobject]@{ ok = $true; msg = "Microsoft Fabric CLI ready ($v)" }
  }
  return [pscustomobject]@{ ok = $false; msg = "ms-fabric-cli installed but 'fab' not on PATH yet — open a new shell" }
}

$UnitPytool = {
  param([bool]$Force, [string]$Pkg)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing)" } }
  if ($Force) {
    & pipx install --force $Pkg *> $null
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Pkg } }
    return [pscustomobject]@{ ok = $false; msg = "failed: $Pkg" }
  }
  & pipx install $Pkg *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg (installed)" } }
  & pipx upgrade $Pkg *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg (up to date)" } }
  return [pscustomobject]@{ ok = $false; msg = "could not install $Pkg" }
}

Coop-Head "Cooptimize agent bootstrap (v$($script:CoopVersion))  [$OS]"

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C / errors via finally. Begin is INSIDE the try so an interrupt between
# hiding the cursor and the first loop still reaches the finally.
try {
  Coop-ProgBegin $TOTAL
  # --- 1. Prerequisites ------------------------------------------------------
  Coop-Head '1/7  Prerequisites'
  if (-not (Test-Have 'git'))  { Coop-Warn "git not found — install Git from https://git-scm.com (or 'winget install Git.Git')." }
  if (-not (Get-CoopPython)) { Coop-Warn "python not found — install Python 3.10+ from https://python.org (or 'winget install Python.Python.3.12'). (A Windows Store 'python' stub does not count.)" }
  if (-not (Test-Have 'node')) { Coop-Warn "node not found — install Node.js 22.19+ from https://nodejs.org (needed to install/update pi)." }
  Coop-Unit 'pipx' $UnitPipx
  Add-CoopUserPaths    # make a just-installed pipx + its tool-bin visible this run

  # --- 2. Pi itself ----------------------------------------------------------
  Coop-Head '2/7  Pi (@earendil-works/pi-coding-agent)'
  Coop-Unit 'pi (@earendil-works/pi-coding-agent)' $UnitPi @($FORCE, $PI_NPM_PACKAGE)
  Add-CoopNpmPath      # make a just-npm-installed `pi` visible to step 3 this run

  # --- 3. Pi extensions ------------------------------------------------------
  Coop-Head '3/7  Pi extensions'
  foreach ($ext in $PI_EXTENSIONS) { Coop-Unit $ext $UnitExt @($ext) }

  # --- 4. Microsoft Fabric CLI ----------------------------------------------
  Coop-Head '4/7  Microsoft Fabric CLI (fab)'
  if ($NO_FABRIC) { Coop-Warn 'skipped (--no-fabric)' }
  else { Coop-Unit 'Microsoft Fabric CLI' $UnitFabric @($FORCE, $FABRIC_PKG) }

  # --- 5. Standalone Coop tools ----------------------------------------------
  Coop-Head '5/7  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)'
  foreach ($pkg in $PY_TOOLS) { Coop-Unit $pkg $UnitPytool @($FORCE, $pkg) }
}
finally {
  Coop-ProgEnd
}

# --- 6. Put `coop` on PATH ---------------------------------------------------
Coop-Head "6/7  Link 'coop' onto your PATH"
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
    }
    if ($envKey) { $envKey.Close() }
    $env:PATH = "$LOCALBIN;$env:PATH"
    $script:NeedNewShell = $true
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

# --- 7. Sync brand assets + doctor ------------------------------------------
Coop-Head '7/7  Sync assets and run doctor'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }
[Console]::Error.WriteLine('')
# Propagate doctor's verdict as the install's exit code (mirror of install.sh): a
# genuinely broken install (a required dep still missing → doctor exits 1) is then
# detectable by whatever ran `coop install`, incl. the double-click launcher wrapper.
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')

[Console]::Error.WriteLine('')
# Close on doctor's verdict (mirror of install.sh): a green "complete" line after a
# failed doctor would bury the real state — on failure, point back at the ✗ items.
if ($doctorRc -ne 0) {
  Coop-Warn "Bootstrap finished, but doctor reported problems — fix the $($script:G_CROSS) items above, then re-run: coop doctor"
} elseif ($script:NeedNewShell) {
  Coop-Ok 'Bootstrap complete. coop was just added to your PATH.'
} else {
  Coop-Ok 'Bootstrap complete. Start the agent with:  coop'
}
if ($script:NeedNewShell) {
  Coop-Say "      Open a NEW terminal, then run:  coop"
  Coop-Say "      (or use it right now in this window:  & `"$LOCALBIN\coop.cmd`")"
}
exit $doctorRc
