param([Parameter(Mandatory=$true)][string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent can leave incompatible modules on PSModulePath.
# This read-only helper loads only the Windows PowerShell OS modules.
$env:PSModulePath = $PSHOME + '\Modules'
$entry = Get-Item -LiteralPath $ExecutablePath -Force
if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update executable is not a regular file.' }
$signature = Get-AuthenticodeSignature -LiteralPath $ExecutablePath
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($entry.FullName)
[ordered]@{
    signatureStatus = [string]$signature.Status
    productName = $version.ProductName
    fileVersion = $version.FileVersion
} | ConvertTo-Json -Compress
