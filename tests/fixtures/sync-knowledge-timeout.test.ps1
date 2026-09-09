#!/usr/bin/env pwsh
# PowerShell behavioral twin of the bounded-git regression in
# tests/sync-knowledge.test.sh: a fake `git` hangs past a 1s deadline while a
# second healthy repo must still sync. The script-under-test is invoked
# IN-PROCESS with & — a sentinel line after the call proves the failure did not
# abort the caller (sync-knowledge.ps1 must return, never exit the parent).
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-knowledge-timeout-ps-' + [guid]::NewGuid().ToString('N'))
$failed = $false
function Ok([string]$Message) { Write-Host "  OK  $Message" }
function Ko([string]$Message) { Write-Host "  FAIL $Message"; $script:failed = $true }

New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  # --- healthy local bare remote (real git, file:// URL, no network) ---------
  $remote = Join-Path $temp 'remote.git'
  $work = Join-Path $temp 'work'
  & git init --bare -b main -q $remote 2>$null
  if ($LASTEXITCODE -ne 0) { & git init --bare -q $remote; & git -C $remote symbolic-ref HEAD refs/heads/main }
  & git clone -q $remote $work 2>$null
  & git -C $work config user.email test@example.com
  & git -C $work config user.name 'Test'
  Set-Content (Join-Path $work 'note.md') 'one'
  & git -C $work add note.md
  & git -C $work commit -qm first
  & git -C $work push -q -u origin main 2>$null

  # --- fake git: hangs when the args mention hanghere, else defers to real ---
  $fakeBin = Join-Path $temp 'fakebin'
  New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
  $fakeLog = Join-Path $temp 'fake-git.log'
  $heartbeat = Join-Path $temp 'heartbeat.txt'
  $realGit = (Get-Command git).Source
  # Fake git: when the args mention "hanghere", spawn a background sleeper that
  # rewrites a heartbeat file once per second, then sleep in the foreground.
  # knowledge-git.py's taskkill /T /F must kill the whole tree, so the heartbeat
  # stops updating after the timeout.
  @"
@echo off
echo %* >> "$fakeLog"
echo %* | findstr /C:"hanghere" >NUL
if %errorlevel% equ 0 (
  start "coop-sleeper" /min powershell -NoProfile -Command "while (`$true) { Set-Content -LiteralPath '$heartbeat' -Value (Get-Date -Format o); Start-Sleep -Milliseconds 500 }"
  powershell -NoProfile -Command "Start-Sleep -Seconds 30"
  exit /b 0
)
"$realGit" %*
"@ | Set-Content (Join-Path $fakeBin 'git.cmd') -Encoding ascii

  $cfg = Join-Path $temp 'cfg'
  New-Item -ItemType Directory -Force -Path (Join-Path $cfg '.coop') | Out-Null
  $cloneSlow = Join-Path $temp 'kb\hanghere-clone'
  $cloneOk = Join-Path $temp 'kb\healthy'
  $json = '{"schema_version":1,"knowledge":{"enabled":true,"repos":[' +
    '{"url":"https://example.invalid/hanghere-clone.git","local_path":"' + ($cloneSlow -replace '\\','/') + '"},' +
    '{"url":"' + ($remote -replace '\\','/') + '","local_path":"' + ($cloneOk -replace '\\','/') + '"}]}}'
  Set-Content (Join-Path $cfg '.coop\config') $json

  $priorPath = $env:PATH
  $priorTimeout = $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS
  $priorCoopDir = $env:COOP_DIR
  $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$priorPath"
  $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = '1'
  $env:COOP_DIR = $cfg
  try {
    # Independent outer deadline so a regression cannot hang CI.
    $job = Start-Job -ScriptBlock {
      param($scriptPath)
      & $scriptPath 2>&1 | Out-String
    } -ArgumentList (Join-Path $root 'scripts\sync-knowledge.ps1')
    if (Wait-Job $job -Timeout 60) {
      $out = (Receive-Job $job) -join "`n"
      Ok 'sync completed inside the outer deadline'
    } else {
      Stop-Job $job -PassThru | Remove-Job -Force
      Ko 'sync hung past the outer deadline'
      $out = ''
    }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
  } finally {
    $env:PATH = $priorPath
    if ($null -eq $priorTimeout) { Remove-Item Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS -ErrorAction SilentlyContinue } else { $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $priorTimeout }
    if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  }

  if ($out -like '*timed out*') { Ok 'timeout warning surfaced (PS)' } else { Ko "no timeout warning (PS): $out" }
  if ($out -like '*sync complete*') { Ok 'sync still fails soft and completes (PS)' } else { Ko "sync did not complete (PS): $out" }
  if (Test-Path -LiteralPath (Join-Path $cloneOk 'note.md')) { Ok 'second healthy repo cloned in the same run (PS)' } else { Ko 'healthy repo missing (PS)' }
  if (Test-Path -LiteralPath $heartbeat) {
    Start-Sleep -Seconds 3
    $before = (Get-Item -LiteralPath $heartbeat).LastWriteTime
    Start-Sleep -Seconds 2
    $after = (Get-Item -LiteralPath $heartbeat).LastWriteTime
    if ($after -gt $before) { Ko 'heartbeat still updating — sleeper descendant survived (PS)' } else { Ok 'sleeper descendant terminated with the owned tree (PS)' }
  } else {
    Ko 'fake git never started its sleeper heartbeat'
  }

  # In-process contract: & sync-knowledge.ps1 must RETURN (never exit), so the
  # sentinel line after the call is always reached — even on total failure.
  $sentinel = Join-Path $temp 'sentinel.txt'
  $env:COOP_DIR = $cfg
  $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = '1'
  $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$priorPath"
  try {
    & (Join-Path $root 'scripts\sync-knowledge.ps1') *> $null
    Set-Content $sentinel 'reached'
  } finally {
    $env:PATH = $priorPath
    if ($null -eq $priorTimeout) { Remove-Item Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS -ErrorAction SilentlyContinue } else { $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $priorTimeout }
    if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  }
  if (Test-Path -LiteralPath $sentinel) { Ok 'in-process invocation returned; sentinel reached after failure' } else { Ko 'sync-knowledge.ps1 exited the parent instead of returning' }
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }
exit 0
