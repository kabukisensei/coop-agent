#!/usr/bin/env pwsh
# Prompt and skill tiers (master plan PR1), driven through
# `bin/coop.ps1 launch-spec --json` (Build-CoopPiArgs + Get-CoopResourceTiers),
# `scripts/doctor.ps1 --json` and the scaffold commands:
#   - a client's .coop\skills and .coop\prompts (beside the committed contract)
#     and the personal <profile>\skills and <profile>\prompts load, in the
#     order shipped, client, personal (one --prompt-template per tier)
#   - a name clash resolves shipped > client > personal: the shadowed skill is
#     skipped with a stderr warning, stdout stays clean JSON
#   - doctor's "Prompts and skills" section lists each tier and warns on every
#     shadowed skill or prompt
#   - outside a client contract there is no client tier (the bundled contract
#     is coop's own) and nothing changes in the launch arguments
#   - coop new-skill / new-prompt --client / --personal write into the tier
# Offline; every path is under a temp dir; COOP_DIR and HOME are sandboxed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path $root 'bin\coop.ps1'
$doctor = Join-Path $root 'scripts\doctor.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-tiers-' + [guid]::NewGuid().ToString('N'))
function Write-Skill([string]$Dir, [string]$Body) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Dir 'SKILL.md'), $Body, $utf8)
}
function Write-Prompt([string]$Dir, [string]$Name) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Dir "$Name.md"), "---`ndescription: $Name prompt`n---`n# $Name`n", $utf8)
}
# `coop <args>` with stdout and stderr captured separately, run from $Cwd.
function Invoke-Coop([string]$Cwd, [string[]]$CoopArgs) {
  $so = Join-Path $t 'out.txt'; $se = Join-Path $t 'err.txt'
  $p = Start-Process -FilePath $psExe -ArgumentList (@('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $coop + '"')) + $CoopArgs) -PassThru -NoNewWindow -WorkingDirectory $Cwd -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  $out = [System.IO.File]::ReadAllText($so); $err = [System.IO.File]::ReadAllText($se)
  $spec = $null; $specArgs = @()
  try { $spec = $out | ConvertFrom-Json; if ($spec -and $spec.args) { $specArgs = @($spec.args | ForEach-Object { ([string]$_) -replace '\\', '/' }) } } catch { $spec = $null }
  return @{ Rc = $p.ExitCode; Out = $out; Err = $err; Json = $spec; Args = $specArgs }
}
function Invoke-Spec([string]$Cwd) { return (Invoke-Coop $Cwd @('launch-spec', '--json')) }
function Test-HasArg([object]$Spec, [string]$Needle) { return [bool]@($Spec.Args | Where-Object { $_ -like "*$Needle*" }).Count }
# The values following every --prompt-template, in order.
function Get-PromptDirs([object]$Spec) {
  $dirs = @()
  for ($i = 0; $i -lt $Spec.Args.Count - 1; $i++) { if ($Spec.Args[$i] -eq '--prompt-template') { $dirs += $Spec.Args[$i + 1] } }
  return @($dirs)
}
function Get-TierRows([string]$Cwd) {
  Set-Location -LiteralPath $Cwd
  try { return @((Get-DoctorRows) | Where-Object { [string]$_.section -eq 'Prompts and skills' }) } finally { Set-Location -LiteralPath $savedLocation }
}
function Test-RowContains($Rows, [string]$Needle, [string]$Status = '') {
  (@($Rows | Where-Object { ([string]$_.name).Contains($Needle) -and (-not $Status -or [string]$_.status -eq $Status) })).Count -gt 0
}

$saved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_NO_ONBOARD', 'COOP_SKIP_AZ', 'COOP_SKIP_UPDATE_CHECK', 'NO_COLOR',
           'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT', 'PSModuleAnalysisCachePath')
$savedLocation = Get-Location
try {
  $cfg = Join-Path $t 'coop'
  $sandboxHome = Join-Path $t 'home'
  $agent = Join-Path $t 'agent'
  $client = Join-Path $t 'work\contoso'
  $plain = Join-Path $t 'work\no-contract'
  New-Item -ItemType Directory -Force -Path (Join-Path $cfg '.coop'), $sandboxHome, $agent, (Join-Path $client '.coop'), $plain | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = $cfg
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_SKIP_UPDATE_CHECK = '1'
  $env:NO_COLOR = '1'
  $env:PSModuleAnalysisCachePath = Join-Path $t 'ModuleAnalysisCache'
  foreach ($n in @('PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  [System.IO.File]::WriteAllText((Join-Path $cfg '.coop\config'), '{"schema_version":1}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $client '.coop\project.yml'), "schema_version: 1`nclient: Contoso`nrepositories: []`nfabric:`n  enabled: false`n", $utf8)

  $profileDir = Join-Path $cfg '.coop'
  # Client tier: one valid skill, one that clashes with a shipped folder
  # (azure-devops), one prompt, one prompt that clashes with a shipped one.
  Write-Skill (Join-Path $client '.coop\skills\contoso-naming') "---`nname: contoso-naming`ndescription: Contoso naming rules`n---`n# Contoso naming`n"
  Write-Skill (Join-Path $client '.coop\skills\azure-devops') "---`nname: azure-devops`ndescription: Clashes with the shipped folder`n---`n# Clash`n"
  Write-Prompt (Join-Path $client '.coop\prompts') 'contoso-release'
  Write-Prompt (Join-Path $client '.coop\prompts') 'daily-log'
  # Personal tier: one valid skill, one whose frontmatter name clashes with the
  # client skill, one prompt, one prompt that clashes with the client one.
  Write-Skill (Join-Path $profileDir 'skills\my-dataverse') "---`nname: my-dataverse`ndescription: Personal Dataverse notes`n---`n# Mine`n"
  Write-Skill (Join-Path $profileDir 'skills\naming-again') "---`nname: contoso-naming`ndescription: Clashes with the client skill by name`n---`n# Clash`n"
  Write-Prompt (Join-Path $profileDir 'prompts') 'my-standup'
  Write-Prompt (Join-Path $profileDir 'prompts') 'contoso-release'

  # --- launch-spec from the client repository ------------------------------
  $s = Invoke-Spec $client
  if ($s.Rc -ne 0) { Ko "launch-spec exited $($s.Rc)" $s.Err }
  if ($s.Json) { Ok 'launch-spec: stdout is valid JSON' } else { Ko 'stdout contaminated' $s.Out }
  if (Test-HasArg $s 'work/contoso/.coop/skills/contoso-naming') { Ok 'client skill loads (--skill .coop/skills/contoso-naming)' } else { Ko 'client skill missing' $s.Out }
  if (Test-HasArg $s 'work/contoso/.coop/skills/azure-devops') { Ko 'client azure-devops was NOT skipped (shipped must win)' $s.Out } else { Ok 'client skill clashing with a shipped folder is skipped' }
  if (Test-HasArg $s 'coop/.coop/skills/my-dataverse') { Ok 'personal skill loads (--skill <profile>/skills/my-dataverse)' } else { Ko 'personal skill missing' $s.Out }
  if (Test-HasArg $s 'coop/.coop/skills/naming-again') { Ko 'personal skill clashing with the client name was NOT skipped' $s.Out } else { Ok 'personal skill clashing with a client frontmatter name is skipped' }
  if ($s.Err.Contains("skipping client skill 'azure-devops'")) { Ok 'client clash warned on stderr' } else { Ko 'no client clash warning' $s.Err }
  if ($s.Err.Contains("skipping personal skill 'naming-again' (name 'contoso-naming'")) { Ok 'personal clash warned on stderr, naming the clashing name' } else { Ko 'no personal clash warning' $s.Err }
  # Order: shipped skills come before the client's, the client's before the personal.
  $skillArgs = @()
  for ($i = 0; $i -lt $s.Args.Count - 1; $i++) { if ($s.Args[$i] -eq '--skill') { $skillArgs += $s.Args[$i + 1] } }
  function Find-Index([string]$Pattern) { for ($j = 0; $j -lt $skillArgs.Count; $j++) { if ($skillArgs[$j] -like $Pattern) { return $j } }; return -1 }
  $iShipped = Find-Index '*/skills/azure-devops'
  $iClient = Find-Index '*/work/contoso/.coop/skills/contoso-naming'
  $iPersonal = Find-Index '*/coop/.coop/skills/my-dataverse'
  if ($iShipped -ge 0 -and $iShipped -lt $iClient -and $iClient -lt $iPersonal) { Ok 'skills are passed shipped, then client, then personal' } else { Ko "skill order: shipped=$iShipped client=$iClient personal=$iPersonal" ($skillArgs -join "`n") }
  $pd = Get-PromptDirs $s
  if ($pd.Count -eq 3 -and $pd[0] -like '*/prompts' -and $pd[0] -notlike '*/.coop/*' -and $pd[1] -like '*/work/contoso/.coop/prompts' -and $pd[2] -like '*/coop/.coop/prompts') { Ok 'three --prompt-template dirs: shipped, client, personal, in that order' } else { Ko 'prompt template dirs wrong' ($pd -join "`n") }

  # --- launch-spec outside any client contract -----------------------------
  $s2 = Invoke-Spec $plain
  if ($s2.Rc -ne 0) { Ko "launch-spec (no contract) exited $($s2.Rc)" $s2.Err }
  if (Test-HasArg $s2 'work/contoso/.coop') { Ko 'client tier leaked outside its repository' $s2.Out } else { Ok 'no client tier outside a client contract' }
  if (Test-HasArg $s2 'coop/.coop/skills/my-dataverse') { Ok 'personal skill still loads outside a client contract' } else { Ko 'personal skill missing without a contract' $s2.Out }
  $pd2 = Get-PromptDirs $s2
  if ($pd2.Count -eq 2) { Ok 'two --prompt-template dirs without a client contract (shipped, personal)' } else { Ko 'prompt template dirs without a contract' ($pd2 -join "`n") }

  # --- doctor: the tier section ---------------------------------------------
  $rows = Get-TierRows $client
  if ($rows.Count -gt 0) { Ok 'doctor has a "Prompts and skills" section' } else { Ko 'doctor section missing' }
  if (Test-RowContains $rows 'shipped tier:' 'ok') { Ok 'doctor lists the shipped tier' } else { Ko 'shipped tier row missing' ($rows | ConvertTo-Json -Depth 3) }
  if (Test-RowContains $rows 'client tier: 2 skill(s), 2 prompt(s)' 'ok') { Ok 'doctor counts the client tier' } else { Ko 'client tier row wrong' ($rows | ConvertTo-Json -Depth 3) }
  if (Test-RowContains $rows 'personal tier: 2 skill(s), 2 prompt(s)' 'ok') { Ok 'doctor counts the personal tier' } else { Ko 'personal tier row wrong' ($rows | ConvertTo-Json -Depth 3) }
  if (Test-RowContains $rows "client skill 'azure-devops' is not loaded: the shipped tier already has 'azure-devops'" 'warn') { Ok 'doctor warns on the client skill shadowed by a shipped one' } else { Ko 'client skill clash warning missing' ($rows | ConvertTo-Json -Depth 3) }
  if (Test-RowContains $rows "personal skill 'naming-again' is not loaded: the client tier already has 'contoso-naming'" 'warn') { Ok 'doctor warns on the personal skill shadowed by a client one' } else { Ko 'personal skill clash warning missing' ($rows | ConvertTo-Json -Depth 3) }
  if (Test-RowContains $rows "client prompt '/daily-log' is not loaded: the shipped tier already has it" 'warn') { Ok 'doctor warns on the client prompt shadowed by a shipped one' } else { Ko 'client prompt clash warning missing' ($rows | ConvertTo-Json -Depth 3) }
  if (Test-RowContains $rows "personal prompt '/contoso-release' is not loaded: the client tier already has it" 'warn') { Ok 'doctor warns on the personal prompt shadowed by a client one' } else { Ko 'personal prompt clash warning missing' ($rows | ConvertTo-Json -Depth 3) }
  $rowsPlain = Get-TierRows $plain
  if (Test-RowContains $rowsPlain 'client tier: no committed .coop/project.yml' 'ok') { Ok 'doctor says there is no client tier outside a contract' } else { Ko 'no-contract client row missing' ($rowsPlain | ConvertTo-Json -Depth 3) }

  # --- scaffolds into a tier -------------------------------------------------
  $r = Invoke-Coop $client @('new-prompt', 'contoso-handover', '--client')
  if ($r.Rc -eq 0 -and (Test-Path -LiteralPath (Join-Path $client '.coop\prompts\contoso-handover.md'))) { Ok 'coop new-prompt --client writes .coop/prompts/<name>.md beside the contract' } else { Ko 'new-prompt --client failed' ($r.Out + $r.Err) }
  $r = Invoke-Coop $client @('new-skill', 'my-notes', '--personal')
  if ($r.Rc -eq 0 -and (Test-Path -LiteralPath (Join-Path $profileDir 'skills\my-notes\SKILL.md'))) { Ok 'coop new-skill --personal writes <profile>/skills/<name>/SKILL.md' } else { Ko 'new-skill --personal failed' ($r.Out + $r.Err) }
  $r = Invoke-Coop $plain @('new-skill', 'orphan', '--client')
  if ($r.Rc -ne 0 -and -not (Test-Path -LiteralPath (Join-Path $root 'skills\orphan'))) { Ok 'coop new-skill --client outside a contract refuses (nothing written)' } else { Ko 'new-skill --client without a contract did not refuse' ($r.Out + $r.Err) }
  if ($r.Err.Contains('no committed .coop/project.yml')) { Ok 'the refusal names the missing contract' } else { Ko 'refusal text' $r.Err }
}
finally {
  Set-Location -LiteralPath $savedLocation
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  prompt-skill-tiers tests passed' } else { Write-Host "  $G_CROSS prompt-skill-tiers tests FAILED" }
exit $fail
