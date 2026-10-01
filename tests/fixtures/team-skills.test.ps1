#!/usr/bin/env pwsh
# Team knowledge skills launch slot (port of tests/team-skills.test.sh), driven
# through `bin/coop.ps1 launch-spec --json` (Build-CoopPiArgs + Get-CoopSkillName):
#   - a configured knowledge repo's valid team skills become --skill args
#   - first-party collisions by directory name and by frontmatter name are skipped
#   - disabled / absent knowledge config leaves the args untouched
#   - a second repo also contributes (multi-repo); duplicate names: first wins
#   - malformed SKILL.md shapes never abort the launcher, keep stdout clean JSON
#     and warn on stderr
#   - with isolation off, the Microsoft catalog resolves from ~/.pi/agent
# Offline; every path is under a temp dir; COOP_DIR and HOME are sandboxed.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path $root 'bin\coop.ps1'
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-team-skills-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }
function Write-Skill([string]$Dir, [string]$Body) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Dir 'SKILL.md'), $Body, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-Config([string[]]$Repos) {
  $entries = @()
  foreach ($r in $Repos) { $entries += ('{"url":"https://example.com/' + (Split-Path -Leaf $r) + '.git","local_path":"' + ($r -replace '\\', '/') + '"}') }
  $json = '{"schema_version":1,"knowledge":{"enabled":true,"repos":[' + ($entries -join ',') + ']}}'
  [System.IO.File]::WriteAllText((Join-Path $cfg '.coop\config'), $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-RawConfig([string]$Json) { [System.IO.File]::WriteAllText((Join-Path $cfg '.coop\config'), $Json, (New-Object System.Text.UTF8Encoding($false))) }
# Run `coop launch-spec --json` with stdout and stderr captured SEPARATELY (the
# JSON contract: diagnostics never reach stdout). Returns @{ Rc; Out; Err; Args }
# where Args has separators normalized to '/'.
function Invoke-Spec {
  $so = Join-Path $t 'spec.json'; $se = Join-Path $t 'spec.err'
  $p = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $coop + '"'), 'launch-spec', '--json') -PassThru -NoNewWindow -WorkingDirectory $t -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  $out = [System.IO.File]::ReadAllText($so); $err = [System.IO.File]::ReadAllText($se)
  $spec = $null; $specArgs = @()
  try { $spec = $out | ConvertFrom-Json; if ($spec -and $spec.args) { $specArgs = @($spec.args | ForEach-Object { ([string]$_) -replace '\\', '/' }) } } catch { $spec = $null }
  return @{ Rc = $p.ExitCode; Out = $out; Err = $err; Json = $spec; Args = $specArgs }
}
function Test-HasArg([object]$Spec, [string]$Needle) { return [bool]@($Spec.Args | Where-Object { $_ -like "*$Needle*" }).Count }

$saved = @{}
$names = @('PATH', 'HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_NO_ONBOARD', 'COOP_SKIP_AZ', 'COOP_SKIP_UPDATE_CHECK', 'COOP_TEST_MS_DIR')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  $cfg = Join-Path $t 'coop'
  $sandboxHome = Join-Path $t 'home'
  New-Item -ItemType Directory -Force -Path (Join-Path $cfg '.coop'), $sandboxHome, (Join-Path $t 'agent') | Out-Null
  $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = $cfg
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  Remove-Item Env:\PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_NO_ISOLATE -ErrorAction SilentlyContinue
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_SKIP_UPDATE_CHECK = '1'

  $kb = Join-Path $t 'knowledge\team-repo'
  Write-Skill (Join-Path $kb 'skills\valid-team-skill') "---`nname: valid-team-skill`ndescription: A valid team skill`n---`n# Valid Team Skill`n"
  # Directory collision (azure-devops collides with first-party skills/azure-devops).
  Write-Skill (Join-Path $kb 'skills\azure-devops') "---`nname: azure-devops`ndescription: Colliding folder name`n---`n# Colliding folder`n"
  # Frontmatter name collision (collides with first-party skills/dax-patterns).
  Write-Skill (Join-Path $kb 'skills\colliding-fm-skill') "---`nname: dax-patterns`ndescription: Colliding frontmatter name`n---`n# Colliding FM`n"
  Write-Config @($kb)

  $s = Invoke-Spec
  if ($s.Rc -ne 0) { Ko "launch-spec exited $($s.Rc)" $s.Err }
  if (Test-HasArg $s 'knowledge/team-repo/skills/valid-team-skill') { Ok 'fixture team skill is included in launch-spec args' } else { Ko 'valid-team-skill missing from args' $s.Out }
  if (Test-HasArg $s 'knowledge/team-repo/skills/azure-devops') { Ko 'colliding folder skill was NOT skipped' $s.Out } else { Ok 'folder collision skipped with first-party precedence' }
  if (Test-HasArg $s 'knowledge/team-repo/skills/colliding-fm-skill') { Ko 'colliding frontmatter skill was NOT skipped' $s.Out } else { Ok 'frontmatter collision skipped with first-party precedence' }

  # Disabled config produces NO team skills in args.
  Write-RawConfig ('{"schema_version":1,"knowledge":{"enabled":false,"repos":[{"url":"https://example.com/team-repo.git","local_path":"' + ($kb -replace '\\', '/') + '"}]}}')
  $s = Invoke-Spec
  if (Test-HasArg $s 'valid-team-skill') { Ko 'disabled knowledge still loaded team skill' } else { Ok 'disabled knowledge config omits team skills' }

  # Absent knowledge config produces NO team skills in args.
  Write-RawConfig '{"schema_version":1}'
  $s = Invoke-Spec
  if (Test-HasArg $s 'valid-team-skill') { Ko 'absent knowledge config still loaded team skill' } else { Ok 'absent knowledge config omits team skills' }

  # Multi-repo: a second fixture repo also contributes skills (Phase 2.5).
  $kb2 = Join-Path $t 'knowledge\second-repo'
  Write-Skill (Join-Path $kb2 'skills\second-team-skill') "---`nname: second-team-skill`ndescription: Second team skill`n---`n# Second Team Skill`n"
  Write-Config @($kb, $kb2)
  $s = Invoke-Spec
  if ($s.Rc -ne 0) { Ko "launch-spec multi-repo exited $($s.Rc)" $s.Err }
  if (Test-HasArg $s 'knowledge/team-repo/skills/valid-team-skill') { Ok 'multi-repo: first repo skill included in launch-spec' } else { Ko 'multi-repo: first repo skill missing' $s.Out }
  if (Test-HasArg $s 'knowledge/second-repo/skills/second-team-skill') { Ok 'multi-repo: second repo skill included in launch-spec' } else { Ko 'multi-repo: second repo skill missing' $s.Out }

  # --- invalid-team-skill regression (review finding 2) -----------------------
  # An optional external skill with no parseable frontmatter name must never abort
  # startup, and stdout must stay clean JSON (diagnostics on stderr only).
  $kb3 = Join-Path $t 'knowledge\no-name-repo'
  Write-Skill (Join-Path $kb3 'skills\zzzz-invalid-final') "# No frontmatter at all: invalid external skill`n"
  Write-Config @($kb3)
  $s = Invoke-Spec
  if ($s.Rc -eq 0) { Ok 'missing-name skill alone: launcher exits 0' } else { Ko "missing-name alone aborted: rc=$($s.Rc)" $s.Err }
  if ($s.Json) { Ok 'missing-name alone: stdout is valid JSON' } else { Ko 'stdout contaminated' $s.Out }
  if (Test-HasArg $s 'zzzz-invalid-final') { Ko 'invalid skill still in launch args' } else { Ok 'invalid skill absent from launch args' }
  if ($s.Err.Contains('missing frontmatter name')) { Ok 'warning emitted on stderr' } else { Ko 'no warning on stderr' $s.Err }

  # Valid skill + zzzz-invalid-final (alphabetically LAST).
  $kb4 = Join-Path $t 'knowledge\mixed-repo'
  Write-Skill (Join-Path $kb4 'skills\aaa-valid-skill') "---`nname: aaa-valid-skill`ndescription: Valid`n---`n# Valid`n"
  Write-Skill (Join-Path $kb4 'skills\zzzz-invalid-final') "---`ndescription: has a description but no name field`n---`n# Invalid final skill`n"
  Write-Config @($kb4)
  $s = Invoke-Spec
  if ($s.Rc -eq 0) { Ok 'valid + invalid-final: launcher exits 0' } else { Ko "invalid-final aborted startup: rc=$($s.Rc)" $s.Err }
  if ($s.Json) { Ok 'valid + invalid-final: stdout is valid JSON' } else { Ko 'stdout contaminated' $s.Out }
  if (Test-HasArg $s 'aaa-valid-skill') { Ok 'valid skill still loaded alongside invalid-final' } else { Ko 'valid skill lost' $s.Out }
  if (Test-HasArg $s 'zzzz-invalid-final') { Ko 'invalid-final present in args' } else { Ok 'invalid-final absent from args' }
  if ($s.Err.Contains('missing frontmatter name')) { Ok 'invalid-final warned on stderr' } else { Ko 'no invalid-final warning' $s.Err }
  # Exact skill arguments: only the valid skill is added.
  $nargs = @($s.Args | Where-Object { $_ -like '*mixed-repo/skills/*' }).Count
  if ($nargs -eq 1) { Ok 'exactly one team --skill argument (the valid one)' } else { Ko "team skill arg count: $nargs" }

  # All malformed shapes from the review: empty / one-line / multiline-no-name.
  # A one-line file used to crash the launcher with [System.Char].Trim().
  $kb8 = Join-Path $t 'knowledge\shapes-repo'
  Write-Skill (Join-Path $kb8 'skills\aaa-valid-skill') "---`nname: aaa-valid-skill`n---`n# Valid`n"
  Write-Skill (Join-Path $kb8 'skills\bbb-empty-invalid') ''
  Write-Skill (Join-Path $kb8 'skills\ccc-one-line-invalid') "# no frontmatter at all: one line only`n"
  Write-Skill (Join-Path $kb8 'skills\ddd-multiline-no-name') "---`ndescription: no name key here`n---`n# Body without a name`n"
  Write-Config @($kb8)
  $s = Invoke-Spec
  if ($s.Rc -eq 0) { Ok 'malformed shapes: launcher exits 0' } else { Ko "malformed shapes aborted startup: rc=$($s.Rc)" $s.Err }
  if ($s.Json) { Ok 'malformed shapes: stdout is valid JSON' } else { Ko 'stdout contaminated' $s.Out }
  if (Test-HasArg $s 'aaa-valid-skill') { Ok 'valid skill still loaded alongside all malformed shapes' } else { Ko 'valid skill lost' $s.Out }
  foreach ($bad in @('bbb-empty-invalid', 'ccc-one-line-invalid', 'ddd-multiline-no-name')) {
    if (Test-HasArg $s $bad) { Ko "$bad present in args" } else { Ok "$bad absent from args" }
  }

  # No skill directories at all.
  $kb5 = Join-Path $t 'knowledge\empty-repo'
  New-Item -ItemType Directory -Force -Path $kb5 | Out-Null
  Write-Config @($kb5)
  $s = Invoke-Spec
  if ($s.Rc -eq 0) { Ok 'no skill dirs: launcher exits 0' } else { Ko "empty repo aborted: rc=$($s.Rc)" $s.Err }

  # Duplicate team names across repositories: first wins, second skipped.
  $kb6 = Join-Path $t 'knowledge\dup-repo-a'; $kb7 = Join-Path $t 'knowledge\dup-repo-b'
  Write-Skill (Join-Path $kb6 'skills\shared-skill') "---`nname: shared-skill`ndescription: First copy`n---`n# First`n"
  Write-Skill (Join-Path $kb7 'skills\shared-skill') "---`nname: shared-skill`ndescription: Second copy`n---`n# Second`n"
  Write-Config @($kb6, $kb7)
  $s = Invoke-Spec
  if ($s.Rc -eq 0) { Ok 'duplicate names: launcher exits 0' } else { Ko "dup aborted: rc=$($s.Rc)" $s.Err }
  if (Test-HasArg $s 'dup-repo-a/skills/shared-skill') { Ok "first repository's copy loaded" } else { Ko 'first copy missing' $s.Out }
  if (Test-HasArg $s 'dup-repo-b') { Ko "second repository's duplicate NOT skipped" } else { Ok "second repository's duplicate skipped (first wins)" }

  # --- Microsoft catalog with isolation off ------------------------------------
  # Launch resolution must use the effective ~/.pi/agent tree when isolation is
  # disabled: the catalog resolver (lib/microsoft_skills.py) is stubbed through a
  # python3 shim that prints the fixture generation dir; the launcher accepts it
  # only when it sits under <effective agent dir>\catalogs\microsoft\generations.
  Write-RawConfig '{"schema_version":1}'
  $msHome = Join-Path $t 'ms-home'
  $msBin = Join-Path $t 'ms-bin'
  $msPrefix = Join-Path (Join-Path $msHome '.pi\agent') 'catalogs\microsoft\generations'
  $msSkill = Join-Path $msPrefix 'fixture\skills\kql'
  New-Item -ItemType Directory -Force -Path $msBin, $msSkill | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $msSkill 'SKILL.md'), "---`nname: kql`n---`n# fixture`n")
  $realPy = (Get-Command python3 -ErrorAction SilentlyContinue)
  if (-not $realPy) { $realPy = (Get-Command python -ErrorAction SilentlyContinue) }
  if (-not $realPy) { Ko 'python3 unavailable for the Microsoft catalog fixture' }
  else {
    $env:COOP_TEST_MS_DIR = $msSkill
    $realPyPath = $realPy.Source
    [System.IO.File]::WriteAllText((Join-Path $msBin 'python3'), "#!/bin/sh`ncase `"`$*`" in *lib/microsoft_skills.py*) echo `"`$COOP_TEST_MS_DIR`"; exit 0 ;; esac`nexec '$realPyPath' `"`$@`"`n")
    [System.IO.File]::WriteAllText((Join-Path $msBin 'python3.cmd'), "@echo off`r`necho %* | findstr /C:`"microsoft_skills.py`" >nul`r`nif not errorlevel 1 (echo %COOP_TEST_MS_DIR%& exit /b 0)`r`n`"$realPyPath`" %*`r`nexit /b %errorlevel%`r`n")
    if (-not $isWindowsHost) { & $chmod +x (Join-Path $msBin 'python3') }
    $env:PATH = $msBin + [System.IO.Path]::PathSeparator + $env:PATH
    $env:HOME = $msHome; $env:USERPROFILE = $msHome
    $env:COOP_NO_ISOLATE = '1'
    Remove-Item Env:\PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
    $s = Invoke-Spec
    $env:PATH = $saved['PATH']
    $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome
    Remove-Item Env:\COOP_NO_ISOLATE -ErrorAction SilentlyContinue
    $want = ($msSkill -replace '\\', '/')
    $hit = $false
    for ($i = 0; $i -lt $s.Args.Count - 1; $i++) { if ($s.Args[$i] -eq '--skill' -and $s.Args[$i + 1] -eq $want) { $hit = $true } }
    if ($s.Rc -ne 0) { Ko 'non-isolated Microsoft catalog launch failed' $s.Err }
    elseif ($hit) { Ok 'non-isolated launch loads the Microsoft catalog from ~/.pi/agent' }
    else { Ko 'non-isolated launch omitted the Microsoft catalog skill' ($s.Out + "`n" + $s.Err) }
  }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  team-skills tests passed' } else { Write-Host "  $G_CROSS team-skills tests FAILED" }
exit $fail
