# Production Argument Construction and Pipeline Cleanliness Fixture
# Exercises the ACTUAL functions from scripts/doctor.ps1 with controlled dependencies:
# 1. Check() argument construction: single-element slices do not unbox to scalar string and splat into chars
# 2. Check-PipxDist() line continuation: backticks do not leak string literals to pipeline/stdout

param(
    [string]$DoctorPath = ""
)
$ErrorActionPreference = 'Stop'

$PSScriptRootResolved = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$recordArgv = Join-Path $PSScriptRootResolved 'record-argv.cmd'

if (-not (Test-Path -LiteralPath $recordArgv)) {
    # If invoked via a forwarder, look in fixtures/doctor-argv
    $alt = Join-Path $PSScriptRootResolved 'fixtures/doctor-argv/record-argv.cmd'
    if (Test-Path -LiteralPath $alt) {
        $recordArgv = (Resolve-Path -LiteralPath $alt).Path
        $PSScriptRootResolved = Split-Path -Parent $recordArgv
    } else {
        Write-Error "record-argv.cmd not found at $recordArgv"
        exit 1
    }
} else {
    $recordArgv = (Resolve-Path -LiteralPath $recordArgv).Path
}

# Resolve doctor.ps1: Fail clearly if an explicitly supplied path is missing
$targetDoctorPath = $null
if ($PSBoundParameters.ContainsKey('DoctorPath') -or $DoctorPath) {
    if (-not $DoctorPath -or -not (Test-Path -LiteralPath $DoctorPath)) {
        Write-Error "Explicitly supplied DoctorPath does not exist: '$DoctorPath'"
        exit 1
    }
    $targetDoctorPath = (Resolve-Path -LiteralPath $DoctorPath).Path
} else {
    # Target the checked-out scripts/doctor.ps1
    $candidates = @(
        (Join-Path $PSScriptRootResolved '../../../scripts/doctor.ps1'),
        (Join-Path $PSScriptRootResolved '../../scripts/doctor.ps1'),
        (Join-Path $PSScriptRootResolved '../scripts/doctor.ps1'),
        (Join-Path (Get-Location).Path 'scripts/doctor.ps1')
    )
    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path -LiteralPath $cand)) {
            $targetDoctorPath = (Resolve-Path -LiteralPath $cand).Path
            break
        }
    }
    if (-not $targetDoctorPath) {
        Write-Error "Could not locate checked-out scripts/doctor.ps1. Supply -DoctorPath explicitly."
        exit 1
    }
}

Write-Host "===================================================="
Write-Host "PowerShell Version: $($PSVersionTable.PSVersion.ToString())"
Write-Host "Target Doctor Script: $targetDoctorPath"
Write-Host "Argv Recording Shim: $recordArgv"
Write-Host "===================================================="
Write-Host ""

# Parse scripts/doctor.ps1 AST and extract production functions
$ast = [System.Management.Automation.Language.Parser]::ParseFile($targetDoctorPath, [ref]$null, [ref]$null)
$funcs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)

$checkAst = $funcs | Where-Object { $_.Name -eq 'Check' } | Select-Object -First 1
$pipxAst  = $funcs | Where-Object { $_.Name -eq 'Check-PipxDist' } | Select-Object -First 1

if (-not $checkAst) { Write-Error "Failed to find Check function in $targetDoctorPath"; exit 1 }
if (-not $pipxAst)  { Write-Error "Failed to find Check-PipxDist function in $targetDoctorPath"; exit 1 }

# Load the production function ASTs into current session
Invoke-Expression $checkAst.Extent.Text
Invoke-Expression $pipxAst.Extent.Text

$failures = 0

# Use a temporary file for recording argv to avoid dirtying the repo
$recordFile = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-test-argv-" + [guid]::NewGuid().ToString('N') + ".json")
$env:ARGV_RECORD_FILE = $recordFile

try {
    # ---------------------------------------------------------------
    # Part 1: Production Check() argument construction (0, 1, 2, 3 args)
    # ---------------------------------------------------------------
    Write-Host "[1/2] Testing production Check() argument construction directly from doctor.ps1..."

    # Setup controlled mocks required by Check()
    function Test-Have { param($bin) return $true }
    $script:lastReport = $null
    function D-Ok   { param($m) $script:lastReport = @{ status = 'ok'; text = $m } }
    function D-Warn { param($m, $h='') $script:lastReport = @{ status = 'warn'; text = $m; hint = $h } }
    function D-Bad  { param($m, $h='') $script:lastReport = @{ status = 'fail'; text = $m; hint = $h } }

    $cases = @(
        @{ name = "0 args (binary only)"; vcmd = @($recordArgv); expected = "[]" },
        @{ name = "1 arg (--version)"; vcmd = @($recordArgv, "--version"); expected = '["--version"]' },
        @{ name = "2 args (--version --json)"; vcmd = @($recordArgv, "--version", "--json"); expected = '["--version","--json"]' },
        @{ name = "3 args (--flag val -v)"; vcmd = @($recordArgv, "--flag", "val", "-v"); expected = '["--flag","val","-v"]' }
    )

    foreach ($c in $cases) {
        if (Test-Path $recordFile) { Remove-Item $recordFile -Force }
        # Invoke the actual production Check function extracted from doctor.ps1
        Check "record-argv" "optional" "test hint" $c.vcmd
        $actual = if (Test-Path $recordFile) { (Get-Content $recordFile -Raw).Trim() } else { "" }

        if ($actual -eq $c.expected) {
            Write-Host "  [PASS] $($c.name): captured=$actual"
        } else {
            Write-Host "  [FAIL] $($c.name): expected $($c.expected), got $actual"
            $failures++
        }
    }

    # ---------------------------------------------------------------
    # Part 2: Production Check-PipxDist() line continuation & pipeline cleanliness
    # ---------------------------------------------------------------
    Write-Host ""
    Write-Host "[2/2] Testing production Check-PipxDist() line continuation directly from doctor.ps1..."

    $script:JsonChecks = @()
    $script:JSON = $true
    $script:WARN = 0
    $script:FAIL = 0
    $script:Section = 'Tools'

    function D-Rec {
        param([string]$Status, [string]$Name, [string]$Hint = '')
        if ($script:JSON) {
            $script:JsonChecks += [ordered]@{ name = $Name; section = $script:Section; status = $Status; hint = $Hint }
        }
    }
    function D-Warn { param([string]$m, [string]$hint = '') D-Rec 'warn' $m $hint; $script:WARN++ }
    function D-Bad  { param([string]$m, [string]$hint = '') D-Rec 'fail' $m $hint; $script:FAIL++ }
    function D-Ok   { param([string]$m) D-Rec 'ok' $m; }

    # Controlled dependency mocks for Check-PipxDist
    function Coop-ManifestGet { param($d) return "1.0.0" }
    function Coop-ManifestStatus { param($a, $b) return "ok" }
    function Test-CoopPythonSpec { param($v, $s) return $false }

    # Scenario A: Executable ownership mismatch (triggers line 186 continuation)
    function Get-CoopVenvDistVersion { param($d, $p) return "1.0.0" }
    function Get-CoopVenvPythonVersion { param($d) return "3.11.0" }
    function Get-CoopExePipxVenv { param($e) return "different-venv" }

    $script:JsonChecks = @()
    $leakedOwnership = Check-PipxDist "coop-data-doc" $recordArgv

    if ($null -ne $leakedOwnership) {
        Write-Host "  [FAIL] Scenario A (ownership mismatch) leaked items to pipeline: $leakedOwnership"
        $failures++
    } else {
        Write-Host "  [PASS] Scenario A (ownership mismatch) emitted 0 pipeline items (clean)"
    }

    $recordedHintA = if ($script:JsonChecks.Count -gt 0) { $script:JsonChecks[-1].hint } else { "" }
    if ($recordedHintA -like "reinstall so the pinned*") {
        Write-Host "  [PASS] Scenario A correctly captured multi-line hint via backtick"
    } else {
        Write-Host "  [FAIL] Scenario A hint corrupted: '$recordedHintA'"
        $failures++
    }

    # Scenario B: Python version violation (triggers line 223 continuation)
    function Get-CoopExePipxVenv { param($e) return "coop-data-doc" }
    function Get-CoopVenvRequiresPython { param($d, $p) return ">=3.12" }

    $script:JsonChecks = @()
    $leakedPython = Check-PipxDist "coop-data-doc" $recordArgv

    if ($null -ne $leakedPython) {
        Write-Host "  [FAIL] Scenario B (python violation) leaked items to pipeline: $leakedPython"
        $failures++
    } else {
        Write-Host "  [PASS] Scenario B (python violation) emitted 0 pipeline items (clean)"
    }

    $recordedHintB = if ($script:JsonChecks.Count -gt 0) { $script:JsonChecks[-1].hint } else { "" }
    if ($recordedHintB -like "*pipx install --force coop-data-doc==1.0.0 --python 3.12*") {
        Write-Host "  [PASS] Scenario B correctly captured multi-line hint via backtick"
    } else {
        Write-Host "  [FAIL] Scenario B hint corrupted: '$recordedHintB'"
        $failures++
    }

    # Scenario C: Metadata / CLI disagreement (triggers line 174 continuation)
    function Get-CoopVenvDistVersion { param($d, $p) return "2.0.0" } # differs from CLI 1.0.0

    $script:JsonChecks = @()
    $leakedDisagreement = Check-PipxDist "coop-data-doc" $recordArgv

    if ($null -ne $leakedDisagreement) {
        Write-Host "  [FAIL] Scenario C (metadata disagreement) leaked items to pipeline: $leakedDisagreement"
        $failures++
    } else {
        Write-Host "  [PASS] Scenario C (metadata disagreement) emitted 0 pipeline items (clean)"
    }

    $recordedHintC = if ($script:JsonChecks.Count -gt 0) { $script:JsonChecks[-1].hint } else { "" }
    if ($recordedHintC -like "*pipx install --force coop-data-doc==1.0.0*metadata/CLI disagreement*") {
        Write-Host "  [PASS] Scenario C correctly captured multi-line hint via backtick"
    } else {
        Write-Host "  [FAIL] Scenario C hint corrupted: '$recordedHintC'"
        $failures++
    }

    Write-Host ""
    if ($failures -eq 0) {
        Write-Host "ALL PRODUCTION DOCTOR.PS1 REGRESSION CHECKS PASSED!"
        exit 0
    } else {
        Write-Error "Production doctor.ps1 regression checks failed."
        exit 1
    }
} finally {
    if (Test-Path $recordFile) { Remove-Item $recordFile -Force -ErrorAction SilentlyContinue }
}
