param(
    [string]$DoctorPath = ""
)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $PSScriptRoot 'fixtures/doctor-argv/test_production_argv.ps1'
& $fixture @PSBoundParameters
