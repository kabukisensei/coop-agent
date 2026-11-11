#!/usr/bin/env pwsh
# A mistyped coop command (`coop docter`) says "unknown command" and names the
# command it is close to, instead of going to Pi as a message and opening a
# session on the typo. A one-word message that is not close to a command
# (`coop hello`) and anything with more than one word still go to Pi. Only the
# commands `coop help` lists are ever suggested. Offline; temp dirs only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-near-command-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_SKIP_AZ')
try {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  $null = New-SandboxHome (Join-Path $t 'home')
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  $launcher = [System.IO.File]::ReadAllText((Join-Path $root 'bin\coop.ps1'))
  $match = [regex]::Match($launcher, '(?s)function Get-CoopNearCommand\(.*?\r?\n}\r?\n')
  if (-not $match.Success) { Ko 'bin/coop.ps1 must define Get-CoopNearCommand' }
  else {
    Invoke-Expression $match.Value
    $cases = [ordered]@{
      'docter' = 'doctor'; 'updat' = 'update'; 'instal' = 'install'; 'hepl' = 'help'; 'feedbak' = 'feedback'
      'versoin' = 'version'; 'datadoc' = 'data-doc'; 'synk' = 'sync'
      'hello' = ''; 'hi' = ''; 'review' = ''; 'please' = ''; 'start' = ''; 'doctor' = ''; 'Instal-It' = ''
      'unlock-prd' = ''; 'launch-spce' = ''
    }
    foreach ($word in $cases.Keys) {
      $got = Get-CoopNearCommand $word
      if ($got -ceq $cases[$word]) { Ok "'$word' -> '$got'" } else { Ko "'$word' must give '$($cases[$word])', got '$got'" }
    }
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $psi.FileName) { $psi.FileName = (Get-Command powershell).Source }
  $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $root 'bin\coop.ps1')`" docter"
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.Environment['COOP_SKIP_AZ'] = '1'
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Close()
  $ended = $proc.WaitForExit(60000)
  $text = ''
  if ($ended) { $text = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd() } else { try { $proc.Kill($true) } catch { } }
  if ($ended -and $proc.ExitCode -ne 0 -and $text -match "unknown command 'docter'" -and $text -match 'coop doctor') { Ok 'coop docter names coop doctor and exits non-zero, no session opens' }
  else { Ko "coop docter must name coop doctor and exit non-zero (ended=$ended exit=$(if ($ended) { $proc.ExitCode } else { 'hung' }))" }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  near-command tests passed' } else { Write-Host "  $G_CROSS near-command tests FAILED" }
exit $fail
