#!/usr/bin/env pwsh
#
# scripts/sign-in.ps1 - coop at Windows sign-in (`coop startup`: the account's
# Run entry starts this file in a minimized console titled "coop: getting
# ready", which comes up as a normal window titled "coop: updating to vX"
# while an update installs; on by default on a machine install, `coop startup
# off` opts out). One run:
#   1. on a machine install: asks github.com for the newest release and, when
#      it is newer than the installed one, waits (at most -WaitMinutes) for the
#      "coop update" task, which runs at every sign-in, to install it. It stops
#      waiting as soon as the task reports it failed or is waiting for a coop
#      that is open. This script runs in the built-in powershell.exe, not from
#      the install folder, so the task does not count it as an open coop. On a
#      developer clone it runs `coop update --yes` instead;
#   2. runs coop's own launch check of the Azure sign-in for the client tenant
#      (Invoke-CoopAzPreflight), which opens `az login` only when a token cannot
#      be minted and never prints or logs one; the window's launch then reuses
#      the result (the .az-ok marker, 30 minutes);
#   3. opens the coop window on the recorded client folder.
# The steps run in this order on purpose: the installer replaces the folder az,
# Python and Node run from, and any process from it makes the task wait an hour.
# Each step's outcome goes to <profile>\.coop\logs\sign-in.log. Windows
# PowerShell 5.1 syntax. The tests dot-source this file for its functions:
# nothing runs then.
param(
  [int]$WaitMinutes = 12
)

# Release lookup, version compare and the trimmed log line, shared with the task.
. (Join-Path $PSScriptRoot 'auto-update.ps1')

# --- pure parts (tested on every OS) ------------------------------------------
# What the wait for the update task does next, from the task's state document:
# 'installed' when a run during this sign-in installed $Latest, 'stop: <why>'
# when a run during this sign-in will not install it now, else 'wait'. Runs
# before $Since (an earlier sign-in, last night) do not count.
function Get-CoopSignInWaitStep([string]$Latest, $State, [datetime]$Since) {
  if ($null -eq $State) { return 'wait' }
  $ran = $null
  try { if ($State.last_run) { $ran = ([datetime]$State.last_run).ToUniversalTime() } } catch { $ran = $null }
  if ($null -eq $ran -or $ran -lt $Since.ToUniversalTime()) { return 'wait' }
  $result = [string]$State.last_result
  if ($result -eq 'installed' -and [string]$State.installed_version -eq $Latest) { return 'installed' }
  if ($result.StartsWith('failed') -or $result.StartsWith('waiting')) { return "stop: the update task says $result" }
  if ($result -eq 'up to date') { return 'stop: the update task found no newer release yet' }
  return 'wait'
}
# "1 minute", "12 minutes".
function Format-CoopMinutes([int]$Count) { if ($Count -eq 1) { return '1 minute' } return "$Count minutes" }
# The log line for the Azure check's exit code (see Invoke-CoopSignIn).
function Get-CoopSignInAzureLine([int]$Code) {
  switch ($Code) {
    0 { return 'Azure: signed in for the client tenant' }
    3 { return 'Azure: not signed in (az login was skipped or did not finish); the window says how to sign in' }
    4 { return 'Azure: check skipped (no client tenant set, no Azure CLI, or COOP_SKIP_AZ=1)' }
  }
  return "Azure: the check stopped with exit $Code"
}
# The client folder ~\.coop\client.json records (root), or '' when none is
# recorded or it is gone.
function Get-CoopSignInClientRoot([string]$ProfileDir) {
  $record = Join-Path $ProfileDir 'client.json'
  if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { return '' }
  try { $root = [string]((Get-Content -LiteralPath $record -Raw | ConvertFrom-Json).root) } catch { return '' }
  if ($root -and (Test-Path -LiteralPath $root -PathType Container)) { return $root }
  return ''
}

# --- one run ----------------------------------------------------------------------
$script:SignInLog = ''
function Write-CoopSignInLine([string]$Text) {
  Write-Host "  $Text"
  if ($script:SignInLog) { try { Add-CoopUpdateLogLine $script:SignInLog $Text } catch { } }
}
function Get-CoopSignInPowerShell { return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') }
# The Run entry starts this console minimized (nothing to read on an ordinary
# sign-in). While an update installs, coop's icons lead nowhere for several
# minutes, so the console comes up as a normal window saying so (a client VM,
# 2026-11-09: nothing told the user an install was running). Best-effort.
function Show-CoopSignInWindow([string]$Title) {
  if ($env:OS -ne 'Windows_NT') { return }
  try { $Host.UI.RawUI.WindowTitle = $Title } catch { }
  try {
    if (-not ('CoopSignIn.NativeWindow' -as [type])) {
      Add-Type -Namespace CoopSignIn -Name NativeWindow -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();'
    }
    $hwnd = [CoopSignIn.NativeWindow]::GetConsoleWindow()
    # 9 = SW_RESTORE: a minimized console back to a normal window.
    if ($hwnd -ne [IntPtr]::Zero) { [void][CoopSignIn.NativeWindow]::ShowWindow($hwnd, 9) }
  } catch { }
}

# Step 1 on a machine install: wait for the update task to install a newer release.
function Wait-CoopSignInUpdate([string]$CoopRoot, [datetime]$Start) {
  $installed = ''
  try { $installed = ([System.IO.File]::ReadAllText((Join-Path $CoopRoot 'VERSION'))).Trim() } catch { }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $latest = if ($env:COOP_AUTO_UPDATE_LATEST) { [string]$env:COOP_AUTO_UPDATE_LATEST } else { Get-CoopLatestReleaseVersion 'kabukisensei/coop-agent' }
  if (-not $latest) { Write-CoopSignInLine "could not read the newest release from github.com; opening coop $installed"; return }
  if (-not (Test-CoopVersionNewer $latest $installed)) { Write-CoopSignInLine "coop $installed is the newest release"; return }
  Show-CoopSignInWindow "coop: updating to $latest (a few minutes)"
  Write-CoopSignInLine "coop $latest is out (this machine has $installed): waiting for the update task to install it (at most $(Format-CoopMinutes $WaitMinutes))"
  Write-CoopSignInLine "coop's icons open nothing until the install finishes; this window closes when coop opens"
  $machineDir = if ($env:COOP_MACHINE_DIR) { [string]$env:COOP_MACHINE_DIR } else { Join-Path $env:ProgramData 'coop' }
  $stateFile = Join-Path $machineDir 'update-state.json'
  # The task's sign-in run may start a little before this script does.
  $since = $Start.AddMinutes(-3)
  $deadline = $Start.AddMinutes($WaitMinutes)
  $nextNote = (Get-Date).AddMinutes(1)
  while ((Get-Date) -lt $deadline) {
    $state = $null
    try { if (Test-Path -LiteralPath $stateFile -PathType Leaf) { $state = Get-Content -LiteralPath $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } } catch { $state = $null }
    $step = Get-CoopSignInWaitStep $latest $state $since
    if ($step -eq 'installed') { Write-CoopSignInLine "coop $latest installed"; return }
    if ($step.StartsWith('stop: ')) { Write-CoopSignInLine "$($step.Substring(6)); opening coop $installed"; return }
    if ((Get-Date) -ge $nextNote) { Write-CoopSignInLine 'still installing...'; $nextNote = (Get-Date).AddMinutes(1) }
    Start-Sleep -Seconds 5
  }
  Write-CoopSignInLine "coop $latest did not install within $(Format-CoopMinutes $WaitMinutes); opening coop $installed (the update task tries again within the hour)"
}

function Invoke-CoopSignIn {
  $start = Get-Date
  $coopRoot = Split-Path -Parent $PSScriptRoot
  $profileDir = if ($env:COOP_DIR) { Join-Path $env:COOP_DIR '.coop' } else { Join-Path $HOME '.coop' }
  $script:SignInLog = Join-Path $profileDir 'logs\sign-in.log'
  try { $Host.UI.RawUI.WindowTitle = 'coop: getting ready' } catch { }
  Write-CoopSignInLine "coop at sign-in ($coopRoot): update, Azure sign-in, then the window"
  $ps = Get-CoopSignInPowerShell
  $runtime = Join-Path (Split-Path -Parent $coopRoot) 'runtime'
  $machine = Test-Path -LiteralPath (Join-Path $runtime 'machine-install.json') -PathType Leaf
  $rc = 0
  try {
    # 1. The update.
    if ($machine) {
      Wait-CoopSignInUpdate $coopRoot $start
    } elseif (Test-Path -LiteralPath (Join-Path $coopRoot '.git')) {
      Write-CoopSignInLine 'updating this developer clone: coop update --yes'
      & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $coopRoot 'bin\coop.ps1') update --yes
      Write-CoopSignInLine "coop update exited $LASTEXITCODE"
    }
    # 2. The Azure sign-in, from the client folder (where the tenant is read),
    #    in a child so this console only sees its lines.
    $client = Get-CoopSignInClientRoot $profileDir
    $here = if ($client) { $client } else { $HOME }
    $common = (Join-Path $coopRoot 'lib\common.ps1') -replace "'", "''"
    Push-Location -LiteralPath $here
    try {
      # Exit 0 signed in (the marker the check writes, under 30 minutes old), 3
      # not signed in, 4 skipped (no client tenant, no az, or COOP_SKIP_AZ=1).
      # One line with no double quotes: Windows PowerShell 5.1 passes it to the child as one argument.
      $check = ". '$common'; Invoke-CoopAzPreflight; " +
        'if ($env:COOP_SKIP_AZ -eq ''1'' -or -not (Test-Have ''az'') -or (Get-CoopTenant).Rc -ne 0) { exit 4 }; ' +
        '$m = Get-Item -LiteralPath (Join-Path (Get-CoopEffectiveAgentDir) ''.az-ok'') -Force -ErrorAction SilentlyContinue; ' +
        'if ($m -and ((Get-Date) - $m.LastWriteTime).TotalMinutes -lt 30) { exit 0 }; exit 3'
      & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -Command $check
      Write-CoopSignInLine (Get-CoopSignInAzureLine $LASTEXITCODE)
    } finally { Pop-Location }
    # 3. The window, as the Start menu's coop opens it.
    $exe = Join-Path (Split-Path -Parent (Split-Path -Parent $coopRoot)) 'coop.exe'
    if ($machine -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
      Start-Process -FilePath $exe -WorkingDirectory $HOME
    } else {
      $launcher = Join-Path $coopRoot 'bin\coop-desktop.ps1'
      Start-Process -FilePath $ps -WorkingDirectory $HOME -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcher`"", 'desktop')
    }
    Write-CoopSignInLine 'opened the coop window'
  } catch {
    Write-CoopSignInLine "stopped: $($_.Exception.Message)"
    $rc = 1
  }
  Write-Host "  log: $($script:SignInLog)"
  Start-Sleep -Seconds $(if ($rc) { 30 } else { 3 })
  return $rc
}

if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-CoopSignIn)
}
