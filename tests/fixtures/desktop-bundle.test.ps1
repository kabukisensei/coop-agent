#!/usr/bin/env pwsh
# The coop window package's bundled runtime (master plan D1d): run from the
# package's coop snapshot (<app>\resources\coop) with <app>\resources\runtime
# beside it, lib/common.ps1
#   - puts the bundled Node and the bundled npm prefix (pi) first on PATH, points
#     npm's global prefix at the bundle and finds the package's coop.exe;
#   - `coop version` and `coop desktop --print-spec` resolve the bundled Pi and
#     node, and the spec's coop.ps1 is the snapshot's;
#   - Restore-CoopBundledExtensions seeds <agent dir>\npm from the bundled tree
#     (lock, package.json, node_modules) and declares the extensions in
#     settings.json as `pi install` would; a converged tree is left alone, a
#     bundle built for another lock is ignored;
#   - the first `coop desktop` on a profile without the lock runs the install
#     first and stops when it fails; after the seed nothing is pending;
#   - doctor reports the package instead of the "not a git checkout" warning.
# Offline: node and python are real (lib/extlock.js, lib/pi_settings.py); Pi
# and npm are stubs and the snapshot's scripts\install.ps1 is replaced by a
# stub that records its call and fails; HOME, COOP_DIR and the agent dir are
# sandboxed; the snapshot is a copy of this checkout's runtime files under a
# temp dir.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-desktop-bundle-' + [guid]::NewGuid().ToString('N'))

function Invoke-Coop([string]$Script, [string[]]$CoopArgs, [string]$Cwd) {
  $so = Join-Path $t 'out.txt'; $se = Join-Path $t 'err.txt'
  $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $Script + '"')) + @($CoopArgs | ForEach-Object { '"' + $_ + '"' })
  $p = Start-Process -FilePath $psExe -ArgumentList $argList -PassThru -NoNewWindow -WorkingDirectory $Cwd -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  return @{ Rc = $p.ExitCode; Out = [System.IO.File]::ReadAllText($so); Err = [System.IO.File]::ReadAllText($se) }
}

$saved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_NO_ONBOARD', 'COOP_SKIP_AZ', 'COOP_SKIP_UPDATE_CHECK', 'COOP_FIRST_RUN', 'NO_COLOR', 'npm_config_prefix', 'COOP_BUNDLED_RUNTIME', 'COOP_TEST_INSTALL_LOG')
try {
  $realNode = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object { -not $isWindowsHost -or $_.Source -like '*.exe' } | Select-Object -First 1).Source
  $realPy = Get-FixturePython
  if (-not $realPy) { throw 'no Python for the fixture' }
  $manifest = Get-Content -LiteralPath (Join-Path $root 'config\release-manifest.json') -Raw | ConvertFrom-Json
  $piVer = [string]$manifest.pi.version
  $extNames = @($manifest.extensions.PSObject.Properties.Name)

  # --- the package: <app>\coop.exe, resources\coop (the snapshot), resources\runtime
  $app = Join-Path $t 'app'
  $snapshot = Join-Path $app 'resources\coop'
  $runtime = Join-Path $app 'resources\runtime'
  New-Item -ItemType Directory -Force -Path $snapshot, $runtime, (Join-Path $snapshot 'docs') | Out-Null
  foreach ($d in @('bin', 'lib', 'config', 'scripts', 'skills', 'prompts', 'extensions', 'themes', 'vibes')) {
    Copy-Item -LiteralPath (Join-Path $root $d) -Destination (Join-Path $snapshot $d) -Recurse -Force
  }
  Copy-Item -LiteralPath (Join-Path $root 'VERSION') -Destination (Join-Path $snapshot 'VERSION')
  Copy-Item -LiteralPath (Join-Path $root 'docs\guardrails.md') -Destination (Join-Path $snapshot 'docs\guardrails.md')
  [System.IO.File]::WriteAllText((Join-Path $app 'coop.exe'), 'stub', $utf8)
  $coop = Join-Path $snapshot 'bin\coop.ps1'
  # The install the first launch runs: a stub that records the call and fails,
  # so nothing is installed here and the failure path is what the test sees.
  $installLog = Join-Path $t 'install.log'
  [System.IO.File]::WriteAllText((Join-Path $snapshot 'scripts\install.ps1'), "[System.IO.File]::AppendAllText(`$env:COOP_TEST_INSTALL_LOG, ('install.ps1 ' + (`$args -join ' ') + [Environment]::NewLine))`nexit 7`n", $utf8)

  # runtime\node: the bundled Node (the real node.exe on Windows, where the
  # window needs an .exe; a forwarder elsewhere) plus an npm stub.
  $nodeDir = Join-Path $runtime 'node'
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  if ($isWindowsHost) { Copy-Item -LiteralPath $realNode -Destination (Join-Path $nodeDir 'node.exe') }
  else { Write-Shim 'node' ("exec '" + $realNode + "' `"`$@`"") '' -Dir $nodeDir }
  $bundledNode = if ($isWindowsHost) { Join-Path $nodeDir 'node.exe' } else { Join-Path $nodeDir 'node' }
  Write-Shim 'npm' 'if [ "$1" = "--version" ]; then echo 10.9.0; fi; if [ "$1 $2" = "prefix -g" ]; then echo "$npm_config_prefix"; fi' 'if "%1"=="--version" echo 10.9.0&if "%1 %2"=="prefix -g" echo %npm_config_prefix%' -Dir $nodeDir
  # runtime\npm: the global prefix with the pi shim and Pi's package.
  $prefix = Join-Path $runtime 'npm'
  $npmRoot = if ($isWindowsHost) { Join-Path $prefix 'node_modules' } else { Join-Path $prefix 'lib/node_modules' }
  $piPkg = Join-Path $npmRoot '@earendil-works\pi-coding-agent'
  New-Item -ItemType Directory -Force -Path (Join-Path $piPkg 'dist\bundle') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $piPkg 'package.json'), ('{"name":"@earendil-works/pi-coding-agent","version":"' + $piVer + '","bin":{"pi":"dist/bundle/cli.js"}}'), $utf8)
  [System.IO.File]::WriteAllText((Join-Path $piPkg 'dist\bundle\cli.js'), "console.log('pi stub')`n", $utf8)
  Write-Shim 'pi' ('echo ' + $piVer) ('@echo ' + $piVer) -Dir $prefix
  # runtime\extensions: the tree from the lock (stub packages at their pins).
  $bundleExt = Join-Path $runtime 'extensions'
  New-Item -ItemType Directory -Force -Path $bundleExt | Out-Null
  $treePkg = (& $realNode (Join-Path $root 'lib\extlock.js') package-json (Join-Path $root 'config\release-manifest.json') | Out-String)
  [System.IO.File]::WriteAllText((Join-Path $bundleExt 'package.json'), $treePkg, $utf8)
  Copy-Item -LiteralPath (Join-Path $root 'config\extensions-lock.json') -Destination (Join-Path $bundleExt 'package-lock.json')
  foreach ($n in $extNames) {
    $d = Join-Path (Join-Path $bundleExt 'node_modules') $n
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $d 'package.json'), ('{"name":"' + $n + '","version":"' + [string]$manifest.extensions.$n + '"}'), $utf8)
  }
  $lockSha = (Get-FileHash -LiteralPath (Join-Path $root 'config\extensions-lock.json') -Algorithm SHA256).Hash.ToLower()
  $marker = '{"schema":1,"coop":"' + (Get-Content -LiteralPath (Join-Path $root 'VERSION') -Raw).Trim() + '","node":{"version":"' + [string]$manifest.desktop.node.version + '","dir":"node"},"npm":{"prefix":"npm"},"pi":"' + $piVer + '","extensions":{"dir":"extensions","lockSha256":"' + $lockSha + '"}}'
  [System.IO.File]::WriteAllText((Join-Path $runtime 'coop-runtime.json'), $marker, $utf8)

  # --- sandbox: PATH carries only python and the real node; the bundle must
  # add its own.
  $script:bin = Join-Path $t 'bin'
  $work = Join-Path $t 'work'
  $sandboxHome = Join-Path $t 'home'
  $agent = Join-Path $t 'agent'
  New-Item -ItemType Directory -Force -Path $script:bin, $work, (Join-Path $t 'coop\.coop'), $agent | Out-Null
  New-SandboxHome $sandboxHome | Out-Null
  $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome
  $env:APPDATA = Join-Path $sandboxHome 'AppData\Roaming'; $env:LOCALAPPDATA = Join-Path $sandboxHome 'AppData\Local'
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  Remove-Item Env:\PI_CODING_AGENT_DIR, Env:\COOP_NO_ISOLATE, Env:\COOP_FIRST_RUN, Env:\npm_config_prefix, Env:\COOP_BUNDLED_RUNTIME -ErrorAction SilentlyContinue
  $env:COOP_NO_ONBOARD = '1'; $env:COOP_SKIP_AZ = '1'; $env:COOP_SKIP_UPDATE_CHECK = '1'; $env:NO_COLOR = '1'
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  $env:COOP_TEST_INSTALL_LOG = $installLog
  $env:PATH = (Split-Path -Parent $realPy) + $sep + (Split-Path -Parent $realNode)

  # --- A. the snapshot's coop finds the bundle by location ---------------------
  $v = Invoke-Coop $coop @('version') $work
  if ($v.Rc -eq 0 -and $v.Out -match 'coop \d+\.\d+\.\d+' -and $v.Out -match ('pi\s+' + [regex]::Escape($piVer))) { Ok 'coop version from the snapshot runs the bundled pi' } else { Ko "coop version (rc=$($v.Rc))" ($v.Out + $v.Err) }

  $r = Invoke-Coop $coop @('desktop', '--print-spec') $work
  $spec = $null
  try { $spec = $r.Out.Trim() | ConvertFrom-Json } catch { }
  if ($r.Rc -eq 0 -and $spec) { Ok 'coop desktop --print-spec from the snapshot prints a spec' } else { Ko "print-spec (rc=$($r.Rc))" ($r.Out + $r.Err) }
  if ($spec) {
    if ([System.IO.Path]::GetFullPath($spec.node) -eq [System.IO.Path]::GetFullPath($bundledNode)) { Ok 'the spec runs the bundled node' } else { Ko "spec.node: $($spec.node)" }
    $wantEntry = [System.IO.Path]::GetFullPath((Join-Path $piPkg 'dist\bundle\cli.js'))
    if ([System.IO.Path]::GetFullPath($spec.entry) -eq $wantEntry) { Ok 'the spec runs the bundled Pi entry (no npm call)' } else { Ko "spec.entry: $($spec.entry)" }
    if ([System.IO.Path]::GetFullPath($spec.coop) -eq [System.IO.Path]::GetFullPath($coop)) { Ok 'the spec names the snapshot''s coop.ps1' } else { Ko "spec.coop: $($spec.coop)" }
    if (@($spec.args).Count -gt 5 -and -not @($spec.args | Where-Object { $_ -in @('-a', '--approve', '--mode') })) { Ok 'the spec carries the terminal''s Pi arguments' } else { Ko 'spec args' $r.Out }
  }

  # --- B. the first coop desktop on a profile without the lock runs the install
  $d = Invoke-Coop $coop @('desktop', $work) $work
  $log = if (Test-Path -LiteralPath $installLog) { [System.IO.File]::ReadAllText($installLog) } else { '' }
  if ($d.Rc -ne 0 -and ($d.Out + $d.Err) -match 'setup did not finish' -and $log -match 'install\.ps1') { Ok 'first coop desktop runs scripts\install.ps1 first and stops when it fails' } else { Ko "first launch (rc=$($d.Rc))" ($d.Out + $d.Err + "`nlog: " + $log) }
  if (-not (Test-Path -LiteralPath (Join-Path $agent 'npm\node_modules'))) { Ok 'a failed setup seeds nothing' } else { Ko 'a failed setup must not seed the tree' }

  # --- C. the library in process: detection, prefix, seeding --------------------
  . (Join-Path $snapshot 'lib\common.ps1')
  if (Test-CoopBundledRuntime) { Ok 'lib/common.ps1 detects the runtime folder beside the snapshot' } else { Ko 'bundled runtime not detected' }
  # An existing terminal install keeps the `coop` command: its link forwards elsewhere.
  $otherRoot = Join-Path $t 'other-coop-agent'
  New-Item -ItemType Directory -Force -Path (Join-Path $otherRoot 'bin') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $otherRoot 'bin\coop.cmd'), "@echo off`r`n", $utf8)
  $linkDir = Join-Path $t 'localbin'
  New-Item -ItemType Directory -Force -Path $linkDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $linkDir 'coop.cmd'), "@echo off`r`ncall `"$(Join-Path $otherRoot 'bin\coop.cmd')`" %*`r`n", $utf8)
  if (Test-CoopForeignLauncherLink -LauncherDir $linkDir) { Ok 'a coop link that forwards to another install is foreign (the package leaves it)' } else { Ko 'foreign link not detected' }
  [System.IO.File]::WriteAllText((Join-Path $linkDir 'coop.cmd'), "@echo off`r`ncall `"$(Join-Path $snapshot 'bin\coop.cmd')`" %*`r`n", $utf8)
  if (-not (Test-CoopForeignLauncherLink -LauncherDir $linkDir)) { Ok 'a coop link that forwards to the snapshot is the package''s own' } else { Ko 'own link read as foreign' }
  Remove-Item -LiteralPath (Join-Path $linkDir 'coop.cmd') -Force
  if (-not (Test-CoopForeignLauncherLink -LauncherDir $linkDir)) { Ok 'no coop link: nothing foreign' } else { Ko 'missing link read as foreign' }
  if ([System.IO.Path]::GetFullPath($env:npm_config_prefix) -eq [System.IO.Path]::GetFullPath($prefix)) { Ok 'npm''s global prefix is the bundled one' } else { Ko "npm_config_prefix: $($env:npm_config_prefix)" }
  $pathDirs = @($env:PATH -split $sep)
  if (($pathDirs.IndexOf($nodeDir) -ge 0) -and ($pathDirs.IndexOf($nodeDir) -lt $pathDirs.IndexOf((Split-Path -Parent $realNode))) -and ($pathDirs -contains $prefix)) { Ok 'the bundled node precedes the machine''s node on PATH, with the prefix' } else { Ko "PATH: $($pathDirs -join ', ')" }
  if ([System.IO.Path]::GetFullPath($script:CoopWindowExe) -eq [System.IO.Path]::GetFullPath((Join-Path $app 'coop.exe'))) { Ok 'the package''s coop.exe is the default window' } else { Ko "CoopWindowExe: $($script:CoopWindowExe)" }
  if ([System.IO.Path]::GetFullPath(@(Get-CoopNpmGlobalRoots)[0]) -eq [System.IO.Path]::GetFullPath($npmRoot)) { Ok 'the bundled prefix is the first npm global root' } else { Ko "roots: $(@(Get-CoopNpmGlobalRoots) -join ', ')" }
  $nodeRow = Get-CoopPrereqs $true | Where-Object { $_.Order -eq 2 }
  if ($nodeRow.Ok -and $nodeRow.Detail -like '*bundled with the coop window*') { Ok 'the Node prerequisite row says it is bundled' } else { Ko "node row: $($nodeRow.Ok) $($nodeRow.Detail)" }
  if (Test-CoopBundledSetupPending) { Ok 'setup is pending before the seed' } else { Ko 'setup must be pending on a fresh agent dir' }

  $seeded = Restore-CoopBundledExtensions -AgentDir $agent
  if ($seeded -eq $true) { Ok 'Restore-CoopBundledExtensions seeds a fresh agent dir' } else { Ko 'seed returned false' }
  $allThere = $true
  foreach ($n in $extNames) { if ((Get-CoopExtInstalledVersion -AgentDir $agent -Name $n) -ne [string]$manifest.extensions.$n) { $allThere = $false } }
  if ($allThere) { Ok 'every extension is in the agent dir at its pin' } else { Ko 'extensions missing from the seeded tree' }
  $treeLock = Join-Path $agent 'npm\package-lock.json'
  if ((Test-Path -LiteralPath $treeLock) -and ((Get-FileHash -LiteralPath $treeLock -Algorithm SHA256).Hash.ToLower() -eq $lockSha)) { Ok 'the seeded tree carries the shipped lock' } else { Ko 'seeded tree lock' }
  $settings = Get-Content -LiteralPath (Join-Path $agent 'settings.json') -Raw | ConvertFrom-Json
  $declared = $true
  foreach ($n in $extNames) { if (@($settings.packages) -notcontains ('npm:' + $n + '@' + [string]$manifest.extensions.$n)) { $declared = $false } }
  if ($declared) { Ok 'settings.json declares each extension as pi install would' } else { Ko "settings packages: $(@($settings.packages) -join ', ')" }
  if (-not (Test-CoopExtensionsLockPending -AgentDir $agent -PiVersion $piVer)) { Ok 'the lock is no longer pending' } else { Ko 'lock still pending after the seed' }
  if (-not (Test-CoopBundledSetupPending)) { Ok 'nothing is pending after the seed' } else { Ko 'setup still pending after the seed' }
  if ((Restore-CoopBundledExtensions -AgentDir $agent) -eq $false) { Ok 'a converged tree is left alone' } else { Ko 'second seed must be a no-op' }

  # A bundle built for another lock never seeds.
  $agent2 = Join-Path $t 'agent2'
  New-Item -ItemType Directory -Force -Path $agent2 | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $bundleExt 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}', $utf8)
  if ((Restore-CoopBundledExtensions -AgentDir $agent2) -eq $false -and -not (Test-Path -LiteralPath (Join-Path $agent2 'npm'))) { Ok 'a bundle for another lock is ignored' } else { Ko 'bundle with a foreign lock seeded' }
  Copy-Item -LiteralPath (Join-Path $root 'config\extensions-lock.json') -Destination (Join-Path $bundleExt 'package-lock.json') -Force

  # --- D. doctor from the snapshot: the package rows, no git warning -----------
  $script:doctor = Join-Path $snapshot 'scripts\doctor.ps1'
  $rows = Get-DoctorRows
  $pkgRow = Find-Row $rows 'coop window package v'
  if ($pkgRow -and $pkgRow.status -eq 'ok') { Ok 'doctor: the repository row names the package' } else { Ko 'doctor package row' (Show-Rows $rows 'coop-agent repository') }
  $winRow = Find-Row $rows 'coop window: this package'
  if ($winRow -and $winRow.status -eq 'ok' -and $winRow.name -like ('*Node ' + [string]$manifest.desktop.node.version + '*') -and $winRow.name -like ('*Pi ' + $piVer + '*')) { Ok 'doctor: the window row names the bundled Node and Pi' } else { Ko 'doctor window row' (Show-Rows $rows 'coop window') }
  if (-not (Find-Row $rows 'NEVER update')) { Ok 'doctor: no "not a git checkout" warning for the package' } else { Ko 'doctor still warns about git' }
  # --- D. the uninstaller's cleanup: scripts\window-uninstall.ps1 removes the
  # first launch's `coop` link (and "coop" shortcut) only when it points into
  # the package; a terminal install's own stays.
  $la = Join-Path $t 'localappdata'
  $linkFile = Join-Path (Join-Path (Join-Path $la 'coop') 'bin') 'coop.cmd'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $linkFile) | Out-Null
  $env:LOCALAPPDATA = $la
  $env:APPDATA = Join-Path $t 'appdata'
  $env:USERPROFILE = Join-Path $t 'profile'
  $unlink = Join-Path $snapshot 'scripts\window-uninstall.ps1'
  [System.IO.File]::WriteAllText($linkFile, "@echo off`r`ncall `"$(Join-Path $otherRoot 'bin\coop.cmd')`" %*`r`n", $utf8)
  $u = Invoke-Coop $unlink @($app) $t
  if ($u.Rc -eq 0 -and (Test-Path -LiteralPath $linkFile)) { Ok 'window-uninstall keeps a coop link that forwards to another install' } else { Ko "foreign link (rc=$($u.Rc), exists=$(Test-Path -LiteralPath $linkFile))" ($u.Out + $u.Err) }
  [System.IO.File]::WriteAllText($linkFile, "@echo off`r`ncall `"$(Join-Path $snapshot 'bin\coop.cmd')`" %*`r`n", $utf8)
  $u = Invoke-Coop $unlink @($app) $t
  if ($u.Rc -eq 0 -and -not (Test-Path -LiteralPath $linkFile)) { Ok 'window-uninstall removes the coop link that forwards into the package' } else { Ko "package link (rc=$($u.Rc), exists=$(Test-Path -LiteralPath $linkFile))" ($u.Out + $u.Err) }
  $u = Invoke-Coop $unlink @() $t
  if ($u.Rc -eq 0) { Ok 'window-uninstall without an install dir does nothing and exits 0' } else { Ko "no-arg run rc=$($u.Rc)" ($u.Out + $u.Err) }
  if ($env:OS -eq 'Windows_NT') {
    $deskDir = Join-Path $env:USERPROFILE 'Desktop'
    New-Item -ItemType Directory -Force -Path $deskDir | Out-Null
    $ws = New-Object -ComObject WScript.Shell
    $psExeWin = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    foreach ($pair in @(@('coop.lnk', (Join-Path $snapshot 'bin\coop-desktop.ps1')), @('coop (terminal).lnk', (Join-Path $otherRoot 'bin\coop-desktop.ps1')))) {
      $sc = $ws.CreateShortcut((Join-Path $deskDir $pair[0])); $sc.TargetPath = $psExeWin; $sc.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$($pair[1])`""; $sc.Save()
    }
    $u = Invoke-Coop $unlink @($app) $t
    if ($u.Rc -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $deskDir 'coop.lnk')) -and (Test-Path -LiteralPath (Join-Path $deskDir 'coop (terminal).lnk'))) { Ok 'window-uninstall removes the "coop" shortcut into the package and keeps a foreign one' } else { Ko "shortcuts (rc=$($u.Rc))" ($u.Out + $u.Err) }
  }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
