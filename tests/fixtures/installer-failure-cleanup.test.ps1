#!/usr/bin/env pwsh
# The window package's setup and removal around the installer (desktop/installer/
# resources/installer.nsh), offline. Any OS unless noted:
#   - a failed machine setup reaches the callers: installer.nsh exits 3,
#     scripts/auto-update.ps1 and scripts/bootstrap.ps1 say so and name the log
#     (#515); the installer acceptance's injected failure works only on a test
#     runner;
#   - scripts/window-uninstall.ps1 removes the "coop at sign-in" Run value only
#     when it starts this install's sign-in.ps1 (#516); on Windows against a
#     throwaway registry key, never the account's real Run key;
#   - the elevated per-account sweep runs nothing from an account's folder and
#     follows no link (scripts/machine-install.ps1);
#   - scripts/auto-update.ps1 runs an installer only from an administrators-only
#     folder (Windows).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-installer-failure-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $t | Out-Null
$saved = Save-Env @('COOP_INSTALLER_TEST', 'COOP_MACHINE_INSTALL_FAIL')
try {
  # --- #515: the installer's exit code ------------------------------------------------
  $nsh = [System.IO.File]::ReadAllText((Join-Path $root 'desktop\installer\resources\installer.nsh'))
  $install = ($nsh -split '!macro customInstall')[1] -split '!macroend' | Select-Object -First 1
  if ($install -notmatch '(?s)\$\{if\} \$0 != 0.*SetErrorLevel 3.*\$\{ifNot\} \$\{Silent\}') { Ko 'installer.nsh does not exit 3 when machine-install.ps1 fails (silent runs included)' $install }
  else { Ok 'a failed machine-install.ps1 makes the installer exit 3, silent or not' }

  . (Join-Path $root 'scripts\auto-update.ps1')
  $machine = 'C:\ProgramData\coop'
  $p3 = Get-CoopInstallerExitProblem 3 $machine
  if ((Get-CoopInstallerExitProblem 0 $machine) -ne '') { Ko 'Get-CoopInstallerExitProblem calls exit 0 a failure' }
  elseif ($p3 -notmatch 'machine setup did not finish' -or $p3 -notmatch 'machine-install\.log') { Ko "Get-CoopInstallerExitProblem 3 does not name the machine setup and its log: $p3" }
  elseif ((Get-CoopInstallerExitProblem 2 $machine) -ne 'the installer exited with code 2') { Ko 'Get-CoopInstallerExitProblem changed the message for other codes' }
  else { Ok 'auto-update records a failed machine setup (exit 3) as failed, with the machine-install log' }
  $au = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\auto-update.ps1'))
  if ($au -notmatch 'Get-CoopInstallerExitProblem \$p\.ExitCode \$machine' -or $au -notmatch "result = 'installed'") { Ko 'auto-update.ps1 does not judge the installer through Get-CoopInstallerExitProblem' }
  else { Ok 'auto-update writes installed only after the installer exits 0 and VERSION moved' }

  $boot = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\bootstrap.ps1'))
  if ($boot -notmatch '(?s)if \(\$p\.ExitCode -eq 3\) \{.*machine-install\.log.*return \$false') { Ko 'bootstrap.ps1 does not report a failed machine setup (exit 3) with the log' }
  elseif ($boot.IndexOf('$p.ExitCode -eq 3') -gt $boot.IndexOf('the coop window is installed for every account')) { Ko 'bootstrap.ps1 announces the install before it checks exit 3' }
  else { Ok 'bootstrap reports a failed machine setup (exit 3) and names the log instead of announcing success' }

  . (Join-Path $root 'scripts\machine-install.ps1')
  $env:COOP_INSTALLER_TEST = $null; $env:COOP_MACHINE_INSTALL_FAIL = 'task'
  $off = Test-CoopMachineInstallInjectedFailure 'task'
  $env:COOP_INSTALLER_TEST = '1'
  $on = Test-CoopMachineInstallInjectedFailure 'task'
  $other = Test-CoopMachineInstallInjectedFailure 'odbc'
  if ($off -or -not $on -or $other) { Ko "the injected machine-setup failure: off=$off on=$on other=$other" }
  else { Ok 'the installer acceptance can fail the task step on purpose, and only with COOP_INSTALLER_TEST=1' }
  $env:COOP_INSTALLER_TEST = $null; $env:COOP_MACHINE_INSTALL_FAIL = $null

  # --- the elevated sweep: nothing run from an account's folder, no link followed ------
  $mi = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\machine-install.ps1'))
  $sweep = ($mi -split 'function Remove-CoopPerUserPackages')[1]
  if ($sweep -match 'Start-Process' -or $sweep -match 'Uninstall coop\.exe''') { Ko 'the per-account sweep still runs a program from an account''s folder' }
  elseif ($sweep -notmatch 'Remove-CoopTreeNoFollow \$pkg' -or $sweep -match 'Remove-Item -LiteralPath \$pkg -Recurse') { Ko 'the per-account sweep does not remove the old package without following links' }
  else { Ok 'the elevated sweep removes an older per-account package itself, running nothing from it' }
  $tree = Join-Path $t 'tree'
  New-Item -ItemType Directory -Force -Path (Join-Path $tree 'Programs\coop') | Out-Null
  if (Test-CoopPathUnderReparsePoint $tree (Join-Path $tree 'Programs\coop')) { Ko 'Test-CoopPathUnderReparsePoint flags a plain folder' }
  else { Ok 'a plain folder is not under a link' }
  $outside = Join-Path $t 'outside'
  New-Item -ItemType Directory -Force -Path (Join-Path $outside 'coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $outside 'coop\keep.txt'), 'keep')
  $linked = $false
  try {
    if ($isWindowsHost) { New-Item -ItemType Junction -Path (Join-Path $tree 'Linked') -Target $outside | Out-Null } else { New-Item -ItemType SymbolicLink -Path (Join-Path $tree 'Linked') -Target $outside | Out-Null }
    $linked = $true
  } catch { Ok "skipped the link checks (no junction or link here: $($_.Exception.Message))" }
  if ($linked) {
    if (-not (Test-CoopPathUnderReparsePoint $tree (Join-Path $tree 'Linked\coop'))) { Ko 'Test-CoopPathUnderReparsePoint misses a folder reached through a link' }
    else { Ok 'a folder reached through a link is under a link, so the sweep leaves it' }
    $holder = Join-Path $t 'holder'
    New-Item -ItemType Directory -Force -Path $holder | Out-Null
    if ($isWindowsHost) { New-Item -ItemType Junction -Path (Join-Path $holder 'inner') -Target $outside | Out-Null } else { New-Item -ItemType SymbolicLink -Path (Join-Path $holder 'inner') -Target $outside | Out-Null }
    Remove-CoopTreeNoFollow $holder
    if (Test-Path -LiteralPath $holder) { Ko 'Remove-CoopTreeNoFollow left the folder' }
    elseif (-not (Test-Path -LiteralPath (Join-Path $outside 'coop\keep.txt'))) { Ko 'Remove-CoopTreeNoFollow followed a link and deleted what it points to' }
    else { Ok 'removing an old package removes a link inside it, never what the link points to' }
  }

  # --- #516: the "coop at sign-in" Run value on uninstall ------------------------------
  . (Join-Path $root 'scripts\window-uninstall.ps1')
  $ErrorActionPreference = 'Stop'
  $app = 'C:\Program Files\coop'
  $ours = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "C:\Program Files\coop\resources\coop\scripts\sign-in.ps1"'
  $clone = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "C:\dev\coop-agent\scripts\sign-in.ps1"'
  $sibling = $ours -replace 'Program Files\\coop\\', 'Program Files\coop-old\'
  $dots = $ours -replace 'coop\\resources\\coop\\scripts', 'coop\..\elsewhere\scripts'
  if (-not (Test-CoopStartupValueInPackage $ours $app) -or -not (Test-CoopStartupValueInPackage $ours.ToUpper() 'c:\program files\coop\')) { Ko 'Test-CoopStartupValueInPackage misses this install''s value (any case, trailing slash)' }
  elseif ((Test-CoopStartupValueInPackage $clone $app) -or (Test-CoopStartupValueInPackage $sibling $app) -or (Test-CoopStartupValueInPackage $dots $app)) { Ko 'Test-CoopStartupValueInPackage claims another checkout''s value, a sibling folder or a path with ..' }
  elseif ((Test-CoopStartupValueInPackage '' $app) -or (Test-CoopStartupValueInPackage $ours '')) { Ko 'Test-CoopStartupValueInPackage claims with no value or no folder' }
  else { Ok 'the uninstaller claims only a "coop at sign-in" value that starts this install''s sign-in.ps1' }
  if ($nsh -notmatch '(?s)!macro customUnInstall\s+\$\{ifNot\} \$\{isUpdated\}.*window-uninstall\.ps1') { Ko 'installer.nsh runs window-uninstall.ps1 on an upgrade too' }
  else { Ok 'an upgrade (--updated) keeps the Run value: window-uninstall.ps1 runs on a real uninstall only' }

  if ($isWindowsHost) {
    # A throwaway key stands in for the Run key: the account's real one is never touched.
    $key = 'HKCU:\Software\coop-test-' + [guid]::NewGuid().ToString('N') + '\Run'
    $pkgDir = Join-Path $t 'pkg'
    New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
    $value = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -File "' + $pkgDir + '\resources\coop\scripts\sign-in.ps1"'
    try {
      New-Item -Path $key -Force | Out-Null
      Set-ItemProperty -LiteralPath $key -Name 'coop at sign-in' -Value $value
      Set-ItemProperty -LiteralPath $key -Name 'Other app' -Value 'other.exe'
      $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $out = (& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\window-uninstall.ps1') $pkgDir -RunKey $key 2>&1 | Out-String)
      $ErrorActionPreference = $eap
      $left = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue)
      if ($left.'coop at sign-in') { Ko 'window-uninstall.ps1 left this install''s "coop at sign-in" value' $out }
      elseif ($left.'Other app' -ne 'other.exe') { Ko 'window-uninstall.ps1 touched another Run value' $out }
      else { Ok 'window-uninstall.ps1 removes this install''s "coop at sign-in" value and nothing else' }
      Set-ItemProperty -LiteralPath $key -Name 'coop at sign-in' -Value $clone
      $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $out = (& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\window-uninstall.ps1') $pkgDir -RunKey $key 2>&1 | Out-String)
      $ErrorActionPreference = $eap
      if ((Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'coop at sign-in' -ne $clone) { Ko 'window-uninstall.ps1 removed another checkout''s "coop at sign-in" value' $out }
      else { Ok 'window-uninstall.ps1 keeps a "coop at sign-in" value that starts another checkout' }
    } finally {
      Remove-Item -Path (Split-Path -Parent $key) -Recurse -Force -ErrorAction SilentlyContinue
    }

    # auto-update runs an installer only from an administrators-only folder.
    $open = Join-Path $t 'updates-open'
    New-Item -ItemType Directory -Force -Path $open | Out-Null
    if (Test-CoopFolderAdminOnly $open) { Ko 'Test-CoopFolderAdminOnly accepts a folder this account owns' }
    else { Ok 'auto-update refuses an updates folder another account could change' }
  }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
