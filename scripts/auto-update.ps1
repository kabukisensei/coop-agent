#!/usr/bin/env pwsh
#
# scripts/auto-update.ps1 - coop's self-update on a machine install (master
# plan F3; Aaron 2026-10-20: updates install themselves, no `coop update` by
# hand). The scheduled task "coop update" (scripts\machine-install.ps1) runs it
# as SYSTEM, daily at 03:00 with hourly retries and after any logon, from the
# installed snapshot <app>\resources\coop\scripts. One run:
#   1. reads the installed version (resources\coop\VERSION) and the machine
#      marker (resources\runtime\machine-install.json; without it: nothing);
#   2. asks github.com for the newest release of kabukisensei/coop-agent
#      (release tags vX.Y.Z only; the repository is public, no token) and stops
#      when it is not newer (never backwards);
#   3. waits ("waiting: coop is open") while any process runs from the install
#      dir, in any account (the task is SYSTEM, so it sees them all);
#   4. downloads coop-window-<ver>-win-x64.exe and installer-acceptance.json
#      to %ProgramData%\coop\updates and checks the exe's SHA-256 against the
#      report (the check scripts/bootstrap.ps1 and check-installer-report.mjs
#      make);
#   5. runs the installer silently for every account (/S /allusers, into the
#      same folder) and checks the installed VERSION moved.
# Every run records %ProgramData%\coop\update-state.json (schema_version 1:
# last_run, last_result "installed" | "up to date" | "waiting: coop is open" |
# "failed: ...", installed_version, pending_version, latest_version,
# release_url) and appends one line to %ProgramData%\coop\logs\update.log
# (kept under 1 MB). The accounts' launches read the state (lib/common.ps1
# Write-CoopUpdateLines); nothing under any %USERPROFILE%\.coop is touched.
#
# -DryRun (or COOP_AUTO_UPDATE_DRY_RUN=1) checks and records, downloads and
# installs nothing ("dry run: ..."). -LatestVersion (COOP_AUTO_UPDATE_LATEST)
# skips github.com, for the tests. Standalone on purpose (no lib/common.ps1):
# the installer it runs replaces this folder. Windows PowerShell 5.1 syntax
# only. Exit 0 unless the result is "failed: ...". The tests dot-source this
# file for its functions: nothing runs then.
param(
  [switch]$DryRun,
  # <app>: default three levels above this script (<app>\resources\coop\scripts).
  [string]$InstallDir = '',
  # %ProgramData%\coop (COOP_MACHINE_DIR, as lib/common.ps1 reads it, for the tests).
  [string]$MachineDir = '',
  [string]$LatestVersion = '',
  [string]$Repo = 'kabukisensei/coop-agent'
)

# --- pure parts (tested on every OS) ------------------------------------------
# Is $Candidate a newer x.y.z than $Than? $false when either is not a version.
function Test-CoopVersionNewer([string]$Candidate, [string]$Than) {
  try { return ([version]$Candidate -gt [version]$Than) } catch { return $false }
}
# The version a release tag names ("v1.2.3" -> "1.2.3"), '' for anything else
# (a pre-release, a tag by hand): release tags only, never a branch.
function Get-CoopReleaseTagVersion([string]$Tag) {
  if ([string]$Tag -match '^v(\d+\.\d+\.\d+)$') { return $Matches[1] }
  return ''
}
# Where a release's installer and its acceptance report live.
function Get-CoopReleaseUrls([string]$Repo, [string]$Version) {
  $base = "https://github.com/$Repo/releases/download/v$Version"
  return @{
    Page      = "https://github.com/$Repo/releases/tag/v$Version"
    Installer = "$base/coop-window-$Version-win-x64.exe"
    Report    = "$base/installer-acceptance.json"
    Name      = "coop-window-$Version-win-x64.exe"
  }
}
# The processes running from the install dir (coop.exe, the bundled node, git,
# python...), by name, from objects with ExecutablePath (Win32_Process) or Path
# (Get-Process). Any of them means the installer would hit open files.
function Get-CoopInstallInUse([string]$InstallDir, $Processes) {
  $root = $InstallDir.Trim().TrimEnd('\')
  if (-not $root) { return @() }
  $names = @()
  foreach ($p in @($Processes)) {
    if ($null -eq $p) { continue }
    $exe = ''
    if ($p.PSObject.Properties['ExecutablePath'] -and $p.ExecutablePath) { $exe = [string]$p.ExecutablePath }
    elseif ($p.PSObject.Properties['Path'] -and $p.Path) { $exe = [string]$p.Path }
    if (-not $exe) { continue }
    if ($exe.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      $name = if ($p.PSObject.Properties['Name'] -and $p.Name) { [string]$p.Name } elseif ($p.PSObject.Properties['ProcessName']) { [string]$p.ProcessName } else { [System.IO.Path]::GetFileName($exe) }
      if ($names -notcontains $name) { $names += $name }
    }
  }
  return @($names)
}
# Does the acceptance report vouch for this version's installer? The reason when not.
function Test-CoopInstallerReport($Report, [string]$Version) {
  if ($null -eq $Report) { return 'no acceptance report' }
  if ($Report.ok -ne $true) { return "the acceptance report does not say ok$(if ($Report.error) { ': ' + $Report.error })" }
  if ([string]$Report.version -ne $Version) { return "the acceptance ran on version $($Report.version), the release is $Version" }
  if ([string]$Report.installerSha256 -notmatch '^[0-9a-fA-F]{64}$') { return 'the acceptance report carries no installer SHA-256' }
  return ''
}
# The state document one run writes.
function New-CoopUpdateState([string]$Result, [string]$Installed, [string]$Pending, [string]$Latest, [string]$ReleaseUrl) {
  return [ordered]@{
    schema_version    = 1
    last_run          = (Get-Date).ToString('o')
    last_result       = $Result
    installed_version = $Installed
    pending_version   = $Pending
    latest_version    = $Latest
    release_url       = $ReleaseUrl
  }
}
function Write-CoopUpdateStateFile([string]$File, $State) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $File) | Out-Null
  $json = $State | ConvertTo-Json
  [System.IO.File]::WriteAllText($File, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
}
# One line appended; the file is cut to its newest half once it passes $MaxBytes.
function Add-CoopUpdateLogLine([string]$File, [string]$Text, [int]$MaxBytes = 1048576) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $File) | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Text + "`r`n"
  if ((Test-Path -LiteralPath $File -PathType Leaf) -and ((Get-Item -LiteralPath $File).Length + $line.Length -gt $MaxBytes)) {
    $bytes = [System.IO.File]::ReadAllBytes($File)
    $keep = [Math]::Floor($MaxBytes / 2)
    if ($bytes.Length -gt $keep) {
      $tail = New-Object byte[] $keep
      [Array]::Copy($bytes, $bytes.Length - $keep, $tail, 0, $keep)
      $text = $utf8.GetString($tail)
      $nl = $text.IndexOf("`n")
      if ($nl -ge 0) { $text = $text.Substring($nl + 1) }
      [System.IO.File]::WriteAllText($File, $text, $utf8)
    }
  }
  [System.IO.File]::AppendAllText($File, $line, $utf8)
}

# --- github.com -----------------------------------------------------------------
function Get-CoopGitHubHeaders {
  $h = @{ 'User-Agent' = 'coop-auto-update' }
  # A token is never needed (public repository); CI passes one so a shared
  # runner address is not rate-limited.
  $token = if ($env:GH_TOKEN) { [string]$env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { [string]$env:GITHUB_TOKEN } else { '' }
  if ($token) { $h['Authorization'] = "Bearer $token" }
  return $h
}
# The newest release's version: the API's latest-release record, else the tag
# the release page's /releases/latest redirect names. '' when neither answers.
function Get-CoopLatestReleaseVersion([string]$Repo) {
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing -Headers (Get-CoopGitHubHeaders) -ErrorAction Stop
    $v = Get-CoopReleaseTagVersion ([string]$rel.tag_name)
    if ($v) { return $v }
  } catch { }
  try {
    $location = ''
    try {
      $r = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -UseBasicParsing -MaximumRedirection 0 -Headers @{ 'User-Agent' = 'coop-auto-update' } -ErrorAction Stop
      $location = [string]$r.Headers['Location']
    } catch {
      $resp = $_.Exception.Response
      if ($resp) { try { $location = [string]$resp.Headers['Location'] } catch { $location = '' } }
      if (-not $location -and $_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response.Headers) {
        try { $location = [string]$_.Exception.Response.Headers.Location } catch { }
      }
    }
    if ($location -match '/releases/tag/(v\d+\.\d+\.\d+)$') { return (Get-CoopReleaseTagVersion $Matches[1]) }
  } catch { }
  return ''
}
function Get-CoopFileSha256([string]$File) { return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-CoopDownload([string]$Url, [string]$OutFile) {
  $pp = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers @{ 'User-Agent' = 'coop-auto-update' } -ErrorAction Stop } finally { $ProgressPreference = $pp }
}
function Get-CoopRunningProcesses {
  try { return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Select-Object Name, ExecutablePath) } catch { }
  try { return @(Get-Process -ErrorAction Stop | Select-Object ProcessName, Path) } catch { return @() }
}

# --- one run ----------------------------------------------------------------------
function Invoke-CoopAutoUpdate {
  $dry = $DryRun -or ($env:COOP_AUTO_UPDATE_DRY_RUN -eq '1')
  $app = if ($InstallDir) { $InstallDir } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
  $app = $app.Trim().TrimEnd('\')
  $machine = if ($MachineDir) { $MachineDir } elseif ($env:COOP_MACHINE_DIR) { [string]$env:COOP_MACHINE_DIR } elseif ($env:ProgramData) { Join-Path $env:ProgramData 'coop' } else { Join-Path $app 'machine' }
  $stateFile = Join-Path $machine 'update-state.json'
  $logFile = Join-Path (Join-Path $machine 'logs') 'update.log'
  $updates = Join-Path $machine 'updates'
  $installed = ''
  $latest = ''
  $pending = ''
  $releaseUrl = ''
  $result = ''
  try {
    $verFile = Join-Path $app 'resources\coop\VERSION'
    if (-not (Test-Path -LiteralPath $verFile -PathType Leaf)) { throw "no installed coop at $app (resources\coop\VERSION is missing)" }
    $installed = ([System.IO.File]::ReadAllText($verFile)).Trim()
    if (-not (Test-Path -LiteralPath (Join-Path $app 'resources\runtime\machine-install.json') -PathType Leaf)) { throw "$app is not this machine's install (no resources\runtime\machine-install.json); nothing to update" }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $latest = if ($LatestVersion) { $LatestVersion } elseif ($env:COOP_AUTO_UPDATE_LATEST) { [string]$env:COOP_AUTO_UPDATE_LATEST } else { Get-CoopLatestReleaseVersion $Repo }
    if (-not $latest) { throw "could not read the newest release from github.com ($Repo)" }
    $urls = Get-CoopReleaseUrls $Repo $latest
    $releaseUrl = $urls.Page
    if (-not (Test-CoopVersionNewer $latest $installed)) {
      $result = 'up to date'
      $releaseUrl = (Get-CoopReleaseUrls $Repo $installed).Page
    } else {
      $pending = $latest
      $inUse = @(Get-CoopInstallInUse $app (Get-CoopRunningProcesses))
      if ($inUse.Count -gt 0) {
        $result = "waiting: coop is open ($($inUse -join ', '))"
      } elseif ($dry) {
        $result = "dry run: would install v$latest"
      } else {
        New-Item -ItemType Directory -Force -Path $updates | Out-Null
        $reportFile = Join-Path $updates 'installer-acceptance.json'
        $exe = Join-Path $updates $urls.Name
        Invoke-CoopDownload $urls.Report $reportFile
        $report = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
        $why = Test-CoopInstallerReport $report $latest
        if ($why) { throw "release v$latest is not installable: $why" }
        $want = ([string]$report.installerSha256).ToLowerInvariant()
        if (-not ((Test-Path -LiteralPath $exe -PathType Leaf) -and ((Get-CoopFileSha256 $exe) -eq $want))) {
          Invoke-CoopDownload $urls.Installer $exe
        }
        $have = Get-CoopFileSha256 $exe
        if ($have -ne $want) {
          Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
          throw "the downloaded installer's SHA-256 ($have) is not the one the release's acceptance report names ($want); deleted it"
        }
        Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue
        # NSIS reads /D only as the last argument and without quotes.
        $p = Start-Process -FilePath $exe -ArgumentList @('/S', '/allusers', "/D=$app") -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "the installer exited with code $($p.ExitCode)" }
        $now = ''
        if (Test-Path -LiteralPath $verFile -PathType Leaf) { $now = ([System.IO.File]::ReadAllText($verFile)).Trim() }
        if ($now -ne $latest) { throw "the installer finished but $verFile says $now, not $latest" }
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
        $installed = $latest
        $pending = ''
        $result = 'installed'
      }
    }
  } catch {
    $result = "failed: $($_.Exception.Message)"
  }
  $state = New-CoopUpdateState $result $installed $pending $latest $releaseUrl
  try { Write-CoopUpdateStateFile $stateFile $state } catch { Write-Host "could not write $stateFile`: $($_.Exception.Message)" }
  try { Add-CoopUpdateLogLine $logFile "$result (installed $installed, newest $latest)" } catch { }
  Write-Host "coop auto-update: $result (installed $installed, newest $latest)"
  if ($result.StartsWith('failed')) { return 1 }
  return 0
}

if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-CoopAutoUpdate)
}
