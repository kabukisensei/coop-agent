#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('Run','ValidateReceipt','Probe')][string]$Mode = 'Run',
  [string]$HarnessRoot = '',
  [string]$CandidateRoot = '',
  [string]$BaselineRoot = '',
  [string]$EvidenceRoot = '',
  [string]$ReceiptPath = '',
  [string]$ExpectedHarnessSha = '',
  [switch]$VmOperatorMode,
  [ValidateSet('ValidateSha','AssertEmptyRoot','HashTree','ScanCanary','EvaluateReadiness')][string]$Probe = 'ValidateSha',
  [string]$Value = '',
  [string]$Root = '',
  [string]$Canary = ''
)

$ErrorActionPreference = 'Stop'
$script:CandidateSha = '295693a3eb08e9988594971d87bc4de751e6b551'
$script:BaselineSha = 'd60300780b565aabf15b172b2bc32abad12b9ca6'
$script:AllowedStatuses = @('PASS','FAIL','BLOCKED','INCONCLUSIVE','NOT_REACHED','NOT_AVAILABLE','CAPABILITY_SKIP','BETA_LIMITATION')
$script:RequiredOperatorIds = @(
  'fresh-candidate-install',
  'real-provider-auth',
  'real-model-response',
  'copied-repo-workflow',
  'decline-no-partial-write',
  'stop-and-continue',
  'reopen-resume',
  'teamai-failure-isolation',
  'rollback-instructions',
  'snapshot-recovery'
)

function Test-StrictSha([string]$Sha) {
  return [bool]($Sha -cmatch '^[0-9a-f]{40}$')
}

function Assert-EmptyOwnedRoot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'owned root is required' }
  if (Test-Path -LiteralPath $Path) {
    throw "refusing occupied owned root: $Path"
  }
  New-Item -ItemType Directory -Path $Path | Out-Null
}

function Get-FileSha([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TreeHash([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "tree does not exist: $Path" }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $rows = New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath $resolved -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch '[\\/]\.git([\\/]|$)' } |
    Sort-Object FullName |
    ForEach-Object {
      $rel = $_.FullName.Substring($resolved.Length).TrimStart('\','/').Replace('\','/')
      $rows.Add("$rel`t$(Get-FileSha $_.FullName)")
    }
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllLines($tmp, $rows, (New-Object System.Text.UTF8Encoding($false)))
    return (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Find-Canary([string]$Path, [string]$Needle) {
  if (-not $Needle) { throw 'canary is required' }
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $hits = @()
  $files = if (Test-Path -LiteralPath $Path -PathType Leaf) { @(Get-Item -LiteralPath $Path) } else {
    @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
  }
  foreach ($file in $files) {
    try {
      $text = [System.IO.File]::ReadAllText($file.FullName)
      if ($text.Contains($Needle)) { $hits += $file.FullName }
    } catch { }
  }
  return @($hits)
}

function Assert-ExactProperties([object]$Object, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Object) { throw "$Label is required" }
  $actual = @($Object.PSObject.Properties.Name)
  foreach ($name in $Expected) {
    if ($actual -notcontains $name) { throw "$Label missing required property: $name" }
  }
  foreach ($name in $actual) {
    if ($Expected -notcontains $name) { throw "$Label contains unknown property: $name" }
  }
}

function Assert-Receipt([object]$Receipt) {
  Assert-ExactProperties $Receipt @('schema_version','candidate','baseline','harness','execution','claims','operator_evidence','terminal_workstation_ready') 'receipt'
  if ($null -eq $Receipt -or $Receipt.schema_version -ne 1) { throw 'receipt schema_version must be 1' }
  foreach ($pair in @(@('candidate',$script:CandidateSha), @('baseline',$script:BaselineSha))) {
    $identity = $Receipt.($pair[0])
    Assert-ExactProperties $identity @('sha','version') "$($pair[0]) identity"
    if ($null -eq $identity -or $identity.sha -cne $pair[1]) { throw "$($pair[0]) SHA mismatch" }
    if ([string]::IsNullOrWhiteSpace([string]$identity.version)) { throw "$($pair[0]) version is required" }
  }
  Assert-ExactProperties $Receipt.harness @('sha','version') 'harness identity'
  if ($null -eq $Receipt.harness -or -not (Test-StrictSha ([string]$Receipt.harness.sha))) { throw 'harness SHA must be exact 40-hex' }
  if ([string]::IsNullOrWhiteSpace([string]$Receipt.harness.version)) { throw 'harness version is required' }
  if ($Receipt.harness.sha -eq $Receipt.candidate.sha -or $Receipt.harness.sha -eq $Receipt.baseline.sha) {
    throw 'harness identity must remain distinct from product identities'
  }
  Assert-ExactProperties $Receipt.execution @('layer','runner','started_utc','finished_utc','owned_root') 'execution'
  if ($Receipt.execution.layer -notin @('AUTOMATED_WINDOWS','DISPOSABLE_VM_OPERATOR')) { throw 'invalid execution layer' }
  foreach ($name in @('runner','started_utc','finished_utc','owned_root')) {
    if ([string]::IsNullOrWhiteSpace([string]$Receipt.execution.$name)) { throw "execution.$name is required" }
  }
  if ($null -eq $Receipt.terminal_workstation_ready -or $Receipt.terminal_workstation_ready -isnot [bool]) { throw 'terminal_workstation_ready must be boolean' }
  if ($null -eq $Receipt.claims) { throw 'claims are required' }
  foreach ($claim in @($Receipt.claims) + @($Receipt.operator_evidence)) {
    Assert-ExactProperties $claim @('id','phase','status','required','automated','human_required','summary','evidence') "claim $($claim.id)"
    if ($null -eq $claim -or $script:AllowedStatuses -notcontains [string]$claim.status) { throw "invalid evidence status: $($claim.status)" }
    if (-not $claim.id -or -not $claim.summary) { throw 'every claim requires id and summary' }
    if ($claim.phase -notin @('PRECHECK','BASELINE','UPGRADE','REINSTALL','ROLLBACK','SECURITY','OPERATOR')) { throw "invalid claim phase: $($claim.phase)" }
    foreach ($name in @('required','automated','human_required')) {
      if ($claim.$name -isnot [bool]) { throw "claim $($claim.id) property $name must be boolean" }
    }
    foreach ($e in @($claim.evidence)) {
      Assert-ExactProperties $e @('kind','observed','command','exit_code','identity','path','sha256') "claim $($claim.id) evidence"
      if (-not $e.observed -or $null -eq $e.exit_code -and $e.kind -eq 'COMMAND') { throw "claim $($claim.id) has incomplete observed evidence" }
      if ($e.kind -notin @('COMMAND','HASH','FILE','OPERATOR_OBSERVATION')) { throw "claim $($claim.id) has invalid evidence kind" }
      if ([string]$e.identity -notmatch '^(harness|candidate|baseline|operator)(:[0-9a-f]{40})?$') { throw "claim $($claim.id) has invalid evidence identity" }
      if ($e.sha256 -and [string]$e.sha256 -notmatch '^[0-9a-f]{64}$') { throw "claim $($claim.id) has invalid evidence SHA-256" }
    }
  }
  foreach ($claim in @($Receipt.operator_evidence)) {
    if ($claim.phase -ne 'OPERATOR' -or [bool]$claim.automated -or -not [bool]$claim.human_required) { throw "operator evidence flags invalid: $($claim.id)" }
  }
  if ([bool]$Receipt.terminal_workstation_ready) {
    if ($Receipt.execution.layer -ne 'DISPOSABLE_VM_OPERATOR') { throw 'automated Windows evidence can never set TERMINAL_WORKSTATION_READY' }
    foreach ($claim in @($Receipt.claims)) {
      if ([bool]$claim.required -and [bool]$claim.automated -and $claim.status -ne 'PASS') {
        throw "required automated claim is not PASS: $($claim.id)"
      }
    }
    foreach ($id in $script:RequiredOperatorIds) {
      $matches = @($Receipt.operator_evidence | Where-Object { $_.id -eq $id })
      if ($matches.Count -ne 1 -or $matches[0].status -ne 'PASS') { throw "required human evidence is not PASS: $id" }
      if ([bool]$matches[0].automated -or -not [bool]$matches[0].human_required) { throw "human evidence flags invalid: $id" }
      $observations = @($matches[0].evidence | Where-Object { $_.kind -eq 'OPERATOR_OBSERVATION' -and $_.observed })
      if ($observations.Count -lt 1) { throw "redacted operator observation missing: $id" }
    }
  }
  return $true
}

function Read-Receipt([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "receipt not found: $Path" }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Invoke-Bounded {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$LogBase,
    [int]$TimeoutSeconds = 1800,
    [string]$InputPath = ''
  )
  $stdout = "$LogBase.stdout.txt"
  $stderr = "$LogBase.stderr.txt"
  $quoted = @()
  foreach ($arg in $Arguments) { $quoted += ('"' + ([string]$arg).Replace('"','\"') + '"') }
  $params = @{
    FilePath = $FilePath
    ArgumentList = ($quoted -join ' ')
    PassThru = $true
    NoNewWindow = $true
    RedirectStandardOutput = $stdout
    RedirectStandardError = $stderr
  }
  if ($InputPath) { $params['RedirectStandardInput'] = $InputPath }
  $process = Start-Process @params
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { & taskkill.exe /PID $process.Id /T /F *> $null } catch { try { $process.Kill() } catch { } }
    throw "command timed out after $TimeoutSeconds seconds: $FilePath"
  }
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function New-Evidence([string]$Kind, [string]$Observed, [string]$Command, [object]$ExitCode, [string]$Identity, [string]$Path = '') {
  return [ordered]@{
    kind = $Kind
    observed = $Observed
    command = $Command
    exit_code = $ExitCode
    identity = $Identity
    path = $Path
    sha256 = if ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf)) { Get-FileSha $Path } else { '' }
  }
}

function New-Claim([string]$Id, [string]$Phase, [string]$Status, [bool]$Required, [bool]$Automated, [bool]$HumanRequired, [string]$Summary, [array]$Evidence = @()) {
  return [ordered]@{
    id = $Id; phase = $Phase; status = $Status; required = $Required
    automated = $Automated; human_required = $HumanRequired; summary = $Summary
    evidence = @($Evidence)
  }
}

function Assert-ExitZero([object]$Result, [string]$Label) {
  if ($Result.ExitCode -ne 0) { throw "$Label exited $($Result.ExitCode); inspect $($Result.Stderr)" }
}

if ($Mode -eq 'Probe') {
  switch ($Probe) {
    'ValidateSha' { if (-not (Test-StrictSha $Value)) { throw 'invalid strict SHA' }; Write-Output 'PASS' }
    'AssertEmptyRoot' { Assert-EmptyOwnedRoot $Root; Write-Output 'PASS' }
    'HashTree' { Write-Output (Get-TreeHash $Root) }
    'ScanCanary' { $hits = @(Find-Canary $Root $Canary); if ($hits.Count -gt 0) { throw "credential canary found in evidence" }; Write-Output 'PASS' }
    'EvaluateReadiness' { $receipt = Read-Receipt $ReceiptPath; Assert-Receipt $receipt | Out-Null; Write-Output ([bool]$receipt.terminal_workstation_ready).ToString().ToLowerInvariant() }
  }
  exit 0
}

if ($Mode -eq 'ValidateReceipt') {
  $receipt = Read-Receipt $ReceiptPath
  Assert-Receipt $receipt | Out-Null
  Write-Output 'receipt valid'
  exit 0
}

$started = (Get-Date).ToUniversalTime().ToString('o')
$claims = New-Object System.Collections.ArrayList
$operator = New-Object System.Collections.ArrayList
$harnessSha = ''
$ownedRoot = ''
$runFailure = $null

try {
  if ($env:OS -ne 'Windows_NT') { throw 'native Windows is required' }
  if (-not $VmOperatorMode) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
      throw 'refusing workstation-like/local execution; use an approved disposable VM with -VmOperatorMode'
    }
  }
  if (-not (Test-StrictSha $ExpectedHarnessSha)) { throw 'ExpectedHarnessSha must be exact 40-hex' }
  foreach ($path in @($HarnessRoot,$CandidateRoot,$BaselineRoot)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "checkout missing: $path" }
  }
  $harnessSha = (& git -C $HarnessRoot rev-parse HEAD).Trim()
  $candidateSha = (& git -C $CandidateRoot rev-parse HEAD).Trim()
  $baselineSha = (& git -C $BaselineRoot rev-parse HEAD).Trim()
  if ($harnessSha -cne $ExpectedHarnessSha) { throw "harness SHA mismatch: $harnessSha" }
  if ($candidateSha -cne $script:CandidateSha) { throw "candidate SHA mismatch: $candidateSha" }
  if ($baselineSha -cne $script:BaselineSha) { throw "baseline SHA mismatch: $baselineSha" }
  if ($harnessSha -eq $candidateSha -or $harnessSha -eq $baselineSha) { throw 'harness checkout must be distinct from product checkouts' }

  if (-not $EvidenceRoot) { throw 'EvidenceRoot is required' }
  $ownedRoot = Split-Path -Parent $EvidenceRoot
  Assert-EmptyOwnedRoot $ownedRoot
  New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
  $logs = Join-Path $EvidenceRoot 'logs'; New-Item -ItemType Directory -Path $logs | Out-Null
  $profileRoot = Join-Path $ownedRoot 'profile'
  $npmRoot = Join-Path $ownedRoot 'npm-global'
  $pipxHome = Join-Path $ownedRoot 'pipx-home'
  $pipxBin = Join-Path $ownedRoot 'pipx-bin'
  $localApp = Join-Path $ownedRoot 'local-app-data'
  $roaming = Join-Path $ownedRoot 'roaming-app-data'
  $agentRoot = Join-Path $ownedRoot 'coop-agent-profile'
  foreach ($d in @($profileRoot,$npmRoot,$pipxHome,$pipxBin,$localApp,$roaming,$agentRoot)) { New-Item -ItemType Directory -Path $d | Out-Null }

  $env:HOME = $profileRoot
  $env:USERPROFILE = $profileRoot
  $env:HOMEDRIVE = (Split-Path -Qualifier $profileRoot)
  $env:HOMEPATH = $profileRoot.Substring($env:HOMEDRIVE.Length)
  $env:LOCALAPPDATA = $localApp
  $env:APPDATA = $roaming
  $env:COOP_DIR = $profileRoot
  $env:COOP_AGENT_DIR = $agentRoot
  $env:PIPX_HOME = $pipxHome
  $env:PIPX_BIN_DIR = $pipxBin
  $env:npm_config_prefix = $npmRoot
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_NO_MODEL_LOGIN = '1'
  $env:COOP_ASSUME_YES = '1'
  $env:PATH = "$npmRoot;$pipxBin;$(Join-Path $localApp 'coop\bin');$($env:PATH)"

  [void]$claims.Add((New-Claim 'identity-and-isolation' 'PRECHECK' 'PASS' $true $true $false 'Harness, candidate, and baseline identities are exact and owned roots were initially absent.' @(
    (New-Evidence 'COMMAND' "harness=$harnessSha candidate=$candidateSha baseline=$baselineSha" 'git rev-parse HEAD (three separate checkouts)' 0 "harness:$harnessSha")
  )))

  $sentinel = Join-Path $npmRoot 'unrelated-owner.sentinel'
  [System.IO.File]::WriteAllText($sentinel, 'not-owned-by-coop' + [Environment]::NewLine)
  $sentinelBefore = Get-FileSha $sentinel

  $installArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\install.ps1'),'--yes','--no-prereqs')
  $r = Invoke-Bounded 'powershell.exe' $installArgs (Join-Path $logs 'baseline-install') 2700
  Assert-ExitZero $r 'baseline source install'
  $doctorBase = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\doctor.ps1'),'--json') (Join-Path $logs 'baseline-doctor') 600
  Assert-ExitZero $doctorBase 'baseline doctor'
  $doctorBaseJson = Get-Content -LiteralPath $doctorBase.Stdout -Raw | ConvertFrom-Json
  if ($doctorBaseJson.fail -ne 0) { throw 'baseline Doctor JSON contains required failures' }

  $answers = Join-Path $ownedRoot 'onboard-input.txt'
  [System.IO.File]::WriteAllText($answers, "Acceptance Operator`n2`nn`nn`n", (New-Object System.Text.UTF8Encoding($false)))
  $onboard = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'bin\coop.ps1'),'onboard','--json') (Join-Path $logs 'baseline-onboard') 300 $answers
  Assert-ExitZero $onboard 'baseline supported onboarding'
  Remove-Item -LiteralPath $answers -Force

  $fixtureRepo = Join-Path $ownedRoot 'representative-repo'
  New-Item -ItemType Directory -Path $fixtureRepo | Out-Null
  & git -C $fixtureRepo init --quiet
  [System.IO.File]::WriteAllText((Join-Path $fixtureRepo 'model.sql'), "select 1 as acceptance_value;`n")
  & git -C $fixtureRepo add model.sql
  & git -C $fixtureRepo -c user.name=Acceptance -c user.email=acceptance@example.invalid commit --quiet -m fixture
  $init = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'bin\coop.ps1'),'init','--template',$fixtureRepo,'--yes') (Join-Path $logs 'baseline-project-init') 300
  Assert-ExitZero $init 'supported project initialization'

  $eventsDir = Join-Path $profileRoot '.coop\support'; New-Item -ItemType Directory -Force -Path $eventsDir | Out-Null
  $canary = ('COOP' + '-ACCEPTANCE-CANARY-' + [guid]::NewGuid().ToString('N'))
  $event = [ordered]@{ event = 'acceptance-probe'; config = [ordered]@{ api_key = $canary; note = 'redaction probe' } } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $eventsDir 'events.jsonl'), $event + "`n")
  $baselineSupportPath = Join-Path $EvidenceRoot 'support-baseline.json'
  # Support Center's COOP_DIR contract is the .coop directory itself, while the
  # launcher/onboarding contract treats COOP_DIR as its parent. Scope this
  # product-defined distinction to Support invocations instead of duplicating
  # or moving profile state.
  $profileParentForCommands = $env:COOP_DIR
  $env:COOP_DIR = Join-Path $profileRoot '.coop'
  $supportBase = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'bin\coop.ps1'),'support','--export',$baselineSupportPath) (Join-Path $logs 'baseline-support') 300
  $env:COOP_DIR = $profileParentForCommands
  Assert-ExitZero $supportBase 'baseline Support'
  if (@(Find-Canary $baselineSupportPath $canary).Count -gt 0) { throw 'Support exported planted credential canary' }

  $profileStateFiles = @(
    (Join-Path $profileRoot '.coop\user.json'),
    (Join-Path $profileRoot '.coop\config'),
    (Join-Path $profileRoot '.coop\agent\mcp.json'),
    (Join-Path $fixtureRepo '.coop\project.yml')
  )
  $stateBefore = @{}
  foreach ($file in $profileStateFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "realistic state missing after baseline exercise: $file" }
    $stateBefore[$file] = Get-FileSha $file
  }
  $repoBefore = Get-TreeHash $fixtureRepo
  [void]$claims.Add((New-Claim 'baseline-source-install' 'BASELINE' 'PASS' $true $true $false 'Actual v0.23.1 source install, Doctor, Support, onboarding, and project initialization completed.' @(
    (New-Evidence 'COMMAND' 'baseline install exited 0' '.\scripts\install.ps1 --yes --no-prereqs' $r.ExitCode "baseline:$baselineSha" $r.Stdout),
    (New-Evidence 'COMMAND' 'Doctor fail count 0' '.\scripts\doctor.ps1 --json' $doctorBase.ExitCode "baseline:$baselineSha" $doctorBase.Stdout),
    (New-Evidence 'FILE' 'baseline Support bundle exported with canary redacted' 'coop support --export <owned-path>' $supportBase.ExitCode "baseline:$baselineSha" $baselineSupportPath)
  )))

  $candidateInstall = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'candidate-upgrade-install') 2700
  Assert-ExitZero $candidateInstall 'candidate source upgrade install'
  foreach ($file in $profileStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "preserved state changed during candidate upgrade: $file" } }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'representative repository mutated merely due to candidate upgrade' }

  $candidateDoctor = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'scripts\doctor.ps1'),'--json') (Join-Path $logs 'candidate-doctor') 600
  Assert-ExitZero $candidateDoctor 'candidate Doctor'
  $candidateDoctorJson = Get-Content -LiteralPath $candidateDoctor.Stdout -Raw | ConvertFrom-Json
  if ($candidateDoctorJson.fail -ne 0) { throw 'candidate Doctor JSON contains required failures' }
  $candidateSupportPath = Join-Path $EvidenceRoot 'support-candidate.json'
  $env:COOP_DIR = Join-Path $profileRoot '.coop'
  $candidateSupport = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'support','--json') (Join-Path $logs 'candidate-support') 300
  $env:COOP_DIR = $profileParentForCommands
  Assert-ExitZero $candidateSupport 'candidate Support'
  Copy-Item -LiteralPath $candidateSupport.Stdout -Destination $candidateSupportPath
  $supportJson = Get-Content -LiteralPath $candidateSupportPath -Raw | ConvertFrom-Json
  if ([string]$supportJson.versions.coopBuild -notmatch '^build-[0-9a-f]{8}$') { throw 'candidate Support build identity is unavailable or malformed' }

  $manifest = Get-Content -LiteralPath (Join-Path $CandidateRoot 'config\release-manifest.json') -Raw | ConvertFrom-Json
  foreach ($pin in @('coop-data-doc','coop-sql-review','coop-dax-review')) {
    $expected = $manifest.python_tools.$pin
    $check = @($candidateDoctorJson.checks | Where-Object { $_.name -like "$pin $expected matches manifest*" })
    if ($check.Count -lt 1) { throw "Doctor did not prove candidate pin for $pin==$expected" }
  }
  $launchSpec = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'launch-spec','--json') (Join-Path $logs 'candidate-launch-spec') 300
  Assert-ExitZero $launchSpec 'candidate launch-spec'
  Get-Content -LiteralPath $launchSpec.Stdout -Raw | ConvertFrom-Json | Out-Null
  $dataDocHelp = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'data-doc','--help') (Join-Path $logs 'candidate-data-doc-help') 300
  Assert-ExitZero $dataDocHelp 'candidate data-doc command'

  [void]$claims.Add((New-Claim 'candidate-upgrade-preservation' 'UPGRADE' 'PASS' $true $true $false 'Candidate source install converged the existing profile without changing profile/project fixtures.' @(
    (New-Evidence 'COMMAND' 'candidate install exited 0 over baseline state' '.\scripts\install.ps1 --yes --no-prereqs' $candidateInstall.ExitCode "candidate:$candidateSha" $candidateInstall.Stdout),
    (New-Evidence 'HASH' "representative repo hash remained $repoBefore" 'deterministic content hash excluding .git' 0 "candidate:$candidateSha")
  )))
  [void]$claims.Add((New-Claim 'candidate-health-and-tools' 'UPGRADE' 'PASS' $true $true $false 'Doctor, Support identity, governed launch spec, data-doc command, and manifest tool pins were observed.' @(
    (New-Evidence 'COMMAND' "Doctor fail count 0; Support $($supportJson.versions.coopBuild)" '.\scripts\doctor.ps1 --json; coop support --json' 0 "candidate:$candidateSha" $candidateSupportPath),
    (New-Evidence 'COMMAND' 'data-doc command help exited 0' 'coop data-doc --help' $dataDocHelp.ExitCode "candidate:$candidateSha" $dataDocHelp.Stdout)
  )))

  $reinstall = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'candidate-reinstall') 2700
  Assert-ExitZero $reinstall 'same-candidate reinstall'
  foreach ($file in $profileStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during same-candidate reinstall: $file" } }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'repository changed during same-candidate reinstall' }
  [void]$claims.Add((New-Claim 'same-candidate-reinstall' 'REINSTALL' 'PASS' $true $true $false 'Same-candidate reinstall was idempotent for exercised state and the fixture repository.' @(
    (New-Evidence 'COMMAND' 'same-candidate reinstall exited 0' '.\scripts\install.ps1 --yes --no-prereqs' $reinstall.ExitCode "candidate:$candidateSha" $reinstall.Stdout)
  )))

  $rollback = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'baseline-rollback') 2700
  Assert-ExitZero $rollback 'v0.23.1 source rollback'
  foreach ($file in $profileStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during rollback: $file" } }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'repository changed during rollback' }
  if ((Get-FileSha $sentinel) -ne $sentinelBefore) { throw 'unrelated tool sentinel changed during install/reinstall/rollback' }
  $rollbackDoctor = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\doctor.ps1'),'--json') (Join-Path $logs 'rollback-doctor') 600
  Assert-ExitZero $rollbackDoctor 'rollback Doctor'
  [void]$claims.Add((New-Claim 'baseline-rollback-preservation' 'ROLLBACK' 'PASS' $true $true $false 'Actual baseline source install restored baseline pins without wiping state, project data, or unrelated sentinel.' @(
    (New-Evidence 'COMMAND' 'rollback install and Doctor exited 0' '.\scripts\install.ps1 --yes --no-prereqs; .\scripts\doctor.ps1 --json' 0 "baseline:$baselineSha" $rollbackDoctor.Stdout),
    (New-Evidence 'HASH' "unrelated sentinel remained $sentinelBefore" 'SHA-256 before/after' 0 "baseline:$baselineSha" $sentinel)
  )))

  $sourceStatusCandidate = (& git -C $CandidateRoot status --porcelain --untracked-files=all | Out-String).Trim()
  $sourceStatusBaseline = (& git -C $BaselineRoot status --porcelain --untracked-files=all | Out-String).Trim()
  if ($sourceStatusCandidate -or $sourceStatusBaseline) { throw 'immutable candidate or baseline checkout was mutated' }
  $canaryHits = @(Find-Canary $EvidenceRoot $canary)
  if ($canaryHits.Count -gt 0) { throw 'credential canary found in uploadable evidence' }
  [void]$claims.Add((New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'PASS' $true $true $false 'Product checkouts remained clean and the planted credential canary was absent from uploadable evidence.' @(
    (New-Evidence 'COMMAND' 'both source checkouts clean; canary scan had zero hits' 'git status --porcelain; exact canary scan' 0 "harness:$harnessSha")
  )))
} catch {
  $runFailure = $_.Exception.Message
  [void]$claims.Add((New-Claim 'automated-harness-completion' 'SECURITY' 'FAIL' $true $true $false "Automated harness failed closed: $runFailure" @(
    (New-Evidence 'COMMAND' 'harness terminated before all required claims passed' 'acceptance/windows-terminal-workstation.ps1 -Mode Run' 1 $(if ($harnessSha) { "harness:$harnessSha" } else { 'harness' }))
  )))
} finally {
  foreach ($id in $script:RequiredOperatorIds) {
    [void]$operator.Add((New-Claim $id 'OPERATOR' 'NOT_REACHED' $true $false $true 'Must be completed by a human in a snapshot-capable disposable Windows VM; CI makes no claim.' @()))
  }
  if (-not $harnessSha -and (Test-StrictSha $ExpectedHarnessSha)) { $harnessSha = $ExpectedHarnessSha }
  if (-not $harnessSha) { $harnessSha = '0000000000000000000000000000000000000000' }
  $receipt = [ordered]@{
    schema_version = 1
    candidate = [ordered]@{ sha = $script:CandidateSha; version = '0.23.1-candidate' }
    baseline = [ordered]@{ sha = $script:BaselineSha; version = 'v0.23.1-source' }
    harness = [ordered]@{ sha = $harnessSha; version = 'workstation-acceptance-harness' }
    execution = [ordered]@{
      layer = 'AUTOMATED_WINDOWS'
      runner = if ($env:RUNNER_NAME) { $env:RUNNER_NAME } else { [Environment]::MachineName }
      started_utc = $started
      finished_utc = (Get-Date).ToUniversalTime().ToString('o')
      owned_root = $ownedRoot
    }
    claims = @($claims)
    operator_evidence = @($operator)
    terminal_workstation_ready = $false
  }
  if ($ReceiptPath) {
    $parent = Split-Path -Parent $ReceiptPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.File]::WriteAllText($ReceiptPath, ($receipt | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
  }
}

if ($runFailure) { Write-Error $runFailure; exit 1 }
Assert-Receipt (Read-Receipt $ReceiptPath) | Out-Null
Write-Output "automated receipt: $ReceiptPath"
Write-Output 'TERMINAL_WORKSTATION_READY=false (human disposable-VM evidence remains mandatory)'
exit 0
