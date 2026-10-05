#!/usr/bin/env pwsh
# One writer for the isolated extension tree (Lock-CoopExtensionTree). On
# 2026-10-05 the coop window's first launch seeded <agent dir>\npm from the
# package while a `coop sync` ran `npm ci` in the same folder; Pi then failed to
# load pi-mcp-adapter and pi-hermes-memory from the half-written tree. The lock
# is a named mutex per agent dir that Sync-CoopExtensionFleet holds while it
# writes and Invoke-CoopLaunchPreflight waits on before Pi loads the tree.
#   gate:     the name is one per agent dir (case and separators ignored) and the
#             lock is taken, released and taken again in process;
#   extended: a second process holding the mutex makes Lock-CoopExtensionTree
#             wait: it gives up after the (short, COOP_EXT_TREE_LOCK_TIMEOUT)
#             wait while the holder stays, and acquires once the holder releases.
#             A live child process, so it runs with COOP_TEST_EXTENDED=1 only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $root 'lib\common.ps1')

$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-extlock-mutex-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $t | Out-Null
$agentDir = Join-Path $t 'agent'
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
$saved = Save-Env @('COOP_EXT_TREE_LOCK_TIMEOUT')
try {
  # --- gate: one name per agent dir ------------------------------------------
  $name = Get-CoopExtensionTreeMutexName $agentDir
  if ($name -match '^coop-extension-tree-[0-9a-f]{16}$') { Ok "mutex name is derived from the agent dir ($name)" } else { Ko "unexpected mutex name: $name" }
  $other = Get-CoopExtensionTreeMutexName ((($agentDir.ToUpperInvariant()) -replace '\\', '/') + '/')
  if ($other -eq $name) { Ok 'the same agent dir in other case and separators gives the same name' } else { Ko "case/separator variant gave another name: $other" }
  $sibling = Get-CoopExtensionTreeMutexName (Join-Path $t 'agent2')
  if ($sibling -ne $name) { Ok 'another agent dir gives another name' } else { Ko 'two agent dirs share one mutex name' }

  # --- gate: take, release, take again --------------------------------------
  $env:COOP_EXT_TREE_LOCK_TIMEOUT = '2'
  $m1 = Lock-CoopExtensionTree -AgentDir $agentDir
  if ($m1) { Ok 'a free tree is locked at once' } else { Ko 'could not lock a free tree' }
  Unlock-CoopExtensionTree $m1
  $m2 = Lock-CoopExtensionTree -AgentDir $agentDir
  if ($m2) { Ok 'the tree is locked again after the release' } else { Ko 'could not lock the tree again after the release' }
  Unlock-CoopExtensionTree $m2
  if (Wait-CoopExtensionTreeIdle -AgentDir $agentDir) { Ok 'Wait-CoopExtensionTreeIdle passes a free tree' } else { Ko 'Wait-CoopExtensionTreeIdle failed on a free tree' }
  Unlock-CoopExtensionTree $null
  Ok 'Unlock-CoopExtensionTree tolerates a null (nothing was locked)'

  # --- extended: a second process holds the mutex ---------------------------
  if ($env:COOP_TEST_EXTENDED -eq '1') {
    $held = Join-Path $t 'held'
    $release = Join-Path $t 'release'
    $holder = Join-Path $t 'holder.ps1'
    $commonPath = (Join-Path $root 'lib\common.ps1')
    @(
      '$ErrorActionPreference = ''Stop''',
      ". '$commonPath'",
      "`$m = Lock-CoopExtensionTree -AgentDir '$agentDir'",
      "if (-not `$m) { exit 3 }",
      "Set-Content -LiteralPath '$held' -Value 'held'",
      "`$deadline = (Get-Date).AddSeconds(60)",
      "while (-not (Test-Path -LiteralPath '$release') -and (Get-Date) -lt `$deadline) { Start-Sleep -Milliseconds 100 }",
      'Unlock-CoopExtensionTree $m',
      'exit 0'
    ) | Set-Content -LiteralPath $holder -Encoding UTF8
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = "-NoProfile -File `"$holder`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path -LiteralPath $held) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $held)) { Ko "the holder process never took the mutex (exited: $($proc.HasExited))" }
    else {
      $env:COOP_EXT_TREE_LOCK_TIMEOUT = '1'
      $busy = Lock-CoopExtensionTree -AgentDir $agentDir
      if ($null -eq $busy) { Ok 'a tree another process is writing is not locked within the wait' } else { Ko 'locked a tree another process holds'; Unlock-CoopExtensionTree $busy }
      if (-not (Wait-CoopExtensionTreeIdle -AgentDir $agentDir)) { Ok 'Wait-CoopExtensionTreeIdle reports the busy tree' } else { Ko 'Wait-CoopExtensionTreeIdle passed a busy tree' }
      Set-Content -LiteralPath $release -Value 'go'
      $env:COOP_EXT_TREE_LOCK_TIMEOUT = '30'
      $after = Lock-CoopExtensionTree -AgentDir $agentDir
      if ($after) { Ok 'the lock is acquired once the other process releases it' } else { Ko 'the lock was not acquired after the other process released it' }
      Unlock-CoopExtensionTree $after
    }
    if (-not $proc.WaitForExit(30000)) { try { $proc.Kill() } catch { }; Ko 'the holder process did not exit' }
  }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
