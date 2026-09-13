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
  [ValidateSet('ValidateSha','AssertEmptyRoot','HashTree','ScanCanary','EvaluateReadiness','VerifySupportBuild','VerifyDoctorPins')][string]$Probe = 'ValidateSha',
  [string]$Value = '',
  [string]$Root = '',
  [string]$Canary = ''
)

$ErrorActionPreference = 'Stop'
$script:CandidateSha = '295693a3eb08e9988594971d87bc4de751e6b551'
$script:BaselineSha = 'd60300780b565aabf15b172b2bc32abad12b9ca6'
$script:AllowedStatuses = @('PASS','FAIL','BLOCKED','INCONCLUSIVE','NOT_REACHED','NOT_AVAILABLE','CAPABILITY_SKIP','BETA_LIMITATION')
$script:CandidateSupportBuild = 'build-24297cf9'
$script:RequiredAutomatedIds = @(
  'identity-and-isolation',
  'baseline-source-install',
  'candidate-upgrade-preservation',
  'candidate-health-and-tools',
  'same-candidate-reinstall',
  'baseline-rollback-preservation',
  'sanitized-read-only-evidence'
)
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
    } catch { throw "canary scan could not read artifact: $($file.FullName)" }
  }
  return @($hits)
}

function Test-DateTimeText([string]$Text) {
  if ($text -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$') { return $false }
  try { [void][datetimeoffset]::Parse($text, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind); return $true } catch { return $false }
}

function Test-DateTime([object]$Value) {
  if ($Value -is [datetime] -or $Value -is [datetimeoffset]) { return $true }
  return Test-DateTimeText ([string]$Value)
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

function Assert-ObservedIdentity([object]$Identity, [string]$Label, [string]$ExpectedSha, [bool]$Ready) {
  Assert-ExactProperties $Identity @('expected_sha','observed_sha','expected_version','observed_version') "$Label identity"
  if ([string]$Identity.expected_sha -cne $ExpectedSha) { throw "$Label expected SHA mismatch" }
  if ([string]::IsNullOrWhiteSpace([string]$Identity.expected_version)) { throw "$Label expected version is required" }
  if ($null -ne $Identity.observed_sha -and -not (Test-StrictSha ([string]$Identity.observed_sha))) { throw "$Label observed SHA must be exact 40-hex or null" }
  if ($null -ne $Identity.observed_version -and [string]::IsNullOrWhiteSpace([string]$Identity.observed_version)) { throw "$Label observed version must be non-empty or null" }
  if ($Ready -and ([string]$Identity.observed_sha -cne $ExpectedSha -or [string]::IsNullOrWhiteSpace([string]$Identity.observed_version))) {
    throw "$Label observed identity does not match the required build"
  }
}

function Assert-DoctorManifestPins([object]$Doctor, [object]$Manifest, [string]$Label) {
  if ($null -eq $Doctor -or $Doctor.fail -ne 0 -or $null -eq $Doctor.checks) { throw "$Label Doctor JSON is incomplete or failing" }
  foreach ($pin in @('coop-data-doc','coop-sql-review','coop-dax-review')) {
    $expected = [string]$Manifest.python_tools.$pin
    if ([string]::IsNullOrWhiteSpace($expected)) { throw "$Label manifest pin missing: $pin" }
    $prefix = "$pin $expected matches manifest ($expected)"
    $matches = @($Doctor.checks | Where-Object { $_.status -eq 'ok' -and ([string]$_.name -eq $prefix -or [string]$_.name -eq "$prefix (CLI-reported; pipx metadata unreadable)") })
    if ($matches.Count -ne 1) { throw "$Label Doctor did not prove exact manifest pin: $pin==$expected" }
  }
}

function Assert-Receipt([object]$Receipt) {
  Assert-ExactProperties $Receipt @('schema_version','candidate','baseline','harness','execution','claims','operator_evidence','terminal_workstation_ready') 'receipt'
  if ($null -eq $Receipt -or $Receipt.schema_version -ne 1) { throw 'receipt schema_version must be 1' }
  if ($null -eq $Receipt.terminal_workstation_ready -or $Receipt.terminal_workstation_ready -isnot [bool]) { throw 'terminal_workstation_ready must be boolean' }
  $ready = [bool]$Receipt.terminal_workstation_ready
  Assert-ObservedIdentity $Receipt.candidate 'candidate' $script:CandidateSha $ready
  Assert-ObservedIdentity $Receipt.baseline 'baseline' $script:BaselineSha $ready
  Assert-ExactProperties $Receipt.harness @('observed_sha','observed_version') 'harness identity'
  if ($null -ne $Receipt.harness.observed_sha -and -not (Test-StrictSha ([string]$Receipt.harness.observed_sha))) { throw 'harness observed_sha must be exact 40-hex or null' }
  if ($Receipt.harness.observed_sha -eq $script:CandidateSha -or $Receipt.harness.observed_sha -eq $script:BaselineSha) { throw 'harness identity must remain distinct from product identities' }
  if ($null -ne $Receipt.harness.observed_version -and [string]::IsNullOrWhiteSpace([string]$Receipt.harness.observed_version)) { throw 'harness observed_version must be non-empty or null' }
  if ($ready) {
    if (-not (Test-StrictSha ([string]$Receipt.harness.observed_sha))) { throw 'harness observed SHA is required for readiness' }
    if ([string]::IsNullOrWhiteSpace([string]$Receipt.harness.observed_version)) { throw 'harness observed version is required for readiness' }

  }
  Assert-ExactProperties $Receipt.execution @('layer','runner','started_utc','finished_utc','owned_root') 'execution'
  if ($Receipt.execution.layer -notin @('AUTOMATED_WINDOWS','DISPOSABLE_VM_OPERATOR')) { throw 'invalid execution layer' }
  if ([string]::IsNullOrWhiteSpace([string]$Receipt.execution.runner)) { throw 'execution.runner is required' }
  foreach ($name in @('started_utc','finished_utc')) {
    if (-not (Test-DateTime $Receipt.execution.$name)) { throw "execution.$name must be RFC 3339 date-time" }
  }
  if ($null -ne $Receipt.execution.owned_root -and [string]::IsNullOrWhiteSpace([string]$Receipt.execution.owned_root)) { throw 'execution.owned_root must be non-empty or null' }
  if ($null -eq $Receipt.claims -or $null -eq $Receipt.operator_evidence) { throw 'claims and operator_evidence are required' }
  $allIds = @{}
  foreach ($claim in @($Receipt.claims) + @($Receipt.operator_evidence)) {
    Assert-ExactProperties $claim @('id','phase','status','required','automated','human_required','summary','evidence') "claim $($claim.id)"
    if ($null -eq $claim -or $script:AllowedStatuses -notcontains [string]$claim.status) { throw "invalid evidence status: $($claim.status)" }
    if ([string]$claim.id -cnotmatch '^[a-z0-9][a-z0-9-]*$' -or [string]::IsNullOrWhiteSpace([string]$claim.summary)) { throw 'every claim requires a valid id and summary' }
    if ($allIds.ContainsKey([string]$claim.id)) { throw "duplicate claim id: $($claim.id)" }; $allIds[[string]$claim.id] = $true
    if ($claim.phase -notin @('PRECHECK','BASELINE','UPGRADE','REINSTALL','ROLLBACK','SECURITY','OPERATOR')) { throw "invalid claim phase: $($claim.phase)" }
    foreach ($name in @('required','automated','human_required')) { if ($claim.$name -isnot [bool]) { throw "claim $($claim.id) property $name must be boolean" } }
    foreach ($e in @($claim.evidence)) {
      Assert-ExactProperties $e @('kind','observed','command','exit_code','identity','path','sha256') "claim $($claim.id) evidence"
      if ([string]::IsNullOrWhiteSpace([string]$e.observed)) { throw "claim $($claim.id) has incomplete observed evidence" }
      if ($e.kind -notin @('COMMAND','HASH','FILE','OPERATOR_OBSERVATION')) { throw "claim $($claim.id) has invalid evidence kind" }
      if ($e.kind -eq 'COMMAND' -and $e.exit_code -isnot [int] -and $e.exit_code -isnot [long]) { throw "claim $($claim.id) command evidence requires integer exit_code" }
      if ([string]$e.identity -cnotmatch '^(harness|candidate|baseline|operator)(:[0-9a-f]{40})?$') { throw "claim $($claim.id) has invalid evidence identity" }
      if ($e.sha256 -and [string]$e.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "claim $($claim.id) has invalid evidence SHA-256" }
    }
  }
  foreach ($claim in @($Receipt.claims)) {
    if (-not [bool]$claim.automated -or [bool]$claim.human_required -or $claim.phase -eq 'OPERATOR') { throw "automated claim flags invalid: $($claim.id)" }
    if ($claim.id -notin @($script:RequiredAutomatedIds + 'automated-harness-completion')) { throw "unknown automated claim id: $($claim.id)" }
  }
  foreach ($claim in @($Receipt.operator_evidence)) {
    if ($claim.phase -ne 'OPERATOR' -or [bool]$claim.automated -or -not [bool]$claim.human_required) { throw "operator evidence flags invalid: $($claim.id)" }
    if ($claim.id -notin $script:RequiredOperatorIds) { throw "unknown operator claim id: $($claim.id)" }
  }
  if ($ready) {
    if ($Receipt.execution.layer -ne 'DISPOSABLE_VM_OPERATOR') { throw 'automated Windows evidence can never set TERMINAL_WORKSTATION_READY' }
    if (@($Receipt.claims).Count -ne $script:RequiredAutomatedIds.Count) { throw 'ready receipt must contain exactly the required automated claims' }
    foreach ($id in $script:RequiredAutomatedIds) {
      $matches = @($Receipt.claims | Where-Object { $_.id -eq $id })
      if ($matches.Count -ne 1 -or $matches[0].status -ne 'PASS' -or -not [bool]$matches[0].required -or -not [bool]$matches[0].automated -or [bool]$matches[0].human_required) { throw "required automated claim is not uniquely PASS: $id" }
    }
    if (@($Receipt.operator_evidence).Count -ne $script:RequiredOperatorIds.Count) { throw 'ready receipt must contain exactly the required operator claims' }
    foreach ($id in $script:RequiredOperatorIds) {
      $matches = @($Receipt.operator_evidence | Where-Object { $_.id -eq $id })
      if ($matches.Count -ne 1 -or $matches[0].status -ne 'PASS' -or -not [bool]$matches[0].required) { throw "required human evidence is not uniquely PASS: $id" }
      $observations = @($matches[0].evidence | Where-Object { $_.kind -eq 'OPERATOR_OBSERVATION' -and -not [string]::IsNullOrWhiteSpace([string]$_.observed) })
      if ($observations.Count -lt 1) { throw "redacted operator observation missing: $id" }
    }
  }
  return $true
}

function Read-Receipt([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "receipt not found: $Path" }
  $raw = Get-Content -LiteralPath $Path -Raw
  foreach ($name in @('started_utc','finished_utc')) {
    $matches = [regex]::Matches($raw, ('"' + $name + '"\s*:\s*"([^"\\]*)"'))
    if ($matches.Count -ne 1 -or -not (Test-DateTimeText $matches[0].Groups[1].Value)) { throw "execution.$name must be an unescaped RFC 3339 date-time" }
  }
  return ($raw | ConvertFrom-Json)
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
    $treeKillSucceeded = $false
    try {
      & taskkill.exe /PID $process.Id /T /F *> $null
      $treeKillSucceeded = ($LASTEXITCODE -eq 0)
    } catch { }
    if (-not $treeKillSucceeded) { try { $process.Kill() } catch { } }
    if (-not $process.WaitForExit(10000) -or -not $process.HasExited) {
      throw "timed-out process tree could not be confirmed terminated: $FilePath"
    }
    throw "command timed out after $TimeoutSeconds seconds; process tree terminated: $FilePath"
  }
  $process.WaitForExit()
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
    'VerifySupportBuild' { if ($Value -cne $script:CandidateSupportBuild) { throw "candidate Support build mismatch: $Value" }; Write-Output 'PASS' }
    'VerifyDoctorPins' {
      $doctor = Get-Content -LiteralPath $Root -Raw | ConvertFrom-Json
      $manifest = Get-Content -LiteralPath $Value -Raw | ConvertFrom-Json
      Assert-DoctorManifestPins $doctor $manifest 'probe'
      Write-Output 'PASS'
    }
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
$harnessObservedSha = $null
$harnessObservedVersion = $null
$candidateObservedSha = $null
$candidateObservedVersion = $null
$baselineObservedSha = $null
$baselineObservedVersion = $null
$ownedRoot = if ($EvidenceRoot) { Split-Path -Parent $EvidenceRoot } else { $null }
$canary = ('COOP' + '-ACCEPTANCE-CANARY-' + [guid]::NewGuid().ToString('N'))
$runFailure = $null
$artifactsUploadable = $false

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
  $harnessObservedSha = (& git -C $HarnessRoot rev-parse HEAD).Trim()
  $candidateObservedSha = (& git -C $CandidateRoot rev-parse HEAD).Trim()
  $baselineObservedSha = (& git -C $BaselineRoot rev-parse HEAD).Trim()
  $harnessVersionPath = Join-Path $HarnessRoot 'VERSION'
  $candidateVersionPath = Join-Path $CandidateRoot 'VERSION'
  $baselineVersionPath = Join-Path $BaselineRoot 'VERSION'
  if (Test-Path -LiteralPath $harnessVersionPath -PathType Leaf) { $harnessObservedVersion = (Get-Content -LiteralPath $harnessVersionPath -Raw).Trim() }
  if (Test-Path -LiteralPath $candidateVersionPath -PathType Leaf) { $candidateObservedVersion = (Get-Content -LiteralPath $candidateVersionPath -Raw).Trim() }
  if (Test-Path -LiteralPath $baselineVersionPath -PathType Leaf) { $baselineObservedVersion = (Get-Content -LiteralPath $baselineVersionPath -Raw).Trim() }
  if ($harnessObservedSha -cne $ExpectedHarnessSha) { throw "harness SHA mismatch: $harnessObservedSha" }
  if ($candidateObservedSha -cne $script:CandidateSha) { throw "candidate SHA mismatch: $candidateObservedSha" }
  if ($baselineObservedSha -cne $script:BaselineSha) { throw "baseline SHA mismatch: $baselineObservedSha" }
  if ($harnessObservedSha -eq $candidateObservedSha -or $harnessObservedSha -eq $baselineObservedSha) { throw 'harness checkout must be distinct from product checkouts' }

  if (-not $EvidenceRoot) { throw 'EvidenceRoot is required' }
  if (-not $ReceiptPath) { throw 'ReceiptPath is required' }
  $evidenceFull = [System.IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\','/') + [System.IO.Path]::DirectorySeparatorChar
  $receiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
  if ($receiptFull.StartsWith($evidenceFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'ReceiptPath must be outside EvidenceRoot so a safe failure receipt can be retained' }
  Assert-EmptyOwnedRoot $ownedRoot
  New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
  $logs = Join-Path $EvidenceRoot 'logs'; New-Item -ItemType Directory -Path $logs | Out-Null
  $profileRoot = Join-Path $ownedRoot 'profile'
  $npmRoot = Join-Path $ownedRoot 'npm-global'
  $pipxHome = Join-Path $ownedRoot 'pipx-home'
  $pipxBin = Join-Path $ownedRoot 'pipx-bin'
  $localApp = Join-Path $ownedRoot 'local-app-data'
  $roaming = Join-Path $ownedRoot 'roaming-app-data'
  $agentRoot = Join-Path $profileRoot '.coop\agent'
  foreach ($d in @($profileRoot,$npmRoot,$pipxHome,$pipxBin,$localApp,$roaming,$agentRoot)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

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
    (New-Evidence 'COMMAND' "harness=$harnessObservedSha candidate=$candidateObservedSha baseline=$baselineObservedSha" 'git rev-parse HEAD (three separate checkouts)' 0 "harness:$harnessObservedSha")
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
    (Join-Path $agentRoot 'mcp.json'),
    (Join-Path $fixtureRepo '.coop\project.yml')
  )
  if ([System.IO.Path]::GetFullPath($env:COOP_AGENT_DIR) -ne [System.IO.Path]::GetFullPath((Join-Path $env:COOP_DIR '.coop\agent'))) { throw 'COOP_AGENT_DIR does not match the supported onboarding agent path' }
  $stateBefore = @{}
  foreach ($file in $profileStateFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "realistic state missing after baseline exercise: $file" }
    $stateBefore[$file] = Get-FileSha $file
  }
  $repoBefore = Get-TreeHash $fixtureRepo
  [void]$claims.Add((New-Claim 'baseline-source-install' 'BASELINE' 'PASS' $true $true $false 'Actual v0.23.1 source install, Doctor, Support, onboarding, and project initialization completed.' @(
    (New-Evidence 'COMMAND' 'baseline install exited 0' '.\scripts\install.ps1 --yes --no-prereqs' $r.ExitCode "baseline:$baselineObservedSha" $r.Stdout),
    (New-Evidence 'COMMAND' 'Doctor fail count 0' '.\scripts\doctor.ps1 --json' $doctorBase.ExitCode "baseline:$baselineObservedSha" $doctorBase.Stdout),
    (New-Evidence 'FILE' 'baseline Support bundle exported with canary redacted' 'coop support --export <owned-path>' $supportBase.ExitCode "baseline:$baselineObservedSha" $baselineSupportPath)
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
  if ([string]$supportJson.versions.coopBuild -cne $script:CandidateSupportBuild) { throw "candidate Support build identity mismatch: $($supportJson.versions.coopBuild)" }

  $manifest = Get-Content -LiteralPath (Join-Path $CandidateRoot 'config\release-manifest.json') -Raw | ConvertFrom-Json
  Assert-DoctorManifestPins $candidateDoctorJson $manifest 'candidate'
  $launchSpec = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'launch-spec','--json') (Join-Path $logs 'candidate-launch-spec') 300
  Assert-ExitZero $launchSpec 'candidate launch-spec'
  Get-Content -LiteralPath $launchSpec.Stdout -Raw | ConvertFrom-Json | Out-Null
  $dataDocHelp = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'data-doc','--help') (Join-Path $logs 'candidate-data-doc-help') 300
  Assert-ExitZero $dataDocHelp 'candidate data-doc command'

  [void]$claims.Add((New-Claim 'candidate-upgrade-preservation' 'UPGRADE' 'PASS' $true $true $false 'Candidate source install converged the existing profile without changing profile/project fixtures.' @(
    (New-Evidence 'COMMAND' 'candidate install exited 0 over baseline state' '.\scripts\install.ps1 --yes --no-prereqs' $candidateInstall.ExitCode "candidate:$candidateObservedSha" $candidateInstall.Stdout),
    (New-Evidence 'HASH' "representative repo hash remained $repoBefore" 'deterministic content hash excluding .git' 0 "candidate:$candidateObservedSha")
  )))
  [void]$claims.Add((New-Claim 'candidate-health-and-tools' 'UPGRADE' 'PASS' $true $true $false 'Doctor, Support identity, governed launch spec, data-doc command, and manifest tool pins were observed.' @(
    (New-Evidence 'COMMAND' "Doctor fail count 0; Support $($supportJson.versions.coopBuild)" '.\scripts\doctor.ps1 --json; coop support --json' 0 "candidate:$candidateObservedSha" $candidateSupportPath),
    (New-Evidence 'COMMAND' 'data-doc command help exited 0' 'coop data-doc --help' $dataDocHelp.ExitCode "candidate:$candidateObservedSha" $dataDocHelp.Stdout)
  )))

  $reinstall = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'candidate-reinstall') 2700
  Assert-ExitZero $reinstall 'same-candidate reinstall'
  foreach ($file in $profileStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during same-candidate reinstall: $file" } }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'repository changed during same-candidate reinstall' }
  [void]$claims.Add((New-Claim 'same-candidate-reinstall' 'REINSTALL' 'PASS' $true $true $false 'Same-candidate reinstall was idempotent for exercised state and the fixture repository.' @(
    (New-Evidence 'COMMAND' 'same-candidate reinstall exited 0' '.\scripts\install.ps1 --yes --no-prereqs' $reinstall.ExitCode "candidate:$candidateObservedSha" $reinstall.Stdout)
  )))

  $rollback = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'baseline-rollback') 2700
  Assert-ExitZero $rollback 'v0.23.1 source rollback'
  foreach ($file in $profileStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during rollback: $file" } }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'repository changed during rollback' }
  if ((Get-FileSha $sentinel) -ne $sentinelBefore) { throw 'unrelated tool sentinel changed during install/reinstall/rollback' }
  $rollbackDoctor = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\doctor.ps1'),'--json') (Join-Path $logs 'rollback-doctor') 600
  Assert-ExitZero $rollbackDoctor 'rollback Doctor'
  $rollbackDoctorJson = Get-Content -LiteralPath $rollbackDoctor.Stdout -Raw | ConvertFrom-Json
  $baselineManifest = Get-Content -LiteralPath (Join-Path $BaselineRoot 'config\release-manifest.json') -Raw | ConvertFrom-Json
  Assert-DoctorManifestPins $rollbackDoctorJson $baselineManifest 'rollback'
  [void]$claims.Add((New-Claim 'baseline-rollback-preservation' 'ROLLBACK' 'PASS' $true $true $false 'Actual baseline source install restored the exact baseline manifest pins without wiping state, project data, or unrelated sentinel.' @(
    (New-Evidence 'COMMAND' 'rollback install and Doctor exited 0' '.\scripts\install.ps1 --yes --no-prereqs; .\scripts\doctor.ps1 --json' 0 "baseline:$baselineObservedSha" $rollbackDoctor.Stdout),
    (New-Evidence 'HASH' "unrelated sentinel remained $sentinelBefore" 'SHA-256 before/after' 0 "baseline:$baselineObservedSha" $sentinel)
  )))

} catch {
  $runFailure = $_.Exception.Message
} finally {
  $artifactFailure = $null
  try {
    if (Test-Path -LiteralPath $CandidateRoot -PathType Container) {
      $sourceStatusCandidate = (& git -C $CandidateRoot status --porcelain --untracked-files=all | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $sourceStatusCandidate) { throw 'immutable candidate checkout is dirty or unreadable' }
    }
    if (Test-Path -LiteralPath $BaselineRoot -PathType Container) {
      $sourceStatusBaseline = (& git -C $BaselineRoot status --porcelain --untracked-files=all | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $sourceStatusBaseline) { throw 'immutable baseline checkout is dirty or unreadable' }
    }
    $canaryHits = @(Find-Canary $EvidenceRoot $canary)
    if ($canaryHits.Count -gt 0) { throw 'credential canary found in uploadable evidence' }
  } catch {
    $artifactFailure = 'artifact finalization failed closed; evidence is not uploadable'
  }
  if ($artifactFailure) {
    if ($runFailure) { $runFailure = "$runFailure; $artifactFailure" } else { $runFailure = $artifactFailure }
    if ($EvidenceRoot -and (Test-Path -LiteralPath $EvidenceRoot)) { Remove-Item -LiteralPath $EvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue }
    [void]$claims.Add((New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'FAIL' $true $true $false $artifactFailure @(
      (New-Evidence 'COMMAND' 'artifact scan failed or detected the planted canary; evidence was removed from upload eligibility' 'final artifact canary and checkout scan' 1 $(if ($harnessObservedSha) { "harness:$harnessObservedSha" } else { 'harness' }))
    )))
  } else {
    $artifactsUploadable = $true
    [void]$claims.Add((New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'PASS' $true $true $false 'Every retained evidence artifact was scanned after success or failure; product checkouts remained clean and the planted canary was absent.' @(
      (New-Evidence 'COMMAND' 'both source checkouts clean when present; final canary scan had zero hits' 'git status --porcelain; final exact canary scan' 0 $(if ($harnessObservedSha) { "harness:$harnessObservedSha" } else { 'harness' }))
    )))
  }
  if ($runFailure) {
    [void]$claims.Add((New-Claim 'automated-harness-completion' 'SECURITY' 'FAIL' $true $true $false "Automated harness failed closed: $runFailure" @(
      (New-Evidence 'COMMAND' 'harness terminated before all required claims passed' 'acceptance/windows-terminal-workstation.ps1 -Mode Run' 1 $(if ($harnessObservedSha) { "harness:$harnessObservedSha" } else { 'harness' }))
    )))
  }
  foreach ($id in $script:RequiredOperatorIds) {
    [void]$operator.Add((New-Claim $id 'OPERATOR' 'NOT_REACHED' $true $false $true 'Must be completed by a human in a snapshot-capable disposable Windows VM; CI makes no claim.' @()))
  }
  $receipt = [ordered]@{
    schema_version = 1
    candidate = [ordered]@{ expected_sha = $script:CandidateSha; observed_sha = $candidateObservedSha; expected_version = '0.23.1'; observed_version = $candidateObservedVersion }
    baseline = [ordered]@{ expected_sha = $script:BaselineSha; observed_sha = $baselineObservedSha; expected_version = '0.23.1'; observed_version = $baselineObservedVersion }
    harness = [ordered]@{ observed_sha = $harnessObservedSha; observed_version = $harnessObservedVersion }
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
    try {
      $receiptHits = @(Find-Canary $ReceiptPath $canary)
      if ($receiptHits.Count -gt 0) { throw 'canary found in receipt' }
      if ($artifactsUploadable) { [System.IO.File]::WriteAllText("$ReceiptPath.evidence-uploadable", "scanned`n", (New-Object System.Text.UTF8Encoding($false))) }
    } catch {
      $artifactsUploadable = $false
      $runFailure = 'artifact finalization failed closed; only a controlled minimal receipt was retained'
      if ($EvidenceRoot -and (Test-Path -LiteralPath $EvidenceRoot)) { Remove-Item -LiteralPath $EvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue }
      $claims = @(
        (New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'FAIL' $true $true $false 'Receipt scan could not prove sanitization; evidence was removed from upload eligibility.' @((New-Evidence 'COMMAND' 'final receipt scan failed closed' 'final exact canary scan' 1 'harness'))),
        (New-Claim 'automated-harness-completion' 'SECURITY' 'FAIL' $true $true $false 'Automated harness failed closed during artifact finalization.' @((New-Evidence 'COMMAND' 'harness did not complete with uploadable evidence' 'acceptance/windows-terminal-workstation.ps1 -Mode Run' 1 'harness')))
      )
      $receipt.claims = @($claims)
      $receipt.execution.finished_utc = (Get-Date).ToUniversalTime().ToString('o')
      [System.IO.File]::WriteAllText($ReceiptPath, ($receipt | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
    }
  }
}

if ($runFailure) { Write-Error $runFailure; exit 1 }
Assert-Receipt (Read-Receipt $ReceiptPath) | Out-Null
Write-Output "automated receipt: $ReceiptPath"
Write-Output 'TERMINAL_WORKSTATION_READY=false (human disposable-VM evidence remains mandatory)'
exit 0
