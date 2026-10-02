#!/usr/bin/env pwsh
# coop desktop (master plan D1b), driven through bin/coop.ps1:
#   - `coop desktop --print-spec` hands the window the same Pi arguments as
#     `coop launch-spec --json` (Build-CoopPiArgs), never --approve or a mode
#   - the spec's env keys, paths and Pi entry (from the npm global root), and
#     desktop/lib/spec.mjs accepts it (node)
#   - a missing folder and an unknown option fail before anything starts
#   - the window runtime helpers: missing, stale and current, path.txt checks
# Offline; Pi is a stub package under a fake `npm root -g`; nothing is installed
# or launched; COOP_DIR and HOME are sandboxed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path $root 'bin\coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-desktop-spec-' + [guid]::NewGuid().ToString('N'))

# Run coop with stdout and stderr captured separately. Returns @{ Rc; Out; Err }.
function Invoke-Coop([string[]]$CoopArgs, [string]$Cwd) {
  $so = Join-Path $t 'out.txt'; $se = Join-Path $t 'err.txt'
  $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $coop + '"')) + @($CoopArgs | ForEach-Object { '"' + $_ + '"' })
  $p = Start-Process -FilePath $psExe -ArgumentList $argList -PassThru -NoNewWindow -WorkingDirectory $Cwd -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  return @{ Rc = $p.ExitCode; Out = [System.IO.File]::ReadAllText($so); Err = [System.IO.File]::ReadAllText($se) }
}

$saved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_NO_ONBOARD', 'COOP_SKIP_AZ', 'COOP_SKIP_UPDATE_CHECK', 'COOP_FIRST_RUN', 'NO_COLOR')
try {
  $node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object { -not $isWindowsHost -or $_.Source -like '*.exe' } | Select-Object -First 1).Source
  $script:bin = Join-Path $t 'bin'
  $npmRoot = Join-Path $t 'npm-global\node_modules'
  $work = Join-Path $t 'work folder'
  $sandboxHome = Join-Path $t 'home'
  New-Item -ItemType Directory -Force -Path $script:bin, $work, (Join-Path $t 'coop\.coop'), (Join-Path $t 'agent') | Out-Null
  New-SandboxHome $sandboxHome | Out-Null
  $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome; $env:APPDATA = Join-Path $sandboxHome 'AppData\Roaming'
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  Remove-Item Env:\PI_CODING_AGENT_DIR, Env:\COOP_NO_ISOLATE, Env:\COOP_FIRST_RUN -ErrorAction SilentlyContinue
  $env:COOP_NO_ONBOARD = '1'; $env:COOP_SKIP_AZ = '1'; $env:COOP_SKIP_UPDATE_CHECK = '1'; $env:NO_COLOR = '1'

  # Pi: a package under the fake npm global root, and `pi` on PATH.
  $piPkg = Join-Path $npmRoot '@earendil-works\pi-coding-agent'
  New-Item -ItemType Directory -Force -Path (Join-Path $piPkg 'dist\bundle') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $piPkg 'package.json'), '{"name":"@earendil-works/pi-coding-agent","version":"0.87.1","bin":{"pi":"dist/bundle/cli.js"}}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $piPkg 'dist\bundle\cli.js'), "console.log('pi stub')`n", $utf8)
  Write-Shim 'pi' 'echo pi-stub' '@echo pi-stub'
  Write-Shim 'npm' "if [ `"`$1 `$2`" = 'root -g' ]; then echo '$npmRoot'; fi" "@if `"%1 %2`"==`"root -g`" echo $npmRoot"
  $env:PATH = $script:bin + $sep + (Split-Path -Parent $node) + $sep + $env:PATH

  $r = Invoke-Coop @('desktop', '--print-spec') $work
  $spec = $null
  try { $spec = $r.Out.Trim() | ConvertFrom-Json } catch { }
  if ($r.Rc -eq 0 -and $spec) { Ok 'coop desktop --print-spec prints the launch spec as JSON' } else { Ko "print-spec failed (rc=$($r.Rc))" ($r.Out + $r.Err) }
  $launch = Invoke-Coop @('launch-spec', '--json') $work
  $launchSpec = $null
  try { $launchSpec = ($launch.Out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { }
  if ($spec -and $launchSpec -and ((@($spec.args) -join "`n") -ceq (@($launchSpec.args) -join "`n")) -and @($spec.args).Count -gt 5) {
    Ok 'the window gets exactly the terminal''s Pi arguments (launch-spec)'
  } else { Ko 'spec args differ from launch-spec' ($r.Out + "`n" + $launch.Out + $launch.Err) }
  if ($spec -and -not @($spec.args | Where-Object { $_ -in @('-a', '--approve', '--mode', '-p', '--print') -or $_ -like '--mode=*' })) { Ok 'no --approve and no Pi mode in the spec' } else { Ko 'spec carries --approve or a mode' $r.Out }
  if ($spec) {
    $badKeys = @($spec.env.PSObject.Properties.Name | Where-Object { $_ -notmatch '^(PI|COOP)_[A-Z0-9_]+$' })
    if ($badKeys.Count -eq 0 -and $spec.env.PI_CODING_AGENT_DIR -and $spec.env.COOP_DIR -eq $env:COOP_DIR) { Ok 'spec env: PI_/COOP_ keys only, with the agent dir and the profile' } else { Ko "spec env keys: $($badKeys -join ', ')" $r.Out }
    $wantEntry = [System.IO.Path]::GetFullPath((Join-Path $piPkg 'dist\bundle\cli.js'))
    if ($spec.entry -eq $wantEntry -and $spec.node -eq $node) { Ok 'spec runs node on Pi''s entry from the npm global root' } else { Ko "spec entry/node: $($spec.entry) / $($spec.node)" }
    if ($spec.cwd -eq (Resolve-Path -LiteralPath $work).ProviderPath -and $spec.schema -eq 1 -and $spec.loginPresent -eq $false -and ($spec.coop -replace '\\', '/') -like '*/bin/coop.ps1') { Ok 'spec folder, schema, coop.ps1 and no stored login' } else { Ko 'spec fields' $r.Out }
  }

  # The window's own validator accepts what coop.ps1 printed.
  $specModule = [System.Uri]::new((Join-Path $root 'desktop\lib\spec.mjs')).AbsoluteUri
  $checker = Join-Path $t 'check-spec.mjs'
  [System.IO.File]::WriteAllText($checker, "const { parseSpec, piArgv } = await import(process.argv[2]);`nconst spec = parseSpec(process.env.COOP_DESKTOP_SPEC);`nconst argv = piArgv(spec);`nif (argv.args[1] !== '--mode' || argv.args[2] !== 'rpc') process.exit(2);`nconsole.log('spec-ok ' + spec.args.length);`n", $utf8)
  $env:COOP_DESKTOP_SPEC = $r.Out.Trim()
  $nodeOut = (& $node $checker $specModule 2>&1 | Out-String)
  $nodeRc = $LASTEXITCODE
  Remove-Item Env:\COOP_DESKTOP_SPEC -ErrorAction SilentlyContinue
  if ($nodeRc -eq 0 -and $nodeOut -match 'spec-ok \d+') { Ok 'desktop/lib/spec.mjs accepts the spec and adds --mode rpc' } else { Ko "spec.mjs refused the spec (rc=$nodeRc)" $nodeOut }

  $missing = Invoke-Coop @('desktop', (Join-Path $t 'no-such-folder')) $work
  if ($missing.Rc -ne 0 -and ($missing.Out + $missing.Err) -match 'folder not found') { Ok 'a missing folder fails before anything starts' } else { Ko "missing folder (rc=$($missing.Rc))" ($missing.Out + $missing.Err) }
  $bogus = Invoke-Coop @('desktop', '--bogus') $work
  if ($bogus.Rc -ne 0 -and ($bogus.Out + $bogus.Err) -match "unknown option '--bogus'") { Ok 'an unknown option is refused' } else { Ko "unknown option (rc=$($bogus.Rc))" ($bogus.Out + $bogus.Err) }

  # --- the window runtime helpers ---------------------------------------------
  . (Join-Path $root 'lib\common.ps1')
  $pin = Get-CoopDesktopElectronPin
  if ($pin -match '^\d+\.\d+\.\d+$') { Ok "manifest pins the window's Electron ($pin)" } else { Ko "desktop.electron pin: '$pin'" }
  if ((Get-CoopDesktopRuntimeDir) -eq (Join-Path $env:COOP_DIR '.coop\desktop\runtime') -and (Get-CoopDesktopDataDir) -eq (Join-Path $env:COOP_DIR '.coop\desktop\data')) { Ok 'runtime and window data live under the profile' } else { Ko "runtime dir: $(Get-CoopDesktopRuntimeDir)" }
  if ((Get-CoopDesktopRuntimeState) -eq 'missing') { Ok 'runtime state: missing before the first coop desktop' } else { Ko "state: $(Get-CoopDesktopRuntimeState)" }
  $rt = Get-CoopDesktopRuntimeDir
  $pkg = Join-Path $rt 'node_modules\electron'
  New-Item -ItemType Directory -Force -Path (Join-Path $pkg 'dist') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $pkg 'package.json'), ('{"name":"electron","version":"' + $pin + '"}'), $utf8)
  [System.IO.File]::WriteAllText((Join-Path $pkg 'path.txt'), 'electron.exe', $utf8)
  if ((Get-CoopDesktopRuntimeState) -eq 'stale') { Ok 'runtime state: stale while the binary is missing' } else { Ko "state without binary: $(Get-CoopDesktopRuntimeState)" }
  [System.IO.File]::WriteAllText((Join-Path $pkg 'dist\electron.exe'), 'stub', $utf8)
  if ((Get-CoopDesktopRuntimeState) -eq 'stale') { Ok 'runtime state: stale without the shipped lock' } else { Ko "state without lock: $(Get-CoopDesktopRuntimeState)" }
  Copy-Item -LiteralPath (Join-Path $root 'config\desktop-lock.json') -Destination (Join-Path $rt 'package-lock.json')
  if ((Get-CoopDesktopRuntimeState) -eq 'current' -and (Get-CoopDesktopElectronExe) -eq (Join-Path $pkg 'dist\electron.exe')) { Ok 'runtime state: current with the pin, the lock and the binary' } else { Ko "state: $(Get-CoopDesktopRuntimeState)" }
  [System.IO.File]::WriteAllText((Join-Path $pkg 'package.json'), '{"name":"electron","version":"1.0.0"}', $utf8)
  if ((Get-CoopDesktopRuntimeState) -eq 'stale' -and (Get-CoopDesktopElectronVersion) -eq '1.0.0') { Ok 'runtime state: stale after a pin bump' } else { Ko "state after bump: $(Get-CoopDesktopRuntimeState)" }
  [System.IO.File]::WriteAllText((Join-Path $pkg 'path.txt'), '..\..\..\evil.exe', $utf8)
  if (-not (Get-CoopDesktopElectronExe)) { Ok 'path.txt cannot point outside the Electron package' } else { Ko 'path.txt escaped dist' }
  if (-not $isWindowsHost) {
    if (-not (Set-CoopWindowShortcut)) { Ok 'no window shortcut off Windows' } else { Ko 'shortcut written off Windows' }
  }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  desktop-spec tests passed' } else { Write-Host "  $G_CROSS desktop-spec tests FAILED" }
exit $fail
