#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('Run','RunBehavioralSuite','ValidateReceipt','ValidateUploadAuthorization','Probe')][string]$Mode = 'Run',
  [ValidateSet('Receipt','Evidence')][string]$AuthorizationKind = 'Receipt',
  [string]$RunNonce = '',
  [string]$HarnessRoot = '',
  [string]$CandidateRoot = '',
  [string]$BaselineRoot = '',
  [string]$EvidenceRoot = '',
  [string]$ReceiptPath = '',
  [string]$ExpectedHarnessSha = '',
  [string]$ExpectedCandidateSha = '',
  [string]$ExpectedCandidateBuild = '',
  [switch]$VmOperatorMode,
  [ValidateSet('ValidateSha','AssertEmptyRoot','HashTree','ScanCanary','EvaluateReadiness','VerifySupportBuild','VerifyManifestPins','CollectExtensionInventory','ReconcileNpmState','ValidateLifecycleEvent','AuthorizeArtifacts','ResolvePython','BoundedCommandSuccess','BoundedUnicodeFidelity','BoundedProcessTree','SuccessfulParentDescendant','OwnershipLifecycleFailure','FinalizeArtifacts')][string]$Probe = 'ValidateSha',
  [string]$Value = '',
  [string]$Root = '',
  [string]$Canary = ''
)

$ErrorActionPreference = 'Stop'
$script:CandidateSha = $ExpectedCandidateSha
$script:BaselineSha = 'd60300780b565aabf15b172b2bc32abad12b9ca6'
$script:AllowedStatuses = @('PASS','FAIL','BLOCKED','INCONCLUSIVE','NOT_REACHED','NOT_AVAILABLE','CAPABILITY_SKIP','BETA_LIMITATION')
$script:CandidateSupportBuild = $ExpectedCandidateBuild
$script:ProcessCleanupUncertain = $false
$script:LifecycleFaultEvidence = $null
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
  'warehouse-mcp-live-acceptance',
  'snapshot-recovery'
)

function Test-StrictSha([string]$Sha) {
  return [bool]($Sha -cmatch '^[0-9a-f]{40}$')
}

function Assert-CheckoutIdentity([string]$Path, [string]$Label, [string]$ExpectedSha) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "checkout missing: $Label" }
  $observed = (& git -C $Path rev-parse HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $observed -cne $ExpectedSha) { throw "checkout identity mismatch: $Label" }
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

function Assert-NoReparsePoints([string]$Path, [string]$Label) {
  [void]@(Get-SafeTreeItems $Path $Label)
}

function Get-SafeTreeItems([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$Label does not exist: $Path" }
  Assert-NoReparseAncestry $Path $true
  $root = Get-Item -LiteralPath $Path -Force
  if (-not $root.PSIsContainer) { return @($root) }
  $items = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push($root.FullName)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label contains a reparse point: $($item.FullName)" }
      $items.Add($item)
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
  return $items.ToArray()
}

function Remove-SafeTree([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $true }
  try {
    Assert-NoReparseAncestry $Path $true
    Assert-NoReparsePoints $Path 'removal target'
  } catch {
    return $false
  }
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  return $true
}

function Get-TreeHash([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "tree does not exist: $Path" }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $rows = New-Object System.Collections.Generic.List[string]
  Get-SafeTreeItems $Path 'tree' |
    Where-Object { -not $_.PSIsContainer -and $_.FullName -notmatch '[\\/]\.git([\\/]|$)' } |
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

function Get-DirectTreeHash([string]$Path, [bool]$ExcludeGit = $false) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "tree does not exist: $Path" }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $rows = New-Object System.Collections.Generic.List[string]
  Get-SafeTreeItems $Path 'direct tree' |
    Where-Object { -not $ExcludeGit -or $_.FullName -notmatch '[\\/]\.git([\\/]|$)' } |
    Sort-Object FullName |
    ForEach-Object {
      $rel = $_.FullName.Substring($resolved.Length).TrimStart('\','/').Replace('\','/')
      $digest = if (-not $_.PSIsContainer) { Get-FileSha $_.FullName } else { '' }
      $rows.Add("$rel`t$([int]$_.Attributes)`t$digest")
    }
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($rows -join "`n"))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-CheckoutSnapshot([string]$Path) {
  $git = Join-Path $Path '.git'
  if (-not (Test-Path -LiteralPath $git -PathType Container)) { throw "checkout git metadata is not an ordinary directory: $Path" }
  return [pscustomobject]@{
    content = Get-DirectTreeHash $Path $true
    git_control = Get-DirectTreeHash $git $false
  }
}

function Assert-CheckoutSnapshot([object]$Expected, [string]$Path, [string]$Label) {
  $actual = Get-CheckoutSnapshot $Path
  if ($actual.content -cne $Expected.content -or $actual.git_control -cne $Expected.git_control) { throw "behavioral suite mutated checkout content or git metadata: $Label" }
}

function Find-Canary([string]$Path, [string]$Needle) {
  if (-not $Needle) { throw 'canary is required' }
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $hits = @()
  $files = @(Get-SafeTreeItems $Path 'canary scan target' | Where-Object { -not $_.PSIsContainer })
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

function Test-JsonString([object]$Value) {
  return ($Value -is [string])
}

function Test-JsonArray([object]$Value) {
  return ($null -ne $Value -and $Value -is [System.Array])
}

function Assert-WarehouseLiveObject([object]$live, [string]$Label = 'Warehouse MCP live proof') {
  Assert-ExactProperties $live @('auth_state','target_validation','target_scope','discovered_tool','provenance','mock') $Label
  foreach ($name in @('auth_state','target_validation','target_scope','discovered_tool','provenance')) {
    if (-not (Test-JsonString $live.$name)) { throw "$Label property $name must be a string" }
  }
  if ($live.auth_state -cne 'authenticated') { throw 'Warehouse MCP live auth was not authenticated' }
  if ($live.target_validation -cne 'validated' -or $live.target_scope -cne 'item') { throw 'Warehouse MCP live item target was not validated' }
  if ($live.discovered_tool -cnotin @('executeSQL','execute_query','fabric-sqlendpoint-execute_query','fabric_sqlendpoint_execute_query')) { throw 'Warehouse MCP live proof lacks an exact compatible discovered tool' }
  if ($live.provenance -cne 'live' -or $live.mock -isnot [bool] -or [bool]$live.mock) { throw 'Warehouse MCP evidence is mock, generic, or not explicitly live' }
}

function Assert-WarehouseLiveEvidence([object]$Claim) {
  $proofs = @($Claim.evidence | Where-Object { $_.kind -ceq 'OPERATOR_OBSERVATION' -and $null -ne $_.warehouse_live })
  if ($proofs.Count -ne 1) { throw 'Warehouse MCP readiness requires exactly one structured live proof' }
  Assert-WarehouseLiveObject $proofs[0].warehouse_live
}

function Assert-ObservedIdentity([object]$Identity, [string]$Label, [string]$ExpectedSha, [bool]$Ready) {
  Assert-ExactProperties $Identity $(if ($Label -eq 'candidate') { @('expected_sha','observed_sha','expected_version','observed_version','expected_build','observed_build') } else { @('expected_sha','observed_sha','expected_version','observed_version') }) "$Label identity"
  if (-not (Test-JsonString $Identity.expected_sha) -or $Identity.expected_sha -cne $ExpectedSha) { throw "$Label expected SHA mismatch" }
  if (-not (Test-JsonString $Identity.expected_version) -or [string]::IsNullOrWhiteSpace($Identity.expected_version)) { throw "$Label expected version must be a non-empty string" }
  if ($Label -eq 'candidate') {
    if ($script:CandidateSupportBuild -cnotmatch '^build-[0-9a-f]{8}$' -or $Identity.expected_build -cne $script:CandidateSupportBuild) { throw 'candidate expected build mismatch' }
    if ($null -ne $Identity.observed_build -and (-not (Test-JsonString $Identity.observed_build) -or $Identity.observed_build -cnotmatch '^build-[0-9a-f]{8}$')) { throw 'candidate observed build must be an exact build fingerprint or null' }
    if ($null -ne $Identity.observed_build -and $Identity.observed_build -cne $script:CandidateSupportBuild) { throw 'candidate observed build does not match the required build' }
  }
  if ($null -ne $Identity.observed_sha -and (-not (Test-JsonString $Identity.observed_sha) -or -not (Test-StrictSha $Identity.observed_sha))) { throw "$Label observed SHA must be exact 40-hex string or null" }
  if ($null -ne $Identity.observed_sha -and $Identity.observed_sha -cne $ExpectedSha) { throw "$Label observed SHA mismatch" }
  if ($null -ne $Identity.observed_version -and (-not (Test-JsonString $Identity.observed_version) -or [string]::IsNullOrWhiteSpace($Identity.observed_version))) { throw "$Label observed version must be a non-empty string or null" }
  if ($Ready -and ($Identity.observed_sha -cne $ExpectedSha -or [string]::IsNullOrWhiteSpace($Identity.observed_version))) {
    throw "$Label observed identity does not match the required build"
  }
}

function Assert-ManifestPinProof([object]$Proof, [object]$Manifest, [string]$Label) {
  Assert-ExactProperties $Proof @('coop_version','pi','extensions','python_tools','npm_tools','mcp_servers') "$Label manifest proof"
  if (-not (Test-JsonString $Manifest.coop_version) -or $Proof.coop_version -cne $Manifest.coop_version) { throw "$Label COOP version does not match manifest" }
  Assert-ExactProperties $Proof.pi @('package','version') "$Label Pi proof"
  foreach ($name in @('package','version')) {
    if (-not (Test-JsonString $Manifest.pi.$name) -or $Proof.pi.$name -cne $Manifest.pi.$name) { throw "$Label Pi $name does not match manifest" }
  }
  foreach ($category in @('extensions','python_tools','npm_tools')) {
    $expectedNames = @($Manifest.$category.PSObject.Properties.Name)
    if ($expectedNames.Count -eq 0) { throw "$Label manifest category is empty: $category" }
    Assert-ExactProperties $Proof.$category $expectedNames "$Label $category proof"
    foreach ($name in $expectedNames) {
      $expected = $Manifest.$category.PSObject.Properties[$name].Value
      $observed = $Proof.$category.PSObject.Properties[$name].Value
      if (-not (Test-JsonString $expected) -or [string]::IsNullOrWhiteSpace($expected) -or $observed -cne $expected) { throw "$Label manifest pin mismatch: $category.$name" }
    }
  }
  $mcpNames = @($Manifest.mcp_servers.PSObject.Properties.Name)
  if ($mcpNames.Count -eq 0) { throw "$Label manifest category is empty: mcp_servers" }
  Assert-ExactProperties $Proof.mcp_servers $mcpNames "$Label mcp_servers proof"
  foreach ($name in $mcpNames) {
    $expected = $Manifest.mcp_servers.PSObject.Properties[$name].Value
    $observed = $Proof.mcp_servers.PSObject.Properties[$name].Value
    if (-not (Test-JsonString $expected) -or [string]::IsNullOrWhiteSpace($expected)) { throw "$Label manifest pin missing: mcp_servers.$name" }
    if ($observed -cne $expected -and $observed -cne 'NOT_MANAGED') { throw "$Label managed MCP pin mismatch: $name" }
  }
}

function Get-InstalledExtensionInventory([object]$Manifest, [string]$AgentRoot, [string]$Label) {
  $inventory = [ordered]@{}
  $settingsPath = Join-Path $AgentRoot 'settings.json'
  if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { throw "$Label Pi settings missing" }
  $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  if (-not (Test-JsonArray $settings.packages)) { throw "$Label Pi package list must be an array" }
  $packageRoot = Join-Path $AgentRoot 'npm\node_modules'
  $core = '(?:0|[1-9][0-9]*)'
  $identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  $prerelease = "-$identifier(?:\.$identifier)*"
  $build = '\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*'
  $semver = "$core\.$core\.$core(?:$prerelease)?(?:$build)?"
  $specPattern = "^npm:(?<name>@[^/@]+/[^/@]+|[^/@]+)@(?<version>$semver)\z"
  foreach ($spec in @($settings.packages)) {
    if (-not (Test-JsonString $spec)) { throw "$Label Pi package spec must be a string" }
    $match = [regex]::Match([string]$spec, $specPattern)
    if (-not $match.Success) { throw "$Label Pi package spec is not canonical: $spec" }
    $name = $match.Groups['name'].Value
    $configuredVersion = $match.Groups['version'].Value
    if ($inventory.Contains($name)) { throw "$Label duplicate installed extension spec: $name" }
    $packageJson = $packageRoot
    foreach ($part in ($name -split '/')) { $packageJson = Join-Path $packageJson $part }
    $packageJson = Join-Path $packageJson 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { throw "$Label installed extension metadata missing: $name" }
    $metadata = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
    if (-not (Test-JsonString $metadata.name) -or [string]$metadata.name -cne $name) { throw "$Label installed extension name mismatch: $name" }
    if (-not (Test-JsonString $metadata.version) -or [string]::IsNullOrWhiteSpace($metadata.version)) { throw "$Label installed extension version missing: $name" }
    if ([string]$metadata.version -cne $configuredVersion) { throw "$Label configured and installed extension versions differ: $name" }
    $inventory[$name] = [string]$metadata.version
  }
  return [pscustomobject]$inventory
}

function Invoke-NpmRollbackReconciliation([object]$BaselineState, [string]$LogRoot, [scriptblock]$Runner = $null) {
  $commands = New-Object System.Collections.Generic.List[string]
  foreach ($name in @($BaselineState.PSObject.Properties.Name)) {
    $expected = [string]$BaselineState.PSObject.Properties[$name].Value
    $npmArgs = if ($expected -ceq 'NOT_INSTALLED') { @('uninstall','-g',$name) } else { @('install','-g',"$name@$expected") }
    $logPath = Join-Path $LogRoot ("baseline-rollback-npm-" + ($name -replace '[^A-Za-z0-9._-]','_'))
    $result = if ($null -ne $Runner) { & $Runner -NpmArgs $npmArgs -LogPath $logPath } else { Invoke-Bounded 'npm.cmd' $npmArgs $logPath 600 }
    Assert-ExitZero $result "rollback npm reconciliation for $name"
    [void]$commands.Add(($npmArgs -join ' '))
  }
  return @($commands)
}

function Get-ManifestPinProof([object]$Doctor, [object]$Manifest, [string]$ObservedCoopVersion, [object]$NpmInventory, [object]$ExtensionInventory, [object]$McpConfig, [string]$Label) {
  if ($null -eq $Doctor -or $Doctor.fail -ne 0 -or -not (Test-JsonArray $Doctor.checks)) { throw "$Label Doctor JSON is incomplete or failing" }
  $requireDoctorCheck = {
    param([string]$ExpectedName, [string]$AlternateName = '')
    $matches = @($Doctor.checks | Where-Object { $_.status -ceq 'ok' -and ($_.name -ceq $ExpectedName -or ($AlternateName -and $_.name -ceq $AlternateName)) })
    if ($matches.Count -ne 1) {
      # Name every look-alike so a non-unique proof is diagnosable from the run
      # log alone (the evidence bundle cannot be built after a fail-closed run).
      $subject = ($ExpectedName -split ' ', 2)[0]
      $alternateSubject = if ($AlternateName) { ($AlternateName -split ' ', 2)[0] } else { '' }
      $lookalikes = @($Doctor.checks | Where-Object {
        $_.name -ceq $ExpectedName -or
        ($AlternateName -and $_.name -ceq $AlternateName) -or
        $_.name.StartsWith("$subject ", [System.StringComparison]::Ordinal) -or
        ($alternateSubject -and $_.name.StartsWith("$alternateSubject ", [System.StringComparison]::Ordinal))
      })
      $detail = if ($lookalikes.Count -gt 0) { '; saw ' + (@($lookalikes | ForEach-Object { "$($_.status):$($_.name)" }) -join ' | ') } else { '' }
      throw "$Label Doctor did not uniquely prove: $ExpectedName ($($matches.Count) ok match(es)$detail)"
    }
  }
  $piPackage = $Manifest.pi.package
  $piVersion = $Manifest.pi.version
  $piInstalled = $NpmInventory.dependencies.PSObject.Properties[$piPackage].Value.version
  if ($piInstalled -cne $piVersion) { throw "$Label installed Pi package does not match manifest" }
  & $requireDoctorCheck "pi $piVersion matches manifest ($piVersion)"

  $extensionProof = [ordered]@{}
  Assert-ExactProperties $ExtensionInventory @($Manifest.extensions.PSObject.Properties.Name) "$Label installed extension inventory"
  foreach ($name in @($Manifest.extensions.PSObject.Properties.Name)) {
    $version = $Manifest.extensions.PSObject.Properties[$name].Value
    $installed = $ExtensionInventory.PSObject.Properties[$name].Value
    if ($installed -cne $version) { throw "$Label installed extension does not match manifest: $name" }
    $extensionProof[$name] = $installed
  }
  $pythonProof = [ordered]@{}
  foreach ($name in @($Manifest.python_tools.PSObject.Properties.Name)) {
    $version = $Manifest.python_tools.PSObject.Properties[$name].Value
    if ($name -eq 'fabric-cicd') {
      & $requireDoctorCheck "fabric-cicd $version (library, in the Fabric CLI env)"
    } else {
      $normal = "$name $version matches manifest ($version)"
      & $requireDoctorCheck $normal "$normal (CLI-reported; pipx metadata unreadable)"
    }
    $pythonProof[$name] = $version
  }
  $npmProof = [ordered]@{}
  foreach ($name in @($Manifest.npm_tools.PSObject.Properties.Name)) {
    $version = $Manifest.npm_tools.PSObject.Properties[$name].Value
    $installed = $NpmInventory.dependencies.PSObject.Properties[$name].Value.version
    if ($installed -cne $version) { throw "$Label installed npm tool does not match manifest: $name" }
    $npmProof[$name] = $installed
  }

  $managed = @()
  if ($null -ne $McpConfig._coop -and $null -ne $McpConfig._coop.managed_servers) {
    if (-not (Test-JsonArray $McpConfig._coop.managed_servers)) { throw "$Label managed MCP list must be an array" }
    $managed = @($McpConfig._coop.managed_servers)
  }
  $managedSpecs = @()
  foreach ($serverName in $managed) {
    if (-not (Test-JsonString $serverName)) { throw "$Label managed MCP server name must be a string" }
    $server = $McpConfig.mcpServers.PSObject.Properties[$serverName].Value
    if ($null -eq $server -or -not (Test-JsonArray $server.args)) { throw "$Label managed MCP server is missing or has non-array args: $serverName" }
    $specs = @($server.args | Where-Object { $_ -is [string] -and $_ -match '^(@[^/]+/[^@]+|[^@]+)@(.+)$' })
    if ($specs.Count -ne 1) { throw "$Label managed MCP server must contain exactly one pinned package spec: $serverName" }
    $managedSpecs += $specs[0]
  }
  $knownManagedSpecs = @()
  foreach ($category in @('mcp_servers','npm_tools')) {
    foreach ($name in @($Manifest.$category.PSObject.Properties.Name)) {
      $knownManagedSpecs += "$name@$($Manifest.$category.PSObject.Properties[$name].Value)"
    }
  }
  foreach ($spec in $managedSpecs) {
    if ($knownManagedSpecs -cnotcontains $spec) { throw "$Label managed MCP spec is not exactly manifest-pinned: $spec" }
  }
  $mcpProof = [ordered]@{}
  foreach ($name in @($Manifest.mcp_servers.PSObject.Properties.Name)) {
    $version = $Manifest.mcp_servers.PSObject.Properties[$name].Value
    $mcpProof[$name] = if ($managedSpecs -ccontains "$name@$version") { $version } else { 'NOT_MANAGED' }
  }
  return [pscustomobject][ordered]@{
    coop_version = $ObservedCoopVersion
    pi = [pscustomobject][ordered]@{ package = $piPackage; version = $piInstalled }
    extensions = [pscustomobject]$extensionProof
    python_tools = [pscustomobject]$pythonProof
    npm_tools = [pscustomobject]$npmProof
    mcp_servers = [pscustomobject]$mcpProof
  }
}

function Assert-Receipt([object]$Receipt) {
  Assert-ExactProperties $Receipt @('schema_version','candidate','baseline','harness','execution','claims','operator_evidence','terminal_workstation_ready') 'receipt'
  if ($null -eq $Receipt -or ($Receipt.schema_version -isnot [int] -and $Receipt.schema_version -isnot [long]) -or $Receipt.schema_version -ne 1) { throw 'receipt schema_version must be integer 1' }
  if ($null -eq $Receipt.terminal_workstation_ready -or $Receipt.terminal_workstation_ready -isnot [bool]) { throw 'terminal_workstation_ready must be boolean' }
  $ready = [bool]$Receipt.terminal_workstation_ready
  Assert-ObservedIdentity $Receipt.candidate 'candidate' $script:CandidateSha $ready
  Assert-ObservedIdentity $Receipt.baseline 'baseline' $script:BaselineSha $ready
  Assert-ExactProperties $Receipt.harness @('observed_sha','observed_version') 'harness identity'
  if ($null -ne $Receipt.harness.observed_sha -and (-not (Test-JsonString $Receipt.harness.observed_sha) -or -not (Test-StrictSha $Receipt.harness.observed_sha))) { throw 'harness observed_sha must be exact 40-hex string or null' }
  if ($null -ne $Receipt.harness.observed_sha -and $Receipt.harness.observed_sha -cne $ExpectedHarnessSha) { throw 'harness observed SHA mismatch' }
  if ($Receipt.harness.observed_sha -eq $script:BaselineSha) { throw 'harness identity must remain distinct from baseline identity' }
  if ($null -ne $Receipt.harness.observed_version -and (-not (Test-JsonString $Receipt.harness.observed_version) -or [string]::IsNullOrWhiteSpace($Receipt.harness.observed_version))) { throw 'harness observed_version must be a non-empty string or null' }
  if ($ready) {
    if (-not (Test-StrictSha $Receipt.harness.observed_sha)) { throw 'harness observed SHA is required for readiness' }
    if ([string]::IsNullOrWhiteSpace($Receipt.harness.observed_version)) { throw 'harness observed version is required for readiness' }
  }
  Assert-ExactProperties $Receipt.execution @('layer','runner','started_utc','finished_utc','owned_root') 'execution'
  if (-not (Test-JsonString $Receipt.execution.layer) -or $Receipt.execution.layer -notin @('AUTOMATED_WINDOWS','DISPOSABLE_VM_OPERATOR')) { throw 'invalid execution layer' }
  if (-not (Test-JsonString $Receipt.execution.runner) -or [string]::IsNullOrWhiteSpace($Receipt.execution.runner)) { throw 'execution.runner must be a non-empty string' }
  foreach ($name in @('started_utc','finished_utc')) {
    if (-not (Test-DateTime $Receipt.execution.$name)) { throw "execution.$name must be an RFC 3339 date-time string" }
  }
  if ($null -ne $Receipt.execution.owned_root -and (-not (Test-JsonString $Receipt.execution.owned_root) -or [string]::IsNullOrWhiteSpace($Receipt.execution.owned_root))) { throw 'execution.owned_root must be a non-empty string or null' }
  if (-not (Test-JsonArray $Receipt.claims) -or -not (Test-JsonArray $Receipt.operator_evidence)) { throw 'claims and operator_evidence must be arrays' }
  $allIds = @{}
  foreach ($claim in @($Receipt.claims) + @($Receipt.operator_evidence)) {
    Assert-ExactProperties $claim @('id','phase','status','required','automated','human_required','summary','evidence') "claim $($claim.id)"
    if ($null -eq $claim -or -not (Test-JsonString $claim.status) -or $script:AllowedStatuses -notcontains $claim.status) { throw "invalid evidence status: $($claim.status)" }
    if (-not (Test-JsonString $claim.id) -or $claim.id -cnotmatch '^[a-z0-9][a-z0-9-]*$' -or -not (Test-JsonString $claim.summary) -or [string]::IsNullOrWhiteSpace($claim.summary)) { throw 'every claim requires a valid string id and non-empty string summary' }
    if ($allIds.ContainsKey($claim.id)) { throw "duplicate claim id: $($claim.id)" }; $allIds[$claim.id] = $true
    if (-not (Test-JsonString $claim.phase) -or $claim.phase -notin @('PRECHECK','BASELINE','UPGRADE','REINSTALL','ROLLBACK','SECURITY','OPERATOR')) { throw "invalid claim phase: $($claim.phase)" }
    foreach ($name in @('required','automated','human_required')) { if ($claim.$name -isnot [bool]) { throw "claim $($claim.id) property $name must be boolean" } }
    if (-not (Test-JsonArray $claim.evidence)) { throw "claim $($claim.id) evidence must be an array" }
    foreach ($e in $claim.evidence) {
      Assert-ExactProperties $e @('kind','observed','command','exit_code','identity','path','sha256','warehouse_live') "claim $($claim.id) evidence"
      if (-not (Test-JsonString $e.observed) -or [string]::IsNullOrWhiteSpace($e.observed)) { throw "claim $($claim.id) has incomplete observed evidence" }
      if (-not (Test-JsonString $e.kind) -or $e.kind -notin @('COMMAND','HASH','FILE','OPERATOR_OBSERVATION')) { throw "claim $($claim.id) has invalid evidence kind" }
      if ($null -ne $e.exit_code -and $e.exit_code -isnot [int] -and $e.exit_code -isnot [long]) { throw "claim $($claim.id) evidence exit_code must be integer or null" }
      if ($e.kind -eq 'COMMAND' -and $null -eq $e.exit_code) { throw "claim $($claim.id) COMMAND evidence exit_code must be an integer" }
      foreach ($name in @('command','identity','path','sha256')) { if (-not (Test-JsonString $e.$name)) { throw "claim $($claim.id) evidence $name must be a string" } }
      if ($null -ne $e.warehouse_live) {
        if ($e.warehouse_live -isnot [pscustomobject]) { throw "claim $($claim.id) warehouse_live evidence must be an object or null" }
        Assert-WarehouseLiveObject $e.warehouse_live "claim $($claim.id) Warehouse MCP live proof"
      }
      if ($e.identity -cnotmatch '^(harness|candidate|baseline|operator)(:[0-9a-f]{40})?$') { throw "claim $($claim.id) has invalid evidence identity" }
      if ($e.sha256 -and $e.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "claim $($claim.id) has invalid evidence SHA-256" }
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
    $warehouse = @($Receipt.operator_evidence | Where-Object { $_.id -eq 'warehouse-mcp-live-acceptance' })
    if ($warehouse.Count -ne 1 -or $warehouse[0].status -ne 'PASS') {
      throw 'Warehouse MCP live acceptance is a certification blocker until auth, target validation, and tools/list succeed'
    }
    Assert-WarehouseLiveEvidence $warehouse[0]
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

function Stop-TrackedProcessTrees {
  if ($script:ProcessCleanupUncertain) { throw 'owned process cleanup was previously uncertain' }
  # Invoke-Bounded does not return until knowledge-git.py has observed its owned
  # Job Object/process group empty. There is deliberately no PID enumeration:
  # kernel-owned inherited membership is the safety boundary.
}

function Assert-FrozenArtifactsSafe([string]$EvidencePath, [string]$Needle, [string]$CandidatePath = '', [string]$BaselinePath = '', [string]$HarnessPath = '') {
  Stop-TrackedProcessTrees
  if ($script:ProcessCleanupUncertain) { throw 'owned process cleanup uncertainty suppresses upload' }
  foreach ($item in @(@{ Path = $CandidatePath; Label = 'candidate' }, @{ Path = $BaselinePath; Label = 'baseline' }, @{ Path = $HarnessPath; Label = 'harness' })) {
    if ($item.Path -and (Test-Path -LiteralPath $item.Path -PathType Container)) {
      $sourceStatus = (& git -C $item.Path status --porcelain --untracked-files=all | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $sourceStatus) { throw "immutable $($item.Label) checkout is dirty or unreadable" }
    }
  }
  $canaryHits = @(Find-Canary $EvidencePath $Needle)
  if ($canaryHits.Count -gt 0) { throw 'credential canary found in uploadable evidence' }
}

function Get-AuthorizationPath([string]$Path, [string]$Kind) {
  if ($Kind -eq 'Receipt') { return "$Path.receipt-authorization.json" }
  if ($Kind -eq 'Evidence') { return "$Path.evidence-authorization.json" }
  throw "unknown upload authorization kind: $Kind"
}

function Assert-NoReparseAncestry([string]$Path, [bool]$IncludeLeaf = $false) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $target = if ($IncludeLeaf) { $full } else { Split-Path -Parent $full }
  if (-not $target) { throw "reparse ancestry target is missing: $Path" }
  $root = [System.IO.Path]::GetPathRoot($target)
  if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw "reparse ancestry root is missing: $root" }
  $current = $root
  $rootItem = Get-Item -LiteralPath $current -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse ancestry rejected: $($rootItem.FullName)" }
  $relative = $target.Substring($root.Length)
  foreach ($part in @($relative -split '[\\/]' | Where-Object { $_ })) {
    $current = Join-Path $current $part
    if (-not (Test-Path -LiteralPath $current)) { throw "reparse ancestry component is missing: $current" }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse ancestry rejected: $($item.FullName)" }
  }
}

function Write-ExclusiveText([string]$Path, [string]$Text) {
  Assert-NoReparseAncestry $Path
  if (Test-Path -LiteralPath $Path) { throw "exclusive publication collision: $Path" }
  $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  $temporary = Join-Path $parent ('.authorization-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose(); $stream = $null
    [System.IO.File]::Move($temporary, [System.IO.Path]::GetFullPath($Path))
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
  }
}

function Write-ControlledReceipt([string]$Path, [string]$Text) {
  Assert-NoReparseAncestry $Path
  $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  $temporary = Join-Path $parent ('.receipt-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose(); $stream = $null
    if ($env:COOP_TERMINAL_ACCEPTANCE_AUTHORIZATION_FAULT -eq 'receipt-replace-fail') { throw 'test receipt replacement failure' }
    if (Test-Path -LiteralPath $Path) {
      [System.IO.File]::Replace($temporary, [System.IO.Path]::GetFullPath($Path), [System.Management.Automation.Language.NullString]::Value)
    } else {
      [System.IO.File]::Move($temporary, [System.IO.Path]::GetFullPath($Path))
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
  }
}

function Remove-UploadAuthorizations([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  if ($env:COOP_TERMINAL_ACCEPTANCE_AUTHORIZATION_FAULT -eq 'revoke-fail') { throw 'test upload authorization revocation failure' }
  foreach ($kind in @('Receipt','Evidence')) {
    $authorization = Get-AuthorizationPath $Path $kind
    if (Test-Path -LiteralPath $authorization) { Remove-Item -LiteralPath $authorization -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $authorization) { throw "could not revoke stale $kind upload authorization" }
  }
}

function New-UploadAuthorization([string]$Kind, [string]$Path, [string]$Nonce, [string]$HarnessSha, [string]$EvidencePath = '') {
  if ($Nonce -cnotmatch '^[0-9a-f]{32}$' -or -not (Test-StrictSha $HarnessSha)) { throw 'upload authorization identity is invalid' }
  $receiptSha = Get-FileSha $Path
  if ($receiptSha -cnotmatch '^[0-9a-f]{64}$') { throw 'receipt hash unavailable for authorization' }
  $record = [ordered]@{ schema_version = 1; kind = $Kind.ToLowerInvariant(); run_nonce = $Nonce; harness_sha = $HarnessSha; candidate_sha = $script:CandidateSha; candidate_build = $script:CandidateSupportBuild; receipt_sha256 = $receiptSha }
  if ($Kind -eq 'Evidence') {
    if (-not $EvidencePath) { throw 'evidence path is required for evidence authorization' }
    $record.evidence_root = [System.IO.Path]::GetFullPath($EvidencePath)
    $record.evidence_sha256 = Get-TreeHash $EvidencePath
  }
  Write-ExclusiveText (Get-AuthorizationPath $Path $Kind) (($record | ConvertTo-Json -Compress) + "`n")
}

function Assert-UploadAuthorization([string]$Kind, [string]$Path, [string]$Nonce, [string]$HarnessSha, [string]$EvidencePath = '') {
  if ($Nonce -cnotmatch '^[0-9a-f]{32}$' -or -not (Test-StrictSha $HarnessSha)) { throw 'current upload identity is invalid' }
  $authorizationPath = Get-AuthorizationPath $Path $Kind
  if (-not (Test-Path -LiteralPath $authorizationPath -PathType Leaf)) { throw "$Kind upload authorization is absent" }
  Assert-NoReparseAncestry $authorizationPath
  $record = Get-Content -LiteralPath $authorizationPath -Raw | ConvertFrom-Json
  $properties = @('schema_version','kind','run_nonce','harness_sha','candidate_sha','candidate_build','receipt_sha256')
  if ($Kind -eq 'Evidence') { $properties += @('evidence_root','evidence_sha256') }
  Assert-ExactProperties $record $properties "$Kind upload authorization"
  if (($record.schema_version -isnot [int] -and $record.schema_version -isnot [long]) -or $record.schema_version -ne 1) { throw 'upload authorization schema mismatch' }
  if ($record.kind -cne $Kind.ToLowerInvariant() -or $record.run_nonce -cne $Nonce -or $record.harness_sha -cne $HarnessSha -or $record.candidate_sha -cne $script:CandidateSha -or $record.candidate_build -cne $script:CandidateSupportBuild) { throw 'stale or wrong upload authorization identity' }
  if ($record.receipt_sha256 -cne (Get-FileSha $Path)) { throw 'upload authorization receipt hash mismatch' }
  if ($Kind -eq 'Evidence') {
    $fullEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
    if ($record.evidence_root -cne $fullEvidence -or $record.evidence_sha256 -cne (Get-TreeHash $EvidencePath)) { throw 'evidence authorization state mismatch' }
  }
  return $true
}

function Assert-LifecycleFaultEvent([string]$Path, [string]$Nonce, [string]$RequestedStage) {
  $stages = @('job-create','job-assign','resume','job-query','job-terminate','job-close')
  if ($RequestedStage -notin $stages) { throw "unsupported ownership lifecycle fault: $RequestedStage" }
  if ($Nonce -cnotmatch '^[0-9a-f]{32}$') { throw 'lifecycle record nonce is invalid' }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "helper stderr log missing for requested fault: $RequestedStage" }
  $prefix = 'COOP_KNOWLEDGE_GIT_LIFECYCLE:'
  $records = @()
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    if (-not $line.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
    $raw = $line.Substring($prefix.Length)
    try { $records += ,($raw | ConvertFrom-Json) } catch { throw "observed lifecycle record is malformed for requested fault: $RequestedStage" }
  }
  if ($records.Count -ne 1) { throw "expected exactly one helper lifecycle record for requested fault $RequestedStage; observed $($records.Count)" }
  $event = $records[0]
  Assert-ExactProperties $event @('schema_version','nonce','stage','outcome') 'observed lifecycle record'
  if (($event.schema_version -isnot [int] -and $event.schema_version -isnot [long]) -or $event.schema_version -ne 1) { throw 'observed lifecycle record schema version mismatch' }
  if (-not (Test-JsonString $event.nonce) -or $event.nonce -cne $Nonce) { throw "stale lifecycle record rejected for requested fault: $RequestedStage" }
  if (-not (Test-JsonString $event.stage) -or $event.stage -cne $RequestedStage) { throw "wrong observed lifecycle stage for requested fault: $RequestedStage" }
  $expectedOutcome = if ($RequestedStage -eq 'job-query') { 'indeterminate' } else { 'failure' }
  if (-not (Test-JsonString $event.outcome) -or $event.outcome -cne $expectedOutcome) { throw "wrong observed lifecycle outcome for requested fault: $RequestedStage" }
  return $event
}

function Resolve-AcceptancePythonExecutable([string]$Path) {
  if (-not [System.IO.Path]::IsPathRooted($Path)) { throw 'acceptance Python must be an absolute path' }
  $expected = [System.IO.Path]::GetFullPath($Path)
  $comparison = if ($env:OS -eq 'Windows_NT') { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
  if (-not [string]::Equals($Path, $expected, $comparison)) { throw 'acceptance Python must be a fully qualified normalized path' }
  if (-not (Test-Path -LiteralPath $expected -PathType Leaf)) { throw 'acceptance Python does not identify a file' }
  $reported = @(& $expected -c 'import os,sys; print(os.path.abspath(sys.executable))' 2>$null)
  if ($LASTEXITCODE -ne 0 -or $reported.Count -ne 1) { throw 'acceptance Python executable probe failed' }
  $actual = [System.IO.Path]::GetFullPath(([string]$reported[0]).Trim())
  if (-not [string]::Equals($actual, $expected, $comparison)) { throw 'acceptance Python executable identity mismatch' }
  return $expected
}

function Get-AcceptancePython {
  if ($env:CERT_PYTHON) {
    return Resolve-AcceptancePythonExecutable $env:CERT_PYTHON
  }
  $pythonCommands = @(Get-Command python3,python -CommandType Application -All -ErrorAction SilentlyContinue)
  foreach ($python in $pythonCommands) {
    try { return Resolve-AcceptancePythonExecutable $python.Source } catch { continue }
  }
  throw 'acceptance Python is unavailable'
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
  $logParent = Split-Path -Parent $LogBase
  if ($logParent -and -not (Test-Path -LiteralPath $logParent)) { New-Item -ItemType Directory -Force -Path $logParent | Out-Null }

  $helper = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\knowledge-git.py'))
  try { $pythonPath = Get-AcceptancePython } catch { $pythonPath = '' }
  if (-not $pythonPath -or -not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    $script:ProcessCleanupUncertain = $true
    [System.IO.File]::WriteAllText($stdout, '', (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($stderr, "ownership helper unavailable; payload was not started`n", (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ ExitCode = 126; Stdout = $stdout; Stderr = $stderr }
  }
  # Serialize the payload vector as UTF-8 JSON. The Python helper reconstructs
  # the exact argv list and opens InputPath directly for the same owned child;
  # no cmd.exe command line or lossy ASCII intermediary is involved.
  $argvPath = "$LogBase.argv.json"
  $payloadArgv = [object[]](@($FilePath) + @($Arguments))
  [System.IO.File]::WriteAllText($argvPath, (ConvertTo-Json -InputObject $payloadArgv -Compress), (New-Object System.Text.UTF8Encoding($false)))
  $helperArguments = @($helper,'--timeout-seconds',[string]$TimeoutSeconds)
  if ($InputPath) { $helperArguments += @('--stdin-file',$InputPath) }
  $helperArguments += @('--argv-file',$argvPath)
  $quoted = @()
  foreach ($arg in $helperArguments) { $quoted += ('"' + ([string]$arg).Replace('"','\"') + '"') }
  $params = @{
    FilePath = $pythonPath
    ArgumentList = ($quoted -join ' ')
    PassThru = $true
    NoNewWindow = $true
    RedirectStandardOutput = $stdout
    RedirectStandardError = $stderr
  }
  $oldSshCommand = $env:GIT_SSH_COMMAND
  try {
    # This child-only value bypasses knowledge-git's Git transport probe, so an
    # ordinary generic payload cannot cause a preliminary command invocation.
    $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
    $process = Start-Process @params
    $process.WaitForExit()
  } catch {
    $script:ProcessCleanupUncertain = $true
    [System.IO.File]::WriteAllText($stderr, "ownership helper could not start; payload was not started: $($_.Exception.Message)`n", (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ ExitCode = 126; Stdout = $stdout; Stderr = $stderr }
  } finally {
    $env:GIT_SSH_COMMAND = $oldSshCommand
    Remove-Item -LiteralPath $argvPath -Force -ErrorAction SilentlyContinue
  }
  if ($process.ExitCode -eq 124 -or $process.ExitCode -eq 126) { $script:ProcessCleanupUncertain = $true }
  return [pscustomobject]@{ ExitCode = [int]$process.ExitCode; Stdout = $stdout; Stderr = $stderr }
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
    warehouse_live = $null
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

function Invoke-OwnershipLifecycleFault([string]$Fixture, [string]$LogBase, [string]$PayloadMarker) {
  $fault = $env:COOP_KNOWLEDGE_GIT_TEST_FAULT
  $eventNonce = [guid]::NewGuid().ToString('N')
  $oldEventNonce = $env:COOP_KNOWLEDGE_GIT_TEST_EVENT_NONCE
  try {
    $env:COOP_KNOWLEDGE_GIT_TEST_EVENT_NONCE = $eventNonce
    if ($fault -in @('job-create','job-assign','resume')) {
      $result = Invoke-Bounded 'node' @($Fixture,$PayloadMarker) $LogBase 5
      if ($result.ExitCode -ne 126) { throw "$fault did not return ownership uncertainty 126: $($result.ExitCode)" }
      if (Test-Path -LiteralPath $PayloadMarker) { throw "$fault allowed the suspended payload to execute" }
    } elseif ($fault -eq 'job-query') {
      $result = Invoke-Bounded 'node' @($Fixture,'parent-with-descendant',$PayloadMarker) $LogBase 5
      if ($result.ExitCode -ne 126) { throw "$fault preserved payload execution instead of uncertainty: $($result.ExitCode)" }
    } elseif ($fault -in @('job-terminate','job-close')) {
      # The fixture fails its own setup after three seconds, keeps the owned
      # parent alive once its descendant is ready, and delays the canary until
      # six seconds. The five-second helper deadline therefore exercises the
      # requested cleanup fault without racing normal parent completion.
      $result = Invoke-Bounded 'node' @($Fixture,'owned-timeout',$PayloadMarker) $LogBase 5
      if ($result.ExitCode -ne 124) { throw "$fault did not preserve timeout 124: $($result.ExitCode)" }
    } else {
      throw "unsupported ownership lifecycle fault: $fault"
    }
  } finally {
    $env:COOP_KNOWLEDGE_GIT_TEST_EVENT_NONCE = $oldEventNonce
  }
  $eventMutation = $env:COOP_TERMINAL_ACCEPTANCE_EVENT_MUTATION
  if ($eventMutation -and $eventMutation -notin @('no-event','duplicate-event','wrong-event','stale-event','malformed-event','payload-spoofed')) { throw "unsupported lifecycle event mutation: $eventMutation" }
  $prefix = 'COOP_KNOWLEDGE_GIT_LIFECYCLE:'
  $lines = @([System.IO.File]::ReadAllLines($result.Stderr))
  if ($eventMutation -eq 'no-event') {
    $lines = @($lines | Where-Object { -not $_.StartsWith($prefix, [StringComparison]::Ordinal) })
  } elseif ($eventMutation -eq 'duplicate-event') {
    $record = @($lines | Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) }) | Select-Object -First 1
    $lines += $record
  } elseif ($eventMutation -eq 'wrong-event') {
    $wrong = if ($fault -eq 'job-create') { 'job-close' } else { 'job-create' }
    $lines = @($lines | ForEach-Object { if ($_.StartsWith($prefix, [StringComparison]::Ordinal)) { $_.Replace(('"stage":"' + $fault + '"'), ('"stage":"' + $wrong + '"')) } else { $_ } })
  } elseif ($eventMutation -eq 'stale-event') {
    $lines = @($lines | ForEach-Object { if ($_.StartsWith($prefix, [StringComparison]::Ordinal)) { $_.Replace($eventNonce, '00000000000000000000000000000000') } else { $_ } })
  } elseif ($eventMutation -eq 'malformed-event') {
    $lines += ($prefix + '{malformed')
  } elseif ($eventMutation -eq 'payload-spoofed') {
    $lines += ($prefix + '{"schema_version":1,"nonce":"00000000000000000000000000000000","stage":"' + $fault + '","outcome":"failure"}')
  }
  if ($eventMutation) { [System.IO.File]::WriteAllLines($result.Stderr, $lines, (New-Object System.Text.UTF8Encoding($false))) }
  $observed = Assert-LifecycleFaultEvent $result.Stderr $eventNonce $fault
  return [pscustomobject]@{ Fault = $fault; ExitCode = [int]$result.ExitCode; ObservedStage = $observed.stage; ObservedOutcome = $observed.outcome; Log = $result.Stderr; LogSha256 = Get-FileSha $result.Stderr }
}

if ($Mode -eq 'Probe') {
  switch ($Probe) {
    'ValidateSha' { if (-not (Test-StrictSha $Value)) { throw 'invalid strict SHA' }; Write-Output 'PASS' }
    'AssertEmptyRoot' { Assert-EmptyOwnedRoot $Root; Write-Output 'PASS' }
    'HashTree' { Write-Output (Get-TreeHash $Root) }
    'ScanCanary' { $hits = @(Find-Canary $Root $Canary); if ($hits.Count -gt 0) { throw "credential canary found in evidence" }; Write-Output 'PASS' }
    'EvaluateReadiness' { $receipt = Read-Receipt $ReceiptPath; Assert-Receipt $receipt | Out-Null; Write-Output ([bool]$receipt.terminal_workstation_ready).ToString().ToLowerInvariant() }
    'VerifySupportBuild' {
      if (-not (Test-StrictSha $Canary)) { throw 'candidate SHA is invalid' }
      if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'candidate root is required' }
      $version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -Raw).Trim()
      $module = (New-Object System.Uri((Resolve-Path (Join-Path $Root 'lib\support-center.mjs')).Path)).AbsoluteUri
      $code = 'const {fingerprintBuild}=await import(process.argv[1]);const r=fingerprintBuild({version:process.argv[2],commit:process.argv[3]});if(!r.ok)process.exit(2);console.log(r.value)'
      $expected = (& node --input-type=module -e $code $module $version $Canary | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $Value -cne $expected) { throw "candidate Support build mismatch: $Value" }
      Write-Output 'PASS'
    }
    'VerifyManifestPins' {
      $observed = Get-Content -LiteralPath $Root -Raw | ConvertFrom-Json
      $manifest = Get-Content -LiteralPath $Value -Raw | ConvertFrom-Json
      $proof = Get-ManifestPinProof $observed.doctor $manifest $observed.coop_version $observed.npm_inventory $observed.extension_inventory $observed.mcp_config 'probe'
      Assert-ManifestPinProof $proof $manifest 'probe'
      Write-Output 'PASS'
    }
    'CollectExtensionInventory' {
      $manifest = Get-Content -LiteralPath $Value -Raw | ConvertFrom-Json
      $inventory = Get-InstalledExtensionInventory $manifest $Root 'probe'
      Assert-ExactProperties $inventory @($manifest.extensions.PSObject.Properties.Name) 'probe installed extension inventory'
      Write-Output ($inventory | ConvertTo-Json -Compress)
    }
    'ReconcileNpmState' {
      $state = Get-Content -LiteralPath $Root -Raw | ConvertFrom-Json
      $probeExitCode = 0
      if (-not [int]::TryParse($Value, [ref]$probeExitCode)) { throw 'probe exit code must be an integer' }
      $runner = { param([string[]]$NpmArgs, [string]$LogPath); [pscustomobject]@{ ExitCode = $probeExitCode; Stderr = $LogPath } }.GetNewClosure()
      $commands = @(Invoke-NpmRollbackReconciliation $state ([System.IO.Path]::GetTempPath()) $runner)
      Write-Output ($commands | ConvertTo-Json -Compress)
    }
    'ValidateLifecycleEvent' { Assert-LifecycleFaultEvent $Value $Canary $Root | Out-Null; Write-Output 'PASS' }
    'AuthorizeArtifacts' {
      Remove-UploadAuthorizations $ReceiptPath
      Assert-Receipt (Read-Receipt $ReceiptPath) | Out-Null
      Assert-FrozenArtifactsSafe $Root 'NO-SUCH-CANARY'
      New-UploadAuthorization 'Receipt' $ReceiptPath $Value $Canary
      New-UploadAuthorization 'Evidence' $ReceiptPath $Value $Canary $Root
      Assert-UploadAuthorization 'Receipt' $ReceiptPath $Value $Canary | Out-Null
      Assert-UploadAuthorization 'Evidence' $ReceiptPath $Value $Canary $Root | Out-Null
      Write-Output 'PASS'
    }
    'ResolvePython' { Write-Output (Get-AcceptancePython) }
    'BoundedCommandSuccess' {
      $result = Invoke-Bounded 'node' @($Value,'success') $Root 10
      if ($result.ExitCode -ne 23) { throw "bounded command status was not preserved: $($result.ExitCode)" }
      Stop-TrackedProcessTrees
      Write-Output 'PASS'
    }
    'BoundedUnicodeFidelity' {
      $expectedArgs = @('雪 λ','space arg','&|<>^%!','quote"arg','backslash\tail','')
      $result = Invoke-Bounded 'node' (@($Value,'unicode') + $expectedArgs) $Root 10 $Canary
      if ($result.ExitCode -ne 0) { throw "Unicode fidelity payload exited $($result.ExitCode)" }
      $observed = Get-Content -LiteralPath $result.Stdout -Raw | ConvertFrom-Json
      if (@($observed.argv).Count -ne $expectedArgs.Count) { throw 'Unicode fidelity argument count changed' }
      for ($i = 0; $i -lt $expectedArgs.Count; $i++) {
        if ([string]$observed.argv[$i] -cne $expectedArgs[$i]) { throw "Unicode fidelity argument $i changed" }
      }
      if ([string]$observed.stdin -cne "Zażółć 雪`nsecond`n") { throw 'Unicode stdin content changed' }
      Stop-TrackedProcessTrees
      Write-Output 'PASS'
    }
    'BoundedProcessTree' {
      $result = Invoke-Bounded 'node' @($Value,'cleanup-race',$Canary) $Root 1
      if ($result.ExitCode -ne 124) { throw "process-tree probe did not return timeout 124: $($result.ExitCode)" }
      $marker = "$ReceiptPath.evidence-authorization.json"
      try { Assert-FrozenArtifactsSafe (Split-Path -Parent $Root) 'NO-SUCH-CANARY'; [System.IO.File]::WriteAllText($marker, 'unsafe') } catch { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Milliseconds 2500
      if (Test-Path -LiteralPath $Canary) { throw 'descendant wrote after process-tree finalization' }
      if (Test-Path -LiteralPath $marker) { throw 'timeout incorrectly allowed an upload marker' }
      Write-Output 'PASS'
    }
    'SuccessfulParentDescendant' {
      $result = Invoke-Bounded 'node' @($Value,'parent-success',$Canary) $Root 1
      if ($result.ExitCode -ne 124) { throw "surviving descendant was incorrectly treated as complete: $($result.ExitCode)" }
      $marker = "$ReceiptPath.evidence-authorization.json"
      try { Assert-FrozenArtifactsSafe (Split-Path -Parent $Root) 'NO-SUCH-CANARY'; [System.IO.File]::WriteAllText($marker, 'unsafe') } catch { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Milliseconds 2500
      if (Test-Path -LiteralPath $Canary) { throw 'successful-parent descendant wrote after ownership timeout' }
      if (Test-Path -LiteralPath $marker) { throw 'surviving descendant incorrectly allowed an upload marker' }
      Write-Output 'PASS'
    }
    'OwnershipLifecycleFailure' {
      $faultResult = Invoke-OwnershipLifecycleFault $Value $Root $Canary
      $fault = $faultResult.Fault
      $marker = "$ReceiptPath.evidence-authorization.json"
      try { Assert-FrozenArtifactsSafe (Split-Path -Parent $Root) 'NO-SUCH-CANARY'; [System.IO.File]::WriteAllText($marker, 'unsafe') } catch { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
      if (Test-Path -LiteralPath $marker) { throw "$fault incorrectly allowed an upload marker" }
      Write-Output 'PASS'
    }
    'FinalizeArtifacts' {
      $marker = "$Value.evidence-authorization.json"
      try {
        Assert-FrozenArtifactsSafe $Root $Canary
        $receiptHits = @(Find-Canary $Value $Canary)
        if ($receiptHits.Count -gt 0) { throw 'canary found in receipt' }
        [System.IO.File]::WriteAllText($marker, "scanned`n", (New-Object System.Text.UTF8Encoding($false)))
      } catch {
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        [void](Remove-SafeTree $Root)
        throw
      }
      Write-Output 'PASS'
    }
  }
  exit 0
}

if ($Mode -eq 'RunBehavioralSuite') {
  try {
    if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'behavioral suite finalization requires a GitHub-hosted Windows runner' }
    if ($RunNonce -cnotmatch '^[0-9a-f]{32}$' -or -not (Test-StrictSha $ExpectedHarnessSha) -or -not (Test-StrictSha $ExpectedCandidateSha)) { throw 'behavioral suite identity is invalid' }
    if ($ExpectedHarnessSha -cne $ExpectedCandidateSha -or $ExpectedCandidateBuild -cnotmatch '^build-[0-9a-f]{8}$') { throw 'behavioral suite candidate binding is invalid' }
    $suiteCheckouts = @(
      @{ Path = $HarnessRoot; Sha = $ExpectedHarnessSha; Label = 'harness' },
      @{ Path = $CandidateRoot; Sha = $ExpectedCandidateSha; Label = 'candidate' },
      @{ Path = $BaselineRoot; Sha = $script:BaselineSha; Label = 'baseline' }
    )
    foreach ($item in $suiteCheckouts) { Assert-CheckoutIdentity $item.Path $item.Label $item.Sha }
    if (-not (Test-Path -LiteralPath $EvidenceRoot -PathType Container) -or -not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { throw 'behavioral suite artifacts are missing' }
    Assert-Receipt (Read-Receipt $ReceiptPath) | Out-Null
    Assert-UploadAuthorization 'Receipt' $ReceiptPath $RunNonce $ExpectedHarnessSha | Out-Null
    Assert-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot | Out-Null
    Assert-FrozenArtifactsSafe $EvidenceRoot $Canary $CandidateRoot $BaselineRoot $HarnessRoot
    $receiptBefore = Get-FileSha $ReceiptPath
    $evidenceBefore = Get-TreeHash $EvidenceRoot
    $checkoutSnapshots = [ordered]@{}
    foreach ($item in $suiteCheckouts) { $checkoutSnapshots[$item.Label] = Get-CheckoutSnapshot $item.Path }
    $commandFileNames = @('GITHUB_ENV','GITHUB_PATH','GITHUB_OUTPUT','GITHUB_STATE','GITHUB_STEP_SUMMARY')
    $commandFileValues = [ordered]@{}
    $commandFileHashes = [ordered]@{}
    foreach ($name in $commandFileNames) {
      $path = [Environment]::GetEnvironmentVariable($name, 'Process')
      $commandFileValues[$name] = $path
      $commandFileHashes[$name] = if ($path) { Get-FileSha $path } else { '' }
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }

    $logBase = Join-Path (Split-Path -Parent $ReceiptPath) 'exact-behavioral-suite'
    try {
      $suite = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'tests\run.ps1')) $logBase 1800
    } finally {
      foreach ($name in $commandFileNames) { [Environment]::SetEnvironmentVariable($name, $commandFileValues[$name], 'Process') }
    }
    Assert-ExitZero $suite 'exact-candidate behavioral suite'
    Stop-TrackedProcessTrees
    if ((Get-FileSha $ReceiptPath) -cne $receiptBefore -or (Get-TreeHash $EvidenceRoot) -cne $evidenceBefore) { throw 'behavioral suite mutated frozen artifacts' }
    foreach ($name in $commandFileNames) {
      $path = $commandFileValues[$name]
      $actual = if ($path) { Get-FileSha $path } else { '' }
      if ($actual -cne $commandFileHashes[$name]) { throw "behavioral suite mutated GitHub command file: $name" }
    }
    foreach ($item in $suiteCheckouts) { Assert-CheckoutSnapshot $checkoutSnapshots[$item.Label] $item.Path $item.Label }
    $evidenceHits = @(Find-Canary $EvidenceRoot $Canary)
    if ($evidenceHits.Count -gt 0) { throw 'credential canary found in evidence after behavioral suite' }
    $receiptHits = @(Find-Canary $ReceiptPath $Canary)
    if ($receiptHits.Count -gt 0) { throw 'credential canary found in receipt after behavioral suite' }

    Remove-UploadAuthorizations $ReceiptPath
    New-UploadAuthorization 'Receipt' $ReceiptPath $RunNonce $ExpectedHarnessSha
    New-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot
    Assert-UploadAuthorization 'Receipt' $ReceiptPath $RunNonce $ExpectedHarnessSha | Out-Null
    Assert-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot | Out-Null
    Write-Output 'behavioral suite and post-suite finalization passed'
    exit 0
  } catch {
    try { Remove-UploadAuthorizations $ReceiptPath } catch {}
    throw
  }
}

if ($Mode -eq 'ValidateReceipt') {
  $receipt = Read-Receipt $ReceiptPath
  Assert-Receipt $receipt | Out-Null
  Write-Output 'receipt valid'
  exit 0
}

if ($Mode -eq 'ValidateUploadAuthorization') {
  $receipt = Read-Receipt $ReceiptPath
  Assert-Receipt $receipt | Out-Null
  Assert-UploadAuthorization $AuthorizationKind $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot | Out-Null
  Write-Output "$AuthorizationKind upload authorization valid"
  exit 0
}

$started = (Get-Date).ToUniversalTime().ToString('o')
$claims = New-Object System.Collections.ArrayList
$operator = New-Object System.Collections.ArrayList
$harnessObservedSha = $null
$harnessObservedVersion = $null
$candidateObservedSha = $null
$candidateObservedVersion = $null
$candidateObservedBuild = $null
$baselineObservedSha = $null
$baselineObservedVersion = $null
$ownedRoot = if ($EvidenceRoot) { Split-Path -Parent $EvidenceRoot } else { $null }
$canary = if ($Canary) {
  if ($Canary -cnotmatch '^COOP-ACCEPTANCE-CANARY-[0-9a-f]{32}$') { throw 'Canary must be exact current-run acceptance canary' }
  $Canary
} else { 'COOP-ACCEPTANCE-CANARY-' + [guid]::NewGuid().ToString('N') }
$runFailure = $null
$evidenceEligible = $false
$authorizationRevoked = $false

try {
  Remove-UploadAuthorizations $ReceiptPath
  $authorizationRevoked = $true
} catch {
  $runFailure = "upload authorization revocation failed: $($_.Exception.Message)"
}

try {
  if (-not $authorizationRevoked) { throw $runFailure }
  if ($RunNonce -cnotmatch '^[0-9a-f]{32}$') { throw 'RunNonce must be exact 32-hex current-run identity' }
  if ($env:OS -ne 'Windows_NT') { throw 'native Windows is required' }
  if (-not $VmOperatorMode) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
      throw 'refusing workstation-like/local execution; use an approved disposable VM with -VmOperatorMode'
    }
  }
  if (-not (Test-StrictSha $ExpectedHarnessSha)) { throw 'ExpectedHarnessSha must be exact 40-hex' }
  if (-not (Test-StrictSha $ExpectedCandidateSha)) { throw 'ExpectedCandidateSha must be exact lowercase 40-hex' }
  if ($ExpectedCandidateBuild -cnotmatch '^build-[0-9a-f]{8}$') { throw 'ExpectedCandidateBuild must be an exact build fingerprint' }
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
  if ($harnessObservedSha -eq $baselineObservedSha) { throw 'harness checkout must be distinct from baseline checkout' }
  $supportModule = (New-Object System.Uri((Resolve-Path (Join-Path $CandidateRoot 'lib\support-center.mjs')).Path)).AbsoluteUri
  $supportCode = 'const {fingerprintBuild}=await import(process.argv[1]);const r=fingerprintBuild({version:process.argv[2],commit:process.argv[3]});if(!r.ok)process.exit(2);console.log(r.value)'
  $computedCandidateBuild = (& node --input-type=module -e $supportCode $supportModule $candidateObservedVersion $candidateObservedSha | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $computedCandidateBuild -cne $script:CandidateSupportBuild) { throw "candidate computed Support build mismatch: $computedCandidateBuild" }

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

  if ($env:COOP_TERMINAL_ACCEPTANCE_OWNERSHIP_FIXTURE) {
    $faultResult = Invoke-OwnershipLifecycleFault $env:COOP_TERMINAL_ACCEPTANCE_OWNERSHIP_FIXTURE (Join-Path $logs 'ownership-lifecycle-fault') (Join-Path $ownedRoot 'ownership-payload.txt')
    $script:LifecycleFaultEvidence = New-Evidence 'FILE' "one authentic helper stderr lifecycle record; sha256=$($faultResult.LogSha256)" 'knowledge-git.py captured stderr lifecycle seam' $faultResult.ExitCode "harness:$harnessObservedSha" $faultResult.Log
    throw "observed ownership lifecycle $($faultResult.ObservedStage) outcome $($faultResult.ObservedOutcome) failed closed with exit $($faultResult.ExitCode)"
  }

  $sentinel = Join-Path $npmRoot 'unrelated-owner.sentinel'
  [System.IO.File]::WriteAllText($sentinel, 'not-owned-by-coop' + [Environment]::NewLine)
  $sentinelBefore = Get-FileSha $sentinel

  $installArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\install.ps1'),'--yes','--no-prereqs')
  $r = Invoke-Bounded 'powershell.exe' $installArgs (Join-Path $logs 'baseline-install') 2700
  Assert-ExitZero $r 'baseline source install'
  $doctorBase = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\doctor.ps1'),'--json') (Join-Path $logs 'baseline-doctor') 600
  Assert-ExitZero $doctorBase 'baseline doctor'
  $doctorBaseJson = Get-Content -LiteralPath $doctorBase.Stdout -Raw | ConvertFrom-Json
  $baselineManifest = Get-Content -LiteralPath (Join-Path $BaselineRoot 'config\release-manifest.json') -Raw | ConvertFrom-Json
  $candidateManifest = Get-Content -LiteralPath (Join-Path $CandidateRoot 'config\release-manifest.json') -Raw | ConvertFrom-Json
  $baselineNpm = Invoke-Bounded 'npm.cmd' @('ls','-g','--depth=0','--json') (Join-Path $logs 'baseline-npm-inventory') 300
  Assert-ExitZero $baselineNpm 'baseline npm inventory'
  $baselineNpmJson = Get-Content -LiteralPath $baselineNpm.Stdout -Raw | ConvertFrom-Json
  $baselineNpmToolState = [ordered]@{}
  foreach ($name in @($candidateManifest.npm_tools.PSObject.Properties.Name)) {
    $property = $baselineNpmJson.dependencies.PSObject.Properties[$name]
    $baselineNpmToolState[$name] = if ($null -eq $property) { 'NOT_INSTALLED' } else { [string]$property.Value.version }
  }
  if ($doctorBaseJson.fail -ne 0) { throw 'baseline Doctor JSON contains required failures' }

  $answers = Join-Path $ownedRoot 'onboard-input.txt'
  [System.IO.File]::WriteAllText($answers, "Acceptance Operator`n2`nn`nn`n", (New-Object System.Text.UTF8Encoding($false)))
  # v0.23.1's launcher omitted scripts/onboard.py's required `onboard`
  # subcommand. Seed realistic pre-upgrade state through that version's actual
  # onboarding implementation; the candidate launcher is exercised below.
  $onboardPython = Get-AcceptancePython
  $onboard = Invoke-Bounded $onboardPython @((Join-Path $BaselineRoot 'scripts\onboard.py'),'onboard','--json') (Join-Path $logs 'baseline-onboard') 300 $answers
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

  $managedMcpPath = Join-Path $agentRoot 'mcp.json'
  $preservedStateFiles = @(
    (Join-Path $profileRoot '.coop\user.json'),
    (Join-Path $profileRoot '.coop\config'),
    (Join-Path $fixtureRepo '.coop\project.yml')
  )
  if ([System.IO.Path]::GetFullPath($env:COOP_AGENT_DIR) -ne [System.IO.Path]::GetFullPath((Join-Path $env:COOP_DIR '.coop\agent'))) { throw 'COOP_AGENT_DIR does not match the supported onboarding agent path' }
  $stateBefore = @{}
  foreach ($file in @($preservedStateFiles) + @($managedMcpPath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "realistic state missing after baseline exercise: $file" }
    $stateBefore[$file] = Get-FileSha $file
  }
  $baselineMcpSha = $stateBefore[$managedMcpPath]
  $repoBefore = Get-TreeHash $fixtureRepo
  [void]$claims.Add((New-Claim 'baseline-source-install' 'BASELINE' 'PASS' $true $true $false 'Actual v0.23.1 source install, Doctor, Support, onboarding, and project initialization completed.' @(
    (New-Evidence 'COMMAND' 'baseline install exited 0' '.\scripts\install.ps1 --yes --no-prereqs' $r.ExitCode "baseline:$baselineObservedSha" $r.Stdout),
    (New-Evidence 'COMMAND' 'Doctor fail count 0' '.\scripts\doctor.ps1 --json' $doctorBase.ExitCode "baseline:$baselineObservedSha" $doctorBase.Stdout),
    (New-Evidence 'FILE' 'baseline Support bundle exported with canary redacted' 'coop support --export <owned-path>' $supportBase.ExitCode "baseline:$baselineObservedSha" $baselineSupportPath)
  )))

  $candidateInstall = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'candidate-upgrade-install') 2700
  Assert-ExitZero $candidateInstall 'candidate source upgrade install'
  foreach ($file in $preservedStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "preserved state changed during candidate upgrade: $file" } }
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
  $candidateObservedBuild = [string]$supportJson.versions.coopBuild

  $manifest = $candidateManifest
  $candidateNpm = Invoke-Bounded 'npm.cmd' @('ls','-g','--depth=0','--json') (Join-Path $logs 'candidate-npm-inventory') 300
  Assert-ExitZero $candidateNpm 'candidate npm inventory'
  $candidateNpmJson = Get-Content -LiteralPath $candidateNpm.Stdout -Raw | ConvertFrom-Json
  $candidateExtensionInventory = Get-InstalledExtensionInventory $manifest $agentRoot 'candidate'
  $candidateMcpJson = Get-Content -LiteralPath (Join-Path $agentRoot 'mcp.json') -Raw | ConvertFrom-Json
  $candidatePinProof = Get-ManifestPinProof $candidateDoctorJson $manifest $candidateObservedVersion $candidateNpmJson $candidateExtensionInventory $candidateMcpJson 'candidate'
  Assert-ManifestPinProof $candidatePinProof $manifest 'candidate'
  $candidateMcpSha = Get-FileSha $managedMcpPath
  $candidatePinProofPath = Join-Path $EvidenceRoot 'candidate-manifest-pin-proof.json'
  [System.IO.File]::WriteAllText($candidatePinProofPath, ($candidatePinProof | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  $launchSpec = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'launch-spec','--json') (Join-Path $logs 'candidate-launch-spec') 300
  Assert-ExitZero $launchSpec 'candidate launch-spec'
  Get-Content -LiteralPath $launchSpec.Stdout -Raw | ConvertFrom-Json | Out-Null
  $dataDocHelp = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'bin\coop.ps1'),'data-doc','--help') (Join-Path $logs 'candidate-data-doc-help') 300
  Assert-ExitZero $dataDocHelp 'candidate data-doc command'

  [void]$claims.Add((New-Claim 'candidate-upgrade-preservation' 'UPGRADE' 'PASS' $true $true $false 'Candidate source install converged the existing profile without changing profile/project fixtures.' @(
    (New-Evidence 'COMMAND' 'candidate install exited 0 over baseline state' '.\scripts\install.ps1 --yes --no-prereqs' $candidateInstall.ExitCode "candidate:$candidateObservedSha" $candidateInstall.Stdout),
    (New-Evidence 'HASH' "representative repo hash remained $repoBefore" 'deterministic content hash excluding .git' 0 "candidate:$candidateObservedSha")
  )))
  [void]$claims.Add((New-Claim 'candidate-health-and-tools' 'UPGRADE' 'PASS' $true $true $false 'Doctor, Support identity, governed launch spec, data-doc command, and complete observable manifest pin set were proven.' @(
    (New-Evidence 'COMMAND' "Doctor fail count 0; Support $($supportJson.versions.coopBuild)" '.\scripts\doctor.ps1 --json; coop support --json' 0 "candidate:$candidateObservedSha" $candidateSupportPath),
    (New-Evidence 'FILE' 'COOP, Pi, extension, Python, npm, and managed MCP pins match the candidate manifest; unmanaged MCP pins are explicitly non-applicable' 'Doctor JSON plus installed extension metadata, npm global inventory, and managed mcp.json specs' 0 "candidate:$candidateObservedSha" $candidatePinProofPath),
    (New-Evidence 'COMMAND' 'data-doc command help exited 0' 'coop data-doc --help' $dataDocHelp.ExitCode "candidate:$candidateObservedSha" $dataDocHelp.Stdout)
  )))

  $reinstall = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $CandidateRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'candidate-reinstall') 2700
  Assert-ExitZero $reinstall 'same-candidate reinstall'
  foreach ($file in $preservedStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during same-candidate reinstall: $file" } }
  if ((Get-FileSha $managedMcpPath) -ne $candidateMcpSha) { throw 'managed MCP state changed during same-candidate reinstall' }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'repository changed during same-candidate reinstall' }
  [void]$claims.Add((New-Claim 'same-candidate-reinstall' 'REINSTALL' 'PASS' $true $true $false 'Same-candidate reinstall was idempotent for exercised state and the fixture repository.' @(
    (New-Evidence 'COMMAND' 'same-candidate reinstall exited 0' '.\scripts\install.ps1 --yes --no-prereqs' $reinstall.ExitCode "candidate:$candidateObservedSha" $reinstall.Stdout)
  )))

  $rollback = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\install.ps1'),'--yes','--no-prereqs') (Join-Path $logs 'baseline-rollback') 2700
  Assert-ExitZero $rollback 'v0.23.1 source rollback'
  [void](Invoke-NpmRollbackReconciliation ([pscustomobject]$baselineNpmToolState) $logs)
  foreach ($file in $preservedStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during rollback: $file" } }
  if ((Get-FileSha $managedMcpPath) -ne $baselineMcpSha) { throw 'managed MCP state did not converge to the baseline during rollback' }
  if ((Get-TreeHash $fixtureRepo) -ne $repoBefore) { throw 'repository changed during rollback' }
  if ((Get-FileSha $sentinel) -ne $sentinelBefore) { throw 'unrelated tool sentinel changed during install/reinstall/rollback' }
  $rollbackDoctor = Invoke-Bounded 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BaselineRoot 'scripts\doctor.ps1'),'--json') (Join-Path $logs 'rollback-doctor') 600
  Assert-ExitZero $rollbackDoctor 'rollback Doctor'
  $rollbackDoctorJson = Get-Content -LiteralPath $rollbackDoctor.Stdout -Raw | ConvertFrom-Json
  $rollbackNpm = Invoke-Bounded 'npm.cmd' @('ls','-g','--depth=0','--json') (Join-Path $logs 'rollback-npm-inventory') 300
  Assert-ExitZero $rollbackNpm 'rollback npm inventory'
  $rollbackNpmJson = Get-Content -LiteralPath $rollbackNpm.Stdout -Raw | ConvertFrom-Json
  foreach ($name in @($baselineNpmToolState.Keys)) {
    $property = $rollbackNpmJson.dependencies.PSObject.Properties[$name]
    $actual = if ($null -eq $property) { 'NOT_INSTALLED' } else { [string]$property.Value.version }
    if ($actual -cne $baselineNpmToolState[$name]) { throw "rollback npm state did not return to observed baseline: $name" }
  }
  $rollbackExtensionInventory = Get-InstalledExtensionInventory $baselineManifest $agentRoot 'rollback'
  $rollbackMcpJson = Get-Content -LiteralPath (Join-Path $agentRoot 'mcp.json') -Raw | ConvertFrom-Json
  $rollbackExpected = ($baselineManifest | ConvertTo-Json -Depth 20 | ConvertFrom-Json)
  foreach ($name in @($rollbackExpected.npm_tools.PSObject.Properties.Name)) {
    $expected = $baselineNpmToolState[$name]
    if ($expected -ceq 'NOT_INSTALLED') { $rollbackExpected.npm_tools.PSObject.Properties.Remove($name) }
    else { $rollbackExpected.npm_tools.PSObject.Properties[$name].Value = $expected }
  }
  $rollbackPinProof = Get-ManifestPinProof $rollbackDoctorJson $rollbackExpected $baselineObservedVersion $rollbackNpmJson $rollbackExtensionInventory $rollbackMcpJson 'rollback'
  Assert-ManifestPinProof $rollbackPinProof $rollbackExpected 'rollback'
  $rollbackPinProofPath = Join-Path $EvidenceRoot 'rollback-manifest-pin-proof.json'
  [System.IO.File]::WriteAllText($rollbackPinProofPath, ($rollbackPinProof | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  [void]$claims.Add((New-Claim 'baseline-rollback-preservation' 'ROLLBACK' 'PASS' $true $true $false 'Actual baseline source install plus bounded npm reconciliation restored the observed pre-upgrade baseline state without wiping state, project data, or unrelated sentinel.' @(
    (New-Evidence 'COMMAND' 'rollback install and Doctor exited 0' '.\scripts\install.ps1 --yes --no-prereqs; .\scripts\doctor.ps1 --json' 0 "baseline:$baselineObservedSha" $rollbackDoctor.Stdout),
    (New-Evidence 'FILE' 'COOP, Pi, extension, Python, and managed MCP pins match the baseline manifest; npm tools match the directly observed pre-upgrade baseline, including absence of its unpublished desktop-bridge pin; unmanaged MCP pins are explicitly non-applicable' 'Doctor JSON plus installed extension metadata, pre-upgrade/rollback npm inventories, and managed mcp.json specs' 0 "baseline:$baselineObservedSha" $rollbackPinProofPath),
    (New-Evidence 'HASH' "unrelated sentinel remained $sentinelBefore" 'SHA-256 before/after' 0 "baseline:$baselineObservedSha" $sentinel)
  )))

} catch {
  if ($runFailure) { $runFailure = "$runFailure; $($_.Exception.Message)" } else { $runFailure = $_.Exception.Message }
} finally {
  $artifactFailure = $null
  if ($runFailure) {
    $artifactFailure = 'artifact finalization failed closed because the current run did not fully succeed'
  } else {
    try {
      Assert-FrozenArtifactsSafe $EvidenceRoot $canary $CandidateRoot $BaselineRoot $HarnessRoot
      $evidenceEligible = $true
    } catch {
      $artifactFailure = 'artifact finalization failed closed; process-tree termination, checkout cleanliness, or evidence sanitization was not proven'
    }
  }
  if ($artifactFailure) {
    if (-not $runFailure) { $runFailure = $artifactFailure }
    [void](Remove-SafeTree $EvidenceRoot)
    [void]$claims.Add((New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'FAIL' $true $true $false $artifactFailure @(
      (New-Evidence 'COMMAND' 'evidence was removed from upload eligibility' 'current-run success plus final artifact canary and checkout scan' 1 $(if ($harnessObservedSha) { "harness:$harnessObservedSha" } else { 'harness' }))
    )))
  } else {
    [void]$claims.Add((New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'PASS' $true $true $false 'Every retained evidence artifact was scanned after a fully successful current run; product checkouts remained clean and the planted canary was absent.' @(
      (New-Evidence 'COMMAND' 'both source checkouts clean; final canary scan had zero hits' 'git status --porcelain; final exact canary scan' 0 "harness:$harnessObservedSha")
    )))
  }
  if ($runFailure) {
    $completionEvidence = if ($script:LifecycleFaultEvidence) { @($script:LifecycleFaultEvidence) } else { @(
        (New-Evidence 'COMMAND' "harness terminated before all required claims passed: $runFailure" 'acceptance/windows-terminal-workstation.ps1 -Mode Run' 1 $(if ($harnessObservedSha) { "harness:$harnessObservedSha" } else { 'harness' }))
      ) }
    [void]$claims.Add((New-Claim 'automated-harness-completion' 'SECURITY' 'FAIL' $true $true $false "Automated harness failed closed: $runFailure" $completionEvidence))
  }
  foreach ($id in $script:RequiredOperatorIds) {
    [void]$operator.Add((New-Claim $id 'OPERATOR' 'NOT_REACHED' $true $false $true 'Must be completed by a human in a snapshot-capable disposable Windows VM; CI makes no claim.' @()))
  }
  $receipt = [ordered]@{
    schema_version = 1
    candidate = [ordered]@{ expected_sha = $script:CandidateSha; observed_sha = $candidateObservedSha; expected_version = '0.23.1'; observed_version = $candidateObservedVersion; expected_build = $script:CandidateSupportBuild; observed_build = $candidateObservedBuild }
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
    $sanitizationFailed = $env:COOP_TERMINAL_ACCEPTANCE_RECEIPT_SANITIZATION_FAULT -eq 'fail'
    $receiptText = $receipt | ConvertTo-Json -Depth 12
    if ($env:COOP_TERMINAL_ACCEPTANCE_AUTHORIZATION_FAULT -eq 'receipt-contamination') { $receiptText += $canary }
    if ($sanitizationFailed -or $receiptText.Contains($canary)) {
      $evidenceEligible = $false
      $runFailure = 'artifact finalization failed closed; only a controlled minimal receipt was retained'
      [void](Remove-SafeTree $EvidenceRoot)
      $claims = @(
        (New-Claim 'sanitized-read-only-evidence' 'SECURITY' 'FAIL' $true $true $false 'Receipt scan could not prove sanitization; evidence was removed from upload eligibility.' @((New-Evidence 'COMMAND' 'final receipt scan failed closed' 'final exact canary scan' 1 'harness'))),
        (New-Claim 'automated-harness-completion' 'SECURITY' 'FAIL' $true $true $false 'Automated harness failed closed during artifact finalization.' @((New-Evidence 'COMMAND' 'harness did not complete with uploadable evidence' 'acceptance/windows-terminal-workstation.ps1 -Mode Run' 1 'harness')))
      )
      $receipt.claims = @($claims)
      $receipt.execution.finished_utc = (Get-Date).ToUniversalTime().ToString('o')
      $receiptText = $receipt | ConvertTo-Json -Depth 12
    }
    try {
      Assert-Receipt ($receiptText | ConvertFrom-Json) | Out-Null
      Write-ControlledReceipt $ReceiptPath $receiptText
      if ($env:COOP_TERMINAL_ACCEPTANCE_AUTHORIZATION_FAULT -eq 'validator-fail') { throw 'test current receipt validator failure' }
      Assert-Receipt (Read-Receipt $ReceiptPath) | Out-Null
      if ($authorizationRevoked) {
        New-UploadAuthorization 'Receipt' $ReceiptPath $RunNonce $ExpectedHarnessSha
        if ($evidenceEligible -and -not $runFailure) {
          New-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot
        }
      }
    } catch {
      $evidenceEligible = $false
      if ($runFailure) { $runFailure = "$runFailure; upload authorization failed: $($_.Exception.Message)" } else { $runFailure = "upload authorization failed: $($_.Exception.Message)" }
      try { Remove-UploadAuthorizations $ReceiptPath } catch { $runFailure = "$runFailure; authorization revocation failed: $($_.Exception.Message)" }
      [void](Remove-SafeTree $EvidenceRoot)
    }
  }
}

if ($runFailure) { Write-Error $runFailure; exit 1 }
Assert-Receipt (Read-Receipt $ReceiptPath) | Out-Null
Write-Output "automated receipt: $ReceiptPath"
Write-Output 'TERMINAL_WORKSTATION_READY=false (human disposable-VM evidence remains mandatory)'
exit 0
