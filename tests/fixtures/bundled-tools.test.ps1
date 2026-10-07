#!/usr/bin/env pwsh
# D1k: the coop window package carries every tool a teammate needs
# (desktop/scripts/build-installer.mjs stages them; coop-runtime.json names
# them). From a snapshot with such a runtime, lib/common.ps1
#   - puts the bundled npm prefix, Node, Git (git\cmd), Python (and its Scripts,
#     where pipx.cmd lives) and the Azure CLI (az\bin) first on PATH, in that order;
#   - points COOP_BUNDLED_WHEELS at the wheel folder and finds the ODBC MSI and
#     VC++ runtime (Install-CoopBundledOdbc);
#   - Use-CoopBundledWheels turns pipx installs and injects of exact pins offline
#     (PIP_NO_INDEX, PIP_FIND_LINKS) and leaves --edge, upgrade and
#     COOP_PIP_ONLINE=1 on the index; Restore-CoopBundledWheels puts the old
#     values back;
#   - Get-CoopBundledPython and Test-CoopBundledPath name the package's copies;
#   - a D1d marker without the D1k entries still loads (Node and Pi only).
# Offline, no real home; the runtime is folders and empty files under a temp dir.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-bundled-tools-' + [guid]::NewGuid().ToString('N'))

function New-Runtime([string]$Dir, [bool]$WithTools) {
  foreach ($d in @('node', 'npm')) { New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null }
  $marker = [ordered]@{ schema = 1; coop = '0.0.0'; node = @{ version = '22.19.0'; dir = 'node' }; npm = @{ prefix = 'npm' }; pi = '0.87.1'; extensions = @{ dir = 'extensions'; lockSha256 = ('ab' * 32) } }
  if ($WithTools) {
    foreach ($d in @('git\cmd', 'python\Scripts', 'python-wheels', 'az\bin', 'installers')) { New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null }
    foreach ($f in @('python\python.exe', 'installers\msodbcsql.msi', 'installers\VC_redist.x64.exe')) { [System.IO.File]::WriteAllText((Join-Path $Dir $f), 'stub', $utf8) }
    $marker.git = @{ version = '2.56.0'; dir = 'git' }
    $marker.python = @{ version = '3.13.16'; dir = 'python'; wheels = 'python-wheels' }
    $marker.azureCli = @{ version = '2.91.0'; dir = 'az' }
    $marker.odbc = @{ version = '18.6.2.1'; dir = 'installers'; msi = 'msodbcsql.msi'; vcRedist = 'VC_redist.x64.exe'; vcRedistVersion = '14.50.35719.0' }
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir 'coop-runtime.json'), ($marker | ConvertTo-Json -Depth 5), $utf8)
}

$saved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_BUNDLED_RUNTIME', 'COOP_BUNDLED_WHEELS', 'COOP_PIP_ONLINE', 'PIP_NO_INDEX', 'PIP_FIND_LINKS', 'npm_config_prefix')
try {
  New-Item -ItemType Directory -Force -Path $t, (Join-Path $t 'home') | Out-Null
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:NO_COLOR = '1'
  Remove-Item Env:\COOP_BUNDLED_WHEELS, Env:\COOP_PIP_ONLINE, Env:\PIP_NO_INDEX -ErrorAction SilentlyContinue
  $env:PIP_FIND_LINKS = 'user-links'
  $rt = Join-Path $t 'runtime'
  New-Runtime $rt $true
  $env:COOP_BUNDLED_RUNTIME = $rt
  . (Join-Path $root 'lib\common.ps1')

  $sep = [System.IO.Path]::PathSeparator
  $want = @('npm', 'node', 'git\cmd', 'python', 'python\Scripts', 'az\bin') | ForEach-Object { Join-Path $rt $_ }
  $head = @(($env:PATH -split $sep) | Select-Object -First $want.Count)
  if (($head -join '|') -ne ($want -join '|')) { Ko 'PATH does not start with the bundled prefix, Node, Git, Python, Scripts and az\bin' ($head -join "`n") }
  else { Ok 'PATH starts with the bundled npm prefix, Node, Git, Python (and Scripts) and the Azure CLI' }

  if ($env:COOP_BUNDLED_WHEELS -ne (Join-Path $rt 'python-wheels')) { Ko "COOP_BUNDLED_WHEELS is '$($env:COOP_BUNDLED_WHEELS)'" }
  elseif (-not $script:CoopBundledOdbc -or $script:CoopBundledOdbc.Msi -ne (Join-Path $rt 'installers\msodbcsql.msi') -or $script:CoopBundledOdbc.VcRedist -ne (Join-Path $rt 'installers\VC_redist.x64.exe') -or $script:CoopBundledOdbc.Version -ne '18.6.2.1') { Ko 'the bundled ODBC installers were not found' ($script:CoopBundledOdbc | Out-String) }
  else { Ok 'the wheel folder and the ODBC MSI with its VC++ runtime are found' }

  if ((Get-CoopBundledPython) -ne (Join-Path $rt 'python\python.exe')) { Ko "Get-CoopBundledPython returned '$(Get-CoopBundledPython)'" }
  elseif (-not (Test-CoopBundledPath (Join-Path $rt 'git\cmd\git.exe')) -or (Test-CoopBundledPath (Join-Path $t 'elsewhere\git.exe'))) { Ko 'Test-CoopBundledPath does not tell the package''s copies from others' }
  else { Ok 'Get-CoopBundledPython and Test-CoopBundledPath name the package''s own copies' }

  # Offline for exact pins only.
  $cases = @(
    @{ Args = @('install', 'coop-data-doc==1.3.4'); Offline = $true; Name = 'install of a pin' },
    @{ Args = @('install', '--force', '--python', 'C:\py\python.exe', 'ms-fabric-cli==1.7.0'); Offline = $true; Name = 'forced install with --python' },
    @{ Args = @('inject', 'ms-fabric-cli', 'pyodbc==5.3.0', '--force'); Offline = $true; Name = 'inject of a pin' },
    @{ Args = @('install', 'coop-data-doc'); Offline = $false; Name = 'unpinned (--edge) install' },
    @{ Args = @('inject', 'ms-fabric-cli', 'fabric-cicd', '--force'); Offline = $false; Name = 'unpinned inject' },
    @{ Args = @('upgrade', 'coop-data-doc'); Offline = $false; Name = 'pipx upgrade' },
    @{ Args = @('list'); Offline = $false; Name = 'pipx list' }
  )
  foreach ($c in $cases) {
    $s = Use-CoopBundledWheels $c.Args
    $isOff = ($env:PIP_NO_INDEX -eq '1' -and $env:PIP_FIND_LINKS -eq (Join-Path $rt 'python-wheels'))
    Restore-CoopBundledWheels $s
    $back = (-not $env:PIP_NO_INDEX -and $env:PIP_FIND_LINKS -eq 'user-links')
    if ($isOff -ne $c.Offline) { Ko "$($c.Name): offline=$isOff, expected $($c.Offline)" }
    elseif (-not $back) { Ko "$($c.Name): the pip variables were not restored (PIP_NO_INDEX='$($env:PIP_NO_INDEX)', PIP_FIND_LINKS='$($env:PIP_FIND_LINKS)')" }
  }
  $env:COOP_PIP_ONLINE = '1'
  $s = Use-CoopBundledWheels @('install', 'coop-data-doc==1.3.4')
  if ($null -ne $s -or $env:PIP_NO_INDEX) { Ko 'COOP_PIP_ONLINE=1 still went offline' }
  Restore-CoopBundledWheels $s
  Remove-Item Env:\COOP_PIP_ONLINE -ErrorAction SilentlyContinue
  if ($fail -eq 0) { Ok 'pipx installs and injects of exact pins read the wheel folder offline; --edge, upgrade and COOP_PIP_ONLINE=1 keep the index; the old values come back' }

  # A D1d package (Node and Pi only) still loads, with nothing of D1k set.
  $old = Join-Path $t 'runtime-d1d'
  New-Runtime $old $false
  $common = Join-Path $root 'lib\common.ps1'
  $probe = "`$env:COOP_BUNDLED_RUNTIME = '$old'; Remove-Item Env:\COOP_BUNDLED_WHEELS -ErrorAction SilentlyContinue; . '$common'; '{0}|{1}|{2}|{3}' -f (Test-CoopBundledRuntime), [bool]`$env:COOP_BUNDLED_WHEELS, [bool]`$script:CoopBundledOdbc, (Get-CoopBundledPython)"
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $line = (& $psExe -NoProfile -Command $probe 2>&1 | Select-Object -Last 1 | Out-String).Trim()
  $ErrorActionPreference = $eap
  if ($line -ne 'True|False|False|') { Ko "a D1d marker without the D1k entries: $line" }
  else { Ok 'a package without the bundled tools still loads its Node and Pi' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
