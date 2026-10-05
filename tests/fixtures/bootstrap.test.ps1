#!/usr/bin/env pwsh
# D1k: scripts/bootstrap.ps1, the one-command terminal bootstrap. The dry run
# prints the four steps for this machine and changes nothing (any OS); off
# Windows a real run stops at once with the Windows-only line. The documented
# one-liner names this file at its path on main.
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

$saved = Save-Env @('COOP_BOOTSTRAP_DRY_RUN', 'COOP_BOOTSTRAP_NO_WINDOW', 'COOP_BOOTSTRAP_DIR')
try {
  $env:COOP_BOOTSTRAP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-bootstrap-' + [guid]::NewGuid().ToString('N'))
  $env:COOP_BOOTSTRAP_DRY_RUN = '1'
  Remove-Item Env:\COOP_BOOTSTRAP_NO_WINDOW -ErrorAction SilentlyContinue
  $out = Invoke-Bootstrap
  foreach ($want in @('1. Git (winget, when missing)', "2. clone https://github.com/kabukisensei/coop-agent into $($env:COOP_BOOTSTRAP_DIR) at the newest release", '3. coop install --prereqs auto', '4. the coop window installer from that release, SHA-256 checked', 'dry run (COOP_BOOTSTRAP_DRY_RUN=1): nothing was changed')) {
    if (-not $out.Contains($want)) { Ko "bootstrap dry run is missing: $want" $out }
  }
  if ($bootRc -ne 0) { Ko "bootstrap dry run exited $bootRc" $out }
  if (Test-Path -LiteralPath $env:COOP_BOOTSTRAP_DIR) { Ko 'bootstrap dry run created the clone folder' $out }
  if ($fail -eq 0) { Ok 'bootstrap dry run lists the four steps for this machine and changes nothing' }

  $env:COOP_BOOTSTRAP_NO_WINDOW = '1'
  $out = Invoke-Bootstrap
  if (-not $out.Contains('4. the coop window: skipped (COOP_BOOTSTRAP_NO_WINDOW=1)')) { Ko 'COOP_BOOTSTRAP_NO_WINDOW=1 does not skip the window step' $out }
  else { Ok 'COOP_BOOTSTRAP_NO_WINDOW=1 leaves the terminal coop alone' }

  if (-not $isWindowsHost) {
    Remove-Item Env:\COOP_BOOTSTRAP_DRY_RUN -ErrorAction SilentlyContinue
    $out = Invoke-Bootstrap
    if ($bootRc -eq 0 -or -not $out.Contains('this bootstrap runs on Windows only')) { Ko "a real run off Windows did not stop (rc=$bootRc)" $out }
    elseif (Test-Path -LiteralPath $env:COOP_BOOTSTRAP_DIR) { Ko 'a real run off Windows created the clone folder' $out }
    else { Ok 'off Windows the bootstrap stops before touching anything' }
  }

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
