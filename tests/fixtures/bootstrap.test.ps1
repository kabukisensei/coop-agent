#!/usr/bin/env pwsh
# D1k: scripts/bootstrap.ps1, the one command that downloads and runs the coop
# window installer (which carries everything). The dry run prints the four steps
# and changes nothing (any OS); off Windows a real run stops at once with the
# Windows-only line. The documented one-liner names this file at its path on main.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $root 'scripts\bootstrap.ps1'

function Invoke-Bootstrap {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = @('' | & $psExe -NoProfile -ExecutionPolicy Bypass -File $script 2>&1 | ForEach-Object { "$_" })
  $script:bootRc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  return ($lines -join "`n")
}

$saved = Save-Env @('COOP_BOOTSTRAP_DRY_RUN', 'COOP_BOOTSTRAP_NO_LAUNCH')
try {
  $env:COOP_BOOTSTRAP_DRY_RUN = '1'
  Remove-Item Env:\COOP_BOOTSTRAP_NO_LAUNCH -ErrorAction SilentlyContinue
  $out = Invoke-Bootstrap
  foreach ($want in @('1. find the newest coop release on github.com', '2. download its coop window installer, SHA-256 checked', '3. install it once for every account on this computer (this machine; needs an administrator PowerShell); updates then install themselves', '4. open the coop window: its first launch sets up this account from the package', 'dry run (COOP_BOOTSTRAP_DRY_RUN=1): nothing was changed')) {
    if (-not $out.Contains($want)) { Ko "bootstrap dry run is missing: $want" $out }
  }
  if ($bootRc -ne 0) { Ko "bootstrap dry run exited $bootRc" $out }
  if ($fail -eq 0) { Ok 'bootstrap dry run lists the four steps and changes nothing' }

  # The documented form is `irm <url> | iex`: the raw bytes decoded as UTF-8
  # without BOM stripping, then Invoke-Expression. A BOM (or any non-ASCII lead)
  # became a command name on line 1 and printed a red error first (VM check
  # 2026-10-07), so run the dry run exactly that way.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $iexCmd = "Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes('" + ($script -replace "'", "''") + "')))"
  $iexOut = (@('' | & $psExe -NoProfile -ExecutionPolicy Bypass -Command $iexCmd 2>&1 | ForEach-Object { "$_" }) -join "`n")
  $ErrorActionPreference = $eap
  if ($iexOut -match 'is not recognized|CommandNotFound') { Ko 'irm | iex form prints an error before the bootstrap runs' $iexOut }
  elseif (-not $iexOut.Contains('dry run (COOP_BOOTSTRAP_DRY_RUN=1): nothing was changed')) { Ko 'irm | iex form did not reach the dry-run line' $iexOut }
  else { Ok 'the irm | iex form runs cleanly (no BOM error on line 1)' }

  $env:COOP_BOOTSTRAP_NO_LAUNCH = '1'
  $out = Invoke-Bootstrap
  if (-not $out.Contains('4. first launch: skipped (COOP_BOOTSTRAP_NO_LAUNCH=1)')) { Ko 'COOP_BOOTSTRAP_NO_LAUNCH=1 does not skip opening the window' $out }
  else { Ok 'COOP_BOOTSTRAP_NO_LAUNCH=1 installs without opening the window' }

  if (-not $isWindowsHost) {
    Remove-Item Env:\COOP_BOOTSTRAP_DRY_RUN -ErrorAction SilentlyContinue
    $out = Invoke-Bootstrap
    if ($bootRc -eq 0 -or -not $out.Contains('this bootstrap runs on Windows only')) { Ko "a real run off Windows did not stop (rc=$bootRc)" $out }
    else { Ok 'off Windows the bootstrap stops before touching anything' }
  }

  # No winget and no clone anywhere: the installer carries everything (D1k).
  $code = ([System.IO.File]::ReadAllText($script) -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  if ($code -match '(?i)winget\s+install|&\s*(winget|git)\b') { Ko 'bootstrap.ps1 still runs winget or git clone' }
  else { Ok 'the bootstrap needs neither winget nor git' }

  # An earlier window in another folder: the upgrade goes into that folder (NSIS's
  # /D, last and unquoted), never a second install beside it, which would hang the
  # silent installer on the "already installed" question (dev VM, 2026-10-19).
  $install = ($code -split "`n" | Where-Object { $_ -match 'Start-Process -FilePath \$exe' }) -join "`n"
  if ($code -notmatch "@\('coop', 'coop \(window\)'\) -notcontains" -or $code -notmatch 'InstallLocation' -or $code -notmatch "@\('HKLM:', 'HKCU:'\)") { Ko 'bootstrap.ps1 must find the installed window through its Add/Remove entry, this machine (HKLM) first' }
  elseif ($code -notmatch '\$installArgs \+= "/D=\$dir"' -or $install -notmatch '-ArgumentList \$installArgs') { Ko 'bootstrap.ps1 must hand an existing install folder to the installer as its last /D argument' $install }
  elseif ($code -match '"/D=\$dir"\s*,|/D="' ) { Ko 'the /D argument must be last and unquoted' }
  else { Ok 'an existing window folder is reused through /D, so a second install never waits on NSIS' }

  # F3: one install per machine. The installer runs for every account (/S /allusers,
  # never /currentuser), from an administrator PowerShell: a plain one stops with
  # the ask before touching anything.
  if ($code -notmatch "@\('/S', '/allusers'\)" -or $code -match '/currentuser') { Ko 'bootstrap.ps1 must install for every account (/S /allusers)' }
  elseif ($code -notmatch 'Test-CoopBootstrapElevated' -or $code -notmatch 'Run as administrator') { Ko 'bootstrap.ps1 must stop with the administrator ask when not elevated' }
  else { Ok 'the bootstrap installs for every account on the machine and asks for an administrator PowerShell' }

  # The one-liner in the docs fetches this file from main at this path.
  $url = 'https://raw.githubusercontent.com/kabukisensei/coop-agent/main/scripts/bootstrap.ps1'
  $text = [System.IO.File]::ReadAllText($script)
  $doc = [System.IO.File]::ReadAllText((Join-Path $root 'docs\install-windows.md'))
  if (-not $text.Contains("irm $url | iex")) { Ko 'bootstrap.ps1 does not carry its own one-liner' }
  elseif (-not $doc.Contains("irm $url | iex")) { Ko 'docs/install-windows.md does not carry the one-liner' }
  else { Ok 'the one-liner in the script header and docs/install-windows.md names this file on main' }
  # `exit` under `irm | iex` would close the user's shell: only the file path form exits.
  $exits = @([regex]::Matches($text, '(?m)^[^#\r\n]*\bexit(\s+\$|\s*[;}]|\s*$)'))
  if ($exits.Count -ne 1 -or -not $text.Contains('if ($PSCommandPath) { exit $script:CoopBootstrapRc }')) { Ko 'bootstrap.ps1 must exit only when run as a file' ($exits | ForEach-Object { $_.Value }) }
  else { Ok 'the bootstrap never calls exit under irm | iex' }
}
finally {
  Restore-Env $saved
}
exit $fail
