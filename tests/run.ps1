#!/usr/bin/env pwsh
#
# coop PowerShell behavioral tests: coop's own test lane (the product is PowerShell,
# master plan S1). tests/run.sh holds the Node/Python logic tests and the bash
# harness suites; this file drives coop.ps1, lib/common.ps1 and scripts/*.ps1:
#   0. scripts/check-bom.ps1 (every .ps1 keeps its UTF-8 BOM) runs first
#   1. coop.ps1 launch-spec resolves guardrails, prompts, theme, all 4 extensions
#   2. coop.ps1 --no-launch exits 0 + prints the spec; --no-launch --json emits {bin,args,env}
#   3. update.ps1 --check is a dry-run that reports current/expected and exits 0;
#      --pi-latest warns that it is deprecated and keeps that read-only path
#   4. coop.ps1 forwards a single trailing --check argument intact to update.ps1
#   5. (retired with ST1: coop review no longer exists)
#   6. the child fixtures under tests/fixtures, one table-driven loop with a lane
#      column (gate / extended); each fixture is a self-contained script that
#      dot-sources tests/fixtures/_common.ps1
#
# No network: the stubs on a scratch PATH answer every tool probe, and nothing is
# installed. Runs under Windows PowerShell 5.1 (coop.cmd's runtime) and pwsh 7
# (macOS/Linux CI). CI wires it into the windows + tests jobs; run locally with
# `pwsh -File tests/run.ps1`.
#
# Lanes (#96), as in tests/run.sh: the default run is the gate lane (deterministic
# logic only). COOP_TEST_EXTENDED=1 also runs the extended lane: the in-process
# sections marked "EXTENDED LANE" and the fixture rows with Lane = 'extended'
# (timing and process fixtures; docs/ci.md lists them).
#
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$update = Join-Path (Join-Path $root 'scripts') 'update.ps1'

# Run the child gate/check invocations under the SAME PowerShell edition that runs
# this file — so under `shell: powershell` (coop.cmd's Windows PowerShell 5.1) the
# gate is exercised on 5.1, and under pwsh 7 (CI ubuntu / macOS) on pwsh. Falls back
# to 'pwsh' if the host path can't be resolved.
$psExe = try { (Get-Process -Id $PID).Path } catch { $null }
if (-not $psExe) { $psExe = 'pwsh' }

# Launches sign in to Azure automatically (H2). No test may reach a runner's or a
# developer's real Azure CLI; the sign-in fixture opts back in with a fake az.
$priorSkipAz = $env:COOP_SKIP_AZ
$env:COOP_SKIP_AZ = '1'

# Bounded child-exit propagation probe. The normal suite invokes this mode with
# a deliberately failing Fabric fixture and proves a later success cannot erase
# the stored child failure. Keep this before all unrelated aggregate work.
if ($env:COOP_TEST_FABRIC_RUNNER_FAILURE_PROBE -eq '1') {
  $probeEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $probeOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\fabric-mcp-launch.test.ps1') *>&1
  $childRc = $LASTEXITCODE
  & $psExe -NoProfile -Command 'exit 0'
  $laterRc = $LASTEXITCODE
  $ErrorActionPreference = $probeEap
  $probeOut | ForEach-Object { Write-Output $_ }
  Write-Output "FABRIC_MCP_RUNNER_PROBE child-rc=$childRc later-rc=$laterRc"
  if (
    $childRc -ne 0 -and
    $laterRc -eq 0 -and
    (($probeOut | Out-String).Contains('FABRIC_MCP_FIXTURE_INJECTION_REACHED'))
  ) {
    exit $childRc
  }
  exit 1
}

# Status glyphs via [char] codepoints (Windows PowerShell 5.1 compat, matching
# lib/common.ps1) — a BOM-less or mis-encoded literal glyph mojibakes on 5.1.
$G_CHECK = [char]0x2713   # ✓
$G_CROSS = [char]0x2717   # ✗
$G_ARROW = [char]0x2192   # →

$fail = 0
function Ok   { param([string]$m) Write-Host "  $G_CHECK $m" }
function Ko   { param([string]$m) Write-Host "  $G_CROSS $m"; $script:fail = 1 }
function Head { param([string]$m) Write-Host "$G_ARROW $m" }

# --- Lane selection (#96) ----------------------------------------------------
# Only COOP_TEST_EXTENDED=1 selects the extended lane. The try block below
# normalizes the variable for child fixtures and the finally block restores it.
$priorTestExtended = $env:COOP_TEST_EXTENDED
$extendedLane = ($priorTestExtended -eq '1')
if ($extendedLane) {
  $laneName = 'gate + extended lanes'
  Head 'lanes: gate + extended (COOP_TEST_EXTENDED=1). Gate lane only: pwsh -File tests/run.ps1'
} else {
  $laneName = 'gate lane'
  Head 'lane: gate (default). Add the extended lane with COOP_TEST_EXTENDED=1'
}

# --- 0. .ps1 UTF-8 BOM check (scripts/check-bom.ps1) ---------------------------
# First, before any fixture: a BOM-less .ps1 mojibakes its glyphs on Windows
# PowerShell 5.1, and the check prints the exact fix command for each offender.
Head '.ps1 UTF-8 BOM check (scripts/check-bom.ps1)'
$bomEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$bomOut = & $psExe -NoProfile -File (Join-Path $root 'scripts\check-bom.ps1') 2>&1
$bomRc = $LASTEXITCODE
$ErrorActionPreference = $bomEap
if ($bomRc -eq 0) { Ok 'every .ps1 keeps its UTF-8 BOM (scripts/check-bom.ps1)' } else { Ko "scripts/check-bom.ps1 failed: $($bomOut | Out-String)" }

# --- pi/npm stubs on a scratch PATH -----------------------------------------
# --check needs a `pi` (reporting 0.87.1) and an `npm` that Get-Command
# resolves. Windows PowerShell 5.1 finds a stub only via a PATHEXT extension
# (.cmd), so write BOTH an extension-less Unix executable and a .cmd wrapper.
$stub = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-ps-test-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $stub -Force | Out-Null
try {
  # Unix executables (extension-less, +x) — resolved by Get-Command on macOS/Linux.
  $piSh = "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && { echo `"pi 0.87.1`"; exit 0; }`nexit 0`n"
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi'),  $piSh)
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm'), "#!/bin/sh`nexit 0`n")
  if ($IsLinux -or $IsMacOS) { & chmod +x (Join-Path $stub 'pi') (Join-Path $stub 'npm') }
  # Windows .cmd wrappers — resolved by Get-Command on Windows PowerShell 5.1.
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi.cmd'),  "@echo off`r`nif `"%1`"==`"--version`" (echo pi 0.87.1& exit /b 0)`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm.cmd'), "@echo off`r`nexit /b 0`r`n")

  $sep = [System.IO.Path]::PathSeparator
  $stubPath = "$stub$sep$($env:PATH)"
  # The launch preflight can repair an extension tree. Point every writable
  # Coop/Pi location at this fixture and make the fake Pi authoritative so this
  # behavioral suite never inspects or changes the developer's real ~/.coop.
  # HOME and USERPROFILE point at a fixture home too, so every child process
  # (PowerShell derives $HOME from USERPROFILE on Windows; node and python read
  # them) resolves its home there, and the standards roots are unset so they
  # resolve inside it (#96 fixture rules). Sections called in this process with
  # `& $coop` keep this host's $HOME automatic variable; their writable
  # locations are the COOP_DIR/COOP_AGENT_DIR overrides below.
  $priorPath = $env:PATH
  $priorCoopDir = $env:COOP_DIR
  $priorCoopAgentDir = $env:COOP_AGENT_DIR
  $priorPiAgentDir = $env:PI_CODING_AGENT_DIR
  $priorNoOnboard = $env:COOP_NO_ONBOARD
  $priorHomeVars = @{}
  $homeVarNames = @('HOME', 'USERPROFILE', 'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT')
  foreach ($name in $homeVarNames) { $priorHomeVars[$name] = [Environment]::GetEnvironmentVariable($name) }
  if ($extendedLane) { $env:COOP_TEST_EXTENDED = '1' }
  else { Remove-Item Env:\COOP_TEST_EXTENDED -ErrorAction SilentlyContinue }

  # --- EXTENDED LANE: terminal acceptance reparse subset --------------------
  # Run receipt/reparse validation before fixture PATH and interpreter seams.
  # Native extension imports (jsonschema/rpds) must be consumed from the exact
  # CI-pinned interpreter before later fixtures replace executable discovery.
  if ($extendedLane) {
    Head 'terminal acceptance reparse boundary tests'
    $reparseOut = & node --test --test-name-pattern 'directory links|junctioned ancestor|authorization revocation|failure cleanup|checkout ancestry|owned-root probe|fully safe authorization|decisive receipt mutations' (Join-Path $root 'tests\terminal-workstation-acceptance.test.mjs') 2>&1
    $reparseRc = $LASTEXITCODE
    if ($reparseRc -eq 0) { $reparseOut | ForEach-Object { Write-Host $_ }; Ok 'terminal acceptance rejects reparse evidence' }
    else { Ko "terminal acceptance reparse boundary tests failed: $($reparseOut | Out-String)" }
  }

  $env:PATH = $stubPath
  $env:COOP_DIR = Join-Path $stub 'coop-dir'
  $env:COOP_AGENT_DIR = Join-Path $stub 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'
  $sandboxHome = Join-Path $stub 'home'
  New-Item -ItemType Directory -Path $sandboxHome -Force | Out-Null
  # A profile shape Windows PowerShell 5.1 needs: its known folders expand from
  # USERPROFILE, and Receive-Job fails ("The Persistence Path does not exist")
  # when AppData\Local is missing.
  foreach ($sub in @('AppData\Local\Microsoft\Windows\PowerShell', 'AppData\Roaming')) {
    New-Item -ItemType Directory -Path (Join-Path $sandboxHome $sub) -Force | Out-Null
  }
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  foreach ($name in @('COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT')) {
    [Environment]::SetEnvironmentVariable($name, $null)
  }

  # --- 0b. public onboarding dispatcher supplies the Python subcommand -------
  Head 'onboarding dispatcher contract test'
  $onboardRoot = Join-Path $stub 'onboard-dispatch'
  New-Item -ItemType Directory -Path $onboardRoot -Force | Out-Null
  $onboardInput = Join-Path $stub 'onboard-input.txt'
  $onboardStdout = Join-Path $stub 'onboard-stdout.txt'
  $onboardStderr = Join-Path $stub 'onboard-stderr.txt'
  $invalidStdout = Join-Path $stub 'onboard-invalid-stdout.txt'
  $invalidStderr = Join-Path $stub 'onboard-invalid-stderr.txt'
  [System.IO.File]::WriteAllText($onboardInput, "PowerShell Operator`n1`n", (New-Object System.Text.UTF8Encoding($false)))
  $savedCoopDir = $env:COOP_DIR
  $savedAzureBin = $env:COOP_AZ_BIN
  try {
    $env:COOP_DIR = $onboardRoot
    $env:COOP_AZ_BIN = Join-Path $stub 'missing-az'
    $onboardProcess = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $coop + '"'),'onboard','--json') -PassThru -NoNewWindow -RedirectStandardInput $onboardInput -RedirectStandardOutput $onboardStdout -RedirectStandardError $onboardStderr
    $null = $onboardProcess.Handle
    $onboardProcess.WaitForExit()
    $onboardExit = $onboardProcess.ExitCode
    $invalidProcess = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $coop + '"'),'onboard','--invalid-acceptance-flag') -PassThru -NoNewWindow -RedirectStandardOutput $invalidStdout -RedirectStandardError $invalidStderr
    $null = $invalidProcess.Handle
    $invalidProcess.WaitForExit()
    $invalidExit = $invalidProcess.ExitCode
  } finally {
    $env:COOP_DIR = $savedCoopDir
    $env:COOP_AZ_BIN = $savedAzureBin
  }
  $onboardProfile = if ($onboardExit -eq 0) { Get-Content -LiteralPath $onboardStdout -Raw | ConvertFrom-Json } else { $null }
  if ($onboardExit -eq 0 -and $onboardProfile.name -ceq 'PowerShell Operator' -and (Test-Path -LiteralPath (Join-Path $onboardRoot '.coop\user.json') -PathType Leaf)) {
    Ok 'coop.ps1 onboard supplies the required subcommand'
  } else {
    Ko "coop.ps1 onboard dispatcher failed with exit $onboardExit"
  }
  if ($invalidExit -eq 2) { Ok 'coop.ps1 onboard propagates Python argument failures' } else { Ko "coop.ps1 onboard changed Python exit 2 to $invalidExit" }

  # --- 0c. ConvertFrom-Json manifest objects expose all managed keys ----------
  Head 'PowerShell release-manifest key enumeration'
  $commonPath = Join-Path $root 'lib\common.ps1'
  . $commonPath
  $manifestKeys = @(& $psExe -NoLogo -NoProfile -Command ". '$commonPath'; Coop-ManifestKeys 'extensions'")
  $expectedManifestKeys = @((Get-Content -LiteralPath (Join-Path $root 'config\release-manifest.json') -Raw | ConvertFrom-Json).extensions.PSObject.Properties.Name)
  if ($manifestKeys.Count -eq $expectedManifestKeys.Count -and @($expectedManifestKeys | Where-Object { $manifestKeys -cnotcontains $_ }).Count -eq 0) {
    Ok 'Coop-ManifestKeys enumerates every PSCustomObject manifest property'
  } else {
    Ko "Coop-ManifestKeys returned $($manifestKeys.Count) of $($expectedManifestKeys.Count) extension keys"
  }

  # --- 0d. Installed extension versions come from specs, never install paths --
  # `pi list` prints a spec line and, beneath it, the install path — which also
  # contains the extension name. Counting path lines made one installed version
  # read as several and failed the fleet-pin proof closed on a correct machine.
  Head 'Installed Pi extension version parsing'
  $piListFixture = @(
    '  npm:pi-mcp-adapter@2.10.0',
    '    C:\Users\a\.coop\agent\npm\node_modules\pi-mcp-adapter',
    '  npm:@juicesharp/rpiv-ask-user-question@2.12.0',
    '    C:\Users\a\.coop\agent\npm\node_modules\@juicesharp\rpiv-ask-user-question',
    '  npm:pi-mcp-adapter-tools@9.9.9',
    '    C:\Users\a\.coop\agent\npm\node_modules\pi-mcp-adapter-tools',
    '  npm:pi-mcp-adapter@2.10.0'
  ) -join "`n"
  $parsedAdapter = @(Get-CoopPiExtensionVersions $piListFixture 'pi-mcp-adapter')
  if ($parsedAdapter.Count -eq 1 -and $parsedAdapter[0] -ceq '2.10.0') {
    Ok 'install paths, name prefixes, and duplicate specs do not inflate the installed version'
  } else {
    Ko "pi-mcp-adapter parsed as [$($parsedAdapter -join ', ')] instead of exactly 2.10.0"
  }
  $parsedScoped = @(Get-CoopPiExtensionVersions $piListFixture '@juicesharp/rpiv-ask-user-question')
  if ($parsedScoped.Count -eq 1 -and $parsedScoped[0] -ceq '2.12.0') {
    Ok 'scoped extension names resolve to their own spec'
  } else {
    Ko "scoped extension parsed as [$($parsedScoped -join ', ')] instead of exactly 2.12.0"
  }
  $parsedConflict = @(Get-CoopPiExtensionVersions ($piListFixture + "`n  npm:pi-mcp-adapter@2.11.0") 'pi-mcp-adapter')
  if ($parsedConflict.Count -eq 2) {
    Ok 'two genuinely different installed versions stay visible for the caller to reject'
  } else {
    Ko "conflicting installed versions parsed as [$($parsedConflict -join ', ')] instead of two entries"
  }
  $parsedSuffixConflict = @(Get-CoopPiExtensionVersions ($piListFixture + "`n  npm:pi-mcp-adapter@2.10.0-beta.1") 'pi-mcp-adapter')
  if ($parsedSuffixConflict.Count -eq 2 -and $parsedSuffixConflict -ccontains '2.10.0-beta.1') {
    Ok 'pre-release suffix conflicts remain visible'
  } else {
    Ko "pre-release conflict parsed as [$($parsedSuffixConflict -join ', ')] instead of two entries"
  }
  foreach ($package in @('pi-mcp-adapter', '@scope/extension')) {
    $caseConflict = @(Get-CoopPiExtensionVersions "npm:${package}@2.10.0-beta.A`nnpm:${package}@2.10.0-beta.a" $package)
    if ($caseConflict.Count -eq 2) { Ok "case-distinct prereleases remain conflicting: $package" } else { Ko "case-distinct prereleases collapsed for $package" }
    $buildConflict = @(Get-CoopPiExtensionVersions "npm:${package}@2.10.0+BUILD`nnpm:${package}@2.10.0+build" $package)
    if ($buildConflict.Count -eq 2) { Ok "case-distinct builds remain conflicting: $package" } else { Ko "case-distinct builds collapsed for $package" }
    foreach ($suffix in @('2.10.0/path', '2.10.0@9.9.9', '2.10.0-..', '2.10.0+..', '02.10.0')) {
      $malformed = "npm:${package}@$suffix"
      if (@(Get-CoopPiExtensionVersions $malformed $package).Count -eq 0) {
        Ok "malformed package spec is rejected: $malformed"
      } else {
        Ko "malformed package spec was accepted: $malformed"
      }
    }
    foreach ($terminated in @("npm:${package}@2.10.0  ", "npm:${package}@2.10.0`r`n")) {
      $parsedTerminated = @(Get-CoopPiExtensionVersions $terminated $package)
      if ($parsedTerminated.Count -eq 1 -and $parsedTerminated[0] -ceq '2.10.0') { Ok "trailing whitespace/CRLF is normalized: $package" } else { Ko "valid whitespace/CRLF-terminated spec was rejected: $package" }
    }
  }

  # --- 1. launch-spec resolves the governed pi invocation --------------------
  Head 'launch-spec (shared launch builder) test'
  # Join-Path emits native separators, so on Windows PowerShell 5.1 the spec paths
  # are backslash-delimited (docs\guardrails.md); the forward-slash needles below
  # would never match. Normalize '\' -> '/' so the check is separator-agnostic.
  $spec = (& $coop launch-spec 2>&1 | Out-String) -replace '\\', '/'
  $miss = $false
  foreach ($needle in @('docs/guardrails.md', '--prompt-template', 'themes/cooptimize.json',
                        'extensions/coop-powerline', 'extensions/coop-tools', 'extensions/coop-guardrails', 'extensions/coop-profile')) {
    if ($spec -notlike "*$needle*") { Ko "launch-spec missing: $needle"; $miss = $true }
  }
  if (-not $miss) { Ok 'launch-spec resolves guardrails, prompts, theme, and all 4 extensions' }

  # --- 1b. launch-spec includes team skills from configured knowledge repo ---
  $kbTmp = Join-Path $stub "team-kb"
  New-Item -ItemType Directory -Path (Join-Path $kbTmp 'skills\team-fixture') -Force | Out-Null
  Set-Content (Join-Path $kbTmp 'skills\team-fixture\SKILL.md') "---`nname: team-fixture`n---`n# Fixture"
  $kbCfgDir = Join-Path $stub "kb-cfg"
  New-Item -ItemType Directory -Path (Join-Path $kbCfgDir '.coop') -Force | Out-Null
  $kbJson = '{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/repo.git","local_path":"' + ($kbTmp -replace '\\', '/') + '"}]}}'
  Set-Content (Join-Path $kbCfgDir '.coop\config') $kbJson
  $priorCoop = $env:COOP_DIR
  $env:COOP_DIR = $kbCfgDir
  $kbSpec = (& $coop launch-spec 2>&1 | Out-String) -replace '\\', '/'
  $env:COOP_DIR = $priorCoop
  if ($kbSpec -like "*team-fixture*") { Ok 'launch-spec includes team skills from configured knowledge repo' } else { Ko 'launch-spec missing team-fixture' }

  # --- 1c. invalid team skill cannot abort the PowerShell launcher -------------
  Head 'invalid team skill is skipped (missing frontmatter name)'
  $kbBad = Join-Path $stub 'team-kb-bad'
  New-Item -ItemType Directory -Path (Join-Path $kbBad 'skills/aaa-valid-skill'), (Join-Path $kbBad 'skills/zzzz-invalid-final'), (Join-Path $kbBad 'skills/bbb-empty-invalid'), (Join-Path $kbBad 'skills/ccc-multiline-no-name') -Force | Out-Null
  Set-Content (Join-Path $kbBad 'skills/aaa-valid-skill/SKILL.md') "---`nname: aaa-valid-skill`n---`n# Valid"
  Set-Content (Join-Path $kbBad 'skills/zzzz-invalid-final/SKILL.md') '# no frontmatter at all'
  # Review shape 1: a completely EMPTY skill file (0 bytes).
  New-Item -ItemType File -Path (Join-Path $kbBad 'skills/bbb-empty-invalid/SKILL.md') -Force | Out-Null
  # Review shape 3: frontmatter present but NO name key anywhere.
  Set-Content (Join-Path $kbBad 'skills/ccc-multiline-no-name/SKILL.md') "---`ndescription: no name key here`n---`n# Body without a name"
  $kbBadCfg = Join-Path $stub 'kb-bad-cfg'
  New-Item -ItemType Directory -Path (Join-Path $kbBadCfg '.coop') -Force | Out-Null
  $badJson = '{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/repo.git","local_path":"' + ($kbBad -replace '\\', '/') + '"}]}}'
  Set-Content (Join-Path $kbBadCfg '.coop/config') $badJson
  $env:COOP_DIR = $kbBadCfg
  $badSpec = (& $coop launch-spec 2>&1 | Out-String) -replace '\\', '/'
  $badRc = $LASTEXITCODE
  $env:COOP_DIR = $priorCoop
  if ($badRc -eq 0) { Ok 'valid + invalid-final: PowerShell launcher exits 0' } else { Ko "invalid-final aborted PowerShell launcher: rc=$badRc" }
  if ($badSpec -like '*aaa-valid-skill*') { Ok 'valid skill still loaded alongside invalid-final (PS)' } else { Ko 'valid skill lost (PS)' }
  if ($badSpec -like '*zzzz-invalid-final*') { Ko 'invalid-final present in PS launch args' } else { Ok 'invalid-final absent from PS launch args' }
  if ($badSpec -like '*missing frontmatter name*') { Ok 'invalid-final warned (PS)' } else { Ko 'no invalid-final warning (PS)' }
  if ($badSpec -like '*bbb-empty-invalid*') { Ko 'empty skill present in PS launch args' } else { Ok 'empty skill absent from PS launch args' }
  if ($badSpec -like '*ccc-multiline-no-name*') { Ko 'multiline-no-name skill present in PS launch args' } else { Ok 'multiline-no-name skill absent from PS launch args' }

  # --- 1d. duplicate team skill names across repositories: first wins ----------
  Head 'duplicate team skill names across repositories (PS)'
  $kbDupA = Join-Path $stub 'kb-dup-a'; $kbDupB = Join-Path $stub 'kb-dup-b'
  New-Item -ItemType Directory -Path (Join-Path $kbDupA 'skills/shared-skill'), (Join-Path $kbDupB 'skills/shared-skill') -Force | Out-Null
  Set-Content (Join-Path $kbDupA 'skills/shared-skill/SKILL.md') "---`nname: shared-skill`n---`n# First"
  Set-Content (Join-Path $kbDupB 'skills/shared-skill/SKILL.md') "---`nname: shared-skill`n---`n# Second"
  $kbDupCfg = Join-Path $stub 'kb-dup-cfg'
  New-Item -ItemType Directory -Path (Join-Path $kbDupCfg '.coop') -Force | Out-Null
  $dupJson = '{"schema_version":1,"knowledge":{"enabled":true,"repos":[' +
    '{"url":"https://example.com/a.git","local_path":"' + ($kbDupA -replace '\\', '/') + '"},' +
    '{"url":"https://example.com/b.git","local_path":"' + ($kbDupB -replace '\\', '/') + '"}]}}'
  Set-Content (Join-Path $kbDupCfg '.coop/config') $dupJson
  $env:COOP_DIR = $kbDupCfg
  $dupSpec = (& $coop launch-spec 2>&1 | Out-String) -replace '\\', '/'
  $dupRc = $LASTEXITCODE
  $env:COOP_DIR = $priorCoop
  if ($dupRc -eq 0) { Ok 'duplicate names: PowerShell launcher exits 0' } else { Ko "dup aborted PS launcher: rc=$dupRc" }
  if ($dupSpec -like '*kb-dup-a*shared-skill*') { Ok 'first repository copy loaded (PS)' } else { Ko 'first copy missing (PS)' }
  if ($dupSpec -like '*kb-dup-b*') { Ko 'second repository duplicate NOT skipped (PS)' } else { Ok 'second repository duplicate skipped (PS)' }

  # --- 1g. ResumeThread previous-suspend-count contract (Defect A) ----------
  # Deterministic unit test of the pure verdict classifier: failure sentinel,
  # expected prev=1 for a CREATE_SUSPENDED first resume, already-running (0),
  # and still-suspended (>1). Fail-safe cleanup paths are unchanged.
  Head 'resume thread suspend-count contract'
  $resumePy = @'
import importlib.util
spec = importlib.util.spec_from_file_location("kg", r"ROOT/scripts/knowledge-git.py")
kg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kg)
cases = [
    (0xFFFFFFFF, False, "failure_sentinel"),
    (1, True, None),
    (0, False, "already_running"),
    (2, False, "still_suspended:2"),
]
for prev, ok, detail in cases:
    got_ok, got_code = kg._win_resume_verdict(prev)
    assert got_ok is ok, (prev, got_ok, ok)
    got_detail = got_code[1] if got_code else None
    assert got_detail == detail, (prev, got_detail, detail)
print("resume verdict contract OK")
'@
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $resumeOut = @($resumePy.Replace('ROOT', ($root -replace '\\', '/')) | python -)
  $resumeRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  $resumeOut | ForEach-Object { Write-Host $_ }
  if (($resumeRc -eq 0) -and ($resumeOut -join ' ' -like '*resume verdict contract OK*')) {
    Ok 'resume verdict: failure sentinel / expected prev=1 / already-running / still-suspended'
  } else {
    Ko "resume verdict contract failed: $($resumeOut | Out-String)"
  }


  # --- 2. --no-launch is a dry-run: exits 0, prints the spec -----------------
  Head '--no-launch dry-run (must NOT start pi; prints the spec)'
  $nlOut = (& $coop --no-launch 2>&1 | Out-String) -replace '\\', '/'
  if ($LASTEXITCODE -eq 0) { Ok '--no-launch exits 0' } else { Ko "--no-launch exited $LASTEXITCODE (expected 0)" }
  if ($nlOut -like '*docs/guardrails.md*') { Ok '--no-launch prints the launch spec' } else { Ko '--no-launch did not print the spec (no docs/guardrails.md)' }
  $jsonOut = & $coop --no-launch --json 2>&1 | Out-String
  if (($jsonOut -like '*"bin"*') -and ($jsonOut -like '*"args"*') -and ($jsonOut -like '*"env"*')) {
    Ok '--no-launch --json emits {bin,args,env}'
  } else { Ko '--no-launch --json did not emit the JSON spec' }
  try {
    $jsonData = $jsonOut | ConvertFrom-Json
    if ($jsonData.env.PI_SKIP_VERSION_CHECK -eq '1') { Ok 'launch spec suppresses Pi upstream version notices' }
    else { Ko 'launch spec does not suppress Pi upstream version notices' }
    # #165: MCP comes only from coop's agent-dir mcp-adapter.json, never a repo's .mcp.json.
    if ($jsonData.env.PI_MCP_CONFIG_MODE -eq 'exclusive') { Ok "launch spec pins MCP config to coop's agent dir (PI_MCP_CONFIG_MODE=exclusive)" }
    else { Ko 'launch spec does not set PI_MCP_CONFIG_MODE=exclusive' }
    # Client data isolation: Pi's /bug upload must never reach radius.pi.dev from a coop session.
    if ($jsonData.env.PI_RADIUS_GATEWAY -eq 'https://radius.coop.invalid') { Ok 'launch spec blocks the Pi /bug upload (PI_RADIUS_GATEWAY points at an unresolvable host)' }
    else { Ko "launch spec does not block the Pi /bug upload (PI_RADIUS_GATEWAY='$($jsonData.env.PI_RADIUS_GATEWAY)')" }
  } catch { Ko "--no-launch --json update-policy check failed: $_" }

  # --- 2b. coop web is retired (S5): it warns and starts the terminal agent ----
  # Old 'coop' shortcuts still run `coop web`; it must reach Pi, not fail.
  Head 'coop web (retired) starts the terminal agent'
  $webStub = Join-Path $stub 'web-retired'
  New-Item -ItemType Directory -Force -Path $webStub | Out-Null
  $webMarker = Join-Path $webStub 'pi-ran'
  $webPin = (Get-Content -LiteralPath (Join-Path $root 'config\release-manifest.json') -Raw | ConvertFrom-Json).pi.version
  [System.IO.File]::WriteAllText((Join-Path $webStub 'pi'), "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && { echo `"pi $webPin`"; exit 0; }`n: > '$webMarker'`nexit 0`n")
  if ($IsLinux -or $IsMacOS) { & chmod +x (Join-Path $webStub 'pi') }
  [System.IO.File]::WriteAllText((Join-Path $webStub 'pi.cmd'), "@echo off`r`nif `"%1`"==`"--version`" (echo pi $webPin& exit /b 0)`r`ntype nul > `"$webMarker`"`r`nexit /b 0`r`n")
  $webPriorPath = $env:PATH
  $webPriorSkipExt = $env:COOP_SKIP_EXT_CHECK
  $env:PATH = "$webStub$([System.IO.Path]::PathSeparator)$env:PATH"
  $env:COOP_SKIP_EXT_CHECK = '1'
  # The child's warning is native stderr: under 'Stop', Windows PowerShell turns it
  # into a terminating NativeCommandError, so capture it with 'Continue'.
  $webEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $webOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File $coop web 2>&1 | Out-String) }
  finally {
    $ErrorActionPreference = $webEap
    $env:PATH = $webPriorPath
    if ($null -eq $webPriorSkipExt) { Remove-Item Env:COOP_SKIP_EXT_CHECK -ErrorAction SilentlyContinue } else { $env:COOP_SKIP_EXT_CHECK = $webPriorSkipExt }
  }
  if ($webOut -like '*coop web was removed*') { Ok 'coop web says it was removed' } else { Ko "coop web did not explain its removal: $webOut" }
  if (Test-Path -LiteralPath $webMarker) { Ok 'coop web started the terminal agent (pi ran)' } else { Ko "coop web did not start pi: $webOut" }

  # --- 3. context-budget via PowerShell dispatcher ---------------------------
  Head 'coop context-budget (PowerShell dispatch)'
  $pythonAvailable = (Get-Command python3 -ErrorAction SilentlyContinue) -or (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $pythonAvailable) {
    Ok 'python not available on this runner; skipping context-budget PowerShell tests'
  } else {
    $cbOut = & $coop context-budget 2>&1 | Out-String
    if ($cbOut -like '*COOP context budget*') { Ok 'context-budget prints the human header' } else { Ko 'context-budget missing human header' }
    if ($cbOut -like '*Estimated fixed total*') { Ok 'context-budget reports the estimated fixed total' } else { Ko 'context-budget missing estimated fixed total' }
    if ($cbOut -like '*On-demand inventory*') { Ok 'context-budget lists on-demand inventory separately' } else { Ko 'context-budget missing on-demand inventory section' }
    $cbJsonOut = & $coop context-budget --json 2>&1 | Out-String
    try {
      $cbData = $cbJsonOut | ConvertFrom-Json
      if ($cbData.schema_version -eq 1) { Ok 'context-budget --json schema_version is 1' } else { Ko 'context-budget --json schema_version unexpected' }
      if ($cbData.estimated_fixed_total_tokens -gt 0) { Ok 'context-budget --json fixed total is positive' } else { Ko 'context-budget --json fixed total not positive' }
      $prompts = $cbData.categories.on_demand_inventory.prompts
      if ($prompts.chars -gt 0) { Ok 'context-budget --json reports on-demand prompt inventory' } else { Ko 'context-budget --json missing prompt inventory' }
    } catch {
      Ko "context-budget --json did not parse as JSON: $_"
    }
    $cbCheck = Join-Path $root 'scripts\check-context-budget.ps1'
    & $cbCheck
    if ($LASTEXITCODE -eq 0) { Ok 'check-context-budget.ps1 gate passes' } else { Ko 'check-context-budget.ps1 gate failed' }
  }

  # --- 4. update --check is a dry-run: reports versions, exits 0 -------------
  Head 'coop update --check (dry-run — reports current/expected)'
  $checkOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
& '$update' --check 2>`$null
"@ 6>$null | Out-String
  if ($LASTEXITCODE -eq 0) { Ok '--check exits 0' } else { Ko "--check exit was $LASTEXITCODE" }
  if ($checkOut -like '*expected 0.87.1*') { Ok '--check prints the pi expected version' } else { Ko '--check missing pi expected version' }
  if ($checkOut -like '*status *') { Ok '--check prints a status column' } else { Ko '--check missing status column' }
  if ($checkOut -like '*@microsoft/powerbi-report-authoring-cli*') { Ok '--check lists npm authoring tools' } else { Ko '--check missing npm authoring tools' }
  # --pi-latest is a deprecated alias for --edge: it warns (stderr) and the
  # read-only --check table is unchanged (normal update pins to the manifest;
  # --edge is the only latest/upstream mode, exercised in fleet-execution).
  # The warning is written through [Console]::Error (Coop-Emit), so it reaches
  # this process as the child's stderr: capture it here, under Continue (5.1
  # turns redirected native stderr into NativeCommandError records).
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $piLatestOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
& '$update' --pi-latest --check
"@ 2>&1 6>$null | Out-String
  $piLatestRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($piLatestRc -eq 0 -and ($piLatestOut -like '*--pi-latest is deprecated*') -and ($piLatestOut -like '*expected 0.87.1*')) {
    Ok '--pi-latest warns that it is deprecated and still reaches the --check dry-run'
  } else { Ko "--pi-latest --check: exit $piLatestRc, output: $piLatestOut" }

  # --- 5. dispatcher preserves one trailing argument -------------------------
  # Before the fix, coop.ps1 split the scalar '--check' into six characters and
  # update.ps1 entered its mutating path; this asserts the real --check dry-run
  # is reached through the public wrapper (the stub PATH answers every probe,
  # and --check itself installs nothing).
  Head 'coop update --check wrapper forwarding (single trailing argument)'
  $wrappedCheckOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
& '$coop' update --check 2>&1
"@ 6>$null | Out-String
  if (($wrappedCheckOut -like '*expected 0.87.1*') -and ($wrappedCheckOut -like '*status *')) {
    Ok 'coop wrapper forwards --check intact to the read-only path'
  } else { Ko "coop wrapper did not reach the --check dry-run: $wrappedCheckOut" }
  if ($wrappedCheckOut -notlike '*ignoring unknown flag*') {
    Ok 'coop wrapper does not split --check into unknown flags'
  } else { Ko 'coop wrapper split --check into unknown flags' }

  # --- 7c. Microsoft skills catalog deterministic fixture -------------------
  Head 'Microsoft skills catalog fixture'
  $pyExe = (Get-Command python3 -ErrorAction SilentlyContinue)
  if (-not $pyExe) { $pyExe = (Get-Command python -ErrorAction SilentlyContinue) }
  if ($pyExe) {
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $msOut = & $pyExe.Source (Join-Path $root 'tests\microsoft-skills.test.py') 2>&1
    $msRc = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($msRc -eq 0) {
      $msOut | ForEach-Object { Write-Host $_ }
    } else {
      Ko "Microsoft skills catalog fixture failed: $($msOut | Out-String)"
    }

    Head 'bounded legacy project diagnostics and migration'
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $legacyOut = & $pyExe.Source (Join-Path $root 'tests\project-health.test.py') 2>&1
    $legacyRc = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($legacyRc -eq 0) {
      $legacyOut | ForEach-Object { Write-Host $_ }
    } else {
      Ko "legacy project health fixture failed: $($legacyOut | Out-String)"
    }
  } else {
    Ko 'python not available; Microsoft skills catalog fixture cannot run'
  }

  # --- 7d. Warehouse MCP doctor + P0 acceptance fixtures --------------------
  Head 'Warehouse MCP and P0 vertical slice fixtures'
  if ($pyExe) {
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $whOut = & $pyExe.Source (Join-Path $root 'tests\warehouse-mcp.test.py') 2>&1
    $whRc = $LASTEXITCODE
    $p0Out = & $pyExe.Source (Join-Path $root 'tests\p0-vertical-slice.test.py') 2>&1
    $p0Rc = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($whRc -eq 0 -and $p0Rc -eq 0) {
      $whOut | ForEach-Object { Write-Host $_ }
      $p0Out | ForEach-Object { Write-Host $_ }
    } else {
      Ko "Warehouse/P0 fixtures failed: $($whOut | Out-String) $($p0Out | Out-String)"
    }
  } else {
    Ko 'python not available; Warehouse/P0 fixtures cannot run'
  }

  # --- 8. Child fixtures: one pwsh/powershell child each ---------------------
  # Every fixture under tests/fixtures is a self-contained script (they share
  # tests/fixtures/_common.ps1 for Ok/Ko, Save-Env/Restore-Env, stubs and doctor
  # row helpers). Lane 'extended' rows run only with COOP_TEST_EXTENDED=1 (#96):
  # timing and process fixtures, and the ones that run the real scripts many
  # times (doctor and inventory take about a minute each). A fixture's
  # output is echoed when it passes; a non-zero exit, or a missing Needle, fails
  # this run with its full output. Coop status output is stderr: the children
  # run under ErrorActionPreference=Continue because Windows PowerShell 5.1
  # turns redirected native stderr into NativeCommandError records.
  # home-guard checks the CALLER's real home on purpose (#135): RestoreHome puts
  # it back for that child, then the gate-lane temp home returns.
  $fixtures = @(
    @{ Name = 'sync-knowledge-timeout'; Lane = 'extended'; Head = 'knowledge git timeout (PowerShell)' },
    @{ Name = 'win-ownership-probe';    Lane = 'extended'; File = 'win-ownership-probe.ps1'; Head = 'windows ownership native probe (evidence only)'; OkLine = 'ownership probe completed; PROBE| evidence above' },
    @{ Name = 'update-follow';          Lane = 'gate';     Head = 'coop update follows release tags (never backwards)' },
    @{ Name = 'version-describe';       Lane = 'gate';     Head = 'coop version and doctor --publish carry git describe' },
    @{ Name = 'pipx-ownership';         Lane = 'gate';     Head = 'pipx executable ownership' },
    @{ Name = 'install-pipx-unit';      Lane = 'gate';     Head = 'install pipx unit (bootstrap verdict, no-result job diagnostics, parent-side verify)' },
    @{ Name = 'fabric-python-finder';   Lane = 'gate';     Head = 'fabric-compatible Python discovery' },
    @{ Name = 'fabric-mcp-launch';      Lane = 'extended'; Head = 'Fabric MCP launch-time bearer isolation'; Needle = 'FABRIC_MCP_FIXTURE_INJECTION_REACHED' },
    @{ Name = 'release';                Lane = 'gate';     Head = 'release transaction consistency' },
    @{ Name = 'search-knowledge';       Lane = 'gate';     Head = 'team knowledge local recall helper' },
    @{ Name = 'install-python-prereq';  Lane = 'extended'; Head = 'fresh-install Fabric Python prerequisite' },
    @{ Name = 'install-prereq-gate';    Lane = 'gate';     Head = 'install prerequisite gate (and the D1k offer: --yes, continue after a passing re-check)' },
    @{ Name = 'bootstrap';              Lane = 'gate';     Head = 'scripts/bootstrap.ps1: the one-command terminal bootstrap (D1k; dry run, Windows-only guard)' },
    @{ Name = 'azcache';                Lane = 'gate';     Head = 'Azure sign-in preflight (tenant chain, token check, automatic sign-in, .az-ok cache)' },
    @{ Name = 'doctor-warehouse';       Lane = 'gate';     Head = 'doctor.ps1 Warehouse tenant and fabric MCP rows' },
    @{ Name = 'doctor-pipx-shadow';     Lane = 'gate';     Head = 'doctor.ps1 pipx PATH-shadow rows (foreign coop-data-doc on PATH vs. stale venv)' },
    @{ Name = 'doctor-fleet-pins';      Lane = 'gate';     Head = 'doctor.ps1 npm tool pins and retired reviewers' },
    @{ Name = 'seeddocs';               Lane = 'gate';     Head = 'coop init --seed-docs shows the config-set status (not runnable = warning)' },
    @{ Name = 'data-doc-summary';       Lane = 'gate';     Head = 'coop data-doc summarizes the graph its config names (subfolder, --config, failures)' },
    @{ Name = 'fleet-manifest';         Lane = 'gate';     Head = 'fleet manifest (Coop-Manifest* helpers, fleet plan)' },
    @{ Name = 'login-present';          Lane = 'gate';     Head = 'model login detection ignores Pi''s empty startup auth.json (#167)' },
    @{ Name = 'extensions-lock';        Lane = 'gate';     Head = 'extension lockfile applied through the helpers (#152)' },
    @{ Name = 'team-skills';            Lane = 'gate';     Head = 'team knowledge skills launch slot (launch-spec --json)' },
    @{ Name = 'desktop-spec';           Lane = 'gate';     Head = 'coop desktop: the window''s launch spec and runtime state (D1b)' },
    @{ Name = 'desktop-bundle';         Lane = 'gate';     Head = 'coop window package: the bundled Node, Pi and extension tree (D1d)' },
    @{ Name = 'staleness';              Lane = 'gate';     Head = 'repo staleness nudge (throttled fetch + behind-count)' },
    @{ Name = 'coop-unit';              Lane = 'gate';     Head = 'Coop-Unit: the 5.1 job persistence path, and a job that returns nothing is re-run in-process' },
    @{ Name = 'doctor-project';         Lane = 'gate';     Head = 'doctor.ps1 project contract rows' },
    @{ Name = 'first-run';              Lane = 'gate';     Head = 'first-run launcher continuation (onboarding gate)' },
    @{ Name = 'profile-root';           Lane = 'gate';     Head = 'one profile root: COOP_DIR parent of .coop, one agent-dir chain (S3, #220)' },
    @{ Name = 'sync-knowledge';         Lane = 'gate';     Head = 'team knowledge sync (sync-knowledge.ps1; hang cases in the extended lane)' },
    @{ Name = 'teamai';                 Lane = 'gate';     Head = 'coop teamai: isolated TeamAI adapter entry (K1; off by default)' },
    @{ Name = 'fleet-execution';        Lane = 'extended'; Head = 'fleet execution (install/update/sync against stubs)' },
    @{ Name = 'home-guard';             Lane = 'extended'; Head = 'home-guard (fleet paths must not mutate the real home)'; RestoreHome = $true },
    @{ Name = 'doctor';                 Lane = 'extended'; Head = 'doctor.ps1 MCP mode, az preflight, login and fleet rows' },
    @{ Name = 'inventory';              Lane = 'extended'; Head = 'truthful inventory (doctor pipx probes / sync postconditions)' },
    @{ Name = 'profile-redirect';       Lane = 'gate';     Head = 'install shortcuts and user PATH follow a redirected profile (isolated install)' },
    @{ Name = 'pi-busy-guard';          Lane = 'gate';     Head = 'install/update busy guard counts only this install''s Pi sessions (#234)' })
  foreach ($fx in $fixtures) {
    if ($fx.Lane -eq 'extended' -and -not $extendedLane) { continue }
    Head $fx.Head
    $fxFile = if ($fx.File) { $fx.File } else { $fx.Name + '.test.ps1' }
    $hgSaved = @{}
    if ($fx.RestoreHome) {
      foreach ($name in $homeVarNames) { $hgSaved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $priorHomeVars[$name]) }
    }
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $fxOut = & $psExe -NoProfile -File (Join-Path $root ('tests\fixtures\' + $fxFile)) 2>&1
    $fxRc = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($fx.RestoreHome) {
      foreach ($name in $homeVarNames) { [Environment]::SetEnvironmentVariable($name, $hgSaved[$name]) }
    }
    $fxText = $fxOut | Out-String
    if ($fxRc -eq 0 -and ((-not $fx.Needle) -or $fxText.Contains($fx.Needle))) {
      $fxOut | ForEach-Object { Write-Host $_ }
      if ($fx.OkLine) { Ok $fx.OkLine }
    } else {
      Ko "$($fx.Name) fixture failed (rc=$fxRc): $fxText"
    }
  }

  # --- 8b. EXTENDED LANE: Fabric MCP child-failure propagation --------------
  # Regression for a prior false green: re-run this file's exact fixture path
  # in forced-failure mode (COOP_TEST_FABRIC_RUNNER_FAILURE_PROBE=1 exits at the
  # probe block at the top before any lane logic). The nested aggregate must stay
  # nonzero even though its probe runs a successful command after the child failure.
  if ($extendedLane) {
    Head 'Fabric MCP child failure propagation'
    $priorProbe = $env:COOP_TEST_FABRIC_RUNNER_FAILURE_PROBE
    $priorForcedFailure = $env:COOP_TEST_FORCE_FABRIC_FIXTURE_FAILURE
    $env:COOP_TEST_FABRIC_RUNNER_FAILURE_PROBE = '1'
    $env:COOP_TEST_FORCE_FABRIC_FIXTURE_FAILURE = '1'
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $fabricProbeOut = & $psExe -NoProfile -File $PSCommandPath *>&1
    $fabricProbeRc = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($null -eq $priorProbe) { Remove-Item Env:COOP_TEST_FABRIC_RUNNER_FAILURE_PROBE -ErrorAction SilentlyContinue }
    else { $env:COOP_TEST_FABRIC_RUNNER_FAILURE_PROBE = $priorProbe }
    if ($null -eq $priorForcedFailure) { Remove-Item Env:COOP_TEST_FORCE_FABRIC_FIXTURE_FAILURE -ErrorAction SilentlyContinue }
    else { $env:COOP_TEST_FORCE_FABRIC_FIXTURE_FAILURE = $priorForcedFailure }
    $fabricProbeText = $fabricProbeOut | Out-String
    if (
      $fabricProbeRc -ne 0 -and
      $fabricProbeText.Contains('FABRIC_MCP_FIXTURE_INJECTION_REACHED') -and
      $fabricProbeText.Contains('FABRIC_MCP_RUNNER_PROBE child-rc=1 later-rc=0')
    ) {
      Ok 'Fabric MCP child failure survives a later successful command and fails the aggregate'
    } else {
      Ko "Fabric MCP runner propagation regression failed: rc=$fabricProbeRc output=$fabricProbeText"
    }
  }
}
catch {
  # An error that escapes a section would otherwise skip every later section and
  # still end in "passed" with exit 0. Record it so this run fails.
  Ko "run.ps1 stopped early at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
}
finally {
  $env:PATH = $priorPath
  if ($priorHomeVars) { foreach ($name in $priorHomeVars.Keys) { [Environment]::SetEnvironmentVariable($name, $priorHomeVars[$name]) } }
  if ($null -eq $priorSkipAz) { Remove-Item Env:\COOP_SKIP_AZ -ErrorAction SilentlyContinue } else { $env:COOP_SKIP_AZ = $priorSkipAz }
  if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  if ($null -eq $priorCoopAgentDir) { Remove-Item Env:\COOP_AGENT_DIR -ErrorAction SilentlyContinue } else { $env:COOP_AGENT_DIR = $priorCoopAgentDir }
  if ($null -eq $priorPiAgentDir) { Remove-Item Env:\PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue } else { $env:PI_CODING_AGENT_DIR = $priorPiAgentDir }
  if ($null -eq $priorNoOnboard) { Remove-Item Env:\COOP_NO_ONBOARD -ErrorAction SilentlyContinue } else { $env:COOP_NO_ONBOARD = $priorNoOnboard }
  if ($null -eq $priorTestExtended) { Remove-Item Env:\COOP_TEST_EXTENDED -ErrorAction SilentlyContinue } else { $env:COOP_TEST_EXTENDED = $priorTestExtended }
  Remove-Item -LiteralPath $stub -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "`n$G_CROSS PowerShell behavioral tests FAILED ($laneName)"; exit 1 }
Write-Host "$G_CHECK PowerShell behavioral tests passed ($laneName)"
