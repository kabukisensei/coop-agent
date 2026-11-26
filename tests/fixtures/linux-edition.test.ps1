#!/usr/bin/env pwsh
# Linux personal edition (LX1): the Linux-only branches behind
# `-not (Test-CoopWindowsHost)`, in-process and offline. On Windows the same
# fixture checks that the wording helpers keep the Windows text and that the
# Linux-only cases are skipped (Windows behavior is unchanged).
#   SP6 fixes  pi version probe (pi printing --version on stderr, nothing, or
#              after a Node warning on stderr), install's PATH helpers through
#              Add-CoopPathFront (':' separator, no trailing ':', trimmed first
#              line of python/npm output), the quiet contract probes over an
#              unreadable folder (child scan, sibling scan, root proposal)
#   S1         the ~/.local/bin/coop link: install links it, keeps a foreign
#              link or a regular file, and warns when ~/.local/bin was not on
#              the PATH coop started with; uninstall removes only this clone's link
#   S2         Test-CoopPiRunning off Windows: /proc argv (spaces kept, node
#              flags skipped) with npm's bin link resolved to Pi's cli.js, and a
#              real running `node <bin/pi>` process
#   S3         fab / te fallbacks in PIPX_BIN_DIR, ~/.local/bin, the pipx venv
#              (Get-CoopPipxVenvsDir), executable files only; Python Fabric
#              (SSH) as the fallback fab is refused
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
Expect 'Linux names a Linux user' (Get-CoopAccountNoun) 'Linux user'
Expect 'off Windows the clone install hint is the bash forwarder' (Get-CoopCloneInstallCommand) 'bin/coop install'

# Runs $Block with errors collected, not thrown: .Out is the pipeline output,
# .Noise every error/warning line (and a terminating error) it produced.
function Invoke-Quiet([scriptblock]$Block) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = @(); $noise = @()
  try {
    foreach ($r in @(& $Block 2>&1 3>&1)) {
      if ($r -is [System.Management.Automation.ErrorRecord] -or $r -is [System.Management.Automation.WarningRecord]) { $noise += [string]$r } else { $out += $r }
    }
  } catch { $noise += "threw: $_" }
  finally { $ErrorActionPreference = $eap }
  return [pscustomobject]@{ Out = $out; Noise = ($noise -join "`n") }
}
# Runs $Block with coop's [Console]::Error lines (Coop-Ok / Coop-Warn) captured.
function Get-CoopLines([scriptblock]$Block) {
  $w = New-Object System.IO.StringWriter
  $old = [Console]::Error
  [Console]::SetError($w)
  try { try { & $Block | Out-Null } catch { $w.WriteLine("threw: $_") } }
  finally { [Console]::SetError($old) }
  return $w.ToString()
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-lx1-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$saved = Save-Env @('PATH', 'HOME', 'PIPX_BIN_DIR', 'PIPX_HOME', 'COOP_PIPX_HOME', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_ASSUME_YES', 'COOP_ORIGINAL_PATH')
try {
  # --- SP6 fix 1: pi version probe ----------------------------------------------
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
  # Node's warning reaches stderr first (the sleep keeps the order fixed).
  Write-Shim -Name 'pi' -Sh "echo '(node:4242) ExperimentalWarning: Support for loading ES Module in require() is an experimental feature and might change at any time' >&2; sleep 0.3; echo 1.5.2" -Cmd 'echo 1.5.2'
  $v = $null; $err = $null
  try { $v = Get-CoopPiVersion } catch { $err = $_ }
  if ($err) { Ko "Get-CoopPiVersion threw after a Node warning: $err" }
  else { Expect 'a Node ExperimentalWarning on stderr before the version: the version is still read' $v '1.5.2' }

  # --- SP6 fix 2: PATH handling (Add-CoopPathFront, install's helpers) ---------------
  $env:PATH = ''
  $err = $null
  try { Add-CoopPathFront '/lx1/only' } catch { $err = $_ }
  if ($err) { Ko "Add-CoopPathFront threw: $err" } else { Expect 'Add-CoopPathFront on an empty PATH: the dir alone, no trailing ":"' $env:PATH '/lx1/only' }
  $env:PATH = '/lx1/a:/lx1/b'
  try { Add-CoopPathFront '/lx1/b'; Add-CoopPathFront '/lx1/c' } catch { }
  Expect 'Add-CoopPathFront: an entry already there stays put, a new one goes first' $env:PATH '/lx1/c:/lx1/a:/lx1/b'
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
  # PIPX_BIN_DIR unset (~/.local/bin) and a python3 whose sysconfig line is padded
  # and followed by another line: only the trimmed first line goes on PATH.
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue
  Write-Shim -Name 'python3' -Sh "case `"`$1`" in --version) echo 'Python 3.12.3' ;; *) printf '  /lx1/user-scripts  \n/lx1/extra\n' ;; esac" -Cmd 'exit /b 0'
  $env:PATH = "$bin`:/lx1/first"
  Add-CoopUserPaths
  $parts = @($env:PATH -split ':')
  if ($parts[0] -eq '/lx1/user-scripts' -and $parts -contains (Join-Path $HOME '.local/bin') -and $parts -contains '/lx1/first' -and $env:PATH -notmatch 'extra|  ') { Ok 'Add-CoopUserPaths: ~/.local/bin and the trimmed first sysconfig line, nothing else' }
  else { Ko "Add-CoopUserPaths took the python output as-is: '$env:PATH'" }
  Remove-Item -LiteralPath (Join-Path $bin 'python3') -Force
  $npmPrefix = Join-Path $tmp 'npm-prefix'
  New-Item -ItemType Directory -Force -Path (Join-Path $npmPrefix 'bin') | Out-Null
  Write-Shim -Name 'npm' -Sh "[ `"`$1`" = prefix ] && echo '$npmPrefix'; exit 0" -Cmd 'exit /b 0'
  $env:PATH = "$bin`:/lx1/first"
  Add-CoopNpmPath
  $parts = @($env:PATH -split ':')
  if ($parts[0] -eq (Join-Path $npmPrefix 'bin') -and $parts -contains '/lx1/first' -and $env:PATH -notmatch ';') { Ok 'Add-CoopNpmPath prepends <prefix>/bin with ":"' }
  else { Ko "Add-CoopNpmPath broke PATH: $env:PATH" }
  Write-Shim -Name 'npm' -Sh "[ `"`$1`" = prefix ] && printf '  $npmPrefix  \n'; exit 0" -Cmd 'exit /b 0'
  $env:PATH = "$bin`:/lx1/first"
  Add-CoopNpmPath
  $parts = @($env:PATH -split ':')
  Expect 'Add-CoopNpmPath trims the npm prefix line' $parts[0] (Join-Path $npmPrefix 'bin')
  Remove-Item -LiteralPath (Join-Path $bin 'npm') -Force
  $env:PATH = "$bin$sep$($saved['PATH'])"

  # --- SP6 fix 3: quiet contract probes over unreadable folders ---------------------
  $scan = Join-Path $tmp 'scan'
  $locked = Join-Path $scan 'locked'
  New-Item -ItemType Directory -Force -Path (Join-Path $locked 'repo') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $scan 'open/.git') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $scan 'open/.coop') | Out-Null
  $openContract = Join-Path $scan 'open/.coop/project.yml'
  [System.IO.File]::WriteAllText($openContract, "version: 1`n")
  New-Item -ItemType Directory -Force -Path (Join-Path $scan 'half/.git') | Out-Null
  $halfCoop = Join-Path $scan 'half/.coop'
  New-Item -ItemType Directory -Force -Path $halfCoop | Out-Null
  & $chmod 000 $locked
  & $chmod 000 $halfCoop
  try {
    $probe = $null
    try { $probe = Get-ChildItem -LiteralPath $locked -ErrorAction Stop } catch { $probe = 'denied' }
    if ($probe -ne 'denied') { Ok 'unreadable-folder cases skipped (running as root: nothing is unreadable)' }
    else {
      $r = Invoke-Quiet { Get-CoopChildContracts -StartDir $scan }
      if (-not $r.Noise) { Ok 'Get-CoopChildContracts skips an unreadable child and an unreadable .coop quietly' }
      else { Ko 'Get-CoopChildContracts printed errors for an unreadable folder' $r.Noise }
      $found = @($r.Out | ForEach-Object { [string]$_ })
      if ($found -contains $openContract -and $found.Count -eq 1) { Ok 'Get-CoopChildContracts still returns the readable repository''s contract' }
      else { Ko "Get-CoopChildContracts did not return open/.coop/project.yml alone: $($found -join ', ')" }
      $r = Invoke-Quiet { Find-CoopSiblingContract -StartDir (Join-Path $scan 'open') }
      if (-not $r.Noise) { Ok 'Find-CoopSiblingContract skips unreadable siblings quietly' }
      else { Ko 'Find-CoopSiblingContract printed errors for an unreadable sibling' $r.Noise }
      $r = Invoke-Quiet { Get-CoopContractRootProposal -StartDir (Join-Path $scan 'half') }
      if (-not $r.Noise) { Ok 'Get-CoopContractRootProposal probes unreadable folders quietly' }
      else { Ko 'Get-CoopContractRootProposal printed errors for an unreadable folder' $r.Noise }
      $r = Invoke-Quiet { Test-CoopCheckout $locked }
      if (-not $r.Noise -and -not ($r.Out | Select-Object -First 1)) { Ok 'Test-CoopCheckout on an unreadable folder: false, quietly' }
      else { Ko 'Test-CoopCheckout printed errors for an unreadable folder' $r.Noise }
    }
  } finally { & $chmod 755 $locked; & $chmod 755 $halfCoop }

  # --- S2: Test-CoopPiRunning rows from /proc ---------------------------------------
  $npmTop = Join-Path $tmp 'npm dir'
  $npmRoot = Join-Path $npmTop 'lib/node_modules'
  $cli = Join-Path $npmRoot '@earendil-works/pi-coding-agent/dist/cli.js'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cli) | Out-Null
  [System.IO.File]::WriteAllText($cli, "setInterval(() => {}, 1000);`n")
  $npmBin = Join-Path $npmTop 'bin'
  New-Item -ItemType Directory -Force -Path $npmBin | Out-Null
  $piLink = Join-Path $npmBin 'pi'
  New-Item -ItemType SymbolicLink -Path $piLink -Target $cli | Out-Null
  $procs = @(
    (New-Object PSObject -Property @{ Id = 4242; Argv = @('node', '--no-warnings', '--max-old-space-size=4096', $piLink, '-e', '/x/extensions/coop-powerline') }),
    (New-Object PSObject -Property @{ Id = 5151; Argv = @('node', '/usr/lib/node_modules/some-tool/cli.js') }),
    (New-Object PSObject -Property @{ Id = 6161; Argv = @() }))
  $rows = @(Get-CoopUnixNodeProcessRows $procs)
  Expect 'process rows: one row per node process with an argv' $rows.Count 2
  if ($rows.Count -ge 1 -and ([string]$rows[0].CommandLine).Contains($cli) -and $rows[0].ProcessId -eq 4242) { Ok 'bin/pi behind two node flags, in a path with a space, is resolved to Pi''s cli.js' }
  else { Ko "the bin/pi link was not resolved: $($rows | Out-String)" }
  Expect 'a Pi session through bin/pi under this install''s root is busy' (Test-CoopPiRunning $rows @($npmRoot)) $true
  Expect 'the same session against another install''s root is not busy' (Test-CoopPiRunning $rows @('/elsewhere/lib/node_modules')) $false
  Expect 'no Pi session at all is not busy' (Test-CoopPiRunning @($rows | Select-Object -Last 1) @($npmRoot)) $false
  $live = $null; $err = $null
  try { $live = Test-CoopPiRunning $null @('/nonexistent/lx1/node_modules') } catch { $err = $_ }
  if ($err) { Ko "Test-CoopPiRunning threw reading the live process list: $err" } else { Expect 'live process list: no session under an unknown root' $live $false }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Ok 'real node process case skipped (node not on PATH)' }
  else {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $node.Source
    foreach ($a in @('--no-warnings', '--max-old-space-size=128', $piLink)) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
      $busy = $false
      for ($i = 0; $i -lt 40 -and -not $busy; $i++) {
        Start-Sleep -Milliseconds 100
        $busy = Test-CoopPiRunning $null @($npmRoot)
      }
      Expect 'a real running `node --flags <npm dir>/bin/pi` is seen as a busy Pi session' $busy $true
    } finally {
      try { $proc.Kill() } catch { }
      [void]$proc.WaitForExit(5000)
    }
    Expect 'after that node process exits, nothing is busy' (Test-CoopPiRunning $null @($npmRoot)) $false
  }

  # --- S3: fab / te fallbacks ------------------------------------------------------
  $fakeHome = New-SandboxHome (Join-Path $tmp 'home')
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\PIPX_HOME -ErrorAction SilentlyContinue
  $env:COOP_PIPX_HOME = Join-Path $tmp 'custom-pipx'
  function Get-Fallback([string]$Name, [string]$Venv = '') {
    $r = Invoke-Quiet { Get-CoopUnixToolFallback $Name $Venv -HomeDir $fakeHome }
    if ($r.Noise) { return "error: $($r.Noise)" }
    return [string]($r.Out | Select-Object -Last 1)
  }
  function New-Exe([string]$Path, [string]$Body = 'exit 0', [switch]$NoExec) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, "#!/bin/sh`n$Body`n")
    if (-not $NoExec) { & $chmod +x $Path }
  }
  Expect 'fallback: nothing installed -> empty' (Get-Fallback 'te') ''
  $venvFab = Join-Path $env:COOP_PIPX_HOME 'venvs/ms-fabric-cli/bin/fab'
  New-Exe $venvFab
  Expect 'fallback: fab in the pipx venv bin dir Get-CoopPipxVenvsDir names' (Get-Fallback 'fab' 'ms-fabric-cli') $venvFab
  $env:PIPX_BIN_DIR = Join-Path $tmp 'pipx-noexec'
  New-Exe (Join-Path $env:PIPX_BIN_DIR 'te') -NoExec
  Expect 'fallback: a te without an execute bit does not count' (Get-Fallback 'te') ''
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue
  $localTe = Join-Path $fakeHome '.local/bin/te'
  New-Exe $localTe
  Expect 'fallback: te in ~/.local/bin (HomeDir)' (Get-Fallback 'te') $localTe
  $env:PIPX_BIN_DIR = Join-Path $tmp 'pipx-bin2'
  New-Exe (Join-Path $env:PIPX_BIN_DIR 'te')
  Expect 'fallback: PIPX_BIN_DIR comes first' (Get-Fallback 'te') (Join-Path $env:PIPX_BIN_DIR 'te')
  # Python Fabric (SSH) as the fallback fab: the convergence must refuse it,
  # as it does for a fab on PATH. The pipx steps are stubbed in this scope.
  $env:PIPX_BIN_DIR = Join-Path $tmp 'ssh-fabric-bin'
  New-Exe (Join-Path $env:PIPX_BIN_DIR 'fab') "printf 'Fabric 3.2.2\nParamiko 3.4.0\nInvoke 2.2.0\n'"
  function Test-CoopPipxAvailable { return $true }
  function Invoke-CoopPipxConverge { return (Coop-UnitResult $true 'stub') }
  $env:PATH = $bin
  $r = Invoke-Quiet { Invoke-CoopFabricCliConverge -Package 'ms-fabric-cli' -Pin '1.0.0' -Python '/usr/bin/python3' }
  $res = $r.Out | Select-Object -Last 1
  if ($res -and -not $res.ok -and ([string]$res.msg) -match 'Python Fabric') { Ok 'a fallback fab that is Python Fabric (SSH) is refused' }
  else { Ko "the fallback fab was not identity-checked: $($res | Out-String) $($r.Noise)" }
  $env:PATH = "$bin$sep$($saved['PATH'])"
  Remove-Item Env:\PIPX_BIN_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_PIPX_HOME -ErrorAction SilentlyContinue

  # --- S1: install's ~/.local/bin/coop link and PATH warning -----------------------
  # common.ps1 records the PATH from before its own ~/.local/bin prepend.
  $pHome = New-SandboxHome (Join-Path $tmp 'phome')
  New-Item -ItemType Directory -Force -Path (Join-Path $pHome '.local/bin') | Out-Null
  $env:HOME = $pHome
  $env:PATH = '/usr/bin:/bin'
  Remove-Item Env:\COOP_ORIGINAL_PATH -ErrorAction SilentlyContinue
  $commonLib = Join-Path $root 'lib/common.ps1'
  $line = [string](& $psExe -NoLogo -NoProfile -Command ". '$commonLib'; [Console]::Out.WriteLine(`"`$env:COOP_ORIGINAL_PATH|`$env:PATH`")" 2>$null | Select-Object -Last 1)
  $env:HOME = $saved['HOME']
  $env:PATH = "$bin$sep$($saved['PATH'])"
  $origPart, $nowPart = $line.Split('|', 2)
  # (pwsh may put its own folder first at startup; the original must still lack ~/.local/bin.)
  if ($origPart -like '*/usr/bin:/bin' -and @($origPart.Split(':')) -notcontains "$pHome/.local/bin" -and $nowPart -like "$pHome/.local/bin:*") { Ok 'common.ps1 keeps the user''s original PATH (COOP_ORIGINAL_PATH) before prepending ~/.local/bin' }
  else { Ko "COOP_ORIGINAL_PATH did not keep the original PATH: '$line'" }

  $iHome = New-SandboxHome (Join-Path $tmp 'ihome')
  $iBin = Join-Path $iHome '.local/bin'
  New-Item -ItemType Directory -Force -Path $iBin | Out-Null
  $iLink = Join-Path $iBin 'coop'
  $ours = Join-Path $root 'bin/coop'
  $hint = '"/x y/coop-agent/bin/coop" install'
  $out = Get-CoopLines { Install-CoopUnixLauncher -Root $root -HomeDir $iHome -OriginalPath '/usr/bin:/bin' -InstallCmd $hint }
  $it = Get-Item -LiteralPath $iLink -Force -ErrorAction SilentlyContinue
  if ($it -and $it.LinkType -eq 'SymbolicLink' -and [string]$it.Target -eq $ours) { Ok 'install links ~/.local/bin/coop to this clone''s bin/coop' } else { Ko 'install did not link ~/.local/bin/coop' $out }
  if ($out -match [regex]::Escape("$iBin is not on your PATH")) { Ok 'install warns when ~/.local/bin was not on the PATH coop started with' } else { Ko 'install did not warn about ~/.local/bin missing from the original PATH' $out }
  $out = Get-CoopLines { Install-CoopUnixLauncher -Root $root -HomeDir $iHome -OriginalPath "/usr/bin:$iBin/" -InstallCmd $hint }
  if ($out -match 'already linked' -and $out -notmatch 'not on your PATH') { Ok 'install again: already linked, and no PATH warning when ~/.local/bin was on the original PATH' } else { Ko 'install rerun: wrong link or PATH message' $out }
  Remove-Item -LiteralPath $iLink -Force -ErrorAction SilentlyContinue
  $elsewhere = Join-Path $tmp 'elsewhere/bin/coop'
  New-Exe $elsewhere
  New-Item -ItemType SymbolicLink -Path $iLink -Target $elsewhere | Out-Null
  $out = Get-CoopLines { Install-CoopUnixLauncher -Root $root -HomeDir $iHome -OriginalPath $iBin -InstallCmd $hint }
  $it = Get-Item -LiteralPath $iLink -Force -ErrorAction SilentlyContinue
  if ($it -and [string]$it.Target -eq $elsewhere -and $out -match 'not this coop-agent clone' -and $out.Contains($hint)) { Ok 'install keeps a foreign link (<tmp>/elsewhere/bin/coop), warns, and names the clone''s re-run command' }
  else { Ko "install replaced or misreported a foreign link (target '$($it.Target)')" $out }
  Remove-Item -LiteralPath $iLink -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($iLink, '#!/bin/sh')
  $out = Get-CoopLines { Install-CoopUnixLauncher -Root $root -HomeDir $iHome -OriginalPath $iBin -InstallCmd $hint }
  $it = Get-Item -LiteralPath $iLink -Force -ErrorAction SilentlyContinue
  if ($it -and $it.LinkType -ne 'SymbolicLink' -and $out -match 'not a link; leaving it alone' -and $out.Contains($hint)) { Ok 'install keeps a regular ~/.local/bin/coop file and names the clone''s re-run command' }
  else { Ko 'install replaced or misreported a regular file' $out }

  # --- S1: coop uninstall removes only this clone's ~/.local/bin/coop link ----------
  $uHome = New-SandboxHome (Join-Path $tmp 'uhome')
  $uBin = Join-Path $uHome '.local/bin'
  New-Item -ItemType Directory -Force -Path $uBin | Out-Null
  $env:HOME = $uHome
  $env:COOP_DIR = $uHome
  $env:COOP_AGENT_DIR = Join-Path $uHome '.coop/agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:PATH = "$bin$sep$($saved['PATH'])"
  $uninstall = Join-Path $root 'scripts/uninstall.ps1'
  function Invoke-Uninstall {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { return (& $psExe -NoLogo -NoProfile -File $uninstall --keep-tools --yes 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $eap }
  }
  $link = Join-Path $uBin 'coop'
  New-Item -ItemType SymbolicLink -Path $link -Target $ours | Out-Null
  $out = Invoke-Uninstall
  if (-not (Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue) -and $out -match 'removed .*\.local/bin/coop') { Ok 'uninstall removes this clone''s ~/.local/bin/coop link' }
  else { Ko 'uninstall left the ~/.local/bin/coop link' $out }
  if ($out -notmatch 'Exception|LOCALAPPDATA|Cannot bind|is not recognized|CategoryInfo|InvalidOperation') { Ok 'uninstall prints no PowerShell error and no LOCALAPPDATA error' } else { Ko 'uninstall printed errors' $out }
  if ($out -match 'bin/coop install' -and $out -notmatch 'coop\.cmd') { Ok 'uninstall names the bash forwarder for a re-install' } else { Ko 'uninstall named coop.cmd off Windows' $out }
  $out = Invoke-Uninstall
  if ($out -match 'no launcher at .*already gone') { Ok 'uninstall again: the link is already gone' } else { Ko 'second uninstall did not report the link gone' $out }
  New-Item -ItemType SymbolicLink -Path $link -Target $elsewhere | Out-Null
  $out = Invoke-Uninstall
  $it = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($it -and [string]$it.Target -eq $elsewhere) { Ok 'uninstall leaves a link to another bin/coop (<tmp>/elsewhere/bin/coop) alone' } else { Ko 'uninstall removed a foreign bin/coop link' $out }
  Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($link, '#!/bin/sh')
  $out = Invoke-Uninstall
  if (Test-Path -LiteralPath $link -PathType Leaf) { Ok 'uninstall leaves a regular ~/.local/bin/coop file alone' } else { Ko 'uninstall removed a regular file' $out }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
