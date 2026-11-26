#!/usr/bin/env pwsh
# Linux personal edition (LX1): the Linux-only branches behind
# `-not (Test-CoopWindowsHost)`, in-process and offline. On Windows the same
# fixture checks that the wording helpers keep the Windows text and that the
# Linux-only cases are skipped (Windows behavior is unchanged).
#   SP6 fixes  null-safe pi version probe (pi printing --version on stderr or
#              nothing), the ':' PATH handling in install's Add-CoopUserPaths /
#              Add-CoopNpmPath, the quiet child-repo scan (unreadable child)
#   S1         coop uninstall removes the ~/.local/bin/coop link (and only a
#              link to a coop clone), with no LOCALAPPDATA errors
#   S2         Test-CoopPiRunning off Windows: Get-Process rows with npm's bin
#              link resolved to Pi's cli.js
#   S3         fab / te fallbacks in PIPX_BIN_DIR, ~/.local/bin, the pipx venv
#   S4         platform words (Get-CoopAccountNoun, Get-CoopCloneInstallCommand)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $root 'lib\common.ps1')

function Expect([string]$Label, $Got, $Want) {
  if ($Got -eq $Want) { Ok $Label } else { Ko "$Label (got '$Got', want '$Want')" }
}

# --- S4: platform words (both platforms) --------------------------------------
if (Test-CoopWindowsHost) {
  Expect 'Windows keeps "Windows user"' (Get-CoopAccountNoun) 'Windows user'
  Expect 'Windows keeps the .\bin\coop.cmd install hint' (Get-CoopCloneInstallCommand) '.\bin\coop.cmd install'
  Ok 'Linux-only cases skipped on Windows (the Windows branches are unchanged)'
  exit $fail
}
if ($IsMacOS) { Expect 'macOS names a macOS user' (Get-CoopAccountNoun) 'macOS user' }
else { Expect 'Linux names a Linux user' (Get-CoopAccountNoun) 'Linux user' }
Expect 'off Windows the clone install hint is the bash forwarder' (Get-CoopCloneInstallCommand) 'bin/coop install'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-lx1-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$saved = Save-Env @('PATH', 'HOME', 'PIPX_BIN_DIR', 'PIPX_HOME', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_ASSUME_YES')
try {
  # --- SP6 fix 1: null-safe pi version probe ------------------------------------
  $bin = Join-Path $tmp 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $env:PATH = "$bin$sep$($saved['PATH'])"
  Write-Shim -Name 'pi' -Sh 'echo 0.76.0 >&2' -Cmd 'echo 0.76.0 1>&2'
  $v = $null; $err = $null
  try { $v = Get-CoopPiVersion } catch { $err = $_ }
  if ($err) { Ko "Get-CoopPiVersion threw on a pi that prints --version on stderr: $err" }
  else { Expect 'pi printing --version on stderr: the version is read' $v '0.76.0' }
  Write-Shim -Name 'pi' -Sh 'exit 0' -Cmd 'exit /b 0'
  $v = $null; $err = $null
  try { $v = Get-CoopPiVersion } catch { $err = $_ }
  if ($err) { Ko "Get-CoopPiVersion threw on a pi with no output: $err" }
  else { Expect 'pi with no --version output: empty, no exception' $v '' }
  Write-Shim -Name 'pi' -Sh 'echo 1.5.2' -Cmd 'echo 1.5.2'
  Expect 'pi printing --version on stdout: the version is read' (Get-CoopPiVersion) '1.5.2'

  # --- SP6 fix 2: install's PATH helpers use ':' --------------------------------
  # The two functions are defined inside scripts/install.ps1; load just them.
  $installAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/install.ps1'), [ref]$null, [ref]$null)
  foreach ($fn in @('Add-CoopUserPaths', 'Add-CoopNpmPath')) {
    $def = $installAst.Find({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $fn }, $true)
    if (-not $def) { Ko "install.ps1 no longer defines $fn" } else { . ([scriptblock]::Create($def.Extent.Text)) }
  }
  $env:PIPX_BIN_DIR = Join-Path $tmp 'pipx-bin'
  $env:PATH = "/lx1/first:/lx1/second"
  Add-CoopUserPaths
  $parts = @($env:PATH -split ':')
  if ($parts -contains $env:PIPX_BIN_DIR -and $parts -contains '/lx1/first' -and $parts -contains '/lx1/second' -and $env:PATH -notmatch ';') { Ok 'Add-CoopUserPaths prepends the pipx bin dir with ":" and keeps every entry' }
  else { Ko "Add-CoopUserPaths broke PATH: $env:PATH" }
  $npmPrefix = Join-Path $tmp 'npm-prefix'
  New-Item -ItemType Directory -Force -Path (Join-Path $npmPrefix 'bin') | Out-Null
  Write-Shim -Name 'npm' -Sh "[ `"`$1`" = prefix ] && echo '$npmPrefix'; exit 0" -Cmd 'exit /b 0'
  $env:PATH = "$bin`:/lx1/first"
  Add-CoopNpmPath
  $parts = @($env:PATH -split ':')
  if ($parts[0] -eq (Join-Path $npmPrefix 'bin') -and $parts -contains '/lx1/first' -and $env:PATH -notmatch ';') { Ok 'Add-CoopNpmPath prepends <prefix>/bin with ":"' }
  else { Ko "Add-CoopNpmPath broke PATH: $env:PATH" }
  $env:PATH = "$bin$sep$($saved['PATH'])"
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue

  # --- SP6 fix 3: quiet child-repo scan --------------------------------------------
  $scan = Join-Path $tmp 'scan'
  $locked = Join-Path $scan 'locked'
  New-Item -ItemType Directory -Force -Path (Join-Path $locked 'repo') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $scan 'open/.git') | Out-Null
  & $chmod 000 $locked
  try {
    $probe = $null
    try { $probe = Get-ChildItem -LiteralPath $locked -ErrorAction Stop } catch { $probe = 'denied' }
    if ($probe -ne 'denied') { Ok 'unreadable-child case skipped (running as root: nothing is unreadable)' }
    else {
      # -ErrorAction SilentlyContinue still records in $Error; what matters is the output.
      $out = (Get-CoopChildContracts -StartDir $scan 3>&1 2>&1 | Out-String)
      if ($out -notmatch 'denied') { Ok 'Get-CoopChildContracts skips an unreadable child quietly' }
      else { Ko "Get-CoopChildContracts printed errors for an unreadable child: $out" }
    }
  } finally { & $chmod 755 $locked }

  # --- S2: Test-CoopPiRunning rows from Get-Process -----------------------------
  $npmRoot = Join-Path $tmp 'npm/lib/node_modules'
  $cli = Join-Path $npmRoot '@earendil-works/pi-coding-agent/dist/cli.js'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cli) | Out-Null
  [System.IO.File]::WriteAllText($cli, "#!/usr/bin/env node`n")
  $npmBin = Join-Path $tmp 'npm/bin'
  New-Item -ItemType Directory -Force -Path $npmBin | Out-Null
  $piLink = Join-Path $npmBin 'pi'
  New-Item -ItemType SymbolicLink -Path $piLink -Target $cli | Out-Null
  $procs = @(
    (New-Object PSObject -Property @{ Id = 4242; CommandLine = "node $piLink -e /x/extensions/coop-powerline" }),
    (New-Object PSObject -Property @{ Id = 5151; CommandLine = 'node /usr/lib/node_modules/some-tool/cli.js' }),
    (New-Object PSObject -Property @{ Id = 6161; CommandLine = '' }))
  $rows = @(Get-CoopUnixNodeProcessRows $procs)
  Expect 'Get-Process rows: one row per node process with a command line' $rows.Count 2
  if ($rows.Count -ge 1 -and ([string]$rows[0].CommandLine).Contains($cli) -and $rows[0].ProcessId -eq 4242) { Ok 'npm''s bin/pi link is resolved to Pi''s cli.js' }
  else { Ko "the bin/pi link was not resolved: $($rows | Out-String)" }
  Expect 'a Pi session through bin/pi under this install''s root is busy' (Test-CoopPiRunning $rows @($npmRoot)) $true
  Expect 'the same session against another install''s root is not busy' (Test-CoopPiRunning $rows @('/elsewhere/lib/node_modules')) $false
  Expect 'no Pi session at all is not busy' (Test-CoopPiRunning @($rows | Select-Object -Last 1) @($npmRoot)) $false
  $live = $null; $err = $null
  try { $live = Test-CoopPiRunning $null @('/nonexistent/lx1/node_modules') } catch { $err = $_ }
  if ($err) { Ko "Test-CoopPiRunning threw reading the live process list: $err" } else { Expect 'live process list: no session under an unknown root' $live $false }

  # --- S3: fab / te fallbacks --------------------------------------------------------
  # $HOME is read-only in-process, so each probe runs in a child whose HOME is the sandbox.
  $fakeHome = New-SandboxHome (Join-Path $tmp 'home')
  $commonLib = Join-Path $root 'lib/common.ps1'
  function Get-Fallback([string]$Name, [string]$Venv = '') {
    $env:HOME = $fakeHome
    try { return [string](& $psExe -NoLogo -NoProfile -Command ". '$commonLib'; Get-CoopUnixToolFallback '$Name' '$Venv'" 2>$null | Select-Object -Last 1) }
    finally { $env:HOME = $saved['HOME'] }
  }
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\PIPX_HOME -ErrorAction SilentlyContinue
  Expect 'fallback: nothing installed -> empty' (Get-Fallback 'te') ''
  $venvFab = Join-Path $fakeHome '.local/share/pipx/venvs/ms-fabric-cli/bin/fab'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $venvFab) | Out-Null
  [System.IO.File]::WriteAllText($venvFab, '')
  Expect 'fallback: fab in the default pipx venv bin dir' (Get-Fallback 'fab' 'ms-fabric-cli') $venvFab
  $localTe = Join-Path $fakeHome '.local/bin/te'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $localTe) | Out-Null
  [System.IO.File]::WriteAllText($localTe, '')
  Expect 'fallback: te in ~/.local/bin' (Get-Fallback 'te') $localTe
  $env:PIPX_BIN_DIR = Join-Path $tmp 'pipx-bin2'
  New-Item -ItemType Directory -Force -Path $env:PIPX_BIN_DIR | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $env:PIPX_BIN_DIR 'te'), '')
  Expect 'fallback: PIPX_BIN_DIR comes first' (Get-Fallback 'te') (Join-Path $env:PIPX_BIN_DIR 'te')
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue

  # --- S1: coop uninstall removes the ~/.local/bin/coop link -----------------------
  $uHome = New-SandboxHome (Join-Path $tmp 'uhome')
  $uBin = Join-Path $uHome '.local/bin'
  New-Item -ItemType Directory -Force -Path $uBin | Out-Null
  $env:HOME = $uHome
  $env:COOP_DIR = $uHome
  $env:COOP_AGENT_DIR = Join-Path $uHome '.coop/agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:PATH = "$bin$sep$($saved['PATH'])"
  Remove-Item -LiteralPath (Join-Path $bin 'npm') -Force -ErrorAction SilentlyContinue
  $uninstall = Join-Path $root 'scripts/uninstall.ps1'
  function Invoke-Uninstall {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { return (& $psExe -NoLogo -NoProfile -File $uninstall --keep-tools --yes 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $eap }
  }
  $link = Join-Path $uBin 'coop'
  New-Item -ItemType SymbolicLink -Path $link -Target (Join-Path $root 'bin/coop') | Out-Null
  $out = Invoke-Uninstall
  if (-not (Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue) -and $out -match 'removed .*\.local/bin/coop') { Ok 'uninstall removes the ~/.local/bin/coop link' }
  else { Ko 'uninstall left the ~/.local/bin/coop link' $out }
  if ($out -notmatch 'Exception|LOCALAPPDATA|Cannot bind') { Ok 'uninstall prints no PowerShell exception and no LOCALAPPDATA error' } else { Ko 'uninstall printed errors' $out }
  if ($out -match 'bin/coop install' -and $out -notmatch 'coop\.cmd') { Ok 'uninstall names the bash forwarder for a re-install' } else { Ko 'uninstall named coop.cmd off Windows' $out }
  $out = Invoke-Uninstall
  if ($out -match 'already gone') { Ok 'uninstall again: the link is already gone' } else { Ko 'second uninstall did not report the link gone' $out }
  $foreign = Join-Path $tmp 'other-tool'
  [System.IO.File]::WriteAllText($foreign, '')
  New-Item -ItemType SymbolicLink -Path $link -Target $foreign | Out-Null
  $out = Invoke-Uninstall
  if (Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue) { Ok 'uninstall leaves a ~/.local/bin/coop link to something else alone' } else { Ko 'uninstall removed a foreign link' $out }
  Remove-Item -LiteralPath $link -Force
  [System.IO.File]::WriteAllText($link, '#!/bin/sh')
  $out = Invoke-Uninstall
  if (Test-Path -LiteralPath $link -PathType Leaf) { Ok 'uninstall leaves a regular ~/.local/bin/coop file alone' } else { Ko 'uninstall removed a regular file' $out }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
