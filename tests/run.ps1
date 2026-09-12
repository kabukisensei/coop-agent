#!/usr/bin/env pwsh
#
# coop PowerShell behavioral tests (twin of the PS-relevant assertions in tests/run.sh).
# Windows is coop's PRIMARY target, yet every behavioral test drove the BASH side only —
# the .ps1 dispatcher (coop.ps1) and update gate (update.ps1) had no executable safety
# net. This exercises the SAME seams tests/run.sh does, but through PowerShell:
#   1. coop.ps1 launch-spec resolves guardrails, prompts, theme, all 3 extensions
#   2. coop.ps1 --no-launch exits 0 + prints the spec; --no-launch --json emits {bin,args,env}
#   3. update.ps1 fleet-mode decisions via COOP_UPDATE_GATE_DRYRUN
#      (the same seams tests/update-guard.test.sh drives against update.sh)
#   4. update.ps1 --check is a dry-run that reports current/expected and exits 0
#   5. coop.ps1 forwards a single trailing --check argument intact to update.ps1
#   6. coop.ps1 review --help exits 0; an unknown review flag dies non-zero
#
# No network: the fleet-mode decision stops before any install via
# COOP_UPDATE_GATE_DRYRUN. Runs under Windows PowerShell 5.1
# (coop.cmd's runtime) and pwsh 7 (macOS/Linux CI). CI wires it into the windows +
# tests jobs; run locally with `pwsh -File tests/run.ps1`.
#
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:COOP_ROOT = $root
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$update = Join-Path (Join-Path $root 'scripts') 'update.ps1'

# Run the child gate/check invocations under the SAME PowerShell edition that runs
# this file — so under `shell: powershell` (coop.cmd's Windows PowerShell 5.1) the
# gate is exercised on 5.1, and under pwsh 7 (CI ubuntu / macOS) on pwsh. Falls back
# to 'pwsh' if the host path can't be resolved.
$psExe = try { (Get-Process -Id $PID).Path } catch { $null }
if (-not $psExe) { $psExe = 'pwsh' }

# Status glyphs via [char] codepoints (Windows PowerShell 5.1 compat, matching
# lib/common.ps1) — a BOM-less or mis-encoded literal glyph mojibakes on 5.1.
$G_CHECK = [char]0x2713   # ✓
$G_CROSS = [char]0x2717   # ✗
$G_ARROW = [char]0x2192   # →

$fail = 0
function Ok   { param([string]$m) Write-Host "  $G_CHECK $m" }
function Ko   { param([string]$m) Write-Host "  $G_CROSS $m"; $script:fail = 1 }
function Head { param([string]$m) Write-Host "$G_ARROW $m" }

# These contracts are platform-neutral but run here as well so Windows CI cannot
# drift away from the same capability and Desktop release baseline as Bash CI.
Head 'Pi process detection parity tests'
& node (Join-Path $root 'tests\pi-process-guard.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Pi process detection parity passes' }
else { Ko 'Pi process detection parity failed' }

Head 'Desktop capability and parity contract tests'
& node (Join-Path $root 'tests\desktop-contracts.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Desktop capability and parity contracts pass' }
else { Ko 'Desktop capability and parity contracts failed' }

Head 'Desktop shell selection contract tests'
& node (Join-Path $root 'tests\desktop-shell-spike.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Desktop shell selection contracts pass' }
else { Ko 'Desktop shell selection contracts failed' }

Head 'Desktop preview lifecycle and native-boundary tests'
& node (Join-Path $root 'tests\desktop-preview-shell.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Desktop preview lifecycle and native-boundary contracts pass' }
else { Ko 'Desktop preview lifecycle and native-boundary contracts failed' }

Head 'Managed Desktop runtime bundle tests'
& node (Join-Path $root 'tests\windows-health-job.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Windows health job process cleanup passes' }
else { Ko 'Windows health job process cleanup failed' }
& node (Join-Path $root 'tests\managed-mcp.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Managed MCP isolation and bundled configuration pass' }
else { Ko 'Managed MCP isolation and bundled configuration failed' }
& node (Join-Path $root 'tests\managed-tool-invocation.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Managed tool invocation contracts pass' }
else { Ko 'Managed tool invocation contracts failed' }
& node (Join-Path $root 'tests\windows-update-replacement.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Windows replacement and recovery contracts pass' }
else { Ko 'Windows replacement and recovery contracts failed' }
& node (Join-Path $root 'tests\windows-update-archive.test.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $root 'tests\windows-update-application.test.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $root 'tests\windows-update-prepare.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Windows update archive extraction contracts pass' }
else { Ko 'Windows update archive extraction contracts failed' }
& node (Join-Path $root 'tests\managed-runtime-build-plan.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Managed Desktop runtime build-plan contracts pass' }
else { Ko 'Managed Desktop runtime build-plan contracts failed' }
& node (Join-Path $root 'tests\prepare-managed-runtime.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Managed Desktop runtime preparation contracts pass' }
else { Ko 'Managed Desktop runtime preparation contracts failed' }
& node (Join-Path $root 'tests\managed-runtime.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Managed Desktop runtime bundle contracts pass' }
else { Ko 'Managed Desktop runtime bundle contracts failed' }
& node (Join-Path $root 'tests\managed-package-security.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Managed Desktop packaged security contracts pass' }
else { Ko 'Managed Desktop packaged security contracts failed' }

Head 'Signed Desktop update and rollback contract tests'
& node (Join-Path $root 'tests\update-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Signed Desktop update and rollback contracts pass' }
else { Ko 'Signed Desktop update and rollback contracts failed' }
& node (Join-Path $root 'tests\update-trust.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Packaged Desktop update trust boundary passes' }
else { Ko 'Packaged Desktop update trust boundary failed' }

Head 'Desktop release evidence and parity gate tests'
& node (Join-Path $root 'tests\desktop-release-gate.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Desktop release evidence and parity gate contracts pass' }
else { Ko 'Desktop release evidence and parity gate contracts failed' }

Head 'Commands, images, and live queue projection tests'
& node (Join-Path $root 'tests\interaction-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Commands, images, and live queue projection contracts pass' }
else { Ko 'Commands, images, and live queue projection contracts failed' }

Head 'Workspace onboarding and Health projection tests'
& node (Join-Path $root 'tests\workspace-health-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Workspace onboarding and Health projection contracts pass' }
else { Ko 'Workspace onboarding and Health projection contracts failed' }

Head 'Allowlisted capability-view and generic findings projection tests'
& node (Join-Path $root 'tests\capability-view-registry.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Capability-view extension contracts pass' }
else { Ko 'Capability-view extension contracts failed' }
& node (Join-Path $root 'tests\findings-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Generic findings projection contracts pass' }
else { Ko 'Generic findings projection contracts failed' }
& node (Join-Path $root 'tests\findings-golden.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Pinned SQL/DAX golden parity contracts pass' }
else { Ko 'Pinned SQL/DAX golden parity contracts failed' }
& node (Join-Path $root 'tests\lineage-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Focused Data Doc lineage projection contracts pass' }
else { Ko 'Focused Data Doc lineage projection contracts failed' }
& node (Join-Path $root 'tests\impact-analysis.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Guided impact analysis contracts pass' }
else { Ko 'Guided impact analysis contracts failed' }

Head 'Resumable workflow extension contract tests'
& node (Join-Path $root 'tests\workflow-extensions.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Workflow extension contracts pass' }
else { Ko 'Workflow extension contracts failed' }

Head 'Shared user profile owner/service tests'
& node (Join-Path $root 'tests\profile-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Shared user profile owner/service contracts pass' }
else { Ko 'Shared user profile owner/service contracts failed' }

Head 'Runtime capability negotiation tests'
& node (Join-Path $root 'tests\runtime-capabilities.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Runtime capability negotiation contracts pass' }
else { Ko 'Runtime capability negotiation contracts failed' }

Head 'Structured execution and runtime event contract tests'
& node (Join-Path $root 'tests\runtime-domain.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Structured execution and runtime event contracts pass' }
else { Ko 'Structured execution and runtime event contracts failed' }

Head 'Declarative service extension contract tests'
& node (Join-Path $root 'tests\service-extensions.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Declarative service extension contracts pass' }
else { Ko 'Declarative service extension contracts failed' }

Head 'Shared Doctor service contract tests'
& node (Join-Path $root 'tests\doctor-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Shared Doctor service contracts pass' }
else { Ko 'Shared Doctor service contracts failed' }

Head 'Shared authentication provider contract tests'
& node (Join-Path $root 'tests\auth-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Shared authentication provider contracts pass' }
else { Ko 'Shared authentication provider contracts failed' }

Head 'Shared project configuration proposal/write contract tests'
& node (Join-Path $root 'tests\project-config-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Shared project configuration proposal/write contracts pass' }
else { Ko 'Shared project configuration proposal/write contracts failed' }

Head 'Read-only environment discovery contract tests'
& node (Join-Path $root 'tests\environment-discovery.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Read-only environment discovery contracts pass' }
else { Ko 'Read-only environment discovery contracts failed' }

Head 'Progressive project setup state contract tests'
& node (Join-Path $root 'tests\project-setup-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Progressive project setup state contracts pass' }
else { Ko 'Progressive project setup state contracts failed' }

Head 'Pi RPC adapter and runtime client tests'
& node (Join-Path $root 'tests\rpc-adapter.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Pi RPC adapter and runtime client contracts pass' }
else { Ko 'Pi RPC adapter and runtime client contracts failed' }

Head 'Provider usage window compatibility tests'
& node (Join-Path $root 'tests\usage-windows.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Provider usage window compatibility passes' }
else { Ko 'Provider usage window compatibility failed' }

Head 'Session tree projection tests'
& node (Join-Path $root 'tests\session-tree-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Session tree projection contracts pass' }
else { Ko 'Session tree projection contracts failed' }

Head 'Existing-branch navigation adapter tests'
& node (Join-Path $root 'tests\tree-navigation.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Existing-branch navigation adapter passes' }
else { Ko 'Existing-branch navigation adapter failed' }

Head 'Cross-client workspace isolation tests'
& node (Join-Path $root 'tests\workspace-isolation.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Cross-client workspace isolation contracts pass' }
else { Ko 'Cross-client workspace isolation contracts failed' }

Head 'Governed knowledge scope and lifecycle policy tests'
& node (Join-Path $root 'tests\knowledge-policy.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Governed knowledge policy contracts pass' }
else { Ko 'Governed knowledge policy contracts failed' }

Head 'Disposable Git-backed knowledge index tests'
& node (Join-Path $root 'tests\knowledge-index.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Disposable knowledge index contracts pass' }
else { Ko 'Disposable knowledge index contracts failed' }

Head 'Governed knowledge source-change and presentation tests'
& node (Join-Path $root 'tests\knowledge-service.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Governed knowledge source-change contracts pass' }
else { Ko 'Governed knowledge source-change contracts failed' }
& node (Join-Path $root 'tests\knowledge-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Governed knowledge presentation contracts pass' }
else { Ko 'Governed knowledge presentation contracts failed' }

Head 'Workspace-first Mission Control projection tests'
& node (Join-Path $root 'tests\mission-control-model.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Mission Control projection contracts pass' }
else { Ko 'Mission Control projection contracts failed' }

Head 'Shared three-theme design-system tests'
& node (Join-Path $root 'tests\theme-system.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Three-theme design-system contracts pass' }
else { Ko 'Three-theme design-system contracts failed' }

Head 'Clipboard and attachment portability tests'
& node (Join-Path $root 'tests\content-portability.test.mjs')
& node (Join-Path $root 'tests\clipboard-interoperability.test.mjs')
& node (Join-Path $root 'tests\session-export.test.mjs')
if ($LASTEXITCODE -eq 0) { Ok 'Clipboard and attachment portability contracts pass' }
else { Ko 'Clipboard and attachment portability contracts failed' }

Head 'Cross-client writable session lease tests'
$leaseDist = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-lease-build-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $leaseDist -Force | Out-Null
try {
  $entry = Join-Path $root 'extensions\coop-tools\index.ts'
  $typebox = Join-Path $root 'tests\typebox-stub.mjs'
  $outfile = Join-Path $leaseDist 'coop-tools.mjs'
  & npx -y esbuild $entry --bundle --format=esm --platform=node --packages=external "--alias:typebox=$typebox" "--outfile=$outfile"
  if ($LASTEXITCODE -ne 0) {
    Ko 'Could not bundle coop-tools for session lease tests'
  } else {
    $priorTestDist = $env:COOP_TEST_DIST
    $env:COOP_TEST_DIST = $leaseDist
    & node (Join-Path $root 'tests\session-lease.test.mjs')
    if ($LASTEXITCODE -eq 0) { Ok 'Cross-client writable session lease contracts pass' }
    else { Ko 'Cross-client writable session lease contracts failed' }
    & node (Join-Path $root 'tests\terminal-handoff.test.mjs')
    if ($LASTEXITCODE -eq 0) { Ok 'Safe terminal handoff contracts pass' }
    else { Ko 'Safe terminal handoff contracts failed' }
    if ($null -eq $priorTestDist) { Remove-Item Env:\COOP_TEST_DIST -ErrorAction SilentlyContinue }
    else { $env:COOP_TEST_DIST = $priorTestDist }
  }
} finally {
  Remove-Item -LiteralPath $leaseDist -Recurse -Force -ErrorAction SilentlyContinue
}

Head 'Supported Coop Runtime entry-point tests'
$env:PWSH_EXE = $psExe
& node (Join-Path $root 'tests\runtime-entrypoint.test.mjs')
Remove-Item Env:\PWSH_EXE -ErrorAction SilentlyContinue
if ($LASTEXITCODE -eq 0) { Ok 'Coop Runtime entry point passes' }
else { Ko 'Coop Runtime entry point failed' }

# --- pi/npm stubs on a scratch PATH -----------------------------------------
# The gate + --check need a `pi` (reporting 0.84.3) and an `npm` that Get-Command
# resolves. Windows PowerShell 5.1 finds a stub only via a PATHEXT extension
# (.cmd), so write BOTH an extension-less Unix executable and a .cmd wrapper.
$stub = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-ps-test-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $stub -Force | Out-Null
try {
  # Unix executables (extension-less, +x) — resolved by Get-Command on macOS/Linux.
  $piSh = "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && { echo `"pi 0.84.3`"; exit 0; }`nexit 0`n"
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi'),  $piSh)
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm'), "#!/bin/sh`nexit 0`n")
  if ($IsLinux -or $IsMacOS) { & chmod +x (Join-Path $stub 'pi') (Join-Path $stub 'npm') }
  # Windows .cmd wrappers — resolved by Get-Command on Windows PowerShell 5.1.
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi.cmd'),  "@echo off`r`nif `"%1`"==`"--version`" (echo pi 0.84.3& exit /b 0)`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm.cmd'), "@echo off`r`nexit /b 0`r`n")

  $sep = [System.IO.Path]::PathSeparator
  $stubPath = "$stub$sep$($env:PATH)"
  # The launch preflight can repair an extension tree. Point every writable
  # Coop/Pi location at this fixture and make the fake Pi authoritative so this
  # behavioral suite never inspects or changes the developer's real ~/.coop.
  $priorPath = $env:PATH
  $priorCoopDir = $env:COOP_DIR
  $priorCoopAgentDir = $env:COOP_AGENT_DIR
  $priorPiAgentDir = $env:PI_CODING_AGENT_DIR
  $priorNoOnboard = $env:COOP_NO_ONBOARD
  $env:PATH = $stubPath
  $env:COOP_DIR = Join-Path $stub 'coop-dir'
  $env:COOP_AGENT_DIR = Join-Path $stub 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'

  # --- 0. byte-level BOM gate: exactly ONE UTF-8 BOM on every .ps1 ------------
  # A duplicate BOM is invisible to parsers but makes PowerShell read the
  # shebang line as a command — the launcher dies at startup (review finding 1).
  Head 'byte-level BOM check (exactly one UTF-8 BOM per .ps1)'
  $bomFail = $false
  Get-ChildItem -Path $root -Recurse -Filter '*.ps1' |
    Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|\.cache)[\\/]' } |
    ForEach-Object {
      $bytes = [System.IO.File]::ReadAllBytes($_.FullName)[0..5]
      $hasBom = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
      $dupBom = $hasBom -and ($bytes.Count -ge 6 -and $bytes[3] -eq 0xEF -and $bytes[4] -eq 0xBB -and $bytes[5] -eq 0xBF)
      if ($dupBom) { Ko "duplicate UTF-8 BOM: $($_.FullName)"; $bomFail = $true }
      elseif (-not $hasBom) { Ko "missing UTF-8 BOM: $($_.FullName)"; $bomFail = $true }
    }
  if (-not $bomFail) { Ok 'every .ps1 carries exactly one UTF-8 BOM' }

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

  # --- 1e. bounded knowledge git (process-tree deadline; PS in-process return) --
  Head 'knowledge git timeout (PowerShell)'
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $kgOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\sync-knowledge-timeout.test.ps1') 2>&1
  $kgRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($kgRc -eq 0) {
    $kgOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "knowledge git timeout fixture failed: $($kgOut | Out-String)"
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
  } catch { Ko "--no-launch --json update-policy check failed: $_" }

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

  # --- 4. update fleet-mode decisions (COOP_UPDATE_GATE_DRYRUN stops before install) -
  # Normal mode pins to the release manifest ('GATE pin:<v>'); --edge takes latest
  # ('GATE all'); --pi-latest is a deprecated alias for --edge.
  Head 'coop update fleet-mode decision (COOP_UPDATE_GATE_DRYRUN)'
  function Invoke-Gate {
    param([string[]]$GateArgs = @())
    $out = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
`$env:COOP_UPDATE_GATE_DRYRUN = '1'
& '$update' $($GateArgs -join ' ') 2>`$null
"@ 6>$null
    # The gate line is the last emitted 'GATE …' line.
    return (($out | Where-Object { $_ -match 'GATE' }) | Select-Object -Last 1)
  }
  $d = Invoke-Gate
  if ($d -eq 'GATE pin:0.84.3') { Ok 'normal mode pins Pi to the release manifest' } else { Ko "expected 'GATE pin:0.84.3', got '$d'" }
  $d = Invoke-Gate -GateArgs @('--edge')
  if ($d -eq 'GATE all') { Ok '--edge is the only latest/upstream mode' } else { Ko "with --edge expected 'GATE all', got '$d'" }
  $d = Invoke-Gate -GateArgs @('--pi-latest')
  if ($d -eq 'GATE all') { Ok '--pi-latest is a deprecated alias for --edge' } else { Ko "with --pi-latest expected 'GATE all', got '$d'" }

  # --- 4. update --check is a dry-run: reports versions, exits 0 -------------
  Head 'coop update --check (dry-run — reports current/expected)'
  $checkOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
& '$update' --check 2>`$null
"@ 6>$null | Out-String
  if ($LASTEXITCODE -eq 0) { Ok '--check exits 0' } else { Ko "--check exit was $LASTEXITCODE" }
  if ($checkOut -like '*expected 0.84.3*') { Ok '--check prints the pi expected version' } else { Ko '--check missing pi expected version' }
  if ($checkOut -like '*status *') { Ok '--check prints a status column' } else { Ko '--check missing status column' }
  if ($checkOut -like '*@microsoft/powerbi-report-authoring-cli*') { Ok '--check lists npm authoring tools' } else { Ko '--check missing npm authoring tools' }

  # --- 5. dispatcher preserves one trailing argument -------------------------
  # COOP_UPDATE_GATE_DRYRUN is a safety net: before the fix, coop.ps1 split the
  # scalar '--check' into six characters and update.ps1 entered its mutating path.
  # The gate seam stops that broken path before any install while this test asserts
  # that the real --check dry-run was reached through the public wrapper.
  Head 'coop update --check wrapper forwarding (single trailing argument)'
  $wrappedCheckOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
`$env:COOP_UPDATE_GATE_DRYRUN = '1'
& '$coop' update --check 2>&1
"@ 6>$null | Out-String
  if (($wrappedCheckOut -like '*expected 0.84.3*') -and ($wrappedCheckOut -like '*status *')) {
    Ok 'coop wrapper forwards --check intact to the read-only path'
  } else { Ko "coop wrapper did not reach the --check dry-run: $wrappedCheckOut" }
  if ($wrappedCheckOut -notlike '*ignoring unknown flag*' -and $wrappedCheckOut -notlike '*GATE *') {
    Ok 'coop wrapper does not split --check or enter the update gate'
  } else { Ko 'coop wrapper split --check or entered the mutating update path' }

  # --- 6. review --help exits 0; an unknown review flag dies -----------------
  Head 'coop review arg parsing (--help ok; unknown flag dies)'
  & $coop review --help *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'review --help exits 0' } else { Ko "review --help exit was $LASTEXITCODE" }
  & $coop review --bogus-flag *> $null
  if ($LASTEXITCODE -ne 0) { Ok 'review with an unknown flag dies non-zero' } else { Ko 'review --bogus-flag did not die' }

  # --- 7. pipx launcher ownership (Windows .exe metadata fallback) ----------
  Head 'pipx executable ownership'
  $ownerOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\pipx-ownership.test.ps1') 2>&1
  if ($LASTEXITCODE -eq 0) {
    $ownerOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "pipx ownership fixture failed: $($ownerOut | Out-String)"
  }

  # --- 7b. fabric-compatible Python discovery (side-by-side, off-PATH) ------
  Head 'fabric-compatible Python discovery'
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $finderOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\fabric-python-finder.test.ps1') 2>&1
  $finderRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($finderRc -eq 0) {
    $finderOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "fabric python finder fixture failed: $($finderOut | Out-String)"
  }

  # --- 8. release transaction ------------------------------------------------
  Head 'release transaction consistency'
  # Coop status output intentionally uses stderr. Windows PowerShell 5.1 turns
  # redirected native stderr into NativeCommandError records; with this suite's
  # ErrorActionPreference=Stop that would abort despite a zero child exit.
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $releaseOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\release.test.ps1') 2>&1
  $releaseRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($releaseRc -eq 0) {
    $releaseOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "release transaction fixture failed: $($releaseOut | Out-String)"
  }

  # --- 9b. team knowledge local recall helper (configured-clone search) --------
  Head 'team knowledge local recall helper'
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $searchKbOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\search-knowledge.test.ps1') 2>&1
  $searchKbRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($searchKbRc -eq 0) {
    $searchKbOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "team knowledge recall fixture failed: $($searchKbOut | Out-String)"
  }

  # --- 9c. Fresh install repairs a Python 3.14-only Fabric prerequisite -------
  Head 'fresh-install Fabric Python prerequisite'
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $pyPrereqOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\install-python-prereq.test.ps1') 2>&1
  $pyPrereqRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($pyPrereqRc -eq 0) {
    $pyPrereqOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "fresh-install Python prerequisite fixture failed: $($pyPrereqOut | Out-String)"
  }
}
finally {
  $env:PATH = $priorPath
  if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  if ($null -eq $priorCoopAgentDir) { Remove-Item Env:\COOP_AGENT_DIR -ErrorAction SilentlyContinue } else { $env:COOP_AGENT_DIR = $priorCoopAgentDir }
  if ($null -eq $priorPiAgentDir) { Remove-Item Env:\PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue } else { $env:PI_CODING_AGENT_DIR = $priorPiAgentDir }
  if ($null -eq $priorNoOnboard) { Remove-Item Env:\COOP_NO_ONBOARD -ErrorAction SilentlyContinue } else { $env:COOP_NO_ONBOARD = $priorNoOnboard }
  Remove-Item -LiteralPath $stub -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "$G_CROSS PowerShell behavioral tests FAILED"; exit 1 }
Write-Host "$G_CHECK PowerShell behavioral tests passed"
