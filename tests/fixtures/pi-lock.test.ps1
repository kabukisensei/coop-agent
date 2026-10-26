#!/usr/bin/env pwsh
# Pi's own dependency tree from config\pi-lock.json (master plan row U3): the
# lib\common.ps1 half. Get-CoopPiPackageDir finds the installed Pi under the npm
# roots, Test-CoopPiLockPending tells an applied lock from a pending one by the
# marker lib\pilock.js writes, Invoke-CoopPiLockApply runs the apply (through the
# staged-tree seam, so no npm ci), Complete-CoopPiConverge folds it into the Pi
# unit's result, and doctor.ps1 carries the drift row. Offline; temp dirs only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-pi-lock-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object System.Text.UTF8Encoding($false)

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'COOP_PILOCK_STAGED', 'COOP_BUNDLED_RUNTIME', 'APPDATA')
try {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  $null = New-SandboxHome (Join-Path $t 'home')
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  Remove-Item Env:\COOP_PILOCK_STAGED -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_BUNDLED_RUNTIME -ErrorAction SilentlyContinue
  . (Join-Path $root 'lib\common.ps1')
  $pin = Coop-ManifestGet -Key 'pi.version'
  $lock = Get-CoopPiLockPath
  if (Test-Path -LiteralPath $lock -PathType Leaf) { Ok 'config/pi-lock.json ships with the release' } else { Ko 'config/pi-lock.json is missing' }

  function Write-Pkg([string]$Dir, [string]$Name, [string]$Version) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Dir 'package.json'), ('{"name":"' + $Name + '","version":"' + $Version + '"}'), $utf8)
  }

  # --- the installed Pi under an npm root (APPDATA\npm\node_modules is one of the roots) ---
  $appdata = Join-Path $t 'appdata'
  $env:APPDATA = $appdata
  $npmRoot = Join-Path $appdata 'npm\node_modules'
  if (-not (Get-CoopPiPackageDir)) { Ok 'no Pi under any npm root: Get-CoopPiPackageDir is empty' } else { Ko "Get-CoopPiPackageDir found $(Get-CoopPiPackageDir)" }
  $piDir = Join-Path $npmRoot '@earendil-works\pi-coding-agent'
  Write-Pkg $piDir '@earendil-works/pi-coding-agent' $pin
  if ((Get-CoopPiPackageDir) -eq $piDir) { Ok 'Get-CoopPiPackageDir finds Pi under the APPDATA npm root' } else { Ko "Get-CoopPiPackageDir: $(Get-CoopPiPackageDir)" }

  # --- pending: no marker; another Pi version: not pending ---------------------------
  if (Test-CoopPiLockPending $piDir $pin) { Ok 'a Pi at the pin with no marker has the lock pending' } else { Ko 'pending expected without a marker' }
  if (-not (Test-CoopPiLockPending $piDir '0.0.1')) { Ok 'a Pi off the pin never has the lock pending' } else { Ko 'off-pin Pi reported pending' }
  if (-not (Test-CoopPiLockPending '' $pin)) { Ok 'no Pi dir: not pending' } else { Ko 'empty dir reported pending' }

  # --- apply through the staged-tree seam (the real lock's root, a tiny tree) --------
  # A lock of our own so the staged tree stays two packages: Pi and one dependency.
  $smallLock = Join-Path $t 'pi-lock.json'
  $lockJson = '{"name":"coop-pi-runtime","lockfileVersion":3,"requires":true,"packages":{"":{"name":"coop-pi-runtime","dependencies":{"@earendil-works/pi-coding-agent":"' + $pin + '"}},"node_modules/@earendil-works/pi-coding-agent":{"version":"' + $pin + '"},"node_modules/yaml":{"version":"2.0.0"}}}'
  [System.IO.File]::WriteAllText($smallLock, $lockJson, $utf8)
  $stage = Join-Path $t 'stage'
  Write-Pkg (Join-Path $stage 'node_modules\@earendil-works\pi-coding-agent') '@earendil-works/pi-coding-agent' $pin
  Write-Pkg (Join-Path $stage 'node_modules\yaml') 'yaml' '2.0.0'
  Write-Pkg (Join-Path $piDir 'node_modules\yaml') 'yaml' '2.1.0'
  $env:COOP_PILOCK_STAGED = $stage
  # Invoke-CoopPiLockApply reads the shipped lock; point the seam at the small one by
  # calling pilock.js the way the helper does, then the helper's result shape.
  $oldEa = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& node (Join-Path $root 'lib\pilock.js') apply $piDir $smallLock 2>&1 | Out-String)
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $oldEa
  if ($rc -eq 0 -and $out -match 'runs the locked dependency tree') { Ok 'pilock.js apply moved the staged tree into Pi' } else { Ko "apply (rc=$rc): $out" }
  $yamlVer = (Get-Content -LiteralPath (Join-Path $piDir 'node_modules\yaml\package.json') -Raw | ConvertFrom-Json).version
  if ($yamlVer -eq '2.0.0') { Ok 'the floating dependency was replaced by the locked version' } else { Ko "yaml is $yamlVer after apply" }
  $marker = Join-Path $piDir 'node_modules\.coop-pi-lock.json'
  if (Test-Path -LiteralPath $marker) { Ok 'apply wrote the marker' } else { Ko 'no marker after apply' }
  # The marker names the small lock, not the shipped one: the shipped lock is still pending.
  if (Test-CoopPiLockPending $piDir $pin) { Ok 'a marker from another lock leaves the shipped lock pending' } else { Ko 'marker from another lock reported applied' }
  $markerJson = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $markerJson.lock_sha256 = (Get-CoopFileSha256 $lock)
  [System.IO.File]::WriteAllText($marker, ($markerJson | ConvertTo-Json), $utf8)
  if (-not (Test-CoopPiLockPending $piDir $pin)) { Ok 'a marker from the shipped lock means applied' } else { Ko 'shipped-lock marker still pending' }

  # --- Complete-CoopPiConverge: applied lock passes the message through; pending lock applies ---
  $r = Complete-CoopPiConverge $true "pi $pin matches manifest" $pin
  if ($r.ok -and $r.msg -eq "pi $pin matches manifest") { Ok 'an applied lock leaves the unit message as is' } else { Ko "Complete (applied): $($r.ok) $($r.msg)" }
  $r = Complete-CoopPiConverge $false 'npm install of pi failed' $pin
  if (-not $r.ok -and $r.msg -eq 'npm install of pi failed') { Ok 'a failed install is returned untouched' } else { Ko "Complete (failed): $($r.msg)" }
  Remove-Item -LiteralPath $marker -Force
  # Pending now; the staged seam still points at the small stage, whose Pi matches the
  # shipped lock's version only if the pin agrees, and the shipped lock's tree is far
  # larger than the stage: apply reports the mismatch and the unit fails with a hint.
  $r = Complete-CoopPiConverge $true "pi $pin matches manifest" $pin
  if (-not $r.ok -and $r.msg -like "pi $pin matches manifest; pi dependency tree not pinned*coop update*") { Ok 'a pending lock that cannot be applied fails the unit with the hint' } else { Ko "Complete (pending, bad stage): $($r.ok) $($r.msg)" }
  if (Test-Path -LiteralPath (Join-Path $piDir 'node_modules\yaml\package.json')) { Ok 'a failed apply leaves the installed tree in place' } else { Ko 'failed apply removed the tree' }

  # --- doctor carries the row -----------------------------------------------------------
  $doctor = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\doctor.ps1'))
  if ($doctor.Contains('pilock.js') -and $doctor.Contains('config/pi-lock.json')) { Ok 'doctor.ps1 carries the Pi dependency tree row' } else { Ko 'doctor.ps1 must check config/pi-lock.json' }
  $stage = [System.IO.File]::ReadAllText((Join-Path $root 'desktop\scripts\build-installer.mjs'))
  if ($stage.Contains('pilock.js') -and $stage -match '"apply", dirname\(piPkg\)' -and $stage -match '"matches", dirname\(piPkg\)') { Ok 'the installer stage applies and checks the lock on the Pi it bundles' } else { Ko 'desktop/scripts/build-installer.mjs must apply config/pi-lock.json to the staged Pi' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  pi-lock tests passed' } else { Write-Host "  $G_CROSS pi-lock tests FAILED" }
exit $fail
